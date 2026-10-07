-- PostgreSQL serveur, connexion A distincte de B.
-- Exécuter BEGIN + SELECT puis laisser la transaction ouverte.
BEGIN;
SELECT id FROM shopflow.clients_migration_tp LIMIT 1;
-- La connexion B tente maintenant son ALTER TABLE : elle doit échouer à ~2 s.
-- Après avoir conservé l'erreur de B, sélectionner COMMIT dans A.
COMMIT;
