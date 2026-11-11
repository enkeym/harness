---
name: handoff
description: "Prepare or restore a compact handoff and continuation plan. Invoke as /handoff; also load for automatic context compaction and session transfer."
---

# handoff

Record the objective, constraints, decisions, completed changes, test results and next concrete step. Include branch, affected paths and log locations, not copied source or full logs. Record applicable skills and instruction paths so the receiving agent can load them. Carry existing authorization, latest user steering and unresolved questions forward. Include a short remaining plan and pending processes or uncertain writes; never replay them blindly.

For a large plan, reference the existing task plan file as its durable cache instead of copying the full plan into each summary. Preserve a compact checkpoint: phase, current unfinished step, relevant verified contracts, missing facts, exact next edit or check and its source paths/symbols or ranges. If no plan file exists during native compaction, retain this checkpoint in the summary without tools; the receiving agent may persist the existing plan once when needed, without replanning.

The Handoff checkpoint supersedes the plan file's own progress notes, which may still describe finished phases. Carry only unfinished steps into the remaining plan; never repeat completed phases as next steps, never copy the executed part of the checklist, and do not tell the receiver to re-read the whole plan or reload already-loaded skills to rediscover progress.

For manual invocation, save a compact note at the requested path, otherwise `.opencode/HANDOFF.md` relative to the project. Create the directory if needed and ensure the default note is ignored by Git before writing it; preserve existing ignore rules. For native compaction, preserve these essentials in the client's required summary template without tools or a separate file write. Automatic maintenance and continuation are authorized by the installed context policy; do not request confirmation for them. Use supported client compaction or the harness-owned fresh-thread mechanism. Do not delete history, switch models outside an explicitly configured routing policy, manufacture token measurements or launch another worker to implement the current task.

After automatic compaction or transfer, restore the objective and remaining plan and continue the next authorized action without waiting for another user message. Keep completed and blocked tasks stopped. OpenCode `/handoff` is owned by the harness plugin: it generates the note without tools, creates a fresh session and submits the continuation there. Never emulate transfer with a shell background task or an invented subagent. In clients without a native transfer control, save the note and state the limitation; do not claim a new session exists. Client controls and thresholds are documented in [context automation](../../docs/context-automation.md).

An adequate authorized implementation plan resumes in implementation. Treat the Handoff checkpoint as authoritative even when a plan file, checklist or phase note is stale. Recover missing applicable instructions, verify the working tree and read the current edit target and only its necessary dependencies; do not reread the entire cached plan or rebuild project context. Reuse recorded decisions and contracts unless changed requirements or contradictory evidence invalidate them. Name a specific missing fact before expanding retrieval. If the same step survives another compaction without progress, narrow it to the smallest coherent edit and check, or report its concrete blocker; do not repeat the same preparation cycle or make an unrelated edit merely to show activity. Progress can be a verified decision or resolved blocker during analysis, not only a code change.

When `task_context` is available, save the current checkpoint and only needed already-observed ranges before manual transfer. During native compaction, retain its reference without tools. On resume, use the checkpoint first and restore selected ranges through `task_context`; never load the entire evidence cache. The tool validates source hashes; stale evidence requires a scoped MCP read. Clear the task cache only after the whole task and checks finish, not after each answer.

Rebuild the note from current state, aiming for at most 3000 characters; replace
the previous snapshot instead of appending. Keep only decisions, affected
contracts and verification the remaining work needs. Use exact paths/symbols,
absolute dates and the next executable action. Read the named ranges on resume;
load applicable skills whose instructions are missing; do not reload all project
files or rerun unchanged successful checks. For native compaction, preserve the
same essentials in the summary and continue the task.
