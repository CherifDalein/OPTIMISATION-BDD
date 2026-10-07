-- Connexion B, autocommit activé. A a exécuté BEGIN + SELECT sans COMMIT.
-- Sélectionner SET, puis ALTER, comme deux commandes séparées.
SET lock_timeout='2s';
ALTER TABLE shopflow.clients_migration_tp ADD COLUMN test_verrou integer;
-- Erreur attendue 55P03 : attente de verrou dépassée. Capturer erreur et durée.
-- Si B était dans une transaction, faire ROLLBACK avant de reprendre.

-- Après COMMIT dans A : resélectionner le même ALTER TABLE ci-dessus.
-- Cette seconde tentative doit réussir. Conserver la trace.
-- Après réussite, nettoyer uniquement la colonne de test.
ALTER TABLE shopflow.clients_migration_tp DROP COLUMN test_verrou;
RESET lock_timeout;
