import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAtomicFieldUpdates } from '../dist/atomic-updates.js';

const response = data => ({ data, status: 200, headers: new Headers() });

test('capabilities route all eight tools to verified stock backends and identify operation limits', async () => {
  for (const version of ['2.7.0','v2.7.0','2.7.1','v2.7.1']) {
    let reads=0;
    const client=createAtomicFieldUpdates(async()=>{reads++;return response({version});},false);
    const info=await client.describe();
    assert.equal(info.backendVersion,version);assert.equal(info.updateMode,'stock');
    assert.equal(info.atomicUpdatesRequired,false);assert.equal(info.supportedUpdateTools.length,8);
    assert.ok(info.supportedUpdateTools.includes('complete_task'));
    assert.deepEqual(info.unsupportedOperations,['clear_nonempty_project_description']);
    assert.equal(await client.available(),false);assert.equal(reads,1);
  }
});

test('unknown or unverified stock versions are reported before writes rather than assumed compatible', async () => {
  for (const version of [undefined,'2.3.0','2.8.0','not a version']) {
    let writes=0;
    const client=createAtomicFieldUpdates(async(_path,init)=>{if(init)writes++;return response({version});},false);
    const info=await client.describe();
    assert.equal(info.updateMode,'blocked');assert.deepEqual(info.supportedUpdateTools,[]);
    await assert.rejects(client.available(),/Stock updates are verified only.*No changes were written/);
    assert.equal(writes,0);
  }
});

test('strict mode reports blocked capabilities, while an advertised patch permits description clearing', async () => {
  const strict=createAtomicFieldUpdates(async()=>response({version:'2.7.1'}),true);
  assert.equal((await strict.describe()).updateMode,'blocked');
  await assert.rejects(strict.available(),/Atomic field updates are required/);
  const patched=createAtomicFieldUpdates(async()=>response({version:'2.7.1+atomic-fields.1',atomic_field_updates:1}),false);
  const info=await patched.describe();assert.equal(info.updateMode,'atomic');
  assert.equal(info.supportedUpdateTools.length,8);assert.deepEqual(info.unsupportedOperations,[]);
  assert.equal(await patched.available(),true);
});

test('atomic updates discover a precise protocol version once and fail when required support is missing', async () => {
  for (const advertised of [undefined, 0, '1', 2]) {
    let calls=0;
    const client=createAtomicFieldUpdates(async()=>{calls++;return response({atomic_field_updates:advertised});},true);
    await assert.rejects(client.available(),/Atomic field updates are required/);
    await assert.rejects(client.available(),/Atomic field updates are required/);
    assert.equal(calls,1);
  }
  let calls=0;
  const client=createAtomicFieldUpdates(async()=>{calls++;return response({atomic_field_updates:1});},false);
  assert.equal(await client.available(),true);assert.equal(await client.available(),true);assert.equal(calls,1);
});

test('temporary capability discovery errors are not cached as an unsafe fallback', async () => {
  let calls=0;
  const client=createAtomicFieldUpdates(async()=>{if(++calls===1) throw new Error('Temporary info outage');return response({atomic_field_updates:1});},false);
  await assert.rejects(client.available(),/Temporary info outage/);assert.equal(calls,1);
  assert.equal(await client.available(),true);assert.equal(calls,2);
});

test('field writes use only the dedicated v2 route and classify an invalid success response as uncertain', async () => {
  const calls=[];
  const client=createAtomicFieldUpdates(async(path,init,version)=>{
    calls.push({path,init,version});return response(path.startsWith('/projects')?{id:7,title:'Edited'}:{message:'Not proof of a write'});
  },false);
  const result=await client.write('projects',7,{id:7,title:'Edited',description:'Stale'},['title']);
  assert.equal(result.title,'Edited');assert.equal(calls[0].path,'/projects/7/fields?format=html');assert.equal(calls[0].version,2);
  assert.deepEqual(JSON.parse(calls[0].init.body).update_fields,['title']);
  await assert.rejects(client.write('labels',7,{title:'Edited'},['title']),/write outcome is unknown/);
  assert.equal(calls.length,2);
  await assert.rejects(client.write('projects',7,{},[]),/non-empty field mask/);assert.equal(calls.length,2);
});

test('a failed advertised atomic write is never retried through a stock route', async () => {
  const calls=[];
  const client=createAtomicFieldUpdates(async(path,init)=>{
    calls.push(path);
    if(!init)return response({version:'2.7.1+atomic-fields.1',atomic_field_updates:1});
    throw Object.assign(new Error('Write outcome uncertain'),{status:503});
  },false);
  assert.equal(await client.available(),true);
  await assert.rejects(client.write('tasks',1,{title:'Requested'},['title']),/Write outcome uncertain/);
  assert.deepEqual(calls,['/info','/tasks/1/fields?format=html']);
});
