import assert from "node:assert/strict"
import fs from "node:fs"
import { test } from "node:test"
import { deduplicateContext } from "../../opencode/context-cache.mjs"
import { readInstructions } from "../../opencode/instructions.mjs"
import { readHandoffPrompt } from "../bin/context-policy.mjs"

const source = `file: source.mjs\nmode: lines\ndigest: ${"a".repeat(64)}\n\n${"source evidence\n".repeat(60)}`
const result = (id, value = source, name = "execute") => ({ role: "tool", content: [{ type: "tool-result", id, name, result: { type: "text", value } }] })

test("context keeps one complete identical MCP read without mutating stored history", () => {
  const messages = [result("first"), result("second")]
  const before = structuredClone(messages)

  const projected = deduplicateContext(messages)

  assert.equal(projected[0].content[0].result.value, source)
  assert.match(projected[1].content[0].result.value, /retained in tool call first/)
  assert.ok(JSON.stringify(projected).length < JSON.stringify(messages).length)
  assert.deepEqual(messages, before)
})

test("changed, truncated, uncertain and generic tool outputs remain complete", () => {
  for (const [value, name] of [[source.replace("source evidence", "changed evidence"), "execute"], [source + "\nfull_result=/tmp/log", "execute"], ["ordinary shell output".repeat(60), "shell"]]) {
    const messages = [result("first"), result("second", value, name)]
    assert.equal(deduplicateContext(messages)[1].content[0].result.value, value)
  }
  const providerExecuted = result("remote")
  providerExecuted.content[0].providerExecuted = true
  assert.deepEqual(deduplicateContext([result("first"), providerExecuted])[1], providerExecuted)
})

test("compaction, handoff and separate sessions cannot retain a missing original", () => {
  deduplicateContext([result("old"), result("duplicate")])

  for (const messages of [[result("duplicate")], [result("new-session")], [result("after-handoff")]]) {
    assert.equal(deduplicateContext(messages)[0].content[0].result.value, source)
  }
})

test("multi-block read results are deduplicated while file and JSON results remain untouched", () => {
  const first = result("first")
  first.content[0].result = { type: "content", value: [{ type: "text", text: source }, { type: "text", text: "Relevant metadata" }] }
  const second = structuredClone(first)
  second.content[0].id = "second"
  assert.match(deduplicateContext([first, second])[1].content[0].result.value, /tool call first/)
  for (const value of [{ type: "json", value: { source } }, { type: "content", value: [{ type: "text", text: source }, { type: "file", uri: "file:///image", mime: "image/png" }] }]) {
    first.content[0].result = value
    second.content[0].result = structuredClone(value)
    assert.deepEqual(deduplicateContext([first, second])[1], second)
  }
})

test("identical skill text is elided only while its complete version remains in the request", () => {
  const text = "Applicable skill instructions\n".repeat(40)
  const messages = [result("skill-first", text, "skill"), result("skill-second", text, "skill")]

  assert.match(deduplicateContext(messages)[1].content[0].result.value, /skill-first/)
  assert.equal(deduplicateContext(messages.slice(1))[0].content[0].result.value, text)
  assert.equal(deduplicateContext([messages[0], result("updated", text + "changed", "skill")])[1].content[0].result.value, text + "changed")
})

test("instruction and handoff readers observe changes without reloading their modules", t => {
  let version = "first"
  const read = fs.readFileSync
  t.mock.method(fs, "readFileSync", (file, ...args) => {
    const name = String(file)
    if (name.endsWith("/rules/core.md")) return `# Working rules\n${version}\n## Skills and hooks\nRouting\n`
    if (name.endsWith("/opencode/AGENTS.md")) return `OpenCode ${version}`
    if (name.endsWith("/skills/handoff/SKILL.md")) return `---\nname: handoff\n---\nHandoff ${version}`
    return read(file, ...args)
  })

  const initial = readInstructions()
  const initialHandoff = readHandoffPrompt()
  version = "updated"

  assert.match(readInstructions().core, /updated/)
  assert.match(readInstructions().instructions, /updated/)
  assert.notEqual(readInstructions().text, initial.text)
  assert.notEqual(readHandoffPrompt(), initialHandoff)
})
