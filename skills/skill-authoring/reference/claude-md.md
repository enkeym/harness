# Always-loaded rules

Three files, no frontmatter, loaded in full at session start:

| File | Loaded by | Holds |
| --- | --- | --- |
| `rules/core.md` | Claude Code (`~/.claude/rules/`), OpenCode (`instructions`) | every gate and routing rule both agents need, the **Skills** table |
| `claude/CLAUDE.md` | Claude Code | Claude-only: tool names, hooks, `Agent` deny, user-invoked commands |
| `opencode/AGENTS.md` | OpenCode | OpenCode-only: MCP prefix, guard plugin, agents, denied skills |

Scope test from the top of `core.md`: a behaviour gate or routing rule stays;
anything else belongs in a skill. A rule both agents need lives in `core.md`
only — never copied into `CLAUDE.md` or `AGENTS.md`.

## Checklist

Run on every edit, or when asked to audit.

- [ ] every skill directory has a row in the `core.md` table, a row in the
      one agent file that can run it, or sits in the user-invoked line — and
      every entry names a directory that exists
- [ ] a skill listed for one agent only is denied in the other
      (`permission.skill` in `opencode.json`)
- [ ] no field or mechanism attributed to a file that doesn't carry it (a
      command wrongly called a skill, or vice versa)
- [ ] a rule stated once; a skill restating it is either deleted from the skill
      or is a deliberate "must not wait for a skill" gate, named as such
- [ ] nothing in `CLAUDE.md` or `AGENTS.md` that the other agent also needs
- [ ] every bullet is a directive, not narration; nothing Claude already knows
- [ ] paths, tool names, skill names current — no retired reference
- [ ] English core; Russian only as a quoted user trigger phrase

## Output

Report as `<file>:<line> — <rule broken> — <fix>`, one line each; fixed in
place unless ask mode is on.
