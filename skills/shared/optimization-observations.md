# Optimization observations

Use this protocol when `optimize` is loaded. Analysis runs on demand; an installed
client integration may collect evidence automatically as documented for that
client. Verify actual records and state the observation window. Never imply that
unobserved sessions are covered. Reuse native exports
and existing helpers; do not introduce client parsers without validating their
schema/version and failure handling against a native sample.

## Persistent evidence

Keep raw logs/exports outside Git in a private local directory. Prefer the
client's native sanitization for retained exports; sanitized fields cannot be
used to measure original output size or inspect hidden retrieval calls. Read
unsanitized content locally only as needed; do not echo secrets or private
prompts. Store compact summaries in
`$XDG_STATE_HOME/harness/optimize/<client>/<project-key>/` (default
`~/.local/state/harness/optimize/<client>/<project-key>/`), where
project-key is a digest of the canonical project path. State the chosen path.
Create the directory with mode 700 and evidence files with mode 600. Preserve
existing records; update by session ID and snapshot timestamp, not append-only
copies of the same totals. Do not commit this telemetry.
Prefer one atomic `sessions/<session-id>.json` snapshot per session; retain older
`observations.json` evidence without adding its duplicate totals. Keep acceptance,
workload, checks and corrections in `assessment`; collectors must preserve it.

For each observation retain:

| Field | Evidence |
| --- | --- |
| Provenance | Client/version, project, session and parent IDs, time window, revision/config fingerprint, native source and schema checked |
| Workload | Task category, scope/complexity, constraints, warm/cold state, fresh session or continuation; synthetic/live label |
| Model | Provider, model, variant and agent for each step; model switches |
| Usage | Input, output, reasoning, cache read/write as separate native counters; field semantics, missing values, zero/synthetic flags |
| Money | Native reported cost separately from validated price estimate; currency, price source/date and coverage; unknown remains null |
| Sequence | Ordered message/tool IDs and timestamps, tool and nested MCP names, status/duration, batching/overlap, retry and fallback evidence |
| Retrieval | Index freshness/coverage, scoped MCP calls, exact path/range fingerprints for repeated reads; possible bypasses need manual verification |
| Output | Emitted bytes/lines separately from full-log bytes and native tokens; unavailable original output remains unknown |
| Delegation | Actual parent/child IDs, agent/model, handoff/prompt size when measurable, waiting, duplicate work, child outcome and usage; verified absence vs unknown |
| Result | Native execution outcome separately from task acceptance, focused checks, rework and user corrections; quality unknown without evidence |
| Coverage | Missing/filtered/truncated records, redactions, unreconciled totals, unobserved task phases and next measurement |

Inspect observable actions and results, not private model reasoning. A repeated
read is a candidate for waste only if the same range/content is still available
in context; edits, compaction and changed requirements may justify it. Retried
exports are snapshots of the same activity, not additional cost.

## Accounting checks

Choose one non-overlapping accounting basis. Verify unique message IDs and
complete time coverage; compare summed request counters with the native
session summary. Record discrepancies and investigate missing/hidden messages,
auxiliary requests or export timing; do not silently replace one with the other.
Determine whether parent totals include children before adding their usage.
If unknown, keep them separate and label family totals incomplete. Link fresh
handoff sessions only with explicit evidence; matching titles are insufficient.

Do not add reasoning to output, or cached input to input, until the supported
client/provider adapter establishes whether the counters overlap. Do not treat
missing fields, all-zero counters or unpriced models as free. Native client
costs may be estimates from configured prices, not a provider invoice. Validate
the configured model price and effective date against the provider's supported
data before a monetary claim; otherwise retain native reported cost with an
unverified-price label. Never retrofit current prices to historical requests
without labeling the result an estimate. Retrieval savings and source bytes
remain separate from billable usage.

## OpenCode v2.2.5 native sources

Use the validated collector in [OpenCode integration documentation](../../docs/opencode.md)
before comparing sessions. Automatic context snapshots are incomplete history until
checked through complete native message pages. Pre-compaction snapshots preserve
observed earlier steps by ID; they cannot recover unseen earlier phases. Inspect
`messageCoverage`, `delegation.childrenComplete`, `gaps` and `accounting.delta`.
The collector's `readyForOptimization: false` is not a permanent ban: it does not
evaluate comparable workloads or acceptance. Apply the readiness checklist below,
retain that assessment and propose only the comparison it supports.

First check the installed version and each command's help; revalidate for a
different version. These commands were observed on v2.2.5:

- `opencode stats --days 7 --project . --full --json`: period/model/tool totals;
  tool names may only show the `execute` wrapper. It cannot prove MCP routing,
  order or absence of children in a specific session family.
- `opencode session list --max-count 100 --format json`: top-level sessions in
  the project; the limit and omission of children constrain coverage.
- `opencode session export <id> --sanitize`: `{info, messages}`; assistant
  messages carry `model`, `agent`, `tokens`, `cost`, `time`, and `content` tool
  parts. Tool parts carry `name`, `state.status`, `state.input` and `time`.
  Sanitization hides arguments, results and nested MCP calls. It preserves
  counters, but is insufficient for bypass and byte-size analysis.

Validate export shape rather than assuming v1 `parts`/`info.role` fields.
Use the installed OpenAPI schema to discover child-session and detailed native
data access; do not guess endpoints. Native aggregate cost can be zero for
nonzero Pro usage. An export's sum can also differ from its session total;
record the discrepancy before selecting an accounting basis. Native status
`succeeded` proves execution finished, not that acceptance checks passed.
Auxiliary title/compaction requests may contribute to native totals without an
assistant message. Keep that difference unallocated unless request evidence
identifies it. Registry price snapshots are dated evidence, not an invoice:
DeepSeek pricing can vary by time window. A historical zero cost is not free
usage and must not be silently repriced at today's rate. Do not sum reasoning
into output or cache into input without verifying the native field semantics.

## Readiness and proposals

Define the comparison and acceptance checks before judging efficiency. Require
complete relevant phases, reconciled usage at the claimed scope, known quality
outcomes and repeated comparable completed workloads. Control task difficulty,
revision, model/variant, cache state, instruction/config changes and session
length; report sample count, variation and confounders. No arbitrary number of
sessions makes unmatched workloads comparable.

For a delegation recommendation, require observed comparable solo and delegated
work, with child accounting and quality checks. If either is absent, leave that
comparison pending and collect natural authorized work; an explicit requested
experiment may supply it. Partial data can support a narrowly scoped finding,
but not a general model/routing/cost optimization plan. Do not change model,
compaction or delegation policy merely to make an incomplete table look better.

After readiness, propose prioritized changes with supporting observation IDs,
measured baseline, expected effect labeled as a hypothesis, quality/latency
tradeoffs, validation and rollback. Measure the same workload after changes;
report observed results and uncertainty instead of promising savings.
