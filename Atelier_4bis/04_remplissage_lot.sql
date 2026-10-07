-- Sélectionner le bloc WITH...SELECT et le relancer, en autocommit.
-- Une exécution = un lot validé. Ne pas englober tous les lots dans BEGIN.
WITH lot AS (
  SELECT id FROM shopflow.clients_migration_tp
  WHERE newsletter_ok IS NULL ORDER BY id LIMIT 200
), maj AS (
  UPDATE shopflow.clients_migration_tp c
  SET newsletter_ok = false FROM lot
  WHERE c.id = lot.id AND c.newsletter_ok IS NULL
  RETURNING c.id
)
SELECT count(*) AS nb_mises_a_jour FROM maj;
-- Avec 1000 clients : 5 passages à 200, puis un passage à 0.
-- Relever le nombre et la durée de chaque passage dans le client SQL.
-- Le filtre NULL conserve les valeurs explicites déjà présentes.

-- Sélectionner cette requête de suivi à part entre deux lots.
SELECT count(*) AS nb_null_restants
FROM shopflow.clients_migration_tp WHERE newsletter_ok IS NULL;
