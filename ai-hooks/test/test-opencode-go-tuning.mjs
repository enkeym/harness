import assert from "node:assert/strict"
import { test } from "node:test"
import {
  OPENCODE_GO_PROVIDER_ID,
  opencodeGoCaps,
  tuneOpencodeGoModel
} from "../../opencode/opencode-go-tuning/tuning.mjs"

const goModel = () => ({
  limit: { context: 1_048_576, input: 983_010, output: 65_536 },
  settings: { baseURL: "https://opencode.ai/inference/go/openai/v1" },
  cost: [{ input: 0.834, output: 2.501 }],
  variants: [{ id: "low", settings: { reasoningEffort: "low" } }]
})

test("the opencode-go provider id matches the registry", () => {
  assert.equal(OPENCODE_GO_PROVIDER_ID, "opencode-go")
})

test("caps default to the harness token policy and ignore malformed environment", () => {
  assert.deepEqual(opencodeGoCaps({}), { cap: 8192, inputCap: 120_000 })
  assert.deepEqual(opencodeGoCaps({ OPENCODE_GO_OUTPUT_CAP: "4096", OPENCODE_GO_INPUT_CAP: "90000" }), {
    cap: 4096,
    inputCap: 90_000
  })
  assert.deepEqual(opencodeGoCaps({ OPENCODE_GO_OUTPUT_CAP: "0", OPENCODE_GO_INPUT_CAP: "-5" }), {
    cap: 8192,
    inputCap: 120_000
  })
})

test("large provider limits are capped to the token policy", () => {
  const model = tuneOpencodeGoModel(goModel(), opencodeGoCaps({}))

  assert.deepEqual(model.limit, {
    context: 1_048_576,
    input: 120_000,
    output: 8192
  })
})

test("a smaller declared input or output limit wins", () => {
  const model = tuneOpencodeGoModel(
    { ...goModel(), limit: { context: 1_048_576, input: 64_000, output: 4096 } },
    opencodeGoCaps({})
  )

  assert.equal(model.limit.input, 64_000)
  assert.equal(model.limit.output, 4096)
})

test("the input cap never exceeds the context left after the output", () => {
  const model = tuneOpencodeGoModel(
    { ...goModel(), limit: { context: 80_000, output: 65_536 } },
    opencodeGoCaps({})
  )

  assert.equal(model.limit.output, 8192)
  assert.equal(model.limit.input, 80_000 - 8192)
})

test("a model without limits is still capped safely", () => {
  const model = tuneOpencodeGoModel({}, opencodeGoCaps({}))

  assert.equal(model.limit.output, 8192)
  assert.equal(model.limit.input, 120_000)
})

test("tuning keeps pricing, settings and variants untouched", () => {
  const source = goModel()
  const model = tuneOpencodeGoModel(source, opencodeGoCaps({}))

  assert.deepEqual(model.cost, source.cost)
  assert.deepEqual(model.settings, source.settings)
  assert.deepEqual(model.variants, source.variants)
})
