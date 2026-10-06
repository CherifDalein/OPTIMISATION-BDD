-- PostgreSQL 18. Exécuter dans une base vide de laboratoire.
-- Les noms du cours appartiennent au schéma shopflow.
BEGIN;
CREATE SCHEMA IF NOT EXISTS shopflow;
SET LOCAL search_path TO shopflow, public;
CREATE TABLE clients (
 id bigint PRIMARY KEY,
 email text NOT NULL UNIQUE,
 nom text NOT NULL
);
CREATE TABLE produits (
 id bigint PRIMARY KEY,
 nom text NOT NULL,
 prix numeric(12,2) NOT NULL CHECK (prix >= 0),
 stock integer NOT NULL CHECK (stock >= 0),
 attributs jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE commandes (
 id bigint PRIMARY KEY,
 client_id bigint NOT NULL REFERENCES clients(id),
 created_at timestamptz NOT NULL,
 statut text NOT NULL CHECK (statut IN ('payee','en_attente','annulee')),
 total numeric(12,2) NOT NULL CHECK (total >= 0),
 cle_idempotence text,
 UNIQUE (client_id, cle_idempotence)
);
CREATE TABLE lignes (
 commande_id bigint NOT NULL REFERENCES commandes(id),
 produit_id bigint NOT NULL REFERENCES produits(id),
 qte integer NOT NULL CHECK (qte > 0),
 prix_unitaire numeric(12,2) NOT NULL CHECK (prix_unitaire >= 0),
 PRIMARY KEY (commande_id, produit_id)
);
COMMIT;
-- Dans chaque nouvelle session SQL du laboratoire :
SET search_path TO shopflow, public;
