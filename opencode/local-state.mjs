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
