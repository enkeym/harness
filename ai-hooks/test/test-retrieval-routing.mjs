import assert from "node:assert/strict"
import { test } from "node:test"
import { registerRetrievalRouting } from "../../opencode/retrieval-routing.mjs"

test("retrieval guidance reaches native tools without changing execution or schemas", async () => {
  const execute = async () => ({ content: "original result" })
  const tools = new Map(["read", "grep", "glob", "shell", "skill", "subagent", "execute", "edit"].map(name => [name, { name, description: `Original ${name}`, input: { type: "object" }, execute }]))
  const context = { tool: { transform: async transform => transform({ get: name => tools.get(name), update: (name, update) => update(tools.get(name)) }) } }

  await registerRetrievalRouting(context)

  for (const name of ["read", "grep", "glob", "shell", "execute"]) {
    const { description } = tools.get(name)
    assert.doesNotMatch(description, /call tokensave_status|demonstrated MCP\/coverage limitation/, name)
    assert.match(description, /^For indexed project files, follow the TokenSave\/RAGSave route/)
    assert.ok(description.endsWith(`\n\nOriginal ${name}`))
  }
  assert.match(tools.get("shell").description, /never search \/ or the home tree/)
  assert.match(tools.get("shell").description, /never create placeholder\/background shells/)
  assert.match(tools.get("shell").description, /A known path or an earlier MCP call does not justify local source retrieval/)
  assert.match(tools.get("skill").description, /Load only a skill whose described scope this task actually touches/)
  assert.equal(tools.get("skill").description.includes("before project exploration"), false)
  assert.match(tools.get("skill").description, /returned Base directory/)
  assert.match(tools.get("subagent").description, /^Use only when the user explicitly requests delegation/)
  assert.match(tools.get("execute").description, /Discover MCP schemas with search before calling them/)
  assert.match(tools.get("execute").description, /Narrow paths, ranges and limits before the call; do not slice serialized MCP results/)
  assert.equal(tools.get("edit").description, "Original edit")
  for (const tool of tools.values()) {
    assert.equal(tool.execute, execute)
    assert.deepEqual(tool.input, { type: "object" })
    assert.deepEqual(await tool.execute(), { content: "original result" })
  }
  const before = structuredClone([...tools.values()].map(({ name, description }) => ({ name, description })))
  await registerRetrievalRouting(context)
  assert.deepEqual([...tools.values()].map(({ name, description }) => ({ name, description })), before)
})

test("routing supports clients with only a subset of native tools", async () => {
  await registerRetrievalRouting({ tool: { transform: async transform => transform({ get: () => undefined, update: () => assert.fail("missing tool updated") }) } })
})
