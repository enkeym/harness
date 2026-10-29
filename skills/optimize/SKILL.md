---
name: optimize
description: "Analyze Codex context or tool overhead when the user asks to reduce cost or improve efficiency."
---

# optimize

Inspect always-loaded AGENTS.md, skill descriptions and representative tool output. Remove duplicated instructions and load details only when needed. Follow tokensave-routing: scoped search, then read mode="lines" around the relevant hit; avoid full-file output and repeated context. Discover optional metrics tools before use; only use session cost data if its parser supports the installed Codex format. State what was actually measured; never invent token or currency totals.

For a representative task, record command-log bytes/lines, repeated reads,
failed tool calls and whether the task completed. Compare similar workloads;
source bytes are not billed tokens. For noisy commands use brief-output.sh
and its full_log metadata. Measure source size before/after instruction edits.
Do not restore Claude transcript parsers or pricing tables. Only add session
usage accounting after obtaining and validating a supported Codex data source;
unknown usage/cost remains unknown.
