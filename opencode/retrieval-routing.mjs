const retrieval = "Indexed project files must be searched/read with TokenSave or RAGSave through execute. First load tokensave-routing, discover the required MCP schemas using search inside execute, and check tokensave_status. For file discovery or reading, use this tool only for Git output, logs, external configuration or an explicitly established MCP/coverage limitation. A known path or continuation does not waive this requirement."

const guidance = {
  read: retrieval,
  grep: retrieval,
  glob: retrieval,
  shell: `${retrieval} Resolve skill references against the Base directory returned by skill; never search / or the home tree for an already located skill. Launch only a concrete necessary command; do not create placeholder/background shells or use shells to emulate unrequested subagents.`,
  skill: "Load tokensave-routing before project exploration, including reviews and resumed sessions. Resolve relative reference links against this skill's returned Base directory, not the project working directory. Read the exact reference path; do not search the filesystem for it. Delegation requires an explicit user request.",
  subagent: "Use only when the user explicitly requests delegation or subagents. A review request, a large task, available tools or the Subagents UI tab do not authorize delegation. Continue the work in the current session otherwise; do not emulate workers through shell.",
  execute: "Use this tool for indexed project retrieval: discover TokenSave/RAGSave schemas with search, check tokensave_status, then call the discovered MCP tools. Use scoped tokensave_context with task and include_code=false to locate unfamiliar structure; use tokensave_read for needed line ranges."
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
