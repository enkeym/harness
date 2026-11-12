const active =
  (globalThis[Symbol.for("harness.session.compaction")] ??= new Map())

export function finishCompaction(sessionID) {
  active.delete(sessionID)
}

export async function compactSession(context, sessionID) {
  if (typeof context.session.compact !== "function")
    throw new Error(
      "Installed OpenCode does not expose same-session compaction; Handoff stopped before creating another session"
    )
  const current = active.get(sessionID)
  if (current) return current
  const promise = Promise.resolve(
    context.session.compact({ sessionID })
  )
  active.set(sessionID, promise)
  try {
    return await promise
  } catch (error) {
    active.delete(sessionID)
    throw error
  }
}
