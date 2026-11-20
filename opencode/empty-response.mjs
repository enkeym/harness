const RETRY_LIMIT = 1

export const NOTICE =
  "Harness empty response guard: the previous reply contained no text and no tool call, so the turn ended without an answer. Continue the same task from the last verified step; do not repeat completed work."

export function emptyCompletion(messages) {
  const list = Array.isArray(messages) ? messages : []
  const last = list[list.length - 1]
  if (!last || last.type !== "assistant") return null
  if (last.error) return null
  if (last.finish && last.finish !== "stop") return null
  const parts = Array.isArray(last.content) ? last.content : []
  const answered = parts.some(
    (part) =>
      (part?.type === "text" && typeof part.text === "string" && part.text.trim()) ||
      part?.type === "tool"
  )
  return answered ? null : (last.id ?? "anonymous")
}

export async function registerEmptyResponseGuard(context) {
  const retried = new Map()
  const check = async (sessionID, source) => {
    if (!sessionID || source?.parentID) return null
    const messages = await context.session.context({ sessionID })
    const empty = emptyCompletion(messages)
    if (!empty) {
      retried.delete(sessionID)
      return null
    }
    const seen = retried.get(sessionID) ?? new Set()
    if (seen.has(empty) || seen.size >= RETRY_LIMIT) return null
    seen.add(empty)
    retried.set(sessionID, seen)
    if (retried.size > 500) retried.delete(retried.keys().next().value)
    try {
      await context.session.synthetic({ sessionID, text: NOTICE })
    } catch (error) {
      seen.delete(empty)
      throw error
    }
    return empty
  }
  return { check }
}
