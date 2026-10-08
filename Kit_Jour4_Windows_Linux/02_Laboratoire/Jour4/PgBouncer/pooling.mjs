#!/usr/bin/env node
// Node >= 22, aucune dépendance npm. Même pilote sous Windows et Linux.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const dir = path.dirname(fileURLToPath(import.meta.url));
const prefix = ['compose', '-p', 'shopflow-j4-pooling', '-f', path.join(dir, 'compose.yaml')];
const results = path.join(dir, 'resultats');
const help = `Commandes (depuis le dossier PgBouncer) :
  node pooling.mjs up
  node pooling.mjs check
  node pooling.mjs compare [--clients 40] [--seconds 20] [--repeats 3] [--connect]
  node pooling.mjs saturation [--seconds 20]
  node pooling.mjs observe
  node pooling.mjs logs
  node pooling.mjs down
  node pooling.mjs reset --confirm
compare : ordre alterné direct/pool, échauffement séparé, mesures CSV et traces.
saturation : 80 clients, PostgreSQL limité à 60, PgBouncer limité à 5 serveurs.
down conserve les données ; reset --confirm supprime seulement le volume de ce labo.`;
let active = null;
process.on('SIGINT', () => {
  console.error('\nInterruption : arrêter le labo avec node pooling.mjs down avant de reprendre.');
  active?.kill('SIGTERM');
  process.exit(130);
});
function command(args, { live = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', [...prefix, ...args], { cwd: dir, shell: false });
    let stdout = '', stderr = '';
    child.stdout.on('data', b => { stdout += b; if (live) process.stdout.write(b); });
    child.stderr.on('data', b => { stderr += b; if (live) process.stderr.write(b); });
    child.on('error', reject);
    child.on('close', code => resolve({ code: code ?? 130, stdout, stderr }));
    if (args.includes('pgbench')) active = child;
  });
}
async function must(args, options) {
  const r = await command(args, options);
  if (r.code !== 0) throw new Error(`Docker (${r.code}) : ${r.stderr || r.stdout}`);
  return r.stdout;
}
function pg(sql) {
  return must(['exec', '-T', 'db', 'psql', '-X', '-U', 'postgres', '-d', 'pooling', '-v', 'ON_ERROR_STOP=1', '-Atc', sql]);
}
function admin(sql) {
  return must(['exec', '-T', '-e', 'PGPASSWORD=observation-local', 'bench', 'psql', '-X', '-h', 'pgbouncer', '-p', '6432', '-U', 'observateur', '-d', 'pgbouncer', '-v', 'ON_ERROR_STOP=1', '-c', sql]);
}
const activitySql = `SELECT json_build_object('total',count(*),
 'active',count(*) FILTER(WHERE state='active'),
 'idle',count(*) FILTER(WHERE state='idle'),
 'idle_in_transaction',count(*) FILTER(WHERE state='idle in transaction'))
 FROM pg_stat_activity WHERE datname='pooling' AND usename='atelier';`;
async function check() {
  console.log(await pg('SELECT version(); SHOW max_connections; SELECT count(*) AS produits FROM public.produits;'));
  console.log(await must(['exec', '-T', 'pgbouncer', 'pgbouncer', '--version']));
  console.log(await must(['exec', '-T', 'bench', 'pgbench', '--version']));
  for (const [host, port] of [['db','5432'], ['pgbouncer','6432']]) {
    const count = await must(['exec', '-T', 'bench', 'psql', '-X', '-h', host, '-p', port, '-U', 'atelier', '-d', 'pooling', '-v', 'ON_ERROR_STOP=1', '-Atc', 'SELECT count(*) FROM public.produits']);
    if (count.trim() !== '1000') throw new Error(`${host} : 1000 produits attendus, reçu ${count}`);
    console.log(`${host}:${port} : 1000 produits accessibles avec le rôle atelier.`);
  }
  console.log(await admin('SHOW CONFIG;'));
}
const csv = values => values.map(v => '"' + String(v ?? '').replaceAll('"','""') + '"').join(',') + '\n';
export function parseBench(text) {
  const match = regex => text.match(regex)?.[1] ?? '';
  return {
    tps: match(/^tps = ([\d.]+)/m),
    latencyMs: match(/^latency average = ([\d.]+) ms/m),
    transactions: match(/^number of transactions actually processed: (\d+)/m),
    failed: match(/^number of failed transactions: (\d+)/m)
  };
}
function options(args) {
  const o = { clients: 40, seconds: 20, repeats: 3, connect: false };
  for (let i=0;i<args.length;i++) {
    if (args[i] === '--connect') { o.connect = true; continue; }
    const key = args[i].replace(/^--/,'');
    if (!['clients','seconds','repeats'].includes(key)) throw new Error(`Option inconnue : ${args[i]}`);
    const value = Number(args[++i]);
    const bounds = { clients:[1,50], seconds:[5,120], repeats:[1,5] }[key];
    if (!Number.isInteger(value) || value<bounds[0] || value>bounds[1]) throw new Error(`${key} attendu entre ${bounds.join(' et ')}`);
    o[key] = value;
  }
  return o;
}
function benchArgs(route, o, warm=false) {
  return ['exec','-T','bench','pgbench','-h',route==='direct'?'db':'pgbouncer',
    '-p',route==='direct'?'5432':'6432','-U','atelier','-n','-M','simple',
    '-f','/lab/charge.sql','-c',String(warm?4:o.clients),'-j','2',
    '-T',String(warm?5:o.seconds),'-P','5', ...(o.connect?['-C']:[]),'pooling'];
}
async function runOne(route, o, folder, index, expectedFailure) {
  // Évite de compter des connexions PgBouncer inactives dans le scénario direct.
  if (route==='direct') await must(['stop','pgbouncer']);
  else await must(['up','-d','--wait','pgbouncer']);
  console.log(`\n${index} / ${route} / ${o.clients} clients / ${o.connect?'reconnexion':'persistant'}`);
  await must(benchArgs(route,o,true)); // Hors mesures, même échauffement des deux côtés.
  const label = `${index}_${route}`;
  const snapshots = path.join(folder, `${label}_observations.txt`);
  const samples = path.join(folder, `${label}_connexions.csv`);
  fs.writeFileSync(samples,csv(['timestamp','total','active','idle','idle_in_transaction']));
  let stop=false, peak=0, sampleCount=0;
  const warnings=[];
  // Une seule observation à la fois ; pas d'empilement d'appels Docker.
  const monitor = (async()=> {
    while (!stop) {
      try {
        const a=JSON.parse((await pg(activitySql)).trim());
        peak=Math.max(peak,Number(a.total)); sampleCount++;
        fs.appendFileSync(samples,csv([new Date().toISOString(),a.total,a.active,a.idle,a.idle_in_transaction]));
        if(route==='pool') fs.appendFileSync(snapshots, `\n${new Date().toISOString()}\n${await admin('SHOW POOLS;')}`);
      } catch(e) { warnings.push(e.message); }
      if(!stop) await new Promise(r=>setTimeout(r,1000));
    }
  })();
  const start=Date.now();
  let r;
  try { r=await command(benchArgs(route,o),{live:true}); }
  finally { stop=true; await monitor; }
  const raw=r.stdout+'\n'+r.stderr;
  fs.writeFileSync(path.join(folder,`${label}_pgbench.txt`),raw);
  const parsed=parseBench(raw);
  const row=[label,route,o.clients,o.seconds,o.connect?'reconnexion':'persistant',r.code,
    parsed.transactions,parsed.failed,parsed.tps,parsed.latencyMs,peak,sampleCount,(Date.now()-start)/1000];
  fs.appendFileSync(path.join(folder,'synthese.csv'),csv(row));
  if(warnings.length) {
    fs.writeFileSync(path.join(folder,`${label}_avertissements.txt`),warnings.join('\n'));
    console.warn('Observations incomplètes : consulter le fichier avertissements.');
  }
  if(route==='pool') fs.appendFileSync(snapshots, '\nFIN\n'+await admin('SHOW STATS;'));
  if(r.code!==0 && !expectedFailure) throw new Error(`Charge interrompue : consulter ${label}_pgbench.txt`);
  if(r.code!==0) console.log('Échec direct attendu à 80 clients : vérifier le message de limite de connexions dans la trace.');
  console.log(`Pic ÉCHANTILLONNÉ : ${peak} connexions ; échantillons : ${sampleCount}.`);
}
async function campaign(o, saturation=false) {
  fs.mkdirSync(results,{recursive:true});
  const folder=path.join(results,`${new Date().toISOString().replace(/[:.]/g,'-')}_${saturation?'saturation':o.connect?'reconnexion':'persistant'}`);
  fs.mkdirSync(folder);
  console.log(`Résultats : ${folder}`);
  fs.writeFileSync(path.join(folder,'synthese.csv'),csv(['essai','route','clients','secondes_demandees','mode','code_sortie','transactions','transactions_echouees','tps','latence_moyenne_ms','pic_connexions_echantillonne','nb_echantillons','duree_pilote_s']));
  fs.writeFileSync(path.join(folder,'configuration.txt'),JSON.stringify(o,null,2)+'\n'
    +await pg('SELECT version(); SHOW max_connections;')
    +await must(['exec','-T','pgbouncer','pgbouncer','--version'])
    +await admin('SHOW CONFIG;')
    +'\n'+await must(['images']));
  try {
    for(let i=1;i<=o.repeats;i++) {
      const order=i%2===1?['direct','pool']:['pool','direct'];
      for(const route of order) await runOne(route,o,folder,i,saturation&&route==='direct');
    }
  } finally {
    await must(['up','-d','--wait','pgbouncer']);
  }
  console.log(`\nCampagne terminée. Lire synthese.csv et les traces dans ${folder}`);
}
async function main() {
  const [cmd,...args]=process.argv.slice(2);
  switch(cmd) {
    case 'up':
      await must(['up','-d','--build','--wait'],{live:true}); await check(); break;
    case 'check': await check(); break;
    case 'compare': await campaign(options(args)); break;
    case 'saturation': {
      if(args.some(a=>a.startsWith('--')&&a!=='--seconds')) throw new Error('Seule option : --seconds');
      const o=options(args); o.clients=80;o.repeats=1;o.connect=false;
      await campaign(o,true);break;
    }
    case 'observe': console.log(await pg(activitySql)); console.log(await admin('SHOW POOLS;')); console.log(await admin('SHOW STATS;')); break;
    case 'logs': console.log(await must(['logs','--tail','100','db','pgbouncer'])); break;
    case 'down': await must(['down'],{live:true}); break;
    case 'reset':
      if(args.join(' ')!=='--confirm') throw new Error('Pour effacer uniquement ce laboratoire : reset --confirm');
      await must(['down','--volumes'],{live:true}); break;
    case undefined: case 'help': case '--help': console.log(help); break;
    default: throw new Error(`Commande inconnue : ${cmd}\n${help}`);
  }
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  main().catch(e=>{ console.error(e.message);process.exitCode=1; });
}
