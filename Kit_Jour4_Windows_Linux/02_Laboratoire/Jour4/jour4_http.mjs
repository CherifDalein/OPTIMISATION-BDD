#!/usr/bin/env node
// Aide Linux du laboratoire. Node.js >= 22, modules standard uniquement.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const helperDir = path.dirname(fileURLToPath(import.meta.url));
function config() {
  if (!fs.existsSync('.env') || !fs.existsSync('server.mjs'))
    throw new Error('Placez-vous dans optimisationBDD/01_server/api.');
  const env = {};
  for (const line of fs.readFileSync('.env', 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z_]+)\s*=(.*)$/);
    if (match) env[match[1]] = match[2].trim().replace(/^(["'])(.*)\1$/, '$2');
  }
  if (!env.LAB_TOKEN) throw new Error('LAB_TOKEN manque dans .env.');
  if (Number(env.LAB_CLIENT_ID ?? 42) !== 42)
    throw new Error('Ces fiches utilisent LAB_CLIENT_ID=42. Redémarrez l’API après modification.');
  return { base: `http://127.0.0.1:${env.PORT ?? 3000}`, ttl: Number(env.CACHE_TTL_SECONDS ?? 5), token: env.LAB_TOKEN };
}
const columns = ['Date','Label','Method','Path','Status','SqlCount','Cache','HttpMs','TraceId','Prix','Ids'];
const csvValue = value => '"' + String(value ?? '').replaceAll('"', '""') + '"';
function save(row) {
  if (!process.env.J4_CSV) throw new Error('Charger Init_Jour4.sh avant les appels.');
  fs.appendFileSync(process.env.J4_CSV, columns.map(key => csvValue(row[key])).join(',') + '\n', 'utf8');
}
async function request(label, endpoint, method = 'GET', body, auth = true, allowError = false) {
  const conf = config();
  if (!endpoint.startsWith('/')) throw new Error('Le chemin doit commencer par /.');
  if (!['GET','PATCH'].includes(method)) throw new Error('Méthode attendue : GET ou PATCH.');
  const headers = auth ? { Authorization: `Bearer ${conf.token}` } : {};
  if (body !== undefined) { JSON.parse(body); headers['Content-Type'] = 'application/json'; }
  const start = performance.now();
  const response = await fetch(conf.base + endpoint, { method, headers, body, signal: AbortSignal.timeout(15000) });
  const raw = await response.text();
  const httpMs = Number((performance.now() - start).toFixed(3));
  const parsed = JSON.parse(raw);
  const result = { Label: label, Status: response.status,
    SqlCount: Number(response.headers.get('X-SQL-Count') ?? 0),
    Cache: response.headers.get('X-Cache') ?? '', HttpMs: httpMs,
    TraceId: response.headers.get('X-Trace-Id') ?? '', Body: parsed };
  save({ ...result, Date: new Date().toISOString(), Method: method, Path: endpoint,
    Prix: endpoint.startsWith('/produits/') ? parsed.data?.prix : '',
    Ids: endpoint.startsWith('/commandes') ? (parsed.data ?? []).map(row => row.id).join(',') : '' });
  if (!response.ok && !allowError) throw new Error(`HTTP ${response.status} : ${parsed.error ?? raw}`);
  return result;
}
function field(json, key) {
  let value = JSON.parse(json);
  for (const name of key.split('.')) {
    if (value === null || value === undefined || !(name in Object(value)))
      throw new Error(`Champ absent : ${key}`);
    value = value[name];
  }
  return value;
}
async function main() {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case 'init': {
      config();
      const folder = path.join(helperDir, 'resultats'); fs.mkdirSync(folder, { recursive: true });
      const file = path.join(folder, `mesures_linux_${new Date().toISOString().replace(/[-:.]/g, '')}_${randomUUID().slice(0,6)}.csv`);
      fs.writeFileSync(file, columns.map(csvValue).join(',') + '\n', 'utf8');
      console.log(file); break;
    }
    case 'config': {
      if (!['base','ttl'].includes(args[0])) throw new Error('Configuration attendue : base ou ttl.');
      console.log(config()[args[0]]); break;
    }
    case 'request': {
      if (args.length < 2) throw new Error('Usage : sf etiquette /chemin [GET|PATCH] [corpsJSON]');
      console.log(JSON.stringify(await request(...args))); break;
    }
    case 'field': {
      const value = field(args[0], args[1]);
      console.log(value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value)); break;
    }
    case 'ids': console.log(field(args[0], 'Body.data').map(row => row.id).join(',')); break;
    case 'encode': console.log(encodeURIComponent(args[0])); break;
    case 'list': {
      console.table(field(args[0], 'Body.data').map(row => ({
        Id: row.id, Date: row.created_at, Total: row.total, NombreLignes: row.lignes?.length
      }))); break;
    }
    case 'summary': {
      console.table(args.map(value => {
        const row = JSON.parse(value);
        return { Label: row.Label, Status: row.Status, Cache: row.Cache,
          SqlCount: row.SqlCount, HttpMs: row.HttpMs, TraceId: row.TraceId };
      })); break;
    }
    case 'code': {
      const result = await request('controle_droits', args[0], 'GET', undefined, args[1] !== 'sans-jeton', true);
      console.log(result.Status); break;
    }
    case 'wait': {
      if (!['true','false'].includes(args[0])) throw new Error('État Redis attendu : true ou false.');
      const ready = args[0] === 'true', until = Date.now() + 20000;
      do {
        const result = await request('etat_redis', '/observations');
        if (result.Body.redisPret === ready) return;
        await new Promise(resolve => setTimeout(resolve, 500));
      } while (Date.now() < until);
      throw new Error('L’état Redis attendu n’a pas été observé. Vérifiez le terminal API et Docker.');
    }
    default: throw new Error('Commande inconnue. Charger Init_Jour4.sh et utiliser sf.');
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
