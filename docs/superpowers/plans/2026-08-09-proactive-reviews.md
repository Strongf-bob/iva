# Proactive Reviews Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:executing-plans to implement this plan task-by-task. Application
> implementation remains in the main agent under this repository's subagent
> policy.

**Goal:** Build an owner-only, durable proactive-report pipeline that prepares
daily and weekly material before 08:00 Europe/Moscow, delivers it once at the
due boundary, recovers missed work, controls alert noise, and turns confirmed
commitment suggestions into idempotent task-provider calls.

**Architecture:** A five-minute Eve schedule invokes a deterministic reconciler.
The reconciler uses narrow providers and a private `node:sqlite` store for
versioning, admission, retry and receipts; report judgement remains behind a
composer port. Telegram callbacks record owner decisions through the same store
and never mutate the personal Telegram account.

**Tech Stack:** TypeScript ESM, Node 24 `node:sqlite`, Eve schedules/client,
Telegram Bot API, Node test runner, Zod.

## Global Constraints

- All wall-clock behavior uses `Europe/Moscow`; daily preparation starts 05:00,
  weekly preparation Monday 05:15, freeze is 07:55, and delivery is due 08:00.
- Monday combines daily and weekly material into one delivery.
- Daily recovery expires after 12 hours; weekly recovery expires after 72 hours.
- High alerts defer during 22:00-08:00 and use a six-hour cooldown; critical
  alerts may bypass quiet hours and use a one-hour cooldown.
- The bot recipient and callback actor must be the owner in a private chat.
- Telegram userbot remains read-only; no send, reaction, delete, join, invite or
  mark-read capability may be added.
- Google Tasks creation occurs only after a durable owner confirmation and uses
  a stable idempotency key. Gmail is never sent and data is never deleted.
- Operational content stays below the per-user `ASSISTANT_DATA_DIR` and outside
  Git. No collector or Containerfile work is included.
- Any authored `agent/` change requires `npm run build` before runtime claims.

---

### Task 1: Time model and provider contracts

**Goal:** Define stable periods, policy decisions and integration ports without
performing I/O.

**Dependencies:** Approved design spec only.

**Files:**

- Create: `scripts/proactive/contracts.ts`
- Create: `scripts/proactive/policy.ts`
- Test: `scripts/proactive/policy.test.ts`

**Accepted decisions:** Moscow timezone, 05:00/05:15 preparation, 07:55 freeze,
08:00 delivery, Monday bundling, bounded recovery and severity cooldowns.

**Interfaces:**

- Produces `ReportKind`, `ReportPeriod`, `ProviderSnapshot`,
  `CommitmentSuggestion`, `UrgentAlert`, `PreparedReport`, and the six provider
  interfaces named in the design.
- Produces `reviewPeriodsAt(nowMs)` and
  `alertAdmission(alert, nowMs, lastDeliveredAt)`.

```ts
export interface ProactiveProviders {
  readonly inbox: UnifiedInboxProvider;
  readonly crm: CrmProvider;
  readonly calendar: CalendarProvider;
  readonly tasks: TasksProvider;
  readonly composer: ReportComposer;
  readonly bot: BotDeliveryProvider;
}

export function reviewPeriodsAt(nowMs: number): readonly ReportPeriod[];
```

**DoD:** Pure functions return stable Moscow period keys and due timestamps;
provider inputs are bounded Zod schemas; quiet-hour and cooldown decisions match
the global constraints.

**Checks:** `node --test scripts/proactive/policy.test.ts` and
`npm run typecheck`.

- [ ] Write tests for Sunday/Monday period selection, 04:59/05:00/05:15/07:55/
      08:00 boundaries, host-timezone independence, recovery expiry, quiet hours and
      cooldowns.
- [ ] Run `node --test scripts/proactive/policy.test.ts`; expect module-not-found
      or missing-export failures.
- [ ] Implement the contracts with bounded strings, item counts and evidence
      references, then implement policy calculations with `Intl.DateTimeFormat` and
      explicit zoned-to-UTC conversion.
- [ ] Re-run the focused test and typecheck; expect all assertions to pass.
- [ ] Commit as `feat(proactive): define review policy and provider ports` with a
      body describing the timing and merge-facing contracts.

### Task 2: Private transactional report store

**Goal:** Persist immutable report versions, delivery ownership, alerts and
commitment decisions across restarts.

**Dependencies:** Task 1 period and action types.

**Files:**

- Create: `scripts/proactive/store.ts`
- Test: `scripts/proactive/store.test.ts`

**Accepted decisions:** One private database per personal data root, SQLite
transactions for admission, opaque callback-token hashes, no destructive
migrations.

**Interfaces:**

- Consumes `ReportKind`, `PreparedReport`, `UrgentAlert` and
  `CommitmentSuggestion`.
- Produces `ProactiveStore.open(dataDir)`, `saveReportVersion`,
  `latestReadyVersion`, `claimDelivery`, `recordDeliveryFailure`,
  `completeDelivery`, `upsertAlert`, `claimAlertDelivery`,
  `createCommitmentActions`, `decideCommitment`, `claimConfirmedCommitment`, and
  `completeCommitmentTask`.

```ts
export class ProactiveStore {
  static open(dataDir: string): ProactiveStore;
  saveReportVersion(input: PreparedReportVersion): StoredReportVersion;
  claimDelivery(input: DeliveryClaimInput): DeliveryClaim | null;
  decideCommitment(input: CommitmentDecisionInput): CommitmentDecisionResult;
  close(): void;
}
```

**DoD:** Reopening a real temporary database preserves state; concurrent claims
have one winner; successful receipts prevent repeats; callback tokens are never
stored raw; database and parent directory are mode 0600/0700; symlink escapes are
rejected.

**Checks:** `node --test scripts/proactive/store.test.ts`, `npm run typecheck`,
and `git check-ignore data/proactive-reviews/state.sqlite`.

- [ ] Write failing tests that reopen the database, compare immutable version
      rows, race two claims, retry after a stored failure, reject a symlinked state
      directory, and prove only a SHA-256 callback hash is stored.
- [ ] Run the focused store test; expect missing store exports.
- [ ] Implement schema version 1 with `DatabaseSync`, foreign keys, WAL, explicit
      transactions and fixed SQL statements. Resolve and validate the state path
      before opening, create private directories, and chmod the database.
- [ ] Re-run focused tests and typecheck; expect all assertions to pass.
- [ ] Commit as `feat(proactive): persist review and action state` with a body
      describing restart safety and deduplication.

### Task 3: Reconciliation service

**Goal:** Prepare and deliver reports, urgent alerts and confirmed commitments
through provider ports with retry and recovery.

**Dependencies:** Task 1 contracts/policy and Task 2 store.

**Files:**

- Create: `scripts/proactive/reconciler.ts`
- Test: `scripts/proactive/reconciler.test.ts`

**Accepted decisions:** Delivery uses prepared versions only; Monday shares one
receipt; failed side effects retain their claim with bounded backoff; missing
providers fail closed.

**Interfaces:**

- Consumes `ProactiveStore` and a `ProactiveProviders` object containing
  `inbox`, `crm`, `calendar`, `tasks`, `composer`, and `bot`.
- Produces `reconcileProactiveReviews({ nowMs, ownerId, store, providers,
settings })` and a bounded `ReconcileResult` of state-transition counts only.

```ts
export async function reconcileProactiveReviews(
  input: ReconcileInput,
): Promise<ReconcileResult>;
```

**DoD:** Tests prove prepare-before-deliver, immutable version use, Monday
bundling, no duplicate send after restart, exponential retry, late recovery and
expiry, high/critical quiet policy, and exactly one task-provider call after
confirmation.

**Checks:** `node --test scripts/proactive/reconciler.test.ts` and
`npm run typecheck`.

- [ ] Write one failing behavior test at a time, beginning with a 05:00 daily
      preparation that gathers all four read providers and saves one ready version.
- [ ] Run each new test and confirm the failure is caused by missing behavior.
- [ ] Implement the smallest state transition needed for the test, re-run it,
      then add the next test for 08:00 delivery, Monday combination, restart dedupe,
      retries, recovery, alerts and commitment execution.
- [ ] Keep provider error data bounded to classifications; never log content or
      raw callback tokens.
- [ ] Run the complete reconciler test and typecheck; expect all assertions to
      pass.
- [ ] Commit as `feat(proactive): reconcile reports alerts and commitments` with
      a body explaining ahead-of-time preparation and receipt-based recovery.

### Task 4: Owner confirmation callbacks

**Goal:** Consume commitment buttons deterministically in the bridge and record
only verified owner decisions.

**Dependencies:** Task 2 store decision API.

**Files:**

- Create: `scripts/proactive/callback.ts`
- Test: `scripts/proactive/callback.test.ts`
- Modify: `scripts/poller/control.ts`
- Modify: `scripts/poller/tenant-routing.test.ts`

**Accepted decisions:** Callback namespace is bridge-owned, token-only, private
owner-only, consume-on-error, and never delivered to the model.

**Interfaces:**

- Produces `handleProactiveCommitmentCallback({ callback, tenant, answer,
openStore }) : Promise<boolean>`.
- Consumes `tenant.user.role`, `tenant.user.id`, `tenant.dataDir`, callback
  sender/chat IDs and `ProactiveStore.decideCommitment`.

```ts
export async function handleProactiveCommitmentCallback(
  input: ProactiveCallbackInput,
): Promise<boolean>;
```

**DoD:** Confirm and dismiss are accepted only for the matching owner/private
chat; foreign user, group, expired, malformed and duplicate tokens reveal no
action content; handled callbacks never reach Eve.

**Checks:** `node --test scripts/proactive/callback.test.ts
scripts/poller/tenant-routing.test.ts` and `npm run typecheck`.

- [ ] Write failing callback tests with injected answer/store functions for
      confirm, dismiss, foreign owner, group, malformed and duplicate cases.
- [ ] Run the focused tests; expect missing handler failures.
- [ ] Implement strict `iva_commitment:(confirm|dismiss):<opaque-token>` parsing,
      verified tenant gates and generic localized answers.
- [ ] Wire the handler before menu/update callback routing in `handleControl` and
      consume every matching-prefix tap even on error.
- [ ] Re-run focused tests and typecheck; expect all assertions to pass.
- [ ] Commit as `feat(proactive): gate commitment actions to the owner` with a
      body explaining private-chat verification and model bypass.

### Task 5: Runtime schedule and adapters

**Goal:** Connect the reconciler to Eve, the existing agent composer path and
Telegram Bot delivery without adding collectors.

**Dependencies:** Tasks 1-4.

**Files:**

- Create: `scripts/proactive/runtime.ts`
- Create: `scripts/proactive/run.ts`
- Create: `scripts/proactive/runtime.test.ts`
- Create: `agent/schedules/proactive-reviews.ts`
- Create: `scripts/proactive-schedule.test.ts`
- Modify: `agent/lib/schedule-paths.ts`
- Modify: `scripts/lib/telegram-send.ts`
- Modify: `scripts/lib/telegram-send.test.ts`
- Modify: `scripts/lib/menu/crons.ts`
- Modify: `docs/deploy.md`
- Modify: `docs/configuration.md`
- Modify: `docs/ru/configuration.md`

**Accepted decisions:** The schedule is opt-in, owner-only, every five minutes,
and uses the existing Eve scheduler. Provider wiring remains narrow so inbox and
CRM collector branches can supply implementations during integration.

**Interfaces:**

- Produces `createRuntimeProviders(env)` with concrete bot and composer adapters
  plus explicit normalized-source adapters; absent source snapshots return empty
  bounded collections rather than reading arbitrary paths.
- Produces `proactiveReviewsJob()` and
  `proactiveReviewsEnabled(settings, env)`.

```ts
export function createRuntimeProviders(
  env: NodeJS.ProcessEnv,
): ProactiveProviders;
export function proactiveReviewsJob(): RunScheduledJobOptions;
export function proactiveReviewsEnabled(
  settings: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): boolean;
```

**DoD:** Runtime reads only fixed files beneath personal data, the composer asks
for final report text from normalized data, bot delivery targets the owner chat
with allowlisted action markup, schedule passes the personal data path and owner
identity, and menu/docs show the opt-in state and cadence.

**Checks:** `node --test scripts/proactive/runtime.test.ts
scripts/proactive-schedule.test.ts`, `npm run typecheck`, `npm run build`, and
focused cron-menu tests.

- [ ] Write failing runtime tests for fixed private paths, empty missing
      snapshots, owner recipient enforcement, action markup and provider error
      classification.
- [ ] Run the runtime tests; expect missing-module failures.
- [ ] Implement runtime adapters using argument arrays, fixed file locations and
      the existing Telegram formatting/security gate. Do not expose a Telegram
      userbot mutation or arbitrary command/path input. Retry only definite Bot API
      rejections; persist ambiguous transport outcomes without an automatic resend.
- [ ] Write and fail schedule tests for `*/5 * * * *`, opt-in, owner-only and the
      exact spawned command contract.
- [ ] Implement the thin schedule/job helpers, then update the cron menu and
      configuration/deploy documentation.
- [ ] Re-run runtime/schedule/menu tests, typecheck and authored-agent build;
      expect zero failures.
- [ ] Commit as `feat(proactive): schedule prepared owner reviews` with a body
      describing opt-in runtime wiring and exact-time reconciliation.

### Task 6: Evidence audit and review

**Goal:** Prove every completion-contract item and leave a clean local branch.

**Dependencies:** Tasks 1-5 complete.

**Files:**

- Modify only files required to resolve verified findings.

**Accepted decisions:** No push, merge, deployment, production contact or
external user contact.

**DoD:** Focused tests, typecheck, lint, formatting, build and full tests pass in
the supported Node 24 environment; independent review has no unresolved Critical
or Important finding; Git contains no runtime data or secrets; branch is clean.

**Checks:** supported-Node invocations of `npm run typecheck`, `npm run lint`,
`npm run format:check`, `npm run build`, `npm test`, `git diff --check`,
`git status --short --branch`, and protected-state `rg`/`git ls-files` checks.

- [ ] Re-read the design completion contract and map every requirement to a
      focused test or diff assertion.
- [ ] Run all focused tests and the complete supported-Node verification suite
      fresh; record exact pass/fail/skip counts.
- [ ] Invoke `requesting-code-review` with the base and head SHAs; resolve every
      Critical and Important finding with TDD and rerun affected checks.
- [ ] Inspect the complete diff for unrelated refactors, hardcoded secrets,
      machine paths, indexed runtime data, widened auth, userbot writes and unsafe
      shell/path handling.
- [ ] If review fixes changed code, commit them using a scoped Conventional
      Commit with a multiline body.
- [ ] Confirm the branch is `strongf/proactive-reviews`, ahead of the approved
      base, and clean; do not push, merge or deploy.
