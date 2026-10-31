import fs from 'node:fs';
import { createInterface } from 'node:readline';
const attempts = new Map();
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (!Object.hasOwn(message, 'id')) continue;
  const params = message.params || {};
  fs.appendFileSync(process.env.CONTEXT_CALL_LOG, `${JSON.stringify(params)}\n`);
  const count = (attempts.get(params.name) || 0) + 1; attempts.set(params.name, count);
  const reply = result => console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  if (params.arguments?.failure) {
    console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: params.arguments.failure } })); continue;
  }
  if (params.arguments?.transport && count < 3) {
    console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'ECONNRESET' } })); continue;
  }
  if (params.name === 'tokensave_read') {
    const digest = 'a'.repeat(64);
    const text = params.arguments?.if_digest === digest ? 'unchanged: true' : `file: a\ndigest: ${digest}\n1\tuseful content`;
    reply({ content: [{ type: 'text', text }] }); continue;
  }
  reply({ content: [{ type: 'text', text: 'я'.repeat(20000) }] });
}
