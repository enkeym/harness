const retrieval = "For indexed project files, search/read through TokenSave or RAGSave with execute: load tokensave-routing once, discover the required MCP schemas with search and call tokensave_status before the first read. Without an index, do not load tokensave-routing or call MCP: use this tool normally. Otherwise use this tool for Git output, logs, external configuration or a demonstrated MCP/coverage limitation; a known path or continuation does not waive indexed retrieval."

const guidance = {
  read: retrieval,
  grep: retrieval,
  glob: retrieval,
  shell: `${retrieval} Resolve skill references against the Base directory returned by skill; never search / or the home tree for an already located skill. Run only a concrete needed command; never create placeholder/background shells or use shells to emulate unrequested subagents.`,
  skill: "Load only a skill whose described scope this task actually touches; never load the whole catalog. Load tokensave-routing only when the project root has an index (`.tokensave/` or `.ragsave/rag.db`) and the task needs code navigation. Resolve relative reference links against this skill's returned Base directory, not the project working directory; read that exact path and do not search the filesystem for it. Delegation requires an explicit user request.",
  subagent: "Use only when the user explicitly requests delegation or subagents. A review request, a large task, available tools or the Subagents UI tab do not authorize delegation. Continue the work in the current session otherwise; do not emulate workers through shell.",
  execute: "Use this tool for indexed project retrieval when the project root has an index: discover the TokenSave/RAGSave schemas with search and call tokensave_status first, then locate structure with tokensave_context (include_code=false) and read ranges with tokensave_read. Pass exactly one input object per call; `lines` is `\"A-B\"` and `tokensave_body` requires `symbol` or `node_id`. Without an index, do not use it for project retrieval; never use it for shell commands or scripts that replace indexed reads."
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
