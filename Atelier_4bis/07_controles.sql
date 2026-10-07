-- Test du défaut : exécuter ce bloc BEGIN...ROLLBACK seulement.
BEGIN;
INSERT INTO shopflow.clients_migration_tp (id,email,nom)
VALUES (1001,'defaut@example.test','Client défaut')
RETURNING id,newsletter_ok;
-- Attendu : newsletter_ok = false.
ROLLBACK;

-- Test de rejet : sélectionner cette commande seule, hors transaction.
UPDATE shopflow.clients_migration_tp SET newsletter_ok=NULL WHERE id=1;
-- Erreur attendue 23502 (NOT NULL). Ne pas exécuter tout le fichier en un bloc.

-- Après l'erreur attendue, sélectionner les contrôles ci-dessous.
SELECT count(*) AS nb_clients,
       count(*) FILTER (WHERE newsletter_ok IS NULL) AS nb_null,
       count(*) FILTER (WHERE newsletter_ok=false) AS nb_false
FROM shopflow.clients_migration_tp;
-- Attendu : 1000 / 0 / 1000 avec le jeu initial de l'exercice.
WITH differences AS (
 (SELECT id,email,nom FROM shopflow.clients_migration_tp
  EXCEPT ALL SELECT id,email,nom FROM shopflow.clients_migration_reference_tp)
 UNION ALL
 (SELECT id,email,nom FROM shopflow.clients_migration_reference_tp
  EXCEPT ALL SELECT id,email,nom FROM shopflow.clients_migration_tp)
)
SELECT count(*) AS ecarts_historiques FROM differences;
-- Attendu : 0. La migration conserve chaque champ historique.
