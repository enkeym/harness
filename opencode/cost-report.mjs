import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { readJSON, writePrivateJSON, writePrivateText } from "./local-state.mjs"
import { deepseekCostBreakdownAt } from "./cost-policy.mjs"
import { deepseekModels } from "./model-routing.mjs"

export const defaultCostConfig = Object.freeze({
  timeZone: "Europe/Moscow",
  dailyProviderCNY: 25,
  dailyNativeUSD: 5,
  billingDiscrepancyPercent: 5,
  sessionAssistantMessages: 100,
  repeatedToolCalls: 3,
  consecutiveFailures: 3
})
const counterKeys = ["input", "output", "reasoning", "cacheRead", "cacheWrite"]
const numeric = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
export const costStateRoot = (
  stateDirectory = process.env.XDG_STATE_HOME ||
    path.join(os.homedir(), ".local/state")
) => path.join(stateDirectory, "harness/optimize/opencode")
export const costConfigFile = () =>
  path.join(
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
    "harness/opencode-costs.json"
  )

export function validateCostConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config))
    throw new Error("Invalid cost config")
  for (const key of Object.keys(config))
    if (!(key in defaultCostConfig))
      throw new Error("Unknown cost config option")
  const merged = { ...defaultCostConfig, ...config }
  new Intl.DateTimeFormat("en", { timeZone: merged.timeZone })
  for (const key of Object.keys(defaultCostConfig).filter(
    (key) => key !== "timeZone"
  )) {
    if (merged[key] !== null && (!numeric(merged[key]) || merged[key] <= 0))
      throw new Error("Invalid cost threshold")
  }
  return merged
}

export function localDate(timestamp, timeZone = defaultCostConfig.timeZone) {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(timestamp))
  return ["year", "month", "day"]
    .map((key) => parts.find((part) => part.type === key).value)
    .join("-")
}

function validDate(date) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    !Number.isNaN(Date.parse(date)) &&
    new Date(date).toISOString().slice(0, 10) === date
  )
}

export function validateBilling(value) {
  if (
    !value ||
    !validDate(value.date) ||
    !["CNY", "USD"].includes(value.currency) ||
    !numeric(value.cost)
  )
    throw new Error("Invalid provider billing")
  for (const key of ["apiRequests", "tokens"])
    if (
      value[key] != null &&
      (!Number.isSafeInteger(value[key]) || value[key] < 0)
    )
      throw new Error("Invalid provider billing counter")
  return {
    date: value.date,
    currency: value.currency,
    cost: value.cost,
    apiRequests: value.apiRequests ?? null,
    tokens: value.tokens ?? null,
    accountScope:
      typeof value.accountScope === "string" ? value.accountScope : null,
    timeZone: typeof value.timeZone === "string" ? value.timeZone : null,
    reportedAt: value.reportedAt ?? null,
    source: "user-provided",
    reconciled: false
  }
}

function uniqueSteps(records, date, timeZone) {
  const seen = new Map()
  let conflictingMessages = 0
  let undatedMessages = 0
  for (const record of records)
    for (const step of record.sequence) {
      if (
        step.type !== "assistant" &&
        step.type !== "compaction" &&
        step.usageKind !== "auxiliary"
      )
        continue
      if (!numeric(step.time?.created)) {
        undatedMessages++
        continue
      }
      if (date && localDate(step.time.created, timeZone) !== date) continue
      const key = `${record.project}:${step.id}`
      if (seen.has(key)) {
        const previous = seen.get(key)
        if (
          JSON.stringify([previous.tokens, previous.nativeReportedUSD]) !==
          JSON.stringify([step.tokens, step.nativeReportedUSD])
        )
          conflictingMessages++
      } else seen.set(key, step)
    }
  return { steps: [...seen.values()], conflictingMessages, undatedMessages }
}

function usage(steps, conflicts = 0) {
  const totals = {
    messages: steps.length,
    assistantMessages: 0,
    compactions: 0,
    tokens: Object.fromEntries(counterKeys.map((key) => [key, 0])),
    nativeRequestReportedUSD: 0,
    recomputedUSD: 0,
    recomputedInputUSD: 0,
    recomputedCacheReadUSD: 0,
    recomputedOutputUSD: 0,
    recomputedMessages: 0,
    unpricedMessages: 0,
    recomputedDeltaUSD: null,
    recomputedComplete: false,
    validatedUSD: null,
    unknownMessages: 0,
    zeroCostWithUsage: 0
  }
  for (const step of steps) {
    if (step.type === "assistant") totals.assistantMessages++
    if (step.type === "compaction") totals.compactions++
    const knownTokens =
      step.tokens && counterKeys.every((key) => numeric(step.tokens[key]))
    if (!knownTokens || !numeric(step.nativeReportedUSD))
      totals.unknownMessages++
    if (!knownTokens) totals.tokens = null
    else if (totals.tokens)
      for (const key of counterKeys) totals.tokens[key] += step.tokens[key]
    if (!numeric(step.nativeReportedUSD)) totals.nativeRequestReportedUSD = null
    else if (totals.nativeRequestReportedUSD !== null)
      totals.nativeRequestReportedUSD += step.nativeReportedUSD
    const breakdown =
      knownTokens && numeric(step.time?.created)
        ? deepseekCostBreakdownAt(
            step.model?.id,
            step.tokens,
            step.time.created
          )
        : null
    if (breakdown) {
      totals.recomputedUSD += breakdown.total
      totals.recomputedInputUSD += breakdown.input
      totals.recomputedCacheReadUSD += breakdown.cacheRead
      totals.recomputedOutputUSD += breakdown.output
      totals.recomputedMessages++
    } else totals.unpricedMessages++
    if (
      step.nativeReportedUSD === 0 &&
      knownTokens &&
      Object.values(step.tokens).some((value) => value > 0)
    )
      totals.zeroCostWithUsage++
  }
  if (conflicts) {
    totals.tokens = null
    totals.nativeRequestReportedUSD = null
    totals.recomputedUSD = null
    totals.recomputedInputUSD = null
    totals.recomputedCacheReadUSD = null
    totals.recomputedOutputUSD = null
  }
  totals.recomputedComplete =
    totals.recomputedUSD !== null && totals.unpricedMessages === 0
  totals.recomputedDeltaUSD =
    totals.recomputedUSD !== null &&
    totals.nativeRequestReportedUSD !== null
      ? totals.recomputedUSD - totals.nativeRequestReportedUSD
      : null
  return totals
}

function repeatsFor(record, date, config) {
  const groups = new Map()
  const repeats = []
  let failures = 0
  let longestFailureStreak = 0
  let epoch = 0
  for (const step of record.sequence) {
    if (step.type === "compaction") {
      epoch++
      failures = 0
      continue
    }
    for (const tool of step.tools ?? []) {
      if (tool.status === "error" || tool.status === "failed") failures++
      else failures = 0
      if (
        numeric(step.time?.created) &&
        localDate(step.time.created, config.timeZone) === date
      )
        longestFailureStreak = Math.max(failures, longestFailureStreak)
      if (/^(edit|write|apply_patch)$/.test(tool.name)) {
        epoch++
        continue
      }
      if (
        !tool.inputFingerprint ||
        !tool.outputFingerprint ||
        !numeric(step.time?.created) ||
        localDate(step.time.created, config.timeZone) !== date
      )
        continue
      const key = JSON.stringify([
        epoch,
        tool.name,
        tool.inputFingerprint,
        tool.outputFingerprint,
        tool.status
      ])
      const group = groups.get(key) ?? {
        sessionID: record.sessionID,
        tool: tool.name,
        status: tool.status,
        inputFingerprint: tool.inputFingerprint,
        outputFingerprint: tool.outputFingerprint,
        occurrences: 0,
        verifiedWaste: false
      }
      group.occurrences++
      groups.set(key, group)
    }
  }
  for (const group of groups.values())
    if (group.occurrences >= (config.repeatedToolCalls ?? Infinity))
      repeats.push(group)
  return { repeats, longestFailureStreak }
}

function sessionFamilies(records, date, timeZone) {
  const byID = new Map(records.map((record) => [record.sessionID, record]))
  const edges = new Map(records.map((record) => [record.sessionID, new Set()]))
  for (const record of records) {
    const linked = [
      record.parentID,
      ...(record.delegation?.childIDs ?? []),
      record.handoff?.targetID,
      ...(record.handoff?.targetIDs ?? [])
    ].filter(Boolean)
    for (const id of linked) {
      edges.get(record.sessionID).add(id)
      if (!edges.has(id)) edges.set(id, new Set())
      edges.get(id).add(record.sessionID)
    }
  }
  const visited = new Set()
  const families = []
  for (const id of byID.keys()) {
    if (visited.has(id)) continue
    const pending = [id]
    const ids = []
    while (pending.length) {
      const current = pending.pop()
      if (visited.has(current)) continue
      visited.add(current)
      ids.push(current)
      pending.push(...(edges.get(current) ?? []))
    }
    const members = ids.map((key) => byID.get(key)).filter(Boolean)
    const daily = uniqueSteps(members, date, timeZone)
    if (!daily.steps.length) continue
    const all = uniqueSteps(members, null, timeZone)
    const missingSessionIDs = ids.filter((key) => !byID.has(key)).sort()
    families.push({
      sessionIDs: ids.sort(),
      missingSessionIDs,
      nativeFamilyTotalUSD: null,
      nativeParentInclusion: "unverified",
      observedRequests: usage(all.steps, all.conflictingMessages),
      dailyObservedRequests: usage(daily.steps, daily.conflictingMessages),
      complete:
        !missingSessionIDs.length &&
        !all.conflictingMessages &&
        !all.undatedMessages &&
        members.every(
          (member) =>
            member.messageCoverage === "complete-pages" &&
            member.delegation?.childrenComplete === true
        ),
      nativeSessions: members.map((member) => ({
        sessionID: member.sessionID,
        nativeReportedUSD: member.accounting?.native?.cost ?? null
      }))
    })
  }
  return families
}

function comparisons(records, timeZone) {
  const groups = new Map()
  for (const family of sessionFamilies(records, null, timeZone)) {
    const relatives = records.filter((record) =>
      family.sessionIDs.includes(record.sessionID)
    )
    const assessed = relatives.filter(
      (record) =>
        record.assessment?.comparisonKey &&
        ["before", "after"].includes(record.assessment.phase)
    )
    if (assessed.length !== 1) continue
    const record = {
      ...assessed[0],
      sequence: relatives.flatMap((member) => member.sequence),
      family
    }
    const a = record.assessment
    if (!a?.comparisonKey || !["before", "after"].includes(a.phase)) continue
    const key = JSON.stringify([a.workload, a.comparisonKey])
    const group = groups.get(key) ?? {
      workload: a.workload,
      comparisonKey: a.comparisonKey,
      before: [],
      after: [],
      savingsPercent: null,
      comparability: "user-assigned; not automatically verified"
    }
    group[a.phase].push(record)
    groups.set(key, group)
  }
  return [...groups.values()].map((group) => {
    for (const phase of ["before", "after"]) {
      const members = group[phase]
      const values = members.map((record) => record.family.observedRequests)
      const known =
        members.length > 0 &&
        values.every((value) => value.nativeRequestReportedUSD !== null) &&
        members.every((record) => record.family.complete)
      group[phase] = {
        sessions: members.length,
        accepted: members.filter(
          (record) => record.assessment.accepted === true
        ).length,
        rejected: members.filter(
          (record) => record.assessment.accepted === false
        ).length,
        unknownAcceptance: members.filter(
          (record) => typeof record.assessment.accepted !== "boolean"
        ).length,
        checksPassed: members.map(
          (record) => record.assessment.checksPassed ?? null
        ),
        checksFailed: members.map(
          (record) => record.assessment.checksFailed ?? null
        ),
        corrections: members.map(
          (record) => record.assessment.correctionCount ?? null
        ),
        nativeMeanUSD: known
          ? values.reduce(
              (sum, value) => sum + value.nativeRequestReportedUSD,
              0
            ) / members.length
          : null,
        models: [
          ...new Set(
            members.flatMap((record) =>
              record.sequence
                .map((step) => (step.model ? JSON.stringify(step.model) : null))
                .filter(Boolean)
            )
          )
        ]
      }
    }
    return group
  })
}

export function buildCostReport(
  records,
  { date, config = defaultCostConfig, billing = [] } = {}
) {
  config = validateCostConfig(config)
  date ??= localDate(Date.now(), config.timeZone)
  if (!validDate(date)) throw new Error("Invalid report date")
  const unique = uniqueSteps(records, date, config.timeZone)
  const totals = usage(unique.steps, unique.conflictingMessages)
  const warnings = []
  const repeats = []
  const sessions = []
  const warn = (code, sessionID, observed, limit) =>
    warnings.push({ code, sessionID, observed, limit, date })
  for (const record of records) {
    const daily = uniqueSteps([record], date, config.timeZone)
    if (!daily.steps.length) continue
    const summary = usage(daily.steps, daily.conflictingMessages)
    sessions.push({
      sessionID: record.sessionID,
      project: record.project,
      ...summary,
      messageCoverage: record.messageCoverage,
      accepted: record.assessment?.accepted ?? null,
      nativeOutcome: record.nativeOutcome ?? null,
      handoffCache: {
        summaryHits: record.handoff?.summaryHits ?? 0,
        continuationHits: record.handoff?.continuationHits ?? 0
      }
    })
    const result = repeatsFor(record, date, config)
    repeats.push(...result.repeats)
    const allAssistants = record.sequence.filter(
      (step) => step.type === "assistant"
    ).length
    if (
      config.sessionAssistantMessages &&
      allAssistants >= config.sessionAssistantMessages
    )
      warn(
        "long-session",
        record.sessionID,
        allAssistants,
        config.sessionAssistantMessages
      )
    if (
      config.consecutiveFailures &&
      result.longestFailureStreak >= config.consecutiveFailures
    )
      warn(
        "failure-streak",
        record.sessionID,
        result.longestFailureStreak,
        config.consecutiveFailures
      )
    if (result.repeats.length)
      warn(
        "repeated-tool-result",
        record.sessionID,
        result.repeats.length,
        config.repeatedToolCalls
      )
  }
  const providerBilling = billing
    .map(validateBilling)
    .filter((point) => point.date === date)
  for (const point of providerBilling)
    if (
      point.currency === "CNY" &&
      config.dailyProviderCNY &&
      point.cost >= config.dailyProviderCNY
    )
      warn(
        "provider-budget",
        point.accountScope,
        point.cost,
        config.dailyProviderCNY
      )
  if (
    config.dailyNativeUSD &&
    totals.nativeRequestReportedUSD !== null &&
    totals.nativeRequestReportedUSD >= config.dailyNativeUSD
  )
    warn(
      "native-estimate-budget",
      null,
      totals.nativeRequestReportedUSD,
      config.dailyNativeUSD
    )
  const billedRequests = providerBilling.reduce(
    (sum, point) => (numeric(point.apiRequests) ? sum + point.apiRequests : sum),
    0
  )
  const requestDiscrepancy =
    billedRequests > 0
      ? Math.round(
          (Math.abs(billedRequests - totals.messages) / billedRequests) *
            1000
        ) / 10
      : null
  if (
    requestDiscrepancy !== null &&
    config.billingDiscrepancyPercent &&
    requestDiscrepancy > config.billingDiscrepancyPercent
  )
    warn(
      "billing-discrepancy",
      null,
      requestDiscrepancy,
      config.billingDiscrepancyPercent
    )
  const models = new Map()
  for (const step of unique.steps) {
    const key = JSON.stringify({
      provider: step.model?.providerID ?? null,
      model: step.model?.id ?? null,
      variant: step.model?.variant ?? null,
      agent: step.agent ?? null
    })
    if (!models.has(key)) models.set(key, [])
    models.get(key).push(step)
  }
  const modelRows = [...models].map(([key, steps]) => {
    const row = { ...JSON.parse(key), ...usage(steps) }
    row.proInBuild =
      row.provider === deepseekModels.pro.providerID &&
      row.model === deepseekModels.pro.id &&
      row.agent === "build"
    row.usdPerRequest =
      row.messages && row.recomputedUSD !== null
        ? row.recomputedUSD / row.messages
        : null
    return row
  })
  for (const row of modelRows)
    if (row.proInBuild) warn("pro-in-build", null, row.messages, 0)
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    date,
    timeZone: config.timeZone,
    usage: totals,
    providerBilling,
    coverage: {
      observedSessions: sessions.length,
      completeHistory:
        sessions.every(
          (session) => session.messageCoverage === "complete-pages"
        ) &&
        !unique.conflictingMessages &&
        !unique.undatedMessages,
      conflictingMessages: unique.conflictingMessages,
      undatedMessages: unique.undatedMessages,
      scope: "locally observed sessions; provider account coverage unverified"
    },
    models: modelRows,
    expensiveSessions: sessions
      .sort(
        (a, b) =>
          (b.nativeRequestReportedUSD ?? -1) -
            (a.nativeRequestReportedUSD ?? -1) || b.messages - a.messages
      )
      .slice(0, 10),
    repeats,
    families: sessionFamilies(records, date, config.timeZone),
    comparisons: comparisons(records, config.timeZone),
    warnings
  }
}

async function entries(directory) {
  try {
    return await fs.readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (error.code === "ENOENT") return []
    throw error
  }
}

export async function readCostEvidence({ stateDirectory } = {}) {
  const root = costStateRoot(stateDirectory)
  const records = []
  const billing = []
  const errors = []
  for (const folder of await entries(root)) {
    if (!folder.isDirectory() || !/^[a-f0-9]{16}$/.test(folder.name)) continue
    const base = path.join(root, folder.name)
    for (const file of await entries(path.join(base, "sessions"))) {
      if (!file.isFile() || !/^ses_[a-zA-Z0-9_-]+\.json$/.test(file.name))
        continue
      try {
        const record = await readJSON(path.join(base, "sessions", file.name))
        if (
          record?.schemaVersion !== 1 ||
          record.client !== "opencode" ||
          record.clientVersion !== "2.2.5" ||
          !Array.isArray(record.sequence) ||
          !record.project ||
          `${record.sessionID}.json` !== file.name
        )
          throw new Error("Unsupported record")
        records.push(record)
      } catch {
        errors.push({
          projectKey: folder.name,
          file: file.name,
          kind: "invalid-session-record"
        })
      }
    }
    for (const file of await entries(base))
      if (file.isFile() && /^billing-baseline-.*\.json$/.test(file.name)) {
        try {
          billing.push(
            validateBilling(await readJSON(path.join(base, file.name)))
          )
        } catch {
          errors.push({
            projectKey: folder.name,
            file: file.name,
            kind: "invalid-billing-record"
          })
        }
      }
  }
  for (const file of await entries(path.join(root, "billing")))
    if (file.isFile() && file.name.endsWith(".json")) {
      try {
        billing.push(
          validateBilling(await readJSON(path.join(root, "billing", file.name)))
        )
      } catch {
        errors.push({ file: file.name, kind: "invalid-billing-record" })
      }
    }
  return { records, billing, errors }
}

export async function refreshCostReport(options = {}) {
  const config = validateCostConfig(
    options.config ?? (await readJSON(costConfigFile(), {}))
  )
  const evidence = await readCostEvidence(options)
  const report = buildCostReport(evidence.records, {
    date: options.date,
    config,
    billing: evidence.billing
  })
  report.coverage.readErrors = evidence.errors
  if (evidence.errors.length) report.coverage.completeHistory = false
  const root = costStateRoot(options.stateDirectory)
  await fs.mkdir(root, { recursive: true, mode: 0o700 })
  await fs.chmod(root, 0o700)
  const file = await writePrivateJSON(
    path.join(root, "reports", `${report.date}.json`),
    report
  )
  await writePrivateText(
    path.join(root, "reports", `${report.date}.md`),
    formatCostReport(report)
  )
  const warningsFile = path.join(
    root,
    "reports",
    `${report.date}.warnings.json`
  )
  const emitted = new Set(await readJSON(warningsFile, []))
  const newWarnings = report.warnings.filter(
    (warning) =>
      !emitted.has(
        JSON.stringify([warning.code, warning.sessionID, warning.limit])
      )
  )
  for (const warning of newWarnings)
    emitted.add(
      JSON.stringify([warning.code, warning.sessionID, warning.limit])
    )
  await writePrivateJSON(warningsFile, [...emitted])
  return { report, file, newWarnings }
}

export async function updateAssessment(sessionID, patch, options = {}) {
  if (!/^ses_[a-zA-Z0-9_-]+$/.test(sessionID))
    throw new Error("Invalid session ID")
  const allowed = [
    "accepted",
    "workload",
    "comparisonKey",
    "phase",
    "checksPassed",
    "checksFailed",
    "correctionCount"
  ]
  if (
    !patch ||
    typeof patch !== "object" ||
    Array.isArray(patch) ||
    Object.keys(patch).some((key) => !allowed.includes(key))
  )
    throw new Error("Invalid assessment fields")
  for (const [key, value] of Object.entries(patch)) {
    if (
      key === "accepted"
        ? value !== null && typeof value !== "boolean"
        : ["checksPassed", "checksFailed", "correctionCount"].includes(key)
          ? !Number.isSafeInteger(value) || value < 0
          : key === "phase"
            ? !["before", "after"].includes(value)
            : typeof value !== "string" || !value.trim() || value.length > 200
    )
      throw new Error("Invalid assessment value")
  }
  const { records } = await readCostEvidence(options)
  const matches = records.filter((record) => record.sessionID === sessionID)
  if (matches.length !== 1) throw new Error("Unknown or ambiguous session ID")
  const record = matches[0]
  const { observationDirectory } = await import("./observations.mjs")
  record.assessment = {
    ...record.assessment,
    ...patch,
    updatedAt: new Date().toISOString()
  }
  return writePrivateJSON(
    path.join(
      observationDirectory(record.project, options.stateDirectory),
      "sessions",
      `${sessionID}.json`
    ),
    record
  )
}

export function formatCostReport(report) {
  const value = (number) =>
    number === null
      ? "неизвестно"
      : typeof number === "number"
        ? String(Math.round(number * 1000000) / 1000000)
        : String(number)
  const lines = [
    `OpenCode: ${report.date} (${report.timeZone})`,
    `Наблюдаемых сессий: ${report.coverage.observedSessions}; сообщений с расходом: ${report.usage.messages}; компактаций: ${report.usage.compactions}.`,
    `Нативная оценка по сообщениям: ${value(report.usage.nativeRequestReportedUSD)} USD; подтверждённый расход: неизвестно.`,
    `Пересчёт по тарифу на момент сообщения: ${value(report.usage.recomputedUSD)} USD; без тарифа: ${report.usage.unpricedMessages}; расхождение с нативной оценкой: ${value(report.usage.recomputedDeltaUSD)} USD.`,
    `Пересчёт по компонентам: input ${value(report.usage.recomputedInputUSD)}, cacheRead ${value(report.usage.recomputedCacheReadUSD)}, output ${value(report.usage.recomputedOutputUSD)} USD.`,
    `История: ${report.coverage.completeHistory ? "полные страницы наблюдаемых сессий" : "неполное покрытие"}; покрытие аккаунта провайдера не проверено.`,
    `Токены: ${report.usage.tokens ? counterKeys.map((key) => `${key}=${report.usage.tokens[key]}`).join(", ") : "есть неизвестные счётчики"}.`,
    `Семейства задач: ${report.families.length}; неполных: ${report.families.filter((family) => !family.complete).length}.`,
    ""
  ]
  for (const point of report.providerBilling)
    lines.push(
      `Провайдер (введено вручную): ${point.cost} ${point.currency}; запросов: ${value(point.apiRequests)}; токенов: ${value(point.tokens)}; область: ${point.accountScope ?? "неизвестна"}.`
    )
  const billedRequests = report.providerBilling.reduce(
    (sum, point) => (numeric(point.apiRequests) ? sum + point.apiRequests : sum),
    0
  )
  if (billedRequests && report.usage.messages)
    lines.push(
      `Кабинет против локальных сообщений: запросов ${billedRequests}, локальных ${report.usage.messages}; расхождение ${Math.round((Math.abs(billedRequests - report.usage.messages) / billedRequests) * 1000) / 10}% — локально видны не все запросы аккаунта.`
    )
  lines.push(
    "",
    "Модель / вариант / агент | сообщений | нативная оценка USD | пересчёт USD | USD/сообщение | pro-in-build",
    "--- | ---: | ---: | ---: | ---: | :---:"
  )
  for (const model of report.models)
    lines.push(
      `${model.provider}/${model.model} / ${model.variant ?? "по умолчанию"} / ${model.agent ?? "неизвестен"} | ${model.messages} | ${value(model.nativeRequestReportedUSD)} | ${value(model.recomputedUSD)} | ${value(model.usdPerRequest)} | ${model.proInBuild ? "да" : "нет"}`
    )
  lines.push(
    "",
    "Сессия | сообщений за день | нативная оценка USD | пересчёт USD",
    "--- | ---: | ---: | ---:"
  )
  for (const session of report.expensiveSessions)
    lines.push(
      `${session.sessionID} | ${session.messages} | ${value(session.nativeRequestReportedUSD)} | ${value(session.recomputedUSD)}`
    )
  lines.push(
    "",
    `Кандидатов повторного вывода: ${report.repeats.length}; это не доказательство лишней работы.`,
    `Предупреждений: ${report.warnings.length}.`
  )
  for (const warning of report.warnings)
    lines.push(
      `- ${warning.code}: ${warning.sessionID ?? "день/аккаунт"}, значение=${warning.observed}, порог=${warning.limit}`
    )
  lines.push(
    "",
    `Групп сравнения качества: ${report.comparisons.length}; сопоставимость задаётся вручную, процент экономии не вычисляется.`
  )
  for (const group of report.comparisons)
    for (const phase of ["before", "after"])
      lines.push(
        `- ${group.workload}/${group.comparisonKey}/${phase}: задач=${group[phase].sessions}, принято=${group[phase].accepted}, отклонено=${group[phase].rejected}, приёмка неизвестна=${group[phase].unknownAcceptance}, средняя нативная оценка USD=${value(group[phase].nativeMeanUSD)}.`
      )
  return `${lines.join("\n")}\n`
}
