import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"

const root = path.resolve(import.meta.dirname, "../..")
const skillsDirectory = path.join(root, "skills")

function frontmatter(name) {
  const text = fs.readFileSync(path.join(skillsDirectory, name, "SKILL.md"), "utf8")
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text)
  assert.ok(match, `${name}: SKILL.md must open with frontmatter`)
  const field = key => new RegExp(`^${key}:\\s*(.+)$`, "m").exec(match[1])?.[1]
  return { field }
}

const entries = fs
  .readdirSync(skillsDirectory, { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => entry.name)
  .filter(name => fs.existsSync(path.join(skillsDirectory, name, "SKILL.md")))
  .map(name => ({ directory: name, ...frontmatter(name) }))

test("every skill directory declares one unique catalog id matching its directory", () => {
  const ids = new Map()
  for (const entry of entries) {
    const id = (entry.field("name") ?? "").trim()
    assert.equal(id, entry.directory, `${entry.directory}: frontmatter name must match the directory`)
    assert.equal(ids.has(id), false, `duplicate skill id ${id} in ${ids.get(id)} and ${entry.directory}`)
    ids.set(id, entry.directory)
  }
})

test("every skill declares one single-line description", () => {
  for (const entry of entries) {
    const description = (entry.field("description") ?? "").trim()
    assert.ok(description, `${entry.directory}: missing description`)
    assert.equal(/^[|>]$/.test(description), false, `${entry.directory}: description must stay on one line`)
  }
})
