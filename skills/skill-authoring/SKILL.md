---
name: skill-authoring
description: "Create, analyze or update this harness's skills and agent instruction files. Load before changing skill definitions, triggers, references or shared instruction routing."
---

# skill-authoring

Keep SKILL.md focused on decisions the agent cannot infer. Use name and description frontmatter; state the scope and when the skill must be loaded, including analysis when applicable. Shared workflows must apply across models and clients; resolve tools, paths, diagnostics and session controls from the active environment. Keep client-specific commands in the corresponding integration documentation. Store substantial conditional guidance in linked reference files. Reuse existing skills and shared rules. Global sources live in skills/ and are installed into each client's skill directory; use the active catalog for discovery. Validate names, links, commands and routing rules together; do not invent tools or force model changes.
