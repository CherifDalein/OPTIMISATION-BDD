# Dossier de preuves — ShopFlow

Auteur : Cherif. Ateliers 1 à 4. PostgreSQL 18.6 Debian, aarch64, 64 bits ; essais SQL depuis pgAdmin sur la base de laboratoire `shopflow`.

## Organisation des preuves

Chaque atelier présente les SQL, la méthode, les valeurs relevées, la comparaison et la décision. Les plans complets figurent exclusivement en annexes dans ce document. Les prochaines expériences pourront être ajoutées avec la même structure.

| Atelier | Question | Preuve principale |
|---|---|---|
| 1 | Quel travail coûte à l’état initial ? | Historique et agrégation mesurés ; référence sans optimisation. |
| 2 | Réécrire sans changer le résultat pertinent | Contenu contrôlé, cinq mesures par variante. |
| 3 | Quel index pour les 20 dernières commandes ? | Même SQL du client 42 dans quatre états, tailles et plans. |
| 4 | Quand les index spécialisés sont-ils utilisables ? | Filtres, opérateurs, résultats et tailles. |

Lecture des statistiques : p50 = médiane ; p95 empirique sur cinq mesures = maximum (rang ceil(0,95 × 5)). Les mesures portent sur Execution Time ; elles ne sont pas des temps API. Les conclusions de durée sont limitées aux séries et paramètres présentés.


## Atelier 1 — Diagnostic initial

### 1. Tester l’état initial

Base `shopflow`, PostgreSQL **18.6 Debian, aarch64, 64 bits**. Volumes vérifiés : **1 000 clients, 200 produits, 100 000 commandes, 300 000 lignes**.

```sql
SELECT version();
SELECT
 (SELECT count(*) FROM shopflow.clients) AS clients,
 (SELECT count(*) FROM shopflow.produits) AS produits,
 (SELECT count(*) FROM shopflow.commandes) AS commandes,
 (SELECT count(*) FROM shopflow.lignes) AS lignes;
```

**Historique du client 42 :**

```sql
SELECT id, created_at, statut, total
FROM shopflow.commandes
WHERE client_id = 42
ORDER BY created_at DESC, id DESC;
```

```sql
SELECT count(*) AS nombre_commandes, sum(total) AS montant_total
FROM shopflow.commandes WHERE client_id = 42;
```

Résultat : **100 commandes ; 47 760,00**.

**Agrégation par statut :**

```sql
SELECT statut, count(*) AS nombre_commandes, sum(total) AS montant_total
FROM shopflow.commandes
GROUP BY statut ORDER BY statut;
```

| Statut | Commandes | Montant |
|---|---:|---:|
| annulee | 10 000 | 3 049 912,50 |
| en_attente | 10 000 | 2 974 962,50 |
| payee | 80 000 | 23 750 126,25 |

```sql
SELECT sum(total) FROM shopflow.commandes;
```

Contrôle : **29 775 001,25**, égal à la somme des trois groupes.

### 2. Mesurer

Méthode : contrôle du résultat, une exécution d’échauffement puis cinq répétitions du même SQL avec `EXPLAIN (ANALYZE, BUFFERS)`. Durée retenue : `Execution Time` (hors `Planning Time`). Échauffement exclu des statistiques.

Préfixer chacune des deux requêtes de lecture par :

```sql
EXPLAIN (ANALYZE, BUFFERS)
```

| État / requête | 1 (ms) | 2 | 3 | 4 | 5 | Moyenne | p50 |
|---|---:|---:|---:|---:|---:|---:|---:|
| Historique client 42 | 0,827 | 1,737 | 2,474 | 1,829 | 1,607 | 1,695 | 1,737 |
| Agrégation par statut | 42,761 | 41,124 | 61,019 | 48,577 | 54,799 | 49,656 | 48,577 |

### 3. Expliquer le coût observé

| Requête | Preuve du plan | Explication |
|---|---|---|
| Historique | Bitmap Index Scan + Bitmap Heap Scan ; 100 lignes, 88 blocs table ; hit=90 ; tri 29 kB | L’index unique initial sur `(client_id, cle_idempotence)` filtre le client ; les lignes doivent être récupérées puis triées. |
| Par statut | Seq Scan de 100 000 lignes + HashAggregate ; 3 groupes ; hit=1674 ; agrégation 32 kB | Chaque commande contribue à un compte et une somme, même si le résultat n’a que trois lignes. |

À la cinquième mesure, `HashAggregate` termine à **54,463 ms**, son enfant à **18,073 ms** : environ **36,390 ms** de travail propre à l’agrégation. Les temps et buffers parents incluent les enfants : ne pas les additionner.

**Décision :** conserver ce diagnostic comme référence initiale. Cet atelier mesure l’état existant, sans changement de SQL ni ajout d’index.

**Plans : annexe A1.**

## Atelier 2 — Réécriture équivalente

### 1. Tester et contrôler le contenu

**Duplication du client 42 :**

```sql
SELECT count(*) AS lignes_retournees, count(DISTINCT c.id) AS clients_distincts
FROM shopflow.clients c
JOIN shopflow.commandes o ON o.client_id = c.id
WHERE c.id = 42;
```

Résultat : **100 lignes, 1 client distinct**. Granularité recherchée : une ligne par client ayant une commande.

**Avant — jointure dédupliquée :**

```sql
SELECT DISTINCT c.id, c.nom
FROM shopflow.clients c
JOIN shopflow.commandes o ON o.client_id = c.id
WHERE c.id = 42;
```

**Solution — existence d’une commande :**

```sql
SELECT c.id, c.nom
FROM shopflow.clients c
WHERE c.id = 42 AND EXISTS (
 SELECT 1 FROM shopflow.commandes o WHERE o.client_id = c.id
);
```

Contrôle : les deux variantes retournent **une ligne identique : 42, Client 42**.

### 2. Mesurer et comparer JOIN DISTINCT / EXISTS

Méthode : contrôle du résultat, une exécution d’échauffement puis cinq répétitions du même SQL avec `EXPLAIN (ANALYZE, BUFFERS)`. Durée retenue : `Execution Time` (hors `Planning Time`). Échauffement exclu des statistiques.

Préfixer chaque variante ci-dessus par `EXPLAIN (ANALYZE, BUFFERS)`.

| État / requête | 1 (ms) | 2 | 3 | 4 | 5 | Moyenne | p50 |
|---|---:|---:|---:|---:|---:|---:|---:|
| JOIN DISTINCT | 0,455 | 0,245 | 0,295 | 0,862 | 0,366 | 0,445 | 0,366 |
| EXISTS | 0,219 | 0,384 | 0,296 | 0,498 | 0,459 | 0,371 | 0,384 |

| Avant | Après | Mécanisme |
|---|---|---|
| Nested Loop : 100 lignes, puis HashAggregate | Nested Loop Semi Join : une correspondance, sans déduplication | EXISTS s’arrête à la première commande trouvée. |
| hit=6 | hit=6 | Même nombre d’accès aux blocs en cache. |

Moyenne : **−16,5 %** ; médiane : **+4,9 %**. **Décision :** retenir EXISTS pour exprimer le besoin et réduire les lignes intermédiaires ; le gain de durée n’est pas uniforme dans l’échantillon.

### 3. Corriger le total par commande

**Erreur initiale :**

```sql
SELECT o.id, sum(o.total) AS total_incorrect
FROM shopflow.commandes o
JOIN shopflow.lignes l ON l.commande_id = o.id
WHERE o.id = 42 GROUP BY o.id;
```

Résultat : **720,00**. La commande possède **3 lignes**, son total est **240,00** : la jointure répète trois fois `o.total`.

**Variante correcte A — somme après jointure :**

```sql
SELECT o.id, o.total AS total_commande,
       sum(l.qte * l.prix_unitaire) AS total_calcule
FROM shopflow.commandes o
LEFT JOIN shopflow.lignes l ON l.commande_id = o.id
WHERE o.id = 42 GROUP BY o.id, o.total;
```

**Variante correcte B — préagrégation :**

```sql
SELECT o.id, o.total AS total_commande, t.total_calcule
FROM shopflow.commandes o
LEFT JOIN (
 SELECT commande_id, sum(qte * prix_unitaire) AS total_calcule
 FROM shopflow.lignes GROUP BY commande_id
) t ON t.commande_id = o.id
WHERE o.id = 42;
```

Contrôle : **une ligne identique : 42, 240,00, 240,00**. L’écriture incorrecte est rejetée sur le contenu.

### 4. Mesurer et comparer les variantes correctes

Même méthode ; préfixer A puis B par `EXPLAIN (ANALYZE, BUFFERS)`.

| État / requête | 1 (ms) | 2 | 3 | 4 | 5 | Moyenne | p50 |
|---|---:|---:|---:|---:|---:|---:|---:|
| Somme après jointure | 0,849 | 0,448 | 0,609 | 0,460 | 1,296 | 0,732 | 0,609 |
| Préagrégation | 0,575 | 0,437 | 0,577 | 0,293 | 1,228 | 0,622 | 0,575 |

| Avant (A) | Après (B) | Explication |
|---|---|---|
| GroupAggregate après la jointure de trois lignes | GroupAggregate avant la jointure, une ligne agrégée | Même somme ; le total enregistré n’est jamais multiplié. |
| Index Scan sur les trois lignes ; hit=10 | Même index et trois lignes ; hit=10 | Le filtre `commande_id=42` est propagé à la sous-requête. |

Moyenne : **−15,1 %** ; médiane : **−5,6 %**. **Décision :** les deux écritures correctes sont valides ; la préagrégation rend explicite la granularité. L’avantage observé porte sur cette commande.

Les mesures 4 et 5 complètent les trois premières dans une seconde série. Les LEFT JOIN conservent une commande sans ligne avec une somme NULL.

**Plans : annexe A2.**

## Atelier 3 — Indexer l’historique client

### 1. Tester l’état initial

Requête identique dans les quatre états :

```sql
SELECT id, created_at, statut, total
FROM shopflow.commandes
WHERE client_id = 42
ORDER BY created_at DESC, id DESC
LIMIT 20;
```

Index initiaux conservés : clé primaire sur `id`, unicité sur `(client_id, cle_idempotence)`. Chaque client testé possède **100 commandes**.

| Client | Total des 100 commandes | Résultat LIMIT 20 |
|---|---:|---|
| 1 | 17 250,00 | 20 lignes, 1 725,00 |
| 42 | 47 760,00 | 20 lignes, 14 400,00 |
| 999 | 25 621,25 | 20 lignes, 7 725,00 |

Le résultat du client 42 est identique dans les quatre états : identifiants **86042 à 29042**, par pas de −3000 ; dates du **12/09/2026 23:54:02 UTC au 12/09/2026 08:04:02 UTC**, par pas de −50 minutes ; statut `payee`, **720,00** par ligne.

### 2. Appliquer les solutions successives

Un seul index expérimental à la fois ; les index des contraintes sont conservés.

**Index simple :**

```sql
CREATE INDEX idx_atelier3_client_simple ON shopflow.commandes (client_id);
```

**Remplacement par le composé :**

```sql
BEGIN;
DROP INDEX shopflow.idx_atelier3_client_simple;
CREATE INDEX idx_atelier3_hist_compose
ON shopflow.commandes (client_id, created_at DESC, id DESC);
COMMIT;
```

**Remplacement par le couvrant :**

```sql
BEGIN;
DROP INDEX shopflow.idx_atelier3_hist_compose;
CREATE INDEX idx_atelier3_hist_couvrant
ON shopflow.commandes (client_id, created_at DESC, id DESC)
INCLUDE (statut, total);
COMMIT;
```

**Vérification de l’inventaire et des tailles à chaque état :**

```sql
SELECT indexname, indexdef,
       pg_relation_size(format('%I.%I', schemaname, indexname)::regclass) AS octets
FROM pg_indexes
WHERE schemaname = 'shopflow' AND tablename = 'commandes'
ORDER BY indexname;
```

### 3. Mesurer les lectures avant/après

Méthode : contrôle du résultat, une exécution d’échauffement puis cinq répétitions du même SQL avec `EXPLAIN (ANALYZE, BUFFERS)`. Durée retenue : `Execution Time` (hors `Planning Time`). Échauffement exclu des statistiques.

Préfixer la requête initiale par `EXPLAIN (ANALYZE, BUFFERS)`. Inventaire et contenu contrôlés après chaque changement. Initial/simple : clients 1, 42, 999 ; composé/couvrant : client 42.

| État / requête | 1 (ms) | 2 | 3 | 4 | 5 | Moyenne | p50 |
|---|---:|---:|---:|---:|---:|---:|---:|
| Initial | 1,834 | 0,951 | 1,113 | 1,061 | 0,928 | 1,177 | 1,061 |
| Simple | 1,498 | 2,445 | 2,907 | 1,989 | 1,323 | 2,032 | 1,989 |
| Composé | 0,496 | 0,684 | 0,227 | 0,562 | 0,427 | 0,479 | 0,496 |
| Couvrant | 0,406 | 0,225 | 0,234 | 0,229 | 0,375 | 0,294 | 0,234 |

### 4. Comparer et expliquer — client 42

| État | Index effectivement utilisé | Travail observé | Buffers hit | Taille expérimentale |
|---|---|---|---:|---:|
| Initial | Index unique initial | 100 commandes, 88 blocs table, tri top-N 27 kB | 90 | — |
| Simple | idx_atelier3_client_simple | Même récupération et tri | 90 | 704 512 octets |
| Composé | idx_atelier3_hist_compose | Index Scan ordonné, 20 commandes, sans tri | 23 | 4 079 616 octets |
| Couvrant | idx_atelier3_hist_couvrant | Index Only Scan, 20 commandes, Heap Fetches=0 | 4 | 5 931 008 octets |

- **Simple :** filtre déjà couvert par le préfixe de l’index unique ; aucun travail de lecture évité.
- **Composé :** l’ordre de l’index correspond au tri ; LIMIT arrête la lecture après 20 lignes. Moyenne **−59,3 %**, médiane **−53,3 %** par rapport à l’état initial.
- **Couvrant :** statut et total sont dans l’index ; les cinq plans évitent les visites à la table. Moyenne **−75,0 %**, médiane **−77,9 %** par rapport à l’état initial. Stockage **+45,4 %** par rapport au composé.

**Décision de lecture :** retenir le couvrant pour la requête testée du client 42 ; le composé est une alternative moins volumineuse. Le zéro Heap Fetch observé dépend de la visibilité des pages.

### 5. Mesurer les insertions — états initial et simple

Même lot de 1 000 commandes. Exécuter séparément BEGIN, EXPLAIN, puis ROLLBACK après avoir copié le plan. Un échauffement et cinq répétitions par état.

```sql
BEGIN;
EXPLAIN (ANALYZE, BUFFERS)
INSERT INTO shopflow.commandes (id, client_id, created_at, statut, total)
SELECT b.max_id + g.n,
       CASE g.n % 3 WHEN 0 THEN 1 WHEN 1 THEN 42 ELSE 999 END,
       TIMESTAMPTZ '2026-10-05 12:00:00+00', 'payee', 0
FROM (SELECT max(id) AS max_id FROM shopflow.commandes) b
CROSS JOIN generate_series(1, 1000) AS g(n);
ROLLBACK;
```

| État / requête | 1 (ms) | 2 | 3 | 4 | 5 | Moyenne | p50 |
|---|---:|---:|---:|---:|---:|---:|---:|
| Initial | 53,759 | 27,691 | 18,113 | 14,727 | 20,052 | 26,868 | 20,052 |
| Simple | 22,712 | 25,532 | 26,996 | 17,117 | 19,502 | 22,372 | 22,712 |

Médiane initiale **20,052 ms**, simple **22,712 ms**. Le calcul de max(id) varie entre **1 et 2 000 Heap Fetches** dans les plans d’insertion ; les durées incluent ce travail et les contrôles de clé étrangère. La variation empêche d’isoler le coût de maintenance du seul index.

**Contrôle après annulation :**

```sql
SELECT count(*), max(id), sum(total) FROM shopflow.commandes;
```

Valeurs retrouvées après initial puis simple : **100 000 ; 100 000 ; 29 775 001,25**. ROLLBACK conserve le contenu logique ; les tailles des index initiaux ont augmenté pendant les essais.

**Plans : annexe A3.**

## Atelier 4 — Index spécialisés

### 1. Index partiel : solution et tests du prédicat

Inventaire initial : index des contraintes de commandes et produits, et index couvrant de l’atelier 3.

```sql
CREATE INDEX idx_atelier4_attente
ON shopflow.commandes (created_at, id)
WHERE statut = 'en_attente';
```

Méthode : une exécution observée par filtre ; même projection, ordre et limite. Modifier uniquement le statut pour vérifier la condition d’utilisation.

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT id FROM shopflow.commandes
WHERE statut = 'en_attente'
ORDER BY created_at, id LIMIT 100;
```

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT id FROM shopflow.commandes
WHERE statut = 'payee'
ORDER BY created_at, id LIMIT 100;
```

| Filtre | Plan | Lignes | Execution Time | Buffers |
|---|---|---:|---:|---|
| en_attente | Index Only Scan partiel, sans tri ; Heap Fetches=0 | 100 | 0,280 ms | hit=1, read=2 |
| payee | Parallel Seq Scan + tri top-N + Gather Merge | 100 | 46,722 ms | hit=1720 |

**Explication :** le filtre en_attente implique le prédicat. L’index fournit directement l’ordre ; il ne contient aucune commande payée. Les deux filtres concernent des sous-ensembles différents : ce test vérifie l’éligibilité de l’index, pas un gain avant/après sur le même résultat.

### 2. GIN : solution et tests des opérateurs

```sql
CREATE INDEX idx_atelier4_attributs_gin
ON shopflow.produits USING gin (attributs);
```

Méthode : une exécution observée par écriture, sur les 200 produits.

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, nom FROM shopflow.produits
WHERE attributs @> '{"categorie":"livre"}'::jsonb;
```

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, nom FROM shopflow.produits
WHERE attributs ->> 'categorie' = 'livre';
```

| Filtre | Compatibilité GIN jsonb_ops | Plan | Lignes | Durée | Buffers hit |
|---|---|---|---:|---:|---:|
| @> | Oui | Seq Scan | 50 | 0,199 ms | 3 |
| ->> puis égalité | Non, pas directement | Seq Scan | 50 | 0,207 ms | 3 |

**Explication :** les 200 produits tiennent dans trois blocs déjà en mémoire. Le planificateur estime le parcours complet moins coûteux que le GIN puis la table. Pour ->>, estimation de 1 ligne contre 50 observées ; un B-tree d’expression correspondrait à cette condition.

**Proposition de test :** copie de plus grand volume, ANALYZE, même filtre @> avant/après GIN, échauffement et cinq répétitions, plusieurs sélectivités sans forcer l’index.

### 3. GiST : créer et vérifier les chevauchements

```sql
BEGIN;
CREATE TABLE shopflow.atelier4_reservations (
 id bigint PRIMARY KEY, periode tstzrange NOT NULL
);
INSERT INTO shopflow.atelier4_reservations VALUES
(1, tstzrange('2026-10-10 14:00+02', '2026-10-10 16:00+02', '[)')),
(2, tstzrange('2026-10-10 15:00+02', '2026-10-10 17:00+02', '[)')),
(3, tstzrange('2026-10-10 18:00+02', '2026-10-10 19:00+02', '[)'));
CREATE INDEX idx_atelier4_periode_gist
ON shopflow.atelier4_reservations USING gist (periode);
COMMIT;
```

Méthode : exécuter d’abord le SELECT pour contrôler les périodes, puis le même SELECT avec EXPLAIN.

```sql
SELECT id, periode FROM shopflow.atelier4_reservations
WHERE periode && tstzrange(
 '2026-10-10 14:00+02', '2026-10-10 16:00+02', '[)'
) ORDER BY id;
```

Résultat : **1 et 2**, période 3 exclue. Affichage UTC : `[12:00,14:00)` et `[13:00,15:00)` le 10 octobre. Bornes : début inclus, fin exclue.

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, periode FROM shopflow.atelier4_reservations
WHERE periode && tstzrange(
 '2026-10-10 14:00+02', '2026-10-10 16:00+02', '[)'
);
```

Preuve : **Seq Scan, 2 lignes, 1 écartée, hit=1, 0,180 ms**. Les trois périodes tiennent dans un bloc ; le parcours complet est préféré au GiST compatible avec &&.

### 4. Tailles vérifiées et décision

Méthode : vérifier indexdef dans pg_indexes, et relever pg_relation_size et pg_size_pretty pour chaque index.

```sql
SELECT indexname, indexdef,
 pg_relation_size(format('%I.%I', schemaname, indexname)::regclass) AS octets,
 pg_size_pretty(pg_relation_size(
   format('%I.%I', schemaname, indexname)::regclass)) AS taille
FROM pg_indexes
WHERE schemaname = 'shopflow'
AND indexname IN ('idx_atelier4_attente',
                 'idx_atelier4_attributs_gin', 'idx_atelier4_periode_gist');
```

| Index | Octets | Taille | Décision liée au test |
|---|---:|---|---|
| Partiel | 335 872 | 328 kB | Adapté aux commandes en attente ordonnées. |
| GIN | 16 384 | 16 kB | Compatible avec @>, sans avantage d’utilisation démontré sur 200 produits. |
| GiST | 8 192 | 8 KiB | Adapté à && ; exactitude du chevauchement vérifiée, Seq Scan sur trois périodes. |

La compatibilité dépend du prédicat et de l’opérateur ; l’utilisation effective dépend aussi du coût estimé. Ces tests portent sur les conditions d’utilisation, avec les durées observées ci-dessus.

**Plans : annexe A4.**

## Annexes — Plans complets

## Annexe A1 — Plans complets

### A1-01 — Annexe — Plans complets et informations BUFFERS / Commande de mesure de la requête 1 / Échauffement — requête 1

```text
Sort  (cost=330.50..330.75 rows=100 width=28) (actual time=1.298..1.314 rows=100.00 loops=1)
  Sort Key: created_at DESC, id DESC
  Sort Method: quicksort  Memory: 29kB
  Buffers: shared hit=90
  ->  Bitmap Heap Scan on commandes  (cost=5.07..327.18 rows=100 width=28) (actual time=0.249..1.111 rows=100.00 loops=1)
        Recheck Cond: (client_id = 42)
        Heap Blocks: exact=88
        Buffers: shared hit=90
        ->  Bitmap Index Scan on commandes_client_id_cle_idempotence_key  (cost=0.00..5.04 rows=100 width=0) (actual time=0.154..0.154 rows=100.00 loops=1)
              Index Cond: (client_id = 42)
              Index Searches: 1
              Buffers: shared hit=2
Planning Time: 0.811 ms
Execution Time: 1.466 ms
```

### A1-02 — Commande de mesure de la requête 1 / Échauffement — requête 1 / Mesure 1 — requête 1

```text
Sort  (cost=330.50..330.75 rows=100 width=28) (actual time=0.714..0.724 rows=100.00 loops=1)
  Sort Key: created_at DESC, id DESC
  Sort Method: quicksort  Memory: 29kB
  Buffers: shared hit=90
  ->  Bitmap Heap Scan on commandes  (cost=5.07..327.18 rows=100 width=28) (actual time=0.157..0.620 rows=100.00 loops=1)
        Recheck Cond: (client_id = 42)
        Heap Blocks: exact=88
        Buffers: shared hit=90
        ->  Bitmap Index Scan on commandes_client_id_cle_idempotence_key  (cost=0.00..5.04 rows=100 width=0) (actual time=0.098..0.098 rows=100.00 loops=1)
              Index Cond: (client_id = 42)
              Index Searches: 1
              Buffers: shared hit=2
Planning Time: 0.451 ms
Execution Time: 0.827 ms
```

### A1-03 — Échauffement — requête 1 / Mesure 1 — requête 1 / Mesure 2 — requête 1

```text
Sort  (cost=330.50..330.75 rows=100 width=28) (actual time=1.545..1.565 rows=100.00 loops=1)
  Sort Key: created_at DESC, id DESC
  Sort Method: quicksort  Memory: 29kB
  Buffers: shared hit=90
  ->  Bitmap Heap Scan on commandes  (cost=5.07..327.18 rows=100 width=28) (actual time=0.391..1.400 rows=100.00 loops=1)
        Recheck Cond: (client_id = 42)
        Heap Blocks: exact=88
        Buffers: shared hit=90
        ->  Bitmap Index Scan on commandes_client_id_cle_idempotence_key  (cost=0.00..5.04 rows=100 width=0) (actual time=0.287..0.287 rows=100.00 loops=1)
              Index Cond: (client_id = 42)
              Index Searches: 1
              Buffers: shared hit=2
Planning Time: 0.873 ms
Execution Time: 1.737 ms
```

### A1-04 — Mesure 1 — requête 1 / Mesure 2 — requête 1 / Mesure 3 — requête 1

```text
Sort  (cost=330.50..330.75 rows=100 width=28) (actual time=2.056..2.073 rows=100.00 loops=1)
  Sort Key: created_at DESC, id DESC
  Sort Method: quicksort  Memory: 29kB
  Buffers: shared hit=90
  ->  Bitmap Heap Scan on commandes  (cost=5.07..327.18 rows=100 width=28) (actual time=1.060..1.916 rows=100.00 loops=1)
        Recheck Cond: (client_id = 42)
        Heap Blocks: exact=88
        Buffers: shared hit=90
        ->  Bitmap Index Scan on commandes_client_id_cle_idempotence_key  (cost=0.00..5.04 rows=100 width=0) (actual time=0.982..0.982 rows=100.00 loops=1)
              Index Cond: (client_id = 42)
              Index Searches: 1
              Buffers: shared hit=2
Planning Time: 0.672 ms
Execution Time: 2.474 ms
```

### A1-05 — Mesure 2 — requête 1 / Mesure 3 — requête 1 / Mesure 4 — requête 1

```text
Sort  (cost=330.50..330.75 rows=100 width=28) (actual time=1.555..1.576 rows=100.00 loops=1)
  Sort Key: created_at DESC, id DESC
  Sort Method: quicksort  Memory: 29kB
  Buffers: shared hit=90
  ->  Bitmap Heap Scan on commandes  (cost=5.07..327.18 rows=100 width=28) (actual time=0.279..1.362 rows=100.00 loops=1)
        Recheck Cond: (client_id = 42)
        Heap Blocks: exact=88
        Buffers: shared hit=90
        ->  Bitmap Index Scan on commandes_client_id_cle_idempotence_key  (cost=0.00..5.04 rows=100 width=0) (actual time=0.178..0.178 rows=100.00 loops=1)
              Index Cond: (client_id = 42)
              Index Searches: 1
              Buffers: shared hit=2
Planning Time: 0.712 ms
Execution Time: 1.829 ms
```

### A1-06 — Mesure 3 — requête 1 / Mesure 4 — requête 1 / Mesure 5 — requête 1

```text
Sort  (cost=330.50..330.75 rows=100 width=28) (actual time=1.409..1.420 rows=100.00 loops=1)
  Sort Key: created_at DESC, id DESC
  Sort Method: quicksort  Memory: 29kB
  Buffers: shared hit=90
  ->  Bitmap Heap Scan on commandes  (cost=5.07..327.18 rows=100 width=28) (actual time=0.316..1.268 rows=100.00 loops=1)
        Recheck Cond: (client_id = 42)
        Heap Blocks: exact=88
        Buffers: shared hit=90
        ->  Bitmap Index Scan on commandes_client_id_cle_idempotence_key  (cost=0.00..5.04 rows=100 width=0) (actual time=0.180..0.181 rows=100.00 loops=1)
              Index Cond: (client_id = 42)
              Index Searches: 1
              Buffers: shared hit=2
Planning Time: 0.999 ms
Execution Time: 1.607 ms
```

### A1-07 — Mesure 5 — requête 1 / Commande de mesure de la requête 2 / Échauffement — requête 2

```text
Sort  (cost=3424.06..3424.07 rows=3 width=46) (actual time=53.866..53.876 rows=3.00 loops=1)
  Sort Key: statut
  Sort Method: quicksort  Memory: 25kB
  Buffers: shared hit=1674
  ->  HashAggregate  (cost=3424.00..3424.04 rows=3 width=46) (actual time=53.689..53.695 rows=3.00 loops=1)
        Group Key: statut
        Batches: 1  Memory Usage: 32kB
        Buffers: shared hit=1674
        ->  Seq Scan on commandes  (cost=0.00..2674.00 rows=100000 width=12) (actual time=6.392..20.683 rows=100000.00 loops=1)
              Buffers: shared hit=1674
Planning Time: 0.629 ms
Execution Time: 54.149 ms
```

### A1-08 — Commande de mesure de la requête 2 / Échauffement — requête 2 / Mesure 1 — requête 2

```text
Sort  (cost=3424.06..3424.07 rows=3 width=46) (actual time=42.345..42.354 rows=3.00 loops=1)
  Sort Key: statut
  Sort Method: quicksort  Memory: 25kB
  Buffers: shared hit=1674
  ->  HashAggregate  (cost=3424.00..3424.04 rows=3 width=46) (actual time=42.233..42.238 rows=3.00 loops=1)
        Group Key: statut
        Batches: 1  Memory Usage: 32kB
        Buffers: shared hit=1674
        ->  Seq Scan on commandes  (cost=0.00..2674.00 rows=100000 width=12) (actual time=3.511..14.596 rows=100000.00 loops=1)
              Buffers: shared hit=1674
Planning Time: 0.854 ms
Execution Time: 42.761 ms
```

### A1-09 — Échauffement — requête 2 / Mesure 1 — requête 2 / Mesure 2 — requête 2

```text
Sort  (cost=3424.06..3424.07 rows=3 width=46) (actual time=40.996..41.003 rows=3.00 loops=1)
  Sort Key: statut
  Sort Method: quicksort  Memory: 25kB
  Buffers: shared hit=1674
  ->  HashAggregate  (cost=3424.00..3424.04 rows=3 width=46) (actual time=40.929..40.930 rows=3.00 loops=1)
        Group Key: statut
        Batches: 1  Memory Usage: 32kB
        Buffers: shared hit=1674
        ->  Seq Scan on commandes  (cost=0.00..2674.00 rows=100000 width=12) (actual time=2.256..13.674 rows=100000.00 loops=1)
              Buffers: shared hit=1674
Planning Time: 0.273 ms
Execution Time: 41.124 ms
```

### A1-10 — Mesure 1 — requête 2 / Mesure 2 — requête 2 / Mesure 3 — requête 2

```text
Sort  (cost=3424.06..3424.07 rows=3 width=46) (actual time=60.901..60.901 rows=3.00 loops=1)
  Sort Key: statut
  Sort Method: quicksort  Memory: 25kB
  Buffers: shared hit=1674
  ->  HashAggregate  (cost=3424.00..3424.04 rows=3 width=46) (actual time=60.864..60.866 rows=3.00 loops=1)
        Group Key: statut
        Batches: 1  Memory Usage: 32kB
        Buffers: shared hit=1674
        ->  Seq Scan on commandes  (cost=0.00..2674.00 rows=100000 width=12) (actual time=5.381..20.969 rows=100000.00 loops=1)
              Buffers: shared hit=1674
Planning Time: 0.286 ms
Execution Time: 61.019 ms
```

### A1-11 — Mesure 2 — requête 2 / Mesure 3 — requête 2 / Mesure 4 — requête 2

```text
Sort  (cost=3424.06..3424.07 rows=3 width=46) (actual time=48.313..48.319 rows=3.00 loops=1)
  Sort Key: statut
  Sort Method: quicksort  Memory: 25kB
  Buffers: shared hit=1674
  ->  HashAggregate  (cost=3424.00..3424.04 rows=3 width=46) (actual time=48.202..48.206 rows=3.00 loops=1)
        Group Key: statut
        Batches: 1  Memory Usage: 32kB
        Buffers: shared hit=1674
        ->  Seq Scan on commandes  (cost=0.00..2674.00 rows=100000 width=12) (actual time=4.953..17.422 rows=100000.00 loops=1)
              Buffers: shared hit=1674
Planning Time: 1.056 ms
Execution Time: 48.577 ms
```

### A1-12 — Mesure 3 — requête 2 / Mesure 4 — requête 2 / Mesure 5 — requête 2

```text
Sort  (cost=3424.06..3424.07 rows=3 width=46) (actual time=54.550..54.561 rows=3.00 loops=1)
  Sort Key: statut
  Sort Method: quicksort  Memory: 25kB
  Buffers: shared hit=1674
  ->  HashAggregate  (cost=3424.00..3424.04 rows=3 width=46) (actual time=54.457..54.463 rows=3.00 loops=1)
        Group Key: statut
        Batches: 1  Memory Usage: 32kB
        Buffers: shared hit=1674
        ->  Seq Scan on commandes  (cost=0.00..2674.00 rows=100000 width=12) (actual time=4.757..18.073 rows=100000.00 loops=1)
              Buffers: shared hit=1674
Planning Time: 0.815 ms
Execution Time: 54.799 ms
```

## Annexe A2 — Plans complets

### A2-01 — 3. Plans et mesures / Comparaison des clients — périmètre client 42 / SQL et plan complet — échauffement JOIN DISTINCT

```text
HashAggregate  (cost=15.59..15.60 rows=1 width=18) (actual time=0.419..0.424 rows=1.00 loops=1)
  Group Key: c.nom
  Batches: 1  Memory Usage: 32kB
  Buffers: shared hit=6
  ->  Nested Loop  (cost=0.57..15.34 rows=100 width=18) (actual time=0.344..0.380 rows=100.00 loops=1)
        Buffers: shared hit=6
        ->  Index Scan using clients_pkey on clients c  (cost=0.28..8.29 rows=1 width=18) (actual time=0.223..0.224 rows=1.00 loops=1)
              Index Cond: (id = 42)
              Index Searches: 1
              Buffers: shared hit=3
        ->  Index Only Scan using commandes_client_id_cle_idempotence_key on commandes o  (cost=0.29..6.04 rows=100 width=8) (actual time=0.104..0.117 rows=100.00 loops=1)
              Index Cond: (client_id = 42)
              Heap Fetches: 0
              Index Searches: 1
              Buffers: shared hit=3
Planning Time: 0.675 ms
Execution Time: 0.616 ms
```

### A2-02 — Comparaison des clients — périmètre client 42 / SQL et plan complet — échauffement JOIN DISTINCT / Mesure 1 — JOIN DISTINCT

```text
HashAggregate  (cost=15.59..15.60 rows=1 width=18) (actual time=0.281..0.285 rows=1.00 loops=1)
  Group Key: c.nom
  Batches: 1  Memory Usage: 32kB
  Buffers: shared hit=6
  ->  Nested Loop  (cost=0.57..15.34 rows=100 width=18) (actual time=0.242..0.258 rows=100.00 loops=1)
        Buffers: shared hit=6
        ->  Index Scan using clients_pkey on clients c  (cost=0.28..8.29 rows=1 width=18) (actual time=0.151..0.151 rows=1.00 loops=1)
              Index Cond: (id = 42)
              Index Searches: 1
              Buffers: shared hit=3
        ->  Index Only Scan using commandes_client_id_cle_idempotence_key on commandes o  (cost=0.29..6.04 rows=100 width=8) (actual time=0.085..0.092 rows=100.00 loops=1)
              Index Cond: (client_id = 42)
              Heap Fetches: 0
              Index Searches: 1
              Buffers: shared hit=3
Planning Time: 0.372 ms
Execution Time: 0.455 ms
```

### A2-03 — SQL et plan complet — échauffement JOIN DISTINCT / Mesure 1 — JOIN DISTINCT / Mesure 2 — JOIN DISTINCT

```text
HashAggregate  (cost=15.59..15.60 rows=1 width=18) (actual time=0.163..0.164 rows=1.00 loops=1)
  Group Key: c.nom
  Batches: 1  Memory Usage: 32kB
  Buffers: shared hit=6
  ->  Nested Loop  (cost=0.57..15.34 rows=100 width=18) (actual time=0.130..0.145 rows=100.00 loops=1)
        Buffers: shared hit=6
        ->  Index Scan using clients_pkey on clients c  (cost=0.28..8.29 rows=1 width=18) (actual time=0.077..0.077 rows=1.00 loops=1)
              Index Cond: (id = 42)
              Index Searches: 1
              Buffers: shared hit=3
        ->  Index Only Scan using commandes_client_id_cle_idempotence_key on commandes o  (cost=0.29..6.04 rows=100 width=8) (actual time=0.050..0.057 rows=100.00 loops=1)
              Index Cond: (client_id = 42)
              Heap Fetches: 0
              Index Searches: 1
              Buffers: shared hit=3
Planning Time: 0.737 ms
Execution Time: 0.245 ms
```

### A2-04 — Mesure 1 — JOIN DISTINCT / Mesure 2 — JOIN DISTINCT / Mesure 3 — JOIN DISTINCT

```text
HashAggregate  (cost=15.59..15.60 rows=1 width=18) (actual time=0.209..0.210 rows=1.00 loops=1)
  Group Key: c.nom
  Batches: 1  Memory Usage: 32kB
  Buffers: shared hit=6
  ->  Nested Loop  (cost=0.57..15.34 rows=100 width=18) (actual time=0.170..0.186 rows=100.00 loops=1)
        Buffers: shared hit=6
        ->  Index Scan using clients_pkey on clients c  (cost=0.28..8.29 rows=1 width=18) (actual time=0.119..0.119 rows=1.00 loops=1)
              Index Cond: (id = 42)
              Index Searches: 1
              Buffers: shared hit=3
        ->  Index Only Scan using commandes_client_id_cle_idempotence_key on commandes o  (cost=0.29..6.04 rows=100 width=8) (actual time=0.048..0.054 rows=100.00 loops=1)
              Index Cond: (client_id = 42)
              Heap Fetches: 0
              Index Searches: 1
              Buffers: shared hit=3
Planning Time: 0.215 ms
Execution Time: 0.295 ms
```

### A2-05 — Mesure 2 — JOIN DISTINCT / Mesure 3 — JOIN DISTINCT / SQL et plan complet — échauffement EXISTS

```text
Nested Loop Semi Join  (cost=0.57..14.35 rows=1 width=18) (actual time=0.337..0.344 rows=1.00 loops=1)
  Buffers: shared hit=6
  ->  Index Scan using clients_pkey on clients c  (cost=0.28..8.29 rows=1 width=18) (actual time=0.216..0.217 rows=1.00 loops=1)
        Index Cond: (id = 42)
        Index Searches: 1
        Buffers: shared hit=3
  ->  Index Only Scan using commandes_client_id_cle_idempotence_key on commandes o  (cost=0.29..6.04 rows=100 width=8) (actual time=0.109..0.109 rows=1.00 loops=1)
        Index Cond: (client_id = 42)
        Heap Fetches: 0
        Index Searches: 1
        Buffers: shared hit=3
Planning Time: 0.589 ms
Execution Time: 0.479 ms
```

### A2-06 — Mesure 3 — JOIN DISTINCT / SQL et plan complet — échauffement EXISTS / Mesure 1 — EXISTS

```text
Nested Loop Semi Join  (cost=0.57..14.35 rows=1 width=18) (actual time=0.153..0.154 rows=1.00 loops=1)
  Buffers: shared hit=6
  ->  Index Scan using clients_pkey on clients c  (cost=0.28..8.29 rows=1 width=18) (actual time=0.092..0.092 rows=1.00 loops=1)
        Index Cond: (id = 42)
        Index Searches: 1
        Buffers: shared hit=3
  ->  Index Only Scan using commandes_client_id_cle_idempotence_key on commandes o  (cost=0.29..6.04 rows=100 width=8) (actual time=0.058..0.058 rows=1.00 loops=1)
        Index Cond: (client_id = 42)
        Heap Fetches: 0
        Index Searches: 1
        Buffers: shared hit=3
Planning Time: 0.417 ms
Execution Time: 0.219 ms
```

### A2-07 — SQL et plan complet — échauffement EXISTS / Mesure 1 — EXISTS / Mesure 2 — EXISTS

```text
Nested Loop Semi Join  (cost=0.57..14.35 rows=1 width=18) (actual time=0.271..0.283 rows=1.00 loops=1)
  Buffers: shared hit=6
  ->  Index Scan using clients_pkey on clients c  (cost=0.28..8.29 rows=1 width=18) (actual time=0.184..0.186 rows=1.00 loops=1)
        Index Cond: (id = 42)
        Index Searches: 1
        Buffers: shared hit=3
  ->  Index Only Scan using commandes_client_id_cle_idempotence_key on commandes o  (cost=0.29..6.04 rows=100 width=8) (actual time=0.076..0.076 rows=1.00 loops=1)
        Index Cond: (client_id = 42)
        Heap Fetches: 0
        Index Searches: 1
        Buffers: shared hit=3
Planning Time: 0.506 ms
Execution Time: 0.384 ms
```

### A2-08 — Mesure 1 — EXISTS / Mesure 2 — EXISTS / Mesure 3 — EXISTS

```text
Nested Loop Semi Join  (cost=0.57..14.35 rows=1 width=18) (actual time=0.207..0.210 rows=1.00 loops=1)
  Buffers: shared hit=6
  ->  Index Scan using clients_pkey on clients c  (cost=0.28..8.29 rows=1 width=18) (actual time=0.138..0.140 rows=1.00 loops=1)
        Index Cond: (id = 42)
        Index Searches: 1
        Buffers: shared hit=3
  ->  Index Only Scan using commandes_client_id_cle_idempotence_key on commandes o  (cost=0.29..6.04 rows=100 width=8) (actual time=0.064..0.064 rows=1.00 loops=1)
        Index Cond: (client_id = 42)
        Heap Fetches: 0
        Index Searches: 1
        Buffers: shared hit=3
Planning Time: 0.357 ms
Execution Time: 0.296 ms
```

### A2-09 — Mesure 3 — EXISTS / Comparaison des totaux — périmètre commande 42 / Échauffement — agrégation après jointure

```text
GroupAggregate  (cost=0.84..24.48 rows=1 width=46) (actual time=0.428..0.432 rows=1.00 loops=1)
  Buffers: shared hit=10
  ->  Nested Loop Left Join  (cost=0.84..24.44 rows=3 width=24) (actual time=0.349..0.391 rows=3.00 loops=1)
        Buffers: shared hit=10
        ->  Index Scan using commandes_pkey on commandes o  (cost=0.42..8.44 rows=1 width=14) (actual time=0.246..0.246 rows=1.00 loops=1)
              Index Cond: (id = 42)
              Index Searches: 1
              Buffers: shared hit=4
        ->  Index Scan using lignes_pkey on lignes l  (cost=0.42..15.98 rows=3 width=18) (actual time=0.097..0.137 rows=3.00 loops=1)
              Index Cond: (commande_id = 42)
              Index Searches: 1
              Buffers: shared hit=6
Planning Time: 0.481 ms
Execution Time: 1.354 ms
```

### A2-10 — Comparaison des totaux — périmètre commande 42 / Échauffement — agrégation après jointure / Mesure 1 — agrégation après jointure

```text
GroupAggregate  (cost=0.84..24.48 rows=1 width=46) (actual time=0.557..0.566 rows=1.00 loops=1)
  Buffers: shared hit=10
  ->  Nested Loop Left Join  (cost=0.84..24.44 rows=3 width=24) (actual time=0.476..0.521 rows=3.00 loops=1)
        Buffers: shared hit=10
        ->  Index Scan using commandes_pkey on commandes o  (cost=0.42..8.44 rows=1 width=14) (actual time=0.300..0.304 rows=1.00 loops=1)
              Index Cond: (id = 42)
              Index Searches: 1
              Buffers: shared hit=4
        ->  Index Scan using lignes_pkey on lignes l  (cost=0.42..15.98 rows=3 width=18) (actual time=0.164..0.203 rows=3.00 loops=1)
              Index Cond: (commande_id = 42)
              Index Searches: 1
              Buffers: shared hit=6
Planning Time: 0.741 ms
Execution Time: 0.849 ms
```

### A2-11 — Échauffement — agrégation après jointure / Mesure 1 — agrégation après jointure / Mesure 2 — agrégation après jointure

```text
GroupAggregate  (cost=0.84..24.48 rows=1 width=46) (actual time=0.369..0.370 rows=1.00 loops=1)
  Buffers: shared hit=10
  ->  Nested Loop Left Join  (cost=0.84..24.44 rows=3 width=24) (actual time=0.280..0.331 rows=3.00 loops=1)
        Buffers: shared hit=10
        ->  Index Scan using commandes_pkey on commandes o  (cost=0.42..8.44 rows=1 width=14) (actual time=0.180..0.181 rows=1.00 loops=1)
              Index Cond: (id = 42)
              Index Searches: 1
              Buffers: shared hit=4
        ->  Index Scan using lignes_pkey on lignes l  (cost=0.42..15.98 rows=3 width=18) (actual time=0.094..0.142 rows=3.00 loops=1)
              Index Cond: (commande_id = 42)
              Index Searches: 1
              Buffers: shared hit=6
Planning Time: 0.382 ms
Execution Time: 0.448 ms
```

### A2-12 — Mesure 1 — agrégation après jointure / Mesure 2 — agrégation après jointure / Mesure 3 — agrégation après jointure

```text
GroupAggregate  (cost=0.84..24.48 rows=1 width=46) (actual time=0.442..0.443 rows=1.00 loops=1)
  Buffers: shared hit=10
  ->  Nested Loop Left Join  (cost=0.84..24.44 rows=3 width=24) (actual time=0.325..0.410 rows=3.00 loops=1)
        Buffers: shared hit=10
        ->  Index Scan using commandes_pkey on commandes o  (cost=0.42..8.44 rows=1 width=14) (actual time=0.234..0.236 rows=1.00 loops=1)
              Index Cond: (id = 42)
              Index Searches: 1
              Buffers: shared hit=4
        ->  Index Scan using lignes_pkey on lignes l  (cost=0.42..15.98 rows=3 width=18) (actual time=0.086..0.167 rows=3.00 loops=1)
              Index Cond: (commande_id = 42)
              Index Searches: 1
              Buffers: shared hit=6
Planning Time: 0.359 ms
Execution Time: 0.609 ms
```

### A2-13 — Mesure 2 — agrégation après jointure / Mesure 3 — agrégation après jointure / SQL et plan complet — échauffement de la préagrégation

```text
Nested Loop Left Join  (cost=0.84..24.47 rows=1 width=46) (actual time=0.767..0.775 rows=1.00 loops=1)
  Buffers: shared hit=10
  ->  Index Scan using commandes_pkey on commandes o  (cost=0.42..8.44 rows=1 width=14) (actual time=0.378..0.379 rows=1.00 loops=1)
        Index Cond: (id = 42)
        Index Searches: 1
        Buffers: shared hit=4
  ->  GroupAggregate  (cost=0.42..16.01 rows=1 width=40) (actual time=0.384..0.384 rows=1.00 loops=1)
        Buffers: shared hit=6
        ->  Index Scan using lignes_pkey on lignes  (cost=0.42..15.98 rows=3 width=18) (actual time=0.154..0.210 rows=3.00 loops=1)
              Index Cond: (commande_id = 42)
              Index Searches: 1
              Buffers: shared hit=6
Planning Time: 1.331 ms
Execution Time: 1.563 ms
```

### A2-14 — Mesure 3 — agrégation après jointure / SQL et plan complet — échauffement de la préagrégation / Mesure 1 — préagrégation

```text
Nested Loop Left Join  (cost=0.84..24.47 rows=1 width=46) (actual time=0.408..0.410 rows=1.00 loops=1)
  Buffers: shared hit=10
  ->  Index Scan using commandes_pkey on commandes o  (cost=0.42..8.44 rows=1 width=14) (actual time=0.219..0.220 rows=1.00 loops=1)
        Index Cond: (id = 42)
        Index Searches: 1
        Buffers: shared hit=4
  ->  GroupAggregate  (cost=0.42..16.01 rows=1 width=40) (actual time=0.185..0.186 rows=1.00 loops=1)
        Buffers: shared hit=6
        ->  Index Scan using lignes_pkey on lignes  (cost=0.42..15.98 rows=3 width=18) (actual time=0.090..0.137 rows=3.00 loops=1)
              Index Cond: (commande_id = 42)
              Index Searches: 1
              Buffers: shared hit=6
Planning Time: 0.624 ms
Execution Time: 0.575 ms
```

### A2-15 — SQL et plan complet — échauffement de la préagrégation / Mesure 1 — préagrégation / Mesure 2 — préagrégation

```text
Nested Loop Left Join  (cost=0.84..24.47 rows=1 width=46) (actual time=0.282..0.287 rows=1.00 loops=1)
  Buffers: shared hit=10
  ->  Index Scan using commandes_pkey on commandes o  (cost=0.42..8.44 rows=1 width=14) (actual time=0.155..0.155 rows=1.00 loops=1)
        Index Cond: (id = 42)
        Index Searches: 1
        Buffers: shared hit=4
  ->  GroupAggregate  (cost=0.42..16.01 rows=1 width=40) (actual time=0.124..0.125 rows=1.00 loops=1)
        Buffers: shared hit=6
        ->  Index Scan using lignes_pkey on lignes  (cost=0.42..15.98 rows=3 width=18) (actual time=0.061..0.094 rows=3.00 loops=1)
              Index Cond: (commande_id = 42)
              Index Searches: 1
              Buffers: shared hit=6
Planning Time: 0.937 ms
Execution Time: 0.437 ms
```

### A2-16 — Mesure 1 — préagrégation / Mesure 2 — préagrégation / Mesure 3 — préagrégation

```text
Nested Loop Left Join  (cost=0.84..24.47 rows=1 width=46) (actual time=0.447..0.449 rows=1.00 loops=1)
  Buffers: shared hit=10
  ->  Index Scan using commandes_pkey on commandes o  (cost=0.42..8.44 rows=1 width=14) (actual time=0.214..0.216 rows=1.00 loops=1)
        Index Cond: (id = 42)
        Index Searches: 1
        Buffers: shared hit=4
  ->  GroupAggregate  (cost=0.42..16.01 rows=1 width=40) (actual time=0.227..0.228 rows=1.00 loops=1)
        Buffers: shared hit=6
        ->  Index Scan using lignes_pkey on lignes  (cost=0.42..15.98 rows=3 width=18) (actual time=0.108..0.178 rows=3.00 loops=1)
              Index Cond: (commande_id = 42)
              Index Searches: 1
              Buffers: shared hit=6
Planning Time: 0.468 ms
Execution Time: 0.577 ms
```

### A2-17 — 4. Interprétation / Complément de collecte — cinq répétitions / Mesure 4 — JOIN DISTINCT

```text
HashAggregate  (cost=15.59..15.60 rows=1 width=18) (actual time=0.373..0.374 rows=1.00 loops=1)
  Group Key: c.nom
  Batches: 1  Memory Usage: 32kB
  Buffers: shared hit=6
  ->  Nested Loop  (cost=0.57..15.34 rows=100 width=18) (actual time=0.296..0.332 rows=100.00 loops=1)
        Buffers: shared hit=6
        ->  Index Scan using clients_pkey on clients c  (cost=0.28..8.29 rows=1 width=18) (actual time=0.198..0.199 rows=1.00 loops=1)
              Index Cond: (id = 42)
              Index Searches: 1
              Buffers: shared hit=3
        ->  Index Only Scan using commandes_client_id_cle_idempotence_key on commandes o  (cost=0.29..6.04 rows=100 width=8) (actual time=0.093..0.108 rows=100.00 loops=1)
              Index Cond: (client_id = 42)
              Heap Fetches: 0
              Index Searches: 1
              Buffers: shared hit=3
Planning Time: 0.718 ms
Execution Time: 0.862 ms
```

### A2-18 — Complément de collecte — cinq répétitions / Mesure 4 — JOIN DISTINCT / Mesure 5 — JOIN DISTINCT

```text
HashAggregate  (cost=15.59..15.60 rows=1 width=18) (actual time=0.194..0.199 rows=1.00 loops=1)
  Group Key: c.nom
  Batches: 1  Memory Usage: 32kB
  Buffers: shared hit=6
  ->  Nested Loop  (cost=0.57..15.34 rows=100 width=18) (actual time=0.161..0.177 rows=100.00 loops=1)
        Buffers: shared hit=6
        ->  Index Scan using clients_pkey on clients c  (cost=0.28..8.29 rows=1 width=18) (actual time=0.099..0.100 rows=1.00 loops=1)
              Index Cond: (id = 42)
              Index Searches: 1
              Buffers: shared hit=3
        ->  Index Only Scan using commandes_client_id_cle_idempotence_key on commandes o  (cost=0.29..6.04 rows=100 width=8) (actual time=0.056..0.063 rows=100.00 loops=1)
              Index Cond: (client_id = 42)
              Heap Fetches: 0
              Index Searches: 1
              Buffers: shared hit=3
Planning Time: 0.992 ms
Execution Time: 0.366 ms
```

### A2-19 — Mesure 4 — JOIN DISTINCT / Mesure 5 — JOIN DISTINCT / Mesure 4 — EXISTS

```text
Nested Loop Semi Join  (cost=0.57..14.35 rows=1 width=18) (actual time=0.396..0.399 rows=1.00 loops=1)
  Buffers: shared hit=6
  ->  Index Scan using clients_pkey on clients c  (cost=0.28..8.29 rows=1 width=18) (actual time=0.311..0.313 rows=1.00 loops=1)
        Index Cond: (id = 42)
        Index Searches: 1
        Buffers: shared hit=3
  ->  Index Only Scan using commandes_client_id_cle_idempotence_key on commandes o  (cost=0.29..6.04 rows=100 width=8) (actual time=0.078..0.078 rows=1.00 loops=1)
        Index Cond: (client_id = 42)
        Heap Fetches: 0
        Index Searches: 1
        Buffers: shared hit=3
Planning Time: 0.427 ms
Execution Time: 0.498 ms
```

### A2-20 — Mesure 5 — JOIN DISTINCT / Mesure 4 — EXISTS / Mesure 5 — EXISTS

```text
Nested Loop Semi Join  (cost=0.57..14.35 rows=1 width=18) (actual time=0.284..0.293 rows=1.00 loops=1)
  Buffers: shared hit=6
  ->  Index Scan using clients_pkey on clients c  (cost=0.28..8.29 rows=1 width=18) (actual time=0.187..0.189 rows=1.00 loops=1)
        Index Cond: (id = 42)
        Index Searches: 1
        Buffers: shared hit=3
  ->  Index Only Scan using commandes_client_id_cle_idempotence_key on commandes o  (cost=0.29..6.04 rows=100 width=8) (actual time=0.089..0.089 rows=1.00 loops=1)
        Index Cond: (client_id = 42)
        Heap Fetches: 0
        Index Searches: 1
        Buffers: shared hit=3
Planning Time: 0.546 ms
Execution Time: 0.459 ms
```

### A2-21 — Mesure 4 — EXISTS / Mesure 5 — EXISTS / Mesure 4 — agrégation après jointure

```text
GroupAggregate  (cost=0.84..24.48 rows=1 width=46) (actual time=0.358..0.358 rows=1.00 loops=1)
  Buffers: shared hit=10
  ->  Nested Loop Left Join  (cost=0.84..24.44 rows=3 width=24) (actual time=0.212..0.334 rows=3.00 loops=1)
        Buffers: shared hit=10
        ->  Index Scan using commandes_pkey on commandes o  (cost=0.42..8.44 rows=1 width=14) (actual time=0.105..0.106 rows=1.00 loops=1)
              Index Cond: (id = 42)
              Index Searches: 1
              Buffers: shared hit=4
        ->  Index Scan using lignes_pkey on lignes l  (cost=0.42..15.98 rows=3 width=18) (actual time=0.103..0.201 rows=3.00 loops=1)
              Index Cond: (commande_id = 42)
              Index Searches: 1
              Buffers: shared hit=6
Planning Time: 0.188 ms
Execution Time: 0.460 ms
```

### A2-22 — Mesure 5 — EXISTS / Mesure 4 — agrégation après jointure / Mesure 5 — agrégation après jointure

```text
GroupAggregate  (cost=0.84..24.48 rows=1 width=46) (actual time=1.114..1.115 rows=1.00 loops=1)
  Buffers: shared hit=10
  ->  Nested Loop Left Join  (cost=0.84..24.44 rows=3 width=24) (actual time=1.009..1.056 rows=3.00 loops=1)
        Buffers: shared hit=10
        ->  Index Scan using commandes_pkey on commandes o  (cost=0.42..8.44 rows=1 width=14) (actual time=0.934..0.935 rows=1.00 loops=1)
              Index Cond: (id = 42)
              Index Searches: 1
              Buffers: shared hit=4
        ->  Index Scan using lignes_pkey on lignes l  (cost=0.42..15.98 rows=3 width=18) (actual time=0.066..0.111 rows=3.00 loops=1)
              Index Cond: (commande_id = 42)
              Index Searches: 1
              Buffers: shared hit=6
Planning Time: 0.694 ms
Execution Time: 1.296 ms
```

### A2-23 — Mesure 4 — agrégation après jointure / Mesure 5 — agrégation après jointure / Mesure 4 — préagrégation

```text
Nested Loop Left Join  (cost=0.84..24.47 rows=1 width=46) (actual time=0.222..0.223 rows=1.00 loops=1)
  Buffers: shared hit=10
  ->  Index Scan using commandes_pkey on commandes o  (cost=0.42..8.44 rows=1 width=14) (actual time=0.104..0.104 rows=1.00 loops=1)
        Index Cond: (id = 42)
        Index Searches: 1
        Buffers: shared hit=4
  ->  GroupAggregate  (cost=0.42..16.01 rows=1 width=40) (actual time=0.116..0.116 rows=1.00 loops=1)
        Buffers: shared hit=6
        ->  Index Scan using lignes_pkey on lignes  (cost=0.42..15.98 rows=3 width=18) (actual time=0.045..0.094 rows=3.00 loops=1)
              Index Cond: (commande_id = 42)
              Index Searches: 1
              Buffers: shared hit=6
Planning Time: 0.365 ms
Execution Time: 0.293 ms
```

### A2-24 — Mesure 5 — agrégation après jointure / Mesure 4 — préagrégation / Mesure 5 — préagrégation

```text
Nested Loop Left Join  (cost=0.84..24.47 rows=1 width=46) (actual time=0.975..1.029 rows=1.00 loops=1)
  Buffers: shared hit=10
  ->  Index Scan using commandes_pkey on commandes o  (cost=0.42..8.44 rows=1 width=14) (actual time=0.369..0.370 rows=1.00 loops=1)
        Index Cond: (id = 42)
        Index Searches: 1
        Buffers: shared hit=4
  ->  GroupAggregate  (cost=0.42..16.01 rows=1 width=40) (actual time=0.602..0.602 rows=1.00 loops=1)
        Buffers: shared hit=6
        ->  Index Scan using lignes_pkey on lignes  (cost=0.42..15.98 rows=3 width=18) (actual time=0.418..0.495 rows=3.00 loops=1)
              Index Cond: (commande_id = 42)
              Index Searches: 1
              Buffers: shared hit=6
Planning Time: 0.573 ms
Execution Time: 1.228 ms
```

## Annexe A3 — Plans complets

### A3-01 — Décision fondée sur les lectures du client 42 / Mesures de lecture — état initial, client 42 / Échauffement — état initial, client 42

```text
Limit  (cost=329.84..329.89 rows=20 width=28) (actual time=1.617..1.627 rows=20.00 loops=1)
  Buffers: shared hit=90
  ->  Sort  (cost=329.84..330.09 rows=100 width=28) (actual time=1.612..1.614 rows=20.00 loops=1)
        Sort Key: created_at DESC, id DESC
        Sort Method: top-N heapsort  Memory: 27kB
        Buffers: shared hit=90
        ->  Bitmap Heap Scan on commandes  (cost=5.07..327.18 rows=100 width=28) (actual time=0.446..1.449 rows=100.00 loops=1)
              Recheck Cond: (client_id = 42)
              Heap Blocks: exact=88
              Buffers: shared hit=90
              ->  Bitmap Index Scan on commandes_client_id_cle_idempotence_key  (cost=0.00..5.04 rows=100 width=0) (actual time=0.365..0.366 rows=100.00 loops=1)
                    Index Cond: (client_id = 42)
                    Index Searches: 1
                    Buffers: shared hit=2
Planning Time: 0.763 ms
Execution Time: 1.872 ms
```

### A3-02 — Mesures de lecture — état initial, client 42 / Échauffement — état initial, client 42 / Mesure 1 — état initial, client 42

```text
Limit  (cost=329.84..329.89 rows=20 width=28) (actual time=1.669..1.683 rows=20.00 loops=1)
  Buffers: shared hit=90
  ->  Sort  (cost=329.84..330.09 rows=100 width=28) (actual time=1.664..1.670 rows=20.00 loops=1)
        Sort Key: created_at DESC, id DESC
        Sort Method: top-N heapsort  Memory: 27kB
        Buffers: shared hit=90
        ->  Bitmap Heap Scan on commandes  (cost=5.07..327.18 rows=100 width=28) (actual time=0.229..1.525 rows=100.00 loops=1)
              Recheck Cond: (client_id = 42)
              Heap Blocks: exact=88
              Buffers: shared hit=90
              ->  Bitmap Index Scan on commandes_client_id_cle_idempotence_key  (cost=0.00..5.04 rows=100 width=0) (actual time=0.154..0.158 rows=100.00 loops=1)
                    Index Cond: (client_id = 42)
                    Index Searches: 1
                    Buffers: shared hit=2
Planning Time: 0.591 ms
Execution Time: 1.834 ms
```

### A3-03 — Échauffement — état initial, client 42 / Mesure 1 — état initial, client 42 / Mesure 2 — état initial, client 42

```text
Limit  (cost=329.84..329.89 rows=20 width=28) (actual time=0.883..0.890 rows=20.00 loops=1)
  Buffers: shared hit=90
  ->  Sort  (cost=329.84..330.09 rows=100 width=28) (actual time=0.883..0.884 rows=20.00 loops=1)
        Sort Key: created_at DESC, id DESC
        Sort Method: top-N heapsort  Memory: 27kB
        Buffers: shared hit=90
        ->  Bitmap Heap Scan on commandes  (cost=5.07..327.18 rows=100 width=28) (actual time=0.168..0.790 rows=100.00 loops=1)
              Recheck Cond: (client_id = 42)
              Heap Blocks: exact=88
              Buffers: shared hit=90
              ->  Bitmap Index Scan on commandes_client_id_cle_idempotence_key  (cost=0.00..5.04 rows=100 width=0) (actual time=0.108..0.108 rows=100.00 loops=1)
                    Index Cond: (client_id = 42)
                    Index Searches: 1
                    Buffers: shared hit=2
Planning Time: 0.587 ms
Execution Time: 0.951 ms
```

### A3-04 — Mesure 1 — état initial, client 42 / Mesure 2 — état initial, client 42 / Mesure 3 — état initial, client 42

```text
Limit  (cost=329.84..329.89 rows=20 width=28) (actual time=0.984..0.990 rows=20.00 loops=1)
  Buffers: shared hit=90
  ->  Sort  (cost=329.84..330.09 rows=100 width=28) (actual time=0.984..0.985 rows=20.00 loops=1)
        Sort Key: created_at DESC, id DESC
        Sort Method: top-N heapsort  Memory: 27kB
        Buffers: shared hit=90
        ->  Bitmap Heap Scan on commandes  (cost=5.07..327.18 rows=100 width=28) (actual time=0.197..0.906 rows=100.00 loops=1)
              Recheck Cond: (client_id = 42)
              Heap Blocks: exact=88
              Buffers: shared hit=90
              ->  Bitmap Index Scan on commandes_client_id_cle_idempotence_key  (cost=0.00..5.04 rows=100 width=0) (actual time=0.130..0.130 rows=100.00 loops=1)
                    Index Cond: (client_id = 42)
                    Index Searches: 1
                    Buffers: shared hit=2
Planning Time: 0.726 ms
Execution Time: 1.113 ms
```

### A3-05 — Mesure 2 — état initial, client 42 / Mesure 3 — état initial, client 42 / Mesure 4 — état initial, client 42

```text
Limit  (cost=329.84..329.89 rows=20 width=28) (actual time=0.985..0.991 rows=20.00 loops=1)
  Buffers: shared hit=90
  ->  Sort  (cost=329.84..330.09 rows=100 width=28) (actual time=0.984..0.986 rows=20.00 loops=1)
        Sort Key: created_at DESC, id DESC
        Sort Method: top-N heapsort  Memory: 27kB
        Buffers: shared hit=90
        ->  Bitmap Heap Scan on commandes  (cost=5.07..327.18 rows=100 width=28) (actual time=0.147..0.889 rows=100.00 loops=1)
              Recheck Cond: (client_id = 42)
              Heap Blocks: exact=88
              Buffers: shared hit=90
              ->  Bitmap Index Scan on commandes_client_id_cle_idempotence_key  (cost=0.00..5.04 rows=100 width=0) (actual time=0.089..0.090 rows=100.00 loops=1)
                    Index Cond: (client_id = 42)
                    Index Searches: 1
                    Buffers: shared hit=2
Planning Time: 0.237 ms
Execution Time: 1.061 ms
```

### A3-06 — Mesure 3 — état initial, client 42 / Mesure 4 — état initial, client 42 / Mesure 5 — état initial, client 42

```text
Limit  (cost=329.84..329.89 rows=20 width=28) (actual time=0.801..0.807 rows=20.00 loops=1)
  Buffers: shared hit=90
  ->  Sort  (cost=329.84..330.09 rows=100 width=28) (actual time=0.799..0.800 rows=20.00 loops=1)
        Sort Key: created_at DESC, id DESC
        Sort Method: top-N heapsort  Memory: 27kB
        Buffers: shared hit=90
        ->  Bitmap Heap Scan on commandes  (cost=5.07..327.18 rows=100 width=28) (actual time=0.163..0.731 rows=100.00 loops=1)
              Recheck Cond: (client_id = 42)
              Heap Blocks: exact=88
              Buffers: shared hit=90
              ->  Bitmap Index Scan on commandes_client_id_cle_idempotence_key  (cost=0.00..5.04 rows=100 width=0) (actual time=0.097..0.097 rows=100.00 loops=1)
                    Index Cond: (client_id = 42)
                    Index Searches: 1
                    Buffers: shared hit=2
Planning Time: 0.234 ms
Execution Time: 0.928 ms
```

### A3-07 — Référence de contenu — client 1, état initial / Mesures de lecture — état initial, client 1 / Échauffement — état initial, client 1

```text
Limit  (cost=329.84..329.89 rows=20 width=28) (actual time=5.122..5.136 rows=20.00 loops=1)
  Buffers: shared hit=99
  ->  Sort  (cost=329.84..330.09 rows=100 width=28) (actual time=5.117..5.124 rows=20.00 loops=1)
        Sort Key: created_at DESC, id DESC
        Sort Method: top-N heapsort  Memory: 27kB
        Buffers: shared hit=99
        ->  Bitmap Heap Scan on commandes  (cost=5.07..327.18 rows=100 width=28) (actual time=0.192..4.977 rows=100.00 loops=1)
              Recheck Cond: (client_id = 1)
              Heap Blocks: exact=97
              Buffers: shared hit=99
              ->  Bitmap Index Scan on commandes_client_id_cle_idempotence_key  (cost=0.00..5.04 rows=100 width=0) (actual time=0.127..0.130 rows=100.00 loops=1)
                    Index Cond: (client_id = 1)
                    Index Searches: 1
                    Buffers: shared hit=2
Planning Time: 0.556 ms
Execution Time: 5.290 ms
```

### A3-08 — Mesures de lecture — état initial, client 1 / Échauffement — état initial, client 1 / Mesure 1 — état initial, client 1

```text
Limit  (cost=329.84..329.89 rows=20 width=28) (actual time=1.969..1.995 rows=20.00 loops=1)
  Buffers: shared hit=99
  ->  Sort  (cost=329.84..330.09 rows=100 width=28) (actual time=1.968..1.971 rows=20.00 loops=1)
        Sort Key: created_at DESC, id DESC
        Sort Method: top-N heapsort  Memory: 27kB
        Buffers: shared hit=99
        ->  Bitmap Heap Scan on commandes  (cost=5.07..327.18 rows=100 width=28) (actual time=0.211..1.755 rows=100.00 loops=1)
              Recheck Cond: (client_id = 1)
              Heap Blocks: exact=97
              Buffers: shared hit=99
              ->  Bitmap Index Scan on commandes_client_id_cle_idempotence_key  (cost=0.00..5.04 rows=100 width=0) (actual time=0.138..0.139 rows=100.00 loops=1)
                    Index Cond: (client_id = 1)
                    Index Searches: 1
                    Buffers: shared hit=2
Planning Time: 1.270 ms
Execution Time: 2.160 ms
```

### A3-09 — Échauffement — état initial, client 1 / Mesure 1 — état initial, client 1 / Mesure 2 — état initial, client 1

```text
Limit  (cost=329.84..329.89 rows=20 width=28) (actual time=1.557..1.569 rows=20.00 loops=1)
  Buffers: shared hit=99
  ->  Sort  (cost=329.84..330.09 rows=100 width=28) (actual time=1.554..1.563 rows=20.00 loops=1)
        Sort Key: created_at DESC, id DESC
        Sort Method: top-N heapsort  Memory: 27kB
        Buffers: shared hit=99
        ->  Bitmap Heap Scan on commandes  (cost=5.07..327.18 rows=100 width=28) (actual time=0.146..1.408 rows=100.00 loops=1)
              Recheck Cond: (client_id = 1)
              Heap Blocks: exact=97
              Buffers: shared hit=99
              ->  Bitmap Index Scan on commandes_client_id_cle_idempotence_key  (cost=0.00..5.04 rows=100 width=0) (actual time=0.079..0.079 rows=100.00 loops=1)
                    Index Cond: (client_id = 1)
                    Index Searches: 1
                    Buffers: shared hit=2
Planning Time: 0.258 ms
Execution Time: 1.656 ms
```

### A3-10 — Mesure 1 — état initial, client 1 / Mesure 2 — état initial, client 1 / Mesure 3 — état initial, client 1

```text
Limit  (cost=329.84..329.89 rows=20 width=28) (actual time=1.105..1.117 rows=20.00 loops=1)
  Buffers: shared hit=99
  ->  Sort  (cost=329.84..330.09 rows=100 width=28) (actual time=1.101..1.106 rows=20.00 loops=1)
        Sort Key: created_at DESC, id DESC
        Sort Method: top-N heapsort  Memory: 27kB
        Buffers: shared hit=99
        ->  Bitmap Heap Scan on commandes  (cost=5.07..327.18 rows=100 width=28) (actual time=0.136..1.018 rows=100.00 loops=1)
              Recheck Cond: (client_id = 1)
              Heap Blocks: exact=97
              Buffers: shared hit=99
              ->  Bitmap Index Scan on commandes_client_id_cle_idempotence_key  (cost=0.00..5.04 rows=100 width=0) (actual time=0.094..0.094 rows=100.00 loops=1)
                    Index Cond: (client_id = 1)
                    Index Searches: 1
                    Buffers: shared hit=2
Planning Time: 0.408 ms
Execution Time: 1.211 ms
```

### A3-11 — Mesure 2 — état initial, client 1 / Mesure 3 — état initial, client 1 / Mesure 4 — état initial, client 1

```text
Limit  (cost=329.84..329.89 rows=20 width=28) (actual time=2.160..2.180 rows=20.00 loops=1)
  Buffers: shared hit=99
  ->  Sort  (cost=329.84..330.09 rows=100 width=28) (actual time=2.154..2.163 rows=20.00 loops=1)
        Sort Key: created_at DESC, id DESC
        Sort Method: top-N heapsort  Memory: 27kB
        Buffers: shared hit=99
        ->  Bitmap Heap Scan on commandes  (cost=5.07..327.18 rows=100 width=28) (actual time=0.328..1.974 rows=100.00 loops=1)
              Recheck Cond: (client_id = 1)
              Heap Blocks: exact=97
              Buffers: shared hit=99
              ->  Bitmap Index Scan on commandes_client_id_cle_idempotence_key  (cost=0.00..5.04 rows=100 width=0) (actual time=0.225..0.225 rows=100.00 loops=1)
                    Index Cond: (client_id = 1)
                    Index Searches: 1
                    Buffers: shared hit=2
Planning Time: 0.854 ms
Execution Time: 2.336 ms
```

### A3-12 — Mesure 3 — état initial, client 1 / Mesure 4 — état initial, client 1 / Mesure 5 — état initial, client 1

```text
Limit  (cost=329.84..329.89 rows=20 width=28) (actual time=1.515..1.524 rows=20.00 loops=1)
  Buffers: shared hit=99
  ->  Sort  (cost=329.84..330.09 rows=100 width=28) (actual time=1.514..1.516 rows=20.00 loops=1)
        Sort Key: created_at DESC, id DESC
        Sort Method: top-N heapsort  Memory: 27kB
        Buffers: shared hit=99
        ->  Bitmap Heap Scan on commandes  (cost=5.07..327.18 rows=100 width=28) (actual time=0.220..1.407 rows=100.00 loops=1)
              Recheck Cond: (client_id = 1)
              Heap Blocks: exact=97
              Buffers: shared hit=99
              ->  Bitmap Index Scan on commandes_client_id_cle_idempotence_key  (cost=0.00..5.04 rows=100 width=0) (actual time=0.129..0.129 rows=100.00 loops=1)
                    Index Cond: (client_id = 1)
                    Index Searches: 1
                    Buffers: shared hit=2
Planning Time: 0.998 ms
Execution Time: 1.654 ms
```

### A3-13 — Référence de contenu — client 999, état initial / Mesures de lecture — état initial, client 999 / Échauffement — état initial, client 999

```text
Limit  (cost=329.84..329.89 rows=20 width=28) (actual time=2.061..2.073 rows=20.00 loops=1)
  Buffers: shared hit=97
  ->  Sort  (cost=329.84..330.09 rows=100 width=28) (actual time=2.060..2.062 rows=20.00 loops=1)
        Sort Key: created_at DESC, id DESC
        Sort Method: top-N heapsort  Memory: 27kB
        Buffers: shared hit=97
        ->  Bitmap Heap Scan on commandes  (cost=5.07..327.18 rows=100 width=28) (actual time=0.613..1.869 rows=100.00 loops=1)
              Recheck Cond: (client_id = 999)
              Heap Blocks: exact=95
              Buffers: shared hit=97
              ->  Bitmap Index Scan on commandes_client_id_cle_idempotence_key  (cost=0.00..5.04 rows=100 width=0) (actual time=0.436..0.436 rows=100.00 loops=1)
                    Index Cond: (client_id = 999)
                    Index Searches: 1
                    Buffers: shared hit=2
Planning Time: 0.947 ms
Execution Time: 2.364 ms
```

### A3-14 — Mesures de lecture — état initial, client 999 / Échauffement — état initial, client 999 / Mesure 1 — état initial, client 999

```text
Limit  (cost=329.84..329.89 rows=20 width=28) (actual time=1.199..1.206 rows=20.00 loops=1)
  Buffers: shared hit=97
  ->  Sort  (cost=329.84..330.09 rows=100 width=28) (actual time=1.198..1.200 rows=20.00 loops=1)
        Sort Key: created_at DESC, id DESC
        Sort Method: top-N heapsort  Memory: 27kB
        Buffers: shared hit=97
        ->  Bitmap Heap Scan on commandes  (cost=5.07..327.18 rows=100 width=28) (actual time=0.197..1.107 rows=100.00 loops=1)
              Recheck Cond: (client_id = 999)
              Heap Blocks: exact=95
              Buffers: shared hit=97
              ->  Bitmap Index Scan on commandes_client_id_cle_idempotence_key  (cost=0.00..5.04 rows=100 width=0) (actual time=0.120..0.120 rows=100.00 loops=1)
                    Index Cond: (client_id = 999)
                    Index Searches: 1
                    Buffers: shared hit=2
Planning Time: 0.501 ms
Execution Time: 1.309 ms
```

### A3-15 — Échauffement — état initial, client 999 / Mesure 1 — état initial, client 999 / Mesure 2 — état initial, client 999

```text
Limit  (cost=329.84..329.89 rows=20 width=28) (actual time=1.544..1.556 rows=20.00 loops=1)
  Buffers: shared hit=97
  ->  Sort  (cost=329.84..330.09 rows=100 width=28) (actual time=1.540..1.544 rows=20.00 loops=1)
        Sort Key: created_at DESC, id DESC
        Sort Method: top-N heapsort  Memory: 27kB
        Buffers: shared hit=97
        ->  Bitmap Heap Scan on commandes  (cost=5.07..327.18 rows=100 width=28) (actual time=0.245..1.437 rows=100.00 loops=1)
              Recheck Cond: (client_id = 999)
              Heap Blocks: exact=95
              Buffers: shared hit=97
              ->  Bitmap Index Scan on commandes_client_id_cle_idempotence_key  (cost=0.00..5.04 rows=100 width=0) (actual time=0.153..0.156 rows=100.00 loops=1)
                    Index Cond: (client_id = 999)
                    Index Searches: 1
                    Buffers: shared hit=2
Planning Time: 0.540 ms
Execution Time: 1.693 ms
```

### A3-16 — Mesure 1 — état initial, client 999 / Mesure 2 — état initial, client 999 / Mesure 3 — état initial, client 999

```text
Limit  (cost=329.84..329.89 rows=20 width=28) (actual time=1.125..1.135 rows=20.00 loops=1)
  Buffers: shared hit=97
  ->  Sort  (cost=329.84..330.09 rows=100 width=28) (actual time=1.124..1.128 rows=20.00 loops=1)
        Sort Key: created_at DESC, id DESC
        Sort Method: top-N heapsort  Memory: 27kB
        Buffers: shared hit=97
        ->  Bitmap Heap Scan on commandes  (cost=5.07..327.18 rows=100 width=28) (actual time=0.220..1.058 rows=100.00 loops=1)
              Recheck Cond: (client_id = 999)
              Heap Blocks: exact=95
              Buffers: shared hit=97
              ->  Bitmap Index Scan on commandes_client_id_cle_idempotence_key  (cost=0.00..5.04 rows=100 width=0) (actual time=0.139..0.139 rows=100.00 loops=1)
                    Index Cond: (client_id = 999)
                    Index Searches: 1
                    Buffers: shared hit=2
Planning Time: 0.466 ms
Execution Time: 1.220 ms
```

### A3-17 — Mesure 2 — état initial, client 999 / Mesure 3 — état initial, client 999 / Mesure 4 — état initial, client 999

```text
Limit  (cost=329.84..329.89 rows=20 width=28) (actual time=2.106..2.119 rows=20.00 loops=1)
  Buffers: shared hit=97
  ->  Sort  (cost=329.84..330.09 rows=100 width=28) (actual time=2.102..2.104 rows=20.00 loops=1)
        Sort Key: created_at DESC, id DESC
        Sort Method: top-N heapsort  Memory: 27kB
        Buffers: shared hit=97
        ->  Bitmap Heap Scan on commandes  (cost=5.07..327.18 rows=100 width=28) (actual time=0.262..1.907 rows=100.00 loops=1)
              Recheck Cond: (client_id = 999)
              Heap Blocks: exact=95
              Buffers: shared hit=97
              ->  Bitmap Index Scan on commandes_client_id_cle_idempotence_key  (cost=0.00..5.04 rows=100 width=0) (actual time=0.163..0.163 rows=100.00 loops=1)
                    Index Cond: (client_id = 999)
                    Index Searches: 1
                    Buffers: shared hit=2
Planning Time: 0.601 ms
Execution Time: 2.264 ms
```

### A3-18 — Mesure 3 — état initial, client 999 / Mesure 4 — état initial, client 999 / Mesure 5 — état initial, client 999

```text
Limit  (cost=329.84..329.89 rows=20 width=28) (actual time=1.522..1.528 rows=20.00 loops=1)
  Buffers: shared hit=97
  ->  Sort  (cost=329.84..330.09 rows=100 width=28) (actual time=1.520..1.523 rows=20.00 loops=1)
        Sort Key: created_at DESC, id DESC
        Sort Method: top-N heapsort  Memory: 27kB
        Buffers: shared hit=97
        ->  Bitmap Heap Scan on commandes  (cost=5.07..327.18 rows=100 width=28) (actual time=0.195..1.437 rows=100.00 loops=1)
              Recheck Cond: (client_id = 999)
              Heap Blocks: exact=95
              Buffers: shared hit=97
              ->  Bitmap Index Scan on commandes_client_id_cle_idempotence_key  (cost=0.00..5.04 rows=100 width=0) (actual time=0.150..0.150 rows=100.00 loops=1)
                    Index Cond: (client_id = 999)
                    Index Searches: 1
                    Buffers: shared hit=2
Planning Time: 0.267 ms
Execution Time: 1.571 ms
```

### A3-19 — Mesure 5 — état initial, client 999 / Insertion — protocole commun aux quatre états / Échauffement documenté — insertion, état initial

```text
Insert on commandes  (cost=0.46..32.97 rows=0 width=0) (actual time=27.347..27.354 rows=0.00 loops=1)
  Buffers: shared hit=5484 dirtied=8
  ->  Nested Loop  (cost=0.46..32.97 rows=1000 width=104) (actual time=1.326..2.044 rows=1000.00 loops=1)
        Buffers: shared hit=15
        ->  Result  (cost=0.45..0.46 rows=1 width=8) (actual time=1.159..1.161 rows=1.00 loops=1)
              Buffers: shared hit=15
              InitPlan 1
                ->  Limit  (cost=0.42..0.45 rows=1 width=8) (actual time=1.145..1.146 rows=1.00 loops=1)
                      Buffers: shared hit=15
                      ->  Index Only Scan Backward using commandes_pkey on commandes commandes_1  (cost=0.42..3712.42 rows=100000 width=8) (actual time=1.144..1.144 rows=1.00 loops=1)
                            Heap Fetches: 1000
                            Index Searches: 1
                            Buffers: shared hit=15
        ->  Function Scan on generate_series g  (cost=0.00..10.00 rows=1000 width=4) (actual time=0.147..0.311 rows=1000.00 loops=1)
Planning Time: 1.441 ms
Trigger for constraint commandes_client_id_fkey: time=6.030 calls=1000
Execution Time: 33.894 ms
```

### A3-20 — Insertion — protocole commun aux quatre états / Échauffement documenté — insertion, état initial / Mesure 1 — insertion, état initial

```text
Insert on commandes  (cost=0.46..32.97 rows=0 width=0) (actual time=48.282..48.318 rows=0.00 loops=1)
  Buffers: shared hit=5485 dirtied=28 written=1
  ->  Nested Loop  (cost=0.46..32.97 rows=1000 width=104) (actual time=6.718..7.617 rows=1000.00 loops=1)
        Buffers: shared hit=15 dirtied=11
        ->  Result  (cost=0.45..0.46 rows=1 width=8) (actual time=6.516..6.520 rows=1.00 loops=1)
              Buffers: shared hit=15 dirtied=11
              InitPlan 1
                ->  Limit  (cost=0.42..0.45 rows=1 width=8) (actual time=6.481..6.482 rows=1.00 loops=1)
                      Buffers: shared hit=15 dirtied=11
                      ->  Index Only Scan Backward using commandes_pkey on commandes commandes_1  (cost=0.42..3712.42 rows=100000 width=8) (actual time=6.476..6.476 rows=1.00 loops=1)
                            Heap Fetches: 1000
                            Index Searches: 1
                            Buffers: shared hit=15 dirtied=11
        ->  Function Scan on generate_series g  (cost=0.00..10.00 rows=1000 width=4) (actual time=0.168..0.378 rows=1000.00 loops=1)
Planning Time: 0.850 ms
Trigger for constraint commandes_client_id_fkey: time=5.044 calls=1000
Execution Time: 53.759 ms
```

### A3-21 — Échauffement documenté — insertion, état initial / Mesure 1 — insertion, état initial / Mesure 2 — insertion, état initial

```text
Insert on commandes  (cost=0.46..32.97 rows=0 width=0) (actual time=19.744..19.753 rows=0.00 loops=1)
  Buffers: shared hit=5465 dirtied=38 written=9
  ->  Nested Loop  (cost=0.46..32.97 rows=1000 width=104) (actual time=4.731..5.255 rows=1000.00 loops=1)
        Buffers: shared hit=15 dirtied=11
        ->  Result  (cost=0.45..0.46 rows=1 width=8) (actual time=4.586..4.588 rows=1.00 loops=1)
              Buffers: shared hit=15 dirtied=11
              InitPlan 1
                ->  Limit  (cost=0.42..0.45 rows=1 width=8) (actual time=4.580..4.581 rows=1.00 loops=1)
                      Buffers: shared hit=15 dirtied=11
                      ->  Index Only Scan Backward using commandes_pkey on commandes commandes_1  (cost=0.42..3712.42 rows=100000 width=8) (actual time=4.578..4.578 rows=1.00 loops=1)
                            Heap Fetches: 1000
                            Index Searches: 1
                            Buffers: shared hit=15 dirtied=11
        ->  Function Scan on generate_series g  (cost=0.00..10.00 rows=1000 width=4) (actual time=0.126..0.257 rows=1000.00 loops=1)
Planning Time: 0.949 ms
Trigger for constraint commandes_client_id_fkey: time=7.480 calls=1000
Execution Time: 27.691 ms
```

### A3-22 — Mesure 1 — insertion, état initial / Mesure 2 — insertion, état initial / Mesure 3 — insertion, état initial

```text
Insert on commandes  (cost=0.46..32.97 rows=0 width=0) (actual time=11.360..11.369 rows=0.00 loops=1)
  Buffers: shared hit=5481 dirtied=8
  ->  Nested Loop  (cost=0.46..32.97 rows=1000 width=104) (actual time=0.617..0.979 rows=1000.00 loops=1)
        Buffers: shared hit=15
        ->  Result  (cost=0.45..0.46 rows=1 width=8) (actual time=0.524..0.526 rows=1.00 loops=1)
              Buffers: shared hit=15
              InitPlan 1
                ->  Limit  (cost=0.42..0.45 rows=1 width=8) (actual time=0.521..0.522 rows=1.00 loops=1)
                      Buffers: shared hit=15
                      ->  Index Only Scan Backward using commandes_pkey on commandes commandes_1  (cost=0.42..3712.42 rows=100000 width=8) (actual time=0.520..0.520 rows=1.00 loops=1)
                            Heap Fetches: 1000
                            Index Searches: 1
                            Buffers: shared hit=15
        ->  Function Scan on generate_series g  (cost=0.00..10.00 rows=1000 width=4) (actual time=0.085..0.176 rows=1000.00 loops=1)
Planning Time: 0.626 ms
Trigger for constraint commandes_client_id_fkey: time=6.362 calls=1000
Execution Time: 18.113 ms
```

### A3-23 — Mesure 2 — insertion, état initial / Mesure 3 — insertion, état initial / Mesure 4 — insertion, état initial

```text
Insert on commandes  (cost=0.46..32.97 rows=0 width=0) (actual time=10.035..10.041 rows=0.00 loops=1)
  Buffers: shared hit=5489 dirtied=11 written=3
  ->  Nested Loop  (cost=0.46..32.97 rows=1000 width=104) (actual time=0.456..0.761 rows=1000.00 loops=1)
        Buffers: shared hit=15
        ->  Result  (cost=0.45..0.46 rows=1 width=8) (actual time=0.382..0.384 rows=1.00 loops=1)
              Buffers: shared hit=15
              InitPlan 1
                ->  Limit  (cost=0.42..0.45 rows=1 width=8) (actual time=0.380..0.381 rows=1.00 loops=1)
                      Buffers: shared hit=15
                      ->  Index Only Scan Backward using commandes_pkey on commandes commandes_1  (cost=0.42..3712.42 rows=100000 width=8) (actual time=0.380..0.380 rows=1.00 loops=1)
                            Heap Fetches: 1000
                            Index Searches: 1
                            Buffers: shared hit=15
        ->  Function Scan on generate_series g  (cost=0.00..10.00 rows=1000 width=4) (actual time=0.068..0.139 rows=1000.00 loops=1)
Planning Time: 0.596 ms
Trigger for constraint commandes_client_id_fkey: time=4.450 calls=1000
Execution Time: 14.727 ms
```

### A3-24 — Mesure 3 — insertion, état initial / Mesure 4 — insertion, état initial / Mesure 5 — insertion, état initial

```text
Insert on commandes  (cost=0.46..32.97 rows=0 width=0) (actual time=13.583..13.590 rows=0.00 loops=1)
  Buffers: shared hit=4050 dirtied=13 written=3
  ->  Nested Loop  (cost=0.46..32.97 rows=1000 width=104) (actual time=0.429..1.058 rows=1000.00 loops=1)
        Buffers: shared hit=5
        ->  Result  (cost=0.45..0.46 rows=1 width=8) (actual time=0.332..0.334 rows=1.00 loops=1)
              Buffers: shared hit=5
              InitPlan 1
                ->  Limit  (cost=0.42..0.45 rows=1 width=8) (actual time=0.328..0.329 rows=1.00 loops=1)
                      Buffers: shared hit=5
                      ->  Index Only Scan Backward using commandes_pkey on commandes commandes_1  (cost=0.42..3712.42 rows=100000 width=8) (actual time=0.327..0.328 rows=1.00 loops=1)
                            Heap Fetches: 1
                            Index Searches: 1
                            Buffers: shared hit=5
        ->  Function Scan on generate_series g  (cost=0.00..10.00 rows=1000 width=4) (actual time=0.086..0.339 rows=1000.00 loops=1)
Planning Time: 2.914 ms
Trigger for constraint commandes_client_id_fkey: time=6.040 calls=1000
Execution Time: 20.052 ms
```

### A3-25 — Tailles des index — état avec index simple / Mesures de lecture — index simple, client 42 / Échauffement — index simple, client 42

```text
Limit  (cost=329.84..329.89 rows=20 width=28) (actual time=1.762..1.774 rows=20.00 loops=1)
  Buffers: shared hit=90
  ->  Sort  (cost=329.84..330.09 rows=100 width=28) (actual time=1.761..1.763 rows=20.00 loops=1)
        Sort Key: created_at DESC, id DESC
        Sort Method: top-N heapsort  Memory: 27kB
        Buffers: shared hit=90
        ->  Bitmap Heap Scan on commandes  (cost=5.07..327.18 rows=100 width=28) (actual time=0.319..1.575 rows=100.00 loops=1)
              Recheck Cond: (client_id = 42)
              Heap Blocks: exact=88
              Buffers: shared hit=90
              ->  Bitmap Index Scan on idx_atelier3_client_simple  (cost=0.00..5.04 rows=100 width=0) (actual time=0.180..0.181 rows=100.00 loops=1)
                    Index Cond: (client_id = 42)
                    Index Searches: 1
                    Buffers: shared hit=2
Planning Time: 0.904 ms
Execution Time: 1.937 ms
```

### A3-26 — Mesures de lecture — index simple, client 42 / Échauffement — index simple, client 42 / Mesure 1 — index simple, client 42

```text
Limit  (cost=329.84..329.89 rows=20 width=28) (actual time=1.359..1.386 rows=20.00 loops=1)
  Buffers: shared hit=90
  ->  Sort  (cost=329.84..330.09 rows=100 width=28) (actual time=1.358..1.360 rows=20.00 loops=1)
        Sort Key: created_at DESC, id DESC
        Sort Method: top-N heapsort  Memory: 27kB
        Buffers: shared hit=90
        ->  Bitmap Heap Scan on commandes  (cost=5.07..327.18 rows=100 width=28) (actual time=0.235..1.232 rows=100.00 loops=1)
              Recheck Cond: (client_id = 42)
              Heap Blocks: exact=88
              Buffers: shared hit=90
              ->  Bitmap Index Scan on idx_atelier3_client_simple  (cost=0.00..5.04 rows=100 width=0) (actual time=0.143..0.143 rows=100.00 loops=1)
                    Index Cond: (client_id = 42)
                    Index Searches: 1
                    Buffers: shared hit=2
Planning Time: 0.636 ms
Execution Time: 1.498 ms
```

### A3-27 — Échauffement — index simple, client 42 / Mesure 1 — index simple, client 42 / Mesure 2 — index simple, client 42

```text
Limit  (cost=329.84..329.89 rows=20 width=28) (actual time=2.224..2.234 rows=20.00 loops=1)
  Buffers: shared hit=90
  ->  Sort  (cost=329.84..330.09 rows=100 width=28) (actual time=2.222..2.225 rows=20.00 loops=1)
        Sort Key: created_at DESC, id DESC
        Sort Method: top-N heapsort  Memory: 27kB
        Buffers: shared hit=90
        ->  Bitmap Heap Scan on commandes  (cost=5.07..327.18 rows=100 width=28) (actual time=0.481..1.957 rows=100.00 loops=1)
              Recheck Cond: (client_id = 42)
              Heap Blocks: exact=88
              Buffers: shared hit=90
              ->  Bitmap Index Scan on idx_atelier3_client_simple  (cost=0.00..5.04 rows=100 width=0) (actual time=0.226..0.226 rows=100.00 loops=1)
                    Index Cond: (client_id = 42)
                    Index Searches: 1
                    Buffers: shared hit=2
Planning Time: 0.679 ms
Execution Time: 2.445 ms
```

### A3-28 — Mesure 1 — index simple, client 42 / Mesure 2 — index simple, client 42 / Mesure 3 — index simple, client 42

```text
Limit  (cost=329.84..329.89 rows=20 width=28) (actual time=2.455..2.513 rows=20.00 loops=1)
  Buffers: shared hit=90
  ->  Sort  (cost=329.84..330.09 rows=100 width=28) (actual time=2.453..2.456 rows=20.00 loops=1)
        Sort Key: created_at DESC, id DESC
        Sort Method: top-N heapsort  Memory: 27kB
        Buffers: shared hit=90
        ->  Bitmap Heap Scan on commandes  (cost=5.07..327.18 rows=100 width=28) (actual time=1.027..2.191 rows=100.00 loops=1)
              Recheck Cond: (client_id = 42)
              Heap Blocks: exact=88
              Buffers: shared hit=90
              ->  Bitmap Index Scan on idx_atelier3_client_simple  (cost=0.00..5.04 rows=100 width=0) (actual time=0.520..0.520 rows=100.00 loops=1)
                    Index Cond: (client_id = 42)
                    Index Searches: 1
                    Buffers: shared hit=2
Planning Time: 1.508 ms
Execution Time: 2.907 ms
```

### A3-29 — Mesure 2 — index simple, client 42 / Mesure 3 — index simple, client 42 / Mesure 4 — index simple, client 42

```text
Limit  (cost=329.84..329.89 rows=20 width=28) (actual time=1.862..1.872 rows=20.00 loops=1)
  Buffers: shared hit=90
  ->  Sort  (cost=329.84..330.09 rows=100 width=28) (actual time=1.861..1.863 rows=20.00 loops=1)
        Sort Key: created_at DESC, id DESC
        Sort Method: top-N heapsort  Memory: 27kB
        Buffers: shared hit=90
        ->  Bitmap Heap Scan on commandes  (cost=5.07..327.18 rows=100 width=28) (actual time=0.402..1.735 rows=100.00 loops=1)
              Recheck Cond: (client_id = 42)
              Heap Blocks: exact=88
              Buffers: shared hit=90
              ->  Bitmap Index Scan on idx_atelier3_client_simple  (cost=0.00..5.04 rows=100 width=0) (actual time=0.282..0.282 rows=100.00 loops=1)
                    Index Cond: (client_id = 42)
                    Index Searches: 1
                    Buffers: shared hit=2
Planning Time: 1.115 ms
Execution Time: 1.989 ms
```

### A3-30 — Mesure 3 — index simple, client 42 / Mesure 4 — index simple, client 42 / Mesure 5 — index simple, client 42

```text
Limit  (cost=329.84..329.89 rows=20 width=28) (actual time=1.179..1.187 rows=20.00 loops=1)
  Buffers: shared hit=90
  ->  Sort  (cost=329.84..330.09 rows=100 width=28) (actual time=1.179..1.180 rows=20.00 loops=1)
        Sort Key: created_at DESC, id DESC
        Sort Method: top-N heapsort  Memory: 27kB
        Buffers: shared hit=90
        ->  Bitmap Heap Scan on commandes  (cost=5.07..327.18 rows=100 width=28) (actual time=0.439..1.028 rows=100.00 loops=1)
              Recheck Cond: (client_id = 42)
              Heap Blocks: exact=88
              Buffers: shared hit=90
              ->  Bitmap Index Scan on idx_atelier3_client_simple  (cost=0.00..5.04 rows=100 width=0) (actual time=0.290..0.290 rows=100.00 loops=1)
                    Index Cond: (client_id = 42)
                    Index Searches: 1
                    Buffers: shared hit=2
Planning Time: 0.507 ms
Execution Time: 1.323 ms
```

### A3-31 — Mesure 4 — index simple, client 42 / Mesure 5 — index simple, client 42 / Échauffement — index simple, client 1

```text
Limit  (cost=329.84..329.89 rows=20 width=28) (actual time=2.812..2.825 rows=20.00 loops=1)
  Buffers: shared hit=99
  ->  Sort  (cost=329.84..330.09 rows=100 width=28) (actual time=2.807..2.813 rows=20.00 loops=1)
        Sort Key: created_at DESC, id DESC
        Sort Method: top-N heapsort  Memory: 27kB
        Buffers: shared hit=99
        ->  Bitmap Heap Scan on commandes  (cost=5.07..327.18 rows=100 width=28) (actual time=1.201..2.650 rows=100.00 loops=1)
              Recheck Cond: (client_id = 1)
              Heap Blocks: exact=97
              Buffers: shared hit=99
              ->  Bitmap Index Scan on idx_atelier3_client_simple  (cost=0.00..5.04 rows=100 width=0) (actual time=0.202..0.205 rows=100.00 loops=1)
                    Index Cond: (client_id = 1)
                    Index Searches: 1
                    Buffers: shared hit=2
Planning Time: 0.749 ms
Execution Time: 2.994 ms
```

### A3-32 — Mesure 5 — index simple, client 42 / Échauffement — index simple, client 1 / Mesure 1 — index simple, client 1

```text
Limit  (cost=329.84..329.89 rows=20 width=28) (actual time=1.757..1.769 rows=20.00 loops=1)
  Buffers: shared hit=99
  ->  Sort  (cost=329.84..330.09 rows=100 width=28) (actual time=1.756..1.759 rows=20.00 loops=1)
        Sort Key: created_at DESC, id DESC
        Sort Method: top-N heapsort  Memory: 27kB
        Buffers: shared hit=99
        ->  Bitmap Heap Scan on commandes  (cost=5.07..327.18 rows=100 width=28) (actual time=0.304..1.624 rows=100.00 loops=1)
              Recheck Cond: (client_id = 1)
              Heap Blocks: exact=97
              Buffers: shared hit=99
              ->  Bitmap Index Scan on idx_atelier3_client_simple  (cost=0.00..5.04 rows=100 width=0) (actual time=0.187..0.188 rows=100.00 loops=1)
                    Index Cond: (client_id = 1)
                    Index Searches: 1
                    Buffers: shared hit=2
Planning Time: 0.883 ms
Execution Time: 2.050 ms
```

### A3-33 — Échauffement — index simple, client 1 / Mesure 1 — index simple, client 1 / Mesure 2 — index simple, client 1

```text
Limit  (cost=329.84..329.89 rows=20 width=28) (actual time=1.663..1.677 rows=20.00 loops=1)
  Buffers: shared hit=99
  ->  Sort  (cost=329.84..330.09 rows=100 width=28) (actual time=1.662..1.668 rows=20.00 loops=1)
        Sort Key: created_at DESC, id DESC
        Sort Method: top-N heapsort  Memory: 27kB
        Buffers: shared hit=99
        ->  Bitmap Heap Scan on commandes  (cost=5.07..327.18 rows=100 width=28) (actual time=0.282..1.543 rows=100.00 loops=1)
              Recheck Cond: (client_id = 1)
              Heap Blocks: exact=97
              Buffers: shared hit=99
              ->  Bitmap Index Scan on idx_atelier3_client_simple  (cost=0.00..5.04 rows=100 width=0) (actual time=0.180..0.183 rows=100.00 loops=1)
                    Index Cond: (client_id = 1)
                    Index Searches: 1
                    Buffers: shared hit=2
Planning Time: 0.566 ms
Execution Time: 1.785 ms
```

### A3-34 — Mesure 1 — index simple, client 1 / Mesure 2 — index simple, client 1 / Mesure 3 — index simple, client 1

```text
Limit  (cost=329.84..329.89 rows=20 width=28) (actual time=1.962..1.969 rows=20.00 loops=1)
  Buffers: shared hit=99
  ->  Sort  (cost=329.84..330.09 rows=100 width=28) (actual time=1.960..1.963 rows=20.00 loops=1)
        Sort Key: created_at DESC, id DESC
        Sort Method: top-N heapsort  Memory: 27kB
        Buffers: shared hit=99
        ->  Bitmap Heap Scan on commandes  (cost=5.07..327.18 rows=100 width=28) (actual time=0.186..1.859 rows=100.00 loops=1)
              Recheck Cond: (client_id = 1)
              Heap Blocks: exact=97
              Buffers: shared hit=99
              ->  Bitmap Index Scan on idx_atelier3_client_simple  (cost=0.00..5.04 rows=100 width=0) (actual time=0.094..0.094 rows=100.00 loops=1)
                    Index Cond: (client_id = 1)
                    Index Searches: 1
                    Buffers: shared hit=2
Planning Time: 0.518 ms
Execution Time: 2.033 ms
```

### A3-35 — Mesure 2 — index simple, client 1 / Mesure 3 — index simple, client 1 / Mesure 4 — index simple, client 1

```text
Limit  (cost=329.84..329.89 rows=20 width=28) (actual time=1.578..1.593 rows=20.00 loops=1)
  Buffers: shared hit=99
  ->  Sort  (cost=329.84..330.09 rows=100 width=28) (actual time=1.574..1.579 rows=20.00 loops=1)
        Sort Key: created_at DESC, id DESC
        Sort Method: top-N heapsort  Memory: 27kB
        Buffers: shared hit=99
        ->  Bitmap Heap Scan on commandes  (cost=5.07..327.18 rows=100 width=28) (actual time=0.209..1.440 rows=100.00 loops=1)
              Recheck Cond: (client_id = 1)
              Heap Blocks: exact=97
              Buffers: shared hit=99
              ->  Bitmap Index Scan on idx_atelier3_client_simple  (cost=0.00..5.04 rows=100 width=0) (actual time=0.142..0.145 rows=100.00 loops=1)
                    Index Cond: (client_id = 1)
                    Index Searches: 1
                    Buffers: shared hit=2
Planning Time: 0.497 ms
Execution Time: 1.737 ms
```

### A3-36 — Mesure 3 — index simple, client 1 / Mesure 4 — index simple, client 1 / Mesure 5 — index simple, client 1

```text
Limit  (cost=329.84..329.89 rows=20 width=28) (actual time=1.260..1.269 rows=20.00 loops=1)
  Buffers: shared hit=99
  ->  Sort  (cost=329.84..330.09 rows=100 width=28) (actual time=1.260..1.261 rows=20.00 loops=1)
        Sort Key: created_at DESC, id DESC
        Sort Method: top-N heapsort  Memory: 27kB
        Buffers: shared hit=99
        ->  Bitmap Heap Scan on commandes  (cost=5.07..327.18 rows=100 width=28) (actual time=0.270..1.169 rows=100.00 loops=1)
              Recheck Cond: (client_id = 1)
              Heap Blocks: exact=97
              Buffers: shared hit=99
              ->  Bitmap Index Scan on idx_atelier3_client_simple  (cost=0.00..5.04 rows=100 width=0) (actual time=0.135..0.135 rows=100.00 loops=1)
                    Index Cond: (client_id = 1)
                    Index Searches: 1
                    Buffers: shared hit=2
Planning Time: 1.283 ms
Execution Time: 1.492 ms
```

### A3-37 — Contrôle du contenu — index simple, client 999 / Mesures de lecture — index simple, client 999 / Échauffement — index simple, client 999

```text
Limit  (cost=329.84..329.89 rows=20 width=28) (actual time=1.892..1.909 rows=20.00 loops=1)
  Buffers: shared hit=97
  ->  Sort  (cost=329.84..330.09 rows=100 width=28) (actual time=1.887..1.894 rows=20.00 loops=1)
        Sort Key: created_at DESC, id DESC
        Sort Method: top-N heapsort  Memory: 27kB
        Buffers: shared hit=97
        ->  Bitmap Heap Scan on commandes  (cost=5.07..327.18 rows=100 width=28) (actual time=0.306..1.704 rows=100.00 loops=1)
              Recheck Cond: (client_id = 999)
              Heap Blocks: exact=95
              Buffers: shared hit=97
              ->  Bitmap Index Scan on idx_atelier3_client_simple  (cost=0.00..5.04 rows=100 width=0) (actual time=0.167..0.171 rows=100.00 loops=1)
                    Index Cond: (client_id = 999)
                    Index Searches: 1
                    Buffers: shared hit=2
Planning Time: 0.829 ms
Execution Time: 2.047 ms
```

### A3-38 — Mesures de lecture — index simple, client 999 / Échauffement — index simple, client 999 / Mesure 1 — index simple, client 999

```text
Limit  (cost=329.84..329.89 rows=20 width=28) (actual time=1.640..1.650 rows=20.00 loops=1)
  Buffers: shared hit=97
  ->  Sort  (cost=329.84..330.09 rows=100 width=28) (actual time=1.635..1.638 rows=20.00 loops=1)
        Sort Key: created_at DESC, id DESC
        Sort Method: top-N heapsort  Memory: 27kB
        Buffers: shared hit=97
        ->  Bitmap Heap Scan on commandes  (cost=5.07..327.18 rows=100 width=28) (actual time=0.304..1.503 rows=100.00 loops=1)
              Recheck Cond: (client_id = 999)
              Heap Blocks: exact=95
              Buffers: shared hit=97
              ->  Bitmap Index Scan on idx_atelier3_client_simple  (cost=0.00..5.04 rows=100 width=0) (actual time=0.183..0.183 rows=100.00 loops=1)
                    Index Cond: (client_id = 999)
                    Index Searches: 1
                    Buffers: shared hit=2
Planning Time: 1.019 ms
Execution Time: 1.773 ms
```

### A3-39 — Échauffement — index simple, client 999 / Mesure 1 — index simple, client 999 / Mesure 2 — index simple, client 999

```text
Limit  (cost=329.84..329.89 rows=20 width=28) (actual time=1.494..1.502 rows=20.00 loops=1)
  Buffers: shared hit=97
  ->  Sort  (cost=329.84..330.09 rows=100 width=28) (actual time=1.493..1.496 rows=20.00 loops=1)
        Sort Key: created_at DESC, id DESC
        Sort Method: top-N heapsort  Memory: 27kB
        Buffers: shared hit=97
        ->  Bitmap Heap Scan on commandes  (cost=5.07..327.18 rows=100 width=28) (actual time=0.176..1.410 rows=100.00 loops=1)
              Recheck Cond: (client_id = 999)
              Heap Blocks: exact=95
              Buffers: shared hit=97
              ->  Bitmap Index Scan on idx_atelier3_client_simple  (cost=0.00..5.04 rows=100 width=0) (actual time=0.090..0.090 rows=100.00 loops=1)
                    Index Cond: (client_id = 999)
                    Index Searches: 1
                    Buffers: shared hit=2
Planning Time: 0.425 ms
Execution Time: 1.666 ms
```

### A3-40 — Mesure 1 — index simple, client 999 / Mesure 2 — index simple, client 999 / Mesure 3 — index simple, client 999

```text
Limit  (cost=329.84..329.89 rows=20 width=28) (actual time=1.635..1.648 rows=20.00 loops=1)
  Buffers: shared hit=97
  ->  Sort  (cost=329.84..330.09 rows=100 width=28) (actual time=1.634..1.640 rows=20.00 loops=1)
        Sort Key: created_at DESC, id DESC
        Sort Method: top-N heapsort  Memory: 27kB
        Buffers: shared hit=97
        ->  Bitmap Heap Scan on commandes  (cost=5.07..327.18 rows=100 width=28) (actual time=0.375..1.518 rows=100.00 loops=1)
              Recheck Cond: (client_id = 999)
              Heap Blocks: exact=95
              Buffers: shared hit=97
              ->  Bitmap Index Scan on idx_atelier3_client_simple  (cost=0.00..5.04 rows=100 width=0) (actual time=0.207..0.210 rows=100.00 loops=1)
                    Index Cond: (client_id = 999)
                    Index Searches: 1
                    Buffers: shared hit=2
Planning Time: 0.593 ms
Execution Time: 1.886 ms
```

### A3-41 — Mesure 2 — index simple, client 999 / Mesure 3 — index simple, client 999 / Mesure 4 — index simple, client 999

```text
Limit  (cost=329.84..329.89 rows=20 width=28) (actual time=1.581..1.594 rows=20.00 loops=1)
  Buffers: shared hit=97
  ->  Sort  (cost=329.84..330.09 rows=100 width=28) (actual time=1.580..1.582 rows=20.00 loops=1)
        Sort Key: created_at DESC, id DESC
        Sort Method: top-N heapsort  Memory: 27kB
        Buffers: shared hit=97
        ->  Bitmap Heap Scan on commandes  (cost=5.07..327.18 rows=100 width=28) (actual time=0.224..1.442 rows=100.00 loops=1)
              Recheck Cond: (client_id = 999)
              Heap Blocks: exact=95
              Buffers: shared hit=97
              ->  Bitmap Index Scan on idx_atelier3_client_simple  (cost=0.00..5.04 rows=100 width=0) (actual time=0.139..0.139 rows=100.00 loops=1)
                    Index Cond: (client_id = 999)
                    Index Searches: 1
                    Buffers: shared hit=2
Planning Time: 0.661 ms
Execution Time: 1.707 ms
```

### A3-42 — Mesure 3 — index simple, client 999 / Mesure 4 — index simple, client 999 / Mesure 5 — index simple, client 999

```text
Limit  (cost=329.84..329.89 rows=20 width=28) (actual time=1.115..1.120 rows=20.00 loops=1)
  Buffers: shared hit=97
  ->  Sort  (cost=329.84..330.09 rows=100 width=28) (actual time=1.113..1.116 rows=20.00 loops=1)
        Sort Key: created_at DESC, id DESC
        Sort Method: top-N heapsort  Memory: 27kB
        Buffers: shared hit=97
        ->  Bitmap Heap Scan on commandes  (cost=5.07..327.18 rows=100 width=28) (actual time=0.113..1.037 rows=100.00 loops=1)
              Recheck Cond: (client_id = 999)
              Heap Blocks: exact=95
              Buffers: shared hit=97
              ->  Bitmap Index Scan on idx_atelier3_client_simple  (cost=0.00..5.04 rows=100 width=0) (actual time=0.071..0.072 rows=100.00 loops=1)
                    Index Cond: (client_id = 999)
                    Index Searches: 1
                    Buffers: shared hit=2
Planning Time: 0.279 ms
Execution Time: 1.155 ms
```

### A3-43 — Annexe 6 — Atelier 3 : plans composé et couvrant du client 42 / Index composé — SQL / Échauffement

```text
Limit  (cost=0.42..79.96 rows=20 width=28) (actual time=0.201..0.345 rows=20.00 loops=1)
  Buffers: shared hit=23
  ->  Index Scan using idx_atelier3_hist_compose on commandes  (cost=0.42..398.14 rows=100 width=28) (actual time=0.200..0.339 rows=20.00 loops=1)
        Index Cond: (client_id = 42)
        Index Searches: 1
        Buffers: shared hit=23
Planning Time: 0.392 ms
Execution Time: 0.388 ms
```

### A3-44 — Index composé — SQL / Échauffement / Mesure 1

```text
Limit  (cost=0.42..79.96 rows=20 width=28) (actual time=0.169..0.418 rows=20.00 loops=1)
  Buffers: shared hit=23
  ->  Index Scan using idx_atelier3_hist_compose on commandes  (cost=0.42..398.14 rows=100 width=28) (actual time=0.168..0.414 rows=20.00 loops=1)
        Index Cond: (client_id = 42)
        Index Searches: 1
        Buffers: shared hit=23
Planning Time: 0.267 ms
Execution Time: 0.496 ms
```

### A3-45 — Échauffement / Mesure 1 / Mesure 2

```text
Limit  (cost=0.42..79.96 rows=20 width=28) (actual time=0.238..0.531 rows=20.00 loops=1)
  Buffers: shared hit=23
  ->  Index Scan using idx_atelier3_hist_compose on commandes  (cost=0.42..398.14 rows=100 width=28) (actual time=0.237..0.517 rows=20.00 loops=1)
        Index Cond: (client_id = 42)
        Index Searches: 1
        Buffers: shared hit=23
Planning Time: 1.219 ms
Execution Time: 0.684 ms
```

### A3-46 — Mesure 1 / Mesure 2 / Mesure 3

```text
Limit  (cost=0.42..79.96 rows=20 width=28) (actual time=0.085..0.198 rows=20.00 loops=1)
  Buffers: shared hit=23
  ->  Index Scan using idx_atelier3_hist_compose on commandes  (cost=0.42..398.14 rows=100 width=28) (actual time=0.084..0.195 rows=20.00 loops=1)
        Index Cond: (client_id = 42)
        Index Searches: 1
        Buffers: shared hit=23
Planning Time: 0.150 ms
Execution Time: 0.227 ms
```

### A3-47 — Mesure 2 / Mesure 3 / Mesure 4

```text
Limit  (cost=0.42..79.96 rows=20 width=28) (actual time=0.180..0.503 rows=20.00 loops=1)
  Buffers: shared hit=23
  ->  Index Scan using idx_atelier3_hist_compose on commandes  (cost=0.42..398.14 rows=100 width=28) (actual time=0.179..0.495 rows=20.00 loops=1)
        Index Cond: (client_id = 42)
        Index Searches: 1
        Buffers: shared hit=23
Planning Time: 0.324 ms
Execution Time: 0.562 ms
```

### A3-48 — Mesure 3 / Mesure 4 / Mesure 5

```text
Limit  (cost=0.42..79.96 rows=20 width=28) (actual time=0.153..0.373 rows=20.00 loops=1)
  Buffers: shared hit=23
  ->  Index Scan using idx_atelier3_hist_compose on commandes  (cost=0.42..398.14 rows=100 width=28) (actual time=0.152..0.368 rows=20.00 loops=1)
        Index Cond: (client_id = 42)
        Index Searches: 1
        Buffers: shared hit=23
Planning Time: 0.300 ms
Execution Time: 0.427 ms
```

### A3-49 — Mesure 5 / Index couvrant — SQL / Échauffement

```text
Limit  (cost=0.42..1.57 rows=20 width=28) (actual time=0.136..0.142 rows=20.00 loops=1)
  Buffers: shared hit=4
  ->  Index Only Scan using idx_atelier3_hist_couvrant on commandes  (cost=0.42..6.17 rows=100 width=28) (actual time=0.135..0.137 rows=20.00 loops=1)
        Index Cond: (client_id = 42)
        Heap Fetches: 0
        Index Searches: 1
        Buffers: shared hit=4
Planning Time: 0.518 ms
Execution Time: 0.192 ms
```

### A3-50 — Index couvrant — SQL / Échauffement / Mesure 1

```text
Limit  (cost=0.42..1.57 rows=20 width=28) (actual time=0.268..0.284 rows=20.00 loops=1)
  Buffers: shared hit=4
  ->  Index Only Scan using idx_atelier3_hist_couvrant on commandes  (cost=0.42..6.17 rows=100 width=28) (actual time=0.266..0.271 rows=20.00 loops=1)
        Index Cond: (client_id = 42)
        Heap Fetches: 0
        Index Searches: 1
        Buffers: shared hit=4
Planning Time: 0.455 ms
Execution Time: 0.406 ms
```

### A3-51 — Échauffement / Mesure 1 / Mesure 2

```text
Limit  (cost=0.42..1.57 rows=20 width=28) (actual time=0.151..0.159 rows=20.00 loops=1)
  Buffers: shared hit=4
  ->  Index Only Scan using idx_atelier3_hist_couvrant on commandes  (cost=0.42..6.17 rows=100 width=28) (actual time=0.150..0.153 rows=20.00 loops=1)
        Index Cond: (client_id = 42)
        Heap Fetches: 0
        Index Searches: 1
        Buffers: shared hit=4
Planning Time: 0.233 ms
Execution Time: 0.225 ms
```

### A3-52 — Mesure 1 / Mesure 2 / Mesure 3

```text
Limit  (cost=0.42..1.57 rows=20 width=28) (actual time=0.165..0.173 rows=20.00 loops=1)
  Buffers: shared hit=4
  ->  Index Only Scan using idx_atelier3_hist_couvrant on commandes  (cost=0.42..6.17 rows=100 width=28) (actual time=0.164..0.167 rows=20.00 loops=1)
        Index Cond: (client_id = 42)
        Heap Fetches: 0
        Index Searches: 1
        Buffers: shared hit=4
Planning Time: 0.438 ms
Execution Time: 0.234 ms
```

### A3-53 — Mesure 2 / Mesure 3 / Mesure 4

```text
Limit  (cost=0.42..1.57 rows=20 width=28) (actual time=0.137..0.146 rows=20.00 loops=1)
  Buffers: shared hit=4
  ->  Index Only Scan using idx_atelier3_hist_couvrant on commandes  (cost=0.42..6.17 rows=100 width=28) (actual time=0.135..0.140 rows=20.00 loops=1)
        Index Cond: (client_id = 42)
        Heap Fetches: 0
        Index Searches: 1
        Buffers: shared hit=4
Planning Time: 0.295 ms
Execution Time: 0.229 ms
```

### A3-54 — Mesure 3 / Mesure 4 / Mesure 5

```text
Limit  (cost=0.42..1.57 rows=20 width=28) (actual time=0.263..0.273 rows=20.00 loops=1)
  Buffers: shared hit=4
  ->  Index Only Scan using idx_atelier3_hist_couvrant on commandes  (cost=0.42..6.17 rows=100 width=28) (actual time=0.261..0.264 rows=20.00 loops=1)
        Index Cond: (client_id = 42)
        Heap Fetches: 0
        Index Searches: 1
        Buffers: shared hit=4
Planning Time: 0.903 ms
Execution Time: 0.375 ms
```

### A3-55 — Annexe 9 — Insertion avec index simple : plans complets / Échauffement

```text
Insert on commandes  (cost=0.46..32.97 rows=0 width=0) (actual time=19.697..19.736 rows=0.00 loops=1)
  Buffers: shared hit=8167 read=2 dirtied=35 written=5
  ->  Nested Loop  (cost=0.46..32.97 rows=1000 width=104) (actual time=2.434..2.961 rows=1000.00 loops=1)
        Buffers: shared hit=27 dirtied=5
        ->  Result  (cost=0.46..0.47 rows=1 width=8) (actual time=2.313..2.315 rows=1.00 loops=1)
              Buffers: shared hit=27 dirtied=5
              InitPlan 1
                ->  Limit  (cost=0.42..0.46 rows=1 width=8) (actual time=2.308..2.309 rows=1.00 loops=1)
                      Buffers: shared hit=27 dirtied=5
                      ->  Index Only Scan Backward using commandes_pkey on commandes commandes_1  (cost=0.42..3915.82 rows=100000 width=8) (actual time=2.306..2.307 rows=1.00 loops=1)
                            Heap Fetches: 2000
                            Index Searches: 1
                            Buffers: shared hit=27 dirtied=5
        ->  Function Scan on generate_series g  (cost=0.00..10.00 rows=1000 width=4) (actual time=0.107..0.244 rows=1000.00 loops=1)
Planning:
  Buffers: shared hit=3
Planning Time: 1.703 ms
Trigger for constraint commandes_client_id_fkey: time=7.535 calls=1000
Execution Time: 28.261 ms
```

### A3-56 — Annexe 9 — Insertion avec index simple : plans complets / Échauffement / Mesure 1

```text
Insert on commandes  (cost=0.46..32.97 rows=0 width=0) (actual time=16.779..16.790 rows=0.00 loops=1)
  Buffers: shared hit=8178 dirtied=8
  ->  Nested Loop  (cost=0.46..32.97 rows=1000 width=104) (actual time=0.928..1.826 rows=1000.00 loops=1)
        Buffers: shared hit=18
        ->  Result  (cost=0.46..0.47 rows=1 width=8) (actual time=0.767..0.776 rows=1.00 loops=1)
              Buffers: shared hit=18
              InitPlan 1
                ->  Limit  (cost=0.42..0.46 rows=1 width=8) (actual time=0.762..0.767 rows=1.00 loops=1)
                      Buffers: shared hit=18
                      ->  Index Only Scan Backward using commandes_pkey on commandes commandes_1  (cost=0.42..3915.82 rows=100000 width=8) (actual time=0.758..0.763 rows=1.00 loops=1)
                            Heap Fetches: 1000
                            Index Searches: 1
                            Buffers: shared hit=18
        ->  Function Scan on generate_series g  (cost=0.00..10.00 rows=1000 width=4) (actual time=0.141..0.301 rows=1000.00 loops=1)
Planning Time: 1.177 ms
Trigger for constraint commandes_client_id_fkey: time=4.658 calls=1000
Execution Time: 22.712 ms
```

### A3-57 — Échauffement / Mesure 1 / Mesure 2

```text
Insert on commandes  (cost=0.46..32.97 rows=0 width=0) (actual time=19.747..19.759 rows=0.00 loops=1)
  Buffers: shared hit=8191 dirtied=14 written=6
  ->  Nested Loop  (cost=0.46..32.97 rows=1000 width=104) (actual time=1.115..1.688 rows=1000.00 loops=1)
        Buffers: shared hit=18
        ->  Result  (cost=0.46..0.47 rows=1 width=8) (actual time=0.922..0.928 rows=1.00 loops=1)
              Buffers: shared hit=18
              InitPlan 1
                ->  Limit  (cost=0.42..0.46 rows=1 width=8) (actual time=0.918..0.923 rows=1.00 loops=1)
                      Buffers: shared hit=18
                      ->  Index Only Scan Backward using commandes_pkey on commandes commandes_1  (cost=0.42..3915.82 rows=100000 width=8) (actual time=0.917..0.922 rows=1.00 loops=1)
                            Heap Fetches: 1000
                            Index Searches: 1
                            Buffers: shared hit=18
        ->  Function Scan on generate_series g  (cost=0.00..10.00 rows=1000 width=4) (actual time=0.140..0.302 rows=1000.00 loops=1)
Planning Time: 0.862 ms
Trigger for constraint commandes_client_id_fkey: time=5.315 calls=1000
Execution Time: 25.532 ms
```

### A3-58 — Mesure 1 / Mesure 2 / Mesure 3

```text
Insert on commandes  (cost=0.46..32.97 rows=0 width=0) (actual time=21.693..21.700 rows=0.00 loops=1)
  Buffers: shared hit=8159 dirtied=16 written=7
  ->  Nested Loop  (cost=0.46..32.97 rows=1000 width=104) (actual time=0.913..1.556 rows=1000.00 loops=1)
        Buffers: shared hit=18
        ->  Result  (cost=0.46..0.47 rows=1 width=8) (actual time=0.764..0.769 rows=1.00 loops=1)
              Buffers: shared hit=18
              InitPlan 1
                ->  Limit  (cost=0.42..0.46 rows=1 width=8) (actual time=0.760..0.761 rows=1.00 loops=1)
                      Buffers: shared hit=18
                      ->  Index Only Scan Backward using commandes_pkey on commandes commandes_1  (cost=0.42..3915.82 rows=100000 width=8) (actual time=0.759..0.760 rows=1.00 loops=1)
                            Heap Fetches: 1000
                            Index Searches: 1
                            Buffers: shared hit=18
        ->  Function Scan on generate_series g  (cost=0.00..10.00 rows=1000 width=4) (actual time=0.131..0.326 rows=1000.00 loops=1)
Planning Time: 0.817 ms
Trigger for constraint commandes_client_id_fkey: time=4.933 calls=1000
Execution Time: 26.996 ms
```

### A3-59 — Mesure 2 / Mesure 3 / Mesure 4

```text
Insert on commandes  (cost=0.46..32.97 rows=0 width=0) (actual time=7.646..7.652 rows=0.00 loops=1)
  Buffers: shared hit=7553 dirtied=11 written=3
  ->  Nested Loop  (cost=0.46..32.97 rows=1000 width=104) (actual time=0.116..0.491 rows=1000.00 loops=1)
        Buffers: shared hit=8
        ->  Result  (cost=0.46..0.47 rows=1 width=8) (actual time=0.045..0.046 rows=1.00 loops=1)
              Buffers: shared hit=8
              InitPlan 1
                ->  Limit  (cost=0.42..0.46 rows=1 width=8) (actual time=0.042..0.042 rows=1.00 loops=1)
                      Buffers: shared hit=8
                      ->  Index Only Scan Backward using commandes_pkey on commandes commandes_1  (cost=0.42..3915.82 rows=100000 width=8) (actual time=0.041..0.041 rows=1.00 loops=1)
                            Heap Fetches: 1
                            Index Searches: 1
                            Buffers: shared hit=8
        ->  Function Scan on generate_series g  (cost=0.00..10.00 rows=1000 width=4) (actual time=0.063..0.154 rows=1000.00 loops=1)
Planning Time: 0.289 ms
Trigger for constraint commandes_client_id_fkey: time=9.297 calls=1000
Execution Time: 17.117 ms
```

### A3-60 — Mesure 3 / Mesure 4 / Mesure 5

```text
Insert on commandes  (cost=0.46..32.97 rows=0 width=0) (actual time=14.549..14.561 rows=0.00 loops=1)
  Buffers: shared hit=6056 dirtied=16 written=6
  ->  Nested Loop  (cost=0.46..32.97 rows=1000 width=104) (actual time=0.598..1.061 rows=1000.00 loops=1)
        Buffers: shared hit=5
        ->  Result  (cost=0.46..0.47 rows=1 width=8) (actual time=0.381..0.382 rows=1.00 loops=1)
              Buffers: shared hit=5
              InitPlan 1
                ->  Limit  (cost=0.42..0.46 rows=1 width=8) (actual time=0.360..0.361 rows=1.00 loops=1)
                      Buffers: shared hit=5
                      ->  Index Only Scan Backward using commandes_pkey on commandes commandes_1  (cost=0.42..3915.82 rows=100000 width=8) (actual time=0.359..0.359 rows=1.00 loops=1)
                            Heap Fetches: 1
                            Index Searches: 1
                            Buffers: shared hit=5
        ->  Function Scan on generate_series g  (cost=0.00..10.00 rows=1000 width=4) (actual time=0.184..0.318 rows=1000.00 loops=1)
Planning Time: 1.138 ms
Trigger for constraint commandes_client_id_fkey: time=4.451 calls=1000
Execution Time: 19.502 ms
```

## Annexe A4 — Plans complets

### A4-01 — Annexe 5 — Atelier 4 : SQL et plans complets

```text
INDEX PARTIEL — filtre correspondant

EXPLAIN (ANALYZE, BUFFERS)
SELECT id
FROM shopflow.commandes
WHERE statut = 'en_attente'
ORDER BY created_at, id
LIMIT 100;

Limit  (cost=0.29..3.44 rows=100 width=16) (actual time=0.167..0.200 rows=100.00 loops=1)
  Buffers: shared hit=1 read=2
  ->  Index Only Scan using idx_atelier4_attente on commandes  (cost=0.29..312.64 rows=9890 width=16) (actual time=0.166..0.180 rows=100.00 loops=1)
        Heap Fetches: 0
        Index Searches: 1
        Buffers: shared hit=1 read=2
Planning:
  Buffers: shared hit=42 read=8
Planning Time: 6.821 ms
Execution Time: 0.280 ms

```

### A4-02 — Annexe 5 — Atelier 4 : SQL et plans complets

```text
INDEX PARTIEL — filtre non correspondant

EXPLAIN (ANALYZE, BUFFERS)
SELECT id
FROM shopflow.commandes
WHERE statut = 'payee'
ORDER BY created_at, id
LIMIT 100;

Limit  (cost=5208.25..5219.64 rows=100 width=16) (actual time=42.066..46.405 rows=100.00 loops=1)
  Buffers: shared hit=1720
  ->  Gather Merge  (cost=5208.25..14327.83 rows=80017 width=16) (actual time=42.062..46.392 rows=100.00 loops=1)
        Workers Planned: 1
        Workers Launched: 1
        Buffers: shared hit=1720
        ->  Sort  (cost=4208.24..4325.91 rows=47069 width=16) (actual time=34.575..34.582 rows=73.00 loops=2)
              Sort Key: created_at, id
              Sort Method: top-N heapsort  Memory: 31kB
              Buffers: shared hit=1720
              Worker 0:  Sort Method: top-N heapsort  Memory: 31kB
              ->  Parallel Seq Scan on commandes  (cost=0.00..2409.29 rows=47069 width=16) (actual time=7.924..28.175 rows=40000.00 loops=2)
                    Filter: (statut = 'payee'::text)
                    Rows Removed by Filter: 10000
                    Buffers: shared hit=1674
Planning Time: 1.725 ms
Execution Time: 46.722 ms

```

### A4-03 — Annexe 5 — Atelier 4 : SQL et plans complets

```text
GIN — contenance JSONB compatible

EXPLAIN (ANALYZE, BUFFERS)
SELECT id, nom
FROM shopflow.produits
WHERE attributs @> '{"categorie":"livre"}'::jsonb;

Seq Scan on produits  (cost=0.00..5.50 rows=50 width=19) (actual time=0.048..0.105 rows=50.00 loops=1)
  Filter: (attributs @> '{"categorie": "livre"}'::jsonb)
  Rows Removed by Filter: 150
  Buffers: shared hit=3
Planning:
  Buffers: shared hit=36 read=3 dirtied=1
Planning Time: 3.155 ms
Execution Time: 0.199 ms

```

### A4-04 — Annexe 5 — Atelier 4 : SQL et plans complets

```text
GIN — extraction de propriété

EXPLAIN (ANALYZE, BUFFERS)
SELECT id, nom
FROM shopflow.produits
WHERE attributs ->> 'categorie' = 'livre';

Seq Scan on produits  (cost=0.00..6.00 rows=1 width=19) (actual time=0.070..0.114 rows=50.00 loops=1)
  Filter: ((attributs ->> 'categorie'::text) = 'livre'::text)
  Rows Removed by Filter: 150
  Buffers: shared hit=3
Planning Time: 0.343 ms
Execution Time: 0.207 ms

```

### A4-05 — Annexe 5 — Atelier 4 : SQL et plans complets

```text
GIST — chevauchement

EXPLAIN (ANALYZE, BUFFERS)
SELECT id, periode
FROM shopflow.atelier4_reservations
WHERE periode && tstzrange(
  '2026-10-10 14:00+02', '2026-10-10 16:00+02', '[)'
);

Seq Scan on atelier4_reservations  (cost=0.00..1.04 rows=1 width=40) (actual time=0.134..0.140 rows=2.00 loops=1)
  Filter: (periode && '["2026-10-10 12:00:00+00","2026-10-10 14:00:00+00")'::tstzrange)
  Rows Removed by Filter: 1
  Buffers: shared hit=1
Planning Time: 0.448 ms
Execution Time: 0.180 ms
```

## Annexe B — Références ordonnées de l’atelier 3

### Client 1

| Rang | id | created_at (UTC) | statut | total |
|---|---:|---|---|---:|
| 1 | 86001 | 2026-08-26 23:53:21+00 | annulee | 86.25 |
| 2 | 83001 | 2026-08-26 23:03:21+00 | annulee | 86.25 |
| 3 | 80001 | 2026-08-26 22:13:21+00 | annulee | 86.25 |
| 4 | 77001 | 2026-08-26 21:23:21+00 | annulee | 86.25 |
| 5 | 74001 | 2026-08-26 20:33:21+00 | annulee | 86.25 |
| 6 | 71001 | 2026-08-26 19:43:21+00 | annulee | 86.25 |
| 7 | 68001 | 2026-08-26 18:53:21+00 | annulee | 86.25 |
| 8 | 65001 | 2026-08-26 18:03:21+00 | annulee | 86.25 |
| 9 | 62001 | 2026-08-26 17:13:21+00 | annulee | 86.25 |
| 10 | 59001 | 2026-08-26 16:23:21+00 | annulee | 86.25 |
| 11 | 56001 | 2026-08-26 15:33:21+00 | annulee | 86.25 |
| 12 | 53001 | 2026-08-26 14:43:21+00 | annulee | 86.25 |
| 13 | 50001 | 2026-08-26 13:53:21+00 | annulee | 86.25 |
| 14 | 47001 | 2026-08-26 13:03:21+00 | annulee | 86.25 |
| 15 | 44001 | 2026-08-26 12:13:21+00 | annulee | 86.25 |
| 16 | 41001 | 2026-08-26 11:23:21+00 | annulee | 86.25 |
| 17 | 38001 | 2026-08-26 10:33:21+00 | annulee | 86.25 |
| 18 | 35001 | 2026-08-26 09:43:21+00 | annulee | 86.25 |
| 19 | 32001 | 2026-08-26 08:53:21+00 | annulee | 86.25 |
| 20 | 29001 | 2026-08-26 08:03:21+00 | annulee | 86.25 |

### Client 42

| Rang | id | created_at (UTC) | statut | total |
|---|---:|---|---|---:|
| 1 | 86042 | 2026-09-12 23:54:02+00 | payee | 720.00 |
| 2 | 83042 | 2026-09-12 23:04:02+00 | payee | 720.00 |
| 3 | 80042 | 2026-09-12 22:14:02+00 | payee | 720.00 |
| 4 | 77042 | 2026-09-12 21:24:02+00 | payee | 720.00 |
| 5 | 74042 | 2026-09-12 20:34:02+00 | payee | 720.00 |
| 6 | 71042 | 2026-09-12 19:44:02+00 | payee | 720.00 |
| 7 | 68042 | 2026-09-12 18:54:02+00 | payee | 720.00 |
| 8 | 65042 | 2026-09-12 18:04:02+00 | payee | 720.00 |
| 9 | 62042 | 2026-09-12 17:14:02+00 | payee | 720.00 |
| 10 | 59042 | 2026-09-12 16:24:02+00 | payee | 720.00 |
| 11 | 56042 | 2026-09-12 15:34:02+00 | payee | 720.00 |
| 12 | 53042 | 2026-09-12 14:44:02+00 | payee | 720.00 |
| 13 | 50042 | 2026-09-12 13:54:02+00 | payee | 720.00 |
| 14 | 47042 | 2026-09-12 13:04:02+00 | payee | 720.00 |
| 15 | 44042 | 2026-09-12 12:14:02+00 | payee | 720.00 |
| 16 | 41042 | 2026-09-12 11:24:02+00 | payee | 720.00 |
| 17 | 38042 | 2026-09-12 10:34:02+00 | payee | 720.00 |
| 18 | 35042 | 2026-09-12 09:44:02+00 | payee | 720.00 |
| 19 | 32042 | 2026-09-12 08:54:02+00 | payee | 720.00 |
| 20 | 29042 | 2026-09-12 08:04:02+00 | payee | 720.00 |

### Client 999

| Rang | id | created_at (UTC) | statut | total |
|---|---:|---|---|---:|
| 1 | 83999 | 2026-09-21 23:19:59+00 | payee | 386.25 |
| 2 | 80999 | 2026-09-21 22:29:59+00 | payee | 386.25 |
| 3 | 77999 | 2026-09-21 21:39:59+00 | payee | 386.25 |
| 4 | 74999 | 2026-09-21 20:49:59+00 | payee | 386.25 |
| 5 | 71999 | 2026-09-21 19:59:59+00 | payee | 386.25 |
| 6 | 68999 | 2026-09-21 19:09:59+00 | payee | 386.25 |
| 7 | 65999 | 2026-09-21 18:19:59+00 | payee | 386.25 |
| 8 | 62999 | 2026-09-21 17:29:59+00 | payee | 386.25 |
| 9 | 59999 | 2026-09-21 16:39:59+00 | payee | 386.25 |
| 10 | 56999 | 2026-09-21 15:49:59+00 | payee | 386.25 |
| 11 | 53999 | 2026-09-21 14:59:59+00 | payee | 386.25 |
| 12 | 50999 | 2026-09-21 14:09:59+00 | payee | 386.25 |
| 13 | 47999 | 2026-09-21 13:19:59+00 | payee | 386.25 |
| 14 | 44999 | 2026-09-21 12:29:59+00 | payee | 386.25 |
| 15 | 41999 | 2026-09-21 11:39:59+00 | payee | 386.25 |
| 16 | 38999 | 2026-09-21 10:49:59+00 | payee | 386.25 |
| 17 | 35999 | 2026-09-21 09:59:59+00 | payee | 386.25 |
| 18 | 32999 | 2026-09-21 09:09:59+00 | payee | 386.25 |
| 19 | 29999 | 2026-09-21 08:19:59+00 | payee | 386.25 |
| 20 | 26999 | 2026-09-21 07:29:59+00 | payee | 386.25 |

## Atelier 7 — API et mutualisation des connexions

### 1. Contrat et état initial

API ShopFlow sur port 3000, client autorisé **42**, **100 commandes**. `/observations` : HTTP 200, Redis prêt. Client fixé par le contexte pédagogique `LAB_CLIENT_ID`, pas par l’URL. Ordre : `created_at DESC, id DESC`. Limite par défaut 20, maximum 100. Réponse : `data`, `hasNextPage`, `nextCursor`. Identifiants et montants : chaînes JSON ; dates UTC à six chiffres de microsecondes. Curseur signé, lié au client.

### 2. Relations : tester N+1, appliquer le groupé, comparer

Méthode : appels `sf` avec mêmes pagination et limite ; comparaison des corps JSON complets et traces serveur par TraceId.

```bash
n1=$(sf n1_20 '/commandes?limit=20&pagination=curseur&relations=n1')
groupe=$(sf groupe_20 '/commandes?limit=20&pagination=curseur&relations=groupe')
sf_resume "$n1" "$groupe"
```

SQL de relations (projection : commande_id, produit_id, qte, prix_unitaire) :

```sql
-- N+1 : pour chacune des commandes de la page
SELECT commande_id::text AS commande_id, produit_id::text AS produit_id,
       qte, prix_unitaire::text AS prix_unitaire
FROM shopflow.lignes WHERE commande_id=$1 ORDER BY lignes.produit_id;
-- Groupé : une requête pour tous les identifiants de la page
SELECT commande_id::text AS commande_id, produit_id::text AS produit_id,
       qte, prix_unitaire::text AS prix_unitaire
FROM shopflow.lignes WHERE commande_id=ANY($1::bigint[])
ORDER BY lignes.commande_id,lignes.produit_id;
```

| Mode | SQL | HttpMs client | sqlMs serveur | durationMs serveur |
|---|---:|---:|---:|---:|
| N+1 | 21 | 143,018 | 76,884 | 81,344 |
| Groupé | 2 | 144,114 | 60,852 | 67,322 |

**Preuve de contenu : réponses identiques**, 20 commandes, 3 lignes chacune. Groupé : 19 appels SQL évités ; durée serveur inférieure de 14,022 ms, sans gain HTTP sur ces appels isolés. Charger les relations après la page empêche un LIMIT sur une jointure de couper les lignes d’une commande ou de réduire le nombre de commandes.

### 3. Pagination : tester OFFSET, comparer au curseur

Méthode : obtenir le curseur de la page 1, demander la page 2, puis comparer son corps JSON à OFFSET 20, avec relations groupées et jeu stable.

SQL de page émis par l’API :

```sql
-- OFFSET : paramètres client, limit+1, offset
SELECT id::text AS id,
 to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
 statut,total::text AS total
FROM shopflow.commandes WHERE client_id=$1
ORDER BY commandes.created_at DESC,commandes.id DESC LIMIT $2 OFFSET $3;
-- Curseur : paramètres client, limit+1, date, id
SELECT id::text AS id,
 to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
 statut,total::text AS total
FROM shopflow.commandes WHERE client_id=$1
AND (created_at,id)<($3::timestamptz,$4::bigint)
ORDER BY commandes.created_at DESC,commandes.id DESC LIMIT $2;
```

L’API lit 21 commandes pour déterminer hasNextPage, en renvoie 20, puis charge leurs relations. Page vide : une seule requête SQL.

| Page 2 | SQL | HttpMs | sqlMs | durationMs |
|---|---:|---:|---:|---:|
| OFFSET 20 | 2 | 92,359 | 25,770 | 28,667 |
| Curseur | 2 | 70,890 | 42,684 | 46,102 |

**Réponses identiques** : 20 commandes × 3 lignes, total page 12 720,00. Curseur plus court côté client, OFFSET plus court côté serveur : aucun gain uniforme démontré sur ces appels. Le test porte sur OFFSET 20 dans 100 commandes.

### 4. Exactitude : égalité de dates, parcours et accès

Méthode : exécuter `07_dates_identiques.sql` (sauvegarde des dates), demander deux pages de deux commandes, parcourir ensuite toutes les pages de vingt sans écriture, tester les refus et restaurer les dates.

| Contrôle | Résultat observé |
|---|---|
| Date commune de 2042, 1042, 42 | 2026-09-13 23:54:02 UTC |
| Page 1 (limit=2) | 2042, 1042 ; hasNextPage=true |
| Page 2 | 42, 86042 ; trois lignes par commande |
| Parcours complet | 5 pages, 100 identifiants, 100 uniques |
| Sans jeton | HTTP 401 |
| client_id=43 dans l’URL | HTTP 400 |
| Restauration | dates_restaurees=3, DELETE 3, COMMIT |

Le tuple `(created_at,id)` conserve 42 après 1042 malgré une date égale. Une comparaison de date seule perdrait 42. La signature protège le curseur contre l’altération, mais ne remplace pas le contrôle du client autorisé. Le curseur ne crée pas un instantané entre appels.

Dates restaurées : 42 → 2026-02-24 00:00:42 UTC ; 1042 → 2026-06-04 00:17:22 UTC ; 2042 → 2026-09-12 00:34:02 UTC.

### 5. PgBouncer : état direct, solution et méthode

Laboratoire séparé `pooling` : PostgreSQL/pgbench **17.11**, PgBouncer **1.18.0**, 1 000 produits accessibles par les deux chemins. PostgreSQL max_connections=60 ; pool_mode=transaction ; default_pool_size=5 ; max_client_conn=200 ; reserve_pool_size=0. Un couple base/utilisateur de charge.

```sql
-- charge.sql : même transaction pour direct et pool
\set produit random(1, 1000)
BEGIN;
SELECT prix FROM public.produits WHERE id = :produit;
SELECT pg_sleep(0.05);
COMMIT;
\sleep 100 ms
```

Direct : une session serveur par client connecté. Pool : réaffectation des cinq connexions après COMMIT, y compris pendant la pause cliente de 100 ms. pg.Pool est propre à chaque processus API ; PgBouncer peut être partagé entre instances. Dix processus ayant chacun un pool maximal de cinq peuvent demander jusqu’à cinquante connexions.

```bash
node pooling.mjs compare --clients 40 --seconds 20 --repeats 3
node pooling.mjs compare --clients 10 --seconds 20 --repeats 3 --connect
node pooling.mjs saturation --seconds 20
```

Comparaisons : trois essais alternés par chemin, chacun précédé d’un échauffement de 5 s avec 4 clients. Connexions échantillonnées environ chaque seconde. Latence pgbench : scénario et attentes inclus, pas latence HTTP. Option --connect : reconnexion cliente à chaque transaction.

#### 40 clients persistants

| Chemin | TPS 1 / 2 / 3 | Médiane TPS | Latences moyennes 1 / 2 / 3 ms | Médiane ms | Pic serveur échantillonné | Échecs |
|---|---|---:|---|---:|---:|---:|
| Direct | 256,494 / 255,366 / 257,705 | 256,494 | 155,461 / 155,877 / 154,729 | 155,461 | 40 | 0 |
| Pool | 94,695 / 94,552 / 94,615 | 94,615 | 418,449 / 419,232 / 418,915 | 418,915 | 5 | 0 |
#### 10 clients avec reconnexions

| Chemin | TPS 1 / 2 / 3 | Médiane TPS | Latences moyennes 1 / 2 / 3 ms | Médiane ms | Pic serveur échantillonné | Échecs |
|---|---|---:|---|---:|---:|---:|
| Direct | 48,414 / 47,999 / 48,933 | 48,414 | 172,510 / 173,885 / 173,841 | 173,841 | 10 | 0 |
| Pool | 50,487 / 49,869 / 53,835 | 50,487 | 175,122 / 176,305 / 168,138 | 175,122 | 5 | 0 |

**40 clients :** trace pooling/atelier avec cl_waiting=25, sv_active=5, sv_idle=0, maxwait_us=220128. Les sessions passent de 40 à 5 ; cinq transactions occupées 50 ms limitent le débit théorique à environ 100/s. L’attente explique l’augmentation de latence. **10 clients/reconnexions :** sessions 10 → 5, débit médian légèrement supérieur, sans baisse uniforme de latence.

#### Saturation : 80 clients

| Chemin | Preuve | Résultat |
|---|---|---|
| Direct | FATAL: remaining connection slots are reserved for roles with the SUPERUSER attribute ; client 68 refusé | Code 1, essai interrompu |
| Pool | 5 sessions ; 65 clients en attente, maxwait_us=688754 | Code 0 ; 1 917 transactions, zéro échec ; 93,828 TPS ; 835,628 ms |

L’échantillon direct à zéro est insuffisant pour décrire les sessions ouvertes avant le refus. Un essai interrompu ne fournit pas un débit comparable à une campagne complète.

### 6. Décision

Retenir le chargement groupé : contenu identique et 21 → 2 SQL. Le curseur date/id garantit le cas d’égalité testé. PgBouncer limite les sessions et évite le refus à 80 clients, au prix d’une file d’attente ; il ne corrige ni N+1 ni les index. Un dimensionnement plus grand pourrait réduire l’attente, à vérifier par cl_waiting, latence, TPS et ressources serveur. En mode transaction, l’état de session ne doit pas être supposé conservé entre transactions.

Arrêt confirmé avec `node pooling.mjs down` : conteneurs et réseau du labo supprimés, volume conservé. Dates ShopFlow restaurées. Les campagnes de 20 secondes décrivent ce scénario pédagogique.


### Annexes — Réponses, traces et campagnes complètes

#### api_traces.jsonl

```json
{"trace":"dd85795e-532d-4ed2-ad98-870186cf1632","route":"/observations","status":200,"sqlCount":0,"sqlMs":0,"durationMs":3.891,"poolWaiting":0}
{"trace":"64e6d66f-a8e3-46eb-9148-307a9760b1e0","route":"/observations","status":200,"sqlCount":0,"sqlMs":0,"durationMs":1.954,"poolWaiting":0}
{"trace":"898dcaab-ee60-44eb-bc2c-b0c78620b621","route":"/commandes?limit=20&pagination=curseur&relations=n1","status":200,"sqlCount":21,"sqlMs":76.884,"durationMs":81.344,"poolWaiting":0}
{"trace":"74ca8b34-459b-4054-bbc9-e173db5007ed","route":"/commandes?limit=20&pagination=curseur&relations=groupe","status":200,"sqlCount":2,"sqlMs":60.852,"durationMs":67.322,"poolWaiting":0}
{"trace":"04e5f5e3-cca0-422a-807c-a0dbde5666c6","route":"/commandes?limit=20&relations=groupe","status":200,"sqlCount":2,"sqlMs":25.445,"durationMs":29.856,"poolWaiting":0}
{"trace":"0af7d1e3-16e6-44f9-94f5-0073a9055097","route":"/commandes?limit=20&cursor=eyJ2IjoxLCJjbGllbnRJZCI6IjQyIiwiZGF0ZSI6IjIwMjYtMDktMTJUMDg6MDQ6MDIuMDAwMDAwWiIsImlkIjoiMjkwNDIifQ.-8akB0gWWnMKadehIh_owEhG5gkmQREIWKs9j8hbO0M&relations=groupe","status":200,"sqlCount":2,"sqlMs":42.684,"durationMs":46.102,"poolWaiting":0}
{"trace":"741c4d70-0716-47ab-8e2c-7e045323433a","route":"/commandes?limit=20&pagination=offset&offset=20&relations=groupe","status":200,"sqlCount":2,"sqlMs":25.77,"durationMs":28.667,"poolWaiting":0}

```

#### atelier07_api_reponses.jsonl

```json
{"Label":"n1_20","Status":200,"SqlCount":21,"Cache":"","HttpMs":143.018,"TraceId":"898dcaab-ee60-44eb-bc2c-b0c78620b621","Body":{"data":[{"id":"86042","created_at":"2026-09-12T23:54:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"86042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"86042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"86042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"83042","created_at":"2026-09-12T23:04:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"83042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"83042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"83042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"80042","created_at":"2026-09-12T22:14:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"80042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"80042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"80042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"77042","created_at":"2026-09-12T21:24:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"77042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"77042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"77042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"74042","created_at":"2026-09-12T20:34:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"74042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"74042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"74042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"71042","created_at":"2026-09-12T19:44:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"71042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"71042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"71042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"68042","created_at":"2026-09-12T18:54:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"68042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"68042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"68042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"65042","created_at":"2026-09-12T18:04:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"65042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"65042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"65042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"62042","created_at":"2026-09-12T17:14:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"62042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"62042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"62042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"59042","created_at":"2026-09-12T16:24:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"59042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"59042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"59042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"56042","created_at":"2026-09-12T15:34:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"56042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"56042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"56042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"53042","created_at":"2026-09-12T14:44:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"53042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"53042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"53042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"50042","created_at":"2026-09-12T13:54:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"50042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"50042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"50042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"47042","created_at":"2026-09-12T13:04:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"47042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"47042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"47042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"44042","created_at":"2026-09-12T12:14:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"44042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"44042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"44042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"41042","created_at":"2026-09-12T11:24:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"41042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"41042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"41042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"38042","created_at":"2026-09-12T10:34:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"38042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"38042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"38042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"35042","created_at":"2026-09-12T09:44:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"35042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"35042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"35042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"32042","created_at":"2026-09-12T08:54:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"32042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"32042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"32042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"29042","created_at":"2026-09-12T08:04:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"29042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"29042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"29042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]}],"hasNextPage":true,"nextCursor":"eyJ2IjoxLCJjbGllbnRJZCI6IjQyIiwiZGF0ZSI6IjIwMjYtMDktMTJUMDg6MDQ6MDIuMDAwMDAwWiIsImlkIjoiMjkwNDIifQ.-8akB0gWWnMKadehIh_owEhG5gkmQREIWKs9j8hbO0M"}}
{"Label":"groupe_20","Status":200,"SqlCount":2,"Cache":"","HttpMs":144.114,"TraceId":"74ca8b34-459b-4054-bbc9-e173db5007ed","Body":{"data":[{"id":"86042","created_at":"2026-09-12T23:54:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"86042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"86042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"86042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"83042","created_at":"2026-09-12T23:04:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"83042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"83042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"83042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"80042","created_at":"2026-09-12T22:14:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"80042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"80042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"80042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"77042","created_at":"2026-09-12T21:24:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"77042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"77042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"77042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"74042","created_at":"2026-09-12T20:34:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"74042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"74042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"74042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"71042","created_at":"2026-09-12T19:44:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"71042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"71042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"71042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"68042","created_at":"2026-09-12T18:54:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"68042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"68042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"68042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"65042","created_at":"2026-09-12T18:04:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"65042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"65042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"65042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"62042","created_at":"2026-09-12T17:14:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"62042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"62042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"62042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"59042","created_at":"2026-09-12T16:24:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"59042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"59042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"59042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"56042","created_at":"2026-09-12T15:34:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"56042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"56042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"56042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"53042","created_at":"2026-09-12T14:44:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"53042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"53042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"53042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"50042","created_at":"2026-09-12T13:54:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"50042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"50042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"50042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"47042","created_at":"2026-09-12T13:04:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"47042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"47042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"47042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"44042","created_at":"2026-09-12T12:14:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"44042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"44042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"44042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"41042","created_at":"2026-09-12T11:24:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"41042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"41042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"41042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"38042","created_at":"2026-09-12T10:34:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"38042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"38042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"38042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"35042","created_at":"2026-09-12T09:44:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"35042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"35042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"35042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"32042","created_at":"2026-09-12T08:54:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"32042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"32042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"32042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"29042","created_at":"2026-09-12T08:04:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"29042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"29042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"29042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]}],"hasNextPage":true,"nextCursor":"eyJ2IjoxLCJjbGllbnRJZCI6IjQyIiwiZGF0ZSI6IjIwMjYtMDktMTJUMDg6MDQ6MDIuMDAwMDAwWiIsImlkIjoiMjkwNDIifQ.-8akB0gWWnMKadehIh_owEhG5gkmQREIWKs9j8hbO0M"}}
{"Label":"curseur_p1","Status":200,"SqlCount":2,"Cache":"","HttpMs":99.194,"TraceId":"04e5f5e3-cca0-422a-807c-a0dbde5666c6","Body":{"data":[{"id":"86042","created_at":"2026-09-12T23:54:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"86042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"86042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"86042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"83042","created_at":"2026-09-12T23:04:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"83042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"83042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"83042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"80042","created_at":"2026-09-12T22:14:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"80042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"80042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"80042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"77042","created_at":"2026-09-12T21:24:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"77042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"77042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"77042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"74042","created_at":"2026-09-12T20:34:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"74042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"74042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"74042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"71042","created_at":"2026-09-12T19:44:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"71042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"71042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"71042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"68042","created_at":"2026-09-12T18:54:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"68042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"68042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"68042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"65042","created_at":"2026-09-12T18:04:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"65042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"65042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"65042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"62042","created_at":"2026-09-12T17:14:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"62042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"62042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"62042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"59042","created_at":"2026-09-12T16:24:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"59042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"59042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"59042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"56042","created_at":"2026-09-12T15:34:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"56042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"56042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"56042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"53042","created_at":"2026-09-12T14:44:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"53042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"53042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"53042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"50042","created_at":"2026-09-12T13:54:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"50042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"50042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"50042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"47042","created_at":"2026-09-12T13:04:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"47042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"47042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"47042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"44042","created_at":"2026-09-12T12:14:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"44042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"44042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"44042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"41042","created_at":"2026-09-12T11:24:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"41042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"41042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"41042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"38042","created_at":"2026-09-12T10:34:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"38042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"38042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"38042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"35042","created_at":"2026-09-12T09:44:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"35042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"35042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"35042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"32042","created_at":"2026-09-12T08:54:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"32042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"32042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"32042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"29042","created_at":"2026-09-12T08:04:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"29042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"29042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"29042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]}],"hasNextPage":true,"nextCursor":"eyJ2IjoxLCJjbGllbnRJZCI6IjQyIiwiZGF0ZSI6IjIwMjYtMDktMTJUMDg6MDQ6MDIuMDAwMDAwWiIsImlkIjoiMjkwNDIifQ.-8akB0gWWnMKadehIh_owEhG5gkmQREIWKs9j8hbO0M"}}
{"Label":"curseur_p2","Status":200,"SqlCount":2,"Cache":"","HttpMs":70.89,"TraceId":"0af7d1e3-16e6-44f9-94f5-0073a9055097","Body":{"data":[{"id":"26042","created_at":"2026-09-12T07:14:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"26042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"26042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"26042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"23042","created_at":"2026-09-12T06:24:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"23042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"23042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"23042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"20042","created_at":"2026-09-12T05:34:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"20042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"20042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"20042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"17042","created_at":"2026-09-12T04:44:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"17042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"17042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"17042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"14042","created_at":"2026-09-12T03:54:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"14042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"14042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"14042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"98042","created_at":"2026-09-12T03:14:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"98042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"98042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"98042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"11042","created_at":"2026-09-12T03:04:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"11042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"11042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"11042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"95042","created_at":"2026-09-12T02:24:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"95042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"95042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"95042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"8042","created_at":"2026-09-12T02:14:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"8042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"8042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"8042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"92042","created_at":"2026-09-12T01:34:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"92042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"92042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"92042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"5042","created_at":"2026-09-12T01:24:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"5042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"5042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"5042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"89042","created_at":"2026-09-12T00:44:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"89042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"89042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"89042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"2042","created_at":"2026-09-12T00:34:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"2042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"2042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"2042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"85042","created_at":"2026-06-04T23:37:22.000000Z","statut":"payee","total":"480.00","lignes":[{"commande_id":"85042","produit_id":"43","qte":2,"prix_unitaire":"58.75"},{"commande_id":"85042","produit_id":"60","qte":2,"prix_unitaire":"80.00"},{"commande_id":"85042","produit_id":"77","qte":2,"prix_unitaire":"101.25"}]},{"id":"82042","created_at":"2026-06-04T22:47:22.000000Z","statut":"payee","total":"480.00","lignes":[{"commande_id":"82042","produit_id":"43","qte":2,"prix_unitaire":"58.75"},{"commande_id":"82042","produit_id":"60","qte":2,"prix_unitaire":"80.00"},{"commande_id":"82042","produit_id":"77","qte":2,"prix_unitaire":"101.25"}]},{"id":"79042","created_at":"2026-06-04T21:57:22.000000Z","statut":"payee","total":"480.00","lignes":[{"commande_id":"79042","produit_id":"43","qte":2,"prix_unitaire":"58.75"},{"commande_id":"79042","produit_id":"60","qte":2,"prix_unitaire":"80.00"},{"commande_id":"79042","produit_id":"77","qte":2,"prix_unitaire":"101.25"}]},{"id":"76042","created_at":"2026-06-04T21:07:22.000000Z","statut":"payee","total":"480.00","lignes":[{"commande_id":"76042","produit_id":"43","qte":2,"prix_unitaire":"58.75"},{"commande_id":"76042","produit_id":"60","qte":2,"prix_unitaire":"80.00"},{"commande_id":"76042","produit_id":"77","qte":2,"prix_unitaire":"101.25"}]},{"id":"73042","created_at":"2026-06-04T20:17:22.000000Z","statut":"payee","total":"480.00","lignes":[{"commande_id":"73042","produit_id":"43","qte":2,"prix_unitaire":"58.75"},{"commande_id":"73042","produit_id":"60","qte":2,"prix_unitaire":"80.00"},{"commande_id":"73042","produit_id":"77","qte":2,"prix_unitaire":"101.25"}]},{"id":"70042","created_at":"2026-06-04T19:27:22.000000Z","statut":"payee","total":"480.00","lignes":[{"commande_id":"70042","produit_id":"43","qte":2,"prix_unitaire":"58.75"},{"commande_id":"70042","produit_id":"60","qte":2,"prix_unitaire":"80.00"},{"commande_id":"70042","produit_id":"77","qte":2,"prix_unitaire":"101.25"}]},{"id":"67042","created_at":"2026-06-04T18:37:22.000000Z","statut":"payee","total":"480.00","lignes":[{"commande_id":"67042","produit_id":"43","qte":2,"prix_unitaire":"58.75"},{"commande_id":"67042","produit_id":"60","qte":2,"prix_unitaire":"80.00"},{"commande_id":"67042","produit_id":"77","qte":2,"prix_unitaire":"101.25"}]}],"hasNextPage":true,"nextCursor":"eyJ2IjoxLCJjbGllbnRJZCI6IjQyIiwiZGF0ZSI6IjIwMjYtMDYtMDRUMTg6Mzc6MjIuMDAwMDAwWiIsImlkIjoiNjcwNDIifQ.jriOXv7bL-PqYoYq33QjVz-ZV6ptspT23ENzyRVo_c8"}}
{"Label":"offset_p2","Status":200,"SqlCount":2,"Cache":"","HttpMs":92.359,"TraceId":"741c4d70-0716-47ab-8e2c-7e045323433a","Body":{"data":[{"id":"26042","created_at":"2026-09-12T07:14:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"26042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"26042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"26042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"23042","created_at":"2026-09-12T06:24:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"23042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"23042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"23042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"20042","created_at":"2026-09-12T05:34:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"20042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"20042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"20042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"17042","created_at":"2026-09-12T04:44:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"17042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"17042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"17042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"14042","created_at":"2026-09-12T03:54:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"14042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"14042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"14042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"98042","created_at":"2026-09-12T03:14:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"98042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"98042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"98042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"11042","created_at":"2026-09-12T03:04:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"11042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"11042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"11042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"95042","created_at":"2026-09-12T02:24:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"95042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"95042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"95042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"8042","created_at":"2026-09-12T02:14:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"8042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"8042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"8042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"92042","created_at":"2026-09-12T01:34:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"92042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"92042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"92042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"5042","created_at":"2026-09-12T01:24:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"5042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"5042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"5042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"89042","created_at":"2026-09-12T00:44:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"89042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"89042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"89042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"2042","created_at":"2026-09-12T00:34:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"2042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"2042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"2042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"85042","created_at":"2026-06-04T23:37:22.000000Z","statut":"payee","total":"480.00","lignes":[{"commande_id":"85042","produit_id":"43","qte":2,"prix_unitaire":"58.75"},{"commande_id":"85042","produit_id":"60","qte":2,"prix_unitaire":"80.00"},{"commande_id":"85042","produit_id":"77","qte":2,"prix_unitaire":"101.25"}]},{"id":"82042","created_at":"2026-06-04T22:47:22.000000Z","statut":"payee","total":"480.00","lignes":[{"commande_id":"82042","produit_id":"43","qte":2,"prix_unitaire":"58.75"},{"commande_id":"82042","produit_id":"60","qte":2,"prix_unitaire":"80.00"},{"commande_id":"82042","produit_id":"77","qte":2,"prix_unitaire":"101.25"}]},{"id":"79042","created_at":"2026-06-04T21:57:22.000000Z","statut":"payee","total":"480.00","lignes":[{"commande_id":"79042","produit_id":"43","qte":2,"prix_unitaire":"58.75"},{"commande_id":"79042","produit_id":"60","qte":2,"prix_unitaire":"80.00"},{"commande_id":"79042","produit_id":"77","qte":2,"prix_unitaire":"101.25"}]},{"id":"76042","created_at":"2026-06-04T21:07:22.000000Z","statut":"payee","total":"480.00","lignes":[{"commande_id":"76042","produit_id":"43","qte":2,"prix_unitaire":"58.75"},{"commande_id":"76042","produit_id":"60","qte":2,"prix_unitaire":"80.00"},{"commande_id":"76042","produit_id":"77","qte":2,"prix_unitaire":"101.25"}]},{"id":"73042","created_at":"2026-06-04T20:17:22.000000Z","statut":"payee","total":"480.00","lignes":[{"commande_id":"73042","produit_id":"43","qte":2,"prix_unitaire":"58.75"},{"commande_id":"73042","produit_id":"60","qte":2,"prix_unitaire":"80.00"},{"commande_id":"73042","produit_id":"77","qte":2,"prix_unitaire":"101.25"}]},{"id":"70042","created_at":"2026-06-04T19:27:22.000000Z","statut":"payee","total":"480.00","lignes":[{"commande_id":"70042","produit_id":"43","qte":2,"prix_unitaire":"58.75"},{"commande_id":"70042","produit_id":"60","qte":2,"prix_unitaire":"80.00"},{"commande_id":"70042","produit_id":"77","qte":2,"prix_unitaire":"101.25"}]},{"id":"67042","created_at":"2026-06-04T18:37:22.000000Z","statut":"payee","total":"480.00","lignes":[{"commande_id":"67042","produit_id":"43","qte":2,"prix_unitaire":"58.75"},{"commande_id":"67042","produit_id":"60","qte":2,"prix_unitaire":"80.00"},{"commande_id":"67042","produit_id":"77","qte":2,"prix_unitaire":"101.25"}]}],"hasNextPage":true,"nextCursor":"eyJ2IjoxLCJjbGllbnRJZCI6IjQyIiwiZGF0ZSI6IjIwMjYtMDYtMDRUMTg6Mzc6MjIuMDAwMDAwWiIsImlkIjoiNjcwNDIifQ.jriOXv7bL-PqYoYq33QjVz-ZV6ptspT23ENzyRVo_c8"}}

```

#### atelier07_dates_pages.jsonl

```json
{"Label":"dates_p1","Status":200,"SqlCount":2,"Cache":"","HttpMs":107.638,"TraceId":"3903570f-e728-4db8-b9f9-759716a90872","Body":{"data":[{"id":"2042","created_at":"2026-09-13T23:54:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"2042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"2042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"2042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"1042","created_at":"2026-09-13T23:54:02.000000Z","statut":"payee","total":"480.00","lignes":[{"commande_id":"1042","produit_id":"43","qte":2,"prix_unitaire":"58.75"},{"commande_id":"1042","produit_id":"60","qte":2,"prix_unitaire":"80.00"},{"commande_id":"1042","produit_id":"77","qte":2,"prix_unitaire":"101.25"}]}],"hasNextPage":true,"nextCursor":"eyJ2IjoxLCJjbGllbnRJZCI6IjQyIiwiZGF0ZSI6IjIwMjYtMDktMTNUMjM6NTQ6MDIuMDAwMDAwWiIsImlkIjoiMTA0MiJ9.mZMzRKkTUumXjBzdZaAnxFBTeVdJSN7egwtYDCl1Ork"}}
{"Label":"dates_p2","Status":200,"SqlCount":2,"Cache":"","HttpMs":38.771,"TraceId":"ec61477c-57aa-4e6a-bf4b-5a5a62bcae44","Body":{"data":[{"id":"42","created_at":"2026-09-13T23:54:02.000000Z","statut":"payee","total":"240.00","lignes":[{"commande_id":"42","produit_id":"43","qte":1,"prix_unitaire":"58.75"},{"commande_id":"42","produit_id":"60","qte":1,"prix_unitaire":"80.00"},{"commande_id":"42","produit_id":"77","qte":1,"prix_unitaire":"101.25"}]},{"id":"86042","created_at":"2026-09-12T23:54:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"86042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"86042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"86042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]}],"hasNextPage":true,"nextCursor":"eyJ2IjoxLCJjbGllbnRJZCI6IjQyIiwiZGF0ZSI6IjIwMjYtMDktMTJUMjM6NTQ6MDIuMDAwMDAwWiIsImlkIjoiODYwNDIifQ.oyiz7nwDInJ1sB2RYNVyL7hSbKy5RGemicnC3kYU2i4"}}

```

#### atelier07_parcours.txt

```text
Pages=5 Total=100 Uniques=     100

```

#### mesures_linux_20261007T120021290Z_2a5fd8.csv

```csv
"Date","Label","Method","Path","Status","SqlCount","Cache","HttpMs","TraceId","Prix","Ids"
"2026-10-07T12:00:21.849Z","demarrage","GET","/observations","200","0","","48.126","dd85795e-532d-4ed2-ad98-870186cf1632","",""
"2026-10-07T12:02:14.048Z","verification","GET","/observations","200","0","","59.046","64e6d66f-a8e3-46eb-9148-307a9760b1e0","",""
"2026-10-07T12:05:21.792Z","n1_20","GET","/commandes?limit=20&pagination=curseur&relations=n1","200","21","","143.018","898dcaab-ee60-44eb-bc2c-b0c78620b621","","86042,83042,80042,77042,74042,71042,68042,65042,62042,59042,56042,53042,50042,47042,44042,41042,38042,35042,32042,29042"
"2026-10-07T12:28:28.448Z","groupe_20","GET","/commandes?limit=20&pagination=curseur&relations=groupe","200","2","","144.114","74ca8b34-459b-4054-bbc9-e173db5007ed","","86042,83042,80042,77042,74042,71042,68042,65042,62042,59042,56042,53042,50042,47042,44042,41042,38042,35042,32042,29042"
"2026-10-07T12:34:11.453Z","curseur_p1","GET","/commandes?limit=20&relations=groupe","200","2","","99.194","04e5f5e3-cca0-422a-807c-a0dbde5666c6","","86042,83042,80042,77042,74042,71042,68042,65042,62042,59042,56042,53042,50042,47042,44042,41042,38042,35042,32042,29042"
"2026-10-07T12:34:28.043Z","curseur_p2","GET","/commandes?limit=20&cursor=eyJ2IjoxLCJjbGllbnRJZCI6IjQyIiwiZGF0ZSI6IjIwMjYtMDktMTJUMDg6MDQ6MDIuMDAwMDAwWiIsImlkIjoiMjkwNDIifQ.-8akB0gWWnMKadehIh_owEhG5gkmQREIWKs9j8hbO0M&relations=groupe","200","2","","70.89","0af7d1e3-16e6-44f9-94f5-0073a9055097","","26042,23042,20042,17042,14042,98042,11042,95042,8042,92042,5042,89042,2042,85042,82042,79042,76042,73042,70042,67042"
"2026-10-07T12:36:08.175Z","offset_p2","GET","/commandes?limit=20&pagination=offset&offset=20&relations=groupe","200","2","","92.359","741c4d70-0716-47ab-8e2c-7e045323433a","","26042,23042,20042,17042,14042,98042,11042,95042,8042,92042,5042,89042,2042,85042,82042,79042,76042,73042,70042,67042"
"2026-10-07T13:07:10.933Z","dates_p1","GET","/commandes?limit=2","200","2","","107.638","3903570f-e728-4db8-b9f9-759716a90872","","2042,1042"
"2026-10-07T13:07:20.407Z","dates_p2","GET","/commandes?limit=2&cursor=eyJ2IjoxLCJjbGllbnRJZCI6IjQyIiwiZGF0ZSI6IjIwMjYtMDktMTNUMjM6NTQ6MDIuMDAwMDAwWiIsImlkIjoiMTA0MiJ9.mZMzRKkTUumXjBzdZaAnxFBTeVdJSN7egwtYDCl1Ork","200","2","","38.771","ec61477c-57aa-4e6a-bf4b-5a5a62bcae44","","42,86042"
"2026-10-07T13:10:58.599Z","parcours_0","GET","/commandes?limit=20&relations=groupe","200","2","","102.515","4f494ed3-c309-42f5-8e01-0a178b69fe8b","","2042,1042,42,86042,83042,80042,77042,74042,71042,68042,65042,62042,59042,56042,53042,50042,47042,44042,41042,38042"
"2026-10-07T13:10:59.128Z","parcours_1","GET","/commandes?limit=20&relations=groupe&cursor=eyJ2IjoxLCJjbGllbnRJZCI6IjQyIiwiZGF0ZSI6IjIwMjYtMDktMTJUMTA6MzQ6MDIuMDAwMDAwWiIsImlkIjoiMzgwNDIifQ.20bu_Cc6NPtihjc4Y4sCKUgUOOctt6S8wA6BVcwde2Y","200","2","","36.839","5789d8c5-54ee-4219-b326-068896037293","","35042,32042,29042,26042,23042,20042,17042,14042,98042,11042,95042,8042,92042,5042,89042,85042,82042,79042,76042,73042"
"2026-10-07T13:10:59.635Z","parcours_2","GET","/commandes?limit=20&relations=groupe&cursor=eyJ2IjoxLCJjbGllbnRJZCI6IjQyIiwiZGF0ZSI6IjIwMjYtMDYtMDRUMjA6MTc6MjIuMDAwMDAwWiIsImlkIjoiNzMwNDIifQ.sP9hy82tbvHy4OyrHCpSJcgynEB9Mz9VjB4GXwYdvSQ","200","2","","50.023","3e3ea759-1fc8-489b-9fce-225939100cbb","","70042,67042,64042,61042,58042,55042,52042,49042,46042,43042,40042,37042,34042,31042,28042,25042,22042,19042,16042,13042"
"2026-10-07T13:11:00.258Z","parcours_3","GET","/commandes?limit=20&relations=groupe&cursor=eyJ2IjoxLCJjbGllbnRJZCI6IjQyIiwiZGF0ZSI6IjIwMjYtMDYtMDRUMDM6Mzc6MjIuMDAwMDAwWiIsImlkIjoiMTMwNDIifQ.QsPMkIieFNAaUhZ7-JHNz0Mt-X2oJm9QsSbDlKsJJeE","200","2","","52.333","da7a6519-965f-4d47-97b8-d50d6de7a8c2","","97042,10042,94042,7042,91042,4042,88042,84042,81042,78042,75042,72042,69042,66042,63042,60042,57042,54042,51042,48042"
"2026-10-07T13:11:00.796Z","parcours_4","GET","/commandes?limit=20&relations=groupe&cursor=eyJ2IjoxLCJjbGllbnRJZCI6IjQyIiwiZGF0ZSI6IjIwMjYtMDItMjRUMTM6MjA6NDIuMDAwMDAwWiIsImlkIjoiNDgwNDIifQ.SLmtInoYlOSuhimiR1F5lvuAyORI9B0W-E6pCa3qnUQ","200","2","","50.413","df66a877-e905-4ab6-a30d-8dd48fb011fc","","45042,42042,39042,36042,33042,30042,27042,24042,21042,18042,15042,99042,12042,96042,9042,93042,6042,90042,3042,87042"
"2026-10-07T13:12:21.813Z","controle_droits","GET","/commandes","401","0","","68.202","dc9fdd36-5a72-484b-bcb3-75dc45152dc3","",""
"2026-10-07T13:12:26.812Z","controle_droits","GET","/commandes?client_id=43","400","0","","22.742","fabba420-8124-412a-bc73-493ef9114816","",""

```

#### pgbouncer_demarrage_controle.txt

```text
1/psql.1.gz to provide /usr/share/man/man1/psql.1.gz (psql.1.gz) in auto mode
#11 23.21 Setting up postgresql-common (248+deb12u1) ...
#11 23.25 debconf: unable to initialize frontend: Dialog
#11 23.25 debconf: (TERM is not set, so the dialog frontend is not usable.)
#11 23.25 debconf: falling back to frontend: Readline
#11 23.25 debconf: unable to initialize frontend: Readline
#11 23.25 debconf: (This frontend requires a controlling tty.)
#11 23.25 debconf: falling back to frontend: Teletype
#11 23.35 
#11 23.35 Creating config file /etc/postgresql-common/createcluster.conf with new version
#11 23.39 Building PostgreSQL dictionaries from installed myspell/hunspell packages...
#11 23.39 Removing obsolete dictionary files:
#11 23.40 invoke-rc.d: could not determine current runlevel
#11 23.40 invoke-rc.d: policy-rc.d denied execution of start.
#11 23.50 Setting up postgresql-client (15+248+deb12u1) ...
#11 23.50 Setting up pgbouncer (1.18.0-1+deb12u1) ...
#11 23.52 invoke-rc.d: could not determine current runlevel
#11 23.52 invoke-rc.d: policy-rc.d denied execution of start.
#11 23.58 Processing triggers for libc-bin (2.36-9+deb12u14) ...
#11 23.58 Processing triggers for ca-certificates (20250419~deb12u1) ...
#11 23.59 Updating certificates in /etc/ssl/certs...
#11 23.77 0 added, 0 removed; done.
#11 23.77 Running hooks in /etc/ca-certificates/update.d...
#11 23.77 done.
#11 DONE 24.0s

#10 [bench 1/4] FROM docker.io/library/postgres:17-bookworm@sha256:3645570cccdfa447589da9f57dd740faa29b30938e861289a5574b6ca6b03826
#10 sha256:4748d3f27fc2c572d39c935baa07dd3a52f733da0aa643455951416fc3dcb70e 87.03MB / 113.41MB 45.3s
#10 ...

#12 [pgbouncer 3/4] COPY pgbouncer.ini userlist.txt /etc/pgbouncer/
#12 DONE 0.1s

#10 [bench 1/4] FROM docker.io/library/postgres:17-bookworm@sha256:3645570cccdfa447589da9f57dd740faa29b30938e861289a5574b6ca6b03826
#10 ...

#13 [pgbouncer 4/4] RUN chown postgres:postgres /etc/pgbouncer/pgbouncer.ini /etc/pgbouncer/userlist.txt && chmod 640 /etc/pgbouncer/pgbouncer.ini /etc/pgbouncer/userlist.txt
#13 DONE 0.1s

#10 [bench 1/4] FROM docker.io/library/postgres:17-bookworm@sha256:3645570cccdfa447589da9f57dd740faa29b30938e861289a5574b6ca6b03826
#10 sha256:4748d3f27fc2c572d39c935baa07dd3a52f733da0aa643455951416fc3dcb70e 93.32MB / 113.41MB 46.9s
#10 ...

#14 [pgbouncer] exporting to image
#14 exporting layers 1.9s done
#14 exporting manifest sha256:8ee164d93e246c11faa9072d172dfd3ea094d7d7fca15a6b13cb1182da86216f done
#14 exporting config sha256:eb1d473a940ac39193e01bf79c8fb6297aedaa26d82872a04d7d9055b51823a8 done
#14 exporting attestation manifest sha256:a3506782df462cd654189419b6d572daca7f4bdc7b00146519c78b6c72d23e34 done
#14 exporting manifest list sha256:2fbf1d79f5c65564a30c25f9182e00f138824c0dc035082d020d0f58990ae500 done
#14 naming to docker.io/library/shopflow-j4-pooling-pgbouncer:latest done
#14 unpacking to docker.io/library/shopflow-j4-pooling-pgbouncer:latest 0.6s done
#14 DONE 2.5s

#10 [bench 1/4] FROM docker.io/library/postgres:17-bookworm@sha256:3645570cccdfa447589da9f57dd740faa29b30938e861289a5574b6ca6b03826
#10 ...

#15 [pgbouncer] resolving provenance for metadata file
#15 DONE 0.0s

#10 [bench 1/4] FROM docker.io/library/postgres:17-bookworm@sha256:3645570cccdfa447589da9f57dd740faa29b30938e861289a5574b6ca6b03826
#10 sha256:4748d3f27fc2c572d39c935baa07dd3a52f733da0aa643455951416fc3dcb70e 99.61MB / 113.41MB 48.6s
#10 sha256:4748d3f27fc2c572d39c935baa07dd3a52f733da0aa643455951416fc3dcb70e 105.91MB / 113.41MB 51.0s
#10 sha256:4748d3f27fc2c572d39c935baa07dd3a52f733da0aa643455951416fc3dcb70e 112.20MB / 113.41MB 52.9s
#10 sha256:4748d3f27fc2c572d39c935baa07dd3a52f733da0aa643455951416fc3dcb70e 113.41MB / 113.41MB 53.3s done
#10 extracting sha256:4748d3f27fc2c572d39c935baa07dd3a52f733da0aa643455951416fc3dcb70e
#10 extracting sha256:4748d3f27fc2c572d39c935baa07dd3a52f733da0aa643455951416fc3dcb70e 1.8s done
#10 extracting sha256:4748d3f27fc2c572d39c935baa07dd3a52f733da0aa643455951416fc3dcb70e 1.8s done
#10 extracting sha256:1e59678344bfcedf6c6f3f74952b7dc29d0f1f6ca41c4985b962acacb7990360 0.0s done
#10 extracting sha256:33cdf0532a6a5d4bad1fcfe5fba9e036beba75598855958558056b5eb18abf92 done
#10 extracting sha256:9be6a8c44616f92e608b8cc594476f2db73f2959bc951615d7ef4925c8487dbf done
#10 extracting sha256:3211c9ff14a37a40933603dd306fb6cb67f71aebaf05ea9f16de3fa6e098fe15 done
#10 extracting sha256:1bee21526d9de64a234685e8ab5d9c2a20815092a98f33c64d38321a0aecfd07 done
#10 DONE 55.4s

#16 [db 2/4] COPY init.sql /docker-entrypoint-initdb.d/01_pooling.sql
#16 DONE 0.2s

#17 [bench 3/4] COPY charge.sql /lab/charge.sql
#17 DONE 0.0s

#18 [db 4/4] RUN chmod 755 /docker-entrypoint-initdb.d /lab && chmod 644 /docker-entrypoint-initdb.d/01_pooling.sql /lab/charge.sql
#18 DONE 0.2s

#19 [db] exporting to image
#19 exporting layers 0.1s done
#19 exporting manifest sha256:03dd4a454e728de57e6b6d3dbd217825deb2bfc89781c5ed5272471d858528e8 done
#19 exporting config sha256:d2246c1b56ce2abde35c715ab67aa429cda9490367dfce0d2186c291f86e4958 done
#19 exporting attestation manifest sha256:1431e32e7b37a3bfe9df9e00134a2efa6bd32f577233b75cf82b97704bb95811 done
#19 exporting manifest list sha256:32760fd2c2a74820b0ca8737416bd9902e57fa70c57f2c35f0791fc3eb271935 done
#19 naming to docker.io/library/shopflow-j4-pooling-db:latest
#19 naming to docker.io/library/shopflow-j4-pooling-db:latest done
#19 unpacking to docker.io/library/shopflow-j4-pooling-db:latest 0.0s done
#19 DONE 0.2s

#20 [bench] exporting to image
#20 exporting layers 0.1s done
#20 exporting manifest sha256:a2013dfd7fab380f69152205d3baa39193c86555c2359aa46ac0bdb6dc778068 0.0s done
#20 exporting config sha256:5d0d0472858160d4781ef09c87805660659f383e18103fabd5090d8423073e8e done
#20 exporting attestation manifest sha256:ba9e7de8a1dc74bd63d9e89e38f38ae0fe864228f27ddae4c6cdecf885c7cb98 done
#20 exporting manifest list sha256:39ffd5e5d5f443275d61ca0c118fcf43f094d3300141c7a59046d811524fbaf2 done
#20 naming to docker.io/library/shopflow-j4-pooling-bench:latest done
#20 unpacking to docker.io/library/shopflow-j4-pooling-bench:latest 0.0s done
#20 DONE 0.2s

#21 [bench] resolving provenance for metadata file
#21 DONE 0.1s

#22 [db] resolving provenance for metadata file
#22 DONE 0.0s
 Image shopflow-j4-pooling-db Built 
 Image shopflow-j4-pooling-bench Built 
 Image shopflow-j4-pooling-pgbouncer Built 
 Network shopflow-j4-pooling_default Creating 
 Volume shopflow-j4-pooling_pooling_data Creating 
 Volume shopflow-j4-pooling_pooling_data Creating 
 Network shopflow-j4-pooling_default Creating 
 Volume shopflow-j4-pooling_pooling_data Created 
 Volume shopflow-j4-pooling_pooling_data Created 
 Network shopflow-j4-pooling_default Created 
 Network shopflow-j4-pooling_default Created 
 Container shopflow-j4-pooling-db-1 Creating 
 Container shopflow-j4-pooling-db-1 Created 
 Container shopflow-j4-pooling-pgbouncer-1 Creating 
 Container shopflow-j4-pooling-bench-1 Creating 
 Container shopflow-j4-pooling-pgbouncer-1 Created 
 Container shopflow-j4-pooling-bench-1 Created 
 Container shopflow-j4-pooling-db-1 Starting 
 Container shopflow-j4-pooling-db-1 Started 
 Container shopflow-j4-pooling-db-1 Waiting 
 Container shopflow-j4-pooling-db-1 Waiting 
 Container shopflow-j4-pooling-db-1 Healthy 
 Container shopflow-j4-pooling-bench-1 Starting 
 Container shopflow-j4-pooling-db-1 Healthy 
 Container shopflow-j4-pooling-pgbouncer-1 Starting 
 Container shopflow-j4-pooling-bench-1 Started 
 Container shopflow-j4-pooling-pgbouncer-1 Started 
 Container shopflow-j4-pooling-db-1 Waiting 
 Container shopflow-j4-pooling-pgbouncer-1 Waiting 
 Container shopflow-j4-pooling-bench-1 Waiting 
 Container shopflow-j4-pooling-db-1 Healthy 
 Container shopflow-j4-pooling-bench-1 Healthy 
 Container shopflow-j4-pooling-pgbouncer-1 Healthy 
PostgreSQL 17.11 (Debian 17.11-1.pgdg12+2) on aarch64-unknown-linux-gnu, compiled by gcc (Debian 12.2.0-14+deb12u1) 12.2.0, 64-bit
60
1000

PgBouncer 1.18.0
libevent 2.1.12-stable
adns: c-ares 1.18.1
tls: OpenSSL 3.0.22 25 Aug 2026
systemd: yes

pgbench (PostgreSQL) 17.11 (Debian 17.11-1.pgdg12+2)

db:5432 : 1000 produits accessibles avec le rôle atelier.
pgbouncer:6432 : 1000 produits accessibles avec le rôle atelier.
            key            |                                                             value                                                              |                                                            default                                                             | changeable 
---------------------------+--------------------------------------------------------------------------------------------------------------------------------+--------------------------------------------------------------------------------------------------------------------------------+------------
 admin_users               | observateur                                                                                                                    |                                                                                                                                | yes
 application_name_add_host | 0                                                                                                                              | 0                                                                                                                              | yes
 auth_file                 | /etc/pgbouncer/userlist.txt                                                                                                    |                                                                                                                                | yes
 auth_hba_file             |                                                                                                                                |                                                                                                                                | yes
 auth_query                | SELECT rolname, CASE WHEN rolvaliduntil < now() THEN NULL ELSE rolpassword END FROM pg_authid WHERE rolname=$1 AND rolcanlogin | SELECT rolname, CASE WHEN rolvaliduntil < now() THEN NULL ELSE rolpassword END FROM pg_authid WHERE rolname=$1 AND rolcanlogin | yes
 auth_type                 | scram-sha-256                                                                                                                  | md5                                                                                                                            | yes
 auth_user                 |                                                                                                                                |                                                                                                                                | yes
 autodb_idle_timeout       | 3600                                                                                                                           | 3600                                                                                                                           | yes
 client_idle_timeout       | 0                                                                                                                              | 0                                                                                                                              | yes
 client_login_timeout      | 60                                                                                                                             | 60                                                                                                                             | yes
 client_tls_ca_file        |                                                                                                                                |                                                                                                                                | yes
 client_tls_cert_file      |                                                                                                                                |                                                                                                                                | yes
 client_tls_ciphers        | fast                                                                                                                           | fast                                                                                                                           | yes
 client_tls_dheparams      | auto                                                                                                                           | auto                                                                                                                           | yes
 client_tls_ecdhcurve      | auto                                                                                                                           | auto                                                                                                                           | yes
 client_tls_key_file       |                                                                                                                                |                                                                                                                                | yes
 client_tls_protocols      | secure                                                                                                                         | secure                                                                                                                         | yes
 client_tls_sslmode        | disable                                                                                                                        | disable                                                                                                                        | yes
 conffile                  | /etc/pgbouncer/pgbouncer.ini                                                                                                   |                                                                                                                                | yes
 default_pool_size         | 5                                                                                                                              | 20                                                                                                                             | yes
 disable_pqexec            | 0                                                                                                                              | 0                                                                                                                              | no
 dns_max_ttl               | 15                                                                                                                             | 15                                                                                                                             | yes
 dns_nxdomain_ttl          | 15                                                                                                                             | 15                                                                                                                             | yes
 dns_zone_check_period     | 0                                                                                                                              | 0                                                                                                                              | yes
 idle_transaction_timeout  | 0                                                                                                                              | 0                                                                                                                              | yes
 ignore_startup_parameters |                                                                                                                                |                                                                                                                                | yes
 job_name                  | pgbouncer                                                                                                                      | pgbouncer                                                                                                                      | no
 listen_addr               | 0.0.0.0                                                                                                                        |                                                                                                                                | no
 listen_backlog            | 128                                                                                                                            | 128                                                                                                                            | no
 listen_port               | 6432                                                                                                                           | 6432                                                                                                                           | no
 log_connections           | 0                                                                                                                              | 1                                                                                                                              | yes
 log_disconnections        | 0                                                                                                                              | 1                                                                                                                              | yes
 log_pooler_errors         | 1                                                                                                                              | 1                                                                                                                              | yes
 log_stats                 | 1                                                                                                                              | 1                                                                                                                              | yes
 logfile                   |                                                                                                                                |                                                                                                                                | yes
 max_client_conn           | 200                                                                                                                            | 100                                                                                                                            | yes
 max_db_connections        | 0                                                                                                                              | 0                                                                                                                              | yes
 max_packet_size           | 2147483647                                                                                                                     | 2147483647                                                                                                                     | yes
 max_user_connections      | 0                                                                                                                              | 0                                                                                                                              | yes
 min_pool_size             | 0                                                                                                                              | 0                                                                                                                              | yes
 pidfile                   |                                                                                                                                |                                                                                                                                | no
 pkt_buf                   | 4096                                                                                                                           | 4096                                                                                                                           | no
 pool_mode                 | transaction                                                                                                                    | session                                                                                                                        | yes
 query_timeout             | 0                                                                                                                              | 0                                                                                                                              | yes
 query_wait_timeout        | 30                                                                                                                             | 120                                                                                                                            | yes
 reserve_pool_size         | 0                                                                                                                              | 0                                                                                                                              | yes
 reserve_pool_timeout      | 5                                                                                                                              | 5                                                                                                                              | yes
 resolv_conf               |                                                                                                                                |                                                                                                                                | no
 sbuf_loopcnt              | 5                                                                                                                              | 5                                                                                                                              | yes
 server_check_delay        | 30                                                                                                                             | 30                                                                                                                             | yes
 server_check_query        | select 1                                                                                                                       | select 1                                                                                                                       | yes
 server_connect_timeout    | 10                                                                                                                             | 15                                                                                                                             | yes
 server_fast_close         | 0                                                                                                                              | 0                                                                                                                              | yes
 server_idle_timeout       | 600                                                                                                                            | 600                                                                                                                            | yes
 server_lifetime           | 3600                                                                                                                           | 3600                                                                                                                           | yes
 server_login_retry        | 15                                                                                                                             | 15                                                                                                                             | yes
 server_reset_query        | DISCARD ALL                                                                                                                    | DISCARD ALL                                                                                                                    | yes
 server_reset_query_always | 0                                                                                                                              | 0                                                                                                                              | yes
 server_round_robin        | 0                                                                                                                              | 0                                                                                                                              | yes
 server_tls_ca_file        |                                                                                                                                |                                                                                                                                | yes
 server_tls_cert_file      |                                                                                                                                |                                                                                                                                | yes
 server_tls_ciphers        | fast                                                                                                                           | fast                                                                                                                           | yes
 server_tls_key_file       |                                                                                                                                |                                                                                                                                | yes
 server_tls_protocols      | secure                                                                                                                         | secure                                                                                                                         | yes
 server_tls_sslmode        | disable                                                                                                                        | disable                                                                                                                        | yes
 so_reuseport              | 0                                                                                                                              | 0                                                                                                                              | no
 stats_period              | 5                                                                                                                              | 60                                                                                                                             | yes
 stats_users               |                                                                                                                                |                                                                                                                                | yes
 suspend_timeout           | 10                                                                                                                             | 10                                                                                                                             | yes
 syslog                    | 0                                                                                                                              | 0                                                                                                                              | yes
 syslog_facility           | daemon                                                                                                                         | daemon                                                                                                                         | yes
 syslog_ident              | pgbouncer                                                                                                                      | pgbouncer                                                                                                                      | yes
 tcp_defer_accept          | 1                                                                                                                              | 1                                                                                                                              | yes
 tcp_keepalive             | 1                                                                                                                              | 1                                                                                                                              | yes
 tcp_keepcnt               | 0                                                                                                                              | 0                                                                                                                              | yes
 tcp_keepidle              | 0                                                                                                                              | 0                                                                                                                              | yes
 tcp_keepintvl             | 0                                                                                                                              | 0                                                                                                                              | yes
 tcp_socket_buffer         | 0                                                                                                                              | 0                                                                                                                              | yes
 tcp_user_timeout          | 0                                                                                                                              | 0                                                                                                                              | yes
 unix_socket_dir           | /tmp                                                                                                                           | /tmp                                                                                                                           | no
 unix_socket_group         |                                                                                                                                |                                                                                                                                | no
 unix_socket_mode          | 511                                                                                                                            | 0777                                                                                                                           | no
 user                      |                                                                                                                                |                                                                                                                                | no
 verbose                   | 0                                                                                                                              |                                                                                                                                | yes
(84 rows)


bash-3.2$ 
```

#### pooling_10_reconnexion/1_direct_connexions.csv

```csv
"timestamp","total","active","idle","idle_in_transaction"
"2026-10-07T13:26:12.631Z","0","0","0","0"
"2026-10-07T13:26:13.753Z","10","0","10","0"
"2026-10-07T13:26:14.894Z","10","0","10","0"
"2026-10-07T13:26:16.015Z","10","10","0","0"
"2026-10-07T13:26:17.152Z","10","0","10","0"
"2026-10-07T13:26:18.312Z","10","10","0","0"
"2026-10-07T13:26:19.447Z","10","0","10","0"
"2026-10-07T13:26:20.593Z","10","10","0","0"
"2026-10-07T13:26:21.741Z","8","0","0","8"
"2026-10-07T13:26:22.863Z","10","0","10","0"
"2026-10-07T13:26:24.070Z","10","10","0","0"
"2026-10-07T13:26:25.210Z","10","0","10","0"
"2026-10-07T13:26:26.368Z","10","10","0","0"
"2026-10-07T13:26:27.528Z","10","0","10","0"
"2026-10-07T13:26:28.656Z","10","0","10","0"
"2026-10-07T13:26:29.804Z","8","0","8","0"
"2026-10-07T13:26:30.921Z","10","10","0","0"
"2026-10-07T13:26:32.055Z","10","0","10","0"

```

#### pooling_10_reconnexion/1_direct_pgbench.txt

```text
pgbench (17.11 (Debian 17.11-1.pgdg12+2))
transaction type: /lab/charge.sql
scaling factor: 1
query mode: simple
number of clients: 10
number of threads: 2
maximum number of tries: 1
duration: 20 s
number of transactions actually processed: 970
number of failed transactions: 0 (0.000%)
latency average = 172.510 ms
latency stddev = 14.754 ms
average connection time = 10.404 ms
tps = 48.413819 (including reconnection times)

progress: 5.0 s, 47.8 tps, lat 172.433 ms stddev 14.241, 0 failed
progress: 10.0 s, 48.2 tps, lat 172.313 ms stddev 13.600, 0 failed
progress: 15.0 s, 48.0 tps, lat 173.936 ms stddev 17.471, 0 failed
progress: 20.0 s, 48.0 tps, lat 171.324 ms stddev 13.309, 0 failed

```

#### pooling_10_reconnexion/1_pool_connexions.csv

```csv
"timestamp","total","active","idle","idle_in_transaction"
"2026-10-07T13:26:41.838Z","4","0","4","0"
"2026-10-07T13:26:43.099Z","5","3","0","2"
"2026-10-07T13:26:44.341Z","5","2","1","2"
"2026-10-07T13:26:45.542Z","5","4","1","0"
"2026-10-07T13:26:46.793Z","5","5","0","0"
"2026-10-07T13:26:48.010Z","5","5","0","0"
"2026-10-07T13:26:49.286Z","5","5","0","0"
"2026-10-07T13:26:50.516Z","5","5","0","0"
"2026-10-07T13:26:51.739Z","5","5","0","0"
"2026-10-07T13:26:52.981Z","5","5","0","0"
"2026-10-07T13:26:54.212Z","5","5","0","0"
"2026-10-07T13:26:55.459Z","5","5","0","0"
"2026-10-07T13:26:56.680Z","5","2","0","3"
"2026-10-07T13:26:57.903Z","5","5","0","0"
"2026-10-07T13:26:59.131Z","5","5","0","0"
"2026-10-07T13:27:00.350Z","5","1","4","0"
"2026-10-07T13:27:01.569Z","5","0","5","0"

```

#### pooling_10_reconnexion/1_pool_observations.txt

```text

2026-10-07T13:26:41.839Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        10 |          0 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | transaction
(2 rows)


2026-10-07T13:26:43.099Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |         9 |          0 |                    0 |                     0 |         3 |                0 |                 0 |       2 |       0 |         0 |        0 |       0 |          0 | transaction
(2 rows)


2026-10-07T13:26:44.341Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        10 |          0 |                    0 |                     0 |         3 |                0 |                 0 |       2 |       0 |         0 |        0 |       0 |          0 | transaction
(2 rows)


2026-10-07T13:26:45.542Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |         9 |          0 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | transaction
(2 rows)


2026-10-07T13:26:46.793Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        10 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       5 |       0 |         0 |        0 |       0 |          0 | transaction
(2 rows)


2026-10-07T13:26:48.010Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        10 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       5 |       0 |         0 |        0 |       0 |          0 | transaction
(2 rows)


2026-10-07T13:26:49.286Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |         7 |          0 |                    0 |                     0 |         2 |                0 |                 0 |       3 |       0 |         0 |        0 |       0 |          0 | transaction
(2 rows)


2026-10-07T13:26:50.516Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |         8 |          0 |                    0 |                     0 |         3 |                0 |                 0 |       2 |       0 |         0 |        0 |       0 |          0 | transaction
(2 rows)


2026-10-07T13:26:51.739Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |         8 |          1 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |         99 | transaction
(2 rows)


2026-10-07T13:26:52.981Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        10 |          0 |                    0 |                     0 |         1 |                0 |                 0 |       4 |       0 |         0 |        0 |       0 |          0 | transaction
(2 rows)


2026-10-07T13:26:54.212Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        10 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       5 |       0 |         0 |        0 |       0 |          0 | transaction
(2 rows)


2026-10-07T13:26:55.460Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        10 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       5 |       0 |         0 |        0 |       0 |          0 | transaction
(2 rows)


2026-10-07T13:26:56.680Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |         6 |          0 |                    0 |                     0 |         1 |                0 |                 0 |       4 |       0 |         0 |        0 |       0 |          0 | transaction
(2 rows)


2026-10-07T13:26:57.903Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |         8 |          0 |                    0 |                     0 |         3 |                0 |                 0 |       2 |       0 |         0 |        0 |       0 |          0 | transaction
(2 rows)


2026-10-07T13:26:59.131Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |         9 |          0 |                    0 |                     0 |         3 |                0 |                 0 |       2 |       0 |         0 |        0 |       0 |          0 | transaction
(2 rows)


2026-10-07T13:27:00.350Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |         6 |          1 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |       4027 | transaction
(2 rows)


2026-10-07T13:27:01.569Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |         5 |          2 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |      14666 | transaction
(2 rows)


FIN
 database  | total_xact_count | total_query_count | total_received | total_sent | total_xact_time | total_query_time | total_wait_time | avg_xact_count | avg_query_count | avg_recv | avg_sent | avg_xact_time | avg_query_time | avg_wait_time 
-----------+------------------+-------------------+----------------+------------+-----------------+------------------+-----------------+----------------+-----------------+----------+----------+---------------+----------------+---------------
 pgbouncer |               18 |                18 |              0 |          0 |               0 |                0 |               0 |              0 |               0 |        0 |        0 |             0 |              0 |             0
 pooling   |             1139 |              4517 |         120550 |     189119 |        79080634 |         69874419 |        11256119 |             44 |             177 |     4718 |     7421 |         73887 |          16164 |        554324
(2 rows)


```

#### pooling_10_reconnexion/1_pool_pgbench.txt

```text
pgbench (17.11 (Debian 17.11-1.pgdg12+2))
transaction type: /lab/charge.sql
scaling factor: 1
query mode: simple
number of clients: 10
number of threads: 2
maximum number of tries: 1
duration: 20 s
number of transactions actually processed: 1018
number of failed transactions: 0 (0.000%)
latency average = 175.122 ms
latency stddev = 15.479 ms
average connection time = 9.389 ms
tps = 50.487084 (including reconnection times)

progress: 5.0 s, 52.6 tps, lat 170.126 ms stddev 16.710, 0 failed
progress: 10.0 s, 49.0 tps, lat 178.111 ms stddev 15.282, 0 failed
progress: 15.0 s, 51.2 tps, lat 175.646 ms stddev 14.150, 0 failed
progress: 20.0 s, 49.4 tps, lat 176.983 ms stddev 14.422, 0 failed

```

#### pooling_10_reconnexion/2_direct_connexions.csv

```csv
"timestamp","total","active","idle","idle_in_transaction"
"2026-10-07T13:27:35.391Z","0","0","0","0"
"2026-10-07T13:27:36.532Z","10","10","0","0"
"2026-10-07T13:27:37.665Z","10","0","10","0"
"2026-10-07T13:27:38.817Z","10","0","10","0"
"2026-10-07T13:27:39.962Z","0","0","0","0"
"2026-10-07T13:27:41.092Z","10","0","10","0"
"2026-10-07T13:27:42.232Z","6","0","0","6"
"2026-10-07T13:27:43.362Z","10","0","10","0"
"2026-10-07T13:27:44.495Z","10","0","10","0"
"2026-10-07T13:27:45.638Z","10","0","10","0"
"2026-10-07T13:27:46.864Z","4","0","1","3"
"2026-10-07T13:27:47.998Z","10","0","10","0"
"2026-10-07T13:27:49.144Z","8","0","0","8"
"2026-10-07T13:27:50.308Z","10","0","10","0"
"2026-10-07T13:27:51.457Z","8","0","0","8"
"2026-10-07T13:27:52.598Z","10","0","10","0"
"2026-10-07T13:27:53.764Z","4","0","0","4"
"2026-10-07T13:27:54.921Z","10","0","10","0"

```

#### pooling_10_reconnexion/2_direct_pgbench.txt

```text
pgbench (17.11 (Debian 17.11-1.pgdg12+2))
transaction type: /lab/charge.sql
scaling factor: 1
query mode: simple
number of clients: 10
number of threads: 2
maximum number of tries: 1
duration: 20 s
number of transactions actually processed: 960
number of failed transactions: 0 (0.000%)
latency average = 173.885 ms
latency stddev = 14.989 ms
average connection time = 10.690 ms
tps = 47.998716 (including reconnection times)

progress: 5.0 s, 48.0 tps, lat 172.952 ms stddev 13.015, 0 failed
progress: 10.0 s, 48.0 tps, lat 173.367 ms stddev 13.615, 0 failed
progress: 15.0 s, 46.0 tps, lat 175.634 ms stddev 18.382, 0 failed
progress: 20.0 s, 50.0 tps, lat 173.670 ms stddev 14.402, 0 failed

```

#### pooling_10_reconnexion/2_pool_connexions.csv

```csv
"timestamp","total","active","idle","idle_in_transaction"
"2026-10-07T13:27:09.383Z","5","0","5","0"
"2026-10-07T13:27:10.612Z","5","5","0","0"
"2026-10-07T13:27:11.908Z","5","5","0","0"
"2026-10-07T13:27:13.282Z","5","5","0","0"
"2026-10-07T13:27:14.624Z","5","5","0","0"
"2026-10-07T13:27:15.879Z","5","0","1","4"
"2026-10-07T13:27:17.134Z","5","5","0","0"
"2026-10-07T13:27:18.494Z","5","0","2","3"
"2026-10-07T13:27:19.725Z","5","1","0","4"
"2026-10-07T13:27:20.953Z","5","5","0","0"
"2026-10-07T13:27:22.198Z","5","5","0","0"
"2026-10-07T13:27:23.434Z","5","5","0","0"
"2026-10-07T13:27:24.670Z","5","1","4","0"
"2026-10-07T13:27:25.886Z","5","0","3","2"
"2026-10-07T13:27:27.128Z","5","0","2","3"
"2026-10-07T13:27:28.360Z","5","5","0","0"
"2026-10-07T13:27:29.610Z","5","0","5","0"

```

#### pooling_10_reconnexion/2_pool_observations.txt

```text

2026-10-07T13:27:09.384Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        10 |          0 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | transaction
(2 rows)


2026-10-07T13:27:10.612Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |         8 |          0 |                    0 |                     0 |         3 |                0 |                 0 |       2 |       0 |         0 |        0 |       0 |          0 | transaction
(2 rows)


2026-10-07T13:27:11.908Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |         8 |          0 |                    0 |                     0 |         3 |                0 |                 0 |       2 |       0 |         0 |        0 |       0 |          0 | transaction
(2 rows)


2026-10-07T13:27:13.283Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |         9 |          0 |                    0 |                     0 |         4 |                0 |                 0 |       1 |       0 |         0 |        0 |       0 |          0 | transaction
(2 rows)


2026-10-07T13:27:14.624Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        10 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       5 |       0 |         0 |        0 |       0 |          0 | transaction
(2 rows)


2026-10-07T13:27:15.879Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |         8 |          0 |                    0 |                     0 |         3 |                0 |                 0 |       2 |       0 |         0 |        0 |       0 |          0 | transaction
(2 rows)


2026-10-07T13:27:17.134Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |         5 |          5 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |      43312 | transaction
(2 rows)


2026-10-07T13:27:18.494Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        10 |          0 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | transaction
(2 rows)


2026-10-07T13:27:19.725Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        10 |          0 |                    0 |                     0 |         1 |                0 |                 0 |       4 |       0 |         0 |        0 |       0 |          0 | transaction
(2 rows)


2026-10-07T13:27:20.954Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        10 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       5 |       0 |         0 |        0 |       0 |          0 | transaction
(2 rows)


2026-10-07T13:27:22.199Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |         6 |          0 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | transaction
(2 rows)


2026-10-07T13:27:23.434Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |         5 |          1 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |       3934 | transaction
(2 rows)


2026-10-07T13:27:24.671Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        10 |          0 |                    0 |                     0 |         4 |                0 |                 0 |       1 |       0 |         0 |        0 |       0 |          0 | transaction
(2 rows)


2026-10-07T13:27:25.886Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        10 |          0 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | transaction
(2 rows)


2026-10-07T13:27:27.128Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        10 |          0 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | transaction
(2 rows)


2026-10-07T13:27:28.360Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        10 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       5 |       0 |         0 |        0 |       0 |          0 | transaction
(2 rows)


2026-10-07T13:27:29.610Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |         0 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       5 |       0 |         0 |        0 |       0 |          0 | transaction
(2 rows)


FIN
 database  | total_xact_count | total_query_count | total_received | total_sent | total_xact_time | total_query_time | total_wait_time | avg_xact_count | avg_query_count | avg_recv | avg_sent | avg_xact_time | avg_query_time | avg_wait_time 
-----------+------------------+-------------------+----------------+------------+-----------------+------------------+-----------------+----------------+-----------------+----------+----------+---------------+----------------+---------------
 pgbouncer |               36 |                36 |              0 |          0 |               0 |                0 |               0 |              0 |               0 |        0 |        0 |             0 |              0 |             0
 pooling   |             2271 |              9006 |         240352 |     376888 |       158733800 |        137372303 |        20517621 |             46 |             186 |     4979 |     7776 |         72991 |          16023 |        572791
(2 rows)


```

#### pooling_10_reconnexion/2_pool_pgbench.txt

```text
pgbench (17.11 (Debian 17.11-1.pgdg12+2))
transaction type: /lab/charge.sql
scaling factor: 1
query mode: simple
number of clients: 10
number of threads: 2
maximum number of tries: 1
duration: 20 s
number of transactions actually processed: 1007
number of failed transactions: 0 (0.000%)
latency average = 176.305 ms
latency stddev = 16.097 ms
average connection time = 9.481 ms
tps = 49.869107 (including reconnection times)

progress: 5.0 s, 49.8 tps, lat 174.361 ms stddev 15.435, 0 failed
progress: 10.0 s, 49.2 tps, lat 177.551 ms stddev 17.141, 0 failed
progress: 15.0 s, 50.4 tps, lat 176.648 ms stddev 16.099, 0 failed
progress: 20.0 s, 50.6 tps, lat 176.556 ms stddev 15.523, 0 failed

```

#### pooling_10_reconnexion/3_direct_connexions.csv

```csv
"timestamp","total","active","idle","idle_in_transaction"
"2026-10-07T13:28:01.373Z","0","0","0","0"
"2026-10-07T13:28:02.508Z","10","10","0","0"
"2026-10-07T13:28:03.646Z","10","0","10","0"
"2026-10-07T13:28:04.805Z","10","10","0","0"
"2026-10-07T13:28:05.915Z","10","0","10","0"
"2026-10-07T13:28:07.058Z","10","0","10","0"
"2026-10-07T13:28:08.214Z","10","0","10","0"
"2026-10-07T13:28:09.489Z","10","9","1","0"
"2026-10-07T13:28:10.716Z","10","3","7","0"
"2026-10-07T13:28:11.907Z","10","7","3","0"
"2026-10-07T13:28:13.373Z","9","0","5","4"
"2026-10-07T13:28:14.521Z","7","5","0","2"
"2026-10-07T13:28:15.698Z","9","0","5","4"
"2026-10-07T13:28:16.823Z","10","5","5","0"
"2026-10-07T13:28:17.992Z","10","0","10","0"
"2026-10-07T13:28:19.144Z","4","0","4","0"
"2026-10-07T13:28:20.276Z","10","0","10","0"
"2026-10-07T13:28:21.407Z","6","0","6","0"

```

#### pooling_10_reconnexion/3_direct_pgbench.txt

```text
pgbench (17.11 (Debian 17.11-1.pgdg12+2))
transaction type: /lab/charge.sql
scaling factor: 1
query mode: simple
number of clients: 10
number of threads: 2
maximum number of tries: 1
duration: 20 s
number of transactions actually processed: 980
number of failed transactions: 0 (0.000%)
latency average = 173.841 ms
latency stddev = 22.159 ms
average connection time = 10.538 ms
tps = 48.932942 (including reconnection times)

progress: 5.0 s, 48.0 tps, lat 172.836 ms stddev 13.249, 0 failed
progress: 10.0 s, 47.9 tps, lat 174.193 ms stddev 15.792, 0 failed
progress: 15.0 s, 49.1 tps, lat 177.541 ms stddev 36.517, 0 failed
progress: 20.0 s, 49.0 tps, lat 170.775 ms stddev 13.429, 0 failed

```

#### pooling_10_reconnexion/3_pool_connexions.csv

```csv
"timestamp","total","active","idle","idle_in_transaction"
"2026-10-07T13:28:31.309Z","4","0","4","0"
"2026-10-07T13:28:32.549Z","5","5","0","0"
"2026-10-07T13:28:33.829Z","5","3","0","2"
"2026-10-07T13:28:35.077Z","5","5","0","0"
"2026-10-07T13:28:36.286Z","5","0","5","0"
"2026-10-07T13:28:37.533Z","5","5","0","0"
"2026-10-07T13:28:38.740Z","5","5","0","0"
"2026-10-07T13:28:39.959Z","5","5","0","0"
"2026-10-07T13:28:41.174Z","5","0","5","0"
"2026-10-07T13:28:42.402Z","5","5","0","0"
"2026-10-07T13:28:43.635Z","5","5","0","0"
"2026-10-07T13:28:44.870Z","5","0","4","1"
"2026-10-07T13:28:46.097Z","5","5","0","0"
"2026-10-07T13:28:47.345Z","5","5","0","0"
"2026-10-07T13:28:48.564Z","5","2","3","0"
"2026-10-07T13:28:49.779Z","5","3","2","0"
"2026-10-07T13:28:51.003Z","5","5","0","0"

```

#### pooling_10_reconnexion/3_pool_observations.txt

```text

2026-10-07T13:28:31.309Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        10 |          0 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | transaction
(2 rows)


2026-10-07T13:28:32.550Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |         7 |          1 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | transaction
(2 rows)


2026-10-07T13:28:33.829Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |         6 |          0 |                    0 |                     0 |         1 |                0 |                 0 |       4 |       0 |         0 |        0 |       0 |          0 | transaction
(2 rows)


2026-10-07T13:28:35.078Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        10 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       5 |       0 |         0 |        0 |       0 |          0 | transaction
(2 rows)


2026-10-07T13:28:36.286Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |         5 |          4 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |      18097 | transaction
(2 rows)


2026-10-07T13:28:37.533Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |         7 |          0 |                    0 |                     0 |         2 |                0 |                 0 |       3 |       0 |         0 |        0 |       0 |          0 | transaction
(2 rows)


2026-10-07T13:28:38.740Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        10 |          0 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | transaction
(2 rows)


2026-10-07T13:28:39.959Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        10 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       5 |       0 |         0 |        0 |       0 |          0 | transaction
(2 rows)


2026-10-07T13:28:41.174Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        10 |          0 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | transaction
(2 rows)


2026-10-07T13:28:42.402Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        10 |          0 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | transaction
(2 rows)


2026-10-07T13:28:43.635Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        10 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       5 |       0 |         0 |        0 |       0 |          0 | transaction
(2 rows)


2026-10-07T13:28:44.870Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        10 |          0 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | transaction
(2 rows)


2026-10-07T13:28:46.097Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        10 |          0 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | transaction
(2 rows)


2026-10-07T13:28:47.345Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |         8 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       5 |       0 |         0 |        0 |       0 |          0 | transaction
(2 rows)


2026-10-07T13:28:48.564Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |         9 |          0 |                    0 |                     0 |         4 |                0 |                 0 |       1 |       0 |         0 |        0 |       0 |          0 | transaction
(2 rows)


2026-10-07T13:28:49.779Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        10 |          0 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | transaction
(2 rows)


2026-10-07T13:28:51.003Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |         9 |          0 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | transaction
(2 rows)


FIN
 database  | total_xact_count | total_query_count | total_received | total_sent | total_xact_time | total_query_time | total_wait_time | avg_xact_count | avg_query_count | avg_recv | avg_sent | avg_xact_time | avg_query_time | avg_wait_time 
-----------+------------------+-------------------+----------------+------------+-----------------+------------------+-----------------+----------------+-----------------+----------+----------+---------------+----------------+---------------
 pgbouncer |               18 |                18 |              0 |          0 |               0 |                0 |               0 |              0 |               0 |        0 |        0 |             0 |              0 |             0
 pooling   |             1206 |              4785 |         127702 |     200241 |        77163896 |         70107337 |         8239289 |             49 |             196 |     5250 |     8249 |         65226 |          14685 |        311839
(2 rows)


```

#### pooling_10_reconnexion/3_pool_pgbench.txt

```text
pgbench (17.11 (Debian 17.11-1.pgdg12+2))
transaction type: /lab/charge.sql
scaling factor: 1
query mode: simple
number of clients: 10
number of threads: 2
maximum number of tries: 1
duration: 20 s
number of transactions actually processed: 1085
number of failed transactions: 0 (0.000%)
latency average = 168.138 ms
latency stddev = 10.756 ms
average connection time = 10.509 ms
tps = 53.835355 (including reconnection times)

progress: 5.0 s, 52.0 tps, lat 168.374 ms stddev 11.792, 0 failed
progress: 10.0 s, 54.0 tps, lat 169.628 ms stddev 11.123, 0 failed
progress: 15.0 s, 54.0 tps, lat 167.452 ms stddev 8.632, 0 failed
progress: 20.0 s, 55.0 tps, lat 167.296 ms stddev 11.186, 0 failed

```

#### pooling_10_reconnexion/configuration.txt

```text
{
  "clients": 10,
  "seconds": 20,
  "repeats": 3,
  "connect": true
}
PostgreSQL 17.11 (Debian 17.11-1.pgdg12+2) on aarch64-unknown-linux-gnu, compiled by gcc (Debian 12.2.0-14+deb12u1) 12.2.0, 64-bit
60
PgBouncer 1.18.0
libevent 2.1.12-stable
adns: c-ares 1.18.1
tls: OpenSSL 3.0.22 25 Aug 2026
systemd: yes
            key            |                                                             value                                                              |                                                            default                                                             | changeable 
---------------------------+--------------------------------------------------------------------------------------------------------------------------------+--------------------------------------------------------------------------------------------------------------------------------+------------
 admin_users               | observateur                                                                                                                    |                                                                                                                                | yes
 application_name_add_host | 0                                                                                                                              | 0                                                                                                                              | yes
 auth_file                 | /etc/pgbouncer/userlist.txt                                                                                                    |                                                                                                                                | yes
 auth_hba_file             |                                                                                                                                |                                                                                                                                | yes
 auth_query                | SELECT rolname, CASE WHEN rolvaliduntil < now() THEN NULL ELSE rolpassword END FROM pg_authid WHERE rolname=$1 AND rolcanlogin | SELECT rolname, CASE WHEN rolvaliduntil < now() THEN NULL ELSE rolpassword END FROM pg_authid WHERE rolname=$1 AND rolcanlogin | yes
 auth_type                 | scram-sha-256                                                                                                                  | md5                                                                                                                            | yes
 auth_user                 |                                                                                                                                |                                                                                                                                | yes
 autodb_idle_timeout       | 3600                                                                                                                           | 3600                                                                                                                           | yes
 client_idle_timeout       | 0                                                                                                                              | 0                                                                                                                              | yes
 client_login_timeout      | 60                                                                                                                             | 60                                                                                                                             | yes
 client_tls_ca_file        |                                                                                                                                |                                                                                                                                | yes
 client_tls_cert_file      |                                                                                                                                |                                                                                                                                | yes
 client_tls_ciphers        | fast                                                                                                                           | fast                                                                                                                           | yes
 client_tls_dheparams      | auto                                                                                                                           | auto                                                                                                                           | yes
 client_tls_ecdhcurve      | auto                                                                                                                           | auto                                                                                                                           | yes
 client_tls_key_file       |                                                                                                                                |                                                                                                                                | yes
 client_tls_protocols      | secure                                                                                                                         | secure                                                                                                                         | yes
 client_tls_sslmode        | disable                                                                                                                        | disable                                                                                                                        | yes
 conffile                  | /etc/pgbouncer/pgbouncer.ini                                                                                                   |                                                                                                                                | yes
 default_pool_size         | 5                                                                                                                              | 20                                                                                                                             | yes
 disable_pqexec            | 0                                                                                                                              | 0                                                                                                                              | no
 dns_max_ttl               | 15                                                                                                                             | 15                                                                                                                             | yes
 dns_nxdomain_ttl          | 15                                                                                                                             | 15                                                                                                                             | yes
 dns_zone_check_period     | 0                                                                                                                              | 0                                                                                                                              | yes
 idle_transaction_timeout  | 0                                                                                                                              | 0                                                                                                                              | yes
 ignore_startup_parameters |                                                                                                                                |                                                                                                                                | yes
 job_name                  | pgbouncer                                                                                                                      | pgbouncer                                                                                                                      | no
 listen_addr               | 0.0.0.0                                                                                                                        |                                                                                                                                | no
 listen_backlog            | 128                                                                                                                            | 128                                                                                                                            | no
 listen_port               | 6432                                                                                                                           | 6432                                                                                                                           | no
 log_connections           | 0                                                                                                                              | 1                                                                                                                              | yes
 log_disconnections        | 0                                                                                                                              | 1                                                                                                                              | yes
 log_pooler_errors         | 1                                                                                                                              | 1                                                                                                                              | yes
 log_stats                 | 1                                                                                                                              | 1                                                                                                                              | yes
 logfile                   |                                                                                                                                |                                                                                                                                | yes
 max_client_conn           | 200                                                                                                                            | 100                                                                                                                            | yes
 max_db_connections        | 0                                                                                                                              | 0                                                                                                                              | yes
 max_packet_size           | 2147483647                                                                                                                     | 2147483647                                                                                                                     | yes
 max_user_connections      | 0                                                                                                                              | 0                                                                                                                              | yes
 min_pool_size             | 0                                                                                                                              | 0                                                                                                                              | yes
 pidfile                   |                                                                                                                                |                                                                                                                                | no
 pkt_buf                   | 4096                                                                                                                           | 4096                                                                                                                           | no
 pool_mode                 | transaction                                                                                                                    | session                                                                                                                        | yes
 query_timeout             | 0                                                                                                                              | 0                                                                                                                              | yes
 query_wait_timeout        | 30                                                                                                                             | 120                                                                                                                            | yes
 reserve_pool_size         | 0                                                                                                                              | 0                                                                                                                              | yes
 reserve_pool_timeout      | 5                                                                                                                              | 5                                                                                                                              | yes
 resolv_conf               |                                                                                                                                |                                                                                                                                | no
 sbuf_loopcnt              | 5                                                                                                                              | 5                                                                                                                              | yes
 server_check_delay        | 30                                                                                                                             | 30                                                                                                                             | yes
 server_check_query        | select 1                                                                                                                       | select 1                                                                                                                       | yes
 server_connect_timeout    | 10                                                                                                                             | 15                                                                                                                             | yes
 server_fast_close         | 0                                                                                                                              | 0                                                                                                                              | yes
 server_idle_timeout       | 600                                                                                                                            | 600                                                                                                                            | yes
 server_lifetime           | 3600                                                                                                                           | 3600                                                                                                                           | yes
 server_login_retry        | 15                                                                                                                             | 15                                                                                                                             | yes
 server_reset_query        | DISCARD ALL                                                                                                                    | DISCARD ALL                                                                                                                    | yes
 server_reset_query_always | 0                                                                                                                              | 0                                                                                                                              | yes
 server_round_robin        | 0                                                                                                                              | 0                                                                                                                              | yes
 server_tls_ca_file        |                                                                                                                                |                                                                                                                                | yes
 server_tls_cert_file      |                                                                                                                                |                                                                                                                                | yes
 server_tls_ciphers        | fast                                                                                                                           | fast                                                                                                                           | yes
 server_tls_key_file       |                                                                                                                                |                                                                                                                                | yes
 server_tls_protocols      | secure                                                                                                                         | secure                                                                                                                         | yes
 server_tls_sslmode        | disable                                                                                                                        | disable                                                                                                                        | yes
 so_reuseport              | 0                                                                                                                              | 0                                                                                                                              | no
 stats_period              | 5                                                                                                                              | 60                                                                                                                             | yes
 stats_users               |                                                                                                                                |                                                                                                                                | yes
 suspend_timeout           | 10                                                                                                                             | 10                                                                                                                             | yes
 syslog                    | 0                                                                                                                              | 0                                                                                                                              | yes
 syslog_facility           | daemon                                                                                                                         | daemon                                                                                                                         | yes
 syslog_ident              | pgbouncer                                                                                                                      | pgbouncer                                                                                                                      | yes
 tcp_defer_accept          | 1                                                                                                                              | 1                                                                                                                              | yes
 tcp_keepalive             | 1                                                                                                                              | 1                                                                                                                              | yes
 tcp_keepcnt               | 0                                                                                                                              | 0                                                                                                                              | yes
 tcp_keepidle              | 0                                                                                                                              | 0                                                                                                                              | yes
 tcp_keepintvl             | 0                                                                                                                              | 0                                                                                                                              | yes
 tcp_socket_buffer         | 0                                                                                                                              | 0                                                                                                                              | yes
 tcp_user_timeout          | 0                                                                                                                              | 0                                                                                                                              | yes
 unix_socket_dir           | /tmp                                                                                                                           | /tmp                                                                                                                           | no
 unix_socket_group         |                                                                                                                                |                                                                                                                                | no
 unix_socket_mode          | 511                                                                                                                            | 0777                                                                                                                           | no
 user                      |                                                                                                                                |                                                                                                                                | no
 verbose                   | 0                                                                                                                              |                                                                                                                                | yes
(84 rows)


CONTAINER                         REPOSITORY                      TAG                 PLATFORM            IMAGE ID            SIZE                CREATED
shopflow-j4-pooling-bench-1       shopflow-j4-pooling-bench       latest              linux/arm64         39ffd5e5d5f4        156MB               8 minutes ago
shopflow-j4-pooling-db-1          shopflow-j4-pooling-db          latest              linux/arm64         32760fd2c2a7        156MB               8 minutes ago
shopflow-j4-pooling-pgbouncer-1   shopflow-j4-pooling-pgbouncer   latest              linux/arm64         2fbf1d79f5c6        49.4MB              8 minutes ago

```

#### pooling_10_reconnexion/synthese.csv

```csv
"essai","route","clients","secondes_demandees","mode","code_sortie","transactions","transactions_echouees","tps","latence_moyenne_ms","pic_connexions_echantillonne","nb_echantillons","duree_pilote_s"
"1_direct","direct","10","20","reconnexion","0","970","0","48.413819","172.510","10","18","20.558"
"1_pool","pool","10","20","reconnexion","0","1018","0","50.487084","175.122","5","17","21.004"
"2_pool","pool","10","20","reconnexion","0","1007","0","49.869107","176.305","5","17","20.547"
"2_direct","direct","10","20","reconnexion","0","960","0","47.998716","173.885","10","18","20.688"
"3_direct","direct","10","20","reconnexion","0","980","0","48.932942","173.841","10","18","21.161"
"3_pool","pool","10","20","reconnexion","0","1085","0","53.835355","168.138","5","17","21.034"

```

#### pooling_40_persistant/1_direct_connexions.csv

```csv
"timestamp","total","active","idle","idle_in_transaction"
"2026-10-07T13:21:03.030Z","0","0","0","0"
"2026-10-07T13:21:04.212Z","40","0","40","0"
"2026-10-07T13:21:05.346Z","40","0","40","0"
"2026-10-07T13:21:06.485Z","40","40","0","0"
"2026-10-07T13:21:07.627Z","40","0","40","0"
"2026-10-07T13:21:08.773Z","40","0","40","0"
"2026-10-07T13:21:09.937Z","40","0","40","0"
"2026-10-07T13:21:11.080Z","40","0","40","0"
"2026-10-07T13:21:12.224Z","40","40","0","0"
"2026-10-07T13:21:13.349Z","40","38","0","2"
"2026-10-07T13:21:14.536Z","40","0","40","0"
"2026-10-07T13:21:15.696Z","40","40","0","0"
"2026-10-07T13:21:16.840Z","40","0","40","0"
"2026-10-07T13:21:17.988Z","40","0","40","0"
"2026-10-07T13:21:19.149Z","40","0","40","0"
"2026-10-07T13:21:20.298Z","40","0","40","0"
"2026-10-07T13:21:21.434Z","40","40","0","0"
"2026-10-07T13:21:22.628Z","40","0","40","0"

```

#### pooling_40_persistant/1_direct_pgbench.txt

```text
pgbench (17.11 (Debian 17.11-1.pgdg12+2))
transaction type: /lab/charge.sql
scaling factor: 1
query mode: simple
number of clients: 40
number of threads: 2
maximum number of tries: 1
duration: 20 s
number of transactions actually processed: 5120
number of failed transactions: 0 (0.000%)
latency average = 155.461 ms
latency stddev = 4.317 ms
initial connection time = 134.994 ms
tps = 256.493571 (without initial connection time)

progress: 5.0 s, 247.7 tps, lat 155.538 ms stddev 2.536, 0 failed
progress: 10.0 s, 256.0 tps, lat 155.482 ms stddev 2.534, 0 failed
progress: 15.0 s, 256.2 tps, lat 156.409 ms stddev 7.324, 0 failed
progress: 20.0 s, 256.0 tps, lat 154.357 ms stddev 2.439, 0 failed

```

#### pooling_40_persistant/1_pool_connexions.csv

```csv
"timestamp","total","active","idle","idle_in_transaction"
"2026-10-07T13:21:32.287Z","4","0","4","0"
"2026-10-07T13:21:33.631Z","5","5","0","0"
"2026-10-07T13:21:34.887Z","5","4","1","0"
"2026-10-07T13:21:36.150Z","5","5","0","0"
"2026-10-07T13:21:37.400Z","5","5","0","0"
"2026-10-07T13:21:38.634Z","5","5","0","0"
"2026-10-07T13:21:39.902Z","5","5","0","0"
"2026-10-07T13:21:41.157Z","5","5","0","0"
"2026-10-07T13:21:42.404Z","5","5","0","0"
"2026-10-07T13:21:43.652Z","5","5","0","0"
"2026-10-07T13:21:44.930Z","5","5","0","0"
"2026-10-07T13:21:46.164Z","5","5","0","0"
"2026-10-07T13:21:47.489Z","5","3","0","2"
"2026-10-07T13:21:48.891Z","5","3","0","2"
"2026-10-07T13:21:50.239Z","5","4","0","1"
"2026-10-07T13:21:51.497Z","5","5","0","0"
"2026-10-07T13:21:52.744Z","5","0","5","0"

```

#### pooling_40_persistant/1_pool_observations.txt

```text

2026-10-07T13:21:32.287Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        27 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       4 |       0 |         0 |        0 |       0 |          0 | transaction
(2 rows)


2026-10-07T13:21:33.632Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        15 |         25 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |     220128 | transaction
(2 rows)


2026-10-07T13:21:34.887Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        15 |         25 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |     227832 | transaction
(2 rows)


2026-10-07T13:21:36.150Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        15 |         25 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |     247343 | transaction
(2 rows)


2026-10-07T13:21:37.400Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        14 |         27 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |     264415 | transaction
(2 rows)


2026-10-07T13:21:38.634Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        15 |         25 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |     231960 | transaction
(2 rows)


2026-10-07T13:21:39.902Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        15 |         26 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |     260157 | transaction
(2 rows)


2026-10-07T13:21:41.157Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        15 |         25 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |     250437 | transaction
(2 rows)


2026-10-07T13:21:42.404Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        15 |         25 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |     211934 | transaction
(2 rows)


2026-10-07T13:21:43.652Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        15 |         25 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |     253441 | transaction
(2 rows)


2026-10-07T13:21:44.930Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        15 |         25 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |     225097 | transaction
(2 rows)


2026-10-07T13:21:46.164Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        15 |         25 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |     247576 | transaction
(2 rows)


2026-10-07T13:21:47.489Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        15 |         25 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |     225515 | transaction
(2 rows)


2026-10-07T13:21:48.892Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        15 |         25 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |     250133 | transaction
(2 rows)


2026-10-07T13:21:50.239Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        15 |         25 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |     236127 | transaction
(2 rows)


2026-10-07T13:21:51.497Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        15 |         26 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |     239436 | transaction
(2 rows)


2026-10-07T13:21:52.744Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |         0 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       5 |       0 |         0 |        0 |       0 |          0 | transaction
(2 rows)


FIN
 database  | total_xact_count | total_query_count | total_received | total_sent | total_xact_time | total_query_time | total_wait_time | avg_xact_count | avg_query_count | avg_recv | avg_sent | avg_xact_time | avg_query_time | avg_wait_time 
-----------+------------------+-------------------+----------------+------------+-----------------+------------------+-----------------+----------------+-----------------+----------+----------+---------------+----------------+---------------
 pgbouncer |               18 |                18 |              0 |          0 |               0 |                0 |               0 |              0 |               0 |        0 |        0 |             0 |              0 |             0
 pooling   |             2048 |              8156 |         217824 |     340024 |       614483477 |        613422157 |       507352364 |             88 |             360 |     9693 |    15151 |        330657 |          80262 |      24191483
(2 rows)


```

#### pooling_40_persistant/1_pool_pgbench.txt

```text
pgbench (17.11 (Debian 17.11-1.pgdg12+2))
transaction type: /lab/charge.sql
scaling factor: 1
query mode: simple
number of clients: 40
number of threads: 2
maximum number of tries: 1
duration: 20 s
number of transactions actually processed: 1908
number of failed transactions: 0 (0.000%)
latency average = 418.449 ms
latency stddev = 22.022 ms
initial connection time = 233.993 ms
tps = 94.695217 (without initial connection time)

progress: 5.0 s, 88.0 tps, lat 413.592 ms stddev 43.689, 0 failed
progress: 10.0 s, 94.8 tps, lat 420.714 ms stddev 5.955, 0 failed
progress: 15.0 s, 95.0 tps, lat 421.603 ms stddev 8.749, 0 failed
progress: 20.0 s, 95.8 tps, lat 417.319 ms stddev 5.308, 0 failed

```

#### pooling_40_persistant/2_direct_connexions.csv

```csv
"timestamp","total","active","idle","idle_in_transaction"
"2026-10-07T13:22:26.334Z","0","0","0","0"
"2026-10-07T13:22:27.468Z","40","40","0","0"
"2026-10-07T13:22:28.616Z","40","0","40","0"
"2026-10-07T13:22:29.763Z","40","40","0","0"
"2026-10-07T13:22:30.874Z","40","40","0","0"
"2026-10-07T13:22:32.016Z","40","0","40","0"
"2026-10-07T13:22:33.171Z","40","40","0","0"
"2026-10-07T13:22:34.315Z","40","0","40","0"
"2026-10-07T13:22:35.459Z","40","0","40","0"
"2026-10-07T13:22:36.586Z","40","40","0","0"
"2026-10-07T13:22:37.736Z","40","0","40","0"
"2026-10-07T13:22:38.881Z","40","0","40","0"
"2026-10-07T13:22:40.019Z","40","40","0","0"
"2026-10-07T13:22:41.158Z","40","0","40","0"
"2026-10-07T13:22:42.294Z","40","0","40","0"
"2026-10-07T13:22:43.449Z","40","40","0","0"
"2026-10-07T13:22:44.599Z","40","0","40","0"
"2026-10-07T13:22:45.746Z","40","0","40","0"

```

#### pooling_40_persistant/2_direct_pgbench.txt

```text
pgbench (17.11 (Debian 17.11-1.pgdg12+2))
transaction type: /lab/charge.sql
scaling factor: 1
query mode: simple
number of clients: 40
number of threads: 2
maximum number of tries: 1
duration: 20 s
number of transactions actually processed: 5120
number of failed transactions: 0 (0.000%)
latency average = 155.877 ms
latency stddev = 10.196 ms
initial connection time = 136.503 ms
tps = 255.366283 (without initial connection time)

progress: 5.0 s, 247.9 tps, lat 155.189 ms stddev 3.612, 0 failed
progress: 10.0 s, 256.1 tps, lat 154.583 ms stddev 2.164, 0 failed
progress: 15.0 s, 256.0 tps, lat 155.257 ms stddev 1.753, 0 failed
progress: 20.0 s, 256.0 tps, lat 155.059 ms stddev 3.014, 0 failed

```

#### pooling_40_persistant/2_pool_connexions.csv

```csv
"timestamp","total","active","idle","idle_in_transaction"
"2026-10-07T13:21:59.583Z","5","0","5","0"
"2026-10-07T13:22:00.844Z","5","5","0","0"
"2026-10-07T13:22:02.097Z","5","5","0","0"
"2026-10-07T13:22:03.344Z","5","5","0","0"
"2026-10-07T13:22:04.663Z","5","5","0","0"
"2026-10-07T13:22:05.891Z","5","5","0","0"
"2026-10-07T13:22:07.124Z","5","5","0","0"
"2026-10-07T13:22:08.369Z","5","5","0","0"
"2026-10-07T13:22:09.614Z","5","5","0","0"
"2026-10-07T13:22:10.848Z","5","5","0","0"
"2026-10-07T13:22:12.065Z","5","5","0","0"
"2026-10-07T13:22:13.325Z","5","5","0","0"
"2026-10-07T13:22:14.575Z","5","5","0","0"
"2026-10-07T13:22:15.806Z","5","5","0","0"
"2026-10-07T13:22:17.028Z","5","5","0","0"
"2026-10-07T13:22:18.279Z","5","5","0","0"
"2026-10-07T13:22:19.534Z","5","5","0","0"

```

#### pooling_40_persistant/2_pool_observations.txt

```text

2026-10-07T13:21:59.583Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        26 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       5 |       0 |         0 |        0 |       0 |          0 | transaction
(2 rows)


2026-10-07T13:22:00.844Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        15 |         25 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |     247797 | transaction
(2 rows)


2026-10-07T13:22:02.097Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        15 |         25 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |     256019 | transaction
(2 rows)


2026-10-07T13:22:03.345Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        14 |         26 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |     281320 | transaction
(2 rows)


2026-10-07T13:22:04.663Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        15 |         25 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |     229487 | transaction
(2 rows)


2026-10-07T13:22:05.891Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        13 |         27 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |     266245 | transaction
(2 rows)


2026-10-07T13:22:07.124Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        15 |         26 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |     242976 | transaction
(2 rows)


2026-10-07T13:22:08.369Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        15 |         25 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |     244793 | transaction
(2 rows)


2026-10-07T13:22:09.614Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        15 |         26 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |     254246 | transaction
(2 rows)


2026-10-07T13:22:10.849Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        15 |         25 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |     256463 | transaction
(2 rows)


2026-10-07T13:22:12.065Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        15 |         25 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |     245616 | transaction
(2 rows)


2026-10-07T13:22:13.325Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        15 |         25 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |     249851 | transaction
(2 rows)


2026-10-07T13:22:14.575Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        15 |         25 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |     252727 | transaction
(2 rows)


2026-10-07T13:22:15.806Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        15 |         25 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |     253360 | transaction
(2 rows)


2026-10-07T13:22:17.028Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        15 |         25 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |     219606 | transaction
(2 rows)


2026-10-07T13:22:18.279Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        15 |         25 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |     220307 | transaction
(2 rows)


2026-10-07T13:22:19.534Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        15 |         20 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |     258394 | transaction
(2 rows)


FIN
 database  | total_xact_count | total_query_count | total_received | total_sent | total_xact_time | total_query_time | total_wait_time | avg_xact_count | avg_query_count | avg_recv | avg_sent | avg_xact_time | avg_query_time | avg_wait_time 
-----------+------------------+-------------------+----------------+------------+-----------------+------------------+-----------------+----------------+-----------------+----------+----------+---------------+----------------+---------------
 pgbouncer |               36 |                36 |              0 |          0 |               0 |                0 |               0 |              0 |               0 |        0 |        0 |             0 |              0 |             0
 pooling   |             4098 |             16320 |         435840 |     680192 |      1230400072 |       1228297633 |      1015904527 |             76 |             319 |     8633 |    13517 |        340518 |          81263 |      21718011
(2 rows)


```

#### pooling_40_persistant/2_pool_pgbench.txt

```text
pgbench (17.11 (Debian 17.11-1.pgdg12+2))
transaction type: /lab/charge.sql
scaling factor: 1
query mode: simple
number of clients: 40
number of threads: 2
maximum number of tries: 1
duration: 20 s
number of transactions actually processed: 1908
number of failed transactions: 0 (0.000%)
latency average = 419.232 ms
latency stddev = 22.576 ms
initial connection time = 192.370 ms
tps = 94.551556 (without initial connection time)

progress: 5.0 s, 88.4 tps, lat 414.027 ms stddev 44.305, 0 failed
progress: 10.0 s, 95.8 tps, lat 419.706 ms stddev 5.313, 0 failed
progress: 15.0 s, 94.8 tps, lat 420.729 ms stddev 6.965, 0 failed
progress: 20.0 s, 94.6 tps, lat 422.172 ms stddev 10.337, 0 failed

```

#### pooling_40_persistant/3_direct_connexions.csv

```csv
"timestamp","total","active","idle","idle_in_transaction"
"2026-10-07T13:22:52.415Z","0","0","0","0"
"2026-10-07T13:22:53.622Z","40","5","35","0"
"2026-10-07T13:22:54.809Z","40","0","40","0"
"2026-10-07T13:22:55.939Z","40","40","0","0"
"2026-10-07T13:22:57.067Z","40","40","0","0"
"2026-10-07T13:22:58.224Z","40","0","40","0"
"2026-10-07T13:22:59.392Z","40","40","0","0"
"2026-10-07T13:23:00.550Z","40","0","40","0"
"2026-10-07T13:23:01.698Z","40","0","40","0"
"2026-10-07T13:23:02.826Z","40","0","40","0"
"2026-10-07T13:23:03.963Z","40","40","0","0"
"2026-10-07T13:23:05.151Z","40","0","40","0"
"2026-10-07T13:23:06.319Z","40","40","0","0"
"2026-10-07T13:23:07.500Z","40","0","40","0"
"2026-10-07T13:23:08.698Z","40","40","0","0"
"2026-10-07T13:23:09.863Z","40","0","40","0"
"2026-10-07T13:23:11.003Z","40","40","0","0"
"2026-10-07T13:23:12.118Z","40","34","6","0"

```

#### pooling_40_persistant/3_direct_pgbench.txt

```text
pgbench (17.11 (Debian 17.11-1.pgdg12+2))
transaction type: /lab/charge.sql
scaling factor: 1
query mode: simple
number of clients: 40
number of threads: 2
maximum number of tries: 1
duration: 20 s
number of transactions actually processed: 5120
number of failed transactions: 0 (0.000%)
latency average = 154.729 ms
latency stddev = 4.988 ms
initial connection time = 289.811 ms
tps = 257.705404 (without initial connection time)

progress: 5.0 s, 239.9 tps, lat 154.586 ms stddev 4.498, 0 failed
progress: 10.0 s, 256.3 tps, lat 153.252 ms stddev 2.415, 0 failed
progress: 15.0 s, 255.8 tps, lat 156.084 ms stddev 7.893, 0 failed
progress: 20.0 s, 264.0 tps, lat 154.823 ms stddev 2.588, 0 failed

```

#### pooling_40_persistant/3_pool_connexions.csv

```csv
"timestamp","total","active","idle","idle_in_transaction"
"2026-10-07T13:23:21.861Z","4","0","4","0"
"2026-10-07T13:23:23.241Z","5","5","0","0"
"2026-10-07T13:23:24.520Z","5","5","0","0"
"2026-10-07T13:23:25.768Z","5","5","0","0"
"2026-10-07T13:23:27.032Z","5","5","0","0"
"2026-10-07T13:23:28.269Z","5","5","0","0"
"2026-10-07T13:23:29.574Z","5","5","0","0"
"2026-10-07T13:23:30.808Z","5","5","0","0"
"2026-10-07T13:23:32.055Z","5","5","0","0"
"2026-10-07T13:23:33.309Z","5","5","0","0"
"2026-10-07T13:23:34.563Z","5","5","0","0"
"2026-10-07T13:23:35.796Z","5","5","0","0"
"2026-10-07T13:23:37.083Z","5","5","0","0"
"2026-10-07T13:23:38.340Z","5","5","0","0"
"2026-10-07T13:23:39.582Z","5","5","0","0"
"2026-10-07T13:23:40.810Z","5","5","0","0"
"2026-10-07T13:23:42.060Z","5","5","0","0"

```

#### pooling_40_persistant/3_pool_observations.txt

```text

2026-10-07T13:23:21.861Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        27 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       4 |       0 |         0 |        0 |       0 |          0 | transaction
(2 rows)


2026-10-07T13:23:23.241Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        12 |         28 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |     268079 | transaction
(2 rows)


2026-10-07T13:23:24.520Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        15 |         25 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |     245927 | transaction
(2 rows)


2026-10-07T13:23:25.768Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        15 |         25 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |     236112 | transaction
(2 rows)


2026-10-07T13:23:27.032Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        15 |         26 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |     242626 | transaction
(2 rows)


2026-10-07T13:23:28.269Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        15 |         25 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |     253139 | transaction
(2 rows)


2026-10-07T13:23:29.575Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        15 |         26 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |     291298 | transaction
(2 rows)


2026-10-07T13:23:30.808Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        15 |         25 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |     226572 | transaction
(2 rows)


2026-10-07T13:23:32.055Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        15 |         25 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |     214156 | transaction
(2 rows)


2026-10-07T13:23:33.309Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        15 |         25 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |     231798 | transaction
(2 rows)


2026-10-07T13:23:34.563Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        15 |         25 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |     247329 | transaction
(2 rows)


2026-10-07T13:23:35.796Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        15 |         25 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |     225584 | transaction
(2 rows)


2026-10-07T13:23:37.083Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        15 |         25 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |     221402 | transaction
(2 rows)


2026-10-07T13:23:38.340Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        15 |         25 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |     250074 | transaction
(2 rows)


2026-10-07T13:23:39.582Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        15 |         25 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |     233741 | transaction
(2 rows)


2026-10-07T13:23:40.810Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        15 |         25 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |     254907 | transaction
(2 rows)


2026-10-07T13:23:42.060Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        15 |          0 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | transaction
(2 rows)


FIN
 database  | total_xact_count | total_query_count | total_received | total_sent | total_xact_time | total_query_time | total_wait_time | avg_xact_count | avg_query_count | avg_recv | avg_sent | avg_xact_time | avg_query_time | avg_wait_time 
-----------+------------------+-------------------+----------------+------------+-----------------+------------------+-----------------+----------------+-----------------+----------+----------+---------------+----------------+---------------
 pgbouncer |               18 |                18 |              0 |          0 |               0 |                0 |               0 |              0 |               0 |        0 |        0 |             0 |              0 |             0
 pooling   |             2052 |              8172 |         218224 |     340688 |       616322601 |        615352291 |       508737126 |             81 |             332 |     8933 |    13961 |        330738 |          80329 |      22309264
(2 rows)


```

#### pooling_40_persistant/3_pool_pgbench.txt

```text
pgbench (17.11 (Debian 17.11-1.pgdg12+2))
transaction type: /lab/charge.sql
scaling factor: 1
query mode: simple
number of clients: 40
number of threads: 2
maximum number of tries: 1
duration: 20 s
number of transactions actually processed: 1912
number of failed transactions: 0 (0.000%)
latency average = 418.915 ms
latency stddev = 21.903 ms
initial connection time = 208.303 ms
tps = 94.615132 (without initial connection time)

progress: 5.0 s, 88.8 tps, lat 412.807 ms stddev 42.999, 0 failed
progress: 10.0 s, 94.7 tps, lat 421.972 ms stddev 9.404, 0 failed
progress: 15.0 s, 95.3 tps, lat 419.650 ms stddev 6.446, 0 failed
progress: 20.0 s, 95.6 tps, lat 420.488 ms stddev 4.912, 0 failed

```

#### pooling_40_persistant/configuration.txt

```text
{
  "clients": 40,
  "seconds": 20,
  "repeats": 3,
  "connect": false
}
PostgreSQL 17.11 (Debian 17.11-1.pgdg12+2) on aarch64-unknown-linux-gnu, compiled by gcc (Debian 12.2.0-14+deb12u1) 12.2.0, 64-bit
60
PgBouncer 1.18.0
libevent 2.1.12-stable
adns: c-ares 1.18.1
tls: OpenSSL 3.0.22 25 Aug 2026
systemd: yes
            key            |                                                             value                                                              |                                                            default                                                             | changeable 
---------------------------+--------------------------------------------------------------------------------------------------------------------------------+--------------------------------------------------------------------------------------------------------------------------------+------------
 admin_users               | observateur                                                                                                                    |                                                                                                                                | yes
 application_name_add_host | 0                                                                                                                              | 0                                                                                                                              | yes
 auth_file                 | /etc/pgbouncer/userlist.txt                                                                                                    |                                                                                                                                | yes
 auth_hba_file             |                                                                                                                                |                                                                                                                                | yes
 auth_query                | SELECT rolname, CASE WHEN rolvaliduntil < now() THEN NULL ELSE rolpassword END FROM pg_authid WHERE rolname=$1 AND rolcanlogin | SELECT rolname, CASE WHEN rolvaliduntil < now() THEN NULL ELSE rolpassword END FROM pg_authid WHERE rolname=$1 AND rolcanlogin | yes
 auth_type                 | scram-sha-256                                                                                                                  | md5                                                                                                                            | yes
 auth_user                 |                                                                                                                                |                                                                                                                                | yes
 autodb_idle_timeout       | 3600                                                                                                                           | 3600                                                                                                                           | yes
 client_idle_timeout       | 0                                                                                                                              | 0                                                                                                                              | yes
 client_login_timeout      | 60                                                                                                                             | 60                                                                                                                             | yes
 client_tls_ca_file        |                                                                                                                                |                                                                                                                                | yes
 client_tls_cert_file      |                                                                                                                                |                                                                                                                                | yes
 client_tls_ciphers        | fast                                                                                                                           | fast                                                                                                                           | yes
 client_tls_dheparams      | auto                                                                                                                           | auto                                                                                                                           | yes
 client_tls_ecdhcurve      | auto                                                                                                                           | auto                                                                                                                           | yes
 client_tls_key_file       |                                                                                                                                |                                                                                                                                | yes
 client_tls_protocols      | secure                                                                                                                         | secure                                                                                                                         | yes
 client_tls_sslmode        | disable                                                                                                                        | disable                                                                                                                        | yes
 conffile                  | /etc/pgbouncer/pgbouncer.ini                                                                                                   |                                                                                                                                | yes
 default_pool_size         | 5                                                                                                                              | 20                                                                                                                             | yes
 disable_pqexec            | 0                                                                                                                              | 0                                                                                                                              | no
 dns_max_ttl               | 15                                                                                                                             | 15                                                                                                                             | yes
 dns_nxdomain_ttl          | 15                                                                                                                             | 15                                                                                                                             | yes
 dns_zone_check_period     | 0                                                                                                                              | 0                                                                                                                              | yes
 idle_transaction_timeout  | 0                                                                                                                              | 0                                                                                                                              | yes
 ignore_startup_parameters |                                                                                                                                |                                                                                                                                | yes
 job_name                  | pgbouncer                                                                                                                      | pgbouncer                                                                                                                      | no
 listen_addr               | 0.0.0.0                                                                                                                        |                                                                                                                                | no
 listen_backlog            | 128                                                                                                                            | 128                                                                                                                            | no
 listen_port               | 6432                                                                                                                           | 6432                                                                                                                           | no
 log_connections           | 0                                                                                                                              | 1                                                                                                                              | yes
 log_disconnections        | 0                                                                                                                              | 1                                                                                                                              | yes
 log_pooler_errors         | 1                                                                                                                              | 1                                                                                                                              | yes
 log_stats                 | 1                                                                                                                              | 1                                                                                                                              | yes
 logfile                   |                                                                                                                                |                                                                                                                                | yes
 max_client_conn           | 200                                                                                                                            | 100                                                                                                                            | yes
 max_db_connections        | 0                                                                                                                              | 0                                                                                                                              | yes
 max_packet_size           | 2147483647                                                                                                                     | 2147483647                                                                                                                     | yes
 max_user_connections      | 0                                                                                                                              | 0                                                                                                                              | yes
 min_pool_size             | 0                                                                                                                              | 0                                                                                                                              | yes
 pidfile                   |                                                                                                                                |                                                                                                                                | no
 pkt_buf                   | 4096                                                                                                                           | 4096                                                                                                                           | no
 pool_mode                 | transaction                                                                                                                    | session                                                                                                                        | yes
 query_timeout             | 0                                                                                                                              | 0                                                                                                                              | yes
 query_wait_timeout        | 30                                                                                                                             | 120                                                                                                                            | yes
 reserve_pool_size         | 0                                                                                                                              | 0                                                                                                                              | yes
 reserve_pool_timeout      | 5                                                                                                                              | 5                                                                                                                              | yes
 resolv_conf               |                                                                                                                                |                                                                                                                                | no
 sbuf_loopcnt              | 5                                                                                                                              | 5                                                                                                                              | yes
 server_check_delay        | 30                                                                                                                             | 30                                                                                                                             | yes
 server_check_query        | select 1                                                                                                                       | select 1                                                                                                                       | yes
 server_connect_timeout    | 10                                                                                                                             | 15                                                                                                                             | yes
 server_fast_close         | 0                                                                                                                              | 0                                                                                                                              | yes
 server_idle_timeout       | 600                                                                                                                            | 600                                                                                                                            | yes
 server_lifetime           | 3600                                                                                                                           | 3600                                                                                                                           | yes
 server_login_retry        | 15                                                                                                                             | 15                                                                                                                             | yes
 server_reset_query        | DISCARD ALL                                                                                                                    | DISCARD ALL                                                                                                                    | yes
 server_reset_query_always | 0                                                                                                                              | 0                                                                                                                              | yes
 server_round_robin        | 0                                                                                                                              | 0                                                                                                                              | yes
 server_tls_ca_file        |                                                                                                                                |                                                                                                                                | yes
 server_tls_cert_file      |                                                                                                                                |                                                                                                                                | yes
 server_tls_ciphers        | fast                                                                                                                           | fast                                                                                                                           | yes
 server_tls_key_file       |                                                                                                                                |                                                                                                                                | yes
 server_tls_protocols      | secure                                                                                                                         | secure                                                                                                                         | yes
 server_tls_sslmode        | disable                                                                                                                        | disable                                                                                                                        | yes
 so_reuseport              | 0                                                                                                                              | 0                                                                                                                              | no
 stats_period              | 5                                                                                                                              | 60                                                                                                                             | yes
 stats_users               |                                                                                                                                |                                                                                                                                | yes
 suspend_timeout           | 10                                                                                                                             | 10                                                                                                                             | yes
 syslog                    | 0                                                                                                                              | 0                                                                                                                              | yes
 syslog_facility           | daemon                                                                                                                         | daemon                                                                                                                         | yes
 syslog_ident              | pgbouncer                                                                                                                      | pgbouncer                                                                                                                      | yes
 tcp_defer_accept          | 1                                                                                                                              | 1                                                                                                                              | yes
 tcp_keepalive             | 1                                                                                                                              | 1                                                                                                                              | yes
 tcp_keepcnt               | 0                                                                                                                              | 0                                                                                                                              | yes
 tcp_keepidle              | 0                                                                                                                              | 0                                                                                                                              | yes
 tcp_keepintvl             | 0                                                                                                                              | 0                                                                                                                              | yes
 tcp_socket_buffer         | 0                                                                                                                              | 0                                                                                                                              | yes
 tcp_user_timeout          | 0                                                                                                                              | 0                                                                                                                              | yes
 unix_socket_dir           | /tmp                                                                                                                           | /tmp                                                                                                                           | no
 unix_socket_group         |                                                                                                                                |                                                                                                                                | no
 unix_socket_mode          | 511                                                                                                                            | 0777                                                                                                                           | no
 user                      |                                                                                                                                |                                                                                                                                | no
 verbose                   | 0                                                                                                                              |                                                                                                                                | yes
(84 rows)


CONTAINER                         REPOSITORY                      TAG                 PLATFORM            IMAGE ID            SIZE                CREATED
shopflow-j4-pooling-bench-1       shopflow-j4-pooling-bench       latest              linux/arm64         39ffd5e5d5f4        156MB               3 minutes ago
shopflow-j4-pooling-db-1          shopflow-j4-pooling-db          latest              linux/arm64         32760fd2c2a7        156MB               3 minutes ago
shopflow-j4-pooling-pgbouncer-1   shopflow-j4-pooling-pgbouncer   latest              linux/arm64         2fbf1d79f5c6        49.4MB              3 minutes ago

```

#### pooling_40_persistant/synthese.csv

```csv
"essai","route","clients","secondes_demandees","mode","code_sortie","transactions","transactions_echouees","tps","latence_moyenne_ms","pic_connexions_echantillonne","nb_echantillons","duree_pilote_s"
"1_direct","direct","40","20","persistant","0","5120","0","256.493571","155.461","40","18","20.737"
"1_pool","pool","40","20","persistant","0","1908","0","94.695217","418.449","5","17","20.729"
"2_pool","pool","40","20","persistant","0","1908","0","94.551556","419.232","5","17","21.217"
"2_direct","direct","40","20","persistant","0","5120","0","255.366283","155.877","40","18","20.54"
"3_direct","direct","40","20","persistant","0","5120","0","257.705404","154.729","40","18","20.968"
"3_pool","pool","40","20","persistant","0","1912","0","94.615132","418.915","5","17","21.451"

```

#### pooling_80_saturation/1_direct_connexions.csv

```csv
"timestamp","total","active","idle","idle_in_transaction"
"2026-10-07T13:30:39.709Z","0","0","0","0"

```

#### pooling_80_saturation/1_direct_pgbench.txt

```text
pgbench (17.11 (Debian 17.11-1.pgdg12+2))

pgbench: error: connection to server at "db" (172.21.0.2), port 5432 failed: FATAL:  remaining connection slots are reserved for roles with the SUPERUSER attribute
pgbench: error: could not create connection for client 68

```

#### pooling_80_saturation/1_pool_connexions.csv

```csv
"timestamp","total","active","idle","idle_in_transaction"
"2026-10-07T13:30:49.364Z","4","0","4","0"
"2026-10-07T13:30:50.683Z","5","5","0","0"
"2026-10-07T13:30:51.990Z","5","5","0","0"
"2026-10-07T13:30:53.257Z","5","5","0","0"
"2026-10-07T13:30:54.499Z","5","5","0","0"
"2026-10-07T13:30:55.815Z","5","5","0","0"
"2026-10-07T13:30:57.078Z","5","5","0","0"
"2026-10-07T13:30:58.315Z","5","5","0","0"
"2026-10-07T13:30:59.596Z","5","5","0","0"
"2026-10-07T13:31:00.839Z","5","2","0","3"
"2026-10-07T13:31:02.112Z","5","5","0","0"
"2026-10-07T13:31:03.374Z","5","5","0","0"
"2026-10-07T13:31:04.625Z","5","5","0","0"
"2026-10-07T13:31:05.869Z","5","5","0","0"
"2026-10-07T13:31:07.117Z","5","4","0","1"
"2026-10-07T13:31:08.362Z","5","5","0","0"
"2026-10-07T13:31:09.595Z","5","5","0","0"

```

#### pooling_80_saturation/1_pool_observations.txt

```text

2026-10-07T13:30:49.364Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        24 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       4 |       0 |         0 |        0 |       0 |          0 | transaction
(2 rows)


2026-10-07T13:30:50.683Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        15 |         65 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |     688754 | transaction
(2 rows)


2026-10-07T13:30:51.990Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        15 |         65 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |     667716 | transaction
(2 rows)


2026-10-07T13:30:53.257Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        15 |         66 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |     641781 | transaction
(2 rows)


2026-10-07T13:30:54.499Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        15 |         65 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |     681748 | transaction
(2 rows)


2026-10-07T13:30:55.815Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        15 |         66 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |     689797 | transaction
(2 rows)


2026-10-07T13:30:57.078Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        15 |         65 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |     646699 | transaction
(2 rows)


2026-10-07T13:30:58.316Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        15 |         66 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |     667350 | transaction
(2 rows)


2026-10-07T13:30:59.596Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        15 |         65 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |     671832 | transaction
(2 rows)


2026-10-07T13:31:00.839Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        15 |         65 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |     669663 | transaction
(2 rows)


2026-10-07T13:31:02.113Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        14 |         66 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |     682628 | transaction
(2 rows)


2026-10-07T13:31:03.374Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        15 |         65 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |     668253 | transaction
(2 rows)


2026-10-07T13:31:04.625Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        15 |         65 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |     656318 | transaction
(2 rows)


2026-10-07T13:31:05.869Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        14 |         66 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |     691295 | transaction
(2 rows)


2026-10-07T13:31:07.118Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        15 |         66 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |     670033 | transaction
(2 rows)


2026-10-07T13:31:08.362Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        15 |         65 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |     679779 | transaction
(2 rows)


2026-10-07T13:31:09.595Z
 database  |   user    | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us |  pool_mode  
-----------+-----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-------------
 pgbouncer | pgbouncer |         1 |          0 |                    0 |                     0 |         0 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |          0 | statement
 pooling   | atelier   |        15 |         34 |                    0 |                     0 |         5 |                0 |                 0 |       0 |       0 |         0 |        0 |       0 |     679510 | transaction
(2 rows)


FIN
 database  | total_xact_count | total_query_count | total_received | total_sent | total_xact_time | total_query_time | total_wait_time | avg_xact_count | avg_query_count | avg_recv | avg_sent | avg_xact_time | avg_query_time | avg_wait_time 
-----------+------------------+-------------------+----------------+------------+-----------------+------------------+-----------------+----------------+-----------------+----------+----------+---------------+----------------+---------------
 pgbouncer |               18 |                18 |              0 |          0 |               0 |                0 |               0 |              0 |               0 |        0 |        0 |             0 |              0 |             0
 pooling   |             2056 |              8191 |         218758 |     341316 |      1419350269 |       1418199660 |      1310917499 |             80 |             340 |     9272 |    14483 |        811548 |         189586 |      59990788
(2 rows)


```

#### pooling_80_saturation/1_pool_pgbench.txt

```text
pgbench (17.11 (Debian 17.11-1.pgdg12+2))
transaction type: /lab/charge.sql
scaling factor: 1
query mode: simple
number of clients: 80
number of threads: 2
maximum number of tries: 1
duration: 20 s
number of transactions actually processed: 1917
number of failed transactions: 0 (0.000%)
latency average = 835.628 ms
latency stddev = 77.213 ms
initial connection time = 399.410 ms
tps = 93.827593 (without initial connection time)

progress: 5.0 s, 83.8 tps, lat 798.520 ms stddev 158.143, 0 failed
progress: 10.0 s, 94.0 tps, lat 849.488 ms stddev 12.428, 0 failed
progress: 15.0 s, 94.8 tps, lat 844.537 ms stddev 9.944, 0 failed
progress: 20.0 s, 94.6 tps, lat 842.510 ms stddev 9.199, 0 failed

```

#### pooling_80_saturation/configuration.txt

```text
{
  "clients": 80,
  "seconds": 20,
  "repeats": 1,
  "connect": false
}
PostgreSQL 17.11 (Debian 17.11-1.pgdg12+2) on aarch64-unknown-linux-gnu, compiled by gcc (Debian 12.2.0-14+deb12u1) 12.2.0, 64-bit
60
PgBouncer 1.18.0
libevent 2.1.12-stable
adns: c-ares 1.18.1
tls: OpenSSL 3.0.22 25 Aug 2026
systemd: yes
            key            |                                                             value                                                              |                                                            default                                                             | changeable 
---------------------------+--------------------------------------------------------------------------------------------------------------------------------+--------------------------------------------------------------------------------------------------------------------------------+------------
 admin_users               | observateur                                                                                                                    |                                                                                                                                | yes
 application_name_add_host | 0                                                                                                                              | 0                                                                                                                              | yes
 auth_file                 | /etc/pgbouncer/userlist.txt                                                                                                    |                                                                                                                                | yes
 auth_hba_file             |                                                                                                                                |                                                                                                                                | yes
 auth_query                | SELECT rolname, CASE WHEN rolvaliduntil < now() THEN NULL ELSE rolpassword END FROM pg_authid WHERE rolname=$1 AND rolcanlogin | SELECT rolname, CASE WHEN rolvaliduntil < now() THEN NULL ELSE rolpassword END FROM pg_authid WHERE rolname=$1 AND rolcanlogin | yes
 auth_type                 | scram-sha-256                                                                                                                  | md5                                                                                                                            | yes
 auth_user                 |                                                                                                                                |                                                                                                                                | yes
 autodb_idle_timeout       | 3600                                                                                                                           | 3600                                                                                                                           | yes
 client_idle_timeout       | 0                                                                                                                              | 0                                                                                                                              | yes
 client_login_timeout      | 60                                                                                                                             | 60                                                                                                                             | yes
 client_tls_ca_file        |                                                                                                                                |                                                                                                                                | yes
 client_tls_cert_file      |                                                                                                                                |                                                                                                                                | yes
 client_tls_ciphers        | fast                                                                                                                           | fast                                                                                                                           | yes
 client_tls_dheparams      | auto                                                                                                                           | auto                                                                                                                           | yes
 client_tls_ecdhcurve      | auto                                                                                                                           | auto                                                                                                                           | yes
 client_tls_key_file       |                                                                                                                                |                                                                                                                                | yes
 client_tls_protocols      | secure                                                                                                                         | secure                                                                                                                         | yes
 client_tls_sslmode        | disable                                                                                                                        | disable                                                                                                                        | yes
 conffile                  | /etc/pgbouncer/pgbouncer.ini                                                                                                   |                                                                                                                                | yes
 default_pool_size         | 5                                                                                                                              | 20                                                                                                                             | yes
 disable_pqexec            | 0                                                                                                                              | 0                                                                                                                              | no
 dns_max_ttl               | 15                                                                                                                             | 15                                                                                                                             | yes
 dns_nxdomain_ttl          | 15                                                                                                                             | 15                                                                                                                             | yes
 dns_zone_check_period     | 0                                                                                                                              | 0                                                                                                                              | yes
 idle_transaction_timeout  | 0                                                                                                                              | 0                                                                                                                              | yes
 ignore_startup_parameters |                                                                                                                                |                                                                                                                                | yes
 job_name                  | pgbouncer                                                                                                                      | pgbouncer                                                                                                                      | no
 listen_addr               | 0.0.0.0                                                                                                                        |                                                                                                                                | no
 listen_backlog            | 128                                                                                                                            | 128                                                                                                                            | no
 listen_port               | 6432                                                                                                                           | 6432                                                                                                                           | no
 log_connections           | 0                                                                                                                              | 1                                                                                                                              | yes
 log_disconnections        | 0                                                                                                                              | 1                                                                                                                              | yes
 log_pooler_errors         | 1                                                                                                                              | 1                                                                                                                              | yes
 log_stats                 | 1                                                                                                                              | 1                                                                                                                              | yes
 logfile                   |                                                                                                                                |                                                                                                                                | yes
 max_client_conn           | 200                                                                                                                            | 100                                                                                                                            | yes
 max_db_connections        | 0                                                                                                                              | 0                                                                                                                              | yes
 max_packet_size           | 2147483647                                                                                                                     | 2147483647                                                                                                                     | yes
 max_user_connections      | 0                                                                                                                              | 0                                                                                                                              | yes
 min_pool_size             | 0                                                                                                                              | 0                                                                                                                              | yes
 pidfile                   |                                                                                                                                |                                                                                                                                | no
 pkt_buf                   | 4096                                                                                                                           | 4096                                                                                                                           | no
 pool_mode                 | transaction                                                                                                                    | session                                                                                                                        | yes
 query_timeout             | 0                                                                                                                              | 0                                                                                                                              | yes
 query_wait_timeout        | 30                                                                                                                             | 120                                                                                                                            | yes
 reserve_pool_size         | 0                                                                                                                              | 0                                                                                                                              | yes
 reserve_pool_timeout      | 5                                                                                                                              | 5                                                                                                                              | yes
 resolv_conf               |                                                                                                                                |                                                                                                                                | no
 sbuf_loopcnt              | 5                                                                                                                              | 5                                                                                                                              | yes
 server_check_delay        | 30                                                                                                                             | 30                                                                                                                             | yes
 server_check_query        | select 1                                                                                                                       | select 1                                                                                                                       | yes
 server_connect_timeout    | 10                                                                                                                             | 15                                                                                                                             | yes
 server_fast_close         | 0                                                                                                                              | 0                                                                                                                              | yes
 server_idle_timeout       | 600                                                                                                                            | 600                                                                                                                            | yes
 server_lifetime           | 3600                                                                                                                           | 3600                                                                                                                           | yes
 server_login_retry        | 15                                                                                                                             | 15                                                                                                                             | yes
 server_reset_query        | DISCARD ALL                                                                                                                    | DISCARD ALL                                                                                                                    | yes
 server_reset_query_always | 0                                                                                                                              | 0                                                                                                                              | yes
 server_round_robin        | 0                                                                                                                              | 0                                                                                                                              | yes
 server_tls_ca_file        |                                                                                                                                |                                                                                                                                | yes
 server_tls_cert_file      |                                                                                                                                |                                                                                                                                | yes
 server_tls_ciphers        | fast                                                                                                                           | fast                                                                                                                           | yes
 server_tls_key_file       |                                                                                                                                |                                                                                                                                | yes
 server_tls_protocols      | secure                                                                                                                         | secure                                                                                                                         | yes
 server_tls_sslmode        | disable                                                                                                                        | disable                                                                                                                        | yes
 so_reuseport              | 0                                                                                                                              | 0                                                                                                                              | no
 stats_period              | 5                                                                                                                              | 60                                                                                                                             | yes
 stats_users               |                                                                                                                                |                                                                                                                                | yes
 suspend_timeout           | 10                                                                                                                             | 10                                                                                                                             | yes
 syslog                    | 0                                                                                                                              | 0                                                                                                                              | yes
 syslog_facility           | daemon                                                                                                                         | daemon                                                                                                                         | yes
 syslog_ident              | pgbouncer                                                                                                                      | pgbouncer                                                                                                                      | yes
 tcp_defer_accept          | 1                                                                                                                              | 1                                                                                                                              | yes
 tcp_keepalive             | 1                                                                                                                              | 1                                                                                                                              | yes
 tcp_keepcnt               | 0                                                                                                                              | 0                                                                                                                              | yes
 tcp_keepidle              | 0                                                                                                                              | 0                                                                                                                              | yes
 tcp_keepintvl             | 0                                                                                                                              | 0                                                                                                                              | yes
 tcp_socket_buffer         | 0                                                                                                                              | 0                                                                                                                              | yes
 tcp_user_timeout          | 0                                                                                                                              | 0                                                                                                                              | yes
 unix_socket_dir           | /tmp                                                                                                                           | /tmp                                                                                                                           | no
 unix_socket_group         |                                                                                                                                |                                                                                                                                | no
 unix_socket_mode          | 511                                                                                                                            | 0777                                                                                                                           | no
 user                      |                                                                                                                                |                                                                                                                                | no
 verbose                   | 0                                                                                                                              |                                                                                                                                | yes
(84 rows)


CONTAINER                         REPOSITORY                      TAG                 PLATFORM            IMAGE ID            SIZE                CREATED
shopflow-j4-pooling-bench-1       shopflow-j4-pooling-bench       latest              linux/arm64         39ffd5e5d5f4        156MB               13 minutes ago
shopflow-j4-pooling-db-1          shopflow-j4-pooling-db          latest              linux/arm64         32760fd2c2a7        156MB               13 minutes ago
shopflow-j4-pooling-pgbouncer-1   shopflow-j4-pooling-pgbouncer   latest              linux/arm64         2fbf1d79f5c6        49.4MB              13 minutes ago

```

#### pooling_80_saturation/synthese.csv

```csv
"essai","route","clients","secondes_demandees","mode","code_sortie","transactions","transactions_echouees","tps","latence_moyenne_ms","pic_connexions_echantillonne","nb_echantillons","duree_pilote_s"
"1_direct","direct","80","20","persistant","1","","","","","0","1","1.152"
"1_pool","pool","80","20","persistant","0","1917","0","93.827593","835.628","5","17","21.501"

```

#### 07_dates_identiques.sql

```sql
-- Atelier 7 : trois commandes du client 42 avec une date commune.
-- Base ShopFlow de laboratoire uniquement. Sauvegarde avant modification.
BEGIN;
DO $atelier$
BEGIN
  IF (SELECT count(*) FROM shopflow.commandes
      WHERE client_id=42 AND id IN (42,1042,2042)) <> 3 THEN
    RAISE EXCEPTION 'Jeu attendu absent : charger le jeu initial ShopFlow.';
  END IF;
END;
$atelier$;
CREATE TABLE IF NOT EXISTS shopflow.sauvegarde_dates_atelier07 (
  id bigint PRIMARY KEY,
  created_at timestamptz NOT NULL
);
INSERT INTO shopflow.sauvegarde_dates_atelier07 (id,created_at)
SELECT id,created_at FROM shopflow.commandes
WHERE client_id=42 AND id IN (42,1042,2042)
ON CONFLICT (id) DO NOTHING;
DO $atelier$
DECLARE date_commune timestamptz;
BEGIN
  -- Exclure les trois cibles rend le scénario répétable sur un jeu stable.
  SELECT COALESCE(max(created_at),TIMESTAMPTZ '2026-01-01 00:00+00')
         + INTERVAL '1 day'
  INTO date_commune
  FROM shopflow.commandes WHERE client_id=42 AND id NOT IN (42,1042,2042);
  UPDATE shopflow.commandes SET created_at=date_commune
  WHERE client_id=42 AND id IN (42,1042,2042);
END;
$atelier$;
COMMIT;
SELECT id,created_at FROM shopflow.commandes WHERE client_id=42
ORDER BY created_at DESC,id DESC LIMIT 3;
-- Attendu, dans cet ordre : 2042, 1042, 42, avec la même date.

```

#### 07_restaurer_dates.sql

```sql
-- Atelier 7 : restituer uniquement les trois dates sauvegardées.
-- Exécuter après 07_dates_identiques.sql, dans la même base de laboratoire.
BEGIN;
DO $atelier$
DECLARE nb integer;
BEGIN
  SELECT count(*) INTO nb FROM shopflow.sauvegarde_dates_atelier07
  WHERE id IN (42,1042,2042);
  IF nb NOT IN (0,3) THEN
    RAISE EXCEPTION 'Sauvegarde incomplète : restauration interrompue.';
  END IF;
  IF nb=3 AND (SELECT count(*) FROM shopflow.commandes
      WHERE client_id=42 AND id IN (42,1042,2042)) <> 3 THEN
    RAISE EXCEPTION 'Les trois commandes à restaurer sont absentes.';
  END IF;
  IF nb=0 THEN RAISE NOTICE 'Aucune date en attente de restauration.'; END IF;
END;
$atelier$;
WITH restauration AS (
  UPDATE shopflow.commandes c SET created_at=s.created_at
  FROM shopflow.sauvegarde_dates_atelier07 s
  WHERE c.id=s.id AND c.client_id=42 AND c.id IN (42,1042,2042)
  RETURNING c.id
)
SELECT count(*) AS dates_restaurees FROM restauration;
DELETE FROM shopflow.sauvegarde_dates_atelier07 WHERE id IN (42,1042,2042);
COMMIT;
SELECT id,created_at FROM shopflow.commandes WHERE id IN (42,1042,2042)
ORDER BY id;
-- Attendu au premier passage : dates_restaurees = 3.

```
