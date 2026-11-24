import fs from "node:fs"
import path from "node:path"
import { hash } from "../ai-hooks/bin/context-state.mjs"
import { inside } from "./local-state.mjs"

const shellOperator = /[;&|<>`\n\r]/
const regexMeta = /[\\^$.*+?()[\]{}|]/
const fileMeta = /[*?[\]{}]/

export const testReceiptKey = (sessionID, planID, criterionID) =>
  `test-receipt:${sessionID}:${planID}:${String(criterionID).toLowerCase()}`

const fingerprint = (root, files) => {
  const seen = new Set()
  return files
    .map((file) => path.resolve(root, file))
    .filter((file) => {
      if (seen.has(file)) return false
      seen.add(file)
      return true
    })
    .sort()
    .map((file) => {
      if (!inside(root, file)) throw new Error("Test input is outside the project")
      const content = fs.readFileSync(file)
      return { file: path.relative(root, file), hash: hash(content) }
    })
}

export const testInputFingerprint = (root, files) => fingerprint(root, files)

export function splitCommand(command) {
  const tokens = []
  let current = ""
  let quote = null
  let escaped = false
  for (const char of String(command ?? "")) {
    if (escaped) {
      current += char
      escaped = false
      continue
    }
    if (char === "\\" && quote !== "'") {
      escaped = true
      continue
    }
    if (quote) {
      if (char === quote) quote = null
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current)
        current = ""
      }
      continue
    }
    if (shellOperator.test(char)) throw new Error("Unsupported shell operator")
    current += char
  }
  if (quote) throw new Error("Unclosed quote")
  if (escaped) current += "\\"
  if (current) tokens.push(current)
  return tokens
}

const nodeTestCommand = (tokens) => {
  if (tokens[0] !== "node" || tokens[1] !== "--test") return null
  let file = null
  let pattern = null
  for (let index = 2; index < tokens.length; index++) {
    const token = tokens[index]
    if (token === "-t" || token === "--test-name-pattern") {
      pattern = tokens[++index]
      if (pattern === undefined) return null
      continue
    }
    if (token.startsWith("--test-name-pattern=")) {
      pattern = token.slice("--test-name-pattern=".length)
      continue
    }
    if (/^--test-concurrency(?:=\d+)?$/.test(token)) continue
    if (token.startsWith("-")) return null
    if (file) return null
    file = token
  }
  if (!file || !pattern || fileMeta.test(file)) return null
  let testName = pattern
  if (testName.startsWith("^")) testName = testName.slice(1)
  if (testName.endsWith("$")) testName = testName.slice(0, -1)
  if (!testName || regexMeta.test(testName)) return null
  return { file, testName }
}

export function parseMachineCheckDeclaration(check, root) {
  if (
    !check ||
    check.kind !== "test" ||
    !Array.isArray(check.inputs) ||
    !check.inputs.length
  )
    return null
  let command
  try {
    command = nodeTestCommand(splitCommand(check.anchor))
  } catch {
    return null
  }
  if (!command) return null
  const file = path.resolve(root, command.file)
  if (!inside(root, file)) return null
  const inputs = [path.relative(root, file), ...check.inputs]
  let resolved
  try {
    resolved = [
      ...new Set(
        inputs.map((input) => {
          const target = path.resolve(root, input)
          if (!inside(root, target)) throw new Error("Test input is outside the project")
          return path.relative(root, target)
        })
      )
    ].sort()
  } catch {
    return null
  }
  return {
    file: path.relative(root, file),
    testName: command.testName,
    inputs: resolved,
    checkHash: hash(
      JSON.stringify({ kind: check.kind, anchor: check.anchor, inputs: resolved })
    )
  }
}

export function parseMachineCheck(check, root) {
  const definition = parseMachineCheckDeclaration(check, root)
  if (!definition) return null
  try {
    if (!fs.statSync(path.resolve(root, definition.file)).isFile()) return null
    fingerprint(root, definition.inputs)
  } catch {
    return null
  }
  return definition
}

export function commandRunsMachineCheck(command, spec, root) {
  let parsed
  try {
    parsed = nodeTestCommand(splitCommand(command))
  } catch {
    return false
  }
  if (!parsed || parsed.testName !== spec.testName) return false
  const file = path.resolve(root, parsed.file)
  return inside(root, file) && file === path.resolve(root, spec.file)
}

export function shellResult(result) {
  const output = result?.output
  const exitCode =
    (typeof output === "object" && output !== null ? output.exitCode : undefined) ??
    result?.metadata?.exit ??
    result?.metadata?.exitCode
  const text =
    typeof output === "string"
      ? output
      : typeof output?.output === "string"
        ? output.output
        : typeof output?.text === "string"
          ? output.text
          : ""
  return { exitCode, text }
}

export function parseTap(output, testName) {
  const text = String(output ?? "").replace(/\x1b\[[0-9;]*m/g, "")
  const results = []
  const summary = {}
  for (const line of text.split("\n")) {
    const result = /^(ok|not ok) \d+ - (.*)$/.exec(line)
    if (result) {
      let name = result[2].trim()
      let directive = null
      const marked = / # (SKIP|TODO)\b/i.exec(name)
      if (marked) {
        directive = marked[1].toUpperCase()
        name = name.slice(0, marked.index).trim()
      }
      results.push({ ok: result[1] === "ok", name, directive })
      continue
    }
    const count = /^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$/.exec(line)
    if (count) summary[count[1]] = Number(count[2])
  }
  const matches = results.filter((result) => result.name === testName)
  const problems = []
  if (!Object.keys(summary).length) problems.push("runner summary is missing")
  if (summary.tests !== 1 || summary.pass !== 1) problems.push("runner did not report exactly one passing test")
  if (summary.fail !== 0 || summary.cancelled !== 0) problems.push("runner reported a failed or cancelled test")
  if (summary.skipped !== 0 || summary.todo !== 0) problems.push("runner skipped or did not run the test")
  if (matches.length !== 1) problems.push("the exact test name did not run exactly once")
  else if (!matches[0].ok || matches[0].directive)
    problems.push("the exact test did not pass normally")
  return {
    ok: problems.length === 0,
    problems,
    summary,
    results,
    matches,
    recognized: Object.keys(summary).length > 0
  }
}

export function parseSpec(output, testName) {
  const text = String(output ?? "").replace(/\x1b\[[0-9;]*m/g, "")
  const results = []
  const summary = {}
  for (const line of text.split("\n")) {
    const result = /^([✔✖﹣])\s+(.*)$/.exec(line)
    if (result) {
      let name = result[2].trim()
      let directive = null
      const marked = / # (SKIP|TODO)\b/i.exec(name)
      if (marked) {
        directive = marked[1].toUpperCase()
        name = name.slice(0, marked.index).trim()
      }
      name = name.replace(/\s+\(\d+(?:\.\d+)?(?:ms|s)\)$/, "").trim()
      results.push({ ok: result[1] === "✔", name, directive })
      continue
    }
    const count = /^ℹ (tests|pass|fail|cancelled|skipped|todo) (\d+)$/.exec(line)
    if (count) summary[count[1]] = Number(count[2])
  }
  const matches = results.filter((result) => result.name === testName)
  const problems = []
  if (!Object.keys(summary).length) problems.push("runner summary is missing")
  if (summary.tests !== 1 || summary.pass !== 1) problems.push("runner did not report exactly one passing test")
  if (summary.fail !== 0 || summary.cancelled !== 0) problems.push("runner reported a failed or cancelled test")
  if (summary.skipped !== 0 || summary.todo !== 0) problems.push("runner skipped or did not run the test")
  if (matches.length !== 1) problems.push("the exact test name did not run exactly once")
  else if (!matches[0].ok || matches[0].directive)
    problems.push("the exact test did not pass normally")
  return {
    ok: problems.length === 0,
    problems,
    summary,
    results,
    matches,
    recognized: Object.keys(summary).length > 0
  }
}

export function parseRunnerOutput(output, testName) {
  const tap = parseTap(output, testName)
  if (tap.recognized) return { ...tap, format: "tap" }
  const spec = parseSpec(output, testName)
  if (spec.recognized) return { ...spec, format: "spec" }
  return {
    ok: false,
    problems: ["runner output was not recognized"],
    summary: {},
    matches: [],
    recognized: false
  }
}
