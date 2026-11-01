import { AppServer } from '../ai-hooks/bin/context-runner.mjs';
import { contextPolicy, handoffPrompt } from '../ai-hooks/bin/context-policy.mjs';

export async function syncCodexContext({ check = false, cwd, client = new AppServer({ cwd, env: { ...process.env, HARNESS_CONTEXT_GENERATION_FILE: '' } }) } = {}) {
  try {
    await client.initialize(10000);
    const { config } = await client.request('config/read', { includeLayers: false }, 10000);
    const original = config.compact_prompt?.split('Harness automatic Handoff.')[0].trim();
    const prompt = [original, handoffPrompt].filter(Boolean).join('\n\n');
    const desired = { model_auto_compact_token_limit: contextPolicy.startTokens,
      model_auto_compact_token_limit_scope: 'total', compact_prompt: prompt };
    const edits = Object.entries(desired).filter(([key, value]) => config[key] !== value)
      .map(([keyPath, value]) => ({ keyPath, value, mergeStrategy: 'replace' }));
    if (edits.length && !check) await client.request('config/batchWrite', { edits }, 10000);
    console.log(`${edits.length && check ? '✗' : '✓'} Codex automatic Handoff: ${contextPolicy.startTokens} tokens`);
    return check && edits.length ? 1 : 0;
  } finally { client.close(); }
}
