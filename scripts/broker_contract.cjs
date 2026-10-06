// Run inside the API container; creates only synthetic events in the lab topic.
const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const {Kafka,logLevel} = require('kafkajs');
const {Pool} = require('pg');
async function main() {
  const db = new Pool({connectionString:process.env.DATABASE_URL});
  const kafka = new Kafka({clientId:'contract-check',brokers:process.env.KAFKA_BROKERS.split(','),logLevel:logLevel.NOTHING});
  const producer=kafka.producer(), admin=kafka.admin();
  try {
    await producer.connect(); await admin.connect();
    const response=await fetch('http://127.0.0.1:3000/api/orders',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':randomUUID()},body:JSON.stringify({productId:'asset-01'})});
    assert.equal(response.status,201);
    const order=await response.json();
    const event=(await db.query('SELECT id,payload FROM outbox WHERE order_id=$1',[order.id])).rows[0];
    const fakeKey=randomUUID();
    const malformed=await producer.send({topic:'rg.orders',messages:[{partition:0,key:randomUUID(),value:'{broken'}]});
    const forged=await producer.send({topic:'rg.orders',messages:[{partition:0,key:fakeKey,value:JSON.stringify({orderId:order.id})}]});
    const valid=await producer.send({topic:'rg.orders',messages:[{partition:0,key:event.id,value:JSON.stringify(event.payload)},{partition:0,key:event.id,value:JSON.stringify(event.payload)}]});
    const target=BigInt(valid[0].baseOffset)+2n;
    let passed=false;
    for(let i=0;i<60;i++) {
      const offsets=await admin.fetchOffsets({groupId:'rg.fulfillment',topics:['rg.orders']});
      const offset=offsets[0]?.partitions.find(p=>p.partition===0)?.offset ?? '-1';
      if(BigInt(offset)>=target){passed=true;break;}
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
    assert.ok(passed,'consumer did not advance past invalid events');
    const rejected=await db.query('SELECT reason FROM rejected_events WHERE topic=$1 AND partition_id=0 AND event_offset=ANY($2)', ['rg.orders',[malformed[0].baseOffset,forged[0].baseOffset]]);
    assert.deepEqual(rejected.rows.map(r=>r.reason).sort(),['invalid_payload','unrecognized_event']);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM processed_events WHERE event_id=$1',[event.id])).rows[0].n,1);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM processed_events WHERE event_id=$1',[fakeKey])).rows[0].n,0);
    assert.equal((await db.query('SELECT status FROM orders WHERE id=$1',[order.id])).rows[0].status,'completed');
    console.log(JSON.stringify({passed:true,invalidEvents:2,duplicateDeliveries:2,consumerAdvanced:true}));
  } finally { await Promise.allSettled([producer.disconnect(),admin.disconnect(),db.end()]); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
