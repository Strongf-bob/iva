import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { loadJsonStrict, saveJsonAtomic } from "../../agent/lib/json-store.ts";
import { loadRegistry, type RelationshipPaths } from "./store.ts";
import { classifyCommitment } from "./types.ts";

export type ReportPeriod = "daily" | "weekly";
export interface RelationshipReport {
  schema: "iva-relationship-report/v1";
  period: ReportPeriod;
  preparedAt: string;
  text: string;
  deliveredAt: string | null;
}

function file(paths: RelationshipPaths, period: ReportPeriod): string {
  return join(paths.reportsDir, `${period}.json`);
}

export async function prepareRelationshipReport({
  paths,
  period,
  now = new Date().toISOString(),
}: {
  paths: RelationshipPaths;
  period: ReportPeriod;
  now?: string;
}): Promise<RelationshipReport> {
  const registry = await loadRegistry(paths);
  const open = registry.commitments.filter(
    (item) => !["completed", "dismissed"].includes(item.status),
  );
  const rows = open.slice(0, period === "daily" ? 20 : 50).map((item) => {
    const contact = item.contactIds[0]
      ? registry.contacts[item.contactIds[0]]
      : undefined;
    const state = classifyCommitment(
      item,
      now,
      contact?.lastMeaningfulContactAt ?? null,
    );
    const flags = [
      state.overdue && "overdue",
      state.forgotten && "forgotten",
      item.status,
    ]
      .filter(Boolean)
      .join(", ");
    return `- ${item.id}: ${item.text} (${flags})`;
  });
  const report: RelationshipReport = {
    schema: "iva-relationship-report/v1",
    period,
    preparedAt: now,
    text: [
      `Relationship ${period} review`,
      "",
      ...(rows.length ? rows : ["- No open commitments."]),
    ].join("\n"),
    deliveredAt: null,
  };
  await mkdir(paths.reportsDir, { recursive: true, mode: 0o700 });
  await chmod(paths.reportsDir, 0o700);
  await saveJsonAtomic(file(paths, period), report);
  await chmod(file(paths, period), 0o600);
  return report;
}

export async function deliverRelationshipReport({
  paths,
  period,
  ownerUserId,
  destination,
  role,
  now = new Date().toISOString(),
  send,
}: {
  paths: RelationshipPaths;
  period: ReportPeriod;
  ownerUserId: string | undefined;
  destination: string | undefined;
  role: string | undefined;
  now?: string;
  send: (chatId: string, text: string) => Promise<void>;
}): Promise<{ delivered: boolean }> {
  if (role !== "owner" || !ownerUserId || destination !== ownerUserId)
    throw new Error("relationship reports require the owner private chat");
  const report = await loadJsonStrict<RelationshipReport | null>(
    file(paths, period),
    null,
  );
  if (
    !report ||
    report.schema !== "iva-relationship-report/v1" ||
    report.period !== period
  )
    throw new Error("fresh prepared relationship report is required");
  if (report.deliveredAt !== null) return { delivered: false };
  const age = Date.parse(now) - Date.parse(report.preparedAt);
  if (age < 0 || age > 2 * 60 * 60 * 1000)
    throw new Error("prepared relationship report is stale");
  await send(destination, report.text);
  report.deliveredAt = now;
  await saveJsonAtomic(file(paths, period), report);
  await chmod(file(paths, period), 0o600);
  return { delivered: true };
}
