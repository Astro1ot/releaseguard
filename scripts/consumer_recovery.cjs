const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {Client}=require('pg');
async function restarts(){
  const text=await (await fetch('http://127.0.0.1:3000/metrics')).text();
  return Number(text.match(/^rg_consumer_crashes_total (\d+)/m)?.[1] ?? 0);
}
async function main(){
  const client=new Client({connectionString:process.env.DATABASE_URL});await client.connect();
  let order;
  const before=await restarts();
  try {
    await client.query('BEGIN');
    await client.query('LOCK TABLE processed_events IN ACCESS EXCLUSIVE MODE');
    const response=await fetch('http://127.0.0.1:3000/api/orders',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':randomUUID()},body:JSON.stringify({productId:'asset-01'})});
    assert.equal(response.status,201);order=await response.json();
    // Keep the lock through the library's retry window until a crash is observed.
    for(let i=0;i<30 && await restarts()===before;i++) await new Promise(resolve=>setTimeout(resolve,1000));
    assert.ok(await restarts()>before,'did not exercise a consumer crash');
  } finally {await client.query('ROLLBACK').catch(()=>{});await client.end();}
  for(let i=0;i<60;i++){
    const result=await (await fetch('http://127.0.0.1:3000/api/orders/'+order.id)).json();
    if(result.status==='completed'){
      const attempts=await restarts()-before;
      assert.ok(attempts>0,'did not exercise a consumer crash');
      console.log(JSON.stringify({passed:true,consumerCrashes:attempts,orderId:order.id,status:result.status}));return;
    }
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
  throw Error('Consumer did not recover from database handler failure');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
