import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,mkdir,symlink,link,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { uploadBytes } from '../dist/uploads.js';

test('uploads enforce opt-in, exactly one source, strict base64 and a byte bound',async()=>{
  const config={maxUploadBytes:3};
  await assert.rejects(uploadBytes({serverFilePath:'x'},config),/disabled/);
  for(const input of [{},{serverFilePath:'x',contentBase64:'eA=='}]) await assert.rejects(uploadBytes(input,config),/exactly one/);
  await assert.rejects(uploadBytes({contentBase64:'a???'},config),/base64/);
  await assert.rejects(uploadBytes({contentBase64:Buffer.from('four').toString('base64')},config),/exceeds/);
  assert.equal(Buffer.from(await uploadBytes({contentBase64:'YWJj'},config)).toString(),'abc');
});

test('local imports allow regular bounded files and reject path escapes and links',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'vikunja-import-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const root=join(dir,'imports');await mkdir(root);
  await writeFile(join(root,'small.txt'),'abc');await writeFile(join(root,'large.txt'),'toolarge');await writeFile(join(dir,'outside.txt'),'outside');
  const config={uploadDirectory:root,maxUploadBytes:3};
  assert.equal(Buffer.from(await uploadBytes({serverFilePath:'small.txt'},config)).toString(),'abc');
  for(const file of ['../outside.txt',join(dir,'outside.txt'),root]) await assert.rejects(uploadBytes({serverFilePath:file},config),/inside/);
  await assert.rejects(uploadBytes({serverFilePath:'large.txt'},config),/exceeds/);
  await mkdir(join(root,'subdir'));
  await assert.rejects(uploadBytes({serverFilePath:'subdir'},config));
  await link(join(dir,'outside.txt'),join(root,'hardlink.txt'));
  await assert.rejects(uploadBytes({serverFilePath:'hardlink.txt'},config),/regular file/);
  // Directory junctions work on Windows without the file-symlink privilege.
  await symlink(dir,join(root,'escape'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(uploadBytes({serverFilePath:'escape/outside.txt'},config),/symbolic links/);
});
