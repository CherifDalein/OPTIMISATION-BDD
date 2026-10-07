-- Session de migration. Autocommit activé, exécuter les commandes séparément.
SET lock_timeout = '2s';
ALTER TABLE shopflow.clients_migration_tp
  ADD COLUMN newsletter_ok boolean;
SELECT count(*) AS nb_null
FROM shopflow.clients_migration_tp WHERE newsletter_ok IS NULL;
-- Attendu : toutes les lignes existantes ont NULL, soit 1000 au jeu initial.
