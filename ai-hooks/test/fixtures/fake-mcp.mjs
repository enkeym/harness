import fs from 'node:fs';
import { createInterface } from 'node:readline';

fs.appendFileSync(process.env.FAKE_MCP_STARTS, 'start\n');
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (!Object.hasOwn(request, 'id')) return;
  let result = {};
  if (request.method === 'initialize') {
    result = { protocolVersion: process.env.FAKE_MCP_PROTOCOL || '2024-11-05', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'fake', version: '1' }, instructions: 'tokensave is a code-graph MCP server. Repeated routing guidance.' };
  } else if (request.method === 'tools/list') {
    result = { tools: [{ name: 'read', description: 'Read a bounded range.\n\ntokensave is a code-graph MCP server. Repeated routing guidance.', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }] };
  } else if (request.method === 'tools/call') {
    if (request.params.name === 'fail') {
      send({ jsonrpc: '2.0', id: request.id, error: { code: -32602, message: 'bad arguments' } });
      return;
    }
    if (request.params.name === 'more') send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    result = { content: [{ type: 'text', text: 'file content once' }], structuredContent: { distinctMetadata: 42 }, isError: false };
  }
  send({ jsonrpc: '2.0', id: request.id, result });
});
