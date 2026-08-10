import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { InboxStateSchema } from "../../unified-inbox/state.ts";
import { truncateCodePoints } from "../../unified-inbox/types.ts";
import { handoffText } from "./handoff.ts";
import { personalDataDir } from "./personal-data.ts";

type Button = { text: string; callback_data: string };
type State = {
  chatId: string | number;
  userId: string | number;
  role?: "owner" | "user";
  personalRoot?: string;
};
type Context = {
  deps: {
    dataDir: string;
    deliver: (update: Record<string, unknown>) => unknown;
    reply: (chatId: number, text: string) => unknown;
  };
  flows: { end: (state: State, text: string) => Promise<void> };
  tr: (english: string, russian: string) => string;
  btn: (text: string, callbackData: string) => Button;
  backRow: (screen: string) => Button[];
};

function errorCode(error: unknown): unknown {
  return (error as { code?: unknown } | null | undefined)?.code;
}

export default {
  parent: "r",
  async render(state: State, context: Context) {
    const T = context.tr;
    if (state.role === "user") {
      return {
        text: T(
          "📥 Inbox\n\nThis private inbox is available only to the owner.",
          "📥 Входящие\n\nЭтот приватный inbox доступен только владельцу.",
        ),
        rows: [context.backRow("r")],
      };
    }

    const file = join(
      personalDataDir(state, context.deps.dataDir),
      "unified-inbox",
      `owner-${String(state.userId)}`,
      "state.json",
    );
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (error) {
      return {
        text:
          errorCode(error) === "ENOENT"
            ? T(
                "📥 Inbox\n\nNo inbox snapshot yet.",
                "📥 Входящие\n\nСнимка входящих пока нет.",
              )
            : T(
                "📥 Inbox\n\nInbox snapshot is unavailable.",
                "📥 Входящие\n\nСнимок входящих недоступен.",
              ),
        rows: [context.backRow("r")],
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    const result = InboxStateSchema.safeParse(parsed);
    if (!result.success || result.data.ownerId !== String(state.userId)) {
      return {
        text: T(
          "📥 Inbox\n\nInbox snapshot is unavailable.",
          "📥 Входящие\n\nСнимок входящих недоступен.",
        ),
        rows: [context.backRow("r")],
      };
    }

    const inbox = result.data;
    const report = inbox.lastReport;
    const actionable = Object.entries(inbox.classifications)
      .filter(
        ([, category]) => category === "urgent" || category === "needs_reply",
      )
      .flatMap(([id, category]) => {
        const observation = inbox.observations[id];
        return observation ? [{ observation, category }] : [];
      })
      .sort(
        (left, right) =>
          Date.parse(right.observation.occurredAt) -
          Date.parse(left.observation.occurredAt),
      )
      .slice(0, 5);
    const lines = actionable.map(({ observation, category }) => {
      const label =
        observation.title || observation.excerpt || observation.kind;
      return `• ${category}: ${truncateCodePoints(label, 120)} — ${observation.evidence.locator}`;
    });
    const summary = report
      ? T(
          `Urgent: ${report.urgent} · Needs reply: ${report.needsReply} · Meetings: ${report.meetings}`,
          `Срочно: ${report.urgent} · Требует ответа: ${report.needsReply} · Встречи: ${report.meetings}`,
        )
      : T("No inbox report yet.", "Отчёта по входящим пока нет.");
    const body = lines.length
      ? lines.join("\n")
      : T(
          "No actionable items in the snapshot.",
          "В снимке нет требующих действий пунктов.",
        );
    return {
      text: `${T("📥 Inbox", "📥 Входящие")}\n\n${summary}\n\n${body}`,
      rows: [
        [
          context.btn(
            T("Review privately", "Разобрать приватно"),
            "iva_menu:in:review",
          ),
        ],
        [context.btn(T("Refresh", "Обновить"), "iva_menu:in:rf")],
        context.backRow("r"),
      ],
    };
  },
  async on(verb: string, _args: string[], state: State, context: Context) {
    if (verb !== "review") return;
    if (state.role === "user") {
      await context.deps.reply(
        Number(state.chatId),
        context.tr(
          "This private inbox is available only to the owner.",
          "Этот приватный inbox доступен только владельцу.",
        ),
      );
      return;
    }
    await handoffText(state, context, "/inbox");
  },
};
