import fs from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { observationDirectory } from "./observations.mjs"
import { lifecycleMetricsEnabled } from "../ai-hooks/bin/context-policy.mjs"

export const lifecycleJournalFile = (directory, stateDirectory) =>
  path.join(observationDirectory(directory, stateDirectory), "lifecycle.ndjson")

export function recordLifecycle(entry, { directory, stateDirectory } = {}) {
  if (!lifecycleMetricsEnabled()) return Promise.resolve()
  return (async () => {
    const file = lifecycleJournalFile(directory, stateDirectory)
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
    await fs.appendFile(
      file,
      `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
      { mode: 0o600 }
    )
  })().catch(() => {})
}

export async function awaitBounded(pending, waitMs, onTimeout) {
  const raced = await Promise.race([
    Promise.resolve(pending).then(
      (value) => ({ value }),
      (error) => ({ error })
    ),
    delay(waitMs, null, { ref: false }).then(() => ({ timedOut: true }))
  ])
  if (raced.error) throw raced.error
  if (!raced.timedOut) return raced.value
  return onTimeout ? await onTimeout() : undefined
}
