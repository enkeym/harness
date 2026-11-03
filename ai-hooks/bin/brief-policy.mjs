import fs from "node:fs"

export function readBriefPolicy(client, file = new URL("../brief-routing.json", import.meta.url)) {
  const policy = JSON.parse(fs.readFileSync(file, "utf8"))[client]
  const planner = policy?.planner
  const nonempty = value => typeof value === "string" && value.trim().length > 0
  const valid = client === "opencode"
    ? typeof policy?.enabled === "boolean" && (!planner || (nonempty(planner.providerID) && nonempty(planner.id)))
    : client === "codex" && Boolean(planner) && nonempty(planner.model) && ["minimal", "low", "medium", "high", "xhigh", "max"].includes(planner.effort)
  if (!valid) throw new Error(`Invalid brief routing policy: ${client}`)
  return policy
}

export const planningInstructions = "Planning phase. Read task-brief, project instructions and applicable skills. Preserve the objective, authorization, latest steering, evidence and existing plan path. Investigate only as needed and produce an executable plan with affected contracts, decisions, steps and acceptance checks. Resolve material open questions through the client's interactive question tool, with concrete options and a recommended choice; a Markdown question list is insufficient. Dismissal, silence or a generic continue does not answer them. Wait for answers before dependent implementation or stage=implement, unless the user explicitly delegates those choices. Include the answers and decisions in the plan and Handoff. Do not implement code or launch another worker. For analysis-only requests, finish with the analysis; do not request implementation."
