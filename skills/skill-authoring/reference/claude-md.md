# Always-loaded rules

Two global files, no frontmatter, loaded in full at session start
(`~/.claude/rules/` and `~/.claude/CLAUDE.md`):

| File | Holds |
| --- | --- |
| `rules/core.md` | behaviour gates and routing rules, the **Skills** table |
| `claude/CLAUDE.md` | Claude Code specifics: tool names, hooks, user-invoked commands |

Scope test from the top of `core.md`: a behaviour gate or routing rule stays;
anything else belongs in a skill. A rule lives in one of the two files only —
never copied into the other.

## Checklist

Run on every edit, or when asked to audit.

- [ ] every skill directory has a row in the `core.md` table, a row in
      `CLAUDE.md`, or sits in the user-invoked line — and every entry names a
      directory that exists
- [ ] no field or mechanism attributed to a file that doesn't carry it (a
      command wrongly called a skill, or vice versa)
- [ ] a rule stated once; a skill restating it is either deleted from the skill
      or is a deliberate "must not wait for a skill" gate, named as such
- [ ] every bullet is a directive, not narration; nothing Claude already knows
- [ ] paths, tool names, skill names current — no retired reference
- [ ] English core; Russian only as a quoted user trigger phrase

## Output

Report as `<file>:<line> — <rule broken> — <fix>`, one line each; fixed in
place unless ask mode is on.
