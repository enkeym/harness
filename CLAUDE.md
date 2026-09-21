# harness

Source of the global agent setup. Layout, install and the test list:
`README.md`. This file holds only what working inside the repository needs.

## Edits are live

- `~/.ai-hooks`, `~/.claude/{CLAUDE.md,skills,rules/core.md}` are symlinks
  into this tree: an edit here changes every running session at once. A broken
  guard or router blocks this session too — keep the tests green between edits.
- `claude/CLAUDE.md` is the global Claude-only rules file, not this project's.
  Where a rule goes: `skills/skill-authoring/reference/claude-md.md`.
- Hook registration (`claude/settings.json`) and rules files load at session
  start. A new hook or event is checked by feeding its JSON to the script on
  stdin; the live check waits for the next session — say so, don't claim it.

## Tests

- Any edit in `ai-hooks/` → every `ai-hooks/test/test-*.mjs`; any edit in
  `skills/`, `rules/core.md`, `claude/CLAUDE.md`, `opencode/` →
  `test-skills.mjs` too. `ragsave/` → `ragsave/tests/test_ragsave.py`.
- Hook tests swap external binaries through `AI_HOOKS_*_CMD` fakes in
  `ai-hooks/test/fixtures/`; a new external call gets a fake, never the real
  binary.

## Hook code

- Node ESM `.mjs`, no dependencies. Shared logic lives in `ai-hooks/*-core.mjs`;
  `ai-hooks/claude/` and `ai-hooks/opencode/` are thin adapters over it.
- Comments and messages the agent reads are Russian, matching the file.
- A hook's behaviour is also described in `skills/hooks-guards/SKILL.md` and
  `ai-hooks/README.md` — change them in the same commit.

## Git

- Base `main`, commit and push straight to it.
- Header `type(scope): …` in English, scopes as in `git log`: `hooks`,
  `skills`, `rules`, `opencode`, `config`, `harness`.
- `claude/settings.json` is rewritten by Claude Code itself (`/config`): a
  diff there nobody asked for is left out of the commit.
