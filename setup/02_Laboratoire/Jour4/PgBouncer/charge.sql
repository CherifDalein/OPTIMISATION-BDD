-- Même transaction pour les deux chemins ; protocole simple dans pgbench.
\set produit random(1, 1000)
BEGIN;
SELECT prix FROM public.produits WHERE id = :produit;
-- Attente artificielle tenant une connexion serveur pendant la transaction.
SELECT pg_sleep(0.05);
COMMIT;
-- Temps de réflexion côté client : la connexion serveur peut être réutilisée.
\sleep 100 ms
