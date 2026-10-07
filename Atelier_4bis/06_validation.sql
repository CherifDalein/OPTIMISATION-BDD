-- Exécuter séparément, autocommit activé.
ALTER TABLE shopflow.clients_migration_tp
  VALIDATE CONSTRAINT clients_newsletter_nn_tp;
-- Le CHECK valide prouve l'absence de NULL.
-- Conserver le CHECK pendant cette commande pour éviter un second scan.
ALTER TABLE shopflow.clients_migration_tp
  ALTER COLUMN newsletter_ok SET NOT NULL;
SELECT conname,convalidated FROM pg_constraint
WHERE conrelid = 'shopflow.clients_migration_tp'::regclass
  AND conname = 'clients_newsletter_nn_tp';
SELECT column_name,is_nullable,column_default FROM information_schema.columns
WHERE table_schema='shopflow' AND table_name='clients_migration_tp'
  AND column_name='newsletter_ok';
-- Attendu : CHECK validé, is_nullable = NO, column_default = false.
