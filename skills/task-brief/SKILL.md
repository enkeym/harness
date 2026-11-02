---
name: task-brief
description: "Analyze and clarify tasks, plan work, design solutions and evaluate improvements or alternatives. Load before substantive task analysis or planning, including when no implementation is requested. Combine with relevant domain and stack skills."
---

# task-brief

Keep small plans in the conversation. When a plan needs a file, use `.codex/plans/<task-id>.md` for Codex or `.opencode/plans/<task-id>.md` for OpenCode under the project root, with a unique task identifier; an explicit user path takes precedence. Reuse the same path across continuation and record it in the handoff. Keep the plan while work is unfinished or blocked. After the task and its checks are complete, delete only this task's temporary plan before the final response; this cleanup is authorized as part of the task. Preserve user-owned plans and other tasks' files. Do not create a root `PLAN.md` or delete an existing root plan without verifying that it is this task's temporary artifact.

Load relevant domain and stack skills before evaluating affected code. Inspect it through tokensave-routing: scoped search and small line ranges; use context without code only to locate unfamiliar structure. Reuse project decisions. State the goal, boundaries, assumptions, proposed steps and verification, scaled to the task. Ask only about unresolved choices that materially affect the result. Existing user authorization is sufficient to proceed; do not introduce an additional approval gate or implement changes when only analysis was requested. For a design choice, compare the strongest alternatives with evidence. Harness health diagnostics belong to doctor; it complements this workflow when that is the subject of analysis.
