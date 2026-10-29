# Working rules

- Reply in Russian. Briefly describe the next action before commands or edits.
- Follow project AGENTS.md and explicit user authorization.
- Inspect package.json, existing types, helpers, configs and theme tokens before coding.
- Reuse installed libraries and established patterns; avoid duplicated logic and implicit dependencies.
- Do not use TypeScript any; use precise types or unknown with narrowing.
- Use DTOs for service inputs and interfaces for responses.
- For indexed code, locate symbols with scoped tokensave_search/files; read only needed ranges with tokensave_read mode="lines". Use scoped context without code for unfamiliar structure, and callers/impact for dependencies.
- Use rag_search for docs and conceptual searches; use rg for regexes, unindexed files or unavailable MCP. Avoid full-file reads unless the task requires them; use apply_patch for changes.
- Discover MCP tools through the tool catalog. If unavailable, report that limitation.
- Load each skill/rule once per session; reuse unchanged results. For noisy noninteractive commands use bash ~/.ai-hooks/bin/brief-output.sh <command> [args...]; inspect the saved log around errors. Keep diffs and review evidence complete; never wrap interactive commands or use this to bypass approvals.
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
