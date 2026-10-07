-- Le contrôle doit donner 0 avant de poursuivre.
SELECT count(*) AS nb_null
FROM shopflow.clients_migration_tp WHERE newsletter_ok IS NULL;
-- NOT VALID évite la vérification immédiate des anciennes lignes.
-- PostgreSQL applique déjà ce CHECK aux nouvelles lignes et aux mises à jour.
ALTER TABLE shopflow.clients_migration_tp
  ADD CONSTRAINT clients_newsletter_nn_tp
  CHECK (newsletter_ok IS NOT NULL) NOT VALID;
SELECT conname,convalidated FROM pg_constraint
WHERE conrelid = 'shopflow.clients_migration_tp'::regclass
  AND conname = 'clients_newsletter_nn_tp';
-- Attendu : convalidated = false.
