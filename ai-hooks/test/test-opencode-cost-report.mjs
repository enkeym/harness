import "./env-isolate.mjs"
import assert from "node:assert/strict"
import { test } from "node:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { buildCostReport, refreshCostReport, updateAssessment, defaultCostConfig, formatCostReport } from "../../opencode/cost-report.mjs"
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

test("missing usage stays unknown and snapshots are not treated as complete history", () => {
  const data = report([record("ses_partial", [step("unknown", { tokens: null, nativeReportedUSD: null })], { messageCoverage: "active-context" })])

  assert.equal(data.usage.tokens, null)
  assert.equal(data.usage.nativeRequestReportedUSD, null)
  assert.equal(data.coverage.completeHistory, false)
  assert.equal(data.usage.unknownMessages, 1)
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

test("reports and assessments persist privately, reject invalid edits and deduplicate notifications", async t => {
  const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "cost-report-"))
  t.after(() => fs.rm(stateDirectory, { recursive: true, force: true }))
  const base = observationDirectory("/project", stateDirectory)
  await fs.mkdir(path.join(base, "sessions"), { recursive: true })
  const file = path.join(base, "sessions/ses_long.json")
  await fs.writeFile(file, JSON.stringify(record("ses_long", Array.from({ length: 100 }, (_, i) => step(`msg_${i}`)))))
  const options = { stateDirectory, date: "2026-11-02", config: defaultCostConfig }

  const first = await refreshCostReport(options)
  assert.equal(first.newWarnings.length, 1)
  assert.equal((await refreshCostReport(options)).newWarnings.length, 0)
  assert.equal((await fs.stat(first.file)).mode & 0o777, 0o600)
  assert.equal((await fs.stat(path.dirname(first.file))).mode & 0o777, 0o700)
  await updateAssessment("ses_long", { accepted: true, workload: "implementation", comparisonKey: "scope", phase: "after", checksPassed: 1, checksFailed: 0, correctionCount: 0 }, { stateDirectory })
  assert.equal(JSON.parse(await fs.readFile(file)).assessment.accepted, true)
  await assert.rejects(updateAssessment("ses_long", { accepted: "yes" }, { stateDirectory }), /assessment/)
  await assert.rejects(updateAssessment("../escape", {}, { stateDirectory }), /session/)
})
