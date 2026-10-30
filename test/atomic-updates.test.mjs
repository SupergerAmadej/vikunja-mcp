import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAtomicFieldUpdates } from '../dist/atomic-updates.js';

const response = data => ({ data, status: 200, headers: new Headers() });

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
