// Точка подключения плагина для OpenCode. Реализация — общая с Claude Code,
// живёт в ~/.ai-hooks (единая точка истины для обоих агентов). Путь от
// домашнего каталога, а не зашитый: файл в репозитории общий для всех машин.
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

const guardUrl = pathToFileURL(path.join(os.homedir(), ".ai-hooks", "opencode", "tokensave-guard.mjs")).href
const { TokensaveGuard } = await import(guardUrl)
export default TokensaveGuard
