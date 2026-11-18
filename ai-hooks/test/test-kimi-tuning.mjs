import assert from "node:assert/strict"
import { test } from "node:test"
import { KIMI_PROVIDER_ID, kimiCaps, tuneKimiModel } from "../../opencode/kimi-tuning/tuning.mjs"

const kimiModel = () => ({
  limit: { context: 256_000, output: 65_536 },
  settings: { body: { thinking: { type: "enabled" } } },
  variants: [
    { id: "off", body: { thinking: { type: "disabled" } } },
    { id: "auto", body: {} },
    { id: "low", body: { thinking: { type: "enabled" }, reasoning_effort: "low" } },
    { id: "max", body: { thinking: { type: "enabled" }, reasoning_effort: "max" } }
  ]
})

test("the kimi provider id matches the auth plugin", () => {
  assert.equal(KIMI_PROVIDER_ID, "kimi-for-coding-oauth")
})

test("caps default to the working output ceiling and ignore malformed environment", () => {
  assert.deepEqual(kimiCaps({}), { cap: 8192, inputCap: undefined })
  assert.deepEqual(kimiCaps({ KIMI_OUTPUT_CAP: "4096" }), { cap: 4096, inputCap: undefined })
  assert.deepEqual(kimiCaps({ KIMI_OUTPUT_CAP: "0", KIMI_INPUT_CAP: "-5" }), { cap: 8192, inputCap: undefined })
  assert.deepEqual(kimiCaps({ KIMI_INPUT_CAP: "100000" }), { cap: 8192, inputCap: 100000 })
})

test("the server output limit wins when it is smaller than the cap", () => {
  const model = tuneKimiModel({ ...kimiModel(), limit: { context: 256_000, output: 4096 } }, kimiCaps({}))

  assert.equal(model.limit.output, 4096)
  assert.equal(model.settings.body.max_tokens, 4096)
  assert.equal(model.variants[2].body.max_tokens, 4096)
})

test("effort tiers keep their bodies and only gain the output ceiling", () => {
  const model = tuneKimiModel(kimiModel(), kimiCaps({}))

  assert.deepEqual(
    model.variants.map(variant => variant.id),
    ["off", "auto", "low", "max"]
  )
  assert.deepEqual(model.variants[0].body, { thinking: { type: "disabled" }, max_tokens: 8192 })
  assert.deepEqual(model.variants[2].body, { thinking: { type: "enabled" }, reasoning_effort: "low", max_tokens: 8192 })
  assert.deepEqual(model.variants[3].body, { thinking: { type: "enabled" }, reasoning_effort: "max", max_tokens: 8192 })
})

test("the input limit stays untouched unless it is configured", () => {
  const model = tuneKimiModel(kimiModel(), kimiCaps({}))
  assert.equal(model.limit.input, undefined)

  const capped = tuneKimiModel(kimiModel(), kimiCaps({ KIMI_INPUT_CAP: "150000" }))
  assert.equal(capped.limit.input, 150_000)

  const narrow = tuneKimiModel(
    { ...kimiModel(), limit: { context: 32_000, output: 65_536 } },
    kimiCaps({ KIMI_INPUT_CAP: "150000" })
  )
  assert.equal(narrow.limit.input, 32_000 - 8192)

  const declared = tuneKimiModel(
    { ...kimiModel(), limit: { context: 256_000, input: 120_000, output: 65_536 } },
    kimiCaps({ KIMI_INPUT_CAP: "150000" })
  )
  assert.equal(declared.limit.input, 120_000)
})

test("a model without limits or variants is still capped safely", () => {
  const model = tuneKimiModel({}, kimiCaps({}))

  assert.equal(model.limit.output, 8192)
  assert.deepEqual(model.settings.body, { max_tokens: 8192 })
  assert.deepEqual(model.variants, [])
})

test("tuning never invents pricing or prompt cache keys", () => {
  const model = tuneKimiModel(kimiModel(), kimiCaps({ KIMI_INPUT_CAP: "150000" }))
  const bodies = [model.settings.body, ...model.variants.map(variant => variant.body)]

  assert.equal(model.cost, undefined)
  for (const body of bodies) assert.equal("prompt_cache_key" in body, false)
})
