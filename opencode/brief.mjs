import { randomUUID } from "node:crypto"
import { readBriefPolicy, planningInstructions } from "../ai-hooks/bin/brief-policy.mjs"
import { createPlan, planPath, planReference, readPlan, updatePlan } from "./plan-store.mjs"
import { hasRawConfiguration } from "./handoff.mjs"

const registry = (name) =>
  (globalThis[Symbol.for(`harness.brief.${name}`)] ??= new Set())

export async function registerBrief(context, handoff, policy = readBriefPolicy("opencode")) {
  if (!policy.enabled) return { settle: async () => {} }
  const queueing = registry("queueing")
  const settling = registry("settling")
  await context.tool.transform(editor => editor.add({
    name: "brief_transition",
    description: "Task-brief lifecycle: queue compacted-context planning, or return an executable plan to the original model. End the current turn after success. Never use for routine edits or an adequate existing plan.",
    input: {
      type: "object",
      properties: {
        stage: { type: "string", enum: ["plan", "implement"] },
        handoff: { type: "string", minLength: 1, maxLength: 6000 }
      },
      required: ["stage", "handoff"],
      additionalProperties: false
    },
    execute: async ({ stage, handoff: summary }, invocation) => {
      const sessionID = invocation.sessionID
      if (queueing.has(sessionID)) throw new Error("Brief transfer already being queued")
      queueing.add(sessionID)
      try {
        const current = await context.storage.get(`brief:${sessionID}`)
        if (current?.pending || current?.submitted) throw new Error("Brief transfer already queued; finish this turn")
        if (stage === "implement" && current?.implemented) throw new Error("Implementation is already authorized; continue it")
        if (stage === "implement" && current?.stage !== "planning") throw new Error("No planning phase to complete")
        if (stage === "plan" && current?.stage === "planning") throw new Error("Already planning; do not transfer recursively")
        if (stage === "plan" && current?.stage === "implementation") throw new Error("Implementation is authorized; continue the remaining plan instead of planning again")
        if (typeof summary !== "string" || !summary.trim() || summary.length > 6000) throw new Error("Expected a compact Handoff")
        if (hasRawConfiguration(summary)) throw new Error("Handoff contains raw configuration content")
        const source = await context.session.get({ sessionID })
        const originalModel = stage === "plan" ? source.model : current.originalModel
        const next = stage === "plan" ? "planning" : "implementation"
        const plan = stage === "plan"
          ? await createPlan(context, { sessionID, directory: source.location.directory, objective: summary, stage: next })
          : (await updatePlan(context, { sessionID, remaining: summary })) ??
            await createPlan(context, { sessionID, directory: source.location.directory, objective: summary, stage: next })
        const transfer = {
          id: randomUUID(),
          plan: { id: plan.id, path: planPath(plan) },
          model: originalModel,
          instructions: stage === "plan"
            ? `Write the executable plan to ${planPath(plan)} and keep its checkpoint and remaining steps current. When an authorized implementation plan is ready, call brief_transition with stage=implement and a compact Handoff containing only the remaining steps with their decisions and contracts, not the completed parts of the plan; the plan file keeps them. Then end your turn.`
            : "Restore the plan reference. The plan file is authoritative for the objective, decisions, checkpoint and remaining steps; do not read or repeat completed parts. Start with the first unfinished step, read only the contracts or ranges it names, inspect the working tree, and continue. Do not reload already-loaded skills or repeat the brief for an adequate plan. No other worker.",
          brief: {
            stage: next,
            originalModel,
            planned: stage === "plan" || Boolean(current?.planned),
            implemented: stage === "implement"
          }
        }
        await context.storage.set(`brief:${sessionID}`, { ...current, originalModel, pending: transfer })
        return { content: "Brief transfer queued. Finish this turn now; the harness compacts this session after execution succeeds. Do not implement, call more tools or launch another worker." }
      } finally {
        queueing.delete(sessionID)
      }
    }
  }))
  await context.session.hook("prompt", async event => {
    const state = await context.storage.get(`brief:${event.sessionID}`)
    if (state?.pending || state?.submitted) {
      const { pending, submitted, ...rest } = state
      await context.storage.set(`brief:${event.sessionID}`, rest)
    }
  })
  await context.session.hook("context", async event => {
    const state = await context.storage.get(`brief:${event.sessionID}`)
    if (!state) return
    if (state.pending) {
      event.tools = {}
      event.system.push({ type: "text", text: "A brief transfer is queued or delivered. End this turn immediately. Do not perform more work in this session." })
    } else if (state.stage === "planning") {
      const plan = await readPlan(context, event.sessionID)
      event.system.push({ type: "text", text: `${planningInstructions}${plan ? ` Task plan: ${planPath(plan)}. Keep the objective, decisions, checkpoint and remaining steps there; do not repeat them in the Handoff.` : ""} Use brief_transition(stage=implement) only when implementation is authorized and the plan is ready. End analysis-only tasks here.` })
    }
  })
  return {
    async settle(sessionID, succeeded) {
      if (settling.has(sessionID)) return
      settling.add(sessionID)
      try {
        const state = await context.storage.get(`brief:${sessionID}`)
        if (!state?.pending || state.submitted) return
        if (!succeeded) {
          await context.storage.set(`brief:${sessionID}`, { ...state, pending: undefined })
          return
        }
        const isCurrent = async () => (await context.storage.get(`brief:${sessionID}`))?.pending?.id === state.pending.id
        const delivered = await handoff({
          sessionID,
          transfer: state.pending,
          isCurrent,
          continueAfterCompaction: false
        })
        if (!delivered || !await isCurrent()) return
        const { pending, submitted, ...rest } = state
        await context.storage.set(`brief:${sessionID}`, { ...rest, ...pending.brief })
        try {
          const plan = await readPlan(context, sessionID)
          if (plan)
            await context.session.prompt({
              sessionID,
              text: planReference(plan),
              delivery: "steer"
            })
        } catch (error) {
          await context.storage.set(`brief:${sessionID}`, state)
          throw error
        }
      } finally {
        settling.delete(sessionID)
      }
    }
  }
}
