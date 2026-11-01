import fs from "node:fs"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

export default {
  id: "harness",
  setup: async (context) => {
    const directory = context.location.directory
    const sync = (warm = false) => {
      for (const script of ["tokensave-sync.sh", "ragsave-sync.sh"]) {
        const child = spawn(
          "bash",
          [
            fileURLToPath(new URL(`../ai-hooks/bin/${script}`, import.meta.url)),
            ...(warm && script === "ragsave-sync.sh" ? ["--warm"] : []),
            directory
          ],
          { detached: true, stdio: "ignore" }
        )
        child.on("error", () => {})
        child.unref()
      }
    }
    sync(true)
    const events = await context.event.subscribe({
      types: [
        "session.execution.succeeded",
        "session.execution.failed",
        "session.execution.interrupted"
      ]
    })
    const consume = async () => {
      for await (const event of events) {
        if (event.type.startsWith("session.execution.")) sync()
      }
    }
    consume().catch((error) =>
      process.stderr.write(
        `Harness autosync event stream failed: ${error.message}\n`
      )
    )
    const core = fs.readFileSync(
      new URL("../rules/core.md", import.meta.url),
      "utf8"
    )
    const routing = core
      .split("\n## Skills and hooks\n")[1]
      ?.split("\n## ")[0]
      .trim()
    if (!routing)
      throw new Error("Harness skill routing instructions are missing")
    const instructions = fs
      .readFileSync(new URL("./AGENTS.md", import.meta.url), "utf8")
      .trim()
    await context.session.hook("context", (event) => {
      event.system.push({
        type: "text",
        text: `Harness skill instructions:\n${routing}\n\n${instructions}`
      })
    })
  }
}
