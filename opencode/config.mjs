import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { applyEdits, modify, parse, printParseErrorCode } from "jsonc-parser"

export function configDirectory() {
  return (
    process.env.OPENCODE_CONFIG_DIR ||
    path.join(
      process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
      "opencode"
    )
  )
}

export function readConfig(file) {
  if (!fs.existsSync(file)) return {}
  const errors = []
  const value = parse(fs.readFileSync(file, "utf8"), errors, {
    allowTrailingComma: true
  })
  if (errors.length)
    throw new Error(
      `${file}: ${printParseErrorCode(errors[0].error)} at ${errors[0].offset}`
    )
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${file}: expected an object`)
  return value
}

export function mergeConfig(base, override) {
  const result = { ...base }
  for (const [key, value] of Object.entries(override)) {
    if (["__proto__", "constructor", "prototype"].includes(key))
      throw new Error(`Unsupported configuration key: ${key}`)
    result[key] =
      value && typeof value === "object" && !Array.isArray(value)
        ? mergeConfig(
            base[key] &&
              typeof base[key] === "object" &&
              !Array.isArray(base[key])
              ? base[key]
              : {},
            value
          )
        : value
  }
  return result
}

export function loadConfig(directory = configDirectory()) {
  const settings = path.join(directory, "opencode.jsonc")
  const alternative = path.join(directory, "opencode.json")
  return {
    settings,
    current: mergeConfig(readConfig(alternative), readConfig(settings))
  }
}

export function writeConfig(file, desired) {
  const files = path.basename(file) === "opencode.jsonc"
    ? [path.join(path.dirname(file), "opencode.json"), file]
    : [file]
  const changes = files.flatMap((target) => {
    const removalsOnly = target !== file
    if (removalsOnly && !fs.existsSync(target)) return []
    const original = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "{}\n"
    const current = readConfig(target)
    let text = original
    const update = (before, after, keys) => {
      if (JSON.stringify(before) === JSON.stringify(after)) return
      if (
        before &&
        after &&
        typeof before === "object" &&
        typeof after === "object" &&
        !Array.isArray(before) &&
        !Array.isArray(after)
      ) {
        for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
          update(before[key], Object.hasOwn(after, key) ? after[key] : undefined, [...keys, key])
        }
      } else if (!removalsOnly || after === undefined) {
        text = applyEdits(
          text,
          modify(text, keys, after, {
            formattingOptions: { insertSpaces: true, tabSize: 2 }
          })
        )
      }
    }
    update(current, desired, [])
    return text === original && fs.existsSync(target) ? [] : [{ target, text }]
  })
  for (const { target, text } of changes) {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    if (fs.existsSync(target))
      fs.copyFileSync(
        target,
        `${target}.bak-${Date.now()}`,
        fs.constants.COPYFILE_EXCL
      )
    fs.writeFileSync(target, text, { mode: 0o600 })
  }
}
