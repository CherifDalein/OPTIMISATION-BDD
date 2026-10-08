-- Atelier 7 : restituer uniquement les trois dates sauvegardées.
-- Exécuter après 07_dates_identiques.sql, dans la même base de laboratoire.
BEGIN;
DO $atelier$
DECLARE nb integer;
BEGIN
  SELECT count(*) INTO nb FROM shopflow.sauvegarde_dates_atelier07
  WHERE id IN (42,1042,2042);
  IF nb NOT IN (0,3) THEN
    RAISE EXCEPTION 'Sauvegarde incomplète : restauration interrompue.';
  END IF;
  IF nb=3 AND (SELECT count(*) FROM shopflow.commandes
      WHERE client_id=42 AND id IN (42,1042,2042)) <> 3 THEN
    RAISE EXCEPTION 'Les trois commandes à restaurer sont absentes.';
  END IF;
  IF nb=0 THEN RAISE NOTICE 'Aucune date en attente de restauration.'; END IF;
END;
$atelier$;
WITH restauration AS (
  UPDATE shopflow.commandes c SET created_at=s.created_at
  FROM shopflow.sauvegarde_dates_atelier07 s
  WHERE c.id=s.id AND c.client_id=42 AND c.id IN (42,1042,2042)
  RETURNING c.id
)
SELECT count(*) AS dates_restaurees FROM restauration;
DELETE FROM shopflow.sauvegarde_dates_atelier07 WHERE id IN (42,1042,2042);
COMMIT;
SELECT id,created_at FROM shopflow.commandes WHERE id IN (42,1042,2042)
ORDER BY id;
-- Attendu au premier passage : dates_restaurees = 3.
