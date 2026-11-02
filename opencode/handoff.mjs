import fs from "node:fs"
import path from "node:path"
import { handoffPrompt } from "../ai-hooks/bin/context-policy.mjs"
import handoffRpc from "./handoff-rpc.mjs"
import {
  deepseekHandoffRouting,
  deepseekModels,
  parseHandoffRoute,
  resolveHandoffModel,
  stripHandoffRoute
} from "./model-routing.mjs"

export async function registerHandoff(context, onTransfer) {
  const active = new Set()
  const rpc = await context.rpc.register(handoffRpc, {})
  const notify = (sessionID, status, message, targetID) =>
    rpc.events.emit("changed", {
      sessionID,
      status,
      message,
      ...(targetID ? { targetID } : {})
    })
  const execute = async ({ sessionID, prompt }) => {
    if (active.has(sessionID)) {
      await notify(
        sessionID,
        "preparing",
        "Перенос уже выполняется. Дождитесь открытия новой сессии."
      )
      return
    }
    active.add(sessionID)
    try {
      await notify(
        sessionID,
        "preparing",
        "Готовлю перенос: ожидаю завершения текущего шага и сохраняю план."
      )
      const key = `handoff:${sessionID}`
      let target = await context.storage.get(key)
      if (target?.submitted) {
        await notify(
          sessionID,
          "ready",
          "Открываю существующее продолжение.",
          target.id
        )
        return
      }
      if (!target) {
        await context.session.wait({ sessionID })
        const source = await context.session.get({ sessionID })
        const deepseek =
          source.model.providerID === deepseekModels.flash.providerID
        const routeOption = /(?:^|\s)--route=(\S+)(?=\s|$)/
        const routeValue = routeOption.exec(prompt.text ?? "")?.[1]
        const override = ["pro", "flash"].includes(routeValue)
          ? routeValue
          : null
        let summary
        if (deepseek && source.model.id !== deepseekModels.flash.id)
          await context.session.switchModel({
            sessionID,
            model: deepseekModels.flash
          })
        try {
          summary = await context.session.generate({
            sessionID,
            prompt: deepseek
              ? handoffPrompt + deepseekHandoffRouting
              : handoffPrompt
          })
        } finally {
          if (deepseek && source.model.id !== deepseekModels.flash.id)
            await context.session.switchModel({
              sessionID,
              model: source.model
            })
        }
        const route = deepseek ? parseHandoffRoute(summary.text) : null
        const text = deepseek
          ? stripHandoffRoute(summary.text)
          : summary.text
        if (!text.trim()) throw new Error("Empty Handoff; transfer stopped")
        const file = path.resolve(
          source.location.directory,
          (prompt.text ?? "").replace(routeOption, "").trim() ||
            "HANDOFF.md"
        )
        fs.writeFileSync(file, text, { mode: 0o600 })
        const created = await context.session.create({
          location: source.location,
          agent: source.agent,
          model: deepseek
            ? resolveHandoffModel(source.model, route, override)
            : source.model,
          permissions: source.permissions,
          title: `Handoff: ${source.title || sessionID}`
        })
        target = { id: created.id, summary: text, submitted: false }
        await context.storage.set(key, target)
      }
      await context.session.prompt({
        sessionID: target.id,
        text: `Restore this Handoff. Read project instructions and applicable skills. Continue the next authorized step of the remaining plan immediately. Keep completed or blocked work stopped. Do not launch another worker or transfer again.\n\n${target.summary}`
      })
      await context.storage.set(key, { id: target.id, submitted: true })
      await onTransfer?.(sessionID)
      await notify(
        sessionID,
        "ready",
        "План передан. Открываю новую сессию.",
        target.id
      )
    } catch (error) {
      await notify(
        sessionID,
        "error",
        error instanceof Error ? error.message : String(error)
      )
      throw error
    } finally {
      active.delete(sessionID)
    }
  }
  await context.command.transform((editor) => {
    editor.add({
      name: "handoff",
      description: "Transfer the remaining plan to a fresh session and continue",
      execute
    })
  })
  return execute
}

export async function escalateStalledSession(context, sessionID, handoff) {
  const source = await context.session.get({ sessionID })
  if (
    source.parentID ||
    source.location?.directory !== context.location.directory ||
    source.model?.providerID !== deepseekModels.flash.providerID ||
    source.model?.id !== deepseekModels.flash.id ||
    !["build", "plan", "general"].includes(source.agent)
  )
    return
  const messages = await context.session.context({ sessionID })
  const last = messages.findLast((message) => message.type !== "idle")
  if (last?.type !== "assistant" || !last.time?.completed || last.error) return
  const text = (last.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
  const route = parseHandoffRoute(text)
  if (route?.progress === "stalled" && route.next !== "done") {
    await handoff({ sessionID, prompt: { text: "--route=pro" } })
  }
}
