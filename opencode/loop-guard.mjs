import { contextPolicy } from "../ai-hooks/bin/context-policy.mjs"
import { readTexts } from "./read-results.mjs"
import { boundToolResult } from "./output-bounds.mjs"

const policy = contextPolicy.opencode
const readTools = new Set(["read", "grep", "glob", "skill", "execute", "shell"])
const editTools = new Set(["edit", "write", "apply_patch", "patch"])
const repeatTools = new Set([
  "read",
  "grep",
  "glob",
  "shell",
  "execute",
  "skill",
  "webfetch",
  "websearch"
])
const digestHeader = /^file: (.+)\nmode: full\ndigest: ([a-f0-9]{64})\n/

const softNotice = (reads) =>
  `Harness progress guard: ${reads} read calls since the last file change. Stop gathering. Make the first edit named in the plan, or report a concrete blocker.`
const hardNotice =
  "Harness progress guard: the read budget is exhausted. Do not start another read or shell command. Make the edit named in the plan now, or answer with the verified result or the exact blocker. Any read after this point is a repeated operation the user pays for."
const stopNotice =
  "Harness progress guard: the session exceeded the read budget without a file change and all tools are withdrawn for this turn. Answer now with the verified result, or name the exact blocker and the next step."

const stableKey = (value) => {
  if (Array.isArray(value)) return `[${value.map(stableKey).join(",")}]`
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableKey(value[key])}`)
      .join(",")}}`
  return JSON.stringify(value ?? null)
}

const appendNotice = (event, text) => {
  const result = event.result
  if (!result) return
  if (Array.isArray(result.content)) result.content.push({ type: "text", text })
  else if (typeof result.content === "string")
    result.content = [
      { type: "text", text: result.content },
      { type: "text", text }
    ]
  else if (typeof result.output === "string")
    result.output = `${result.output}\n\n${text}`
  else result.content = [{ type: "text", text }]
}

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

export async function registerLoopGuard(
  context,
  contextCache,
  { outputDir = undefined } = {}
) {
  const sessions = new Map()
  let currentSession = null
  const state = (sessionID) => {
    if (!sessions.has(sessionID))
      sessions.set(sessionID, {
        reads: 0,
        level: 0,
        skills: new Set(),
        digests: new Map(),
        repeats: new Map(),
        resume: false
      })
    return sessions.get(sessionID)
  }
  const sessionOf = (event) => event.sessionID ?? currentSession

  await context.session.hook("compaction", async (event) => {
    const s = state(sessionOf(event))
    s.resume = true
    s.reads = 0
    s.level = 0
    s.digests.clear()
    s.repeats.clear()
  })

  await context.session.hook("context", async (event) => {
    currentSession = event.sessionID ?? currentSession
    const s = state(sessionOf(event))
    if (s.resume) {
      s.resume = false
      const reference = await contextCache.reference(sessionOf(event))
      event.messages.push({
        role: "user",
        content: [{ type: "text", text: [
          "Harness resume after compaction:",
          reference ||
            "No cached ranges. Do not rebuild the plan; use the compaction summary and the plan file.",
          s.skills.size
            ? `Active skills before compaction: ${[...s.skills].join(", ")}. Do not reload them unless the step changes stack.`
            : "",
          `Resume protocol: make the first source edit within ${policy.resumeEditBudget} tool calls. Do not call tokensave_read with mode="full". Read only named ranges you still need.`
        ]
          .filter(Boolean)
          .join("\n")
        }]
      })
    }
    if (event.agent === "plan" || !(event.tools?.edit || event.tools?.write))
      return
    if (s.level >= 3) {
      event.tools = {}
      return
    }
  })

  await context.tool.hook("execute.after", async (event) => {
    if (event.status === "completed")
      boundToolResult(event, outputDir === undefined ? undefined : { dir: outputDir })
    const s = state(sessionOf(event))
    const code = typeof event.input?.code === "string" ? event.input.code : ""
    if (event.tool === "skill" && typeof event.input?.id === "string")
      s.skills.add(event.input.id)
    const edited =
      editTools.has(event.tool) ||
      (event.tool === "execute" && code.includes("tokensave_multi_str_replace"))
    if (
      event.status === "completed" &&
      repeatTools.has(event.tool) &&
      event.input &&
      typeof event.input === "object"
    ) {
      const key = `${event.tool}|${stableKey(event.input)}`
      const previous = s.repeats.get(key)
      if (previous && previous !== event.id)
        appendNotice(
          event,
          `Harness repeat guard: this exact ${event.tool} call already ran as tool call ${previous} since the last file change. Reuse that result instead of repeating it.`
        )
      else if (!previous) s.repeats.set(key, event.id ?? key)
    }
    if (edited) {
      s.reads = 0
      s.level = 0
      s.repeats.clear()
    } else if (readTools.has(event.tool)) s.reads++
    const level =
      s.reads >= policy.stopReads
        ? 3
        : s.reads >= policy.hardReads
          ? 2
          : s.reads >= policy.softReads
            ? 1
            : 0
    if (event.status === "completed" && level > s.level) {
      s.level = level
      appendNotice(
        event,
        level === 3 ? stopNotice : level === 2 ? hardNotice : softNotice(s.reads)
      )
    }
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

  return {
    finishTurn(sessionID) {
      const s = state(sessionID ?? currentSession)
      s.reads = 0
      s.level = 0
      s.repeats.clear()
    }
  }
}
