import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { readHandoffPrompt } from "../ai-hooks/bin/context-policy.mjs"
import { readInstructions } from "./instructions.mjs"
import { cachePolicy } from "./cache-policy.mjs"
import handoffRpc from "./handoff-rpc.mjs"
import {
  resolveHandoffModel,
  stripHandoffRoute
} from "./model-routing.mjs"

export async function registerHandoff(context, onTransfer) {
  const active = new Set()
  const expired = (target) =>
    !target?.submitted &&
    (!Number.isFinite(target?.generatedAt) ||
      Date.now() - target.generatedAt >= cachePolicy.pendingHandoffMs)
  const prune = async (key, target) => {
    const { summary, ...metadata } = target
    const cleaned = {
      ...metadata,
      ...(!expired(target) && !target.submitted ? { summary } : {}),
      previousIDs: (target.previousIDs ?? []).slice(
        -cachePolicy.previousHandoffs
      )
    }
    await context.storage.set(key, cleaned)
    return cleaned
  }
  if (context.storage.scan) {
    let after
    do {
      const page = await context.storage.scan({
        prefix: "handoff:",
        limit: cachePolicy.scanEntries,
        ...(after ? { after } : {})
      })
      for (const { key, value } of page.entries) {
        if (
          value &&
          typeof value === "object" &&
          ((expired(value) && value.summary) ||
            (value.previousIDs?.length ?? 0) > cachePolicy.previousHandoffs)
        ) {
          if ((value.previousIDs?.length ?? 0) > cachePolicy.previousHandoffs)
            await onTransfer?.(key.slice("handoff:".length))
          await prune(key, value)
        }
      }
      after = page.next
    } while (after)
  }
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
      await context.session.wait({ sessionID })
      const source = await context.session.get({ sessionID })
      const messages = await context.session.context({ sessionID })
      const handoffPrompt = readHandoffPrompt()
      const { core, instructions } = readInstructions()
      const fingerprint = createHash("sha256")
        .update(
          JSON.stringify({
            messages: messages.filter(
              (message) => !["idle", "model-switched"].includes(message.type)
            ),
            location: source.location,
            agent: source.agent,
            model: source.model,
            permissions: source.permissions,
            request: prompt.text ?? "",
            policy: handoffPrompt,
            rules: core,
            instructions
          })
        )
        .digest("hex")
      let target = await context.storage.get(key)
      const previousIDs = [
        ...new Set([
          ...(target?.previousIDs ?? []),
          ...(target?.id ? [target.id] : [])
        ])
      ].slice(-cachePolicy.previousHandoffs)
      if (target && expired(target)) {
        if (target.id)
          throw new Error(
            `Handoff delivery is uncertain; inspect continuation ${target.id} before retrying`
          )
        await prune(key, target)
        target = null
      }
      if (target?.fingerprint !== fingerprint) target = null
      if (target?.id) {
        try {
          await context.session.get({ sessionID: target.id })
        } catch (error) {
          if (
            !["Session.NotFoundError", "SessionNotFoundError"].includes(
              error?._tag
            ) &&
            error?.status !== 404
          )
            throw error
          target = target.submitted ? null : { ...target, id: undefined }
        }
      }
      if (target?.submitted) {
        await context.storage.set(key, {
          ...target,
          continuationHits: (target.continuationHits ?? 0) + 1
        })
        await onTransfer?.(sessionID)
        await notify(
          sessionID,
          "ready",
          "Открываю существующее продолжение.",
          target.id
        )
        return
      }
      if (!target) {
        const routeOption = /(?:^|\s)--route=(\S+)(?=\s|$)/
        const routeValue = routeOption.exec(prompt.text ?? "")?.[1]
        const override = ["pro", "flash"].includes(routeValue)
          ? routeValue
          : null
        const summary = await context.session.generate({ sessionID, prompt: handoffPrompt })
        const text = stripHandoffRoute(summary.text)
        if (!text.trim()) throw new Error("Empty Handoff; transfer stopped")
        const file = path.resolve(
          source.location.directory,
          (prompt.text ?? "").replace(routeOption, "").trim() || "HANDOFF.md"
        )
        target = {
          fingerprint,
          file,
          summary: text,
          submitted: false,
          previousIDs,
          model: resolveHandoffModel(source.model, override),
          generatedAt: Date.now(),
          summaryHits: 0,
          continuationHits: 0
        }
        await context.storage.set(key, target)
      } else {
        target = { ...target, summaryHits: (target.summaryHits ?? 0) + 1 }
        await context.storage.set(key, target)
      }
      const existing = Boolean(target.id)
      if (!target.id) {
        fs.writeFileSync(target.file, target.summary, { mode: 0o600 })
        const created = await context.session.create({
          location: source.location,
          agent: source.agent,
          model: target.model,
          permissions: source.permissions,
          title: `Handoff: ${source.title || sessionID}`
        })
        target = { ...target, id: created.id }
        await context.storage.set(key, target)
      }
      const text = `Restore this Handoff. Read project instructions and applicable skills. Continue the next authorized step of the remaining plan immediately. Keep completed or blocked work stopped. Do not launch another worker or transfer again.\n\n${target.summary}`
      const continuation = await context.session.context({
        sessionID: target.id
      })
      const delivered = continuation.some(
        (message) => message.type === "user" && message.text === text
      )
      if (
        existing &&
        !delivered &&
        continuation.some(
          (message) => !["idle", "model-switched"].includes(message.type)
        )
      ) {
        throw new Error(
          `Handoff delivery is uncertain; inspect continuation ${target.id} before retrying`
        )
      }
      if (!delivered) {
        await context.session.prompt({ sessionID: target.id, text })
      }
      await context.storage.set(key, {
        ...target,
        summary: undefined,
        submitted: true
      })
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
      description:
        "Transfer the remaining plan to a fresh session and continue",
      execute
    })
  })
  return execute
}
