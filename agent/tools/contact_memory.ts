import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { defineTool } from "eve/tools";
import { z } from "zod";

import { acquireLock, atomicWrite } from "../lib/card-store.js";
import {
  MeetingSchema,
  PersonTaskDraftSchema,
  ProfileFieldSchema,
  ProfileFactSchema,
  calculateAge,
  safeHumanInline,
  stripInternalMemoryArtifacts,
} from "../lib/contact-memory.js";
import { parseFrontmatter } from "../lib/frontmatter.js";
import {
  assertContactMemoryPath,
  runContactMemoryTransaction,
} from "../lib/contact-memory-transaction.js";
import {
  addPersonTask,
  parsePeopleTaskDocument,
  renderPeopleTaskDocument,
  transitionPersonTask,
} from "../lib/people-task-store.js";
import {
  applyOwnerContactUpdate,
  contactCardPath,
  deleteOwnerContactRecord,
} from "../../scripts/contact-analysis/reducer.ts";
import { reconcilePersonTasks } from "../../scripts/contact-memory/reconcile.ts";

const VAULT = () => process.env.ASSISTANT_VAULT_DIR ?? "vault";

const IdentitySchema = z.object({
  telegram_user_id: z.number().int().positive().optional(),
  person_name: z.string().trim().min(1).max(200).optional(),
  display_name: z.string().trim().min(1).max(200).optional(),
  now: z.iso.datetime({ offset: true }).optional(),
});

export const contactMemoryInputSchema = z
  .discriminatedUnion("action", [
    IdentitySchema.extend({ action: z.literal("get") }),
    IdentitySchema.extend({
      action: z.literal("update_profile"),
      display_name: z.string().trim().min(1).max(200),
      facts: z.array(ProfileFactSchema).min(1).max(32),
    }),
    IdentitySchema.extend({
      action: z.literal("record_meeting"),
      display_name: z.string().trim().min(1).max(200),
      meeting: MeetingSchema,
      tasks: z.array(PersonTaskDraftSchema).max(16).optional(),
    }),
    IdentitySchema.extend({
      action: z.enum(["complete_task", "cancel_task"]),
      task_title: z.string().trim().min(1).max(300),
      fuzzy: z.boolean().optional(),
    }),
    IdentitySchema.extend({
      action: z.literal("delete_record"),
      record_kind: z.enum(["fact", "meeting"]),
      field: ProfileFieldSchema.optional(),
      value: z.string().trim().min(1).max(500).optional(),
      meeting_date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/u)
        .optional(),
      meeting_title: z.string().trim().min(1).max(120).optional(),
      meeting_summary: z.string().trim().min(1).max(1500).optional(),
    }).superRefine((input, context) => {
      if (input.record_kind === "fact" && (!input.field || !input.value)) {
        context.addIssue({
          code: "custom",
          message: "fact deletion requires field and value",
        });
      }
      if (
        input.record_kind === "meeting" &&
        (!input.meeting_date || !input.meeting_title)
      ) {
        context.addIssue({
          code: "custom",
          message: "meeting deletion requires date and title",
        });
      }
    }),
  ])
  .superRefine((input, context) => {
    if (
      (input.telegram_user_id === undefined) ===
      (input.person_name === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "provide exactly one of telegram_user_id or person_name",
      });
    }
    if (input.person_name !== undefined && input.action !== "get") {
      context.addIssue({
        code: "custom",
        message: "mutations require telegram_user_id after name lookup",
      });
    }
  });
export type ContactMemoryInput = z.infer<typeof contactMemoryInputSchema>;

function cleanMarkdown(content: string): string {
  const body = parseFrontmatter(content).body;
  return stripInternalMemoryArtifacts(body)
    .replace(/<!--[^]*?-->/gu, "")
    .replace(/^\s*$/gmu, "")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function today(now: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: process.env.ASSISTANT_TIMEZONE ?? "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(now));
}

function taskFile(): string {
  return join(VAULT(), "tasks", "people.md");
}

function normalizeName(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("ru-RU")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function resolveUserId(
  input: ContactMemoryInput,
): { ok: true; userId: number } | { ok: false; error: string } {
  if (input.telegram_user_id !== undefined)
    return { ok: true, userId: input.telegram_user_id };
  const wanted = normalizeName(input.person_name!);
  const directory = join(VAULT(), "cards", "contacts");
  const matches: number[] = [];
  if (existsSync(directory)) assertContactMemoryPath(VAULT(), directory);
  for (const name of existsSync(directory) ? readdirSync(directory) : []) {
    const id = /^telegram-user-([1-9]\d*)\.md$/u.exec(name)?.[1];
    if (!id) continue;
    const candidate = join(directory, name);
    assertContactMemoryPath(VAULT(), candidate);
    const content = readFileSync(candidate, "utf8");
    const parsed = parseFrontmatter(content);
    const heading = /^#\s+(.+)$/mu.exec(parsed.body)?.[1];
    const fullName = parsed.fields?.full_name;
    const candidates = [heading, typeof fullName === "string" ? fullName : null]
      .filter((value): value is string => Boolean(value))
      .map(normalizeName);
    if (candidates.includes(wanted)) matches.push(Number(id));
  }
  if (matches.length === 1) return { ok: true, userId: matches[0] };
  if (matches.length > 1) {
    return {
      ok: false,
      error:
        "Нашла несколько людей с таким именем. Уточни, кого ты имеешь в виду.",
    };
  }
  return { ok: false, error: "Не нашла человека с таким именем." };
}

function mutateTasks(
  mutation: (tasks: ReturnType<typeof parsePeopleTaskDocument>) => {
    tasks: ReturnType<typeof parsePeopleTaskDocument>;
    result: Record<string, unknown>;
  },
  now: string,
): Record<string, unknown> {
  const file = taskFile();
  mkdirSync(dirname(file), { recursive: true });
  const release = acquireLock(file);
  try {
    const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
    const current = parsePeopleTaskDocument(existing);
    const { tasks, result } = mutation(current);
    const rendered = renderPeopleTaskDocument(existing, tasks, today(now));
    if (rendered !== existing) atomicWrite(file, rendered);
    return result;
  } finally {
    release();
  }
}

export default defineTool({
  description:
    "Читать и обновлять память о конкретном человеке: профиль, явно сообщённые владельцем встречи " +
    "и связанные с человеком дела. Для встреч ownerReported обязан быть true. Возвращает только " +
    "чистый пользовательский текст без внутренних идентификаторов и метаданных.",
  inputSchema: contactMemoryInputSchema,
  async execute(input) {
    const now = input.now ?? new Date().toISOString();
    const identity = resolveUserId(input);
    if (!identity.ok) return identity;
    const userId = identity.userId;
    const file = contactCardPath(VAULT(), userId);
    if (input.action === "get") {
      if (!existsSync(file)) {
        return { ok: false, error: "У меня пока нет карточки этого человека." };
      }
      assertContactMemoryPath(VAULT(), file);
      const content = readFileSync(file, "utf8");
      const parsed = parseFrontmatter(content);
      const birthday =
        typeof parsed.fields?.birthday === "string"
          ? parsed.fields.birthday
          : undefined;
      const timezone =
        typeof parsed.fields?.timezone === "string"
          ? parsed.fields.timezone
          : (process.env.ASSISTANT_TIMEZONE ?? "UTC");
      return {
        ok: true,
        profile: cleanMarkdown(content),
        age: birthday ? calculateAge(birthday, now, timezone) : null,
        ageKnown: Boolean(birthday?.match(/^\d{4}-/u)),
      };
    }

    if (input.action === "update_profile") {
      const update = applyOwnerContactUpdate({
        vault: VAULT(),
        userId,
        displayName: input.display_name,
        facts: input.facts,
        now,
      });
      return {
        ok: true,
        message: update.changed
          ? `Обновила профиль: ${safeHumanInline(input.display_name)}.`
          : `В профиле ${safeHumanInline(input.display_name)} уже всё актуально.`,
      };
    }

    if (input.action === "record_meeting") {
      return runContactMemoryTransaction(
        VAULT(),
        [file, taskFile()],
        async () => {
          const facts = [
            ...(input.meeting.updates ?? []),
            ...(input.meeting.followups ?? []).map((value) => ({
              field: "conversation_followup" as const,
              value,
              confidence: "direct" as const,
            })),
          ];
          const update = applyOwnerContactUpdate({
            vault: VAULT(),
            userId,
            displayName: input.display_name,
            facts,
            meeting: input.meeting,
            now,
            transactionLocked: true,
          });
          let createdTasks = 0;
          if (input.tasks?.length) {
            mutateTasks((current) => {
              let tasks = current;
              for (const draft of input.tasks ?? []) {
                const added = addPersonTask(
                  tasks,
                  { ...draft, originMeetingId: update.meetingId ?? undefined },
                  {
                    path: `cards/contacts/telegram-user-${userId}`,
                    name: input.display_name,
                  },
                  now,
                );
                tasks = added.tasks;
                if (added.created) createdTasks++;
              }
              return { tasks, result: {} };
            }, now);
            await reconcilePersonTasks({
              vault: VAULT(),
              today: today(now),
              transactionLocked: true,
            });
          }
          const taskSuffix =
            createdTasks > 0 ? ` Добавила связанных дел: ${createdTasks}.` : "";
          return {
            ok: true,
            message: update.changed
              ? `Добавила встречу в профиль «${safeHumanInline(input.display_name)}».${taskSuffix}`
              : `Эта встреча с ${safeHumanInline(input.display_name)} уже была записана.${taskSuffix}`,
          };
        },
      );
    }

    if (input.action === "delete_record") {
      return runContactMemoryTransaction(
        VAULT(),
        [file, taskFile()],
        async () => {
          const selector =
            input.record_kind === "fact"
              ? {
                  kind: "fact" as const,
                  field: input.field!,
                  value: input.value!,
                }
              : {
                  kind: "meeting" as const,
                  date: input.meeting_date!,
                  title: input.meeting_title!,
                  ...(input.meeting_summary
                    ? { summary: input.meeting_summary }
                    : {}),
                };
          const result = deleteOwnerContactRecord({
            vault: VAULT(),
            userId,
            selector,
            transactionLocked: true,
          });
          if (result.deletedMeetingId && existsSync(taskFile())) {
            mutateTasks(
              (tasks) => ({
                tasks: tasks.filter(
                  (task) => task.originMeetingId !== result.deletedMeetingId,
                ),
                result: {},
              }),
              now,
            );
            await reconcilePersonTasks({
              vault: VAULT(),
              today: today(now),
              personPaths: [`cards/contacts/telegram-user-${userId}`],
              transactionLocked: true,
            });
          }
          return result.deleted
            ? { ok: true, message: "Удалила выбранную запись из профиля." }
            : result.ambiguous
              ? {
                  ok: false,
                  error:
                    "Нашла несколько встреч с такой датой и названием. Уточни резюме встречи.",
                }
              : { ok: false, error: "Такую запись в профиле не нашла." };
        },
      );
    }

    const status = input.action === "complete_task" ? "done" : "cancelled";
    return runContactMemoryTransaction(
      VAULT(),
      [file, taskFile()],
      async () => {
        const result = mutateTasks((tasks) => {
          const transitioned = transitionPersonTask(
            tasks,
            {
              personPath: `cards/contacts/telegram-user-${userId}`,
              title: input.task_title,
              fuzzy: input.fuzzy,
            },
            status,
            now,
          );
          return {
            tasks: transitioned.tasks,
            result: { outcome: transitioned.outcome },
          };
        }, now);
        if (result.outcome === "changed") {
          await reconcilePersonTasks({
            vault: VAULT(),
            today: today(now),
            transactionLocked: true,
          });
        }
        if (result.outcome === "ambiguous") {
          return {
            ok: false,
            error:
              "Нашла несколько похожих открытых дел. Уточни, какое именно выполнено.",
          };
        }
        if (result.outcome === "not_found") {
          return {
            ok: false,
            error:
              "Не нашла одно подходящее открытое дело. Ничего не изменила.",
          };
        }
        return {
          ok: true,
          message:
            status === "done"
              ? `Дело «${safeHumanInline(input.task_title)}» отмечено как выполненное.`
              : `Дело «${safeHumanInline(input.task_title)}» отменено.`,
        };
      },
    );
  },
});
