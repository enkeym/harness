import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { readHandoffPrompt } from "../ai-hooks/bin/context-policy.mjs"
import { readInstructions } from "./instructions.mjs"
import { cachePolicy } from "./cache-policy.mjs"
import { ensureProjectIgnore, writePrivateText } from "./local-state.mjs"
import handoffRpc from "./handoff-rpc.mjs"
import {
  resolveHandoffModel,
  stripHandoffRoute
} from "./model-routing.mjs"

const active =
  (globalThis[Symbol.for("harness.handoff.active")] ??= new Map())

const restorePrompt = (transfer) =>
  transfer?.instructions ??
  "Restore this Handoff. The Handoff checkpoint is authoritative: a task plan file may lag behind it, so do not read the whole plan or reload already-loaded skills to reconstruct progress. Read project instructions and only the missing applicable skills, then continue the first unfinished step immediately. Keep completed or blocked work stopped. Do not launch another worker or transfer again."

export async function registerHandoff(context, onTransfer, taskContext) {
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
  const execute = async ({ sessionID, prompt, transfer, isCurrent }) => {
    if (active.has(sessionID)) {
      if (transfer) {
        await active.get(sessionID)
        if (isCurrent && !await isCurrent()) return false
        return execute({ sessionID, prompt, transfer, isCurrent })
      }
      await notify(
        sessionID,
        "preparing",
        "Перенос уже выполняется. Дождитесь открытия новой сессии."
      )
      return false
    }
    const completed = Promise.withResolvers()
    active.set(sessionID, completed.promise)
    try {
      await notify(
        sessionID,
        "preparing",
        "Готовлю перенос: ожидаю завершения текущего шага и сохраняю план."
      )
      const key = `handoff:${sessionID}`
      await context.session.wait({ sessionID })
      if (isCurrent && !await isCurrent()) return false
      const source = await context.session.get({ sessionID })
      const brief = await context.storage.get(`brief:${sessionID}`)
      if (!transfer && brief?.pending) {
        transfer = brief.pending
        isCurrent = async () => (await context.storage.get(`brief:${sessionID}`))?.pending?.id === transfer.id
      } else if (!transfer && brief?.stage) transfer = { brief: { stage: brief.stage, originalModel: brief.originalModel } }
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
            ...(transfer ? { transfer } : {}),
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
      if (target?.fingerprint !== fingerprint && (!transfer?.id || target?.transfer?.id !== transfer.id)) target = null
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
        return true
      }
      if (!target) {
        const routeOption = /(?:^|\s)--route=(\S+)(?=\s|$)/
        const routeValue = routeOption.exec(prompt.text ?? "")?.[1]
        const override = ["pro", "flash"].includes(routeValue)
          ? routeValue
          : null
        const summary = transfer?.summary === undefined
          ? await context.session.generate({ sessionID, prompt: handoffPrompt })
          : { text: transfer.summary }
        const text = stripHandoffRoute(summary.text)
        if (!text.trim()) throw new Error("Empty Handoff; transfer stopped")
        const checkpoint = await taskContext?.prepare(sessionID, text, messages)
        const file = path.resolve(
          source.location.directory,
          (prompt.text ?? "").replace(routeOption, "").trim() || ".opencode/HANDOFF.md"
        )
        target = {
          fingerprint,
          file,
          summary: checkpoint ? `${text}\n\n${checkpoint}` : text,
          submitted: false,
          previousIDs,
          model: transfer?.model ?? resolveHandoffModel(source.model, override),
          ...(transfer ? { transfer: { ...transfer, summary: undefined } } : {}),
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
        if (isCurrent && !await isCurrent()) return false
        const localDirectory = path.join(source.location.directory, ".opencode")
        const relativeFile = path.relative(localDirectory, target.file)
        if (relativeFile === "HANDOFF.md" || relativeFile.startsWith(`handoffs${path.sep}`)) {
          const local = await ensureProjectIgnore(source.location.directory, ["/HANDOFF.md", "/handoffs/"])
          target.file = path.join(local, relativeFile)
          let directory = local
          for (const segment of path.dirname(relativeFile).split(path.sep).filter(segment => segment !== ".")) {
            directory = path.join(directory, segment)
            await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 })
            if (await fs.promises.realpath(directory) !== directory) throw new Error("Handoff directory must not be a symlink")
          }
          await writePrivateText(target.file, target.summary)
        } else {
          if (transfer) fs.mkdirSync(path.dirname(target.file), { recursive: true })
          fs.writeFileSync(target.file, target.summary, { mode: 0o600 })
        }
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
      if (target.transfer?.brief && !await context.storage.get(`brief:${target.id}`)) {
        await context.storage.set(`brief:${target.id}`, target.transfer.brief)
      }
      await taskContext?.transfer(sessionID, target.id)
      const text = `${restorePrompt(target.transfer)}\n\n${target.summary}`
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
        if (isCurrent && !await isCurrent()) return false
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
        "Transfer the remaining plan to a fresh session and continue",
      execute
    })
  })
  return execute
}
