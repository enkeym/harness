import "./env-isolate.mjs"
import assert from "node:assert/strict"
import { test } from "node:test"
import plugin from "../../opencode/tui.js"

const context = (messages, notifications) => {
  let layer
  const value = {
    client: { rpc: () => ({ events: { on: () => () => {} } }) },
    keymap: { layer: (factory) => { layer = factory() } },
    data: { session: { message: { list: () => messages } } },
    ui: {
      toast: { show: (input) => notifications.push(input) },
      router: { current: () => ({ type: "session", sessionID: "ses_test" }), navigate: () => {} }
    }
  }
  return { value, command: () => layer.commands.find((item) => item.slash?.name === "cost") }
}

test("/cost recomputes the open session from message time and tariffs", async () => {
  const notifications = []
  const messages = [
    {
      role: "assistant",
      modelID: "deepseek-flash",
      time: { created: Date.parse("2026-11-02T12:00:00Z") },
      tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 5 } },
      cost: 0.1
    }
  ]
  const f = context(messages, notifications)
  await plugin.setup(f.value)
  await f.command().run()

  assert.equal(notifications.length, 1)
  assert.match(notifications[0].message, /Всего \$0\.000003/)
  assert.match(notifications[0].message, /cacheRead \$0\.000000/)
  assert.match(notifications[0].message, /панель \$0\.100000/)
  assert.match(notifications[0].message, /без тарифа: 0/)
  assert.equal(notifications[0].variant, "info")
})

test("/cost reports messages without a known tariff instead of a zero total", async () => {
  const notifications = []
  const f = context(
    [{ role: "assistant", modelID: "qwen", time: { created: Date.now() }, tokens: { input: 1, output: 1, cache: { read: 0 } } }],
    notifications
  )
  await plugin.setup(f.value)
  await f.command().run()

  assert.match(notifications[0].message, /Нет сообщений с известным тарифом/)
  assert.match(notifications[0].message, /без тарифа: 1/)
  assert.equal(notifications[0].variant, "warning")
})
