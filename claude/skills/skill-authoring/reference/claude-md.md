# CLAUDE.md

Not a SKILL.md: no frontmatter, no `name`/`description` limits, always loaded.
Its own rule (top of the file) is the scope test: a behaviour gate or routing
rule stays; anything else belongs in a skill.

## Checklist

Run on every edit, or when asked to audit.

- [ ] every skill directory has a Skills-table row or sits in the user-invoked
      line — and every table/line entry names a directory that exists
- [ ] no field or mechanism attributed to a file that doesn't carry it (a
      command wrongly called a skill, or vice versa)
- [ ] a rule stated once; a skill restating it is either deleted from the skill
      or is a deliberate "must not wait for a skill" gate, named as such
- [ ] every bullet is a directive, not narration; nothing Claude already knows
- [ ] paths, tool names, skill names current — no retired reference
- [ ] English core; Russian only as a quoted user trigger phrase

## Output

Report as `CLAUDE.md:<line> — <rule broken> — <fix>`, one line each; fixed in
place unless ask mode is on.
