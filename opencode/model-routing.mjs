import { deepseekTokenRates } from "./cost-policy.mjs"

export const deepseekModels = {
  flash: { providerID: "deepseek", id: "deepseek-flash" },
  pro: { providerID: "deepseek", id: "deepseek-v4-pro" }
}

export function offPeakModelID(id) {
  if (typeof id !== "string") return id
  const canonical = id.replace(/-(offpeak|peak)$/, "")
  return canonical in deepseekTokenRates ? `${canonical}-offpeak` : id
}

export function configureModelRouting(config) {
  const specialists = ["harness-brief", "harness-plan", "harness-review", "harness-review-flash"]
  const legacy = specialists.some(name => config.agents?.[name] || config.commands?.[name])
  for (const name of specialists) {
    if (config.agents) delete config.agents[name]
    if (config.commands) delete config.commands[name]
  }
  const inherited = ["build", "plan", "general"]
  const names = legacy ? [...inherited, "explore", "ask", "title", "summary", "compaction"] : inherited
  for (const name of names) {
    const agent = config.agents?.[name]
    const model = agent?.model
    const id = typeof model === "string" ? model.split("#")[0] : model?.providerID === "deepseek" ? `deepseek/${model.id}` : null
    if (id === "deepseek/deepseek-flash" || id === "deepseek/deepseek-v4-pro") delete agent.model
  }
}

export function stripHandoffRoute(text) {
  return text.replace(/^[ \t]*HARNESS-ROUTE:.*$/gm, "").trim()
}

export function resolveHandoffModel(sourceModel, override) {
  if (sourceModel.providerID === "deepseek" && override === "pro") return deepseekModels.pro
  if (sourceModel.providerID === "deepseek" && override === "flash") return deepseekModels.flash
  return sourceModel
}
