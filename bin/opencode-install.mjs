import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { isDeepStrictEqual } from "node:util"
import { installShell } from "./shell-install.mjs"
import { harnessLinks, skillLinks, installDefaults, installLink } from "./install-files.mjs"
import {
  configDirectory,
  loadConfig,
  mergeConfig,
  readConfig,
  writeConfig
} from "../opencode/config.mjs"
import { contextPolicy } from "../ai-hooks/bin/context-policy.mjs"
import { configureModelRouting, migrateBundledModels } from "../opencode/model-routing.mjs"

const root = path.resolve(import.meta.dirname, "..")
const home = os.homedir()
const directory = configDirectory()
const args = process.argv.slice(2)
if (args.some((arg) => !["--check", "--yes"].includes(arg))) {
  console.error("Использование: ./install.sh --opencode [--check] [--yes]")
  process.exit(2)
}
const check = args.includes("--check")
const defaults = readConfig(path.join(root, "opencode/opencode.jsonc"))
const { settings, current } = loadConfig(directory)
const desired = structuredClone(mergeConfig(defaults, current))
migrateBundledModels(desired, defaults)
configureModelRouting(desired)
const harnessInstructions = new Set(
  ["opencode/AGENTS.md", "rules/core.md"].map((file) => path.join(root, file))
)
desired.instructions = [
  ...new Set(
    (current.instructions ?? []).filter(
      (file) => !harnessInstructions.has(file)
    )
  )
]
desired.commands = { ...desired.commands }
desired.compaction = {
  ...current.compaction,
  auto: true,
  keep: { tokens: contextPolicy.opencode.keepTokens },
  buffer: contextPolicy.opencode.maxTokens - contextPolicy.opencode.startTokens
}
desired.experimental = { ...current.experimental, background_compaction: false }
desired.plugins = (current.plugins ?? []).filter(
  (plugin) =>
    plugin !== new URL("../opencode/harness.mjs", import.meta.url).href
)
let drift = 0
const legacyPlugin = path.join(directory, "plugins/harness.js")
try {
  const stat = fs.lstatSync(legacyPlugin)
  if (
    stat.isSymbolicLink() &&
    fs.realpathSync(legacyPlugin) === path.join(root, "opencode/harness.js")
  ) {
    if (check) {
      console.error("✗ OpenCode legacy plugin entry")
      drift++
    } else fs.unlinkSync(legacyPlugin)
  }
} catch (error) {
  if (error.code !== "ENOENT") throw error
}
if (!isDeepStrictEqual(current, desired) || !fs.existsSync(settings)) {
  if (check) {
    console.error("✗ OpenCode instructions/plugins")
    drift++
  } else {
    writeConfig(settings, desired)
  }
}
const links = [
  [path.join(directory, "plugins/harness"), "opencode"],
  [path.join(directory, "cli.json"), "opencode/cli.json"],
  [path.join(directory, "agents/ask.md"), "opencode/agent/ask.md"],
  ...harnessLinks(home),
  ...skillLinks(root, path.join(directory, "skills"), { shared: true })
]
for (const [target, relative] of links) {
  drift += installLink(target, path.resolve(root, relative), check)
}
drift += installDefaults(
  path.join(home, ".tokensave/config.toml"),
  path.join(root, "tokensave/config.toml"),
  check
)
drift += installShell(home, check)
try {
  execFileSync(
    process.execPath,
    [
      path.join(root, "bin/mcp-sync.mjs"),
      "--opencode",
      ...(check ? ["--check"] : [])
    ],
    { stdio: "inherit" }
  )
  execFileSync("opencode", ["--version"], { stdio: "inherit" })
} catch {
  drift++
}
process.exitCode = drift ? 1 : 0
