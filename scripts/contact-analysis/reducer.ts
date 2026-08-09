import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { z } from "zod";

import {
  parseFrontmatter,
  writeFrontmatter,
  type FmFields,
} from "../../agent/lib/frontmatter.ts";
import { acquireLock, atomicWrite } from "../../agent/lib/card-store.ts";
import {
  AnalysisPageSchema,
  ObservationSchema,
  type AnalysisPage,
  type Observation,
  type TelegramDialog,
} from "./types.ts";

const START = "<!-- iva:telegram-graph:start -->";
const END = "<!-- iva:telegram-graph:end -->";
const STATE_PREFIX = "<!-- iva:telegram-graph:state:";

const ManagedLinkSchema = z.strictObject({
  target: z.string().min(1),
  label: z.string().min(1).max(500),
});
const ManagedStateSchema = z.strictObject({
  current: z.array(ObservationSchema),
  history: z.array(ObservationSchema),
  links: z.array(ManagedLinkSchema),
});
type ManagedState = z.infer<typeof ManagedStateSchema>;

interface CardState {
  file: string;
  cardType: "contact" | "note" | "project";
  numericId: number | null;
  title: string;
  original: string | undefined;
  managed: ManagedState;
}

export interface ReduceBatchInput {
  vault: string;
  ownerUserId: number;
  dialog: TelegramDialog;
  batch: AnalysisPage;
}

export interface ReduceResult {
  writtenFiles: string[];
  observationIds: string[];
}

function requireSafeNonZeroInteger(id: number, name: string): number {
  if (!Number.isSafeInteger(id) || id === 0) {
    throw new TypeError(`${name} must be a safe non-zero integer`);
  }
  return id;
}

export function contactCardPath(vault: string, userId: number): string {
  return join(
    vault,
    "cards",
    "contacts",
    `telegram-user-${requireSafeNonZeroInteger(userId, "user ID")}.md`,
  );
}

export function chatCardPath(vault: string, dialog: TelegramDialog): string {
  const id = Math.abs(requireSafeNonZeroInteger(dialog.id, "chat ID"));
  return join(vault, "cards", "notes", `telegram-${dialog.kind}-${id}.md`);
}

function projectSlug(title: string): string {
  return (
    title
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 80) ||
    createHash("sha256").update(title).digest("hex").slice(0, 16)
  );
}

function projectCardPath(vault: string, title: string): string {
  return join(
    vault,
    "cards",
    "projects",
    `telegram-project-${projectSlug(title)}.md`,
  );
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function observationId(observation: Observation): string {
  const parsed = ObservationSchema.parse(observation);
  return createHash("sha256").update(canonicalJson(parsed)).digest("hex");
}

function emptyManaged(): ManagedState {
  return { current: [], history: [], links: [] };
}

function ownedRegion(body: string): string | null {
  const start = body.indexOf(START);
  if (start === -1) return null;
  const end = body.indexOf(END, start + START.length);
  if (end === -1) {
    throw new Error("Telegram graph managed section is missing its end marker");
  }
  return body.slice(start, end + END.length);
}

function parseManaged(body: string): ManagedState {
  const region = ownedRegion(body);
  if (region === null) return emptyManaged();
  const stateStart = region.indexOf(STATE_PREFIX);
  if (stateStart === -1) {
    throw new Error("Telegram graph managed section has no state payload");
  }
  const payloadStart = stateStart + STATE_PREFIX.length;
  const payloadEnd = region.indexOf(" -->", payloadStart);
  if (payloadEnd === -1) {
    throw new Error("Telegram graph managed state payload is malformed");
  }
  try {
    const decoded = Buffer.from(
      region.slice(payloadStart, payloadEnd),
      "base64url",
    ).toString("utf8");
    return ManagedStateSchema.parse(JSON.parse(decoded));
  } catch {
    throw new Error("Telegram graph managed state payload is invalid");
  }
}

function readCard(
  file: string,
  cardType: CardState["cardType"],
  numericId: number | null,
  title: string,
): CardState {
  const original = existsSync(file) ? readFileSync(file, "utf8") : undefined;
  const body = original === undefined ? "" : parseFrontmatter(original).body;
  return {
    file,
    cardType,
    numericId,
    title,
    original,
    managed: parseManaged(body),
  };
}

function newestEvidenceTimestamp(observation: Observation): string {
  return observation.evidence
    .map((item) => item.timestamp)
    .sort()
    .at(-1)!;
}

function supersessionKey(observation: Observation): string | null {
  if (["display_name", "username"].includes(observation.predicate)) {
    return `${observation.subjectId}:${observation.predicate}`;
  }
  if (
    ["role", "communication_style", "relationship"].includes(
      observation.predicate,
    )
  ) {
    return `${observation.subjectId}:${observation.predicate}:${observation.contextChatId}`;
  }
  return null;
}

function mergeObservation(managed: ManagedState, incoming: Observation): void {
  const incomingId = observationId(incoming);
  if (
    [...managed.current, ...managed.history].some(
      (item) => observationId(item) === incomingId,
    )
  ) {
    return;
  }
  const key = supersessionKey(incoming);
  if (key === null) {
    managed.current.push(incoming);
    return;
  }
  const conflicts = managed.current.filter(
    (item) => supersessionKey(item) === key,
  );
  if (conflicts.length === 0) {
    managed.current.push(incoming);
    return;
  }
  const incomingTimestamp = newestEvidenceTimestamp(incoming);
  const newestCurrent = conflicts.map(newestEvidenceTimestamp).sort().at(-1)!;
  if (incomingTimestamp >= newestCurrent) {
    const conflictIds = new Set(conflicts.map(observationId));
    managed.current = managed.current.filter(
      (item) => !conflictIds.has(observationId(item)),
    );
    managed.history.push(...conflicts, incoming);
    managed.current.push(incoming);
    managed.history = managed.history.filter(
      (item) => observationId(item) !== incomingId,
    );
  } else {
    managed.history.push(incoming);
  }
}

function vaultLink(vault: string, targetFile: string): string {
  return relative(vault, targetFile).split(sep).join("/").replace(/\.md$/u, "");
}

function addLink(managed: ManagedState, target: string, label: string): void {
  const existing = managed.links.find((link) => link.target === target);
  if (existing) existing.label = label;
  else managed.links.push({ target, label });
}

function subjectUserId(subjectId: string): number | null {
  const match = /^telegram:user:(-?[1-9]\d*)$/u.exec(subjectId);
  return match ? Number(match[1]) : null;
}

function displayName(state: CardState): string {
  const latest = state.managed.current.find(
    (item) => item.predicate === "display_name" && item.value,
  );
  return latest?.value ?? state.title;
}

function safeInline(value: string): string {
  return (
    value
      .replace(/\p{Cc}+/gu, " ")
      .replace(/<!--/gu, "&lt;!--")
      .replace(/-->/gu, "--&gt;")
      .replaceAll("[", " ")
      .replaceAll("]", " ")
      .replaceAll("|", " ")
      .replace(/\s+/gu, " ")
      .trim() || "Telegram item"
  );
}

function renderObservation(observation: Observation): string {
  const id = observationId(observation);
  const target =
    observation.value === undefined
      ? `[[${observation.objectId}]]`
      : safeInline(observation.value);
  const sources = observation.evidence
    .map(
      (item) =>
        `\`telegram:message:${item.chatId}:${item.messageId}\` (${item.timestamp})`,
    )
    .join(", ");
  const asserted = observation.assertedById
    ? `; asserted by \`${observation.assertedById}\``
    : "";
  return `- <!-- iva:observation:${id} --> **${observation.predicate}**: ${target} (${observation.confidence}${asserted}; evidence: ${sources})`;
}

function sortedObservations(items: Observation[]): Observation[] {
  return [...items].sort((left, right) => {
    const predicate = left.predicate.localeCompare(right.predicate);
    return predicate || observationId(left).localeCompare(observationId(right));
  });
}

function renderManaged(managed: ManagedState): string {
  const normalized = ManagedStateSchema.parse({
    current: sortedObservations(managed.current),
    history: sortedObservations(managed.history),
    links: [...managed.links].sort((left, right) =>
      left.target.localeCompare(right.target),
    ),
  });
  const encoded = Buffer.from(JSON.stringify(normalized), "utf8").toString(
    "base64url",
  );
  const current = normalized.current.map(renderObservation);
  const history = normalized.history.map(renderObservation);
  const links = normalized.links.map(
    (link) => `- [[${link.target}|${safeInline(link.label)}]]`,
  );
  return [
    START,
    `${STATE_PREFIX}${encoded} -->`,
    "## Telegram Graph",
    "",
    "### Current",
    ...(current.length > 0 ? current : ["- No observations yet."]),
    ...(links.length > 0 ? ["", "### Links", ...links] : []),
    "",
    "## History",
    ...(history.length > 0 ? history : ["- No superseded observations."]),
    END,
  ].join("\n");
}

function replaceManaged(body: string, rendered: string): string {
  const start = body.indexOf(START);
  if (start === -1) {
    return `${body.replace(/\s*$/u, "")}\n\n${rendered}\n`.replace(/^\n+/u, "");
  }
  const end = body.indexOf(END, start + START.length);
  if (end === -1) {
    throw new Error("Telegram graph managed section is missing its end marker");
  }
  return `${body.slice(0, start)}${rendered}${body.slice(end + END.length)}`;
}

function quotedTelegramIds(frontmatter: string): string {
  return frontmatter.replace(
    /^(telegram_(?:user|chat)_id): (-?\d+)$/gmu,
    '$1: "$2"',
  );
}

function renderCard(card: CardState): string {
  const parsed = parseFrontmatter(card.original ?? "");
  const safeTitle = safeInline(card.title);
  const defaults: FmFields =
    card.cardType === "contact"
      ? {
          type: "contact",
          description: `Telegram contact ${card.numericId}`,
          tags: ["telegram", "contact-analysis"],
          status: "active",
          telegram_user_id: String(card.numericId),
        }
      : card.cardType === "note"
        ? {
            type: "note",
            description: `Telegram chat ${safeTitle}`,
            tags: ["telegram", "contact-analysis"],
            status: "active",
            telegram_chat_id: String(card.numericId),
          }
        : {
            type: "project",
            description: `Telegram-derived project ${safeTitle}`,
            tags: ["telegram", "contact-analysis"],
            status: "active",
          };
  const fields: FmFields = {};
  for (const [key, value] of Object.entries(defaults)) {
    if (parsed.fields?.[key] === undefined) fields[key] = value;
  }
  const frontmatter = quotedTelegramIds(writeFrontmatter(fields, parsed.lines));
  const initialBody =
    card.original === undefined ? `# ${safeTitle}\n` : parsed.body;
  const body = replaceManaged(initialBody, renderManaged(card.managed));
  return `---\n${frontmatter}\n---\n${body.replace(/\s*$/u, "")}\n`;
}

// eslint-disable-next-line @typescript-eslint/require-await -- the reducer is synchronous inside its multi-file lock but implements the async pipeline boundary.
export async function reduceBatch(
  input: ReduceBatchInput,
): Promise<ReduceResult> {
  requireSafeNonZeroInteger(input.ownerUserId, "owner user ID");
  const batch = AnalysisPageSchema.parse(input.batch);
  if (batch.chatId !== input.dialog.id) {
    throw new Error("analysis batch chat does not match reducer dialog");
  }
  const collective = ["group", "channel"].includes(input.dialog.kind);
  const files = new Set<string>();
  if (collective) files.add(chatCardPath(input.vault, input.dialog));
  for (const observation of batch.observations) {
    const userId = subjectUserId(observation.subjectId);
    if (userId !== null) files.add(contactCardPath(input.vault, userId));
    else if (observation.subjectId === `telegram:chat:${input.dialog.id}`) {
      files.add(chatCardPath(input.vault, input.dialog));
    } else {
      throw new Error(
        `unsupported observation subject ${observation.subjectId}`,
      );
    }
    if (observation.predicate === "works_on" && observation.value) {
      files.add(projectCardPath(input.vault, observation.value));
    }
  }

  const orderedFiles = [...files].sort();
  for (const file of orderedFiles)
    mkdirSync(dirname(file), { recursive: true });
  const releases = orderedFiles.map((file) => acquireLock(file));
  try {
    const cards = new Map<string, CardState>();
    for (const file of orderedFiles) {
      const isContact = file.includes(`${sep}cards${sep}contacts${sep}`);
      const isProject = file.includes(`${sep}cards${sep}projects${sep}`);
      const match = /telegram-user-(-?\d+)\.md$/u.exec(file);
      const projectObservation = batch.observations.find(
        (observation) =>
          observation.predicate === "works_on" &&
          observation.value !== undefined &&
          projectCardPath(input.vault, observation.value) === file,
      );
      cards.set(
        file,
        readCard(
          file,
          isContact ? "contact" : isProject ? "project" : "note",
          isContact ? Number(match?.[1]) : isProject ? null : input.dialog.id,
          isContact
            ? `Telegram user ${match?.[1]}`
            : isProject
              ? (projectObservation?.value ?? "Telegram project")
              : input.dialog.title,
        ),
      );
    }

    for (const observation of batch.observations) {
      const userId = subjectUserId(observation.subjectId);
      const subjectFile =
        userId === null
          ? chatCardPath(input.vault, input.dialog)
          : contactCardPath(input.vault, userId);
      const subjectCard = cards.get(subjectFile);
      if (!subjectCard)
        throw new Error("reducer did not lock the subject card");
      mergeObservation(subjectCard.managed, observation);
    }

    if (collective) {
      const groupFile = chatCardPath(input.vault, input.dialog);
      const groupCard = cards.get(groupFile)!;
      const participantIds = new Set(
        batch.observations
          .map((observation) => subjectUserId(observation.subjectId))
          .filter((id): id is number => id !== null),
      );
      for (const userId of participantIds) {
        const personFile = contactCardPath(input.vault, userId);
        const personCard = cards.get(personFile)!;
        addLink(
          personCard.managed,
          vaultLink(input.vault, groupFile),
          input.dialog.title,
        );
        addLink(
          groupCard.managed,
          vaultLink(input.vault, personFile),
          displayName(personCard),
        );
      }
    }

    for (const observation of batch.observations) {
      if (observation.predicate !== "works_on" || !observation.value) continue;
      const userId = subjectUserId(observation.subjectId);
      if (userId === null) continue;
      const personFile = contactCardPath(input.vault, userId);
      const projectFile = projectCardPath(input.vault, observation.value);
      const personCard = cards.get(personFile)!;
      const projectCard = cards.get(projectFile)!;
      addLink(
        personCard.managed,
        vaultLink(input.vault, projectFile),
        observation.value,
      );
      addLink(
        projectCard.managed,
        vaultLink(input.vault, personFile),
        displayName(personCard),
      );
    }

    const writtenFiles: string[] = [];
    for (const file of orderedFiles) {
      const card = cards.get(file)!;
      const rendered = renderCard(card);
      if (rendered !== card.original) {
        atomicWrite(file, rendered);
        writtenFiles.push(file);
      }
    }
    return {
      writtenFiles,
      observationIds: batch.observations.map(observationId),
    };
  } finally {
    for (const release of releases.reverse()) release();
  }
}
