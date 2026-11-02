import fs from "node:fs"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { contextPolicy, handoffPrompt } from "../ai-hooks/bin/context-policy.mjs"
import { escalateStalledSession, registerHandoff } from "./handoff.mjs"
import { deepseekModels, deepseekRouting, deepseekRoutingPro } from "./model-routing.mjs"
import { collectObservations, observationAPI } from "./observations.mjs"

export default {
  id: "harness",
  setup: async (context) => {
    const directory = context.location.directory
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
        } catch (error) {
          process.stderr.write(`Harness observation failed (${error.name}); session evidence remains incomplete.\n`)
        }
      })
      return observationQueue
    }
    const handoff = await registerHandoff(context, observe)
    await context.session.hook("compaction", async (event) => {
      await observe(event.sessionID)
      event.system.push({ type: "text", text: handoffPrompt })
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
          if (event.type === "session.execution.succeeded") {
            try {
              await escalateStalledSession(context, event.data.sessionID, handoff)
            } catch (error) {
              process.stderr.write(`Harness escalation failed (${error.name}); inspect the source session before retrying.\n`)
            }
          }
        }
      }
    }
    consume().catch((error) => {
      if (!abort.signal.aborted) process.stderr.write(`Harness autosync event stream failed: ${error.message}\n`)
    })
    const core = fs.readFileSync(
      new URL("../rules/core.md", import.meta.url),
      "utf8"
    )
    const routing = core
      .split("\n## Skills and hooks\n")[1]
      ?.split("\n## ")[0]
      .trim()
    if (!routing)
      throw new Error("Harness skill routing instructions are missing")
    const instructions = fs
      .readFileSync(new URL("./AGENTS.md", import.meta.url), "utf8")
      .trim()
    await context.session.hook("context", (event) => {
      if (event.model.providerID === deepseekModels.flash.providerID && ["build", "plan", "general"].includes(event.agent)) {
        event.system.push({ type: "text", text: event.model.id === deepseekModels.pro.id ? deepseekRoutingPro : deepseekRouting })
      }
      event.system.push({
        type: "text",
        text: `Harness skill instructions:\n${routing}\n\n${instructions}`
      })
    })
    return async () => {
      abort.abort()
      await observationQueue
    }
  }
}
