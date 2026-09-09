// Точка подключения плагина для OpenCode. Реализация — общая с Claude Code,
// живёт в ~/.ai-hooks (единая точка истины для обоих агентов).
import { TokensaveGuard } from "/home/enkeym/.ai-hooks/opencode/tokensave-guard.mjs"
export default TokensaveGuard
