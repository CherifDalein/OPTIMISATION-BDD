-- Simuler l'ancien lecteur. Les champs historiques restent accessibles.
SELECT id,email,nom FROM shopflow.clients_migration_tp ORDER BY id LIMIT 5;
-- Simuler le nouveau lecteur : NULL signifie absence d'autorisation.
SELECT id,email,COALESCE(newsletter_ok,false) AS newsletter_autorisee
FROM shopflow.clients_migration_tp ORDER BY id LIMIT 5;
-- Test d'anciens et nouveaux écrivains. Les lignes de test ne persistent pas.
BEGIN;
INSERT INTO shopflow.clients_migration_tp (id,email,nom)
VALUES (1001,'ancien@example.test','Client ancien');
INSERT INTO shopflow.clients_migration_tp (id,email,nom,newsletter_ok)
VALUES (1002,'nouveau@example.test','Client nouveau',false);
SELECT id,newsletter_ok FROM shopflow.clients_migration_tp WHERE id IN (1001,1002);
-- Attendu : 1001 / NULL et 1002 / false.
ROLLBACK;
-- Défaut pour les écritures suivantes. Les anciennes lignes restent NULL.
ALTER TABLE shopflow.clients_migration_tp
  ALTER COLUMN newsletter_ok SET DEFAULT false;
SELECT count(*) AS nb_null
FROM shopflow.clients_migration_tp WHERE newsletter_ok IS NULL;
-- Le défaut ne remplit pas les lignes existantes : attendu 1000.
