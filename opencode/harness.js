import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { contextPolicy, readHandoffPrompt } from "../ai-hooks/bin/context-policy.mjs"
import { readInstructions } from "./instructions.mjs"
import { deduplicateContext } from "./context-cache.mjs"
import { registerHandoff } from "./handoff.mjs"
import { registerBrief } from "./brief.mjs"
import { registerTaskContext } from "./task-context.mjs"
import { collectObservations, observationAPI } from "./observations.mjs"
import { refreshCostReport } from "./cost-report.mjs"
import { registerRetrievalRouting } from "./retrieval-routing.mjs"

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
            fileURLToPath(new URL(`../ai-hooks/bin/${script}`, import.meta.url)),
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
    await context.model.transform((editor) => {
      for (const model of editor.list()) {
        if (model.limit.context <= 0) continue
        editor.update(model.providerID, model.id, (draft) => {
          draft.limit.input = Math.min(
            draft.limit.input > 0 ? draft.limit.input : draft.limit.context,
            draft.limit.context,
            contextPolicy.maxTokens
          )
        })
      }
    })
    let observationQueue = Promise.resolve()
    const observe = (sessionID) => {
      observationQueue = observationQueue.then(async () => {
        try {
          await collectObservations(observationAPI(context), sessionID, { directory })
          const { newWarnings } = await refreshCostReport()
          for (const warning of newWarnings) process.stderr.write(`Harness cost warning: ${warning.code}; ${warning.sessionID ?? "daily"}; observed=${warning.observed}; limit=${warning.limit}.\n`)
        } catch (error) {
          process.stderr.write(`Harness observation failed (${error.name}); session evidence remains incomplete.\n`)
        }
      })
      return observationQueue
    }
    const taskContext = await registerTaskContext(context)
    const handoff = await registerHandoff(context, observe, taskContext)
    const brief = await registerBrief(context, handoff)
    await context.session.hook("compaction", async (event) => {
      await observe(event.sessionID)
      event.system.push({ type: "text", text: readHandoffPrompt() })
    })
    const abort = new AbortController()
    const events = await context.event.subscribe({
      signal: abort.signal,
      types: [
        "session.execution.succeeded",
        "session.execution.failed",
        "session.execution.interrupted"
      ]
    })
    const consume = async () => {
      for await (const event of events) {
        if (event.type.startsWith("session.execution.")) {
          sync()
          await observe(event.data.sessionID)
          try {
            await brief.settle(event.data.sessionID, event.type === "session.execution.succeeded")
          } catch (error) {
            process.stderr.write(`Harness brief transfer failed: ${error.message}\n`)
          }
        }
      }
    }
    consume().catch((error) => {
      if (!abort.signal.aborted) process.stderr.write(`Harness autosync event stream failed: ${error.message}\n`)
    })
    readInstructions()
    await context.session.hook("context", (event) => {
      event.messages = deduplicateContext(event.messages)
      for (let i = event.system.length - 1; i >= 0; i--) {
        if (event.system[i].text?.startsWith("Harness skill instructions:\n") || event.system[i].text?.startsWith("DeepSeek model routing:")) event.system.splice(i, 1)
      }
      event.system.push({
        type: "text",
        text: readInstructions().text
      })
    })
    return async () => {
      abort.abort()
      await observationQueue
    }
  }
}
