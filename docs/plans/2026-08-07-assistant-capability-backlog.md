# Iva Capability Backlog

This file records ideas explicitly deferred while the Telegram contact graph is implemented. None
of these items belongs to the current implementation scope.

## 1. LaTeX-only PDF generation

Create an Iva skill and a narrow deterministic build command for generated PDFs:

- use LuaLaTeX or XeLaTeX exclusively;
- adapt the mature LaTeX generation, compilation and render-verification workflow available in the
  Codex environment rather than inventing a weak one-shot template;
- ship Russian-capable templates for reports, articles, letters, CVs and study notes;
- compile repeatedly as required for references and tables of contents;
- validate with `pdfinfo` and `qpdf --check`;
- render every page to images;
- ask the configured multimodal MiniMax M3 reviewer to inspect the rendered pages for clipping,
  overlap, missing glyphs, broken tables, poor hierarchy and inconsistent spacing;
- revise and recompile until deterministic checks pass and the visual reviewer reports no blocking
  defects;
- return both the PDF and its TeX sources.

An instruction alone cannot guarantee LaTeX exclusivity while unrestricted shell tools exist. The
future design must include a tool policy or a single permitted PDF build surface that rejects
non-LaTeX generators.

## 2. Relationship briefing

Before a meeting or requested reply, retrieve the person's contact node, shared groups, projects,
recent commitments and unresolved questions. This should consume the contact graph rather than
create a second profile store.

## 3. Commitment tracker

Extract source-backed promises and deadlines from Telegram and Gmail, deduplicate them, create tasks
only under an explicit policy and surface overdue commitments.

## 4. Unified inbox triage

Combine Telegram and Gmail into a read-only digest: urgent, needs reply, informational and ignorable.
External messages remain untrusted data.

## 5. Context-aware reply drafting

Draft replies using the relationship-specific communication context. Sending remains a separate
explicitly approved action.

## 6. Meeting preparation

Combine calendar events, relevant contacts, projects, documents, prior decisions and unresolved
questions into a compact briefing.

## 7. Personal CRM

Use the contact graph to surface birthdays, promised follow-ups and relationships that have gone
quiet. Avoid manipulative engagement scoring or sensitive-trait inference.

## 8. Weekly review

Summarize completed work, blocked commitments, unanswered conversations and important decisions
using existing memory and task sources.

## Explicitly deferred media work

Voice-to-action and voice-message analysis are not currently planned for implementation. The
contact pipeline records unsupported media counts but does not transcribe or infer from them.
