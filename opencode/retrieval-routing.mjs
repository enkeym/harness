const retrieval = "For indexed project files, follow the TokenSave/RAGSave route in the harness instructions."

const guidance = {
  read: retrieval,
  grep: retrieval,
  glob: retrieval,
  shell: `${retrieval} A known path or an earlier MCP call does not justify local source retrieval. Resolve skill references against the Base directory returned by skill; never search / or the home tree for an already located skill. Run only a concrete needed command; never create placeholder/background shells or use shells to emulate unrequested subagents.`,
  skill: "Load only a skill whose described scope this task actually touches. Resolve relative links against the returned Base directory.",
  subagent: "Use only when the user explicitly requests delegation or subagents. A review request, a large task, available tools or the Subagents UI tab do not authorize delegation. Continue the work in the current session otherwise; do not emulate workers through shell.",
  execute: `${retrieval} Discover MCP schemas with search before calling them. Narrow paths, ranges and limits before the call; do not slice serialized MCP results.`
}

export async function registerRetrievalRouting(context) {
  await context.tool.transform(editor => {
    for (const [name, instruction] of Object.entries(guidance)) {
      if (!editor.get(name)) continue
      editor.update(name, tool => {
        if (!tool.description?.startsWith(instruction)) {
          tool.description = `${instruction}\n\n${tool.description ?? ""}`
        }
      })
    }
  })
}
