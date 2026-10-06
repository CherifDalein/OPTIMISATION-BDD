import {test} from 'node:test';
import assert from 'node:assert/strict';
import {encodeCursor,decodeCursor,integer,idValue} from '../commandes.mjs';
import {getProduit,updatePrix} from '../produits.mjs';
import {summarize,quantile} from '../../mesures/analyser.mjs';
test('Un curseur conserve les microsecondes et les grands identifiants, mais refuse une autre portée',()=>{
 const row={id:'9223372036854775807',created_at:'2026-12-01T12:00:00.123456Z'};
 const c=encodeCursor(row,'42','secret');
 const decoded=decodeCursor(c,'42','secret');
 assert.equal(decoded.date,row.created_at);assert.equal(decoded.id,row.id);
 assert.throws(()=>decodeCursor(c,'43','secret'));assert.throws(()=>decodeCursor(c+'x','42','secret'));
 assert.throws(()=>idValue('9223372036854775808'));assert.throws(()=>integer('1;DROP',20,1,100));
});
test('Une panne du cache garde la lecture BDD, une écriture signale l’invalidation échouée',async()=>{
 const offline=async()=>{throw new Error('offline')};const cache={get:offline,set:offline,del:offline};
 const query=async()=>({rows:[{id:'42',prix:'19.90'}]});
 const read=await getProduit(query,cache,'42');assert.equal(read.cache,'indisponible');
 assert.equal((await updatePrix(query,cache,'42','19.90')).invalidation,'echouee');
 await assert.rejects(getProduit(async()=>({rows:[]}),cache,'999'),{status:404});
});
test('Percentiles et débit excluent les réponses erronées et conservent leur taux',()=>{
 const rows=[10,20,30,40].map(duration_ms=>({duration_ms,status:200,valid:1,sql_count:2}));
 rows.push({duration_ms:1,status:503,valid:0,sql_count:0});
 const s=summarize(rows,2);assert.equal(s.p50_ms,20);assert.equal(s.p95_ms,40);
 assert.equal(s.throughput,2);assert.equal(s.errorPercent,20);assert.equal(s.meanSqlCount,2);
 assert.equal(quantile([],0.95),null);
});
