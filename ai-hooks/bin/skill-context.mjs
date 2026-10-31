#!/usr/bin/env node
import fs from 'node:fs';

try {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (['SessionStart', 'UserPromptSubmit'].includes(input.hook_event_name)) {
    const core = fs.readFileSync(new URL('../../rules/core.md', import.meta.url), 'utf8');
    const section = input.hook_event_name === 'SessionStart' ? 'Skills and hooks' : 'Skill reminder';
    const routing = core.split(`\n## ${section}\n`)[1]?.split('\n## ')[0].trim();
    if (!routing) throw new Error('Skill routing instructions are missing');
    process.stdout.write(`${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: input.hook_event_name,
        additionalContext: `Harness skill instructions:\n${routing}`,
      },
    })}\n`);
  }
} catch {
  process.stderr.write('Harness skill context could not be loaded. Read the shared rules and applicable skills before continuing.\n');
  process.exitCode = 1;
}
