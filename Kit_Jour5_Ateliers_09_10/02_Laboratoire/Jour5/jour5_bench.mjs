#!/usr/bin/env node
// Atelier 9 - courbe de charge HTTP ShopFlow
// Node.js >= 22, modules standard uniquement.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const helperDir = path.dirname(fileURLToPath(import.meta.url));
const resultDir = path.join(helperDir, 'resultats');
fs.mkdirSync(resultDir, { recursive: true });

function parseEnvFile(file = '.env') {
  if (!fs.existsSync(file)) throw new Error('Placez-vous dans optimisationBDD/01_server/api : .env introuvable.');
  const env = {};
  for (const line of fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    env[m[1]] = m[2].trim().replace(/^("|')(.*)\1$/, '$2');
  }
  return env;
}

function config() {
  if (!fs.existsSync('server.mjs')) throw new Error('server.mjs introuvable. Lancez le script depuis optimisationBDD/01_server/api.');
  const env = parseEnvFile('.env');
  if (!env.LAB_TOKEN) throw new Error('LAB_TOKEN manque dans .env.');
  return {
    base: `http://127.0.0.1:${env.PORT ?? 3000}`,
    token: env.LAB_TOKEN,
    clientId: Number(env.LAB_CLIENT_ID ?? 42),
  };
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const args = { command };
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i];
    if (!key.startsWith('--')) throw new Error(`Argument inattendu : ${key}`);
    const name = key.slice(2);
    const value = rest[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Valeur manquante pour --${name}`);
    args[name] = value;
    i++;
  }
  return args;
}

function safeLabel(value) {
  if (!/^[A-Za-z0-9_-]{1,60}$/.test(value ?? ''))
    throw new Error('Le label doit contenir uniquement lettres, chiffres, _ ou - (60 caractères max).');
  return value;
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index];
}

const csvCell = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
function writeCsv(file, columns, rows) {
  const out = [columns.map(csvCell).join(',')];
  for (const row of rows) out.push(columns.map(c => csvCell(row[c])).join(','));
  fs.writeFileSync(file, out.join('\n') + '\n', 'utf8');
}

async function oneRequest(conf, endpoint) {
  const start = performance.now();
  try {
    const response = await fetch(conf.base + endpoint, {
      headers: { Authorization: `Bearer ${conf.token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    const raw = await response.text();
    const ms = performance.now() - start;
    if (!response.ok) {
      return { ok: false, status: response.status, ms, sql: Number(response.headers.get('X-SQL-Count') ?? 0),
        trace: response.headers.get('X-Trace-Id') ?? '', error: raw.slice(0, 160) };
    }
    // Vérifie que la réponse est bien du JSON sans conserver le contenu en mémoire.
    JSON.parse(raw);
    return { ok: true, status: response.status, ms, sql: Number(response.headers.get('X-SQL-Count') ?? 0),
      trace: response.headers.get('X-Trace-Id') ?? '', error: '' };
  } catch (error) {
    return { ok: false, status: 0, ms: performance.now() - start, sql: 0, trace: '', error: error.message };
  }
}

async function loadPhase(conf, endpoint, clients, seconds, record) {
  const until = performance.now() + seconds * 1000;
  let seq = 0;
  const rows = [];
  async function worker(workerId) {
    while (performance.now() < until) {
      const id = ++seq;
      const at = new Date().toISOString();
      const r = await oneRequest(conf, endpoint);
      if (record) rows.push({ At: at, Clients: clients, Worker: workerId, Seq: id, Status: r.status,
        Ok: r.ok, HttpMs: r.ms.toFixed(3), SqlCount: r.sql, TraceId: r.trace, Error: r.error });
    }
  }
  const start = performance.now();
  await Promise.all(Array.from({ length: clients }, (_, i) => worker(i + 1)));
  return { rows, wallSeconds: (performance.now() - start) / 1000 };
}

function summaryFrom(rows, clients, warmup, seconds, wallSeconds, label, endpoint) {
  const ok = rows.filter(r => r.Ok === true);
  const lat = ok.map(r => Number(r.HttpMs)).sort((a, b) => a - b);
  const sql = ok.map(r => Number(r.SqlCount));
  const errors = rows.length - ok.length;
  const sum = lat.reduce((a, b) => a + b, 0);
  return {
    Label: label,
    Path: endpoint,
    Clients: clients,
    WarmupSec: warmup,
    MeasureSec: seconds,
    Completed: rows.length,
    Errors: errors,
    ErrorPct: rows.length ? (errors * 100 / rows.length).toFixed(2) : '0.00',
    ThroughputReqSec: wallSeconds ? (rows.length / wallSeconds).toFixed(2) : '0.00',
    P50Ms: percentile(lat, 0.50).toFixed(2),
    P95Ms: percentile(lat, 0.95).toFixed(2),
    MeanMs: lat.length ? (sum / lat.length).toFixed(2) : '0.00',
    AvgSqlPerRequest: sql.length ? (sql.reduce((a, b) => a + b, 0) / sql.length).toFixed(2) : '0.00',
  };
}

function svgLineChart(title, series, valueKey, yLabel, outFile) {
  const width = 1100, height = 620, left = 95, right = 40, top = 75, bottom = 85;
  const plotW = width - left - right, plotH = height - top - bottom;
  const xs = [...new Set(series.flatMap(s => s.rows.map(r => Number(r.Clients))))].sort((a,b)=>a-b);
  const values = series.flatMap(s => s.rows.map(r => Number(r[valueKey]))).filter(Number.isFinite);
  const maxY = Math.max(1, ...values) * 1.12;
  const x = v => left + (xs.length <= 1 ? plotW/2 : xs.indexOf(v) * plotW / (xs.length - 1));
  const y = v => top + plotH - (Number(v) / maxY) * plotH;
  const colors = ['#123a52', '#00a5b5', '#c56a2d', '#5b6b7a'];
  let svg = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`;
  svg += `<rect width="100%" height="100%" fill="white"/><text x="${left}" y="38" font-family="Arial" font-size="28" font-weight="700" fill="#123a52">${title}</text>`;
  for (let i=0;i<=5;i++) {
    const yy = top + plotH - i*plotH/5;
    const val = maxY*i/5;
    svg += `<line x1="${left}" y1="${yy}" x2="${left+plotW}" y2="${yy}" stroke="#d8e2e8"/><text x="${left-12}" y="${yy+5}" text-anchor="end" font-family="Arial" font-size="14" fill="#4f5f69">${val.toFixed(val < 10 ? 1 : 0)}</text>`;
  }
  svg += `<line x1="${left}" y1="${top}" x2="${left}" y2="${top+plotH}" stroke="#6b7d88"/><line x1="${left}" y1="${top+plotH}" x2="${left+plotW}" y2="${top+plotH}" stroke="#6b7d88"/>`;
  for (const xv of xs) svg += `<text x="${x(xv)}" y="${top+plotH+28}" text-anchor="middle" font-family="Arial" font-size="15" fill="#33434d">${xv}</text>`;
  svg += `<text x="${left+plotW/2}" y="${height-22}" text-anchor="middle" font-family="Arial" font-size="16" fill="#33434d">Clients simultanés</text>`;
  svg += `<text transform="translate(24 ${top+plotH/2}) rotate(-90)" text-anchor="middle" font-family="Arial" font-size="16" fill="#33434d">${yLabel}</text>`;
  series.forEach((s, si) => {
    const pts = s.rows.map(r => `${x(Number(r.Clients))},${y(Number(r[valueKey]))}`).join(' ');
    svg += `<polyline fill="none" stroke="${colors[si%colors.length]}" stroke-width="4" points="${pts}"/>`;
    s.rows.forEach(r => svg += `<circle cx="${x(Number(r.Clients))}" cy="${y(Number(r[valueKey]))}" r="6" fill="${colors[si%colors.length]}"/>`);
    svg += `<rect x="${left + si*250}" y="${height-58}" width="22" height="5" fill="${colors[si%colors.length]}"/><text x="${left+30+si*250}" y="${height-51}" font-family="Arial" font-size="15" fill="#33434d">${s.name}</text>`;
  });
  svg += '</svg>';
  fs.writeFileSync(outFile, svg, 'utf8');
}

function readSummary(label) {
  const file = path.join(resultDir, `${safeLabel(label)}_resume.json`);
  if (!fs.existsSync(file)) throw new Error(`Résumé introuvable : ${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function run(args) {
  const conf = config();
  const label = safeLabel(args.label);
  const endpoint = args.path;
  if (!endpoint?.startsWith('/')) throw new Error('--path doit commencer par /.');
  const clientsList = String(args.clients ?? '1,5,10,20').split(',').map(Number);
  if (!clientsList.length || clientsList.some(v => !Number.isInteger(v) || v < 1 || v > 200))
    throw new Error('--clients attend une liste comme 1,5,10,20 (1 à 200).');
  const warmup = Number(args.warmup ?? 10), seconds = Number(args.seconds ?? 30);
  if (!(warmup >= 0 && warmup <= 120 && seconds >= 5 && seconds <= 600)) throw new Error('Durées invalides.');

  console.log(`API ${conf.base} | client labo ${conf.clientId} | scénario ${label}`);
  console.log(`Charge fermée | warmup ${warmup}s | mesure ${seconds}s | ${endpoint}`);
  const allRaw = [], summaries = [];
  for (const clients of clientsList) {
    console.log(`\n[${label}] ${clients} client(s) - échauffement...`);
    if (warmup > 0) await loadPhase(conf, endpoint, clients, warmup, false);
    console.log(`[${label}] ${clients} client(s) - mesure...`);
    const phase = await loadPhase(conf, endpoint, clients, seconds, true);
    allRaw.push(...phase.rows);
    const s = summaryFrom(phase.rows, clients, warmup, seconds, phase.wallSeconds, label, endpoint);
    summaries.push(s);
    console.table([s]);
    if (Number(s.ErrorPct) >= 2) console.warn('Attention : erreurs >= 2 %. Vérifiez la saturation avant de poursuivre.');
    if (Number(s.P95Ms) >= 5000) console.warn('Attention : p95 >= 5 s. Le poste de laboratoire peut être proche de la saturation.');
  }

  const rawCols = ['At','Clients','Worker','Seq','Status','Ok','HttpMs','SqlCount','TraceId','Error'];
  const sumCols = ['Label','Path','Clients','WarmupSec','MeasureSec','Completed','Errors','ErrorPct','ThroughputReqSec','P50Ms','P95Ms','MeanMs','AvgSqlPerRequest'];
  writeCsv(path.join(resultDir, `${label}_brut.csv`), rawCols, allRaw);
  writeCsv(path.join(resultDir, `${label}_resume.csv`), sumCols, summaries);
  fs.writeFileSync(path.join(resultDir, `${label}_resume.json`), JSON.stringify(summaries, null, 2), 'utf8');
  svgLineChart(`${label} - p95`, [{ name: label, rows: summaries }], 'P95Ms', 'p95 (ms)', path.join(resultDir, `${label}_p95.svg`));
  svgLineChart(`${label} - débit`, [{ name: label, rows: summaries }], 'ThroughputReqSec', 'requêtes/s', path.join(resultDir, `${label}_debit.svg`));
  console.log(`\nRésultats : ${resultDir}`);
}

function compare(args) {
  const before = safeLabel(args.before), after = safeLabel(args.after);
  const a = readSummary(before), b = readSummary(after);
  const by = rows => new Map(rows.map(r => [Number(r.Clients), r]));
  const ma = by(a), mb = by(b);
  const levels = [...new Set([...ma.keys(), ...mb.keys()])].sort((x,y)=>x-y);
  const rows = levels.filter(c => ma.has(c) && mb.has(c)).map(c => {
    const x = ma.get(c), y = mb.get(c);
    const p95a = Number(x.P95Ms), p95b = Number(y.P95Ms), da = Number(x.ThroughputReqSec), db = Number(y.ThroughputReqSec);
    return {
      Clients: c,
      AvantP95Ms: p95a.toFixed(2), ApresP95Ms: p95b.toFixed(2),
      ReductionP95Pct: p95a ? (((p95a-p95b)/p95a)*100).toFixed(1) : '0.0',
      AvantReqSec: da.toFixed(2), ApresReqSec: db.toFixed(2), FacteurDebit: da ? (db/da).toFixed(2) : '0.00',
      AvantErreurPct: x.ErrorPct, ApresErreurPct: y.ErrorPct,
      AvantSqlReq: x.AvgSqlPerRequest, ApresSqlReq: y.AvgSqlPerRequest,
    };
  });
  const base = `${before}_vs_${after}`;
  writeCsv(path.join(resultDir, `${base}_comparaison.csv`), Object.keys(rows[0] ?? {Clients:''}), rows);
  svgLineChart(`${before} vs ${after} - p95`, [{name: before, rows:a},{name: after, rows:b}], 'P95Ms', 'p95 (ms)', path.join(resultDir, `${base}_p95.svg`));
  svgLineChart(`${before} vs ${after} - débit`, [{name: before, rows:a},{name: after, rows:b}], 'ThroughputReqSec', 'requêtes/s', path.join(resultDir, `${base}_debit.svg`));
  console.table(rows);
  console.log(`Comparaison : ${resultDir}`);
}

function help() {
  console.log(`Usage:\n  node jour5_bench.mjs run --label avant_n1 --path "/commandes?limit=20&pagination=curseur&relations=n1" --clients 1,5,10,20 --warmup 10 --seconds 30\n  node jour5_bench.mjs compare --before avant_n1 --after apres_groupe\n\nLe script doit être lancé depuis optimisationBDD/01_server/api.`);
}

const args = parseArgs(process.argv.slice(2));
try {
  if (args.command === 'run') await run(args);
  else if (args.command === 'compare') compare(args);
  else help();
} catch (error) {
  console.error(`ERREUR : ${error.message}`);
  process.exitCode = 1;
}
