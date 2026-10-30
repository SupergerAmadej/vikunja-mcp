// Prepare the exact reviewed backend source for the production Docker build.
// No repository state, deployment credentials or running service is consulted.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile,writeFile,mkdir,cp } from 'node:fs/promises';
import { join,resolve,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const resources=dirname(fileURLToPath(import.meta.url));
const destination=resolve(process.argv[2]??'/source');
const artifacts=resolve(process.argv[3]??'/source-artifacts');
const manifest=JSON.parse(await readFile(join(resources,'vikunja-2.7.1-atomic-fields.json'),'utf8'));
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
assert.match(manifest.commit,/^[a-f0-9]{40}$/);
assert.equal(manifest.patchFile,'vikunja-2.7.1-atomic-fields.patch');
const patch=await readFile(join(resources,manifest.patchFile));
assert.equal(digest(patch),manifest.patchSha256,'Patch digest mismatch');
const response=await fetch(manifest.sourceUrl,{signal:AbortSignal.timeout(180_000)});
assert.ok(response.ok,`Source download failed: HTTP ${response.status}`);
const bytes=Buffer.from(await response.arrayBuffer());
assert.equal(digest(bytes),manifest.sha256,'Source archive digest mismatch');
await mkdir(destination,{recursive:true});await mkdir(artifacts,{recursive:true});
const archive=join(artifacts,'original.tar.gz');await writeFile(archive,bytes);
const entries=execFileSync('tar',['-tzf',archive],{encoding:'utf8',maxBuffer:16*1024*1024}).split('\n').filter(Boolean);
assert.ok(entries.every(name=>name.startsWith(`vikunja-${manifest.commit}/`) && !name.split('/').includes('..')),'Unexpected archive path');
execFileSync('tar',['-xzf',archive,'--strip-components=1','-C',destination]);
for(const file of manifest.files) {
  assert.ok(!file.path.startsWith('/') && !file.path.split('/').includes('..'));
  if(file.beforeSha256!==null) assert.equal(digest(await readFile(join(destination,file.path))),file.beforeSha256,`Source mismatch: ${file.path}`);
}
execFileSync('git',['apply','--check',join(resources,manifest.patchFile)],{cwd:destination,stdio:'inherit'});
execFileSync('git',['apply',join(resources,manifest.patchFile)],{cwd:destination,stdio:'inherit'});
for(const file of manifest.files) assert.equal(digest(await readFile(join(destination,file.path))),file.afterSha256,`Patched source mismatch: ${file.path}`);
await writeFile(join(destination,'frontend/src/version.json'),'{"VERSION":"2.7.1+atomic-fields.1"}\n');
// Include the wrapper, pinned inputs, instructions and original license with the
// corresponding source served by the built frontend.
await cp(resources,join(destination,'upstream'),{recursive:true});
execFileSync('tar',['-czf',join(artifacts,'vikunja-2.7.1-atomic-fields.1.tar.gz'),'-C',destination,'.']);
await cp(join(destination,'LICENSE'),join(artifacts,'LICENSE'));
console.log(`Verified and applied atomic protocol ${manifest.protocol} at ${manifest.commit}.`);
