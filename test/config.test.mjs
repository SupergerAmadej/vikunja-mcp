import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { loadConfig } from '../dist/config.js';
import { cleanEnv,root } from './helpers/harness.mjs';
const secrets={VIKUNJA_TOKEN:'secret-token',VIKUNJA_MCP_API_KEY:'secret-key'};

test('config normalizes root, proxy paths and full v1 URLs with loopback defaults',()=>{
  assert.equal(loadConfig(secrets).host,'127.0.0.1');
  for(const [url,expected] of [['https://example.test/','https://example.test/api/v1'],['https://example.test/proxy/','https://example.test/proxy/api/v1'],['https://example.test/api/v1///','https://example.test/api/v1']]) {
    assert.equal(loadConfig({...secrets,VIKUNJA_BASE_URL:url}).baseApiUrl,expected);
  }
  assert.equal(loadConfig({...secrets,VIKUNJA_API_URL:'https://fallback.test'}).baseApiUrl,'https://fallback.test/api/v1');
  assert.equal(loadConfig(secrets).requireAtomicUpdates,true);
  assert.equal(loadConfig({...secrets,VIKUNJA_REQUIRE_ATOMIC_UPDATES:'1'}).requireAtomicUpdates,true);
  assert.equal(loadConfig({...secrets,VIKUNJA_REQUIRE_ATOMIC_UPDATES:'0'}).requireAtomicUpdates,false);
  assert.throws(()=>loadConfig({...secrets,VIKUNJA_REQUIRE_ATOMIC_UPDATES:'true'}),/VIKUNJA_REQUIRE_ATOMIC_UPDATES/);
});

test('explicit invalid settings are rejected without leaking secret values',()=>{
  for(const [key,value] of [['VIKUNJA_BASE_URL','not-a-url'],['VIKUNJA_BASE_URL','file:///secret-token'],['VIKUNJA_BASE_URL','https://user:secret-token@host/'],['VIKUNJA_BASE_URL','https://host/?token=secret-token'],['VIKUNJA_BASE_URL','https://host/#fragment'],['VIKUNJA_BASE_URL',''],['PORT','no'],['PORT','0'],['PORT','65536'],['PORT','1.5'],['VIKUNJA_TIMEOUT_MS','0'],['VIKUNJA_TIMEOUT_MS','bad'],['VIKUNJA_TIMEOUT_MS','2147483648'],['VIKUNJA_MAX_UPLOAD_BYTES','-1'],['VIKUNJA_MCP_ALLOWED_HOSTS','*'],['VIKUNJA_MCP_ALLOWED_ORIGINS','https://host/path'],['VIKUNJA_UPLOAD_DIRECTORY','does-not-exist'],['VIKUNJA_USER_ID','bad'],['VIKUNJA_MCP_VALIDATE_ONLY','yes'],['HOST',' ']]) {
    assert.throws(()=>loadConfig({...secrets,[key]:value}),error=>error.message.includes(key) && !error.message.includes('secret-token'),`${key}=${value}`);
  }
  assert.throws(()=>loadConfig({}),/VIKUNJA_TOKEN/);
});

test('validate-only process exits nonzero for invalid configuration',()=>{
  const result=spawnSync(process.execPath,['dist/index.js'],{cwd:root,env:{...cleanEnv(),...secrets,VIKUNJA_MCP_VALIDATE_ONLY:'1',VIKUNJA_BASE_URL:'not-a-url'},encoding:'utf8',windowsHide:true});
  assert.notEqual(result.status,0);assert.match(result.stderr,/VIKUNJA_BASE_URL/);
  const valid=spawnSync(process.execPath,['dist/index.js'],{cwd:root,env:{...cleanEnv(),...secrets,VIKUNJA_MCP_VALIDATE_ONLY:'1'},encoding:'utf8',windowsHide:true});
  assert.equal(valid.status,0);assert.match(valid.stderr,/config ok/);
});
