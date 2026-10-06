import assert from 'node:assert/strict';
const base=process.env.API_URL??'http://127.0.0.1:3000';
const headers={Authorization:`Bearer ${process.env.LAB_TOKEN}`};
async function get(path) {
  const r=await fetch(base+path,{headers});assert.equal(r.status,200);
  return {body:await r.json(),count:Number(r.headers.get('X-SQL-Count')),cache:r.headers.get('X-Cache')};
}
const n1=await get('/commandes?limit=20&relations=n1');
const grouped=await get('/commandes?limit=20&relations=groupe');
assert.deepEqual(n1.body,grouped.body);
assert.equal(n1.count,21);assert.equal(grouped.count,2);
const seen=new Set();let cursor=null,pages=0;
do {
  const r=await get('/commandes?limit=20'+(cursor?'&cursor='+encodeURIComponent(cursor):''));
  for (const o of r.body.data) {assert(!seen.has(o.id));seen.add(o.id);assert.equal(o.lignes.length,3);}
  cursor=r.body.nextCursor;pages++;
} while(cursor && pages<20);
assert.equal(seen.size,100);assert.equal(pages,5);
const unauthorized=await fetch(base+'/commandes');assert.equal(unauthorized.status,401);
const crossClient=await fetch(base+'/commandes?client_id=43',{headers});assert.equal(crossClient.status,400);
console.log('Pagination, équivalence, N+1 et portée du client : OK');
// Lire le produit, valider un nouveau prix puis relire immédiatement.
const initial=await get('/produits/42');
try {
  const patch=await fetch(base+'/produits/42',{method:'PATCH',headers:{...headers,
    'Content-Type':'application/json'},body:JSON.stringify({prix:'19.90'})});
  assert.equal(patch.status,200);
  const result=await patch.json(); assert.equal(result.invalidation,'ok');
  const first=await get('/produits/42');const second=await get('/produits/42');
  assert.equal(first.body.data.prix,'19.90');assert.equal(second.body.data.prix,'19.90');
  assert.equal(first.cache,'miss');assert.equal(first.count,1);
  assert.equal(second.cache,'hit');assert.equal(second.count,0);
  const ttl=Number(process.env.CACHE_TTL_SECONDS??5);
  await new Promise(r=>setTimeout(r,(ttl+1)*1000));
  const expired=await get('/produits/42');assert.equal(expired.cache,'miss');assert.equal(expired.count,1);
  console.log('Cache hit/miss, invalidation et expiration : OK');
} finally {
  await fetch(base+'/produits/42',{method:'PATCH',headers:{...headers,'Content-Type':'application/json'},
    body:JSON.stringify({prix:initial.body.data.prix})});
}
// Panne : arrêter Redis séparément et vérifier GET /produits/42 selon TP08.
