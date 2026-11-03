import { createHash, randomUUID } from "node:crypto"
import { readBriefPolicy, planningInstructions } from "../ai-hooks/bin/brief-policy.mjs"

const registry = (name) =>
  (globalThis[Symbol.for(`harness.brief.${name}`)] ??= new Set())

export async function registerBrief(context, handoff, policy = readBriefPolicy("opencode")) {
  if (!policy.enabled) return { settle: async () => {} }
  const queueing = registry("queueing")
  const settling = registry("settling")
  await context.tool.transform(editor => editor.add({
    name: "brief_transition",
    description: "Task-brief lifecycle: queue fresh-context planning, or return an executable plan to the original model. End the current turn after success. Never use for routine edits or an adequate existing plan.",
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
        const source = await context.session.get({ sessionID })
        const originalModel = stage === "plan" ? source.model : current.originalModel
        const next = stage === "plan" ? "planning" : "implementation"
        const transfer = {
          id: randomUUID(),
          summary,
          model: originalModel,
          instructions: stage === "plan"
            ? `${planningInstructions} When an authorized implementation plan is ready, call brief_transition with stage=implement and a compact Handoff containing the plan, then end your turn.`
            : "Restore the Handoff and executable plan. The Handoff checkpoint is authoritative: a task plan file may lag behind it, so do not read the whole plan or reload already-loaded skills to reconstruct progress. Start with the first unfinished step, read only the contracts or ranges it names, inspect the working tree, and continue. Do not repeat the brief for an adequate plan. No other worker.",
          brief: {
            stage: next,
            originalModel,
            planned: stage === "plan" || Boolean(current?.planned),
            implemented: stage === "implement"
          }
        }
        await context.storage.set(`brief:${sessionID}`, { ...current, originalModel, pending: transfer })
        return { content: "Brief transfer queued. Finish this turn now; the harness will continue in a fresh session after execution succeeds. Do not implement, call more tools or launch another worker." }
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
      event.system.push({ type: "text", text: `${planningInstructions} Use brief_transition(stage=implement) only when implementation is authorized and the plan is ready. End analysis-only tasks here.` })
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
        const name = createHash("sha256").update(sessionID).digest("hex").slice(0, 16)
        const delivered = await handoff({ sessionID, prompt: { text: `.opencode/handoffs/brief-${name}.md` }, transfer: state.pending, isCurrent })
        if (delivered && await isCurrent()) await context.storage.set(`brief:${sessionID}`, { ...state, pending: undefined, submitted: true })
      } finally {
        settling.delete(sessionID)
      }
    }
  }
}
