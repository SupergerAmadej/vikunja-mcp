import { createHash } from 'node:crypto';
import { execFileSync,spawnSync } from 'node:child_process';
import { readFile,writeFile,mkdir,mkdtemp } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root=fileURLToPath(new URL('../',import.meta.url));
const manifest=JSON.parse(await readFile(join(root,'upstream/vikunja-2.7.1-atomic-fields.json'),'utf8'));
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const patch=await readFile(join(root,'upstream',manifest.patchFile));
assert.equal(digest(patch),manifest.patchSha256,'Upstream patch digest mismatch');
const cache=join(root,'.tmp/atomic-proof');await mkdir(cache,{recursive:true});
const archive=join(cache,`source-${manifest.sha256}.tar.gz`);
let bytes;
try {bytes=await readFile(archive);} catch(error) {if(error.code!=='ENOENT') throw error;}
if(!bytes) {
  const response=await fetch(manifest.sourceUrl);
  if(!response.ok) throw new Error(`Pinned source download failed: HTTP ${response.status}`);
  bytes=Buffer.from(await response.arrayBuffer());
  assert.equal(digest(bytes),manifest.sha256,'Pinned upstream source digest mismatch');
  await writeFile(archive,bytes);
}
assert.equal(digest(bytes),manifest.sha256,'Cached upstream source digest mismatch');
const run=await mkdtemp(join(cache,'run-'));
const source=join(run,'source'),output=join(run,'output');await mkdir(source);await mkdir(output);
const entries=execFileSync('tar',['-tzf',archive],{encoding:'utf8',maxBuffer:16*1024*1024,windowsHide:true}).split(/\r?\n/).filter(Boolean);
const prefix=`vikunja-${manifest.commit}/`;
assert.ok(entries.every(name=>name.startsWith(prefix) && !name.split('/').includes('..')),'Unexpected archive path');
execFileSync('tar',['-xzf',archive,'--strip-components=1','--exclude=*/.claude*','--exclude=*/CLAUDE.md','-C',source],{stdio:'inherit',windowsHide:true});
for(const file of manifest.files) {
  if(file.beforeSha256===null) continue;
  assert.equal(digest(await readFile(join(source,file.path))),file.beforeSha256,`Source mismatch: ${file.path}`);
}
await writeFile(join(source,'_atomic-fields.patch'),patch);
const docker=(args,options={})=>execFileSync('docker',args,{cwd:root,stdio:'inherit',windowsHide:true,...options});
docker(['build','--platform','linux/amd64','-f',join(root,'upstream/atomic-fields.Dockerfile'),'--output',`type=local,dest=${output}`,source]);
const runner=`vikunja-mcp:atomic-proof-${manifest.patchSha256.slice(0,12)}`;
docker(['build','--platform','linux/amd64','--target','build','-t',runner,'.']);
function check(binary,label) {
  const args=['run','--rm','--platform','linux/amd64',
    '--mount',`type=bind,source=${join(root,'test')},target=/app/test,readonly`,
    '--mount',`type=bind,source=${output},target=/backend,readonly`,
    '-e',`TEST_VIKUNJA_BINARY=/backend/${binary}`,
    '-e',`TEST_REQUIRE_ATOMIC=${label==='patched'?'1':'0'}`,runner,
    'node','--test','--test-reporter=tap','test/integration/atomic-fields.test.mjs'];
  const result=spawnSync('docker',args,{cwd:root,encoding:'utf8',maxBuffer:16*1024*1024,windowsHide:true});
  if(result.error) throw result.error;
  return writeFile(join(output,`${label}.tap`),result.stdout+result.stderr).then(()=>result);
}
const negative=await check('vikunja-base','negative-control');
assert.notEqual(negative.status,0,'Negative control unexpectedly passed');
for(const name of [
  'reminder replacement preserves an external scalar task edit',
  'project title edits preserve an external description, identifier and color',
  'label title edits preserve an external description and color',
]) assert.ok(negative.stdout.includes(`- ${name}`) && new RegExp(`not ok \\d+ - ${name}`).test(negative.stdout),`Missing expected negative-control failure: ${name}`);
console.log('Negative control reproduced the three remaining stock 2.7.1 replacement failures.');
const positive=await check('vikunja-atomic','patched');
if(positive.status!==0) {
  process.stdout.write(positive.stdout);process.stderr.write(positive.stderr);
  throw new Error(`Patched atomic integration failed; inspect ${output}`);
}
process.stdout.write(positive.stdout);
const evidence={sourceCommit:manifest.commit,sourceSha256:manifest.sha256,patchSha256:manifest.patchSha256,protocol:manifest.protocol,negativeControl:'three remaining stock 2.7.1 replacement failures reproduced',patchedIntegration:'passed',output};
await writeFile(join(output,'verification.json'),`${JSON.stringify(evidence,null,2)}\n`);
console.log(`Upstream field-update proof passed. Logs and test binaries: ${output}`);
