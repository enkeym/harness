import { execFile } from "node:child_process"
import { promisify } from "node:util"
import {
  collectObservations,
  requestObservation
} from "../opencode/observations.mjs"
import { refreshCostReport } from "../opencode/cost-report.mjs"

const run = promisify(execFile)
const [sessionID, ...extra] = process.argv.slice(2)
if (!/^ses_[a-zA-Z0-9_-]+$/.test(sessionID ?? "") || extra.length) {
  process.stderr.write("Usage: node bin/opencode-observe.mjs ses_ID\n")
  process.exitCode = 2
} else {
  try {
    const version = (
      await run("opencode", ["--version"], { timeout: 15000 })
    ).stdout
      .trim()
      .replace(/^opencode v/, "")
    const request = (operation, params) =>
      requestObservation(run, operation, params)
    const files = await collectObservations(
      {
        version,
        prices: async (directory) =>
          (await request("model.list", { "location[directory]": directory }))
            .data,
        get: async (id) =>
          (await request("session.get", { sessionID: id })).data,
        messages: (id, cursor) =>
          request("session.message.list", {
            sessionID: id,
            limit: 100,
            ...(cursor ? { cursor } : { order: "asc" })
          }),
        children: (id, cursor) =>
          request("session.list", {
            parentID: id,
            limit: 100,
            ...(cursor ? { cursor } : { order: "asc" })
          })
      },
      sessionID
    )
    process.stdout.write(
      `${JSON.stringify({ files, readyForOptimization: false })}\n`
    )
    await refreshCostReport()
  } catch {
    process.stderr.write(
      "OpenCode observation failed; no complete observation is claimed. Check native API availability, version and permissions.\n"
    )
    process.exitCode = 1
  }
}
