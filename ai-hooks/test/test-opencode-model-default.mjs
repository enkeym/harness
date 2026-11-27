import assert from "node:assert/strict"
import fs from "node:fs"
import { test } from "node:test"
import { readConfig } from "../../opencode/config.mjs"

test("a fresh OpenCode profile seeds the default Go model with low reasoning", () => {
  const model = readConfig(new URL("../../opencode/opencode.jsonc", import.meta.url)).model
  const state = JSON.parse(fs.readFileSync(new URL("../../opencode/state/model.json", import.meta.url), "utf8"))

  assert.equal(model, "{env:OPENCODE_DEFAULT_MODEL}")
  assert.equal(state.variant["opencode-go/deepseek-v4.1-flash"], "low")
})
