// Read-only check. Run inside the MCP container so secrets stay in its environment.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const expectedVersion = '0.2.1';
const expectedSchema = '29e3884bb212eae8979e81047bb741ff0f484f0e353820421c51fe63c32d2f97';
const key = process.env.VIKUNJA_MCP_API_KEY;
assert.ok(key, 'VIKUNJA_MCP_API_KEY is missing');
const port = Number(process.env.PORT || 9090);
const required = process.env.VIKUNJA_REQUIRE_ATOMIC_UPDATES !== '0';
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => compare(a, b)).map(([k, v]) => [k, canonical(v)]),
  );
  return value;
}

async function ready(host) {
  const status = await new Promise((resolve, reject) => {
    const req = http.get({
      hostname: '127.0.0.1', port, path: '/readyz',
      headers: { Host: host, 'X-API-Key': key },
    }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.setTimeout(15_000, () => req.destroy(new Error('Readiness timed out')));
    req.on('error', reject);
  });
  assert.equal(status, 200, `Readiness failed for Host ${host}: HTTP ${status}`);
}

const client = new Client({ name: 'vikunja-upgrade-check', version: '1' });
try {
  await ready(`127.0.0.1:${port}`);
  if (process.env.VIKUNJA_VERIFY_HOST) await ready(process.env.VIKUNJA_VERIFY_HOST);

  const base = new URL(process.env.VIKUNJA_BASE_URL ?? process.env.VIKUNJA_API_URL ?? 'http://vikunja:3456');
  const path = base.pathname.replace(/\/+$/, '');
  base.pathname = `${path.endsWith('/api/v1') ? path : `${path}/api/v1`}/info`;
  const response = await fetch(base, { signal: AbortSignal.timeout(15_000) });
  assert.equal(response.status, 200, 'Backend info request failed');
  const backend = await response.json();
  if (required) assert.equal(backend.atomic_field_updates, 1, 'Atomic protocol 1 is missing');

  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { 'X-API-Key': key } },
  }));
  assert.equal(client.getServerVersion()?.version, expectedVersion, 'Wrong MCP version');
  const catalogue = await client.listTools();
  assert.equal(catalogue.tools.length, 42, 'Unexpected tool count');
  const tools = canonical(catalogue.tools.toSorted((a, b) => compare(a.name, b.name)));
  const schema = createHash('sha256').update(JSON.stringify(tools)).digest('hex');
  assert.equal(schema, expectedSchema, 'Tool schema differs from the reviewed contract');
  const health = await client.callTool({ name: 'vikunja_health', arguments: {} });
  assert.ok(!health.isError, 'The upstream read through MCP failed');
  console.log(JSON.stringify({
    ok: true, mcpVersion: expectedVersion, tools: tools.length, schemaSha256: schema,
    backendVersion: backend.version, atomicProtocol: backend.atomic_field_updates ?? null,
    atomicRequired: required, requestedHostAccepted: Boolean(process.env.VIKUNJA_VERIFY_HOST),
    writesPerformed: false,
  }, null, 2));
} finally {
  await client.close();
}
