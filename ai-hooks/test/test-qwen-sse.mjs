import assert from "node:assert/strict"
import { test } from "node:test"
import { sanitizeChatStream } from "../../opencode/qwen-oauth/sse.mjs"

const sse = payload => `data: ${JSON.stringify(payload)}\n\n`
const delta = choices => ({ choices })

const stream = async (parts, log = () => {}) => {
  const body = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder()
      for (const part of parts) controller.enqueue(encoder.encode(part))
      controller.close()
    }
  })
  const text = await new Response(sanitizeChatStream(body, log)).text()
  return text
    .split("\n")
    .filter(line => line.startsWith("data: ") && line !== "data: [DONE]")
    .map(line => JSON.parse(line.slice(6)))
}

test("streamed tool calls keep a stable id and name", async () => {
  const chunks = await stream([
    sse(delta([{ delta: { tool_calls: [{ index: 0, id: "call_x", type: "function", function: { name: "read", arguments: "" } }] } }])),
    sse(delta([{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"a"}' } }] } }])),
    sse(delta([{ delta: {}, finish_reason: "tool_calls" }])),
    "data: [DONE]\n\n"
  ])

  assert.equal(chunks.length, 3)
  assert.equal(chunks[0].choices[0].delta.tool_calls[0].id, "call_x")
  assert.equal(chunks[1].choices[0].delta.tool_calls[0].id, "call_x")
  assert.equal(chunks[1].choices[0].delta.tool_calls[0].function.name, "read")
  assert.equal(chunks[1].choices[0].delta.tool_calls[0].function.arguments, '{"path":"a"}')
  assert.equal(chunks[2].choices[0].finish_reason, "tool_calls")
})

test("a tool call without an id gets a synthetic one", async () => {
  const chunks = await stream([
    sse(delta([{ delta: { tool_calls: [{ index: 0, function: { name: "grep", arguments: '{"pattern":"x"}' } }] } }])),
    "data: [DONE]\n\n"
  ])

  assert.equal(chunks[0].choices[0].delta.tool_calls[0].id, "call_qwen_0")
  assert.equal(chunks[0].choices[0].delta.tool_calls[0].type, "function")
})

test("arguments arriving before the header are held back and repaired", async () => {
  const chunks = await stream([
    sse(delta([{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"command"' } }] } }])),
    sse(delta([{ delta: { tool_calls: [{ index: 0, id: "call_y", type: "function", function: { name: "bash", arguments: ':1}' } }] } }])),
    sse(delta([{ delta: {}, finish_reason: "tool_calls" }]))
  ])

  assert.equal(chunks.length, 3)
  assert.equal(chunks[0].choices[0].delta.tool_calls[0].id, "call_y")
  assert.equal(chunks[0].choices[0].delta.tool_calls[0].function.name, "bash")
  assert.equal(chunks[0].choices[0].delta.tool_calls[0].function.arguments, '{"command"')
  assert.equal(chunks[1].choices[0].delta.tool_calls[0].function.arguments, ':1}')
  assert.equal(chunks[2].choices[0].finish_reason, "tool_calls")
})

test("a tool call that never names its function is dropped and logged", async () => {
  const logged = []
  const chunks = await stream(
    [
      sse(delta([{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] } }])),
      sse(delta([{ delta: { tool_calls: [{ index: 0, function: { arguments: '"b"}' } }] } }])),
      "data: [DONE]\n\n"
    ],
    () => logged.push("dropped")
  )

  assert.equal(chunks.length, 0)
  assert.ok(logged.length >= 1)
})

test("text deltas pass through untouched and survive chunk boundaries", async () => {
  const payload = sse(delta([{ delta: { content: "hello" } }])) + sse(delta([{ delta: { content: " world" } }]))
  const chunks = await stream([payload.slice(0, 9), payload.slice(9, 31), payload.slice(31)])

  assert.deepEqual(chunks.map(chunk => chunk.choices[0].delta.content), ["hello", " world"])
})
