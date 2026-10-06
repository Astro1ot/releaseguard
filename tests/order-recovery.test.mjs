import test from 'node:test';
import assert from 'node:assert/strict';
import {readOrder,confirmOrder,orderLock,STORAGE_KEY} from '../public/order-recovery.mjs';
const draft = {key:'saved-order-key',productId:'asset-01',status:'unknown'};
const response = {id:'98e8a601-b874-403c-9938-0be165b4dfb1',productId:'asset-01',status:'pending'};
test('unknown order survives reload with original key and product', () => {
  assert.deepEqual(readOrder({getItem(key){assert.equal(key,STORAGE_KEY); return JSON.stringify(draft);}}),draft);
});
test('corrupt storage never silently becomes a new order', () => {
  for (const raw of ['{','null',JSON.stringify({...draft,key:12345678}),JSON.stringify({...draft,status:'confirmed'})]) {
    assert.throws(() => readOrder({getItem:()=>raw}));
  }
  assert.throws(() => readOrder({getItem(){throw Error('blocked');}}), /blocked/);
});
test('response must belong to original product and stable order ID', () => {
  const confirmed=confirmOrder(draft,response);
  assert.equal(confirmed.id,response.id);
  for (const bad of [null,{}, {...response,productId:'asset-02'}, {...response,id:'invalid'}, {...response,status:'other'}]) {
    assert.throws(() => confirmOrder(draft,bad));
  }
  assert.throws(() => confirmOrder({...confirmed,id:'c5de7105-1b79-4723-a4a1-9e91c535bbee'},response));
});
test('another tab cannot create an order while the lock is held', async () => {
  let held=false, release;
  const wait=new Promise(resolve=>{release=resolve;});
  const locks={async request(name,options,action){
    assert.equal(name,'releaseguard.order'); assert.equal(options.ifAvailable,true);
    if(held)return action(null); held=true;
    try{return await action({});}finally{held=false;}
  }};
  const first=orderLock(locks,()=>wait);
  await assert.rejects(orderLock(locks,()=>assert.fail('must not send')));
  release();await first;
  assert.equal(await orderLock(locks,()=>42),42);
  await assert.rejects(orderLock(undefined,()=>assert.fail('must not send')));
});
