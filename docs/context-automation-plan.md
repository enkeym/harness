# Automatic context management: implementation plan

Current behavior (updated 2026-10-31 at the user's request): automatic thread
switching has been removed. Each explicit `run` creates one thread; after native
compaction, renewed context pressure saves the checkpoint and stops with
`manual-handoff`. The user starts the next session manually. `maxRotations` is
removed. The plan and completion notes below describe the original implementation;
use `docs/context-automation.md` for the current workflow.

Date: 2026-10-31. User authorized implementation, focused checks, local installation
and automatic continuation in a fresh session without further confirmation.
No push is authorized. Preserve existing changes, especially vscode/.

## Outcome and boundaries

Reduce repeated retrieval, excessive tool output and repeated failures. Keep the
current task progressing automatically while preserving correctness and user
instructions. Provide an observable, bounded lifecycle for context compaction and
fresh-session continuation. Never claim zero token cost or full control of a
third-party client. Do not delete or rewrite Codex rollout history, fabricate tool
results or replay uncertain writes. Do not replace the user's model/provider.

The initial fresh-session transfer is performed by the originating session;
implementation MUST NOT recursively launch another implementation worker merely
because this document mentions a fresh session.

## Evidence already collected

- codex-cli 0.166.0, Node v24.18.0, tokensave 7.16.0.
- install.sh --check passes. MCP tokensave, ragsave and playwright configured.
- RAG last checked healthy, 116 files, zero sync errors. This is not proof of
  trusted hook execution.
- Previous session 01a190cb-c7e2-7b71-9da8-a239a82da5d3: 41 usage events,
  input 4,122,435, cached input 3,997,312, output 29,965; request input grew
  from 15,783 to 155,799. core.md was read 3 times and schemas discovered 8
  times. Several individual outputs were 22-35K characters. Bytes != tokens.
- Native logs ~/.codex/logs_2.sqlite: 48 errors for ONE missing custom-tool
  output call_a128f5b6c9974ca5975b4440eaa358f7 in thread
  01a18974-40dd-7322-a38f-f41ea57e7fa7, not 48 independent failed operations.
- Other observed failures: same-project graph_root rejected; question instead
  of title; TextEncoder absent in functions.exec; WARNING text parsed as JSON;
  WebSocket/network failures. Some errors came from diagnostic scripts, not MCP.
- No ~/.ai-hooks/logs/errors.log currently exists; native logs and rollouts do.

## Existing mechanisms to reuse

- ai-hooks/bin/brief-output.sh: complete output on disk, bounded excerpt and
  exit/log metadata. Current total output budget is 13,000 bytes.
- ai-hooks/bin/mcp-proxy.mjs: compact TokenSave descriptions and lazy Playwright;
  already has substantial uncommitted changes. tools/call results must preserve
  protocol shape and useful errors.
- tokensave_read: file/range digest and if_digest support. Only suppress text
  if it is actually still available in the current context generation.
- skills/handoff/SKILL.md: replace a short checkpoint rather than append history.
- codex/hooks.json: SessionStart and Stop currently perform RAG sync. Do not
  blindly add frequent hooks, replace native defaults or assume hook trust.

## 1. Establish the supported control surface and baseline

Read core rules and applicable skills once. Use scoped MCP navigation. Inspect
only needed package scripts, helpers, tests, installer and existing impact links.
Before modifications record the existing working-tree state outside the repo.
Do not revert, stage or commit pre-existing changes.

Verify installed support through local CLI/schema and actual isolated requests:
native usage events, compaction, hook payloads, fresh-thread start and completion.
Official references: https://learn.chatgpt.com/docs/app-server,
https://learn.chatgpt.com/docs/hooks,
https://learn.chatgpt.com/docs/non-interactive-mode.
Current documentation is not proof that the installed client implements an API.
Prefer native control through a client-owned connection; do not attach unsafely
to an unrelated active UI session or start a competing controller.

## 2. Add passive, versioned accounting and diagnostics

Implement a small Node component following existing patterns. Consume native
events, with incremental local rollout parsing as a supported fallback. Validate
the actual format using small redacted fixtures. Account usage once per response;
never sum cumulative snapshots or double-count token_usage_record and token_count.
Track input, cached input, output, context growth, output bytes, repeated reads,
error classes and progress. Reasoning is a subset where the format says so.
Money and subscription quota estimates remain unknown without a valid source.

State should be atomic, bounded, per project/thread/task/context generation;
use private files outside the indexed repo. Persist parser offsets safely across
truncation/restart. Redact secrets, rotate logs, exclude runtime artifacts from
indexes. Emit short state transitions, not telemetry on every model request.

## 3. Prevent duplicate retrieval safely

Identify content by canonical project/path, range, digest and context generation.
Use explicit versioned markers for rules/skills and discover each needed tool
schema once per generation. A persistent marker alone MUST NOT imply that the
model still holds the content. Invalidate on compaction, clear, fresh session,
changed content, changed schema/backend, project/branch changes as appropriate.
Do not launch another tool call simply to check a marker before every operation.

Use if_digest when the same range is still held; reload when context was lost.
Do not cache or deduplicate arbitrary stateful tool results or writes. Distinguish
exact text suppression from prompt caching: previous content still costs context
until native compaction or a new thread. Keep guidance concise in one owner file.
State accurately which guarantees are enforced by a wrapper and which remain
agent guidance for directly invoked shell/plugin tools.

## 4. Bound output and make error recovery finite

Reuse brief-output for noisy noninteractive commands; preserve exit status,
full-log path and useful failure excerpts. Bound aggregate batch output too.
Apply limits at supported adapters before content enters model history. Avoid
blind JSON truncation and do not suppress errors, structured payloads, images or
binary content. Save full artifacts privately and offer targeted follow-up reads.
Discover only requested schemas, never print the complete tool catalog.

Validate arguments from installed schemas. Do not silently remove graph selectors
intended for another project. Fix known diagnostic assumptions about functions.exec
globals and JSON/content blocks. Logs on stderr are not equivalent to a warning
inside an MCP text result.

Classify failures: argument/schema, missing file/index, temporary transport,
authentication/permission, backend protocol, ambiguous write completion.
Only temporary, demonstrably safe read operations get bounded retries/backoff.
Unchanged deterministic errors do not get repeated. Repeated failure opens a
circuit with one compact diagnostic; no login requests for filesystem failures.
Inspect missing-call-result evidence before attributing it to MCP. Preserve
call/result pairing across controller interruption, compaction and restart.
For upstream bugs provide a redacted reproducer and supported mitigation;
do not pretend a proxy repairs internal Codex history.

## 5. Automate task state, compaction and session lifecycle

Keep a replaceable checkpoint: objective, latest user steering, permissions,
constraints, decisions, changed paths, verification tied to inputs, unresolved
operations, next concrete action. Prefer <=3000 characters; large evidence stays
in referenced artifacts. Clear completed task-specific read caches. Carry durable
project decisions in maintained docs, not accumulating session summaries.

Use current request/context size and growth, remaining work and available native
budget for decisions, not lifetime cumulative input. Defaults must be configurable,
conservative and labelled engineering policy, not measured billing thresholds.
Retain model defaults unless representative measurements justify a change.
Add cooldown/hysteresis, minimum useful progress, bounded rotations/retries and
a total per-objective automation budget. Compaction/transfer costs count too.

During an unfinished task prefer native compaction at a safe boundary; retain
checkpoints and avoid compaction during pending tool calls/writes/tests. After
verified task completion release transient task state. A subsequent independent
task should start fresh in a harness-owned runner; follow-up questions and
unfinished work must retain the relevant state. Do not infer task completion
from every Stop event or automatically spawn endless idle sessions.

Fresh continuation must be native thread/start or codex exec without resume/fork,
seeded with the checkpoint, project instructions and needed content only. Resume
and forks are not context clearing. Verify the new thread has acknowledged the
checkpoint before releasing ownership. Use a single-writer task lease and
crash recovery to prevent concurrent edits or repeated side effects. Record old
and new thread ids. Preserve authorizations, but never transfer safety bypasses
or permissions not granted by the user/environment.

Do not erase transcripts to clear active model context. Deleted files do not
remove messages already sent to the server. History retention is a separate
setting. Existing UI conversations cannot necessarily be silently replaced;
implement and enable supported automation in the harness-owned runner, document
the native UI boundary honestly, and avoid hijacking its thread. User authorizes
automatic checkpointing, safe compaction and continuation for this task.

## 5a. CLI-only automatic transition (user clarification, 2026-10-31)

The user explicitly requests this feature ONLY within Codex CLI. Do not implement
desktop app opening, codex:// handlers, VS Code switching or GUI automation.
Implement it now as part of this task, not merely as a future proposal.

Provide a usable terminal entrypoint that owns the task lifecycle and switches
to a fresh CLI conversation automatically after a safe completion/checkpoint
boundary, carrying only the necessary state. Verify installed native CLI control
and stdin/TTY behavior before selecting the implementation. If native interactive
session switching is unavailable, provide a terminal supervisor/launcher using
supported CLI commands and clearly distinguish its behavior from an unmodified
Codex TUI. Do not claim that changing files switches an existing terminal UI.

The terminal must display the current session id, transition reason, continuation
status and how the user can send steering or stop. Preserve interactive input,
signals, terminal restoration and exit codes. Never concurrently resume a thread
still owned by codex exec; avoid lost user input, concurrent writers, accidental
command replay and unbounded new-session loops. Do not start an idle paid model
turn simply because the previous task completed. Same-task steering and follow-up
questions must not be discarded as independent tasks.

This initial implementation worker is already running in a fresh CLI session;
do not launch another worker for the same implementation. Add the CLI transition
requirement to the implementation checklist and report the exact installed
entrypoint, verified behavior and any native-TUI limitation. Cover terminal and
session ownership behavior with isolated fixtures, not repeated live model runs.

## 6. Integrate, validate and install

Deliver usable commands/configuration, not only an architecture document. Integrate
the existing installer and relevant concise rules/skills. Default safe automation
on in the supported harness-owned workflow; do not break ordinary Codex use.
Document status, run logs, stopping the controller, rollback and limitations.
Run install --check and supported configuration/schema checks after installation.

Read test-conventions before tests and skill-authoring before rules/skills edits.
Test meaningful behavior: usage dedup/reset, stale digests/context invalidation,
UTF-8/aggregate output budgets, preserved JSON/error contracts, retry limits and
uncertain writes, atomic checkpoints, task lease/crash recovery, safe compaction,
fresh continuation seeding and bounded rotation. Use fake backends and synthetic
logs, not live costly repeated model runs. Run the required runtime suite:
node --test --test-concurrency=1 ai-hooks/test/test-*.mjs
Use brief-output for full logs. Run other focused checks for affected components.

Compare a fixed synthetic workload before/after: emitted bytes, repeat calls,
errors and completed outcome. Actual usage needs supported native records;
output reduction must not be presented as billed-token savings.

## Completion

Update this plan with implementation status, concrete commands, checks, measured
results and remaining upstream/UI limitations. Do not silently omit hard parts.
If a capability is absent, ship the supported automatic path and state the exact
boundary. No push, no recursive implementation-worker spawning, no unrelated
edits. Final report in Russian with links to implementation and log artifacts.

## Implementation status — completed 2026-10-31

- Installed `harness-context` through `bin/codex-install.mjs`. Commands, private
  state layout, policy, stop/recovery/rollback and exact limits are documented in
  `docs/context-automation.md`. Ordinary Codex configuration and hooks remain intact.
- `context-runner.mjs` owns an app-server connection, checkpoints completed turns,
  tracks usage/progress, compacts only at safe boundaries, and starts fresh threads
  with preserved objective/permissions/checkpoint and a unique acknowledgement.
  Project lease, uncertain-write stop, cooldown and turn/time/rotation budgets
  prevent automatic replay and endless continuation. No implementation worker was
  spawned; no push or commit was made.
- `context-state.mjs` provides atomic private state, native usage deltas,
  incremental rollout fallback, redacted diagnostics and bounded artifact storage.
  MCP proxy uses generation-scoped digests, branch/backend identity, aggregate
  UTF-8 text budgets, read-only transport retries and deterministic-error circuits.
  Generation/budget paths are explicitly passed through process-local MCP config
  overrides; installed strict config validation passes.
- Native CLI 0.166.0 probe verified initialize, fresh thread/start, structured
  turn completion, usage events and completed contextCompaction. Native usage
  reported 15,566 input and 15 output for the isolated protocol answer. Compaction
  returned last.totalTokens=19,443 with inputTokens=0; fixture preserves this case.
  The probe did not call tools or implement the plan.
- Final required runtime suite: 32 passed, zero failures. Installer --check,
  installed command/status smoke checks, Node/Bash syntax, strict native config,
  impact-map links and scoped diff whitespace checks passed. Global whitespace
  check still reports pre-existing CRLF/trailing whitespace in vscode/settings.json;
  the file was preserved. Baseline verification found no unrelated tracked changes.
- Fixed synthetic workload: 80,723 → 13,867 emitted bytes (~82.8% reduction),
  7 → 6 backend calls, 3 → 2 backend error executions; both runs delivered four
  successes and three expected client-visible errors. Full large-text outcomes
  remained available as private artifacts. This is not billed-token savings.
- Evidence: `/home/enkeym/.local/state/harness/context-automation-20261031/`:
  `runtime-tests.log`, `install.log`, `install-check.log`, `native-probe.json`,
  `proxy-config-check.json`, `impact-map-check.log`, `baseline-verification.json`
  and `result.md`.

Boundaries: UI conversations cannot be silently replaced; direct shell/plugin
output and instruction/schema read reuse remain agent guidance. MCP JSON, errors,
images and structured results are deliberately not truncated. Rewritten/truncated
fallback sources are rebuilt and marked, with lost history left unknown. No exact
upstream missing-custom-tool-output reproducer is established; the redacted
diagnostic recipe and supported mitigation are supplied without claiming a repair.
Subscription quota, money and invisible provider costs remain unknown. Follow-up
steering outside the runner must be supplied in its next objective/checkpoint;
interactive approvals use ordinary Codex. Existing RAG hooks were not replaced,
and their trust/execution was not inferred from configuration checks.
