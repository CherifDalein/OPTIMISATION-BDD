import { HttpError, idValue } from './commandes.mjs';

export function productKey(id) { return `shopflow:produit:v1:${idValue(id)}`; }
// Cache-aside : la fonction query est fournie par le contexte HTTP.
// cache.get/set/del doivent refuser rapidement en cas de panne.
export async function getProduit(query,cache,id,ttl=5) {
  const key=productKey(id);
  let cacheState='miss';
  try {
    const value=await cache.get(key);
    if (value!==null) {
      try {
        const parsed=JSON.parse(value);
        if (parsed && parsed.id===String(id) && typeof parsed.prix==='string')
          return {data:parsed,cache:'hit'};
      } catch { /* Une valeur illisible déclenche un rechargement. */ }
    }
  } catch { cacheState='indisponible'; }
  const r=await query(`SELECT id::text AS id,nom,prix::text AS prix,stock,attributs
    FROM shopflow.produits WHERE id=$1`,[String(id)]);
  if (!r.rows.length) throw new HttpError(404,'Produit absent');
  const data=r.rows[0];
  try { await cache.set(key,JSON.stringify(data),ttl); }
  catch { cacheState='indisponible'; }
  return {data,cache:cacheState};
}
export async function updatePrix(query,cache,id,prix) {
  const key=productKey(id);
  // Un montant est une chaîne décimale exacte, sans conversion en flottant.
  if (typeof prix!=='string' || !/^\d{1,10}(\.\d{1,2})?$/.test(prix))
    throw new HttpError(400,'Prix attendu sous forme de chaîne décimale positive');
  const r=await query(`UPDATE shopflow.produits SET prix=$2::numeric
    WHERE id=$1 RETURNING id::text AS id,prix::text AS prix`,[String(id),prix]);
  if (!r.rows.length) throw new HttpError(404,'Produit absent');
  let invalidation='ok';
  // pool.query réalise ici une instruction autocommit : invalider après réussite.
  try { await cache.del(key); } catch { invalidation='echouee'; }
  return {data:r.rows[0],invalidation};
}
