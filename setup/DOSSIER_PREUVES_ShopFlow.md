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
