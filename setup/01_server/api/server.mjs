import http from 'node:http';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createClient,commandOptions } from 'redis';
import { HttpError,integer,listCommandes } from './commandes.mjs';
import { getProduit,updatePrix } from './produits.mjs';

for (const name of ['DATABASE_URL','LAB_TOKEN','CURSOR_SECRET'])
  if (!process.env[name]) throw new Error(`Variable requise : ${name}`);
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,
  max:integer(process.env.POOL_MAX,5,1,100),connectionTimeoutMillis:1000,
  idleTimeoutMillis:10000,statement_timeout:5000,application_name:'shopflow-tp'});
pool.on('error',()=>console.error('Connexion PostgreSQL inactive perdue'));
const redis=createClient({url:process.env.REDIS_URL??'redis://127.0.0.1:56379',
  disableOfflineQueue:true,socket:{connectTimeout:500,reconnectStrategy:n=>Math.min(100*(n+1),1000)}});
redis.on('error',()=>console.error('Redis indisponible : repli vers PostgreSQL'));
// L'API peut démarrer lorsque le cache manque. PostgreSQL reste requis à la lecture.
redis.connect().catch(()=>{});
async function redisOperation(action) {
  if (!redis.isReady) throw new Error('Cache indisponible');
  const ac=new AbortController(); const timer=setTimeout(()=>ac.abort(),150);
  try { return await action(commandOptions({signal:ac.signal})); }
  finally { clearTimeout(timer); }
}
const cache={
  get:key=>redisOperation(o=>redis.get(o,key)),
  set:(key,value,ttl)=>redisOperation(o=>redis.set(o,key,value,{EX:ttl})),
  del:key=>redisOperation(o=>redis.del(o,key))
};
async function bodyJson(req) {
  const chunks=[];let size=0;
  for await (const b of req) {
    size+=b.length; if (size>8192) throw new HttpError(413,'Corps trop volumineux'); chunks.push(b);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400,'JSON invalide'); }
}
const server=http.createServer(async(req,res)=>{
  const start=performance.now(),trace=randomUUID();let sqlCount=0,sqlMs=0,cacheState;
  const query=async(text,params)=>{
    sqlCount++;const t=performance.now();
    try { return await pool.query(text,params); }
    finally { sqlMs+=performance.now()-t; }
  };
  let status=200,result;
  try {
    if (req.headers.authorization!==`Bearer ${process.env.LAB_TOKEN}`)
      throw new HttpError(401,'Jeton de laboratoire requis');
    const u=new URL(req.url,'http://127.0.0.1');
    if (req.method==='GET' && u.pathname==='/commandes') {
      // Le client vient du contexte autorisé, jamais d'un client_id fourni dans l'URL.
      if (u.searchParams.has('client_id')) throw new HttpError(400,'Client fourni par le contexte autorisé');
      result=await listCommandes(query,{
        clientId:String(integer(process.env.LAB_CLIENT_ID,42,1,1000)),
        limit:integer(u.searchParams.get('limit'),20,1,100),
        offset:integer(u.searchParams.get('offset'),0,0,1000000),
        cursor:u.searchParams.get('cursor'),pagination:u.searchParams.get('pagination')??'curseur',
        relations:u.searchParams.get('relations')??'groupe',secret:process.env.CURSOR_SECRET});
    } else if (u.pathname.match(/^\/produits\/\d+$/)) {
      const id=u.pathname.split('/').at(-1);
      if (req.method==='GET') {
        result=await getProduit(query,cache,id,integer(process.env.CACHE_TTL_SECONDS,5,1,3600));
        cacheState=result.cache;
      } else if (req.method==='PATCH') {
        result=await updatePrix(query,cache,id,(await bodyJson(req)).prix);
      } else throw new HttpError(405,'Méthode non prise en charge');
    } else if (req.method==='GET' && u.pathname==='/observations') {
      result={pool:{total:pool.totalCount,inactives:pool.idleCount,enAttente:pool.waitingCount},
        redisPret:redis.isReady};
    } else throw new HttpError(404,'Route absente');

  } catch (error) {
    // Affiche l'erreur technique dans le terminal de l'API.
    // La réponse HTTP conserve son message générique.
    console.error('Erreur pendant le traitement de la requête :', {
      route: req.url,
      message: error.message,
      code: error.code,
      cause: error.cause,
      stack: error.stack
    });

    status = error.status ?? 503;
    result = {
      error: error instanceof HttpError
        ? error.message
        : 'Service de données indisponible'
    };
  } 


  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',
    'X-SQL-Count':String(sqlCount),'X-Trace-Id':trace,...(cacheState?{'X-Cache':cacheState}:{})});
  res.end(JSON.stringify(result));
  console.log(JSON.stringify({trace,route:req.url,status,sqlCount,
    sqlMs:Number(sqlMs.toFixed(3)),durationMs:Number((performance.now()-start).toFixed(3)),
    poolWaiting:pool.waitingCount,cache:cacheState}));
});
server.requestTimeout=10000;
server.listen(integer(process.env.PORT,3000,1024,65535),'127.0.0.1',()=>
  console.log('API pédagogique disponible sur le port '+(process.env.PORT??3000)));
async function stop() {
  await new Promise(resolve=>server.close(resolve));
  if (redis.isOpen) redis.disconnect(); await pool.end();
}
for (const sig of ['SIGINT','SIGTERM']) process.once(sig,()=>stop().catch(console.error));
