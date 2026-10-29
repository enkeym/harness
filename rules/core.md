# Working rules

- Reply in Russian. Briefly describe the next action before commands or edits.
- Follow project AGENTS.md and explicit user authorization.
- Inspect package.json, existing types, helpers, configs and theme tokens before coding.
- Reuse installed libraries and established patterns; avoid duplicated logic and implicit dependencies.
- Do not use TypeScript any; use precise types or unknown with narrowing.
- Use DTOs for service inputs and interfaces for responses.
- Indexed project files must be searched/read through MCP: scoped tokensave_search/files → tokensave_read mode="lines"; context without code for structure, callers/impact for dependencies. Do not use shell cat/sed/head, interpreter scripts or copied temp files to read indexed source.
- Use rag_search for docs and conceptual searches. Shell is for Git revisions/diffs, commands/tests, logs, files outside the index and regexes MCP cannot express. MCP unavailable or a file reported unscanned → state that limitation before a scoped fallback. Use apply_patch for changes.
- Discover MCP tools through the tool catalog. If unavailable, report that limitation.
- Load each skill/rule once per session; reuse unchanged results. For noisy noninteractive commands use bash ~/.ai-hooks/bin/brief-output.sh <command> [args...]; inspect the saved log around errors. Keep diffs and review evidence complete; never wrap interactive commands or use this to bypass approvals.
- Batch independent reads/searches in one tool round; keep dependent steps sequential. Reuse successful checks until their inputs change. Poll running jobs at sensible intervals instead of repeated short waits.
- Keep task notes as paths, decisions and next actions; store large logs/data in files. Preserve only current state through compaction or handoff, without accumulated snapshots. Do not spawn agents unless explicitly requested.
- Ask only for missing decisions or authorization; reuse answers already given. Use an available question tool within its schema and mode, otherwise ask briefly in chat. Multiple selections can be answered as finding numbers in text.
- Keep native sandbox and approvals active. Never route around a guard denial.
- Review the diff and run meaningful checks before delivery.
- Commit and push only within the user's authorized scope.

## Skills

Read the relevant SKILL.md before working in its area:
task-brief for ambiguous scope; nestjs-backend for server work; react-frontend
for UI; nextjs-app for Next.js; python for Python; test-conventions for tests;
test-coverage for coverage analysis; review-standards and review-security for
reviews; git-flow for Git; tokensave-routing for code navigation;
skill-authoring for instruction files; hooks-guards for harness diagnostics.
Other skills are discoverable by their descriptions and explicit invocation.
