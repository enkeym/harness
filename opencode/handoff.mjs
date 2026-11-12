import { readHandoffPrompt } from "../ai-hooks/bin/context-policy.mjs"
import { cachePolicy } from "./cache-policy.mjs"
import { adoptPlan, ensurePlan, planReference, readPlan } from "./plan-store.mjs"
import handoffRpc from "./handoff-rpc.mjs"
import { compactSession } from "./session-compaction.mjs"

const active =
  (globalThis[Symbol.for("harness.handoff.active")] ??= new Map())

export const hasRawConfiguration = (text) =>
  /^\s*(?:export\s+)?[A-Z][A-Z0-9_]*\s*=\s*\S+/m.test(text)

export async function registerHandoff(context, onTransfer, contextCache) {
  const rpc = await context.rpc.register(handoffRpc, {})
  const notify = (sessionID, status, message) =>
    rpc.events.emit("changed", { sessionID, status, message })
  const execute = async ({
    sessionID,
    prompt,
    transfer,
    isCurrent,
    continueAfterCompaction = true
  }) => {
    if (active.has(sessionID)) {
      if (transfer) {
        await active.get(sessionID)
        if (isCurrent && !await isCurrent()) return false
        return execute({ sessionID, transfer, isCurrent, continueAfterCompaction })
      }
      await notify(
        sessionID,
        "preparing",
        "Очистка контекста уже выполняется в этой сессии."
      )
      return false
    }
    const completed = Promise.withResolvers()
    active.set(sessionID, completed.promise)
    try {
      await notify(
        sessionID,
        "preparing",
        "Готовлю очистку контекста в текущей сессии: сохраняю план и доказательства."
      )
      await context.session.wait({ sessionID })
      if (isCurrent && !await isCurrent()) return false
      const source = await context.session.get({ sessionID })
      const brief = await context.storage.get(`brief:${sessionID}`)
      if (!transfer && brief?.pending) {
        transfer = brief.pending
        isCurrent = async () =>
          (await context.storage.get(`brief:${sessionID}`))?.pending?.id ===
          transfer.id
      }
      const plan = await readPlan(context, sessionID)
      let activePlan = plan
      if (!plan) {
        const request = prompt?.text?.trim() ?? ""
        const explicit = /^[^\s]+\.md$/.test(request) ? request : null
        if (explicit) {
          activePlan = await adoptPlan(context, {
            sessionID,
            directory: source.location.directory,
            file: explicit,
            stage: transfer?.brief?.stage ?? "handoff"
          })
        }
      }
      if (!activePlan) {
        const text = transfer?.summary !== undefined
          ? transfer.summary
          : (await context.session.generate({ sessionID, prompt: readHandoffPrompt() })).text
        if (!text.trim()) throw new Error("Empty Handoff; transfer stopped")
        if (
          text.length > cachePolicy.taskCheckpointChars ||
          hasRawConfiguration(text)
        )
          throw new Error(
            "Handoff contains oversized or raw configuration content; shorten the Handoff and retry"
          )
        activePlan = await ensurePlan(context, {
          sessionID,
          directory: source.location.directory,
          objective: text,
          stage: transfer?.brief?.stage ?? "handoff"
        })
      }
      const messages = await context.session.context({ sessionID })
      await contextCache?.prepare(sessionID, messages)
      await compactSession(context, sessionID)
      if (continueAfterCompaction && activePlan)
        await context.session.prompt({
          sessionID,
          text: planReference(activePlan),
          delivery: "steer"
        })
      await notify(
        sessionID,
        "ready",
        "Контекст очищается в текущей сессии; план и кеш сохранены."
      )
      await onTransfer?.(sessionID)
      return true
    } catch (error) {
      await notify(
        sessionID,
        "error",
        error instanceof Error ? error.message : String(error)
      )
      throw error
    } finally {
      active.delete(sessionID)
      completed.resolve()
    }
  }
  await context.command.transform((editor) => {
    editor.add({
      name: "handoff",
      description:
        "Compact this session and continue from the managed task plan",
      execute
    })
  })
  return execute
}
