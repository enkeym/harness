import { boundTextResult, contextOutputDir } from "../ai-hooks/bin/context-state.mjs"
import { contextPolicy } from "../ai-hooks/bin/context-policy.mjs"

const boundedTools = new Set([
  "read",
  "grep",
  "glob",
  "shell",
  "webfetch",
  "execute"
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
  const content =
    provided ??
    (typeof result.output === "string"
      ? [{ type: "text", text: result.output }]
      : null)
  if (!content?.length) return false
  const bytes = content.reduce((sum, part) => sum + Buffer.byteLength(part.text), 0)
  if (bytes <= budget) return false
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
