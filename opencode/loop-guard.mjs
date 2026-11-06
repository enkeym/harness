import { contextPolicy } from "../ai-hooks/bin/context-policy.mjs"
import { readTexts } from "./read-results.mjs"

const policy = contextPolicy.opencode
const readTools = new Set(["read", "grep", "glob", "skill", "shell", "execute"])
const editTools = new Set(["edit", "write", "apply_patch", "patch"])
const guardedTools = ["execute", "shell", "read", "grep", "glob", "skill"]
const digestHeader = /^file: (.+)\nmode: full\ndigest: ([a-f0-9]{64})\n/

export function injectDigests(code, digests) {
  let changed = 0
  const next = code.replace(
    /tokensave_read\(\s*\{([\s\S]*?)\}\s*\)/g,
    (call, args) => {
      if (/\bif_digest\s*:/.test(args)) return call
      const mode = /\bmode\s*:\s*["'`]([^"'`]+)["'`]/.exec(args)
      if (mode && mode[1] !== "full") return call
      const file = /\bfile\s*:\s*["'`]([^"'`\n]+)["'`]/.exec(args)
      if (!file) return call
      const digest = digests.get(file[1])
      if (!digest) return call
      changed++
      return `tokensave_read({ if_digest: "${digest}",${args}})`
    }
  )
  return { code: next, changed }
}

export async function registerLoopGuard(context, taskContext) {
  const sessions = new Map()
  let currentSession = null
  const state = (sessionID) => {
    if (!sessions.has(sessionID))
      sessions.set(sessionID, {
        reads: 0,
        warned: 0,
        skills: new Set(),
        digests: new Map(),
        resume: false
      })
    return sessions.get(sessionID)
  }
  const sessionOf = (event) => event.sessionID ?? currentSession

  await context.session.hook("compaction", async (event) => {
    state(sessionOf(event)).resume = true
  })

  await context.session.hook("context", async (event) => {
    currentSession = event.sessionID ?? currentSession
    const s = state(sessionOf(event))
    if (s.resume) {
      s.resume = false
      const reference = await taskContext.reference(sessionOf(event), false)
      event.system.push({
        type: "text",
        text: [
          "Harness resume after compaction:",
          reference,
          s.skills.size
            ? `Active skills before compaction: ${[...s.skills].join(", ")}. Do not reload them unless the step changes stack.`
            : "",
          `Resume protocol: make the first source edit within ${policy.resumeEditBudget} tool calls. Do not call tokensave_read with mode="full". Read only named ranges you still need. Do not rebuild the plan.`
        ]
          .filter(Boolean)
          .join("\n")
      })
    }
    if (event.agent === "plan" || !(event.tools?.edit || event.tools?.write))
      return
    if (s.reads >= policy.hardReads) {
      for (const name of guardedTools) delete event.tools[name]
      event.system.push({
        type: "text",
        text: `Harness progress guard: ${s.reads} read calls without a file change. Read tools are disabled until you edit. Use edit or write now, or report a concrete blocker.`
      })
      return
    }
    if (s.reads >= policy.softReads && s.warned < 2) {
      s.warned++
      event.system.push({
        type: "text",
        text: `Harness progress guard: ${s.reads} read calls since the last file change. Stop gathering. Make the first edit named in the plan, or report a concrete blocker.`
      })
    }
  })

  await context.tool.hook("execute.after", async (event) => {
    const s = state(sessionOf(event))
    const code = typeof event.input?.code === "string" ? event.input.code : ""
    if (event.tool === "skill" && typeof event.input?.id === "string")
      s.skills.add(event.input.id)
    if (
      editTools.has(event.tool) ||
      (event.tool === "execute" && code.includes("tokensave_multi_str_replace"))
    )
      s.reads = 0
    else if (readTools.has(event.tool)) s.reads++
    if (event.status !== "completed") return
    for (const text of readTexts(event.result)) {
      if (/full_result=|unchanged: true/.test(text)) continue
      const match = digestHeader.exec(text)
      if (match) s.digests.set(match[1], match[2])
    }
  })

  await context.tool.hook("execute.before", async (event) => {
    if (event.tool !== "execute") return
    const code = event.input?.code
    if (typeof code !== "string" || !code.includes("tokensave_read")) return
    const result = injectDigests(code, state(sessionOf(event)).digests)
    if (!result.changed) return
    event.input.code = result.code
    process.stderr.write(
      `Harness loop guard: injected ${result.changed} read digest(s) from earlier full reads.\n`
    )
  })
}
