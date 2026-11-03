import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"

export async function readJSON(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"))
  } catch (error) {
    if (error.code === "ENOENT") return fallback
    throw error
  }
}

export async function writePrivateText(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await fs.chmod(path.dirname(file), 0o700)
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, text, { mode: 0o600, flag: "wx" })
    await fs.rename(temporary, file)
  } finally {
    await fs.rm(temporary, { force: true })
  }
  return file
}

export const writePrivateJSON = (file, value) => writePrivateText(file, `${JSON.stringify(value, null, 2)}\n`)

export async function ensureProjectIgnore(directory, rules) {
  const root = await fs.realpath(directory)
  const local = path.join(root, ".opencode")
  await fs.mkdir(local, { recursive: true })
  if (await fs.realpath(local) !== local) throw new Error("Project state directory must not be a symlink")
  const file = path.join(local, ".gitignore")
  try {
    if ((await fs.lstat(file)).isSymbolicLink()) throw new Error("Project ignore file must not be a symlink")
  } catch (error) {
    if (error.code !== "ENOENT") throw error
  }
  const ignored = await fs.readFile(file, "utf8").catch(error => {
    if (error.code === "ENOENT") return ""
    throw error
  })
  const missing = rules.filter(rule => !ignored.split(/\r?\n/).includes(rule))
  if (missing.length) await fs.appendFile(file, `${ignored && !ignored.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`, { mode: 0o600 })
  return local
}
