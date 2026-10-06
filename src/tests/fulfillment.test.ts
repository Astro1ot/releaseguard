import {test} from 'node:test';
import assert from 'node:assert/strict';
import {decodeEvent,fulfill} from '../fulfillment';
import {Pool} from 'pg';
const eventId='98e8a601-b874-403c-9938-0be165b4dfb1';
const orderId='c5de7105-1b79-4723-a4a1-9e91c535bbee';
test('event decoder rejects malformed, tombstone, oversized and foreign-shaped events',()=>{
  assert.deepEqual(decodeEvent(eventId,JSON.stringify({orderId})),{eventId,orderId});
  for(const raw of [null,'{','null','[]',JSON.stringify({orderId,extra:1}),JSON.stringify({orderId:'bad'}),'x'.repeat(4097)]) assert.equal(decodeEvent(eventId,raw),undefined);
  assert.equal(decodeEvent(null,JSON.stringify({orderId})),undefined);
});
test('quarantine storage failure rolls back and propagates so offset is not acknowledged',async()=>{
  const statements:string[]=[];let released=false;
  const pool={async connect(){return {async query(sql:string){statements.push(sql);if(sql.startsWith('INSERT'))throw Error('database unavailable');return {rows:[],rowCount:0};},release(){released=true;}};}} as unknown as Pool;
  await assert.rejects(fulfill(pool,{topic:'rg.orders',partition:0,offset:'17'},null,'{'),/database unavailable/);
  assert.equal(statements[0],'BEGIN');assert.equal(statements.at(-1),'ROLLBACK');
  assert.equal(statements.includes('COMMIT'),false);assert.equal(released,true);
});
