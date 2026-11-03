---
name: doctor
description: "Load for harness installation or routing audits, missing/incorrect skill loads, failed MCP connections or calls, browser extension connection stalls, stale/broken indexes or lifecycle hooks. Diagnose the active client. Skip ordinary application bugs, public web research and successful tool use; working in the harness repository alone is not a trigger."
---

# doctor

Load when the task concerns harness health or observable infrastructure failures
block an ongoing task; reassess skills at that point without restarting the task.
First correct an invalid tool argument or stale browser ref from its schema or a
fresh snapshot. A page's application error, empty search result or one corrected
argument error does not establish a harness failure. Repeated unchanged failures,
missing registered tools/skills and a browser stuck at connection setup do.
State the failing operation and expected result; diagnose that boundary before
expanding the audit. Combine with hooks-guards for trust/approval failures and
optimize for measured context or cost problems.

For a failed MCP call, separate argument validation, project selection,
transport/server errors and successful empty retrieval. Capture the exact tool,
redacted payload and error when available; compare them with its live schema
and the served project root before naming a cause. A successful corrected call
confirms that payload works, not why the original caller used other arguments.
Do not attribute failure to an old dialogue, stale plan or backend defect
without evidence at that boundary. If the original error is unavailable,
state what was reproduced and what remains unverified.

Identify the active client, its config and skill directories, supported installer
selector and diagnostic commands before running checks. Run the matching harness
installer check and the client's supported version and MCP diagnostics; do not
substitute another client's commands. An unsupported client capability is a
reported limitation, not a reason to switch clients.
For a skills audit, compare ~/.config/harness/repo/skills/*/SKILL.md with the active
client's installed skill links and the session's available-skills catalog; inspect
workflow triggers, relative references and required helpers. Check for missing,
dangling and stale links. shared/ is reference material.
Use supported native diagnostics when needed; keep reports local and quote only
relevant redacted checks. They do not prove skill loading or hook execution.
Harness uses SessionStart/UserPromptSubmit for shared skill routing context and
SessionStart/Stop for background index sync and startup RAG warmup. Context
delivery does not prove the model read a skill. Search routing is guidance.
Audit actual successful skill loads or SKILL.md reads against task intent and
scope changes, including recovery after compaction. Distinguish a catalog entry,
an announced skill, a failed load and a completed read. Inspect ordered tool
calls and outcomes, not keyword counts. Report relevant loads, missing loads,
unnecessary loads and cases with insufficient evidence separately; do not claim
all skills work from sessions that never exercise them. Fix the responsible
description/routing boundary and check both triggering and non-triggering tasks.
Inspect .ragsave/sync.log and ~/.ai-hooks/logs/errors.log on failures.
Check actual MCP requests and index freshness; installed files and autosync=ok
do not prove hooks executed. Distinguish sandbox, network and authentication
errors; reuse existing authorization, never ask for login on a filesystem error.
Reproduce failures with isolated input, preserve user config and run focused tests.
Never print credentials. Consult official hook docs only when changing its protocol.
