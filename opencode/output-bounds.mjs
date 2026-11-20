import { boundTextResult, contextOutputDir } from "../ai-hooks/bin/context-state.mjs"
import { contextPolicy } from "../ai-hooks/bin/context-policy.mjs"

const boundedTools = new Set([
  "read",
  "grep",
  "glob",
  "shell",
  "webfetch",
  "execute",
  "skill"
])

const textBlocks = (content) => {
  if (Array.isArray(content))
    return content.every(
      (part) => part.type === "text" && typeof part.text === "string"
    )
      ? content
      : null
  if (typeof content === "string") return [{ type: "text", text: content }]
  return null
}

const artifactFullRequest = (content) => {
  const text = content.map((part) => part.text).join("")
  if (!text.startsWith("{")) return false
  try {
    const value = JSON.parse(text)
    return value?.harnessArtifact === true && value?.full === true
  } catch {
    return false
  }
}

export function boundToolResult(
  event,
  {
    budget = contextPolicy.opencode.toolOutputBytes,
    dir = contextOutputDir()
  } = {}
) {
  if (
    event?.status !== "completed" ||
    !event.result ||
    !boundedTools.has(event.tool)
  )
    return false
  const result = event.result
  const provided = textBlocks(result.content)
  if (Array.isArray(result.content) && !provided) return false
  const content =
    provided ??
    (typeof result.output === "string"
      ? [{ type: "text", text: result.output }]
      : null)
  if (!content?.length) return false
  const bytes = content.reduce((sum, part) => sum + Buffer.byteLength(part.text), 0)
  const limit = artifactFullRequest(content)
    ? Math.max(budget, contextPolicy.opencode.artifactFullOutputBytes)
    : budget
  if (bytes <= limit) return false
  let bounded
  try {
    bounded = boundTextResult({ ...result, content }, budget, dir, undefined, {
      anyText: true
    })
  } catch (error) {
    process.stderr.write(`Harness output bounds skipped: ${error.message}\n`)
    return false
  }
  const text = bounded.content.map((part) => part.text).join("")
  event.result = Object.assign(
    result,
    bounded,
    provided || typeof result.output !== "string" ? {} : { output: text }
  )
  return true
}
