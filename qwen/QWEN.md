# Coding harness

Read `~/.config/harness/repo/rules/core.md` before the first task.
Load relevant skills from `~/.qwen/skills` by reading their SKILL.md.
Use MCP to search/read indexed project files; state the index/tool limitation before shell fallback.
Project instructions and explicit user instructions take precedence.
Perform edits and focused checks autonomously. An explicit push request authorizes push.
Use installed tools. Codex-specific commands in shared skills apply only to Codex;
for Qwen diagnostics use `qwen --version`, `qwen mcp list` and
`~/.config/harness/repo/install.sh --qwen --check`.
