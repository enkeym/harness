import fs from "node:fs/promises"
import path from "node:path"
import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { cachePolicy } from "./cache-policy.mjs"
import {
  ensureProjectIgnore,
  inside,
  sessionExists,
  writePrivateText
} from "./local-state.mjs"

export const planKey = (sessionID) => `plan:${sessionID}`
export const planIndexKey = (id) => `plan-index:${id}`
export const checkpointHeading = "## Checkpoint"
export const remainingHeading = "## Оставшиеся шаги"

export const planPath = (plan) => path.relative(plan.root, plan.file)

export const planReference = (plan) =>
  `Task plan: ${planPath(plan)}\nThe plan file is the single source of the objective, decisions, checkpoint and remaining steps. Read it and continue the first unfinished step there. Do not restate its content in this message.`

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
  /^##\s/m.test(text) ? text.trim() : `## Objective\n\n${text.trim()}`

const indexPlan = (context, plan) =>
  context.storage.set(planIndexKey(plan.id), {
    version: 1,
    id: plan.id,
    file: plan.file,
    root: plan.root,
    sessionID: plan.sessionID,
    updatedAt: plan.updatedAt
  })

export function replaceSection(text, heading, content) {
  const lines = text.replace(/\r\n/g, "\n").split("\n")
  const start = lines.findIndex((line) => line.trimEnd() === heading)
  const block = [heading, "", ...content.trim().split("\n")]
  if (start === -1) {
    const base = lines.join("\n").replace(/\n+$/, "")
    return `${base ? `${base}\n\n` : ""}${block.join("\n")}\n`
  }
  let end = lines.length
  for (let index = start + 1; index < lines.length; index++) {
    if (/^##\s/.test(lines[index])) {
      end = index
      break
    }
  }
  const tail = lines.slice(end)
  return [
    ...lines.slice(0, start),
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
  try {
    if (!(await fs.lstat(plan.file)).isFile())
      throw new Error("Managed plan must be a regular file")
  } catch (error) {
    if (error.code !== "ENOENT") throw error
    await context.storage.remove(planKey(sessionID))
    await context.storage.remove(planIndexKey(plan.id))
    return null
  }
  return plan
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
  return (
    (await readPlan(context, options.sessionID)) ?? createPlan(context, options)
  )
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
  if (!plan) return null
  let text = await fs.readFile(plan.file, "utf8")
  if (remaining?.trim())
    text = replaceSection(text, remainingHeading, remaining)
  text = replaceSection(
    text,
    checkpointHeading,
    checkpointFor(checkpoint ?? remaining ?? "")
  )
  await writePrivateText(plan.file, text)
  const updated = { ...plan, stage, updatedAt: Date.now() }
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
