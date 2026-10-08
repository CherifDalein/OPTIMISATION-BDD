-- Atelier 7 : trois commandes du client 42 avec une date commune.
-- Base ShopFlow de laboratoire uniquement. Sauvegarde avant modification.
BEGIN;
DO $atelier$
BEGIN
  IF (SELECT count(*) FROM shopflow.commandes
      WHERE client_id=42 AND id IN (42,1042,2042)) <> 3 THEN
    RAISE EXCEPTION 'Jeu attendu absent : charger le jeu initial ShopFlow.';
  END IF;
END;
$atelier$;
CREATE TABLE IF NOT EXISTS shopflow.sauvegarde_dates_atelier07 (
  id bigint PRIMARY KEY,
  created_at timestamptz NOT NULL
);
INSERT INTO shopflow.sauvegarde_dates_atelier07 (id,created_at)
SELECT id,created_at FROM shopflow.commandes
WHERE client_id=42 AND id IN (42,1042,2042)
ON CONFLICT (id) DO NOTHING;
DO $atelier$
DECLARE date_commune timestamptz;
BEGIN
  -- Exclure les trois cibles rend le scénario répétable sur un jeu stable.
  SELECT COALESCE(max(created_at),TIMESTAMPTZ '2026-01-01 00:00+00')
         + INTERVAL '1 day'
  INTO date_commune
  FROM shopflow.commandes WHERE client_id=42 AND id NOT IN (42,1042,2042);
  UPDATE shopflow.commandes SET created_at=date_commune
  WHERE client_id=42 AND id IN (42,1042,2042);
END;
$atelier$;
COMMIT;
SELECT id,created_at FROM shopflow.commandes WHERE client_id=42
ORDER BY created_at DESC,id DESC LIMIT 3;
-- Attendu, dans cet ordre : 2042, 1042, 42, avec la même date.
