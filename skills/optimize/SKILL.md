---
name: optimize
description: "Observe agent costs, context, tool sequences and delegation before proposing optimization. Load when the user asks to reduce token or execution cost or improve agent efficiency."
---

# optimize

Begin with observation, not optimization. Follow the [observation protocol](../shared/optimization-observations.md) to retain a compact local record across invocations, validate accounting and assess evidence readiness. Inspect the active client's always-loaded instructions, skill descriptions and representative tool output. Follow tokensave-routing: scoped search, then read mode="lines" around the relevant hit; avoid full-file output and repeated context. Discover optional metrics tools before use; only use session cost data if its parser supports the observed client's format and version. When auditing another client, identify it separately from the client running this skill. State what was actually measured; never invent token or currency totals.

For a representative task, record command-log bytes/lines, repeated reads,
failed tool calls and whether the task completed. Compare similar workloads;
source bytes are not billed tokens. For noisy commands use brief-output.sh
and its full_log metadata. Measure source size before/after instruction edits.
Do not reuse another client's transcript parsers or pricing assumptions. Only add session
usage accounting after obtaining and validating a supported data source for the active client;
unknown usage/cost remains unknown.

Observe model/provider/variant, ordered tool calls, retrieval and fallback,
retries, batching, repeated reads, compaction/handoff, task outcome and checks.
Compare completed, similar tasks with and without subagents only when both
are observed; include parent, child, planning, review and summary overhead.
Do not launch subagents or paid benchmark runs merely to fill a comparison.
An aggregate tool histogram cannot establish the sequence or routing compliance.
Missing child exports, redacted execute bodies or unknown prices are gaps,
not zero usage. Reconcile per-request usage with native totals before summing;
never add session totals to their constituent requests or parent-inclusive
totals to child totals. A zero cost with nonzero usage needs price validation.

Until evidence covers the proposed comparison, report observations, gaps and
the next measurement only; defer an optimization plan and savings claims.
After readiness, tie each proposal to evidence, expected benefit, quality risk,
a comparable validation workload and rollback. Apply changes within the user's
authorized scope. Remove duplicate instructions only after measuring them;
load details lazily without dropping required rules.

Compare against the main branch by mechanism: scoped retrieval, bounded logs,
batching, evidence reuse, lazy skill/tool loading, compact handoff and RAG sync.
Check hooks through the active client's supported diagnostics: configured files do not prove trust or execution.
Use a fixed synthetic workload to compare full_log bytes with emitted bytes;
report that ratio as output reduction, never billed-token or monetary savings.
Check cache and model efficiency only from supported native usage data; avoid
unsupported environment flags, transcript formats and fixed context thresholds.
Keep model defaults for compaction unless measured task data justifies a change.

If installed, `tokensave cost today --by-agent --export json` provides a ledger
summary. Verify it contains real usage from the active client and session before drawing cost/cache conclusions:
zero counters or a `<synthetic>` model are not a measurement of this session.
TokenSave retrieval savings are estimates separate from the provider's bill.
