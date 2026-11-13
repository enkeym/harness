import { deepseekTokenRates } from "./cost-policy.mjs"

export const deepseekModels = {
  flash: { providerID: "deepseek", id: "deepseek-flash" },
  pro: { providerID: "deepseek", id: "deepseek-v4-pro" }
}

const supportedEffort = (model) => model?.capabilities?.reasoning?.effort

const trimEffort = (model, source) => {
  const supported = supportedEffort(source)
  if (!Array.isArray(supported)) return
  const reasoning = model.capabilities?.reasoning
  if (Array.isArray(reasoning?.effort)) {
    const kept = reasoning.effort.filter((value) => supported.includes(value))
    reasoning.effort = kept.length ? kept : [...supported]
  }
  const effort = model.settings?.reasoningEffort
  if (typeof effort === "string" && !supported.includes(effort))
    model.settings.reasoningEffort = supported.at(-1)
}

export function migrateBundledModels(config, defaults) {
  const bundled = defaults?.providers?.deepseek?.models
  if (!bundled) return
  const aliases = new Map()
  for (const id of Object.keys(bundled)) {
    aliases.set(`${id}-offpeak`, id)
    aliases.set(`${id}-peak`, id)
  }
  const models = config.providers?.deepseek?.models
  if (models) {
    for (const alias of aliases.keys()) delete models[alias]
    for (const [id, source] of Object.entries(bundled)) {
      if (!models[id] || !source.cost) continue
      models[id] = { ...models[id], cost: structuredClone(source.cost) }
      trimEffort(models[id], source)
    }
  }
  const retarget = (value) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const canonical = value.providerID === "deepseek" ? aliases.get(value.id) : undefined
      return canonical ? { ...value, id: canonical } : value
    }
    if (typeof value !== "string") return value
    const [id, variant] = value.split("#")
    const separator = id.indexOf("/")
    if (separator < 0) return value
    const canonical = aliases.get(id.slice(separator + 1))
    if (!canonical) return value
    return `${id.slice(0, separator)}/${canonical}${variant === undefined ? "" : `#${variant}`}`
  }
  if (config.model) config.model = retarget(config.model)
  for (const group of [config.agents, config.commands]) {
    if (!group || typeof group !== "object") continue
    for (const entry of Object.values(group))
      if (entry && typeof entry === "object" && entry.model !== undefined) entry.model = retarget(entry.model)
  }
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
