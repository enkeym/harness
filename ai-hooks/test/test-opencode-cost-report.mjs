import "./env-isolate.mjs"
import assert from "node:assert/strict"
import { test } from "node:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { buildCostReport, refreshCostReport, updateAssessment, defaultCostConfig, formatCostReport, readCostEvidence } from "../../opencode/cost-report.mjs"
import { observationDirectory } from "../../opencode/observations.mjs"

const stamp = Date.parse("2026-11-02T12:00:00Z")
const tokens = { input: 10, output: 2, reasoning: 1, cacheRead: 5, cacheWrite: 0 }
const step = (id, extra = {}) => ({ id, type: "assistant", time: { created: stamp }, tokens, nativeReportedUSD: 0.1, model: { providerID: "deepseek", id: "flash", variant: "high" }, tools: [], ...extra })
const record = (id, sequence, extra = {}) => ({ schemaVersion: 1, client: "opencode", clientVersion: "2.2.5", project: "/project", sessionID: id, messageCoverage: "complete-pages", sequence, accounting: { native: { cost: 9, tokens } }, delegation: { childIDs: [], childrenComplete: true }, assessment: {}, ...extra })
const report = (records, extra = {}) => buildCostReport(records, { date: "2026-11-02", config: defaultCostConfig, ...extra })

test("daily report attributes messages by timezone and never sums native parent totals", () => {
  const data = report([
    record("ses_parent", [step("shared"), step("prior", { time: { created: Date.parse("2026-11-01T20:59:00Z") } })], { delegation: { childIDs: ["ses_child"], childrenComplete: true } }),
    record("ses_child", [step("shared"), step("unique")], { parentID: "ses_parent", handoff: { targetID: "ses_missing" } })
  ])

  assert.equal(data.usage.messages, 2)
  assert.equal(data.usage.tokens.input, 20)
  assert.equal(data.usage.nativeRequestReportedUSD, 0.2)
  assert.equal(data.usage.validatedUSD, null)
  assert.equal(data.families.length, 1)
  assert.equal(data.families[0].nativeFamilyTotalUSD, null)
  assert.deepEqual(data.families[0].missingSessionIDs, ["ses_missing"])
  assert.equal(data.families[0].complete, false)
})

test("recomputed cost follows message time and separates input, cache and output", () => {
  const peak = step("peak", { time: { created: Date.parse("2026-11-02T02:00:00Z") }, model: { providerID: "deepseek", id: "deepseek-flash", variant: "high" } })
  const off = step("off", { time: { created: Date.parse("2026-11-02T12:00:00Z") }, model: { providerID: "deepseek", id: "deepseek-flash", variant: "high" } })
  const data = report([record("ses_priced", [peak, off])])

  assert.equal(data.usage.recomputedMessages, 2)
  assert.equal(data.usage.unpricedMessages, 0)
  assert.equal(data.usage.recomputedComplete, true)
  assert.ok(Math.abs(data.usage.recomputedUSD - 0.000009945) < 1e-15)
  assert.ok(Math.abs(data.usage.recomputedInputUSD - 0.0000045) < 1e-15)
  assert.ok(Math.abs(data.usage.recomputedCacheReadUSD - 0.000000045) < 1e-15)
  assert.ok(Math.abs(data.usage.recomputedOutputUSD - 0.0000054) < 1e-15)
  assert.ok(Math.abs(data.usage.recomputedDeltaUSD + 0.199990055) < 1e-12)
  assert.match(formatCostReport(data), /Пересчёт по тарифу/)
})

test("report prices a message by model and agent and shows the cabinet request gap", () => {
  const priced = step("priced", { agent: "build", model: { providerID: "deepseek", id: "deepseek-flash", variant: "high" }, time: { created: Date.parse("2026-11-02T12:00:00Z") } })
  const data = report([record("ses_model", [priced])], { billing: [{ date: "2026-11-02", currency: "CNY", cost: 26, apiRequests: 4, tokens: 100, source: "user-provided", accountScope: null }] })
  const text = formatCostReport(data)

  assert.match(text, /USD\/сообщение/)
  assert.match(text, /deepseek\/deepseek-flash \/ high \/ build \| 1 \| 0\.1 \| 0\.000003 \| 0\.000003/)
  assert.match(text, /Кабинет против локальных сообщений: запросов 4, локальных 1; расхождение 75%/)
})

test("flags Pro in build and cabinet request discrepancy", () => {
  const data = report([
    record("ses_pro", [step("pro", { agent: "build", model: { providerID: "deepseek", id: "deepseek-v4-pro", variant: "high" } })])
  ], { billing: [{ date: "2026-11-02", currency: "CNY", cost: 26, apiRequests: 10, tokens: 100, source: "user-provided", accountScope: null }] })

  assert.equal(data.models[0].proInBuild, true)
  assert.ok(data.warnings.some(w => w.code === "pro-in-build"))
  assert.ok(data.warnings.some(w => w.code === "billing-discrepancy" && w.observed === 90 && w.limit === 5))
  assert.match(formatCostReport(data), /pro-in-build/)
})

test("missing usage stays unknown and snapshots are not treated as complete history", () => {
  const data = report([record("ses_partial", [step("unknown", { tokens: null, nativeReportedUSD: null })], { messageCoverage: "active-context" })])

  assert.equal(data.usage.tokens, null)
  assert.equal(data.usage.nativeRequestReportedUSD, null)
  assert.equal(data.coverage.completeHistory, false)
  assert.equal(data.usage.unknownMessages, 1)
})

test("cache hit rate states incomplete native counter coverage", () => {
  const data = report([record("ses_partial_cache", [step("known"), step("unknown", { tokens: null, nativeReportedUSD: null })])])

  assert.ok(Math.abs(data.usage.cacheHitRate - 1 / 3) < 1e-12)
  assert.equal(data.usage.cacheCoverage, 0.5)
  assert.equal(data.usage.cacheComplete, false)
  assert.equal(data.usage.cacheUnknownSteps, 1)
  assert.ok(data.warnings.some(w => w.code === "cache-telemetry-incomplete"))
  assert.match(formatCostReport(data), /покрытие 50% \(неполное\)/)
  assert.match(formatCostReport(data), /Шаги без usage \(прерванные или неуспешные\)/)
})

test("quality comparisons include worker and handoff requests once per task", () => {
  const assessment = { workload: "implementation", comparisonKey: "scope", phase: "after", accepted: true }
  const data = report([
    record("ses_root", [step("root")], { assessment, delegation: { childIDs: ["ses_worker"], childrenComplete: true }, handoff: { targetID: "ses_next" } }),
    record("ses_worker", [step("worker")], { parentID: "ses_root" }),
    record("ses_next", [step("next")])
  ])

  assert.equal(data.comparisons[0].after.sessions, 1)
  assert.ok(Math.abs(data.comparisons[0].after.nativeMeanUSD - 0.3) < 1e-10)
})

test("repeat candidates require matching fingerprints and reset after compaction", () => {
  const tool = { name: "execute", status: "completed", inputFingerprint: "input", outputFingerprint: "output" }
  const sequence = [step("a", { tools: [tool, tool, tool] }), { id: "compact", type: "compaction", time: { created: stamp }, tokens, nativeReportedUSD: 0.1 }, step("b", { tools: [tool] })]
  const data = report([record("ses_repeat", sequence)])

  assert.equal(data.repeats.length, 1)
  assert.equal(data.repeats[0].occurrences, 3)
  assert.equal(data.repeats[0].verifiedWaste, false)
  assert.ok(data.warnings.some(w => w.code === "repeated-tool-result"))
})

test("repeat candidates match identical inputs even when the output differs", () => {
  const first = { name: "read", status: "completed", inputFingerprint: "same", outputFingerprint: "one" }
  const second = { name: "read", status: "completed", inputFingerprint: "same", outputFingerprint: "two" }
  const data = report([record("ses_repeat_output", [step("a", { tools: [first] }), step("b", { tools: [second] })])])

  assert.equal(data.repeats.length, 1)
  assert.equal(data.repeats[0].occurrences, 2)
})

test("large tool outputs are measured separately", () => {
  const small = { name: "read", outputBytes: 8 * 1024 - 1 }
  const large = { name: "read", outputBytes: 8 * 1024 }
  const data = report([record("ses_large", [step("a", { tools: [small, large] })])])

  assert.equal(data.usage.toolOutputBytes, 16383)
  assert.equal(data.usage.largeToolOutputs, 1)
  assert.equal(data.usage.largeToolOutputBytes, 8192)
  assert.ok(Math.abs(data.usage.largeToolOutputShare - 8192 / 16383) < 1e-12)
  assert.match(formatCostReport(data), />8 KB: 8192 байт в 1 вызовах/)
})

test("cache, compaction and tool-output controls warn only from complete measurements", () => {
  const compact = (id) => ({ id, type: "compaction", time: { created: stamp }, tokens, nativeReportedUSD: 0.1, tools: [] })
  const data = report([record("ses_controls", [step("assistant", { tokens: { ...tokens, input: 10, cacheRead: 0 }, tools: [{ name: "read", outputBytes: 20 * 1024 }] }), compact("compact_one"), compact("compact_two")])])

  assert.equal(data.usage.cacheByRequestType.assistant.complete, true)
  assert.equal(data.usage.cacheByRequestType.compaction.knownSteps, 2)
  assert.ok(data.warnings.some(w => w.code === "assistant-cache-hit-rate"))
  assert.ok(data.warnings.some(w => w.code === "compaction-input-share"))
  assert.ok(data.warnings.some(w => w.code === "large-tool-output-share"))
  assert.ok(data.warnings.some(w => w.code === "session-compactions"))
  assert.match(formatCostReport(data), /Кэш по типам: assistant=0%/)
})

test("provider budgets stay separate from native USD and quality cohorts retain unknown acceptance", () => {
  const before = { workload: "implementation", comparisonKey: "same-scope", phase: "before", accepted: true, checksPassed: 2, checksFailed: 0, correctionCount: 0 }
  const data = report([
    record("ses_before", [step("a")], { assessment: before }),
    record("ses_after", [step("b")], { assessment: { ...before, phase: "after", accepted: null } })
  ], { billing: [{ date: "2026-11-02", currency: "CNY", cost: 26, apiRequests: 1383, tokens: 79889099, source: "user-provided", accountScope: null }] })

  assert.equal(data.providerBilling[0].cost, 26)
  assert.equal(data.usage.nativeRequestReportedUSD, 0.2)
  assert.ok(data.warnings.some(w => w.code === "provider-budget"))
  assert.equal(data.comparisons[0].before.accepted, 1)
  assert.equal(data.comparisons[0].after.unknownAcceptance, 1)
  assert.equal(data.comparisons[0].savingsPercent, null)
})

test("pricing aggregates expose required usage fields per window and request type", () => {
  const withRequest = (id, extra = {}) => step(id, {
    request: {
      requestType: "assistant",
      pricingWindow: "offPeak",
      pricingWindowClockAgrees: true
    },
    tools: [{ name: "read", outputBytes: 100 }, { name: "grep", outputBytes: 50 }],
    time: { created: stamp, completed: stamp + 250 },
    ...extra
  })
  const data = report([
    record("ses_aggregates", [
      withRequest("a"),
      withRequest("b", { request: { requestType: "assistant", pricingWindow: "peak", pricingWindowClockAgrees: false } })
    ])
  ])

  assert.equal(data.usage.cacheMissTokens, 20)
  assert.ok(Math.abs(data.usage.cacheHitRate - 1 / 3) < 1e-12)
  assert.equal(data.usage.cacheHitSteps, 2)
  assert.equal(data.usage.cacheCoverage, 1)
  assert.equal(data.usage.cacheComplete, true)
  assert.equal(data.usage.cacheUnknownSteps, 0)
  assert.equal(data.usage.compactionInputTokens, 0)
  assert.equal(data.usage.compactionInputShare, 0)
  assert.equal(data.usage.toolOutputBytes, 300)
  assert.equal(data.usage.largeToolOutputs, 0)
  assert.equal(data.usage.largeToolOutputBytes, 0)
  assert.equal(data.usage.largeToolOutputShare, 0)
  assert.equal(data.usage.toolCalls, 4)
  assert.equal(data.usage.durationMs, 500)
  assert.deepEqual(data.usage.requestTypes, { assistant: 2 })
  assert.deepEqual(data.usage.pricingWindows, { offPeak: 1, peak: 1 })
  assert.equal(data.usage.pricingWindowMismatches, 1)
  assert.ok(data.warnings.some((warning) => warning.code === "pricing-window-mismatch"))
  assert.match(formatCostReport(data), /Типы запросов: assistant=2/)
  assert.match(formatCostReport(data), /тарифные окна: offPeak=1, peak=1/)
  assert.match(formatCostReport(data), /Кэш: наблюдаемое попадание 33\.3%/)
  assert.match(formatCostReport(data), /вывод инструментов: 300 байт/)
})

test("evidence accepts schema 2 records from validated 2.2 and 2.3 releases and rejects other versions", async t => {
  const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "cost-report-version-"))
  t.after(() => fs.rm(stateDirectory, { recursive: true, force: true }))
  const base = observationDirectory("/project", stateDirectory)
  await fs.mkdir(path.join(base, "sessions"), { recursive: true })
  const write = (name, value) =>
    fs.writeFile(path.join(base, "sessions", name), JSON.stringify(value))

  await write("ses_v2.json", record("ses_v2", [step("v2")], { schemaVersion: 2, clientVersion: "2.2.6" }))
  await write("ses_v3.json", record("ses_v3", [step("v3")], { schemaVersion: 2, clientVersion: "2.3.0" }))
  await write("ses_future.json", record("ses_future", [step("future")], { schemaVersion: 3, clientVersion: "2.2.6" }))

  const { records, errors } = await readCostEvidence({ stateDirectory })

  assert.deepEqual(records.map((entry) => entry.sessionID), ["ses_v2", "ses_v3"])
  assert.deepEqual(errors.map((entry) => entry.file).sort(), ["ses_future.json"])
})

test("reports and assessments persist privately, reject invalid edits and deduplicate notifications", async t => {
  const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "cost-report-"))
  t.after(() => fs.rm(stateDirectory, { recursive: true, force: true }))
  const base = observationDirectory("/project", stateDirectory)
  await fs.mkdir(path.join(base, "sessions"), { recursive: true })
  const file = path.join(base, "sessions/ses_long.json")
  await fs.writeFile(file, JSON.stringify(record("ses_long", Array.from({ length: 100 }, (_, i) => step(`msg_${i}`)))))
  const options = { stateDirectory, date: "2026-11-02", config: { ...defaultCostConfig, sessionCompactions: null, minimumAssistantCacheHitRate: null, maximumCompactionInputShare: null, maximumLargeToolOutputShare: null } }

  const first = await refreshCostReport(options)
  assert.equal(first.newWarnings.length, 2)
  assert.equal((await refreshCostReport(options)).newWarnings.length, 0)
  assert.equal((await fs.stat(first.file)).mode & 0o777, 0o600)
  assert.equal((await fs.stat(path.dirname(first.file))).mode & 0o777, 0o700)
  await updateAssessment("ses_long", { accepted: true, workload: "implementation", comparisonKey: "scope", phase: "after", checksPassed: 1, checksFailed: 0, correctionCount: 0 }, { stateDirectory })
  assert.equal(JSON.parse(await fs.readFile(file)).assessment.accepted, true)
  await assert.rejects(updateAssessment("ses_long", { accepted: "yes" }, { stateDirectory }), /assessment/)
  await assert.rejects(updateAssessment("../escape", {}, { stateDirectory }), /session/)
})
