# Coding harness

Treat the following as required steps, not suggestions. Perform them through actual tool calls; an intention, remembered summary or successful earlier task is not evidence of completion.

## Before acting

- Before the first task, read `~/.config/harness/repo/rules/core.md`. Read applicable project instructions and relevant `~/.qwen/skills/<name>/SKILL.md` before their workflow. After compaction, restore missing instructions before continuing. If a required file cannot be read, report the blocker before dependent actions.
- Follow explicit user instructions within system/tool constraints. Project instructions set project conventions; they do not waive core.md prohibitions reserved for explicit user permission, including the ban on adding or rewriting code comments and JSDoc.
- Before code changes, inspect existing implementations and callers as core.md requires. Before each edit, read the exact target and confirm its path; serialize edits to each file. Never patch a guessed path or unseen content.
- Search/read indexed files through MCP using tokensave-routing. Shell fallback requires a concrete unavailable tool/index or excluded file, stated before use; knowing a path or getting one empty search is insufficient.
- Discover each needed tool's schema before its first call and reuse it. Do not invent tool names, arguments or commands. Codex-only commands in shared skills do not apply to Qwen; use available Qwen tools and report an unavailable required capability.

## Before continuing or finishing

- After every write, re-read the changed region and validate its format where applicable, including parsing JSON. Resolve failed edits and checks before dependent work; do not retry the same failed call without correcting its cause.
- Before handoff, inspect the diff for prohibited comments, literal secrets, duplication and unrelated changes; run the required focused checks. Claim success only from observed results. Report changed paths, checks and any remaining blocker; never describe an unrun check as passed.
- Keep tokens and keys out of chat, patches shown to the user, logs and Git. Store secret values in `~/.config/harness/env`, reference names in settings and verify resolution without printing values.
- Complete authorized edits and checks autonomously; do not ask again for an already authorized action. Ask before sensitive operations only as required by core.md. An explicit push request authorizes that push within its stated scope.

For Qwen diagnostics use `qwen --version`, `qwen mcp list` and `~/.config/harness/repo/install.sh --qwen --check`. Their success does not prove that instructions were loaded, hooks executed or model authentication works.
pfg