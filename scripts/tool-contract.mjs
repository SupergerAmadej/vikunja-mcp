import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, startMcp } from '../test/helpers/harness.mjs';

const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => compare(a, b)).map(([key, entry]) => [key, canonical(entry)]));
  return value;
}

export async function captureToolContract() {
  const upstream = await fixture();
  let mcp;
  try {
    mcp = await startMcp(upstream.url);
    const initialized = await mcp.rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'contract-check', version: '1' } });
    const catalogue = await mcp.rpc('tools/list');
    if (!initialized.data.result?.serverInfo || !catalogue.data.result?.tools) throw new Error('Unable to capture the MCP contract');
    const tools = canonical(catalogue.data.result.tools.toSorted((a, b) => compare(a.name, b.name)));
    return {
      server: initialized.data.result.serverInfo,
      schemaSha256: createHash('sha256').update(JSON.stringify(tools)).digest('hex'),
      tools,
    };
  } finally {
    await mcp?.close();
    await upstream.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const target = new URL('../docs/tool-contract.json', import.meta.url);
  const actual = await captureToolContract();
  if (process.argv.includes('--update')) {
    await writeFile(target, `${JSON.stringify(actual, null, 2)}\n`);
    console.log(`Recorded ${actual.tools.length} tools for ${actual.server.version}: ${actual.schemaSha256}`);
  } else {
    const expected = JSON.parse(await readFile(target, 'utf8'));
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('MCP tool contract changed. Review it and run npm run tool-contract:update intentionally.');
    console.log(`Tool contract matches ${actual.server.version}: ${actual.schemaSha256}`);
  }
}
