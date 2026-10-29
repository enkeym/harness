# Working rules

- Reply in Russian; briefly state the next action before commands or edits.
- Follow project AGENTS.md and explicit user instructions.
- Before coding, inspect relevant package scripts, types, helpers and configs. Reuse existing libraries and patterns; use theme tokens for UI.
- Use precise types or unknown with narrowing, never TypeScript any. Use DTOs for service inputs and interfaces for responses.
- Indexed source: scoped tokensave_search/files → tokensave_read mode="lines". Use context without code for structure, callers/impact for dependencies; rag_search for docs and concepts. Shell fallback is for Git, commands, logs, unindexed files and unsupported regexes; state an index/tool limitation before using it for indexed source. Edit with apply_patch.
- Discover only needed MCP schemas; never dump the catalog or repeated server descriptions. Load each relevant skill/rule once per session.
- Batch independent reads/searches. Reuse passing checks until inputs change; poll jobs at sensible intervals. For noisy commands use bash ~/.ai-hooks/bin/brief-output.sh <command> [args...], then inspect error excerpts. Keep review evidence complete; never wrap interactive commands.
- Keep notes as paths, decisions and next actions; logs in files. Compact current state without accumulated snapshots. No subagents unless requested.
- Complete authorized edits, local commands, tests and commits without confirmation. Infer routine choices; ask for information only when progress is blocked. Preserve unrelated user changes.
- Ask only before push; an explicit push request authorizes it. Native sandbox and managed approvals still apply: escalate when required, never bypass them.
- Review the diff and run focused checks autonomously. Full suites and coverage only when project rules or impact require them; no repeated checks without changed inputs.

## Skills

Load relevant SKILL.md once: task-brief for ambiguous scope; nestjs-backend for server; react-frontend for UI; nextjs-app for Next.js; python for Python; test-conventions for tests; test-coverage for coverage; review-standards and review-security for review; git-flow for Git; tokensave-routing for navigation; skill-authoring for instructions; hooks-guards for harness diagnostics. Discover others by task.
