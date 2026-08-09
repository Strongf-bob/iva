# Iva Chief-of-Staff Design

## Goal

Add a source-backed chief-of-staff workflow to Iva without introducing another
database, role runtime, or orchestration layer. The owner can ask what deserves
attention today, prepare for a conversation with a named person, and review the
week. Every material claim must point to a vault file and preserve any Telegram
message evidence already present in that file.

## Existing foundations

Iva already has the required deterministic substrate:

- `tasks` is the source of open tasks and due dates;
- `memory_search` ranks vault cards and summaries and exposes status,
  confidence, snippets, and file paths;
- `read_file` opens the selected vault evidence;
- contact-analysis cards preserve canonical Telegram identities, temporal
  observations, confidence, and `telegram:message:<chat>:<message>` evidence;
- the Telegram channel already maps `/task`, `/tasks`, and `/digest` to narrow
  model instructions;
- scheduled and on-demand digests already share the agent runtime.

The feature composes these surfaces. It does not create a parallel CRM or copy
Telegram history into a second store.

## Considered approaches

### 1. Skill-first vertical slice (chosen)

Create three narrow bundled skills and two Telegram commands. Skills perform
judgment and synthesis; existing tools remain responsible for deterministic
reads and validation.

Benefits: matches Iva's thin-harness philosophy, has no migration, fails softly
when a source is absent, and stays usable through natural language as well as
commands. Limitation: output quality depends on the configured model, so the
skill contracts need explicit evidence and empty-state tests.

### 2. Deterministic briefing aggregator plus one formatting skill

Add a TypeScript tool that loads tasks, summaries, contact cards, and graph
neighbors into one structured payload.

This gives a strongly typed payload but duplicates retrieval policy already in
`memory_search`, increases the production surface, and makes every schema
extension a code change. It is rejected until real usage proves that model-led
retrieval is unreliable.

### 3. General role framework and dashboard

Add configurable roles, per-role folder policies, and a generated web dashboard.

This is broader than the requested first capability and would mix permissions,
UI, persistence, and briefing behavior in one release. It is deferred. A later
dashboard may render the same briefing output without becoming a source of truth.

## User-facing behavior

### `/brief`

With no argument, load `chief-of-staff-today` and produce a compact attention
brief. It includes:

1. overdue or due-today tasks;
2. high-priority tasks;
3. source-backed commitments, blockers, or unresolved decisions found in recent
   summaries and active cards;
4. one recommended focus for the day.

The brief contains at most seven action bullets. Missing evidence is stated as
missing; it is never filled with generic advice.

### `/brief <person>`

With an argument, load `relationship-briefing`. Resolve the person through
`memory_search`, then read the best contact card and no more than three relevant
linked project, decision, or summary cards. Return:

- current relationship and role context;
- recent decisions and commitments;
- unresolved questions or risks;
- up to five suggested talking points;
- exact source paths and any Telegram evidence identifiers present in the cards.

Ambiguous identities remain ambiguous. The skill shows the candidates instead
of silently choosing one. No message is sent and no task is created.

### `/weekly`

Load `weekly-review`. Read the most recent seven available daily summaries,
current open tasks, and relevant decision/commitment cards. Return:

- three to five recurring themes;
- decision arcs classified as stable, new, conflicting, or changed;
- completed, open, and overdue commitments when supported by evidence;
- the three most important items for the next week;
- source paths for every material item.

One or two available summaries produce a clearly labelled light review. Zero
summaries produce an honest empty result rather than a fabricated review.

## Skill contracts

Each skill is a flat Markdown procedure under `agent/skills/` with `name` and
trigger-only `description` frontmatter. Each procedure follows the same source
contract:

1. gather the smallest sufficient source set;
2. prefer current frontmatter/compiled truth over `History`;
3. distinguish `EXTRACTED`, `INFERRED`, and ambiguous claims;
4. never turn an observation into a task or external action;
5. cite vault-relative paths inline; preserve Telegram evidence IDs verbatim;
6. stop early and say what is absent when evidence is insufficient.

External research informed the output shapes, not the runtime implementation:

- Anthropic's public Agent Skills repository recommends self-contained,
  dynamically loaded and thoroughly tested skills:
  <https://github.com/anthropics/skills>;
- flonat-research's `meetings-weekly` skill contributed the useful ordering of
  conflicting decisions, overdue actions, open commitments, and forward focus:
  <https://github.com/flonat/flonat-research/blob/main/skills/meetings-weekly/SKILL.md>;
- the Second Brain guide contributed the role-lens and evidence-first product
  framing: <https://tochkicamp.ru/guides/second-brain/>.

No third-party skill code, executable, dependency, or registry package is
installed.

## Telegram integration

`agent/lib/i18n.ts` adds `brief` and `weekly` to the single bilingual command
catalog. `agent/channels/telegram.ts` maps the commands to exact skill-loading
instructions:

- `/brief` -> `chief-of-staff-today`;
- `/brief <person>` -> `relationship-briefing` with the untouched user argument;
- `/weekly` -> `weekly-review`.

The existing Telegram allowlist, private/group routing, transcript logging,
prompt-injection handling, and turn lifecycle remain unchanged.

## Failure behavior

- Empty task list: continue with memory evidence; do not invent tasks.
- Empty or unavailable vault: report which source is unavailable and return the
  remaining verified sections.
- Ambiguous person: list candidates with paths and stop before synthesis.
- Stale or superseded fact: exclude it from current truth unless the user asks
  for history.
- Inferred fact: label it as inference.
- Conflicting decisions: show both dates and sources; do not choose silently.
- Tool error: state the unavailable source in one line; never present a partial
  result as complete.

## Testing

Tests are model-independent contract tests plus skill pressure scenarios:

- command catalog and Telegram route tests prove exact command selection and
  argument preservation;
- skill contract tests parse frontmatter and assert required retrieval,
  evidence, ambiguity, empty-state, and no-side-effect behavior;
- baseline and post-skill scenarios compare how an agent responds with and
  without each procedure;
- `typecheck`, lint, formatting, focused Node tests, `npm run build`, and the
  repository test baseline are run with the required Node 24 runtime.

## Documentation

Update the command and use-case documentation. The root README changes only if
its current feature list would otherwise become inaccurate; no unrelated visual
redesign is included.

## Completion contract

Goal:
Deliver the three source-backed chief-of-staff workflows and their Telegram
commands in an isolated branch.

In scope:
Three bundled skills, `/brief`, `/brief <person>`, `/weekly`, focused tests, and
affected user documentation.

Out of scope:
Web dashboard, generic role framework, new database/index, automatic external
writes, email sending, Telegram sending, task creation from inferred commitments,
and production deployment.

Protected state:
The live vault, `data/`, Telegram/userbot sessions, credentials, the current
dirty contact-analysis checkout, and existing command behavior.

Decisions requiring user approval:
None during local implementation. Push, PR, merge, deployment, destructive
operations, and new external credentials remain outside the authorized boundary.

Finish boundary: local

Evidence:

- Command routing -> focused i18n and Telegram channel tests.
- Skill discovery and contracts -> skill contract tests and RED/GREEN scenarios.
- No new production mechanism -> diff inspection and production path inventory.
- Runtime compatibility -> Node 24 typecheck, lint, formatting, build, focused
  tests, and comparison with the recorded repository baseline.
- Protected state -> clean status of the original checkout paths and isolated
  worktree diff.

Stop conditions:

- scope expansion requires new authority;
- destructive or external action is not already authorized;
- the same blocker repeats without a safe alternative.
