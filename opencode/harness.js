import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import {
  contextPolicy,
  readHandoffPrompt
} from "../ai-hooks/bin/context-policy.mjs"
import { readInstructions } from "./instructions.mjs"
import { deduplicateContext } from "./context-cache.mjs"
import { registerHandoff } from "./handoff.mjs"
import { finishCompaction } from "./session-compaction.mjs"
import { registerBrief } from "./brief.mjs"
import { registerContextCache } from "./evidence-cache.mjs"
import { registerLoopGuard } from "./loop-guard.mjs"
import { registerQuestionGuard } from "./question-guard.mjs"
import { collectObservations, observationAPI } from "./observations.mjs"
import {
  refreshCostReport,
  localDate,
  defaultCostConfig
} from "./cost-report.mjs"
import { registerRetrievalRouting } from "./retrieval-routing.mjs"
import { deepseekModels } from "./model-routing.mjs"
import { isPeakAt, deepseekTokenRates } from "./cost-policy.mjs"

const claimed = (globalThis[Symbol.for("harness.events.claimed")] ??= new Set())
const claim = (event) => {
  if (!event.id) return true
  if (claimed.has(event.id)) return false
  claimed.add(event.id)
  if (claimed.size > 500) claimed.delete(claimed.values().next().value)
  return true
}

export default {
  id: "harness",
  setup: async (context) => {
    const directory = context.location.directory
    await registerRetrievalRouting(context)
    const sync = (warm = false) => {
      for (const script of ["tokensave-sync.sh", "ragsave-sync.sh"]) {
        const child = spawn(
          "bash",
          [
            fileURLToPath(
              new URL(`../ai-hooks/bin/${script}`, import.meta.url)
            ),
            ...(warm && script === "ragsave-sync.sh" ? ["--warm"] : []),
            directory
          ],
          { detached: true, stdio: "ignore" }
        )
        child.on("error", () => {})
        child.unref()
      }
    }
    sync(true)
    let budgetDate = null
    const budgetReached = () =>
      budgetDate !== null && budgetDate === localDate(Date.now())
    const notify = (title, message) => {
      const pending = context.client.tui?.showToast?.({
        body: { title, message, variant: "warning", duration: 12000 }
      })
      pending?.catch?.(() => {})
    }
    await context.model.transform((editor) => {
      for (const model of editor.list()) {
        if (model.limit.context <= 0) continue
        editor.update(model.providerID, model.id, (draft) => {
          draft.limit.input = Math.min(
            draft.limit.input > 0 ? draft.limit.input : draft.limit.context,
            draft.limit.context,
            contextPolicy.opencode.maxTokens
          )
          draft.limit.output = Math.min(
            draft.limit.output > 0 ? draft.limit.output : draft.limit.context,
            contextPolicy.maxOutputTokens
          )
          if (
            budgetReached() &&
            draft.providerID === deepseekModels.pro.providerID &&
            draft.id === deepseekModels.pro.id
          )
            draft.enabled = false
        })
      }
    })
    const refreshBudgetDay = async () => {
      if (budgetDate === null || budgetDate === localDate(Date.now())) return
      budgetDate = null
      try {
        await context.model.reload()
      } catch (error) {
        process.stderr.write(
          `Harness model budget reload failed: ${error.message}\n`
        )
      }
    }
    const enforceBudget = async (sessionID, date) => {
      if (budgetDate === date) return
      budgetDate = date
      notify(
        "Дневной бюджет DeepSeek",
        `Достигнут дневной лимит ${defaultCostConfig.dailyNativeUSD} USD; Pro отключён до конца суток, сессия переведена на Flash.`
      )
      try {
        await context.model.reload()
      } catch (error) {
        process.stderr.write(
          `Harness model budget reload failed: ${error.message}\n`
        )
      }
      if (sessionID)
        try {
          await context.session.switchModel({
            sessionID,
            model: deepseekModels.flash
          })
        } catch (error) {
          process.stderr.write(
            `Harness model downgrade failed: ${error.message}\n`
          )
        }
    }
    let observationQueue = Promise.resolve()
    const observe = (sessionID, target = directory) => {
      const result = observationQueue.then(async () => {
        try {
          await refreshBudgetDay()
          await collectObservations(observationAPI(context), sessionID, {
            directory: target
          })
          const { report, newWarnings } = await refreshCostReport()
          for (const warning of newWarnings)
            process.stderr.write(
              `Harness cost warning: ${warning.code}; ${warning.sessionID ?? "daily"}; observed=${warning.observed}; limit=${warning.limit}.\n`
            )
          if (
            report.warnings.some(
              (warning) =>
                warning.code === "native-estimate-budget" ||
                warning.code === "provider-budget"
            )
          )
            await enforceBudget(sessionID, report.date)
          return newWarnings
        } catch (error) {
          process.stderr.write(
            `Harness observation failed (${error.name}); session evidence remains incomplete.\n`
          )
          return []
        }
      })
      observationQueue = result
      return result
    }
    const contextCache = await registerContextCache(context)
    const loopGuard = await registerLoopGuard(context, contextCache)
    const handoff = await registerHandoff(context, observe, contextCache)
    const brief = await registerBrief(context, handoff)
    const questionGuard = await registerQuestionGuard(context)
    readInstructions()
    const harnessInstructions = () => ({
      role: "user",
      content: [{ type: "text", text: readInstructions().text }]
    })
    const isHarnessInstructions = (message) =>
      message.role === "user" &&
      message.content?.[0]?.type === "text" &&
      message.content[0].text?.startsWith("Harness skill instructions:\n")
    await context.session.hook("compaction", async (event) => {
      await observe(event.sessionID)
      event.messages = (event.messages ?? []).filter(
        (message) => !isHarnessInstructions(message)
      )
      event.messages.unshift(harnessInstructions())
      event.messages.push({
        role: "user",
        content: [{ type: "text", text: readHandoffPrompt() }]
      })
    })
    const abort = new AbortController()
    const events = await context.event.subscribe({
      signal: abort.signal,
      types: [
        "session.execution.succeeded",
        "session.execution.failed",
        "session.execution.interrupted",
        "session.model.selected",
        "session.compaction.ended",
        "session.compaction.failed"
      ]
    })
    const consume = async () => {
      for await (const event of events) {
        if (!claim(event)) continue
        if (event.type === "session.model.selected") {
          const model = event.data.model
          const modelId = model?.id ?? model?.modelID
          const sessionID = event.data.sessionID
          if (model?.providerID !== deepseekModels.flash.providerID) continue
          const peak = isPeakAt(new Date())
          const peakNote = peak
            ? "; сейчас пиковое окно DeepSeek, реальный тариф вдвое выше учтённого"
            : ""
          if (modelId === deepseekModels.pro.id) {
            const flash = deepseekTokenRates[deepseekModels.flash.id].offPeak
            const pro = deepseekTokenRates[deepseekModels.pro.id].offPeak
            const agent =
              event.data.agent ??
              (sessionID
                ? await context.session
                    .get({ sessionID })
                    .then((source) => source.agent)
                    .catch(() => undefined)
                : undefined)
            notify(
              "DeepSeek Pro",
              `Pro дороже Flash: вход ×${Math.round(pro.input / flash.input)}, выход ×${Math.round(pro.output / flash.output)}, чтение кеша ×${Math.round(pro.cacheRead / flash.cacheRead)}${peakNote}. Автоматические маршруты harness используют Flash, Pro — ручной выбор.`
            )
            if (agent === "build" && sessionID) {
              notify(
                "build на Pro",
                "build на Pro стоит ×4.5 за токен; harness переключает эту сессию на Flash."
              )
              try {
                await context.session.switchModel({
                  sessionID,
                  model: deepseekModels.flash
                })
              } catch (error) {
                process.stderr.write(
                  `Harness build downgrade failed: ${error.message}\n`
                )
              }
            }
          } else if (peak) {
            notify(
              "DeepSeek пик",
              "Сейчас пиковое окно DeepSeek: реальный тариф вдвое выше учтённого в конфиге. Отложите пакетную задачу через bin/opencode-offpeak.mjs."
            )
          }
          continue
        }
        if (
          event.type === "session.compaction.ended" ||
          event.type === "session.compaction.failed"
        ) {
          finishCompaction(event.data.sessionID)
          continue
        }
        if (event.type.startsWith("session.execution.")) {
          const sessionID = event.data.sessionID
          loopGuard.finishTurn(sessionID)
          const source = await context.session
            .get({ sessionID })
            .catch(() => undefined)
          const owner = source?.location.directory
          sync()
          const warnings = await observe(sessionID, owner ?? directory)
          if (
            warnings.some(
              (warning) =>
                warning.code === "long-session" &&
                warning.sessionID === sessionID
            )
          )
            notify(
              "Длинная сессия",
              "Контекст сессии растёт; запустите /handoff вручную, когда закончите текущий шаг."
            )
          if (event.type === "session.execution.succeeded")
            try {
              await questionGuard.check(sessionID, source)
            } catch (error) {
              process.stderr.write(
                `Harness question guard failed: ${error.message}\n`
              )
            }
          try {
            await brief.settle(
              sessionID,
              event.type === "session.execution.succeeded"
            )
          } catch (error) {
            process.stderr.write(
              `Harness brief transfer failed: ${error.message}\n`
            )
          }
          try {
            await contextCache.prune()
          } catch (error) {
            process.stderr.write(
              `Harness context cache cleanup failed: ${error.message}\n`
            )
          }
        }
      }
    }
    consume().catch((error) => {
      if (!abort.signal.aborted)
        process.stderr.write(
          `Harness autosync event stream failed: ${error.message}\n`
        )
    })
    await context.session.hook("context", (event) => {
      event.messages = deduplicateContext(event.messages)
      for (let i = event.system.length - 1; i >= 0; i--) {
        if (
          event.system[i].text?.startsWith("Harness skill instructions:\n") ||
          event.system[i].text?.startsWith("DeepSeek model routing:")
        )
          event.system.splice(i, 1)
      }
      event.messages = event.messages.filter(
        (message) => !isHarnessInstructions(message)
      )
      event.messages.unshift(harnessInstructions())
      if (budgetReached()) {
        event.options ??= {}
        event.options.maxTokens = Math.min(
          event.options.maxTokens ?? contextPolicy.maxOutputTokens,
          2048
        )
      }
    })
    return async () => {
      abort.abort()
      await observationQueue
    }
  }
}
