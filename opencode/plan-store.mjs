import fs from "node:fs/promises"
import { readFileSync, statSync } from "node:fs"
import path from "node:path"
import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { cachePolicy } from "./cache-policy.mjs"
import { hash } from "../ai-hooks/bin/context-state.mjs"
import {
  parseMachineCheck,
  parseMachineCheckDeclaration,
  testInputFingerprint,
  testReceiptKey
} from "./test-receipts.mjs"
import {
  ensureProjectIgnore,
  inside,
  sessionExists,
  writePrivateText
} from "./local-state.mjs"

export const planKey = (sessionID) => `plan:${sessionID}`
export const planIndexKey = (id) => `plan-index:${id}`
export const steeringKey = (sessionID) => `plan-steering:${sessionID}`
export async function recordSteering(context, sessionID, text = "") {
  await context.storage.set(steeringKey(sessionID), { at: Date.now(), text })
}
export const checkpointHeading = "## Checkpoint"
export const remainingHeading = "## Оставшиеся шаги"
export const acceptanceHeading = "## Acceptance criteria"
const objectiveHeading = "## Objective"
const acceptanceRow = /^- ([a-z0-9][a-z0-9.-]*) \[(closed|defect|not checked)\] (.+)$/i
const baselineMarker = /^baseline:\s*changed$/i
const checkField = /^check:\s+(test|source)\s+(.+)$/i
const inputsField = /^inputs:\s*(.+)$/i
const evidenceField = /^(test|source):\s*(.+)$/i
const testAnchorPattern =
  /(?:node\s+--test|npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|yarn\s+test|pytest|cargo\s+test|go\s+test|[\w./-]+\.(?:test|spec)\.[cm]?[jt]sx?)/i
const scenarioPattern =
  /(?:-t\s+|--test-name-pattern\s+|::|"[^"]+"|'[^']+')/i
const successPattern = /\b(?:passed|ok|green)\b|(?:^|\s)exit\s*0\b/i
const failurePattern =
  /\b(?:[1-9]\d*\s+failed|failed|failure|not ok|red)\b|\b0\s+passed\b|(?:^|\s)exit\s*[1-9]\d*\b/i
const zeroTestPattern = /\b0\s+tests?\b/i
const sourceAnchorPattern =
  /^((?:\.{0,2}\/)?[\w@./-]+\.[a-z0-9]+)(?::([^\s]+)|#L(\d+)(?:-L?(\d+))?)$/i
const numericRange = /^(\d+)(?:-L?(\d+))?$/

const normalize = (text) => text.trim().replace(/\s+/g, " ").toLowerCase()
const normalizeAnchor = (text) => text.trim()
const checkKey = (check) =>
  check
    ? `${check.kind}:${normalizeAnchor(check.anchor)}:${(check.inputs ?? []).join(",")}`
    : ""
const criterionHash = (row) =>
  hash(
    JSON.stringify({
      criterion: normalize(row.criterion ?? ""),
      check: checkKey(row.check),
      revision: Number(row.revision ?? 0)
    })
  )

const splitEvidence = (text) => {
  const parts = text.split(/\s*=>\s*/)
  return parts.length > 1
    ? { anchor: parts[0].trim(), result: parts.slice(1).join(" => ").trim() }
    : { anchor: text.trim(), result: "" }
}

const changeDirective =
  /(?<![\p{L}\p{N}_])(?:change|update|replace|set|rewrite|make|use|измени|изменить|замени|заменить|смени|сменить|обнови|обновить|перепиши|переписать|установи|установить|исправь|исправить|поменяй|поменять)(?![\p{L}\p{N}_])/iu
const changeProhibition =
  /(?:^|[\s,;:—–-])(?:не|not|never|don't|do not|no)\s+(?:\S+\s+){0,4}(?:change|update|replace|set|rewrite|make|use|измен|замен|смен|обнов|перепис|установ|исправ|меня)/i

const escapeID = (value) =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const directiveFiller =
  /^(?:[\s:,"'«»“”()\[\]—–-]|(?:the|a|an|criterion|row|item|пункт|критерий|строк[а-яё]*)(?![\p{L}\p{N}_]))*$/iu
const quotedRange = /«[^»]*»|“[^”]*”|"[^"]*"|`[^`]*`|'[^']*'/g
const insideQuote = (text, index) => {
  for (const match of text.matchAll(quotedRange))
    if (index > match.index && index < match.index + match[0].length)
      return true
  return false
}

const authorizesChange = (text, id, criterion, ids = [id]) => {
  const known = [...new Set(ids.map(String))]
  if (!known.length) return false
  const idPattern = new RegExp(
    `(?<![\\w.-])(?:${known
      .sort((left, right) => right.length - left.length)
      .map(escapeID)
      .join("|")})(?![\\w.-])`,
    "gi"
  )
  let index = text.indexOf(criterion)
  while (index !== -1) {
    const before = text.slice(Math.max(0, index - 400), index)
    const boundary = Math.max(
      before.lastIndexOf(". "),
      before.lastIndexOf("! "),
      before.lastIndexOf("? "),
      before.lastIndexOf("; "),
      before.lastIndexOf("\n")
    )
    const start = Math.max(0, index - 400) + boundary + 1
    const rest = text.slice(index + criterion.length)
    const ends = [". ", "! ", "? ", "; ", "\n"]
      .map((separator) => rest.indexOf(separator))
      .filter((offset) => offset !== -1)
    const end = ends.length ? index + criterion.length + Math.min(...ends) : text.length
    const clause = text.slice(start, end)
    const directives = [
      ...clause.matchAll(new RegExp(changeDirective.source, "giu"))
    ].map((match) => ({
      index: match.index,
      end: match.index + match[0].length
    }))
    for (let position = 0; position < directives.length; position++) {
      const directive = directives[position]
      const segmentStart =
        position === 0 ? 0 : directives[position - 1].end
      const segmentEnd =
        position + 1 < directives.length
          ? directives[position + 1].index
          : clause.length
      if (index < start + directive.end || index >= start + segmentEnd)
        continue
      if (insideQuote(text, start + directive.index)) continue
      const segment = clause.slice(segmentStart, segmentEnd)
      if (changeProhibition.test(segment)) continue
      const localEnd = directive.end - segmentStart
      const matches = [...segment.matchAll(idPattern)].map((match) => ({
        index: match.index,
        end: match.index + match[0].length,
        id: match[0]
      }))
      const next = matches.find((match) => match.index >= localEnd)
      let target = null
      if (next && directiveFiller.test(segment.slice(localEnd, next.index)))
        target = next
      if (!target) {
        const previous = matches
          .filter((match) => match.end <= directive.index - segmentStart)
          .at(-1)
        if (
          previous &&
          directiveFiller.test(
            segment.slice(previous.end, directive.index - segmentStart)
          )
        )
          target = previous
      }
      if (!target) continue
      if (target.id.toLowerCase() !== String(id).toLowerCase()) continue
      const criterionIndex = index - start - segmentStart
      const between = matches.some(
        (match) =>
          match.index > target.end && match.index < criterionIndex
      )
      if (!between) return true
    }
    index = text.indexOf(criterion, index + criterion.length)
  }
  return false
}

const evidenceKey = (evidence) =>
  evidence
    ? `${evidence.kind}:${normalizeAnchor(evidence.anchor)}:${normalize(evidence.result ?? "")}`
    : null

const parseAcceptanceDetail = (detail) => {
  const parts = detail.split(" | ")
  const criterion = parts.shift().trim()
  let changed = false
  let check = null
  let inputs = []
  let evidence = null
  for (const part of parts) {
    const text = part.trim()
    if (baselineMarker.test(text)) {
      changed = true
      continue
    }
    const declared = checkField.exec(text)
    if (declared) {
      check = { kind: declared[1].toLowerCase(), anchor: declared[2].trim() }
      continue
    }
    const declaredInputs = inputsField.exec(text)
    if (declaredInputs) {
      inputs = declaredInputs[1]
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
      continue
    }
    const parsed = evidenceField.exec(text)
    if (parsed) {
      evidence = {
        kind: parsed[1].toLowerCase(),
        ...splitEvidence(parsed[2]),
        raw: text
      }
    }
  }
  if (check && inputs.length) check.inputs = inputs
  return { criterion, changed, check, evidence }
}

const validateTestEvidence = ({ anchor, result }) => {
  const outcome = result.replace(/\b0\s+failed\b/gi, "")
  return (
    testAnchorPattern.test(anchor) &&
    scenarioPattern.test(anchor) &&
    successPattern.test(outcome) &&
    !failurePattern.test(outcome) &&
    !zeroTestPattern.test(outcome)
  )
}

const validateTestCheck = (anchor) =>
  testAnchorPattern.test(anchor) && scenarioPattern.test(anchor)

const sourceAnchorText = (anchor, root) => {
  const match = sourceAnchorPattern.exec(anchor)
  if (!match) return null
  const file = path.resolve(root, match[1])
  if (!inside(root, file)) return null
  try {
    if (!statSync(file).isFile()) return null
    const text = readFileSync(file, "utf8")
    const count = text.length
      ? text.split(/\r?\n/).length - (/(?:\r?\n)$/.test(text) ? 1 : 0)
      : 0
    const start = match[3] ? Number(match[3]) : null
    const end = match[4] ? Number(match[4]) : start
    if (start !== null)
      return Number.isSafeInteger(start) &&
        Number.isSafeInteger(end) &&
        start >= 1 &&
        end >= start &&
        end <= count
        ? text
        : null
    const target = match[2]
    const range = numericRange.exec(target)
    if (range) {
      const first = Number(range[1])
      const last = range[2] ? Number(range[2]) : first
      return Number.isSafeInteger(first) &&
        Number.isSafeInteger(last) &&
        first >= 1 &&
        last >= first &&
        last <= count
        ? text
        : null
    }
    if (target.length < 2) return null
    const code = text
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\/\/[^\n]*/g, " ")
      .replace(/"(?:\\.|[^"\\])*"/g, " ")
      .replace(/'(?:\\.|[^'\\])*'/g, " ")
      .replace(/`(?:\\.|[^`\\])*`/g, " ")
    const symbol = new RegExp(
      `(?<![\\w$])${target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w$])`
    )
    return symbol.test(code) ? text : null
  } catch {
    return null
  }
}

const validateSourceCheck = (anchor) => {
  const match = sourceAnchorPattern.exec(anchor)
  if (!match) return false
  if (match[3])
    return (
      Number(match[3]) >= 1 &&
      (!match[4] || Number(match[4]) >= Number(match[3]))
    )
  const target = match[2]
  if (!target) return false
  const range = numericRange.exec(target)
  if (range)
    return (
      Number(range[1]) >= 1 &&
      (!range[2] || Number(range[2]) >= Number(range[1]))
    )
  return target.length >= 2
}

const validateSourceEvidence = ({ anchor, result }, root) =>
  result.length >= 3 && sourceAnchorText(anchor, root) !== null

export const planPath = (plan) => path.relative(plan.root, plan.file)

export const planTarget = (plan, directory) => {
  const root = typeof directory === "string" ? path.resolve(directory) : null
  return root === plan.root ? planPath(plan) : plan.file
}

export const planReference = (plan, directory) =>
  `Task plan: ${planTarget(plan, directory)}\nThe plan file is the single source of the objective, decisions, checkpoint and remaining steps. Read it and continue the first unfinished step there. Do not restate its content in this message.`

const firstLine = (text) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean)
    ?.replace(/^#{1,6}\s*/, "")
    .replace(/^[-*]\s*/, "") ?? ""

const checkpointFor = (text) => {
  const line = firstLine(text)
  const summary = line.slice(0, 200) || "continue"
  return `- Текущий шаг: 1 — ${line.length > 200 ? `${summary}…` : summary}`
}

const slug = (text) =>
  firstLine(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)

const objectiveSection = (text) =>
  /^##\s/m.test(text) ? text.trim() : `${objectiveHeading}\n\n${text.trim()}`

const indexPlan = (context, plan) =>
  context.storage.set(planIndexKey(plan.id), {
    version: 1,
    id: plan.id,
    file: plan.file,
    root: plan.root,
    sessionID: plan.sessionID,
    updatedAt: plan.updatedAt
  })

const sectionRange = (lines, heading) => {
  const start = lines.findIndex((line) => line.trimEnd() === heading)
  if (start === -1) return null
  const next = lines.findIndex(
    (line, index) => index > start && /^##\s/.test(line)
  )
  return { start, end: next === -1 ? lines.length : next }
}

const sectionContent = (text, heading) => {
  const lines = text.replace(/\r\n/g, "\n").split("\n")
  const range = sectionRange(lines, heading)
  return range
    ? lines.slice(range.start + 1, range.end).join("\n").trim()
    : ""
}

const initialCheckpoint = (text) => {
  const lines = text.replace(/\r\n/g, "\n").split("\n")
  const range = sectionRange(lines, checkpointHeading)
  const heading = range?.start === 0 ? lines[range.end]?.trimEnd() : undefined
  if (!heading || heading === remainingHeading || heading === checkpointHeading)
    return null
  const objective = heading === objectiveHeading ? sectionContent(text, heading) : heading
  return objective ? checkpointFor(objective) : null
}

export function replaceSection(text, heading, content) {
  const lines = text.replace(/\r\n/g, "\n").split("\n")
  const range = sectionRange(lines, heading)
  const block = [heading, "", ...content.trim().split("\n")]
  if (!range) {
    const base = lines.join("\n").replace(/\n+$/, "")
    return `${base ? `${base}\n\n` : ""}${block.join("\n")}\n`
  }
  const tail = lines.slice(range.end)
  return [
    ...lines.slice(0, range.start),
    ...block,
    ...(tail.length ? [""] : []),
    ...tail
  ]
    .join("\n")
    .replace(/\n+$/, "\n")
}

export async function readPlan(context, sessionID) {
  const plan = await context.storage.get(planKey(sessionID))
  if (!plan || typeof plan !== "object") return null
  if (
    plan.version !== 1 ||
    (plan.ownership !== "managed" && plan.ownership !== "user")
  )
    throw new Error("Unsupported managed plan")
  if (
    typeof plan.root !== "string" ||
    typeof plan.file !== "string" ||
    !inside(plan.root, plan.file) ||
    path.dirname(plan.file) !== path.join(plan.root, ".opencode", "plans")
  )
    throw new Error("Unsafe managed plan path")
  if (plan.completedAt) return plan
  try {
    if (!(await fs.lstat(plan.file)).isFile())
      throw new Error("Managed plan must be a regular file")
  } catch (error) {
    if (error.code !== "ENOENT") throw error
    throw Object.assign(
      new Error(
        `Managed plan file is missing: ${plan.file}. Restore it before completing the task.`
      ),
      { code: "ERR_MISSING_PLAN", planPath: plan.file }
    )
  }
  return plan
}

async function acceptanceFrom(text, { baseline = [], root, receiptFor } = {}) {
  const section = sectionContent(text, acceptanceHeading)
  const issues = []
  const pending = []
  const changed = []
  const rows = []
  const ids = new Map()
  const approved = new Map(
    baseline.filter((row) => row.criterion).map((row) => [row.id.toLowerCase(), row])
  )
  for (const line of section.split("\n").map(line => line.trim()).filter(Boolean)) {
    const match = acceptanceRow.exec(line)
    if (!match) {
      issues.push(`Invalid acceptance row; use \`- ID [not checked] criterion\`: ${line}`)
      continue
    }
    const [, id, rawStatus, detail] = match
    const key = id.toLowerCase()
    if (ids.has(key)) {
      issues.push(`Duplicate acceptance criterion ${id}`)
      continue
    }
    ids.set(key, id)
    const status = rawStatus.toLowerCase()
    const parsed = parseAcceptanceDetail(detail)
    const { criterion, check, evidence } = parsed
    if (!criterion) issues.push(`${id} has no acceptance criterion`)
    const baselineRow = approved.get(key)
    if (!check && !baselineRow?.check)
      issues.push(
        `${id} needs a declared check: test <scenario> or source <anchor> before implementation`
      )
    if (check?.kind === "test" && !validateTestCheck(check.anchor))
      issues.push(
        `${id} declared test check needs an exact scenario/command: ${check.anchor}`
      )
    else if (
      check?.kind === "test" &&
      check.inputs?.some(
        (input) =>
          typeof input !== "string" ||
          !input.trim() ||
          !inside(root, path.resolve(root, input))
      )
    )
      issues.push(`${id} declared test inputs must stay inside the project`)
    else if (check?.kind === "source" && !validateSourceCheck(check.anchor))
      issues.push(
        `${id} declared source check needs an exact file, symbol or range: ${check.anchor}`
      )
    let activeCheck = check
    if (baselineRow) {
      if (normalize(criterion) !== baselineRow.criterion) {
        if (!parsed.changed) {
          issues.push(
            `${id} criterion changed from its approved baseline; mark the requirement change explicitly`
          )
          continue
        }
        changed.push({ id, criterion, check, evidence, rawLine: line })
        activeCheck = check ?? baselineRow.check
        pending.push({
          id,
          status: "not checked",
          reason: "requirement changed explicitly; run its check again"
        })
        rows.push({
          id,
          status,
          criterion,
          check: activeCheck,
          evidence,
          changed: true,
          criterionHash: null
        })
        continue
      }
      if (
        baselineRow.check &&
        check &&
        checkKey(baselineRow.check) !== checkKey(check)
      ) {
        issues.push(
          `${id} check changed from its approved baseline; mark the requirement change explicitly`
        )
        continue
      }
      if (!activeCheck) activeCheck = baselineRow.check
    }
    if (status === "closed") {
      const mismatch =
        activeCheck &&
        (activeCheck.kind !== evidence?.kind ||
          normalizeAnchor(activeCheck.anchor) !== normalizeAnchor(evidence?.anchor ?? ""))
      const stale =
        baselineRow?.invalidatedEvidence &&
        evidence &&
        evidenceKey(evidence) === evidenceKey(baselineRow.invalidatedEvidence)
      const machine = activeCheck ? parseMachineCheck(activeCheck, root) : null
      const machineChecked = Boolean(
        machine ||
          baselineRow?.machine ||
          (baselineRow?.check &&
            parseMachineCheckDeclaration(baselineRow.check, root))
      )
      if (stale) {
        issues.push(
          `${id} evidence predates the requirement change; run the check again`
        )
      } else if (machineChecked) {
        if (!machine)
          issues.push(
            `${id} machine check needs a recorded passing test run; its test file or inputs are missing or unreadable`
          )
        else {
          const receipt = receiptFor
            ? await receiptFor(id, activeCheck, baselineRow)
            : null
          if (!receipt)
            issues.push(
              `${id} machine check needs a recorded passing test run for ${activeCheck.anchor}`
            )
        }
      } else if (!evidence) {
        pending.push({
          id,
          status: "not checked",
          reason: "missing specific test: or source: evidence"
        })
      } else if (
        evidence.kind === "test" &&
        validateTestCheck(evidence.anchor) &&
        mismatch
      ) {
        issues.push(
          `${id} evidence does not match its declared ${activeCheck.kind} check ${activeCheck.anchor}`
        )
      } else if (
        evidence.kind === "test" &&
        !validateTestEvidence(evidence)
      ) {
        issues.push(
          `${id} test evidence needs an exact scenario/command anchor and observed result: ${evidence.raw}`
        )
      } else if (
        evidence.kind === "source" &&
        !validateSourceEvidence(evidence, root)
      ) {
        issues.push(
          `${id} source evidence needs an existing file, symbol or range and an established finding: ${evidence.raw}`
        )
      } else if (mismatch) {
        issues.push(
          `${id} evidence does not match its declared ${activeCheck.kind} check ${activeCheck.anchor}`
        )
      }
    } else {
      pending.push({ id, status })
    }
    rows.push({
      id,
      status,
      criterion,
      check: activeCheck,
      evidence,
      changed: false,
      criterionHash: baselineRow ? criterionHash(baselineRow) : null
    })
  }
  if (!section) issues.push(`Add ${acceptanceHeading} to the task plan before completing`)
  else if (!rows.length) issues.push(`Add at least one acceptance criterion to ${acceptanceHeading}`)
  return { ids, issues, pending, rows, changed }
}

const snapshotAcceptance = (rows, root) =>
  rows.map((row) => {
    const check =
      row.check ??
      (row.evidence
        ? { kind: row.evidence.kind, anchor: row.evidence.anchor }
        : null)
    const revision = Number(row.revision ?? 1)
    return {
      id: row.id,
      criterion: normalize(row.criterion),
      check,
      machine: Boolean(check && parseMachineCheckDeclaration(check, root)),
      revision,
      criterionHash: criterionHash({ criterion: row.criterion, check, revision }),
      evidence: row.evidence
        ? {
            kind: row.evidence.kind,
            anchor: row.evidence.anchor,
            result: row.evidence.result,
            raw: row.evidence.raw
          }
        : null
    }
  })

export async function readAcceptance(context, sessionID, { apply = false } = {}) {
  const plan = await readPlan(context, sessionID)
  if (plan?.stage !== "implementation" || plan.completedAt) return null

  let text = await fs.readFile(plan.file, "utf8")
  let baseline =
    plan.acceptanceBaseline ??
    (plan.acceptanceIDs ?? []).map((id) => ({ id, criterion: "", check: null }))
  const receiptFor = async (criterionID, check, baselineRow) => {
    const spec = parseMachineCheck(check, plan.root)
    if (!spec) return null
    const receipt = await context.storage.get(
      testReceiptKey(sessionID, plan.id, criterionID)
    )
    if (!receipt || receipt.checkHash !== spec.checkHash) return null
    if (
      baselineRow?.criterionHash &&
      receipt.criterionHash !== baselineRow.criterionHash
    )
      return null
    try {
      const current = testInputFingerprint(plan.root, spec.inputs)
      if (JSON.stringify(current) !== JSON.stringify(receipt.inputs)) return null
    } catch {
      return null
    }
    return receipt
  }
  let acceptance = await acceptanceFrom(text, {
    baseline,
    root: plan.root,
    receiptFor
  })
  if (apply && acceptance.changed.length) {
    const baselineAt = Number(plan.acceptanceBaselineAt ?? plan.updatedAt ?? 0)
    const steering = await context.storage.get(steeringKey(sessionID))
    const steeringAt = Number(
      typeof steering === "object" && steering ? steering.at : steering
    ) || 0
    const steeringText = normalize(
      typeof steering === "object" && steering && typeof steering.text === "string"
        ? steering.text
        : ""
    )
    if (!(steeringAt > baselineAt)) {
      for (const change of acceptance.changed)
        acceptance.issues.push(
          `${change.id} requirement change needs a new user message after the approved baseline`
        )
    } else {
      const knownIDs = [...acceptance.ids.values()]
      const unauthorized = acceptance.changed.filter(
        (change) =>
          !authorizesChange(
            steeringText,
            change.id,
            normalize(change.criterion),
            knownIDs
          )
      )
      for (const change of unauthorized)
        acceptance.issues.push(
          `${change.id} requirement change needs an explicit new criterion in a user message after the approved baseline`
        )
      acceptance.changed = acceptance.changed.filter(
        (change) => !unauthorized.includes(change)
      )
      if (acceptance.changed.length) {
        const approved = new Map(
          baseline
            .filter((row) => row.criterion)
            .map((row) => [row.id.toLowerCase(), row])
        )
        for (const change of acceptance.changed) {
          const previous = approved.get(change.id.toLowerCase())
          const activeCheck = change.check ?? previous?.check
          const revision = Number(previous?.revision ?? 0) + 1
          approved.set(change.id.toLowerCase(), {
            id: change.id,
            criterion: normalize(change.criterion),
            check: activeCheck ?? null,
            machine: Boolean(
              activeCheck &&
                parseMachineCheckDeclaration(activeCheck, plan.root)
            ),
            revision,
            criterionHash: criterionHash({
              criterion: change.criterion,
              check: activeCheck,
              revision
            }),
            evidence: null,
            invalidatedEvidence:
              change.evidence ?? previous?.evidence ?? previous?.invalidatedEvidence ?? null
          })
          const replacement = `- ${change.id} [not checked] ${change.criterion}${
            activeCheck
              ? ` | check: ${activeCheck.kind} ${activeCheck.anchor}${
                  activeCheck.inputs?.length
                    ? ` | inputs: ${activeCheck.inputs.join(", ")}`
                    : ""
                }`
              : ""
          }`
          text = text.replace(change.rawLine, replacement)
        }
        await writePrivateText(plan.file, text)
        baseline = [...approved.values()]
        const updated = {
          ...plan,
          acceptanceBaseline: baseline,
          acceptanceBaselineAt: Date.now(),
          updatedAt: Date.now()
        }
        await context.storage.set(planKey(sessionID), updated)
        await indexPlan(context, updated)
        const changedIDs = new Set(acceptance.changed.map((change) => change.id))
        acceptance = await acceptanceFrom(text, {
          baseline,
          root: plan.root,
          receiptFor
        })
        acceptance.pending = acceptance.pending.map((problem) =>
          changedIDs.has(problem.id)
            ? {
                ...problem,
                reason: "requirement changed explicitly; run its check again"
              }
            : problem
        )
      }
    }
  }
  for (const id of plan.acceptanceIDs ?? []) {
    if (!acceptance.ids.has(id.toLowerCase()))
      acceptance.issues.push(`Missing original acceptance criterion ${id}`)
  }
  return acceptance
}

export async function completePlan(context, sessionID) {
  const plan = await readPlan(context, sessionID)
  if (!plan) return null
  if (plan.completedAt) return plan
  const completed = { ...plan, completedAt: Date.now(), updatedAt: Date.now() }
  await context.storage.set(planKey(sessionID), completed)
  await indexPlan(context, completed)
  return completed
}

export async function acceptanceStatus(context, sessionID) {
  let plan
  try {
    plan = await readPlan(context, sessionID)
  } catch (error) {
    if (error.code !== "ERR_MISSING_PLAN") throw error
    return {
      kind: "missing",
      path: error.planPath,
      message: `Task acceptance is unfinished: the managed plan file is missing at ${error.planPath}. Restore it instead of treating the task as complete.`
    }
  }
  if (!plan || plan.stage !== "implementation" || plan.completedAt) return null
  const acceptance = await readAcceptance(context, sessionID)
  if (!acceptance) return null
  if (!acceptance.issues.length && !acceptance.pending.length)
    return {
      kind: "unfinalized",
      planID: plan.id,
      message:
        "Task acceptance is not finalized: every criterion is checked but context_cache(action=complete) was not called. Finalize it before reporting completion."
    }
  const first = acceptance.pending[0]?.id ?? acceptance.issues[0]
  return {
    kind: "unfinished",
    planID: plan.id,
    first,
    criterion: acceptance.pending[0]?.id ?? null,
    message: `Task acceptance is unfinished: ${first}. Finish its exact check before reporting completion.`
  }
}

export async function createPlan(
  context,
  { sessionID, directory, objective, stage }
) {
  const root = await fs.realpath(directory)
  const local = await ensureProjectIgnore(root, ["/plans/"])
  const plans = path.join(local, "plans")
  await fs.mkdir(plans, { recursive: true, mode: 0o700 })
  if ((await fs.realpath(plans)) !== plans)
    throw new Error("Plan directory must not be a symlink")
  const text = objective.trim()
  const id = `${slug(text) || "task"}-${randomUUID().slice(0, 8)}`
  const file = path.join(plans, `${id}.md`)
  await writePrivateText(
    file,
    `${checkpointHeading}\n\n${checkpointFor(text)}\n\n${objectiveSection(text)}\n`
  )
  const plan = {
    version: 1,
    id,
    file,
    root,
    sessionID,
    ownership: "managed",
    stage,
    updatedAt: Date.now()
  }
  await context.storage.set(planKey(sessionID), plan)
  await indexPlan(context, plan)
  return plan
}

export async function ensurePlan(context, options) {
  const plan = await readPlan(context, options.sessionID)
  return plan && !plan.completedAt ? plan : createPlan(context, options)
}

export async function adoptPlan(
  context,
  { sessionID, directory, file, stage = "handoff" }
) {
  const root = await fs.realpath(directory)
  const plans = path.join(root, ".opencode", "plans")
  const target = path.resolve(root, file)
  if (!inside(root, target) || path.dirname(target) !== plans)
    throw new Error("Plan path must be inside .opencode/plans")
  const stat = await fs.lstat(target).catch((error) => {
    if (error.code === "ENOENT") return null
    throw error
  })
  if (!stat?.isFile()) throw new Error("Plan path must be a regular file")
  const id = path.basename(target, ".md")
  const indexed = await context.storage.get(planIndexKey(id))
  if (indexed?.sessionID && indexed.sessionID !== sessionID)
    throw new Error("Plan is bound to another session")
  await ensureProjectIgnore(root, ["/plans/"])
  const plan = {
    version: 1,
    id,
    file: target,
    root,
    sessionID,
    ownership: "user",
    stage,
    updatedAt: Date.now()
  }
  await context.storage.set(planKey(sessionID), plan)
  return plan
}

export async function updatePlan(
  context,
  { sessionID, remaining, checkpoint, stage = "implementation" }
) {
  const plan = await readPlan(context, sessionID)
  if (!plan || plan.completedAt) return null
  let acceptanceIDs = plan.acceptanceIDs
  let acceptanceBaseline = plan.acceptanceBaseline
  let acceptanceBaselineAt = plan.acceptanceBaselineAt
  const startingImplementation = stage === "implementation" && plan.stage !== stage
  if (startingImplementation || remaining?.trim() || checkpoint?.trim()) {
    const original = await fs.readFile(plan.file, "utf8")
    const current = sectionContent(original, checkpointHeading)
    const fillsRemaining = remaining?.trim() && !sectionContent(original, remainingHeading)
    let text = original
    if (fillsRemaining)
      text = replaceSection(text, remainingHeading, remaining)
    if (checkpoint?.trim())
      text = replaceSection(text, checkpointHeading, checkpointFor(checkpoint))
    else if (!current || (fillsRemaining && plan.ownership === "managed" && current === initialCheckpoint(original)))
      text = replaceSection(text, checkpointHeading, checkpointFor(remaining ?? ""))
    if (startingImplementation) {
      const acceptance = await acceptanceFrom(text, { root: plan.root })
      if (acceptance.issues.length)
        throw new Error(
          `Plan is not ready for implementation: ${acceptance.issues.join("; ")}. Stay in planning and fix the plan; do not transfer again.`
        )
      acceptanceBaseline = snapshotAcceptance(acceptance.rows, plan.root)
      acceptanceIDs = [...acceptance.ids.values()]
      acceptanceBaselineAt = Date.now()
    }
    if (text !== original) await writePrivateText(plan.file, text)
  }
  const updated = {
    ...plan,
    stage,
    ...(acceptanceIDs?.length ? { acceptanceIDs } : {}),
    ...(acceptanceBaseline?.length ? { acceptanceBaseline } : {}),
    ...(acceptanceBaselineAt ? { acceptanceBaselineAt } : {}),
    updatedAt: Date.now()
  }
  await context.storage.set(planKey(sessionID), updated)
  await indexPlan(context, updated)
  return updated
}

const scanAll = async (context, prefix) => {
  const entries = []
  let after
  do {
    const page = await context.storage.scan({
      prefix,
      limit: cachePolicy.scanEntries,
      ...(after ? { after } : {})
    })
    for (const entry of page.entries) entries.push(entry)
    after = page.next
  } while (after)
  return entries
}

const trackedPlans = (root, plans) =>
  new Promise((resolve) => {
    execFile(
      "git",
      ["-C", root, "ls-files", "-z", "--", path.relative(root, plans)],
      (error, stdout) => {
        if (error) return resolve(new Set())
        resolve(
          new Set(
            stdout
              .split("\0")
              .filter(Boolean)
              .map((file) => path.resolve(root, file))
          )
        )
      }
    )
  })

export async function prunePlans(context, root) {
  if (!context.storage.scan) return
  const plans = path.join(root, ".opencode", "plans")
  const real = await fs.realpath(plans).catch((error) => {
    if (error.code === "ENOENT") return null
    throw error
  })
  if (real !== plans) return
  const planFile = (file) =>
    typeof file === "string" &&
    path.dirname(file) === plans &&
    inside(root, file)
  const bindings = new Map()
  const bind = (file, binding) => {
    const list = bindings.get(file) ?? []
    list.push(binding)
    bindings.set(file, list)
  }
  for (const { key, value } of await scanAll(context, "plan:")) {
    const sessionID = key.slice("plan:".length)
    if (typeof value?.file === "string" && !planFile(value.file)) continue
    const valid =
      value &&
      typeof value === "object" &&
      value.version === 1 &&
      (value.ownership === "managed" || value.ownership === "user") &&
      value.sessionID === sessionID &&
      planFile(value.file)
    if (!valid) {
      await context.storage.remove(key)
      continue
    }
    bind(value.file, { key, value, sessionID, ownership: value.ownership })
  }
  for (const { key, value } of await scanAll(context, "plan-index:")) {
    if (typeof value?.file === "string" && !planFile(value.file)) continue
    const valid =
      value &&
      typeof value === "object" &&
      value.version === 1 &&
      typeof value.id === "string" &&
      typeof value.sessionID === "string" &&
      planFile(value.file) &&
      key === planIndexKey(value.id)
    if (!valid) {
      await context.storage.remove(key)
      continue
    }
    bind(value.file, {
      key,
      value,
      sessionID: value.sessionID,
      ownership: "managed"
    })
  }
  const drop = async (file) => {
    for (const { key } of bindings.get(file) ?? [])
      await context.storage.remove(key)
    bindings.delete(file)
  }
  const entries = await fs.readdir(plans).catch((error) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return []
    throw error
  })
  const tracked = await trackedPlans(root, plans)
  const seen = new Set()
  for (const entry of entries) {
    const file = path.join(plans, entry)
    const stat = await fs.lstat(file).catch((error) => {
      if (error.code === "ENOENT") return null
      throw error
    })
    if (!stat?.isFile()) continue
    seen.add(file)
    if (tracked.has(file)) continue
    const list = bindings.get(file) ?? []
    if (list.some(({ ownership }) => ownership === "user")) continue
    if (Date.now() - stat.mtimeMs < cachePolicy.taskContextMs) continue
    const live = []
    for (const binding of list)
      if (await sessionExists(context, binding.sessionID)) live.push(binding)
    if (live.length) {
      await fs.utimes(file, new Date(), new Date())
      for (const { key, value } of live)
        await context.storage.set(key, { ...value, updatedAt: Date.now() })
      bindings.delete(file)
      continue
    }
    await fs.unlink(file)
    await drop(file)
  }
  for (const file of [...bindings.keys()]) if (!seen.has(file)) await drop(file)
}
