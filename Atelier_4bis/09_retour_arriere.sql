-- Après capture des preuves, arrêter les requêtes du nouveau lecteur.
-- Ce retour de structure concerne uniquement la copie de laboratoire.
SET lock_timeout='2s';
BEGIN;
ALTER TABLE shopflow.clients_migration_tp
  DROP CONSTRAINT clients_newsletter_nn_tp;
ALTER TABLE shopflow.clients_migration_tp
  ALTER COLUMN newsletter_ok DROP NOT NULL,
  ALTER COLUMN newsletter_ok DROP DEFAULT;
COMMIT;
-- À ce stade, la colonne et ses valeurs existent encore.
-- Sélectionner DROP COLUMN uniquement pour terminer le TP sur la copie.
-- Cette commande détruit les valeurs de newsletter_ok.
ALTER TABLE shopflow.clients_migration_tp DROP COLUMN newsletter_ok;
SELECT count(*) AS colonne_restante FROM information_schema.columns
WHERE table_schema='shopflow' AND table_name='clients_migration_tp'
  AND column_name='newsletter_ok';
WITH differences AS (
 (SELECT id,email,nom FROM shopflow.clients_migration_tp
  EXCEPT ALL SELECT id,email,nom FROM shopflow.clients_migration_reference_tp)
 UNION ALL
 (SELECT id,email,nom FROM shopflow.clients_migration_reference_tp
  EXCEPT ALL SELECT id,email,nom FROM shopflow.clients_migration_tp)
)
SELECT count(*) AS ecarts_historiques FROM differences;
-- Attendu : colonne_restante = 0 et ecarts_historiques = 0.
RESET lock_timeout;
