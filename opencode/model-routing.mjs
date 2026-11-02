export const deepseekModels = {
  flash: { providerID: "deepseek", id: "deepseek-flash" },
  pro: { providerID: "deepseek", id: "deepseek-v4-pro" }
}

const specialists = {
  "harness-brief": { skill: "task-brief", task: "Clarify the task, constraints and acceptance criteria. Return a concise brief." },
  "harness-plan": { skill: "task-brief", task: "Inspect the repository and return an actionable implementation plan with checks." },
  "harness-review": { skill: "review", task: "Review the specified change using review-standards and review-security. Return findings with evidence; do not apply fixes." }
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
  for (const [name, { skill, task }] of Object.entries(specialists)) {
    config.agents[name] = {
      ...config.agents[name],
      description: task,
      mode: "subagent",
      model: ref(deepseekModels.pro, config.agents[name]?.model),
      system: `Read project instructions and the ${skill} skill before working. ${task} Use repository tools to obtain evidence. The prompt is the complete task context; do not request or reconstruct the parent's conversation. Do not edit files, commit, push, or delegate. Return your result directly; do not generate another handoff summary.`,
      permissions: [
        ...(config.agents[name]?.permissions ?? []).filter(rule => !deniedActions.includes(rule.action)),
        ...deniedActions.map(action => ({ action, resource: "*", effect: "deny" }))
      ]
    }
    config.commands[name] = { description: task, agent: name, subagent: true, template: `${task}\nLoad the ${skill} skill. Task and scope:\n$ARGUMENTS` }
  }
}

export const deepseekRouting = `DeepSeek model routing: keep this main session on Flash. This configured workflow authorizes specialist subagents unless the user forbids delegation. For a new task needing a brief or substantive planning, invoke ONE NEW native subagent: harness-plan for an implementation plan, or harness-brief for clarification only. Do not call both for the same planning work. Pass only the task, constraints, repository paths, diff scope and necessary accepted decisions. Never paste conversation history or reuse another subagent session. Use the specialist's result directly without an additional summary. Save the accepted plan in the task's existing plan file, otherwise PLAN.md, and update its completion checkboxes on Flash. Execute an existing accepted plan on Flash, including handoff and compaction. Do not call Pro planning again unless requirements change or repository evidence invalidates the plan. For the review skill, invoke a NEW harness-review subagent with the task and diff scope. Delegate only when the current agent and user permissions allow it. A specialist's inability to finish is an error to report, never a reason to silently perform its work on Flash.`
