import test from 'node:test';
import assert from 'node:assert/strict';
import { serializedUpdate } from '../dist/updates.js';

test('per-object queues serialize edits, allow independent objects and release failures',async()=>{
  let release;
  const barrier=new Promise(resolve=>release=resolve);
  const order=[];
  const first=serializedUpdate('one',async()=>{order.push('first');await barrier;throw new Error('write failed');});
  const firstFailure=assert.rejects(first,/write failed/);
  const second=serializedUpdate('one',async()=>{order.push('second');return 2;});
  await serializedUpdate('other',async()=>order.push('other'));
  assert.deepEqual(order,['first','other']);release();
  await firstFailure;assert.equal(await second,2);assert.deepEqual(order,['first','other','second']);
  assert.equal(await serializedUpdate('one',async()=>3),3);
});
