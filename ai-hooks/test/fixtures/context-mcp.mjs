import fs from 'node:fs';
import crypto from 'node:crypto';
import { createInterface } from 'node:readline';
const attempts = new Map();
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (!Object.hasOwn(message, 'id')) continue;
  const params = message.params || {};
  fs.appendFileSync(process.env.CONTEXT_CALL_LOG, `${JSON.stringify(params)}\n`);
  const count = (attempts.get(params.name) || 0) + 1; attempts.set(params.name, count);
  const reply = result => console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  if (params.arguments?.failure && !(params.arguments.recover && count > 2)) {
    console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: /invalid argument/.test(params.arguments.failure) ? -32602 : -32000, message: params.arguments.failure } })); continue;
  }
  if (params.arguments?.transport && count < 3) {
    console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'ECONNRESET' } })); continue;
  }
  if (params.name === 'tokensave_read') {
    const payload = typeof params.arguments?.file === 'string' && fs.existsSync(params.arguments.file) ? fs.readFileSync(params.arguments.file, 'utf8') : null;
    const digest = payload === null ? 'a'.repeat(64) : crypto.createHash('sha256').update(payload).digest('hex');
    if (params.arguments?.invalidateGeneration && params.arguments.if_digest) fs.writeFileSync(process.env.HARNESS_CONTEXT_GENERATION_FILE, JSON.stringify({ v: 1, task: 'one', generation: count }));
    const text = !params.arguments?.force && params.arguments?.if_digest === digest ? 'unchanged: true' : `file: a\ndigest: ${digest}\n1\t${payload ?? 'useful content'}`;
    reply({ content: [{ type: 'text', text }] }); continue;
  }
  reply({ content: [{ type: 'text', text: 'я'.repeat(20000) }] });
}
