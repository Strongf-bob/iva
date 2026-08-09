import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { acquireLock, atomicWrite } from "../../agent/lib/card-store.ts";
import {
  classifyCommitment,
  RelationshipRegistrySchema,
  type RelationshipRegistry,
} from "./types.ts";

const START = "<!-- iva:relationship-crm:start -->";
const END = "<!-- iva:relationship-crm:end -->";

function safe(value: string): string {
  return value
    .replace(/\p{Cc}+/gu, " ")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/([\\`*_{}[\]()#|])/gu, "\\$1")
    .replace(/\s+/gu, " ")
    .trim();
}

function replaceRegion(original: string, region: string): string {
  const start = original.indexOf(START);
  if (start < 0) return `${original.trimEnd()}\n\n${region}\n`;
  const end = original.indexOf(END, start);
  if (end < 0)
    throw new Error(
      "relationship CRM managed section is missing its end marker",
    );
  return `${original.slice(0, start)}${region}${original.slice(end + END.length)}`;
}

function contactRegion(
  id: string,
  registry: RelationshipRegistry,
  now: string,
): string {
  const activity = registry.contacts[id];
  const commitments = registry.commitments.filter(
    (item) =>
      item.contactIds.includes(id) &&
      !["completed", "dismissed"].includes(item.status),
  );
  const lines = commitments
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((item) => {
      const state = classifyCommitment(
        item,
        now,
        activity?.lastMeaningfulContactAt ?? null,
      );
      const labels = [
        state.overdue && "overdue",
        state.forgotten && "forgotten",
        item.status,
      ]
        .filter(Boolean)
        .join(", ");
      return `- ${safe(item.id)} ${safe(item.text)} (${labels}; direction: ${item.direction}; evidence: ${item.evidence.map((e) => safe(e.sourceId)).join(", ")})`;
    });
  return [
    START,
    "## Relationship CRM",
    "",
    `- Birthday: ${activity?.birthday?.value ?? "unknown"}${activity?.birthday ? ` (evidence: ${safe(activity.birthday.evidence.sourceId)})` : ""}`,
    `- Last meaningful contact: ${activity?.lastMeaningfulContactAt ?? "unknown"}${activity?.meaningfulContactEvidence ? ` (evidence: ${safe(activity.meaningfulContactEvidence.sourceId)})` : ""}`,
    "",
    "### Open promises and follow-ups",
    ...(lines.length ? lines : ["- None."]),
    END,
  ].join("\n");
}

// eslint-disable-next-line @typescript-eslint/require-await -- synchronous multi-file locking is exposed through the async pipeline boundary.
export async function renderRelationshipCrm({
  vault,
  registry: raw,
  now = new Date().toISOString(),
}: {
  vault: string;
  registry: RelationshipRegistry;
  now?: string;
}): Promise<{ writtenFiles: string[] }> {
  const registry = RelationshipRegistrySchema.parse(raw);
  const files = Object.keys(registry.contacts).map((id) =>
    join(
      vault,
      "cards",
      "contacts",
      `telegram-user-${id.split(":").at(-1)}.md`,
    ),
  );
  const overview = join(vault, "cards", "notes", "relationship-crm.md");
  files.push(overview);
  files.sort();
  for (const file of files) mkdirSync(dirname(file), { recursive: true });
  const releases = files.map((file) => acquireLock(file));
  const writtenFiles: string[] = [];
  try {
    for (const [id] of Object.entries(registry.contacts)) {
      const file = join(
        vault,
        "cards",
        "contacts",
        `telegram-user-${id.split(":").at(-1)}.md`,
      );
      const original = existsSync(file)
        ? readFileSync(file, "utf8")
        : `# Telegram user ${id.split(":").at(-1)}\n`;
      const next = replaceRegion(original, contactRegion(id, registry, now));
      if (next !== original) {
        atomicWrite(file, next);
        writtenFiles.push(file);
      }
    }
    const original = existsSync(overview)
      ? readFileSync(overview, "utf8")
      : "# Relationship CRM\n";
    const open = registry.commitments
      .filter((item) => !["completed", "dismissed"].includes(item.status))
      .sort((a, b) => a.id.localeCompare(b.id));
    const row = (item: (typeof open)[number]) => {
      const contact = item.contactIds[0]
        ? registry.contacts[item.contactIds[0]]
        : undefined;
      const state = classifyCommitment(
        item,
        now,
        contact?.lastMeaningfulContactAt ?? null,
      );
      return `- ${safe(item.id)} ${safe(item.text)} (${item.status}; direction: ${item.direction}; evidence: ${item.evidence.map((entry) => safe(entry.sourceId)).join(", ")}; overdue: ${state.overdue}; forgotten: ${state.forgotten})`;
    };
    const birthdays = Object.entries(registry.contacts)
      .filter(([, contact]) => contact.birthday !== null)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([id, contact]) =>
          `- ${safe(id)}: ${contact.birthday!.value} (evidence: ${safe(contact.birthday!.evidence.sourceId)})`,
      );
    const overdue = open.filter((item) => {
      const contact = item.contactIds[0]
        ? registry.contacts[item.contactIds[0]]
        : undefined;
      return classifyCommitment(
        item,
        now,
        contact?.lastMeaningfulContactAt ?? null,
      ).overdue;
    });
    const forgotten = open.filter((item) => {
      const contact = item.contactIds[0]
        ? registry.contacts[item.contactIds[0]]
        : undefined;
      return classifyCommitment(
        item,
        now,
        contact?.lastMeaningfulContactAt ?? null,
      ).forgotten;
    });
    const pending = open.filter((item) => item.status === "pending_suggestion");
    const next = replaceRegion(
      original,
      [
        START,
        "## Upcoming birthdays",
        "",
        ...(birthdays.length ? birthdays : ["- None."]),
        "",
        "## Overdue promises",
        "",
        ...(overdue.length ? overdue.map(row) : ["- None."]),
        "",
        "## Pending suggestions",
        "",
        ...(pending.length ? pending.map(row) : ["- None."]),
        "",
        "## Forgotten follow-ups",
        "",
        ...(forgotten.length ? forgotten.map(row) : ["- None."]),
        END,
      ].join("\n"),
    );
    if (next !== original) {
      atomicWrite(overview, next);
      writtenFiles.push(overview);
    }
    return { writtenFiles };
  } finally {
    for (const release of releases.reverse()) release();
  }
}
