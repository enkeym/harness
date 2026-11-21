import { contextPolicy } from "../ai-hooks/bin/context-policy.mjs"
import { boundToolResult } from "./output-bounds.mjs"
import { sanitizeMessageTexts } from "./dsml.mjs"

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
const softNotice = (reads, implementation) =>
  implementation
    ? `Harness progress guard: ${reads} read calls since the last file change. Stop gathering. Make the first edit named in the plan, or report a concrete blocker.`
    : `Harness progress guard: ${reads} read calls without a file change in this session. Stop gathering and reuse confirmed results. For an analysis-only task answer with the verified result or a concrete blocker; move to an edit only when the plan authorizes implementation.`
const hardNotice = (implementation) =>
  implementation
    ? "Harness progress guard: the read budget is exhausted. Do not start another read or shell command. Make the edit named in the plan now, or answer with the verified result or the exact blocker. Any read after this point is a repeated operation the user pays for."
    : "Harness progress guard: the read budget is exhausted without a file change in this session. Do not start another read or shell command for new material; reuse confirmed results and answer with the verified result or the exact blocker. Any further read is a repeated operation the user pays for."
const stopNotice = (implementation) =>
  implementation
    ? "Harness progress guard: the session exceeded the read budget without a file change and all tools are withdrawn for this turn. Answer now with the verified result, or name the exact blocker and the next step."
    : "Harness progress guard: the session exceeded the read budget without a file change. Verification tools stay available, but do not gather new material: answer now with the verified result, or name the exact blocker and the next step."

const verificationRun =
  /(?:^|[\s;&|(`])(?:npm (?:run )?(?:test|check)|pnpm (?:run )?(?:test|check)|yarn (?:test|check)|node --test|pytest|cargo test|go test|make (?:test|check)|install\.sh --check)\b/
const gathersSources =
  /tokensave_read|tokensave_search|rag_search|harness_read_result|\bread\s*\(|\bgrep\s*\(|\bglob\s*\(/
const planningCall = /\btools\.brief_transition\b/
const discoveryCall = /\bsearch\s*\(\s*\{/

const editSucceeded = (event, code) =>
  event.status === "completed" &&
  !event.error &&
  (editTools.has(event.tool) ||
    (event.tool === "execute" && code.includes("tokensave_multi_str_replace")))

const verificationCall = (tool, input) => {
  const text =
    tool === "shell"
      ? typeof input?.command === "string"
        ? input.command
        : ""
      : tool === "execute" && typeof input?.code === "string"
        ? input.code
        : ""
  if (!text) return false
  if (planningCall.test(text)) return true
  if (gathersSources.test(text)) return false
  return verificationRun.test(text) || discoveryCall.test(text)
}

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
        edited: false,
        skills: new Set(),
        repeats: new Map(),
        resume: false,
        dsmlLoopWarned: false
      })
    return sessions.get(sessionID)
  }
  const sessionOf = (event) => event.sessionID ?? currentSession

  await context.session.hook("compaction", async (event) => {
    const s = state(sessionOf(event))
    s.resume = true
    s.reads = 0
    s.level = 0
    s.edited = false
    s.repeats.clear()
  })

  await context.session.hook("context", async (event) => {
    currentSession = event.sessionID ?? currentSession
    const s = state(sessionOf(event))
    if (Array.isArray(event.messages)) {
      const { changed, repeated } = sanitizeMessageTexts(event.messages)
      if (changed) {
        process.stderr.write(
          `Harness DSML guard: stripped leaked DSML markup from ${changed} outgoing message part(s).\n`
        )
      }
      if (repeated.length && !s.dsmlLoopWarned) {
        s.dsmlLoopWarned = true
        event.messages.push({
          role: "user",
          content: [
            {
              type: "text",
              text: `Harness DSML guard: ${repeated.length} repeated assistant block(s) contained raw DSML tool-call markup instead of an executed tool call. Do not copy that markup. Emit the tool call through the tool interface, or answer in prose if the tool result is already available.`
            }
          ]
        })
      }
    }
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
          s.edited
            ? `Resume protocol: make the first source edit within ${policy.resumeEditBudget} tool calls. Do not call tokensave_read with mode="full". Read only named ranges you still need.`
            : `Resume protocol: continue the next unfinished step of the plan within ${policy.resumeEditBudget} tool calls; for analysis-only work that is the next research or verification step, not an edit the plan does not authorize. Do not call tokensave_read with mode="full". Read only named ranges you still need.`
        ]
          .filter(Boolean)
          .join("\n")
        }]
      })
    }
    if (event.agent === "plan" || !s.edited) return
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
    if (
      event.tool === "skill" &&
      event.status === "completed" &&
      typeof event.input?.id === "string"
    )
      s.skills.add(event.input.id)
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
    if (editSucceeded(event, code)) {
      s.edited = true
      s.reads = 0
      s.level = 0
      s.repeats.clear()
    } else if (
      readTools.has(event.tool) &&
      !verificationCall(event.tool, event.input)
    )
      s.reads++
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
        level === 3
          ? stopNotice(s.edited)
          : level === 2
            ? hardNotice(s.edited)
            : softNotice(s.reads, s.edited)
      )
    }
  })

  return {
    finishTurn(sessionID) {
      const s = state(sessionID ?? currentSession)
      s.reads = 0
      s.level = 0
      s.edited = false
      s.repeats.clear()
    }
  }
}
