import assert from "node:assert/strict"
import { test } from "node:test"
import { registerRetrievalRouting } from "../../opencode/retrieval-routing.mjs"

test("retrieval guidance reaches native tools without changing execution or schemas", async () => {
  const execute = async () => ({ content: "original result" })
  const tools = new Map(["read", "grep", "glob", "shell", "skill", "subagent", "execute", "edit"].map(name => [name, { name, description: `Original ${name}`, input: { type: "object" }, execute }]))
  const context = { tool: { transform: async transform => transform({ get: name => tools.get(name), update: (name, update) => update(tools.get(name)) }) } }

  await registerRetrievalRouting(context)

  for (const name of ["read", "grep", "glob", "shell"]) {
    assert.match(tools.get(name).description, /^For indexed project files, search\/read through TokenSave/)
    assert.match(tools.get(name).description, /Without an index, do not load tokensave-routing or call MCP/)
  }
  assert.match(tools.get("shell").description, /never search \/ or the home tree/)
  assert.match(tools.get("shell").description, /never create placeholder\/background shells/)
  assert.match(tools.get("skill").description, /Load only a skill whose described scope this task actually touches/)
  assert.match(tools.get("skill").description, /Load tokensave-routing only when the project root has an index/)
  assert.equal(tools.get("skill").description.includes("before project exploration"), false)
  assert.match(tools.get("skill").description, /returned Base directory/)
  assert.match(tools.get("subagent").description, /^Use only when the user explicitly requests delegation/)
  assert.match(tools.get("execute").description, /tokensave_context \(include_code=false\)/)
  assert.match(tools.get("execute").description, /Pass exactly one input object per call/)
  assert.match(tools.get("execute").description, /`lines` is `"A-B"`/)
  assert.match(tools.get("execute").description, /`tokensave_body` requires `symbol` or `node_id`/)
  assert.match(tools.get("execute").description, /Without an index, do not use it for project retrieval/)
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
