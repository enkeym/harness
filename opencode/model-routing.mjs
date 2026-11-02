export const deepseekModels = {
  flash: { providerID: "deepseek", id: "deepseek-flash" },
  pro: { providerID: "deepseek", id: "deepseek-v4-pro" }
}

const specialists = {
  "harness-brief": { skill: "task-brief", task: "Clarify the task, constraints and acceptance criteria. Return a concise brief." },
  "harness-plan": { skill: "task-brief", task: "Inspect the repository and return an actionable implementation plan with checks." },
  "harness-review": { skill: "review", task: "Review the specified change using review-standards and review-security. Return findings with evidence; do not apply fixes." },
  "harness-review-flash": { skill: "review", model: deepseekModels.flash, task: "Review one pinned low-risk MR using the full review-standards and review-security pass. Return needs_pro with evidence if risk or unresolved uncertainty emerges; do not apply fixes." }
}

const deniedActions = ["edit", "subagent", "todowrite", "tokensave_tokensave_str_replace", "tokensave_tokensave_multi_str_replace", "tokensave_tokensave_replace_symbol", "tokensave_tokensave_insert_at", "tokensave_tokensave_insert_at_symbol"]

export function configureDeepSeek(config) {
  const provider = typeof config.model === "string" ? config.model.split("/")[0] : config.model?.providerID
  if (provider !== deepseekModels.flash.providerID) return
  const ref = (model, previous) => {
    const variant = typeof previous === "string" ? previous.split("#")[1] : previous?.variant
    return `${model.providerID}/${model.id}${variant ? `#${variant}` : ""}`
  }
  config.model = ref(deepseekModels.flash, config.model)
  config.agents ??= {}
  for (const name of ["build", "plan", "general", "explore", "ask", "title", "summary", "compaction"]) {
    const previous = config.agents[name] ?? {}
    const model = typeof previous.model === "string" ? previous.model.split("/")[0] : previous.model?.providerID
    if (model && model !== provider) continue
    config.agents[name] = { ...previous, model: ref(deepseekModels.flash, previous.model) }
  }
  config.commands ??= {}
  for (const [name, { skill, task, model = deepseekModels.pro }] of Object.entries(specialists)) {
    config.agents[name] = {
      ...config.agents[name],
      description: task,
      mode: "subagent",
      model: ref(model, config.agents[name]?.model),
      system: `Read project instructions and the ${skill} skill before working. ${task} Use repository tools to obtain evidence. The prompt is the complete task context; do not request or reconstruct the parent's conversation. Do not edit files, commit, push, or delegate. ${skill === "review" ? "For MR work, act as review_worker: true on exactly one pinned MR; return needs_coordinator for an unprepared scope or a queue instead of reviewing multiple MRs. Do not fetch, switch branches, run tests/typecheck or write external notes. " : ""}Return your result directly; do not generate another handoff summary.`,
      permissions: [
        ...(config.agents[name]?.permissions ?? []).filter(rule => !deniedActions.includes(rule.action)),
        ...deniedActions.map(action => ({ action, resource: "*", effect: "deny" }))
      ]
    }
    config.commands[name] = { description: task, agent: name, subagent: true, template: `${task}\nLoad the ${skill} skill. Task and scope:\n$ARGUMENTS` }
  }
}

const temporaryPlanRouting = `Save the accepted plan in .opencode/plans/<task-id>.md under the project root, using a unique task identifier, unless the user explicitly requests another path. Update its completion checkboxes during execution. Keep it while work is unfinished, blocked, or handed off, and record its exact path in the handoff. Delete only this task's temporary plan after the task and its checks are complete, before the final response; this cleanup is authorized. Preserve user-owned plans and other tasks' files. Do not create a root PLAN.md.`

const reviewRouting = `For MR review, stay in the main session as coordinator: read review/reference/mr-delegation.md, pin each selected MR and classify risk without line-count thresholds. Invoke a fresh harness-review-flash worker only when all low-risk conditions hold, otherwise harness-review on Pro. Pass review_worker: true and exactly one pinned MR per worker; never delegate the entire queue. On needs_pro, send the same scope and evidence to a fresh harness-review worker. For non-MR review, invoke a NEW harness-review subagent with the task and diff scope.`

export const deepseekRouting = `DeepSeek model routing: keep this main session on Flash. This configured workflow authorizes specialist subagents unless the user forbids delegation. For a new task needing a brief or substantive planning, invoke ONE NEW native subagent: harness-plan for an implementation plan, or harness-brief for clarification only. Do not call both for the same planning work. Pass only the task, constraints, repository paths, diff scope and necessary accepted decisions. Never paste conversation history or reuse another subagent session. Use the specialist's result directly without an additional summary. ${temporaryPlanRouting} Execute an existing accepted plan on Flash, including handoff and compaction. Track consecutive hypothesis-and-check cycles for the same unresolved problem. A cycle makes progress only when it produces a new verified fact or narrows the search; merely repeating a command or rephrasing a hypothesis is not progress. Reset the count when new evidence advances the investigation. After two consecutive cycles without progress, do not attempt a third cycle on Flash. End the turn with a concise handoff naming checked hypotheses, results and remaining uncertainty, followed by the final line HARNESS-ROUTE: progress=stalled next=investigate. The harness transfers this completed turn to Pro; do not invoke the blocking /handoff command from a tool during the current execution. Do not emit this marker for completed work, cancellation, missing user input, missing permissions or an unavailable external dependency. Do not call Pro planning again unless requirements change or repository evidence invalidates the plan. ${reviewRouting} Delegate only when the current agent and user permissions allow it. A specialist's inability to finish is an error to report, never a reason to silently perform its work on Flash.`

export const deepseekRoutingPro = `DeepSeek model routing: this main session runs on Pro because the investigation stalled or Pro was explicitly selected. Work directly here; do not downgrade this session to Flash. This configured workflow authorizes specialist subagents unless the user forbids delegation. Invoke ONE NEW native subagent for a new task needing a brief or planning: harness-plan for an implementation plan, or harness-brief for clarification only. Do not call both for the same planning work. Pass only the task, constraints, repository paths, diff scope and necessary accepted decisions. Never paste conversation history or reuse another subagent session. Use the specialist's result directly without an additional summary. ${temporaryPlanRouting} Do not call planning again unless requirements change or repository evidence invalidates the plan. ${reviewRouting} Delegate only when the current agent and user permissions allow it. A specialist's inability to finish is an error to report, never a reason to silently perform its work in this session.`

export const deepseekHandoffRouting = `\n\nAfter the handoff, append exactly one final line and nothing after it:\nHARNESS-ROUTE: progress=advancing|stalled next=done|concrete|investigate\nDecide from observed progress on the remaining work. Use progress=advancing when recent checks produced new verified facts or narrowed the search, even if the root cause is unknown. Use progress=stalled when two consecutive hypothesis-and-check cycles neither produced new facts nor narrowed the search; repeating a checked hypothesis is not a concrete next step. Preserve an existing stalled assessment unless subsequent checks advanced the investigation. Name checked hypotheses, their results and remaining uncertainty in the handoff. Use next=done when no authorized work remains or work is blocked on user input, permissions or an external dependency, next=concrete for a specific new action, and next=investigate when further investigation is needed. An unknown cause, task complexity or handoff alone does not imply stalled progress.`

const handoffRoute = /(?:^|\n)[ \t]*HARNESS-ROUTE:[ \t]*progress=(advancing|stalled)[ \t]+next=(done|concrete|investigate)[ \t]*\s*$/

export function parseHandoffRoute(text) {
  const match = handoffRoute.exec(text)
  return match ? { progress: match[1], next: match[2] } : null
}

export function stripHandoffRoute(text) {
  return text.replace(/^[ \t]*HARNESS-ROUTE:.*$/gm, "").trim()
}

export function resolveHandoffModel(sourceModel, route, override) {
  if (override === "pro") return deepseekModels.pro
  if (override === "flash") return deepseekModels.flash
  if (sourceModel.id === deepseekModels.pro.id) return sourceModel
  if (!route) return deepseekModels.flash
  const needsPro = route.progress === "stalled" && route.next !== "done"
  return needsPro ? deepseekModels.pro : deepseekModels.flash
}
