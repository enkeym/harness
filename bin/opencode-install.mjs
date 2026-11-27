import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
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
import { writePrivateJSON } from "../opencode/local-state.mjs"

const root = path.resolve(import.meta.dirname, "..")
const home = os.homedir()
const directory = configDirectory()
const args = process.argv.slice(2)
if (args.some((arg) => arg !== "--check")) {
  console.error("Использование: ./install.sh [--check]")
  process.exit(2)
}
const check = args.includes("--check")
const cliSettings = path.join(directory, "cli.json")
const cliDefaults = path.resolve(root, "opencode/cli.json")
function installCliFile() {
  let stat
  try {
    stat = fs.lstatSync(cliSettings)
  } catch (error) {
    if (error.code !== "ENOENT") throw error
  }
  if (!stat) {
    if (check) {
      console.error(`✗ ${cliSettings} — требуется установка`)
      return 1
    }
    fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(cliSettings, fs.readFileSync(cliDefaults), { mode: 0o600 })
    console.log(`✓ ${cliSettings}`)
    return 0
  }
  if (stat.isFile()) return 0
  if (stat.isSymbolicLink()) {
    let managed = false
    try {
      managed = fs.realpathSync(cliSettings) === fs.realpathSync(cliDefaults)
    } catch (error) {
      if (error.code !== "ENOENT") throw error
    }
    if (managed) {
      if (check) {
        console.error(`✗ ${cliSettings} — требуется миграция ссылки в файл`)
        return 1
      }
      const temporary = `${cliSettings}.tmp-${randomUUID()}`
      fs.writeFileSync(temporary, fs.readFileSync(cliSettings), {
        mode: 0o600,
        flag: "wx"
      })
      fs.renameSync(temporary, cliSettings)
      console.log(`✓ ${cliSettings} — ссылка заменена файлом`)
      return 0
    }
  }
  console.error(`✗ ${cliSettings} — существующий файл или ссылка сохранены; устраните конфликт установки`)
  return 1
}
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
const legacyHarnessPlugin = new URL(
  "../opencode/harness.mjs",
  import.meta.url
).href
desired.plugins = [
  ...new Set([
    ...(defaults.plugins ?? []),
    ...(current.plugins ?? []).filter(
      (plugin) => plugin !== legacyHarnessPlugin
    )
  ])
]
for (const agent of Object.values(desired.agents ?? {}))
  if (agent && typeof agent === "object") delete agent.disable
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
const stateFile = path.join(
  process.env.XDG_STATE_HOME || path.join(home, ".local/state"),
  "opencode/model.json"
)
const seed = JSON.parse(fs.readFileSync(path.join(root, "opencode/state/model.json"), "utf8"))
let state = {}
try {
  state = JSON.parse(fs.readFileSync(stateFile, "utf8"))
} catch (error) {
  if (error.code !== "ENOENT") throw error
}
const preferences = {
  ...state,
  variant: { ...seed.variant, ...state.variant },
  favorite: state.favorite?.length ? state.favorite : seed.favorite
}
if (!isDeepStrictEqual(state, preferences)) {
  if (check) {
    console.error("✗ OpenCode model preferences")
    drift++
  } else {
    await writePrivateJSON(stateFile, preferences)
  }
}
const links = [
  [path.join(directory, "plugins/harness"), "opencode"],
  [path.join(directory, "agents/ask.md"), "opencode/agent/ask.md"],
  [path.join(directory, "commands/impact-map.md"), "opencode/commands/impact-map.md"],
  ...harnessLinks(home),
  ...skillLinks(root, path.join(directory, "skills"), { shared: true })
]
for (const [target, relative] of links) {
  drift += installLink(target, path.resolve(root, relative), check)
}
drift += installCliFile()
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
      ...(check ? ["--check"] : [])
    ],
    { stdio: "inherit" }
  )
  execFileSync("opencode", ["--version"], { stdio: "inherit" })
} catch {
  drift++
}
if (check) {
  try {
    execFileSync(process.execPath, [path.join(root, "bin/project-identity.mjs")], {
      stdio: "inherit"
    })
  } catch {}
}
process.exitCode = drift ? 1 : 0
