-- Atelier 4 bis. PostgreSQL 18, base de laboratoire ShopFlow préparée.
-- Autocommit activé. Ce fichier se lance une seule fois.
-- Une table déjà présente provoque un arrêt : ne pas l'écraser.
CREATE TABLE shopflow.clients_migration_tp
  (LIKE shopflow.clients INCLUDING ALL);
INSERT INTO shopflow.clients_migration_tp (id,email,nom)
SELECT id,email,nom FROM shopflow.clients;
CREATE TABLE shopflow.clients_migration_reference_tp AS
SELECT id,email,nom FROM shopflow.clients_migration_tp;
SELECT current_database() AS base, version() AS version;
SELECT count(*) AS nb_clients FROM shopflow.clients_migration_tp;
-- Attendu avec le jeu initial : 1000. Si différent, documenter le volume réel.
