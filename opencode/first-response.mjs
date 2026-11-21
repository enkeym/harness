import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const counterScript = fileURLToPath(
  new URL("../ai-hooks/bin/count-first-response.sh", import.meta.url)
)

const spawnCounter = (directory, ms) => {
  const child = spawn("bash", [counterScript, directory, String(ms)], {
    detached: true,
    stdio: "ignore"
  })
  child.on("error", () => {})
  child.unref()
}

export const registerFirstResponse = async (
  context,
  directory,
  record = spawnCounter
) => {
  const starts = new Map()
  await context.session.hook("prompt", (event) => {
    if (event.sessionID) starts.set(event.sessionID, Date.now())
  })
  await context.session.hook("http.response", (event) => {
    if (event.kind && event.kind !== "primary") return
    const started = starts.get(event.sessionID)
    if (started === undefined) return
    starts.delete(event.sessionID)
    record(directory, Date.now() - started)
  })
}
