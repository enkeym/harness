---
name: optimize
description: "Analyze the active agent's context and tool overhead. Load when the user asks to reduce context, token or execution cost or improve agent efficiency."
---

# optimize

Inspect the active client's always-loaded instructions, skill descriptions and representative tool output. Remove duplicated instructions and load details only when needed. Follow tokensave-routing: scoped search, then read mode="lines" around the relevant hit; avoid full-file output and repeated context. Discover optional metrics tools before use; only use session cost data if its parser supports the active client's format and version. State what was actually measured; never invent token or currency totals.

For a representative task, record command-log bytes/lines, repeated reads,
failed tool calls and whether the task completed. Compare similar workloads;
source bytes are not billed tokens. For noisy commands use brief-output.sh
and its full_log metadata. Measure source size before/after instruction edits.
Do not reuse another client's transcript parsers or pricing assumptions. Only add session
usage accounting after obtaining and validating a supported data source for the active client;
unknown usage/cost remains unknown.

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
