import { createHash, createHmac } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
} from "node:fs";
import { join, sep } from "node:path";
import {
  DatabaseSync,
  type SQLInputValue,
  type StatementSync,
} from "node:sqlite";
import { z } from "zod";

import {
  commitmentSuggestionSchema,
  urgentAlertSchema,
  type CommitmentSuggestion,
  type ProviderFailureKind,
  type ReportKind,
  type UrgentAlert,
} from "./contracts.ts";

const suggestionListSchema = z.array(commitmentSuggestionSchema).max(100);
const alertListSchema = z.array(urgentAlertSchema).max(100);
const CLAIM_STALE_MS = 15 * 60_000;

export interface PreparedReportVersion {
  readonly kind: ReportKind;
  readonly periodKey: string;
  readonly sourceFingerprint: string;
  readonly body: string;
  readonly suggestions: readonly CommitmentSuggestion[];
  readonly alerts: readonly UrgentAlert[];
  readonly preparedAt: number;
}

export interface StoredReportVersion extends PreparedReportVersion {
  readonly id: number;
  readonly version: number;
}

export interface DeliveryClaimInput {
  readonly deliveryKey: string;
  readonly versionIds: readonly number[];
  readonly dueAt: number;
  readonly expiresAt: number;
  readonly nowMs: number;
}

export interface DeliveryClaim {
  readonly deliveryKey: string;
  readonly attempt: number;
}

export type DeliveryState =
  "in_progress" | "retry" | "ambiguous" | "terminal" | "delivered" | "expired";

export interface DeliveryRecord {
  readonly deliveryKey: string;
  readonly state: DeliveryState;
  readonly attempts: number;
  readonly receipt: string | null;
  readonly versionIds: readonly number[];
}

export interface CommitmentDecisionInput {
  readonly token: string;
  readonly ownerId: string;
  readonly decision: "confirmed" | "dismissed";
  readonly nowMs: number;
}

export interface CommitmentDecisionResult {
  readonly status: "accepted" | "already-decided" | "rejected";
}

export interface ConfirmedCommitmentWork {
  readonly actionHash: string;
  readonly suggestion: CommitmentSuggestion;
  readonly idempotencyKey: string;
  readonly attempt: number;
}

type SqlRow = Record<string, unknown>;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isInside(base: string, target: string): boolean {
  return target === base || target.startsWith(`${base}${sep}`);
}

function ensurePrivateDirectory(path: string): void {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error(
      `proactive state directory must not be a symbolic link: ${path}`,
    );
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (!info.isDirectory()) {
    throw new Error(`proactive state path is not a directory: ${path}`);
  }
  chmodSync(path, 0o700);
}

function preparePath(dataDir: string): string {
  ensurePrivateDirectory(dataDir);
  const base = realpathSync(dataDir);
  const stateDir = join(base, "proactive-reviews");
  ensurePrivateDirectory(stateDir);
  const actualStateDir = realpathSync(stateDir);
  if (!isInside(base, actualStateDir)) {
    throw new Error("proactive state directory escaped personal data root");
  }
  const databasePath = join(actualStateDir, "state.sqlite");
  if (existsSync(databasePath) && lstatSync(databasePath).isSymbolicLink()) {
    throw new Error("proactive state database must not be a symbolic link");
  }
  return databasePath;
}

function numberValue(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error("invalid proactive SQLite integer");
  }
  return value;
}

function stringValue(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("invalid proactive SQLite text");
  }
  return value;
}

function nullableString(value: unknown): string | null {
  return value === null ? null : stringValue(value);
}

function rowFrom(
  statement: StatementSync,
  ...args: SQLInputValue[]
): SqlRow | null {
  return (statement.get(...args) as SqlRow | undefined) ?? null;
}

export class ProactiveStore {
  static open(dataDir: string): ProactiveStore {
    const databasePath = preparePath(dataDir);
    const database = new DatabaseSync(databasePath);
    chmodSync(databasePath, 0o600);
    return new ProactiveStore(database, databasePath);
  }

  readonly databasePath: string;
  private readonly database: DatabaseSync;

  private constructor(database: DatabaseSync, databasePath: string) {
    this.database = database;
    this.databasePath = databasePath;
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec("PRAGMA busy_timeout = 5000");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS proactive_schema (
        version INTEGER PRIMARY KEY
      ) STRICT;
      INSERT OR IGNORE INTO proactive_schema(version) VALUES (1);

      CREATE TABLE IF NOT EXISTS proactive_meta (
        key TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS report_attempts (
        kind TEXT NOT NULL,
        period_key TEXT NOT NULL,
        state TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER,
        claimed_at INTEGER,
        last_error_code TEXT,
        PRIMARY KEY (kind, period_key)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS report_versions (
        id INTEGER PRIMARY KEY,
        kind TEXT NOT NULL,
        period_key TEXT NOT NULL,
        version INTEGER NOT NULL,
        source_fingerprint TEXT NOT NULL,
        body TEXT NOT NULL,
        suggestions_json TEXT NOT NULL,
        alerts_json TEXT NOT NULL,
        prepared_at INTEGER NOT NULL,
        state TEXT NOT NULL DEFAULT 'ready',
        UNIQUE (kind, period_key, version),
        UNIQUE (kind, period_key, source_fingerprint)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS deliveries (
        delivery_key TEXT PRIMARY KEY,
        version_ids_json TEXT NOT NULL,
        due_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        state TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER,
        claimed_at INTEGER,
        receipt TEXT,
        last_error_code TEXT,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS urgent_alerts (
        fingerprint TEXT PRIMARY KEY,
        severity TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        state TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        last_delivered_at INTEGER,
        next_attempt_at INTEGER,
        claimed_at INTEGER,
        receipt TEXT,
        last_error_code TEXT
      ) STRICT;

      CREATE TABLE IF NOT EXISTS commitment_actions (
        token_hash TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        suggestion_id TEXT NOT NULL,
        suggestion_json TEXT NOT NULL,
        report_version_id INTEGER NOT NULL,
        decision TEXT NOT NULL DEFAULT 'pending',
        decided_at INTEGER,
        task_idempotency_key TEXT NOT NULL,
        task_state TEXT NOT NULL DEFAULT 'pending',
        task_attempts INTEGER NOT NULL DEFAULT 0,
        task_next_attempt_at INTEGER,
        task_claimed_at INTEGER,
        task_receipt TEXT,
        task_error_code TEXT,
        UNIQUE (owner_id, suggestion_id)
      ) STRICT;
    `);
  }

  close(): void {
    this.database.close();
  }

  private transaction<T>(fn: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.database.exec("COMMIT");
      return value;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  recoveryBaseline(nowMs: number): number {
    return this.transaction(() => {
      const row = rowFrom(
        this.database.prepare(
          "SELECT value FROM proactive_meta WHERE key = 'recovery_baseline_at'",
        ),
      );
      if (row) return numberValue(row.value);
      this.database
        .prepare(
          "INSERT INTO proactive_meta(key, value) VALUES ('recovery_baseline_at', ?)",
        )
        .run(nowMs);
      return nowMs;
    });
  }

  claimPreparation(
    kind: ReportKind,
    periodKey: string,
    nowMs: number,
  ): { readonly attempt: number } | null {
    return this.transaction(() => {
      const select = this.database.prepare(
        "SELECT state, attempts, next_attempt_at, claimed_at FROM report_attempts WHERE kind = ? AND period_key = ?",
      );
      const current = rowFrom(select, kind, periodKey);
      if (!current) {
        this.database
          .prepare(
            "INSERT INTO report_attempts(kind, period_key, state, attempts, claimed_at) VALUES (?, ?, 'claimed', 1, ?)",
          )
          .run(kind, periodKey, nowMs);
        return { attempt: 1 };
      }
      const state = stringValue(current.state);
      const attempts = numberValue(current.attempts);
      const nextAttemptAt = current.next_attempt_at;
      const claimedAt = current.claimed_at;
      const reclaimable =
        (state === "retry" &&
          typeof nextAttemptAt === "number" &&
          nowMs >= nextAttemptAt) ||
        (state === "claimed" &&
          typeof claimedAt === "number" &&
          nowMs - claimedAt >= CLAIM_STALE_MS);
      if (!reclaimable) return null;
      const attempt = attempts + 1;
      this.database
        .prepare(
          "UPDATE report_attempts SET state = 'claimed', attempts = ?, claimed_at = ?, next_attempt_at = NULL WHERE kind = ? AND period_key = ?",
        )
        .run(attempt, nowMs, kind, periodKey);
      return { attempt };
    });
  }

  recordPreparationFailure(input: {
    readonly kind: ReportKind;
    readonly periodKey: string;
    readonly code: string;
    readonly nextAttemptAt: number;
  }): void {
    this.database
      .prepare(
        "UPDATE report_attempts SET state = 'retry', next_attempt_at = ?, claimed_at = NULL, last_error_code = ? WHERE kind = ? AND period_key = ? AND state = 'claimed'",
      )
      .run(
        input.nextAttemptAt,
        input.code.slice(0, 120),
        input.kind,
        input.periodKey,
      );
  }

  expirePreparation(kind: ReportKind, periodKey: string): void {
    this.database
      .prepare(
        "INSERT INTO report_attempts(kind, period_key, state, attempts) VALUES (?, ?, 'expired', 0) ON CONFLICT(kind, period_key) DO UPDATE SET state = CASE WHEN report_attempts.state = 'ready' THEN report_attempts.state ELSE 'expired' END, claimed_at = NULL, next_attempt_at = NULL",
      )
      .run(kind, periodKey);
  }

  saveReportVersion(input: PreparedReportVersion): StoredReportVersion {
    return this.transaction(() => {
      const existing = rowFrom(
        this.database.prepare(
          "SELECT * FROM report_versions WHERE kind = ? AND period_key = ? AND source_fingerprint = ?",
        ),
        input.kind,
        input.periodKey,
        input.sourceFingerprint,
      );
      if (existing) return this.reportFromRow(existing);
      const next = rowFrom(
        this.database.prepare(
          "SELECT COALESCE(MAX(version), 0) + 1 AS version FROM report_versions WHERE kind = ? AND period_key = ?",
        ),
        input.kind,
        input.periodKey,
      );
      const version = numberValue(next?.version);
      const result = this.database
        .prepare(
          "INSERT INTO report_versions(kind, period_key, version, source_fingerprint, body, suggestions_json, alerts_json, prepared_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          input.kind,
          input.periodKey,
          version,
          input.sourceFingerprint,
          input.body,
          JSON.stringify(input.suggestions),
          JSON.stringify(input.alerts),
          input.preparedAt,
        );
      this.database
        .prepare(
          "INSERT INTO report_attempts(kind, period_key, state, attempts, claimed_at) VALUES (?, ?, 'ready', 1, NULL) ON CONFLICT(kind, period_key) DO UPDATE SET state = 'ready', claimed_at = NULL, next_attempt_at = NULL, last_error_code = NULL",
        )
        .run(input.kind, input.periodKey);
      return { ...input, id: Number(result.lastInsertRowid), version };
    });
  }

  latestReadyVersion(
    kind: ReportKind,
    periodKey: string,
  ): StoredReportVersion | null {
    const row = rowFrom(
      this.database.prepare(
        "SELECT * FROM report_versions WHERE kind = ? AND period_key = ? AND state = 'ready' ORDER BY version DESC LIMIT 1",
      ),
      kind,
      periodKey,
    );
    return row ? this.reportFromRow(row) : null;
  }

  reportVersion(id: number): StoredReportVersion | null {
    const row = rowFrom(
      this.database.prepare("SELECT * FROM report_versions WHERE id = ?"),
      id,
    );
    return row ? this.reportFromRow(row) : null;
  }

  private reportFromRow(row: SqlRow): StoredReportVersion {
    const kind = stringValue(row.kind);
    if (kind !== "daily" && kind !== "weekly") {
      throw new Error("invalid proactive report kind");
    }
    return {
      id: numberValue(row.id),
      kind,
      periodKey: stringValue(row.period_key),
      version: numberValue(row.version),
      sourceFingerprint: stringValue(row.source_fingerprint),
      body: stringValue(row.body),
      suggestions: suggestionListSchema.parse(
        JSON.parse(stringValue(row.suggestions_json)),
      ),
      alerts: alertListSchema.parse(JSON.parse(stringValue(row.alerts_json))),
      preparedAt: numberValue(row.prepared_at),
    };
  }

  claimDelivery(input: DeliveryClaimInput): DeliveryClaim | null {
    return this.transaction(() => {
      if (input.nowMs > input.expiresAt) {
        this.database
          .prepare(
            "INSERT INTO deliveries(delivery_key, version_ids_json, due_at, expires_at, state, updated_at) VALUES (?, ?, ?, ?, 'expired', ?) ON CONFLICT(delivery_key) DO UPDATE SET state = CASE WHEN deliveries.state = 'delivered' THEN deliveries.state ELSE 'expired' END, updated_at = excluded.updated_at",
          )
          .run(
            input.deliveryKey,
            JSON.stringify(input.versionIds),
            input.dueAt,
            input.expiresAt,
            input.nowMs,
          );
        return null;
      }
      const select = this.database.prepare(
        "SELECT state, attempts, next_attempt_at, claimed_at FROM deliveries WHERE delivery_key = ?",
      );
      const current = rowFrom(select, input.deliveryKey);
      if (!current) {
        this.database
          .prepare(
            "INSERT INTO deliveries(delivery_key, version_ids_json, due_at, expires_at, state, attempts, claimed_at, updated_at) VALUES (?, ?, ?, ?, 'in_progress', 1, ?, ?)",
          )
          .run(
            input.deliveryKey,
            JSON.stringify(input.versionIds),
            input.dueAt,
            input.expiresAt,
            input.nowMs,
            input.nowMs,
          );
        return { deliveryKey: input.deliveryKey, attempt: 1 };
      }
      const state = stringValue(current.state);
      const attempts = numberValue(current.attempts);
      const nextAttemptAt = current.next_attempt_at;
      const claimedAt = current.claimed_at;
      const reclaimable =
        (state === "retry" &&
          typeof nextAttemptAt === "number" &&
          input.nowMs >= nextAttemptAt) ||
        (state === "in_progress" &&
          typeof claimedAt === "number" &&
          input.nowMs - claimedAt >= CLAIM_STALE_MS);
      if (!reclaimable) return null;
      const attempt = attempts + 1;
      this.database
        .prepare(
          "UPDATE deliveries SET state = 'in_progress', attempts = ?, claimed_at = ?, next_attempt_at = NULL, updated_at = ? WHERE delivery_key = ?",
        )
        .run(attempt, input.nowMs, input.nowMs, input.deliveryKey);
      return { deliveryKey: input.deliveryKey, attempt };
    });
  }

  recordDeliveryFailure(input: {
    readonly deliveryKey: string;
    readonly kind: ProviderFailureKind;
    readonly code: string;
    readonly nextAttemptAt: number | null;
    readonly nowMs: number;
  }): void {
    const state =
      input.kind === "retryable"
        ? "retry"
        : input.kind === "ambiguous"
          ? "ambiguous"
          : "terminal";
    this.database
      .prepare(
        "UPDATE deliveries SET state = ?, next_attempt_at = ?, claimed_at = NULL, last_error_code = ?, updated_at = ? WHERE delivery_key = ? AND state = 'in_progress'",
      )
      .run(
        state,
        input.nextAttemptAt,
        input.code.slice(0, 120),
        input.nowMs,
        input.deliveryKey,
      );
  }

  completeDelivery(deliveryKey: string, receipt: string, nowMs: number): void {
    this.database
      .prepare(
        "UPDATE deliveries SET state = 'delivered', receipt = ?, claimed_at = NULL, next_attempt_at = NULL, last_error_code = NULL, updated_at = ? WHERE delivery_key = ? AND state = 'in_progress'",
      )
      .run(receipt.slice(0, 500), nowMs, deliveryKey);
  }

  delivery(deliveryKey: string): DeliveryRecord | null {
    const row = rowFrom(
      this.database.prepare("SELECT * FROM deliveries WHERE delivery_key = ?"),
      deliveryKey,
    );
    if (!row) return null;
    return {
      deliveryKey,
      state: stringValue(row.state) as DeliveryState,
      attempts: numberValue(row.attempts),
      receipt: nullableString(row.receipt),
      versionIds: z
        .array(z.number().int().positive())
        .parse(JSON.parse(stringValue(row.version_ids_json))),
    };
  }

  upsertAlert(alert: UrgentAlert, nowMs: number): void {
    const parsed = urgentAlertSchema.parse(alert);
    this.database
      .prepare(
        "INSERT INTO urgent_alerts(fingerprint, severity, payload_json, state, first_seen_at, last_seen_at) VALUES (?, ?, ?, 'pending', ?, ?) ON CONFLICT(fingerprint) DO UPDATE SET severity = excluded.severity, payload_json = excluded.payload_json, state = CASE WHEN urgent_alerts.state IN ('ambiguous', 'terminal') THEN urgent_alerts.state ELSE 'pending' END, last_seen_at = excluded.last_seen_at",
      )
      .run(
        parsed.fingerprint,
        parsed.severity,
        JSON.stringify(parsed),
        nowMs,
        nowMs,
      );
  }

  pendingAlerts(): readonly {
    readonly alert: UrgentAlert;
    readonly lastDeliveredAt: number | null;
  }[] {
    return [
      ...this.database
        .prepare(
          "SELECT payload_json, last_delivered_at FROM urgent_alerts WHERE state IN ('pending', 'retry') ORDER BY first_seen_at",
        )
        .all(),
    ].map((row) => ({
      alert: urgentAlertSchema.parse(
        JSON.parse(stringValue((row as SqlRow).payload_json)),
      ),
      lastDeliveredAt:
        typeof (row as SqlRow).last_delivered_at === "number"
          ? numberValue((row as SqlRow).last_delivered_at)
          : null,
    }));
  }

  claimAlertDelivery(
    fingerprint: string,
    nowMs: number,
  ): { readonly attempt: number } | null {
    return this.transaction(() => {
      const row = rowFrom(
        this.database.prepare(
          "SELECT state, attempts, next_attempt_at, claimed_at FROM urgent_alerts WHERE fingerprint = ?",
        ),
        fingerprint,
      );
      if (!row) return null;
      const state = stringValue(row.state);
      const nextAttemptAt = row.next_attempt_at;
      const claimedAt = row.claimed_at;
      const eligible =
        state === "pending" ||
        (state === "retry" &&
          (nextAttemptAt === null ||
            (typeof nextAttemptAt === "number" && nowMs >= nextAttemptAt))) ||
        (state === "claimed" &&
          typeof claimedAt === "number" &&
          nowMs - claimedAt >= CLAIM_STALE_MS);
      if (!eligible) return null;
      const attempt = numberValue(row.attempts) + 1;
      this.database
        .prepare(
          "UPDATE urgent_alerts SET state = 'claimed', attempts = ?, claimed_at = ?, next_attempt_at = NULL WHERE fingerprint = ?",
        )
        .run(attempt, nowMs, fingerprint);
      return { attempt };
    });
  }

  deferAlert(fingerprint: string, until: number): void {
    this.database
      .prepare(
        "UPDATE urgent_alerts SET state = 'retry', next_attempt_at = ?, claimed_at = NULL WHERE fingerprint = ? AND state IN ('pending', 'retry', 'claimed')",
      )
      .run(until, fingerprint);
  }

  recordAlertFailure(input: {
    readonly fingerprint: string;
    readonly kind: ProviderFailureKind;
    readonly code: string;
    readonly nextAttemptAt: number | null;
  }): void {
    const state =
      input.kind === "retryable"
        ? "retry"
        : input.kind === "ambiguous"
          ? "ambiguous"
          : "terminal";
    this.database
      .prepare(
        "UPDATE urgent_alerts SET state = ?, next_attempt_at = ?, claimed_at = NULL, last_error_code = ? WHERE fingerprint = ? AND state = 'claimed'",
      )
      .run(
        state,
        input.nextAttemptAt,
        input.code.slice(0, 120),
        input.fingerprint,
      );
  }

  completeAlert(fingerprint: string, receipt: string, nowMs: number): void {
    this.database
      .prepare(
        "UPDATE urgent_alerts SET state = 'delivered', receipt = ?, last_delivered_at = ?, claimed_at = NULL, next_attempt_at = NULL, last_error_code = NULL WHERE fingerprint = ? AND state = 'claimed'",
      )
      .run(receipt.slice(0, 500), nowMs, fingerprint);
  }

  createCommitmentActions(input: {
    readonly ownerId: string;
    readonly reportVersionId: number;
    readonly suggestions: readonly CommitmentSuggestion[];
    readonly tokenSecret: string;
    readonly nowMs: number;
  }): readonly { readonly suggestionId: string; readonly token: string }[] {
    if (input.tokenSecret.length < 32) {
      throw new Error("commitment action token secret is too short");
    }
    return this.transaction(() =>
      suggestionListSchema.parse(input.suggestions).map((suggestion) => {
        const token = createHmac("sha256", input.tokenSecret)
          .update(`${input.ownerId}\0${suggestion.id}`)
          .digest("base64url");
        const tokenHash = sha256(token);
        const idempotencyKey = sha256(
          `google-task\0${input.ownerId}\0${suggestion.id}`,
        );
        this.database
          .prepare(
            "INSERT OR IGNORE INTO commitment_actions(token_hash, owner_id, suggestion_id, suggestion_json, report_version_id, task_idempotency_key) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run(
            tokenHash,
            input.ownerId,
            suggestion.id,
            JSON.stringify(suggestion),
            input.reportVersionId,
            idempotencyKey,
          );
        return { suggestionId: suggestion.id, token };
      }),
    );
  }

  decideCommitment(input: CommitmentDecisionInput): CommitmentDecisionResult {
    const tokenHash = sha256(input.token);
    return this.transaction(() => {
      const row = rowFrom(
        this.database.prepare(
          "SELECT decision FROM commitment_actions WHERE token_hash = ? AND owner_id = ?",
        ),
        tokenHash,
        input.ownerId,
      );
      if (!row) return { status: "rejected" };
      if (stringValue(row.decision) !== "pending") {
        return { status: "already-decided" };
      }
      const result = this.database
        .prepare(
          "UPDATE commitment_actions SET decision = ?, decided_at = ? WHERE token_hash = ? AND owner_id = ? AND decision = 'pending'",
        )
        .run(input.decision, input.nowMs, tokenHash, input.ownerId);
      return { status: result.changes === 1 ? "accepted" : "already-decided" };
    });
  }

  claimConfirmedCommitment(nowMs: number): ConfirmedCommitmentWork | null {
    return this.transaction(() => {
      const row = rowFrom(
        this.database.prepare(
          "SELECT token_hash, suggestion_json, task_idempotency_key, task_attempts FROM commitment_actions WHERE decision = 'confirmed' AND (task_state = 'pending' OR (task_state = 'retry' AND (task_next_attempt_at IS NULL OR task_next_attempt_at <= ?)) OR (task_state = 'claimed' AND task_claimed_at <= ?)) ORDER BY decided_at LIMIT 1",
        ),
        nowMs,
        nowMs - CLAIM_STALE_MS,
      );
      if (!row) return null;
      const actionHash = stringValue(row.token_hash);
      const attempt = numberValue(row.task_attempts) + 1;
      this.database
        .prepare(
          "UPDATE commitment_actions SET task_state = 'claimed', task_attempts = ?, task_claimed_at = ?, task_next_attempt_at = NULL WHERE token_hash = ?",
        )
        .run(attempt, nowMs, actionHash);
      return {
        actionHash,
        suggestion: commitmentSuggestionSchema.parse(
          JSON.parse(stringValue(row.suggestion_json)),
        ),
        idempotencyKey: stringValue(row.task_idempotency_key),
        attempt,
      };
    });
  }

  recordCommitmentTaskFailure(input: {
    readonly actionHash: string;
    readonly kind: ProviderFailureKind;
    readonly code: string;
    readonly nextAttemptAt: number | null;
  }): void {
    const state =
      input.kind === "retryable"
        ? "retry"
        : input.kind === "ambiguous"
          ? "ambiguous"
          : "terminal";
    this.database
      .prepare(
        "UPDATE commitment_actions SET task_state = ?, task_next_attempt_at = ?, task_claimed_at = NULL, task_error_code = ? WHERE token_hash = ? AND task_state = 'claimed'",
      )
      .run(
        state,
        input.nextAttemptAt,
        input.code.slice(0, 120),
        input.actionHash,
      );
  }

  completeCommitmentTask(
    actionHash: string,
    receipt: string,
    nowMs: number,
  ): void {
    this.database
      .prepare(
        "UPDATE commitment_actions SET task_state = 'completed', task_receipt = ?, task_claimed_at = NULL, task_next_attempt_at = NULL, task_error_code = NULL, decided_at = COALESCE(decided_at, ?) WHERE token_hash = ? AND task_state = 'claimed'",
      )
      .run(receipt.slice(0, 500), nowMs, actionHash);
  }
}
