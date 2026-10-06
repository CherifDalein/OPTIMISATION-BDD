import { HttpError,idValue,integer } from './commandes.mjs';
// L'id de commande est fourni pour rester compatible avec le schéma sans séquence.
export async function acheter(pool,{commandeId,clientId,produitId,qte=1}) {
  [commandeId,clientId,produitId].forEach(idValue); qte=integer(qte,1,1,100);
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const r=await client.query(`UPDATE shopflow.produits SET stock=stock-$2
      WHERE id=$1 AND stock>=$2 RETURNING prix::text AS prix`,[produitId,qte]);
    if (!r.rows.length) throw new HttpError(409,'Produit absent ou stock insuffisant');
    await client.query(`INSERT INTO shopflow.commandes(id,client_id,created_at,statut,total)
      VALUES($1,$2,now(),'payee',$3::numeric*$4)`,[commandeId,clientId,r.rows[0].prix,qte]);
    await client.query(`INSERT INTO shopflow.lignes(commande_id,produit_id,qte,prix_unitaire)
      VALUES($1,$2,$3,$4::numeric)`,[commandeId,produitId,qte,r.rows[0].prix]);
    await client.query('COMMIT');
    return {id:String(commandeId),statut:'payee'};
  } catch (error) {
    await client.query('ROLLBACK'); throw error;
  } finally { client.release(); }
}
