import fs from "node:fs"

export function readInstructions() {
  const core = fs.readFileSync(new URL("../rules/core.md", import.meta.url), "utf8").trim()
  if (!core.includes("\n## Skills and hooks\n")) throw new Error("Harness skill routing instructions are missing")
  const instructions = fs.readFileSync(new URL("./AGENTS.md", import.meta.url), "utf8").trim()
  return { core, instructions, text: `Harness skill instructions:\n${core}\n\n${instructions}` }
}
