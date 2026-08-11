# Human-first contact memory for Iva

- **Status:** approved design
- **Date:** 2026-08-11
- **Scope:** Telegram-derived people, groups, channels, interactions, and person-linked obligations

## 1. Decision

Replace the current observation-first presentation with human-first Markdown that Iva can read as
a coherent profile. The Markdown card is the durable source of truth for a person, group, or
channel. Machine metadata remains minimal and invisible in rendered Markdown and must never appear
in user-facing replies.

Each person has one complete file, including the full meeting history. Person-linked obligations
live in one separate task registry so Iva can answer cross-contact questions efficiently. Person
cards and task entries link to each other with vault-relative wikilinks.

This is externalized learning: the model weights do not change. In-context learning applies only
while Iva is reading a retrieved card during a turn. Post-training is out of scope because the
problem is durable, correctable user state rather than a general model behavior deficit.

### 1.1 Evidence, inference, and unknowns

**Evidence from the current repository:** the contact pipeline already has canonical numeric
Telegram identities, strict typed observations, evidence-bearing model output, per-account durable
checkpoints, serialized reduction, reciprocal vault links, and per-user vault isolation. The current
renderer presents observations and hidden Base64 state rather than a compiled human profile.

**Design inference to validate:** a concise compiled profile plus predictable sections should let Iva
retrieve useful contact context more reliably and produce cleaner answers than raw observation lists.
The structure is intentionally based on the owner's stated retrieval needs, but improved retrieval
quality remains a hypothesis until evaluated on the same contact fixtures.

**Unknowns requiring measurement:** real-card length after months of meetings, extraction precision
on informal Russian messages, birthday inference accuracy, task-completion precision, and whether a
prompt rule alone prevents every metadata leak. The implementation therefore includes bounded
summaries, section-aware retrieval, deterministic validation, and an output leakage gate rather than
assuming the model will always comply.

## 2. Goals

- Let Iva retrieve one person card and immediately understand who the person is, how the owner
  knows them, their current circumstances, relevant preferences, open obligations, and interaction
  history.
- Produce readable Russian prose instead of exposing observation tuples, confidence enums,
  Telegram source identifiers, YAML, JSON, or internal markers.
- Allow the owner to log a meeting naturally and have Iva create a concise meeting summary, update
  stable profile facts, and create any explicit obligations.
- Preserve the complete meeting history in the same person file.
- Track all person-linked obligations in one searchable registry with reciprocal links.
- Close an obligation automatically only when completion is unambiguous; otherwise ask the owner.
- Support partial knowledge, conflicts, corrections, deletion, and changing facts without silently
  turning guesses into current truth.
- Keep user data inside the existing per-user private vault and runtime data roots.

## 3. Non-goals

- A SQL database, CRM server, or external contact provider in the first version.
- Recording every Telegram message as an interaction.
- Inferring meetings the owner did not report.
- Assigning people commercial pipeline stages, usefulness scores, or numerical relationship scores.
- Inferring sensitive traits, diagnoses, politics, religion, sexuality, precise location, or
  financial status.
- Exposing provenance, confidence codes, internal IDs, or maintenance diagnostics in normal chat.
- Automatic outbound contact, birthday congratulations, calendar events, or reminders in this
  feature.

## 4. Storage layout

```text
<vault>/
  cards/
    contacts/
      telegram-user-<numeric-user-id>.md
    notes/
      telegram-group-<absolute-chat-id>.md
      telegram-channel-<absolute-chat-id>.md
  tasks/
    people.md
  inbox/
    contact-analysis-questions.md
```

The canonical identity remains the numeric Telegram identity:

- person: `telegram:user:<user-id>`;
- group or channel: `telegram:chat:<chat-id>`.

Names, usernames, phone numbers, and writing style are mutable attributes and never identity keys.
Two same-named people remain separate unless the owner explicitly merges them or a shared canonical
Telegram user ID proves identity.

## 5. Person card

### 5.1 Minimal frontmatter

Frontmatter contains only stable fields needed for deterministic lookup and indexing. Empty fields
are omitted.

```yaml
---
type: contact
telegram_user_id: "123456789"
full_name: Иван Сергеевич Петров
birthday: 2004-03-18
city: Москва
created: 2026-08-01
updated: 2026-08-11
tags: [друг, университет]
status: active
---
```

`birthday` accepts a full ISO date or a partial recurring date in `--MM-DD` form. Age is never
persisted because it becomes stale. Iva calculates age from a full birth date using the person's
local date when their timezone is known, otherwise `ASSISTANT_TIMEZONE`, and says that the year is
unknown when only month and day are known.

### 5.2 Human-readable body

Only non-empty sections are rendered. The canonical order is:

1. `# <preferred display name>`
2. `## Кратко`
3. `## Как обращаться`
4. `## Основные сведения`
5. `## Контакты`
6. `## Наши отношения`
7. `## Учёба`
8. `## Работа и проекты`
9. `## Связанные люди, группы и проекты`
10. `## Интересы и предпочтения`
11. `## Важные даты`
12. `## Подарки и идеи`
13. `## Интересные факты`
14. `## К следующему разговору`
15. `## Открытые дела`
16. `## История встреч`
17. `## Архив изменений`

`Кратко` is a concise compiled profile, normally one or two paragraphs. It says who the person is,
how they relate to the owner, what they currently do, and what is presently useful before a
conversation. It is updated only after a material change, not rewritten after every message.

`Как обращаться` may include the full name, preferred short name, nickname, pronunciation, and
formality preference.

`Основные сведения` may include birthday, residence at city granularity, time zone, languages, and
explicitly known family context. Exact addresses are not inferred from conversation.

`Контакты` supports multiple labeled phone numbers, email addresses, Telegram usernames, other
online services, preferred channel, and preferred contact time.

`Наши отношения` records how and when the owner met the person, the relationship context, the last
meaningful interaction, and the current shared context. It does not contain an algorithmic closeness
score.

`Учёба` and `Работа и проекты` distinguish current from historical affiliations and allow start/end
dates when known. A new current job moves the old one to `Архив изменений` rather than deleting it.

`Интересы и предпочтения` contains durable hobbies, expertise, interests, likes, dislikes, and
communication preferences. A single casual mention is not automatically promoted to a durable
preference.

`Важные даты` supports birthdays, anniversaries, graduation, moves, and other explicitly relevant
life events. `Подарки и идеи` distinguishes gifts already given, the outcome when known, explicit
wishes, and future ideas.

`К следующему разговору` contains conversational follow-ups that are useful but are not commitments
with deadlines. Real obligations belong in the separate task registry.

`Открытые дела` is a generated linked view of active task records for this person. The task registry,
not the duplicated prose, owns task status.

### 5.3 Example meeting entry

```markdown
## История встреч

### 11 августа 2026 — встреча после учёбы

Встретились в кофейне и около двух часов обсуждали поступление в магистратуру и
образовательный проект Ивана. Иван выбирает между двумя программами и сейчас
собирает портфолио. Я пообещал отправить ему презентацию до пятницы.

**После встречи обновилось:**

- Иван планирует поступать в магистратуру после окончания бакалавриата.
- Сейчас ему особенно интересна обработка естественного языка.
- Добавлено дело: отправить презентацию до 14 августа.
```

Meeting entries are ordered newest first. The complete history stays in the same file. A meeting is
created only from an explicit owner report, never inferred merely from message frequency, location,
or conversational wording.

Storage remains one file even when the history grows. Each meeting summary is concise and contains
only durable context, material changes, and commitments. Retrieval is section-aware: normal contact
answers load the compiled profile and relevant current sections first, while historical questions
search meeting headings and summaries inside the same file. The implementation must measure real
card sizes before selecting chunk limits and must not silently drop old meetings.

### 5.4 Internal metadata

Stable record IDs and provenance may be stored as compact HTML comments adjacent to the relevant
fact, interaction, or link. They are not Base64-encoded, are not the primary human representation,
and are invisible in rendered Markdown. Their schema is versioned and validated before writes.

Internal metadata may contain:

- schema version and stable record ID;
- subject ID;
- source event/message identifiers;
- created and updated timestamps;
- confidence and confirmation count;
- validity interval;
- IDs of facts derived from the record.

The agent output contract forbids reproducing HTML comments or any internal metadata. Read and write
procedures treat metadata as state, never prose.

## 6. Groups and channels

Groups and channels remain separate entities because their meaning differs even though both use
Telegram chat IDs.

### 6.1 Group card

A group card may contain:

1. a concise statement of purpose and the owner's relationship to the group;
2. title, username, and relevant public contact details;
3. known members as wikilinks, with explicit roles only;
4. current projects and shared contexts;
5. communication norms and recurring meeting patterns;
6. important events and decisions;
7. person-linked or group-linked open obligations;
8. a chronological history of material group events.

Anonymous messages remain attributed to the group. Membership, hierarchy, friendship, or authority
is not inferred from message volume.

### 6.2 Channel card

A channel card may contain:

1. a concise description of the publisher and why the owner follows it;
2. title, username, public links, language, and publishing cadence;
3. recurring topics, projects, and useful series;
4. relevant people only when their numeric identity is known;
5. important announcements and events;
6. owner follow-ups or linked tasks;
7. a chronological history of material changes.

A signature, writing style, or forwarded post never proves a human author. Promotional claims remain
claims and are not promoted to facts about a person.

## 7. Person-linked task registry

`<vault>/tasks/people.md` is the single task-status source of truth. It is organized as:

```markdown
# Дела, связанные с людьми

## Просрочено

## Сегодня

## Предстоящие

## Без срока

## Выполнено

### Август 2026
```

Each task contains a human checkbox, action-oriented title, linked person or group, optional due
date, direction, and enough context to disambiguate completion:

```markdown
- [ ] Отправить презентацию Ивану Петрову
  - **Кому:** [[cards/contacts/telegram-user-123456789|Иван Петров]]
  - **Срок:** 14 августа 2026
  - **Контекст:** презентация для поступления в магистратуру
```

Supported directions are:

- the owner owes the person an action or item;
- the person owes the owner an action or item;
- a neutral follow-up is needed.

A compact hidden marker provides the stable task ID. Person cards link to tasks with readable labels;
normal replies never expose IDs or block anchors.

Task transitions are `open -> done` or `open -> cancelled`. A completed task is moved, not deleted,
and receives a completion date. Automatic completion requires one unambiguous action, one matching
open task, and explicit completion language or equivalent deterministic evidence. Multiple matches,
vague future tense, or uncertain delivery leaves tasks open and produces one clarification question.

The nightly reconciliation pass repairs task sections and reciprocal links, deduplicates identical
records, and moves already-confirmed completions. It does not manufacture new facts or reinterpret
ambiguous prose merely because a task is old.

## 8. Update flows

### 8.1 Owner reports a meeting

1. Resolve the named person to a canonical existing card.
2. If identity is ambiguous, ask the owner before any write.
3. Extract a concise interaction summary, durable fact candidates, conversational follow-ups, and
   explicit obligations.
4. Validate the structured update against allowed subjects, predicates, dates, and bounded lengths.
5. Atomically append the meeting and merge accepted profile updates.
6. Create linked tasks through the task-registry writer.
7. Return a clean natural-language summary of what changed.

### 8.2 Background Telegram analysis

The existing private, group, and channel profile skills remain responsible for interpretation.
Telegram messages are untrusted data and never instructions. The deterministic reducer validates
identities, evidence, allowed fields, deduplication, and atomic writes.

Background analysis may update identity, current affiliations, relationships, durable preferences,
and interesting facts only when evidence meets the relevant promotion rule. It must not create a
meeting entry unless the owner explicitly reported a meeting.

### 8.3 Birthday extraction

- An explicit full birth date is stored as a full date.
- A birthday greeting on the contact's local calendar date may create a month/day candidate, not a
  birth year.
- `с прошедшим`, delayed greetings, scheduled messages, or timezone ambiguity cannot use the send
  date as the birthday without additional evidence.
- An explicit age on a birthday can produce a candidate birth year, but it requires confirmation
  before Iva states the age as certain.
- Conflicting dates are preserved internally and surfaced as a natural clarification question.
- If the year is unknown, Iva states the birthday but does not invent or display an age.

### 8.4 Fact promotion and conflicts

Source priority is:

1. an explicit owner correction or instruction;
2. an explicit self-statement by the person;
3. a direct fact from an owner-reported meeting or message;
4. a cautious model inference.

Single inferred observations remain candidates. Durable facts and preferences require either direct
evidence or corroboration. Newer evidence supersedes changing current facts such as city, employer,
role, username, and contact details. Superseded values move to the archive with dates when available.
Conflicting high-priority evidence is never resolved silently.

## 9. Retrieval contract

- Questions about a named person first resolve identity, then read that person's complete card.
- Questions across people, such as `что я должен людям`, read the task registry first and follow only
  the necessary person links.
- Questions about a group or channel read its card and then only the linked people needed for the
  answer.
- A missing field produces `у меня пока нет этих данных`, not a guess.
- An ambiguous identity produces a clarification question before retrieval or mutation.
- Search returns vault-relative paths; all reads and writes remain bounded to the current user's
  vault and reject traversal and symlink escape.

## 10. Clean user-output contract

All user-facing replies are polished natural language in the user's language. The model must never
show or quote:

- HTML comments such as `<!-- iva:interaction:... -->`;
- Telegram source IDs or message coordinates;
- internal record, task, observation, or block IDs;
- YAML frontmatter;
- hidden JSON or serialized state;
- confidence enums such as `EXTRACTED`, `INFERRED`, or `AMBIGUOUS`;
- lock, migration, reducer, or checkpoint diagnostics unless the owner explicitly asks for technical
  diagnostics.

Uncertainty is translated into ordinary language: `похоже`, `возможно`, `я не уверена`, or a concise
clarifying question. After a successful update, Iva reports only the meaningful changes, for example:

> Добавила встречу с Иваном за 11 августа, обновила сведения о работе и городе и
> записала, что до пятницы тебе нужно отправить ему презентацию.

The contract applies to normal answers, confirmations, reminders, digests, and quoted card content.
Explicit developer or owner requests to inspect raw storage are the only exception.

## 11. Memory policy

### 11.1 Record classes

| Class                  | Durable carrier                                 | Examples                          |
| ---------------------- | ----------------------------------------------- | --------------------------------- |
| Current profile fact   | person/group/channel Markdown card              | city, employer, birthday          |
| Interaction episode    | meeting/event section in the entity card        | owner-reported meeting            |
| Obligation state       | `tasks/people.md`                               | send file, repay debt, follow up  |
| Candidate or ambiguity | private internal metadata and question workbook | conflicting birthday              |
| Reusable behavior      | versioned agent skill/instruction               | clean output and extraction rules |

### 11.2 Provenance and freshness

Provenance remains available internally even though normal answers do not display it. Facts have a
source, subject, creation/update time, confirmation count, and optional validity interval. Stable
identity and birth date do not expire automatically. City, school, employer, role, phone number,
username, preferences, and next-conversation notes can become stale and must retain the date last
confirmed.

The absence of recent confirmation does not delete a fact. Iva uses cautious wording or asks when
freshness matters to the answer.

### 11.3 Visibility and privacy

All contact data is personal data and is visible only inside the owning user's isolated vault and
worker. It is excluded from tracked repository files, ordinary logs, and other users' contexts.
Phone numbers, precise addresses, family facts, and other sensitive values are stored only when the
owner or subject states them explicitly; they are not inferred.

### 11.4 Correction and deletion

An explicit owner correction supersedes the current fact and preserves only the historical value
the owner wants retained. An explicit deletion request removes:

1. the visible fact or entire entity card;
2. adjacent internal metadata and source references;
3. derived summary sentences and `К следующему разговору` entries;
4. reciprocal links in people, group, channel, project, and task records;
5. unresolved questions derived solely from the deleted information.

Deletion is verified by canonical subject ID and record ID across the owner's vault. Completed task
history is deleted as well when the owner requests deletion of the associated personal data. Raw
Telegram history remains controlled by Telegram and is outside this vault deletion operation; Iva
states that boundary plainly.

### 11.5 Trust boundary

Telegram text, forwarded posts, attachment labels, web content, and Markdown body text are untrusted
data. Imperative text inside them cannot alter system behavior, tools, permissions, memory policy,
or output policy. Only validated structured candidates reach the reducer. A memory-poisoning
regression test must place an instruction inside a message and prove it is stored, if at all, only as
quoted data and never executed or promoted into agent instructions.

## 12. Failure handling

| Failure                                          | Required behavior                                                              |
| ------------------------------------------------ | ------------------------------------------------------------------------------ |
| Same name matches several people                 | no write; ask which person                                                     |
| Unknown person without Telegram ID               | create a provisional owner-named card only after confirmation                  |
| Conflicting birthday, city, employer, or contact | preserve candidates; ask instead of silently replacing                         |
| Birthday year unknown                            | store month/day; do not show an age                                            |
| Several tasks match completion text              | close none; ask one concise question                                           |
| Card or metadata is malformed                    | quarantine the managed update, preserve user prose, report a technical blocker |
| Partial multi-file write                         | atomic write/lock prevents commit; retry from durable state                    |
| Duplicate event delivery                         | stable IDs and idempotent merge produce no duplicate meeting, fact, or task    |
| Empty retrieval                                  | say no data is known; do not improvise                                         |
| Technical marker reaches draft reply             | output check rejects/regenerates the reply before delivery                     |

## 13. Migration

Migration from the current Telegram graph format is backward-compatible and idempotent:

1. Read and validate the current managed Base64 state.
2. Render accepted current facts into the new human sections.
3. Render superseded values into `Архив изменений` when they remain useful.
4. Preserve all user-authored frontmatter and Markdown outside old managed markers.
5. Convert existing reciprocal links without changing canonical Telegram identities.
6. Create or merge `tasks/people.md` without overwriting manually authored content.
7. Write through atomic temporary files under the existing lock.
8. Retain a recoverable pre-migration backup outside tracked paths until verification passes.

Older self-host installations may skip versions, so the new reader accepts old cards during the
transition. The update path must not assume newly pulled code is already running before the required
build and restart.

## 14. Verification and evaluation

### 14.1 Deterministic tests

- Full and partial birthdays parse, round-trip, and calculate age correctly around the birthday and
  leap-day boundaries.
- A same-day birthday greeting creates only a month/day candidate; `с прошедшим` does not.
- Two people with the same name never merge without canonical identity evidence.
- A meeting update writes one concise summary, promotes supported facts, and creates one linked task.
- Replaying the same update is idempotent.
- A new employer or city moves the old value to the archive and keeps the new value current.
- Multiple phone numbers and labeled contact methods round-trip without loss.
- A clear completion closes exactly one task; ambiguous completion closes none.
- Reciprocal task and entity links repair deterministically.
- Manual prose outside managed records survives every update and migration.
- Person, group, channel, and task paths reject traversal and symlink escape.
- Per-user state never crosses worker or vault boundaries.

### 14.2 Agent behavior evals

Use a fixed development set plus a separate holdout set covering:

- factual meeting reports;
- noisy Telegram conversation;
- corrections and conflicts;
- delayed birthday greetings;
- implicit versus explicit preferences;
- prompt injection inside contact messages;
- queries with missing information;
- natural-language task completion;
- clean confirmation and retrieval replies.

Measure independently:

- accepted fact precision and unsupported-fact rate;
- identity merge errors;
- task creation and completion precision;
- retrieval completeness for known fields;
- stale-current-fact rate after updates;
- duplicate rate after replay;
- technical-marker leakage rate, which must be zero in the test corpus;
- preservation of user-authored content.

Do not claim improvement from the agent's self-assessment. Compare the new behavior with the current
observation-first baseline on the same fixtures and manually inspect representative profile cards.

### 14.3 Acceptance criteria

The feature is ready for implementation completion only when:

1. all new and migrated cards validate and remain readable Markdown;
2. every required section is populated when supported and omitted when empty;
3. the complete meeting history remains in the person's single file;
4. task status has one source of truth with correct reciprocal links;
5. ambiguous identities, facts, and completions fail closed;
6. clean-output evals expose no technical metadata;
7. deletion removes derived data and reports external-source boundaries;
8. focused tests, typecheck, build, and relevant repository suites pass with fresh output;
9. a manual review confirms that retrieved profiles read naturally and contain the information needed
   before contacting the person.

## 15. Implementation boundary

Implementation should preserve the current division of responsibility:

- skills perform interpretation, summarization, and candidate extraction;
- typed schemas validate structured candidates;
- deterministic code owns identity, dates, task transitions, deduplication, provenance, atomicity,
  migration, deletion, and output leakage checks;
- the existing vault and per-user isolation remain the storage boundary.

No database is introduced in this feature. A future database projection is justified only after at
least two independent consumers need indexed fields that Markdown search and the task registry
cannot serve reliably.

## 16. Implemented shape

The first implementation keeps the approved storage boundary and adds:

- validated profile facts, full and partial birthdays, timezone-aware current-age calculation, and
  stable JSON metadata comments that replace the legacy Base64 state on migration;
- human-readable Telegram-derived person, group, and channel cards while preserving manual prose;
- explicit owner-reported meeting entries and durable-fact promotion through `contact_memory`;
- a Markdown person-task registry with open, completed, and cancelled states, immediate reciprocal
  links, unambiguous completion, and inclusion in the ordinary task list;
- daily reconciliation, dry-run legacy inventory, recoverable backups, and idempotent migration;
- clean-output instructions and regression tests preventing technical metadata from appearing in
  normal replies.

The migration API requires an explicit backup directory so operators cannot accidentally place
recoverable legacy copies inside a tracked vault. Deployment and migration execution remain separate
operator actions; this implementation does not mutate a live vault merely because the code was
built.
