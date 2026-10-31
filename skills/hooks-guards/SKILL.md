---
name: hooks-guards
description: "Diagnose the active agent client's approval refusals, sandbox restrictions, hook trust and explicitly configured project hooks. Load when investigating these controls or their failures."
---

# hooks-guards

Harness installs SessionStart/UserPromptSubmit context handlers for skill routing and SessionStart/Stop handlers for background index sync with startup RAG warmup. The agent still reads the applicable skills; context delivery alone does not prove loading. MCP search routing is guidance; do not install a blocking search guard. For a refusal, distinguish native sandbox/approval policy from user or project hooks and inline definitions. Inspect only the active client's relevant configuration and handler; check its current official hook documentation before changing the protocol. Never retry a denied action through another tool. A previous user authorization remains valid within its scope. Review hook trust through the client's supported controls, not by editing trust state. Do not assume hook events or approval interfaces are shared across clients. Do not promise a confirmation dialog from a hook.
