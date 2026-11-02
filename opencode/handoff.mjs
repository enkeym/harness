import fs from "node:fs"
import path from "node:path"
import { handoffPrompt } from "../ai-hooks/bin/context-policy.mjs"
import handoffRpc from "./handoff-rpc.mjs"
import { deepseekModels } from "./model-routing.mjs"

export async function registerHandoff(context) {
  const active = new Set()
  const rpc = await context.rpc.register(handoffRpc, {})
  const notify = (sessionID, status, message, targetID) => rpc.events.emit("changed", {
    sessionID, status, message, ...(targetID ? { targetID } : {})
  })
  await context.command.transform((editor) => {
    editor.add({
      name: "handoff",
      description: "Transfer the remaining plan to a fresh session and continue",
      execute: async ({ sessionID, prompt }) => {
        if (active.has(sessionID)) {
          await notify(sessionID, "preparing", "Перенос уже выполняется. Дождитесь открытия новой сессии.")
          return
        }
        active.add(sessionID)
        try {
          await notify(sessionID, "preparing", "Готовлю перенос: ожидаю завершения текущего шага и сохраняю план.")
          const key = `handoff:${sessionID}`
          let target = await context.storage.get(key)
          if (target?.submitted) {
            await notify(sessionID, "ready", "Открываю существующее продолжение.", target.id)
            return
          }
          if (!target) {
            await context.session.wait({ sessionID })
            const source = await context.session.get({ sessionID })
            const deepseek = source.model.providerID === deepseekModels.flash.providerID
            let summary
            if (deepseek && source.model.id !== deepseekModels.flash.id) await context.session.switchModel({ sessionID, model: deepseekModels.flash })
            try {
              summary = await context.session.generate({ sessionID, prompt: handoffPrompt })
            } finally {
              if (deepseek && source.model.id !== deepseekModels.flash.id) await context.session.switchModel({ sessionID, model: source.model })
            }
            if (!summary.text.trim()) throw new Error("Empty Handoff; transfer stopped")
            const file = path.resolve(source.location.directory, prompt.text.trim() || "HANDOFF.md")
            fs.writeFileSync(file, summary.text, { mode: 0o600 })
            const created = await context.session.create({
              location: source.location,
              agent: source.agent,
              model: deepseek ? deepseekModels.flash : source.model,
              permissions: source.permissions,
              title: `Handoff: ${source.title || sessionID}`
            })
            target = { id: created.id, summary: summary.text, submitted: false }
            await context.storage.set(key, target)
          }
          await context.session.prompt({
            sessionID: target.id,
            text: `Restore this Handoff. Read project instructions and applicable skills. Continue the next authorized step of the remaining plan immediately. Keep completed or blocked work stopped. Do not launch another worker or transfer again.\n\n${target.summary}`
          })
          await context.storage.set(key, { id: target.id, submitted: true })
          await notify(sessionID, "ready", "План передан. Открываю новую сессию.", target.id)
        } catch (error) {
          await notify(sessionID, "error", error instanceof Error ? error.message : String(error))
          throw error
        } finally {
          active.delete(sessionID)
        }
      }
    })
  })
}
