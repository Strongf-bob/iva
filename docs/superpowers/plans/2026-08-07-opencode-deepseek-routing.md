# OpenCode DeepSeek Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable production IVA replies through OpenCode Go with DeepSeek V4 Flash for every text/tool turn and Qwen3.7 Plus only for image description.

**Architecture:** Keep the existing provider boundary: `agent/provider.ts` selects one text model at process start, while `agent/vision.ts` performs a narrow image-to-text request before the main turn. Change the production runtime contract and server configuration, then publish through protected `main`; do not add a dynamic router or premium fallback.

**Tech Stack:** Node.js 24, TypeScript, Node test runner, Vercel AI SDK, OpenCode Go OpenAI-compatible API, Docker Compose, GitHub Actions, rootless Docker, Telegram Bot API.

## Global Constraints

- Text/tool model: `deepseek-v4-flash` only.
- Image/OCR model: `qwen3.7-plus`; it must not own final answers or tool calls.
- Context window: `131072`.
- Thinking effort: `medium`.
- The production key exists only in `/home/strongf/iva-runtime/.env` with mode `0600`; never print or commit it.
- No automatic premium-model fallback.
- No production fuzzing or adversarial scan.
- The operator accepts the documented residual risk of direct `.env` exposure to the host-native agent runtime.

---

### Task 1: Lock the production routing contract

**Files:**
- Modify: `scripts/production/release-contract.test.ts`
- Modify: `deploy/container/runtime.env.example`
- Modify: `docs/production-deployment-security-review.md`
- Modify: `docs/superpowers/specs/2026-08-07-opencode-deepseek-routing-design.md`

**Interfaces:**
- Consumes: existing `MODEL_PROVIDER`, `OPENCODE_MODEL`, `OPENCODE_CONTEXT_WINDOW`, `THINKING_EFFORT`, and `providerConfig.visionModel` configuration.
- Produces: a checked-in non-secret production configuration contract and current security status.

- [ ] **Step 1: Write the failing routing-contract test**

Extend `scripts/production/release-contract.test.ts` with a test that reads the non-secret runtime example and provider source:

```ts
void test("production routes text through DeepSeek Flash and images through Qwen", () => {
  const runtime = read("deploy/container/runtime.env.example");
  assert.match(runtime, /^MODEL_PROVIDER=opencode$/mu);
  assert.match(runtime, /^OPENCODE_API_KEY=$/mu);
  assert.match(runtime, /^OPENCODE_MODEL=deepseek-v4-flash$/mu);
  assert.match(runtime, /^OPENCODE_CONTEXT_WINDOW=131072$/mu);
  assert.match(runtime, /^THINKING_EFFORT=medium$/mu);

  const provider = read("agent/provider.ts");
  assert.match(provider, /visionModel: "qwen3\.7-plus"/u);
  assert.match(provider, /process\.env\.OPENCODE_MODEL/u);

  const vision = read("agent/vision.ts");
  assert.match(vision, /Опиши изображение детально/u);
  assert.match(vision, /max_tokens: 700/u);
});
```

- [ ] **Step 2: Run the test and verify the old Codex runtime contract fails**

Run:

```bash
npm test -- scripts/production/release-contract.test.ts
```

Expected: FAIL because `runtime.env.example` still contains `MODEL_PROVIDER=codex` and has no OpenCode production block.

- [ ] **Step 3: Implement the non-secret production defaults**

Replace the model block at the top of `deploy/container/runtime.env.example` with:

```dotenv
MODEL_PROVIDER=opencode
OPENCODE_API_KEY=
OPENCODE_MODEL=deepseek-v4-flash
OPENCODE_CONTEXT_WINDOW=131072
THINKING_EFFORT=medium
```

Keep all real credentials empty.

- [ ] **Step 4: Update security and design status**

Update the production security review so it no longer claims that no model credential is installed. Record OpenCode Go as the external model provider, DeepSeek/Qwen routing, zero-value secret evidence only, and the accepted direct-environment exposure risk. Mark the routing design status as implemented only after production postflight succeeds; before that use `implementation in progress`.

- [ ] **Step 5: Run focused and static verification**

Run:

```bash
npm test -- scripts/production/release-contract.test.ts scripts/lib/model-validation.test.ts scripts/telegram-media-identity.test.ts
git diff --check
```

Expected: all tests pass and `git diff --check` prints nothing.

- [ ] **Step 6: Commit the routing contract**

```bash
git add scripts/production/release-contract.test.ts deploy/container/runtime.env.example docs/production-deployment-security-review.md docs/superpowers/specs/2026-08-07-opencode-deepseek-routing-design.md
git commit -m "feat(models): route production through DeepSeek Flash" -m "Set the non-secret production contract to OpenCode Go with DeepSeek V4 Flash for text and Qwen for bounded image description. Document the accepted direct-environment credential risk and verification boundary."
```

### Task 2: Validate and install the production credential

**Files:**
- Modify on server only: `/home/strongf/iva-runtime/.env`

**Interfaces:**
- Consumes: the OpenCode Go key supplied in the current owner task and the model IDs from Task 1.
- Produces: an atomic, mode-`0600` server configuration with the five production model variables.

- [ ] **Step 1: Resolve the supplied key without displaying it**

Locate the current Codex session record by matching the surrounding user sentence, extract exactly one credential-shaped token in memory, and pipe it directly to the remote updater. Do not place the full value in a shell argument, temporary file, terminal output, Git config, or environment dump. Abort unless exactly one candidate is found.

- [ ] **Step 2: Validate authenticated catalog membership**

Using the key only as an HTTP Authorization header, request `https://opencode.ai/zen/go/v1/models` through the production VPN path. Emit only booleans/status: authentication accepted, `deepseek-v4-flash` present, and `qwen3.7-plus` present.

Expected: HTTP 200 and both model-membership checks true.

- [ ] **Step 3: Run bounded text and vision smokes**

Send one minimal tool-capable chat-completions request to `deepseek-v4-flash` and one synthetic non-sensitive one-pixel/image-text request to `qwen3.7-plus`. Limit outputs to the minimum required and print only status, selected model, non-empty-content boolean, and tool-support boolean.

Expected: both requests succeed; the text model accepts a tools block; vision returns non-empty content.

- [ ] **Step 4: Atomically update the server runtime file**

Use a remote Python updater that reads the secret from stdin, rewrites only these keys, writes a mode-`0600` sibling temporary file, fsyncs it, and replaces `.env` atomically:

```text
MODEL_PROVIDER=opencode
OPENCODE_API_KEY=<stdin secret>
OPENCODE_MODEL=deepseek-v4-flash
OPENCODE_CONTEXT_WINDOW=131072
THINKING_EFFORT=medium
```

Remove obsolete `CODEX_MODEL` and `CODEX_CONTEXT_WINDOW` entries. Preserve all unrelated runtime settings.

- [ ] **Step 5: Verify configuration without values**

Check mode `600`, exactly one occurrence of each required key, expected non-secret values, a non-empty OpenCode key, and absence of `data/codex-auth.json`. Output only the checks and never the key.

### Task 3: Publish, deploy, and verify real replies

**Files:**
- Modify after postflight: `docs/production-deployment-security-review.md`
- Modify after postflight: `docs/superpowers/specs/2026-08-07-opencode-deepseek-routing-design.md`

**Interfaces:**
- Consumes: committed routing contract and validated server configuration.
- Produces: protected-main release, immutable production image, verified Telegram text/image behavior, and fresh audit evidence.

- [ ] **Step 1: Run the full repository verification**

Run the same checks required by CI:

```bash
npm run lint
npm run format:check
IVA_IMAGE=ghcr.io/strongf-bob/iva:ci IVA_ENV_FILE=runtime.env.example docker compose -f deploy/container/compose.production.yml config --quiet
npm test
npm run test:coverage
npm run typecheck
npm run build
python3 -m unittest discover -s scripts/security-defense/tests
```

Expected: every command exits zero. If local Node differs from the required Node 24, treat GitHub CI as the authoritative clean Node 24 run and report the local version warning separately.

- [ ] **Step 2: Review the final diff for secrets and routing scope**

Run `git diff --check`, inspect the full branch diff, and scan tracked files for the supplied credential shape without printing matches. Expected: only contract/docs changes, no production key, no unrelated changes.

- [ ] **Step 3: Push and merge through protected main**

Push `strongf/opencode-deepseek-routing`, create an English PR with Summary/Changes/Motivation/Testing/Notes, wait for required `verify`, and merge only after success and review resolution.

- [ ] **Step 4: Wait for immutable deployment and synchronize bootstrap files**

Wait for the Deploy workflow triggered by the successful `main` CI run. Confirm publish and deploy both target the merge SHA. Synchronize the checked-in runtime example/deploy bootstrap only where required; never overwrite the server `.env` with the example.

- [ ] **Step 5: Restart against the model-enabled environment**

Invoke the restricted deploy command with the exact merge SHA so both containers are recreated with the updated environment. The deploy must retain health, Telegram identity, zero restart counts, limits, loopback binding, and VPN routing.

- [ ] **Step 6: Run bounded production postflight**

Verify:

- Eve health returns `ready`;
- both containers use the merge SHA and have zero restarts;
- Telegram `getMe` matches bot ID `8773401195`;
- application status reports provider `opencode` and model `deepseek-v4-flash` without exposing credentials;
- one owner-only benign text turn receives a real model response;
- one owner-only benign synthetic image turn receives a description-backed response;
- sanitized logs contain no API key or raw secret-shaped values;
- Mihomo remains active, enabled, non-Russian, and on a 60-second URLTest interval.

- [ ] **Step 7: Finalize evidence and commit if documentation changed**

Set the design status to implemented and update the security review with run IDs, merge SHA, model/vision smoke results, SHAD statuses, unknowns, and residual risk. Commit with a multi-line Conventional Commit message, repeat focused verification, and publish through the same protected-main path if the evidence update changes tracked files.

