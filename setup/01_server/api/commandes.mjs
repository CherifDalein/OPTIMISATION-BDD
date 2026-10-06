import { createHmac, timingSafeEqual } from 'node:crypto';

export class HttpError extends Error {
  constructor(status,message) { super(message); this.status=status; }
}
export function integer(value,fallback,min,max) {
  if (value===null || value===undefined) return fallback;
  if (!/^\d+$/.test(String(value))) throw new HttpError(400,'Entier attendu');
  const n=Number(value);
  if (!Number.isSafeInteger(n) || n<min || n>max) throw new HttpError(400,'Valeur hors limites');
  return n;
}
export function idValue(value) {
  if (!/^[1-9]\d{0,18}$/.test(String(value)) || BigInt(value)>9223372036854775807n)
    throw new HttpError(400,'Identifiant invalide');
  return String(value);
}
function signature(payload,secret) {
  return createHmac('sha256',secret).update(payload).digest('base64url');
}
export function encodeCursor(row,clientId,secret) {
  const p=Buffer.from(JSON.stringify({v:1,clientId:String(clientId),
    date:row.created_at,id:row.id})).toString('base64url');
  return p+'.'+signature(p,secret);
}
export function decodeCursor(cursor,clientId,secret) {
  if (typeof cursor!=='string' || cursor.length>1000) throw new HttpError(400,'Curseur invalide');
  const [p,s,...extra]=cursor.split('.');
  const expected=signature(p??'',secret);
  if (extra.length || !p || !s || s.length!==expected.length ||
      !timingSafeEqual(Buffer.from(s),Buffer.from(expected)))
    throw new HttpError(400,'Signature du curseur invalide');
  let value;
  try { value=JSON.parse(Buffer.from(p,'base64url').toString('utf8')); }
  catch { throw new HttpError(400,'Format du curseur invalide'); }
  if (value.v!==1 || value.clientId!==String(clientId) ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value.date) ||
      !Number.isFinite(Date.parse(value.date))) throw new HttpError(400,'Portée du curseur invalide');
  idValue(value.id);
  return value;
}
const fields=`id::text AS id,
  to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
  statut,total::text AS total`;

export async function listCommandes(query,{clientId,limit=20,offset=0,cursor=null,
    pagination='curseur',relations='groupe',secret}) {
  idValue(clientId);
  limit=integer(limit,20,1,100); offset=integer(offset,0,0,1000000);
  if (!['offset','curseur'].includes(pagination) || !['n1','groupe'].includes(relations))
    throw new HttpError(400,'Mode inconnu');
  let params=[String(clientId),limit+1],sql;
  if (pagination==='offset') {
    params.push(offset);
    sql=`SELECT ${fields} FROM shopflow.commandes WHERE client_id=$1
      ORDER BY commandes.created_at DESC,commandes.id DESC LIMIT $2 OFFSET $3`;
  } else if (cursor) {
    const c=decodeCursor(cursor,clientId,secret);
    params.push(c.date,c.id);
    sql=`SELECT ${fields} FROM shopflow.commandes WHERE client_id=$1
      AND (created_at,id)<($3::timestamptz,$4::bigint)
      ORDER BY commandes.created_at DESC,commandes.id DESC LIMIT $2`;
  } else {
    sql=`SELECT ${fields} FROM shopflow.commandes WHERE client_id=$1
      ORDER BY commandes.created_at DESC,commandes.id DESC LIMIT $2`;
  }
  const result=await query(sql,params);
  const hasNextPage=result.rows.length>limit;
  const rows=result.rows.slice(0,limit);
  const lineSql=`SELECT commande_id::text AS commande_id,produit_id::text AS produit_id,
    qte,prix_unitaire::text AS prix_unitaire FROM shopflow.lignes`;
  if (relations==='n1') {
    for (const row of rows) row.lignes=(await query(
      lineSql+' WHERE commande_id=$1 ORDER BY lignes.produit_id',[row.id])).rows;
  } else if (rows.length) {
    const lines=(await query(lineSql+
      ' WHERE commande_id=ANY($1::bigint[]) ORDER BY lignes.commande_id,lignes.produit_id',
      [rows.map(r=>r.id)])).rows;
    const byId=new Map(rows.map(r=>[r.id,[]]));
    for (const line of lines) byId.get(line.commande_id).push(line);
    for (const row of rows) row.lignes=byId.get(row.id);
  }
  return {data:rows,hasNextPage,nextCursor:hasNextPage && rows.length
    ? encodeCursor(rows.at(-1),clientId,secret):null};
}

