-- Jeu déterministe synthétique. Ne pas utiliser sur une base métier.
-- Réinitialise uniquement les quatre tables du laboratoire shopflow.
BEGIN;
SET LOCAL search_path TO shopflow, public;
TRUNCATE TABLE shopflow.lignes, shopflow.commandes,
 shopflow.produits, shopflow.clients;
INSERT INTO clients
SELECT n, 'etudiant' || n || '@example.test', 'Client ' || n
FROM generate_series(1,1000) n;
INSERT INTO produits
SELECT n, 'Produit ' || n, (5 + (n % 80) * 1.25)::numeric(12,2), 100,
 jsonb_build_object('categorie', CASE WHEN n % 4 = 0 THEN 'livre'
 WHEN n % 4 = 1 THEN 'accessoire' ELSE 'materiel' END,
 'couleur', CASE WHEN n % 2 = 0 THEN 'bleu' ELSE 'noir' END)
FROM generate_series(1,200) n;
INSERT INTO commandes (id,client_id,created_at,statut,total)
SELECT n, 1 + ((n-1) % 1000),
 TIMESTAMPTZ '2026-01-01 00:00+00'
   + ((n*37) % 300) * INTERVAL '1 day'
   + (n % 86400) * INTERVAL '1 second',
 CASE WHEN n % 10 = 0 THEN 'en_attente'
 WHEN n % 10 = 1 THEN 'annulee' ELSE 'payee' END, 0
FROM generate_series(1,100000) n;
INSERT INTO lignes
SELECT o.id, p.id, 1 + (o.id % 3), p.prix
FROM commandes o
CROSS JOIN generate_series(0,2) rang
JOIN produits p ON p.id = 1 + ((o.id + rang*17) % 200);
UPDATE commandes o SET total = x.montant
FROM (SELECT commande_id, SUM(qte*prix_unitaire) montant
 FROM lignes GROUP BY commande_id) x
WHERE o.id = x.commande_id;
COMMIT;
ANALYZE shopflow.clients;
ANALYZE shopflow.produits;
ANALYZE shopflow.commandes;
ANALYZE shopflow.lignes;
-- Contrôles attendus : 1000, 200, 100000, 300000.
SELECT (SELECT count(*) FROM shopflow.clients) clients,
 (SELECT count(*) FROM shopflow.produits) produits,
 (SELECT count(*) FROM shopflow.commandes) commandes,
 (SELECT count(*) FROM shopflow.lignes) lignes;
-- Attendu : 0 total incohérent.
SELECT count(*) AS totaux_incoherents FROM shopflow.commandes o
JOIN (SELECT commande_id, SUM(qte*prix_unitaire) montant
 FROM shopflow.lignes GROUP BY commande_id) x ON x.commande_id=o.id
WHERE o.total <> x.montant;
