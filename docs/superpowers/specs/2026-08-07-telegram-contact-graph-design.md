# Telegram Contact Graph Design

Status: approved in chat; implemented locally; live-account validation pending

## Purpose

When the owner connects a personal Telegram account, Iva should build and maintain a private,
source-backed graph of people, groups, channels, projects, relationships and communication
contexts. The initial run processes every accessible text message. Later runs process only new
messages. The pipeline is read-only and never sends or mutates Telegram data.

The graph remains part of Iva's existing Markdown vault. This preserves the local-first memory
model, Obsidian compatibility, existing `memory_search` retrieval and the generated
`.graph/vault-graph.json` index without introducing Neo4j, Graphiti or another persistent service.

## Product Decisions

- Use three stable skills, one per chat class. Do not generate one skill per actual chat.
- Analyze up to three chats concurrently. Chunks inside one chat remain chronological and
  sequential.
- Process the complete accessible text history on first import. Chunking is a transport and
  context-window boundary, not sampling.
- Use Telegram numeric identifiers as canonical identities. Names, usernames and phone numbers
  are mutable attributes, not keys.
- Represent the owner as a first-class graph node and collect source-separated observations about
  them.
- Store current profiles and relationships in Markdown cards and wikilinks. Store operational
  checkpoints only in the private untracked data directory.
- Keep group-derived claims and model inferences out of `CORE.md`. Promotion to CORE requires an
  explicit owner confirmation.
- Ignore voice and video content in this version. Record only that unsupported media was present.

## Goals

1. Build one durable profile for the same Telegram person across direct messages and groups.
2. Preserve differences between a person's direct-message style and their behavior in each group.
3. Build separate profiles for groups and channels.
4. Populate an owner profile from the owner's messages, direct mentions and statements made by
   others about the owner.
5. Attach message-level provenance and confidence to every material extracted observation.
6. Resume after crashes without skipping or duplicating committed message ranges.
7. Remain safe under the existing `TELEGRAM_EXPOSED_TOOLS=read-only` deployment policy.

## Non-goals

- Sending, replying, forwarding, reacting, joining or inviting through Telegram.
- Voice-note or video-message transcription.
- Psychological diagnoses, protected-trait inference or automatic truth claims based on gossip.
- Automatic merging of two Telegram accounts that may belong to one real person.
- Copying the complete Telegram archive into the vault.
- Replacing Iva's Markdown graph with a graph database.
- Automatically editing `CORE.md` from imported Telegram history.

## Skills

### `telegram-person-profile`

Use for one-to-one dialogs and for reducing observations about a Telegram user across group
contexts. It extracts stable facts, relationship context, projects, commitments, communication
style and source-backed changes over time. It must distinguish:

- facts stated by the person;
- observations about the owner stated by the person;
- model inferences;
- chat-specific style from cross-context traits.

### `telegram-group-profile`

Use for groups and megagroups. It extracts purpose, recurring topics, norms, active participants,
roles, projects, decisions and outstanding commitments. Participant observations retain
`sender_id`, so the reducer can connect the group to existing person cards.

### `telegram-channel-profile`

Use for broadcast channels. It extracts topic, authorship when Telegram exposes it, recurring
formats, usefulness and linked projects. Anonymous channel posts remain attributed to the channel;
the model must not invent a human author.

Each skill produces the same versioned structured observation envelope. Skills encode extraction
judgment; schemas, identifiers, pagination, checkpoints and writes remain deterministic code.

## Architecture

### 1. Read-only Telegram export surface

The existing Python userbot proxy remains the only owner of the Telethon session. Add a narrowly
scoped, bearer-authenticated read surface for the pipeline rather than opening the session from a
second process. It provides:

- the authorized account identity;
- a paginated dialog inventory with an explicit chat kind;
- chronological message pages with chat ID, message ID, sender ID, timestamp, text, reply target,
  mentions and media kind;
- no write methods.

Inputs use explicit schemas and bounded integer/string fields. The proxy never accepts filesystem
paths or shell fragments. Existing read-only tool pruning remains unchanged.

### 2. Coordinator

A TypeScript coordinator owns discovery, checkpoints and bounded concurrency:

1. Confirm that the userbot is authorized and read-only access is available.
2. Read the owner Telegram user ID.
3. Inventory all accessible dialogs.
4. Create or resume one job per dialog.
5. Run at most three chat jobs at once.
6. Fetch a chat's messages oldest-first in bounded pages.
7. Feed pages to that chat's analysis worker sequentially.
8. Validate every worker result before accepting it.
9. Queue validated observations for the single-writer identity reducer.
10. Advance the committed cursor only after the reducer durably updates the vault.

The coordinator can be invoked manually for diagnosis. An in-process schedule detects a newly
authorized account and starts the initial import automatically. Later scheduled runs perform
incremental synchronization. The schedule is only a thin trigger; pipeline logic lives outside the
handler.

### 3. Analysis workers

Every chat receives its own model session and the skill matching its chat kind. The coordinator
sends only one chronological page at a time. The session maintains a bounded rolling summary of
prior pages, so later pages can interpret references without resending the full history.

The worker returns structured observations only. A page is not acknowledged when output is
malformed, lacks required evidence or names identifiers outside the input page. Bounded retries may
repair formatting, but the pipeline never silently substitutes invented data.

### 4. Single-writer identity reducer

Three chat workers may finish concurrently, but only one reducer writes shared memory. The reducer:

- resolves `telegram:user:<user_id>` to one contact card;
- resolves `telegram:chat:<chat_id>` to one group or channel card;
- merges compatible observations;
- preserves contradictions and changes through current truth plus history;
- creates reciprocal wikilinks;
- records the committed message range;
- writes atomically through the existing card-store and frontmatter utilities.

This separation provides three-chat throughput without allowing two workers to overwrite the same
person card.

## Identity Model

Canonical identifiers are:

```text
telegram:user:<user_id>
telegram:chat:<chat_id>
telegram:message:<chat_id>:<message_id>
```

Telethon exposes `chat_id` and `sender_id` independently, so the same sender can be linked across a
direct dialog and multiple groups. Display name, username, phone and photo are versioned attributes.

Rules:

- Equal numeric user IDs are the same Telegram identity.
- Similar names are never enough to merge identities.
- Deleted accounts remain keyed by their known user ID.
- Hidden or anonymous group/channel authors are not resolved to a person.
- Multiple accounts belonging to one real person require a future explicit alias operation.

## Observation Schema

Every accepted observation contains:

```text
schemaVersion
subjectId
kind
predicate
value or objectId
confidence: EXTRACTED | INFERRED | AMBIGUOUS
assertedById (when another participant made the claim)
contextChatId
evidence: [{ chatId, messageId, timestamp }]
validFrom / validUntil (when supported by the messages)
```

`predicate` is an allowlisted enum rather than model-invented relationship names. Initial families
cover identity attributes, roles, group membership, project participation, communication style,
commitments, preferences, direct mentions and external observations about the owner.

The model may summarize evidence but may not emit a material observation without at least one input
message reference.

## Owner Profile

The owner is stored as a dedicated contact node, for example `cards/contacts/self.md`, keyed by the
authorized Telegram user ID. Its content separates:

1. **Self-stated facts** from the owner's messages.
2. **Observed communication behavior** per direct or group context.
3. **External assertions** made by another identified participant.
4. **Model inferences**, always marked `INFERRED` or `AMBIGUOUS`.

Owner references are detected in descending reliability:

- explicit owner user ID;
- a reply to an owner-authored message;
- an exact Telegram `@username` mention;
- a configured name or nickname match;
- contextual pronoun resolution, which must remain ambiguous unless the evidence is decisive.

External assertions are represented as claims by their speaker, not as truth. Sensitive or
diagnostic labels are rejected. Nothing from this card enters the always-on CORE automatically.

## Vault Representation

### Nodes

- People, including the owner: `cards/contacts/telegram-user-<user-id>.md`, type `contact`.
- Groups: `cards/notes/telegram-group-<id>.md`, type `note`, tag `telegram-group`.
- Channels: `cards/notes/telegram-channel-<id>.md`, type `note`, tag `telegram-channel`.
- Projects: existing `cards/projects/*.md` nodes when identity is unambiguous.

No new schema node type is required in the first version, which keeps existing vaults backward
compatible.

The numeric suffix makes the card path stable when a person changes their display name or
username. The card H1 and description remain human-readable and may change without changing the
node identity.

### Edges

Semantic relationships are human-readable bullets containing reciprocal wikilinks and an evidence
summary. Existing Autograph processing turns wikilinks into incoming/outgoing adjacency in
`.graph/vault-graph.json`; `memory_search` can therefore expand from a person to their groups and
projects without another database.

Example:

```markdown
- [[cards/contacts/alexey-petrov|Alexey Petrov]] — backend role;
  evidence: `telegram:message:-100123:4812`.
```

The first version does not extend `vault-graph.json` with typed edge properties. Relationship type,
confidence and provenance remain in the source card. A future deterministic typed-edge index may be
derived from Markdown if real queries require it.

### Temporal truth and provenance

Current compiled truth stays near the top of a card. Compatible new evidence appends to the log;
contradictory new truth uses the existing SUPERSEDE/history semantics. Provenance stores Telegram
references rather than duplicating raw messages. The source remains retrievable from Telegram while
available.

## Operational State

All pipeline state lives under `ASSISTANT_DATA_DIR/contact-analysis/`, which is untracked and private:

```text
state.json                 # version, account identity and global run state
jobs/<chat-id>.json        # fetched, analyzed and committed cursors
observations/<job>/*.json  # validated, not-yet-reduced batches
errors/<chat-id>.json      # sanitized failure state
```

Writes are atomic and mode `0600`; directories are mode `0700`. State validates a versioned schema
on every read. Corrupt state is quarantined and reported rather than treated as an empty first run.
Temporary raw page files are deleted after their validated observations are durable. No state file
contains credentials.

## Failure and Resume Semantics

- One failing chat releases its concurrency slot and does not stop other chats.
- A failed page remains pending with a bounded retry counter and sanitized error.
- FloodWait and transient transport failures honor server timing before retry.
- Permanent access loss marks that chat blocked without advancing its cursor.
- A process crash may repeat the last uncommitted page, but observation IDs and evidence ranges make
  reduction idempotent.
- A cursor advances only after the corresponding vault write is durable.
- Account identity changes stop the run and require a separate state namespace; data from two
  accounts is never silently combined.
- A summary report lists completed, pending, blocked and failed chats without exposing message text.

## Security and Privacy

- The complete feature operates under read-only Telegram exposure.
- Imported messages are untrusted data. Instructions inside them never become agent commands.
- Worker prompts explicitly delimit message data and use the existing security-defense boundary.
- Model output cannot choose a vault path; the reducer derives bounded paths from validated IDs.
- No raw message text appears in logs or error reports.
- No Telegram credential, session value, bearer token or phone number is written to the vault.
- The feature does not infer health, politics, religion, sexuality or other sensitive traits.
- External claims remain attributable and do not silently modify the owner's global persona.

## Testing Strategy

### Unit tests

- Dialog and message normalization for private, group, megagroup, channel, bot and anonymous sender
  cases.
- Stable identity construction and mutable-name updates.
- Oldest-first chunking with no gaps, duplicates or reordering.
- Three-chat concurrency with sequential pages inside each chat.
- Atomic state, corruption quarantine and account namespace separation.
- Observation schema validation, evidence bounds and predicate allowlists.
- Idempotent reduction, reciprocal links, owner-claim separation and SUPERSEDE history.
- Path bounding and secret/message-text redaction.

### Integration tests

- A fake read-only userbot exports several intersecting dialogs where one person appears in direct
  messages and two groups.
- Three workers run concurrently and produce one linked contact card for that person.
- A crash between analysis and reduction resumes without losing or duplicating a message range.
- A malformed model result is rejected and does not advance the cursor.
- A changed display name updates attributes without creating a second identity.
- Owner mentions populate the owner card but never edit CORE.
- Group and channel cards produce valid reciprocal wikilinks and zero new broken-link findings.
- The pipeline contains no callable Telegram write operation.

### Repository verification

- Run focused contact-analysis and userbot tests.
- Run `npm run typecheck`, `npm run lint`, `npm run build` and the full test suite.
- Account for the three pre-existing clean-main baseline failures recorded before feature writes.
- Re-run Autograph graph health against a fixture vault.
- Review tracked files for secrets and private runtime data.

Live-account validation is optional and must remain read-only. Automated tests must not require a
real Telegram account.

## Rollout

1. Ship the skills, proxy read surface, coordinator, reducer and tests disabled by default until the
   userbot is both authorized and configured read-only.
2. Poll readiness every 15 minutes. On first authorized detection, create the account namespace and
   begin the full import with three chat workers. The post-login userbot skill also starts the same
   command immediately after successful QR authorization, while the schedule remains the recovery
   path when login happened elsewhere or the immediate trigger failed.
3. Post progress summaries without raw text and allow safe restart/resume.
4. After the initial import, use incremental scheduled runs.
5. Provide a manual diagnostic invocation that performs the same pipeline without changing
   concurrency or safety semantics.

## Research Basis

- Graphiti's entities, temporal facts and source episodes informed the data model, without adopting
  its separate graph database: <https://github.com/getzep/graphiti>.
- The Zep temporal graph paper motivates changing facts plus provenance:
  <https://arxiv.org/abs/2501.13956>.
- Telethon exposes independent marked chat and sender IDs used by the identity model:
  <https://docs.telethon.dev/en/stable/quick-references/objects-reference.html>.
- Obsidian wikilinks and backlinks match Iva's existing human-readable graph:
  <https://obsidian.md/help/links> and <https://obsidian.md/help/backlinks>.
- Microsoft GraphRAG was considered but is primarily a document indexing and community-summary
  pipeline rather than an incremental personal relationship graph:
  <https://github.com/microsoft/graphrag>.
