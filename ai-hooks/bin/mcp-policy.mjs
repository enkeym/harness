import fs from 'node:fs';

const defaults = JSON.parse(fs.readFileSync(new URL('../mcp-policy.json', import.meta.url), 'utf8'));

export function loadMcpPolicy(env = process.env) {
  const overrides = env.HARNESS_MCP_POLICY_FILE ? JSON.parse(fs.readFileSync(env.HARNESS_MCP_POLICY_FILE, 'utf8')) : {};
  if (!overrides || Array.isArray(overrides) || typeof overrides !== 'object') throw new Error('Invalid MCP policy');
  const policy = { ...defaults, ...overrides };
  for (const [key, value] of Object.entries(policy)) {
    if (!Object.hasOwn(defaults, key) || (typeof defaults[key] === 'boolean' ? typeof value !== 'boolean' :
      !Number.isSafeInteger(value) || value < (key === 'retries' || key === 'artifactGraceMs' ? 0 : 1))) throw new Error(`Invalid MCP policy: ${key}`);
  }
  return policy;
}

export const mcpPolicy = loadMcpPolicy();
export const retryDelay = (attempt, policy = mcpPolicy) => policy.retryDelayMs * 2 ** attempt;

export function retryAllowed(kind, readOnly, attempt, policy = mcpPolicy) {
  return policy.errorsEnabled && readOnly && kind === 'transport' && attempt < policy.retries;
}
