import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { captureToolContract } from '../scripts/tool-contract.mjs';

test('host-visible tools and server release match the reviewed public contract', async () => {
  const expected = JSON.parse(await readFile(new URL('../docs/tool-contract.json', import.meta.url), 'utf8'));
  const actual = await captureToolContract();
  assert.deepEqual(actual, expected, 'Review schema changes, then regenerate the documented contract');
  assert.equal(actual.server.version, JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version);
});
