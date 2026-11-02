import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { defaultCostConfig, costConfigFile, costStateRoot, refreshCostReport, updateAssessment, validateBilling, validateCostConfig, formatCostReport } from "../opencode/cost-report.mjs"
import { readJSON, writePrivateJSON } from "../opencode/local-state.mjs"

const [command = "report", ...args] = process.argv.slice(2)
const options = {}
const allowed = { report: ["--date", "--json"], init: [], assess: ["--file"], billing: ["--file"] }
try {
  if (!(command in allowed)) throw new Error("Unknown command")
  let sessionID
  if (command === "assess") sessionID = args.shift()
  while (args.length) {
    const key = args.shift()
    if (!allowed[command].includes(key) || key in options) throw new Error("Invalid option")
    options[key] = key === "--json" ? true : args.shift()
    if (options[key] === undefined) throw new Error("Missing option value")
  }
  if (command === "init") {
    const file = costConfigFile()
    const config = validateCostConfig(await readJSON(file, defaultCostConfig))
    await writePrivateJSON(file, config)
    console.log(file)
  } else {
    if (command === "assess" || command === "billing") {
      if (!options["--file"]) throw new Error("Missing --file")
      const data = JSON.parse(await fs.readFile(options["--file"], "utf8"))
      if (command === "assess") await updateAssessment(sessionID, data)
      else {
        const point = validateBilling(data)
        point.reportedAt = new Date().toISOString()
        const key = createHash("sha256").update(JSON.stringify([point.date, point.currency, point.accountScope, point.timeZone])).digest("hex").slice(0, 16)
        await writePrivateJSON(path.join(costStateRoot(), "billing", `${point.date}-${key}.json`), point)
      }
    }
    const result = await refreshCostReport({ date: options["--date"] })
    process.stdout.write(options["--json"] ? `${JSON.stringify(result.report, null, 2)}\n` : formatCostReport(result.report))
    process.stderr.write(`Report: ${result.file}\n`)
  }
} catch (error) {
  process.stderr.write(`OpenCode costs: ${error.code ?? error.name}. Usage: report [--date YYYY-MM-DD] [--json] | init | assess ses_ID --file assessment.json | billing --file billing.json\n`)
  process.exitCode = 1
}
