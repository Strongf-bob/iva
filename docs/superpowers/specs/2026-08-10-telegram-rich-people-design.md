# Telegram Rich People Cards Design

## Goal

Render every owner-only People result as one native Telegram Rich Message while
preserving the existing identity resolution, evidence, mutation, and delivery
boundaries.

## Scope

The change covers `/person`, `/person_update`, and the People menu's relationship
brief handoff. It does not add a Mini App, change contact storage, widen access,
send through the personal userbot, or convert unrelated conversational replies to
Rich Messages.

## Chosen approach

People workflows use the existing `rich-post` formatting skill in embedded
renderer mode. The model returns one Rich Markdown response through Eve's normal
reply lifecycle; it does not invoke `send_rich.py`. Each response contains a
native-rich construct, such as a summary table or `<details>` block, so the
existing Telegram renderer selects `sendRichMessage`. The renderer retains its
current HTML and plain-text fallbacks if Telegram rejects rich content.

This is preferable to a separate script send because delivery remains attached to
the current turn and cannot produce a duplicate report plus confirmation. It is
preferable to globally promoting all headings because unrelated short replies stay
on the proven lightweight transport.

## Output contracts

### Person view

The response is one compact card:

- `# 👤 <canonical name>` heading;
- a two-column summary table for relationship, identity, and confidence;
- current facts, commitments, open questions, and uncertainties as bounded lists;
- a collapsed `<details>` section for source paths, Telegram evidence locators,
  and relevant history.

Every memory-derived claim keeps its adjacent vault-relative source. Inferred and
ambiguous information retains explicit confidence language. The collapsed section
is presentation only; it does not weaken the existing maximum of three supporting
cards.

### Relationship brief

The response uses a heading, a short context table, and the existing five sections:
relationship context, commitments, unresolved risks, at most five talking points,
and sources. Sources and historical detail may be grouped in `<details>`, while
claim-level citations remain adjacent to their claims.

### Supplement result

After resolving exactly one existing card, the response reports `NOOP`, `UPDATE`,
or `SUPERSEDE` in a small result table and identifies the changed fact and
vault-relative card path. It never claims success before `write_card` succeeds.
Ambiguous and missing contacts return a rich diagnostic without writing.

## Skill and renderer responsibilities

`rich-post` documents two modes:

1. standalone report delivery through `send_rich.py`;
2. embedded renderer mode for workflows that already own the Eve reply.

In embedded mode the skill produces Rich Markdown only and never sends a second
message. `person-memory` and `relationship-briefing` explicitly select this mode.
The Telegram channel remains the only delivery mechanism and continues to apply
the outbound secret-redaction gate before `sendRichMessage`.

## Safety and compatibility

- People workflows remain owner-only and private-bot-only.
- Personal Telegram userbot remains strictly read-only.
- Identity and supplement text remain separate untrusted data.
- No personal data enters callback payloads.
- No new persistent state, media upload, dependency, or credential is introduced.
- Rich output stays below Telegram's 32,768 UTF-8 character, 500-block, 16-level,
  and 20-column table limits; People output additionally stays compact.
- Rich rejection falls back to the existing chunked Telegram HTML/plain path.

## Verification

Tests must prove that:

- the People skills require embedded `rich-post` renderer mode and a rich-only
  construct for view, brief, success, ambiguity, and not-found paths;
- the Telegram routing context requests one normal rich response and forbids the
  standalone send script;
- representative People cards trigger `needsRichMessage`;
- existing owner gates, untrusted-data separation, and supplement semantics still
  pass;
- build, typecheck, lint, format, focused tests, full Node 24 tests, coverage,
  container smoke, and `git diff --check` pass before publication.
