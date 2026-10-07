# Atelier 1 — Diagnostic initial de ShopFlow

Date : 5 octobre 2026

## 1. Contexte et version

Base de laboratoire : `shopflow`, schéma `shopflow`. Consultation depuis pgAdmin dans l’environnement Docker décrit dans `PREPARATION.md`. Le diagnostic doit être réalisé sans ajouter d’index. Version communiquée, obtenue avec `SELECT version();` :

```text
PostgreSQL 18.6 (Debian 18.6-1.pgdg13+2) on aarch64-unknown-linux-gnu, compiled by gcc (Debian 14.2.0-19) 14.2.0, 64-bit
```

Contrôle du chargement des données :

```sql
SELECT
  (SELECT count(*) FROM shopflow.clients) AS clients,
  (SELECT count(*) FROM shopflow.produits) AS produits,
  (SELECT count(*) FROM shopflow.commandes) AS commandes,
  (SELECT count(*) FROM shopflow.lignes) AS lignes;
```

| Table | Effectif attendu selon le script | Effectif observé |
|---|---:|---|
| clients | 1 000 | 1 000 |
| produits | 200 | 200 |
| commandes | 100 000 | 100 000 |
| lignes | 300 000 | 300 000 |

Les effectifs observés correspondent aux effectifs attendus du jeu de données initial.

## 2. Requêtes et résultats fonctionnels

Les deux requêtes suivantes sont proposées pour répondre à la consigne de l’atelier ; aucun script de diagnostic dédié n’a été trouvé dans le dossier fourni.

### Requête 1 — Historique du client 42

```sql
SELECT id, created_at, statut, total
FROM shopflow.commandes
WHERE client_id = 42
ORDER BY created_at DESC, id DESC;
```

Contrôle fonctionnel :

```sql
SELECT count(*) AS nombre_commandes,
       sum(total) AS montant_total
FROM shopflow.commandes
WHERE client_id = 42;
```

Nombre de commandes observé par le contrôle fonctionnel : **100**, conforme à l’effectif attendu selon les données initiales. Montant total observé : **47 760,00**.

### Requête 2 — Agrégation des commandes par statut

```sql
SELECT statut,
       count(*) AS nombre_commandes,
       sum(total) AS montant_total
FROM shopflow.commandes
GROUP BY statut
ORDER BY statut;
```

| Statut | Nombre attendu | Nombre observé | Montant total observé |
|---|---:|---|---|
| annulee | 10 000 | 10 000 | 3 049 912,50 |
| en_attente | 10 000 | 10 000 | 2 974 962,50 |
| payee | 80 000 | 80 000 | 23 750 126,25 |

Nombre de lignes retournées : **3**, conforme au résultat attendu. Les effectifs par statut sont conformes et représentent au total **100 000 commandes**. Somme des trois montants communiqués : **29 775 001,25**. Contrôle du montant global :

```sql
SELECT sum(total) AS montant_global
FROM shopflow.commandes;
```

Montant global observé : **29 775 001,25**. Il est égal à la somme des trois montants par statut : **contrôle validé**.

## 3. Mesures après échauffement

Protocole suivi : chaque requête a été exécutée avec `EXPLAIN (ANALYZE, BUFFERS)` une fois pour l’échauffement, puis cinq fois pour les mesures. Les valeurs `Execution Time` ont été relevées en millisecondes et les plans complets conservés en annexe. L’échauffement est exclu des cinq mesures.

| Requête | Mesure 1 (ms) | Mesure 2 (ms) | Mesure 3 (ms) | Mesure 4 (ms) | Mesure 5 (ms) |
|---|---|---|---|---|---|
| Historique du client 42 | 0,827 | 1,737 | 2,474 | 1,829 | 1,607 |
| Agrégation par statut | 42,761 | 41,124 | 61,019 | 48,577 | 54,799 |

| Requête | Moyenne (ms) | Médiane (ms) | Minimum (ms) | Maximum (ms) |
|---|---:|---:|---:|---:|
| Historique du client 42 | 1,695 | 1,737 | 0,827 | 2,474 |
| Agrégation par statut | 49,656 | 48,577 | 41,124 | 61,019 |

Échauffement de la requête 1 effectué : `Execution Time = 1.466 ms`, exclu des cinq mesures. Le plan indique `shared hit=90` au nœud racine, sans lecture `shared read` rapportée. Échauffement de la requête 2 effectué : `Execution Time = 54.149 ms`, également exclu des cinq mesures ; le plan indique `shared hit=1674` au nœud racine.

## 4. Nœud coûteux et hypothèse

Le nœud coûteux retenu est **`HashAggregate` de la requête 2**, alimenté par un `Seq Scan` de toutes les commandes. À la cinquième mesure, il termine à **54,463 ms**, contre **18,073 ms** pour son enfant, avec une seule boucle. La différence d’environ **36,390 ms** estime le temps propre à l’agrégation, sous réserve de l’instrumentation. Les temps des parents incluent ceux des enfants : ils ne doivent pas être additionnés.

**Hypothèse expliquant le coût :** l’agrégation traite les **100 000 commandes** pour déterminer le groupe de chaque ligne, incrémenter le compteur et additionner les montants de type `numeric`. Les trois groupes nécessitent peu de mémoire, mais toutes les lignes restent à traiter. Les cinq plans rapportent **1 674 accès aux blocs en cache** (`shared hit=1674`), sans `shared read` rapporté. L’agrégation tient en mémoire (**32 kB**, `Batches: 1`) et le tri final de trois lignes utilise **25 kB**. Aucun débordement sur disque n’est rapporté. Ces observations sont compatibles avec un coût de calcul et de parcours en mémoire. Les estimations de lignes correspondent aux observations : 100 000 pour le parcours et 3 pour l’agrégation. Pour la requête 1, l’index initial créé par `UNIQUE (client_id, cle_idempotence)` permet de retrouver 100 commandes sans parcourir toute la table. Le `Bitmap Heap Scan` et son enfant constituent la principale partie du temps avant le tri. Les lignes sont réparties sur **88 blocs de table distincts** ; cette dispersion explique le travail de récupération malgré le faible nombre de résultats. Les plans indiquent **90 accès aux blocs en cache**, dont 2 pour l’index, et un tri en mémoire de **29 kB**. Les structures de plans et les buffers restent stables malgré la variation des durées. Une variation de charge ou d’ordonnancement de l’environnement est une hypothèse possible, non vérifiée par ces seuls plans. Les résultats constituent une référence initiale sur cet environnement et ce jeu de données, sans ajout d’index lors de cet atelier.

## Annexe — Plans complets et informations BUFFERS

### Commande de mesure de la requête 1

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, created_at, statut, total
FROM shopflow.commandes
WHERE client_id = 42
ORDER BY created_at DESC, id DESC;
```

#### Échauffement — requête 1

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

L’index `commandes_client_id_cle_idempotence_key` provient de la contrainte `UNIQUE (client_id, cle_idempotence)` du schéma initial. Son utilisation ne suppose pas l’ajout d’un index supplémentaire. Le plan retourne bien 100 lignes. Le parcours de la table utilise 88 blocs distincts.

#### Mesure 1 — requête 1

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

#### Mesure 2 — requête 1

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

#### Mesure 3 — requête 1

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

#### Mesure 4 — requête 1

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

#### Mesure 5 — requête 1

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

Synthèse des cinq mesures de la requête 1 : moyenne **1,695 ms**, médiane **1,737 ms**, minimum **0,827 ms**, maximum **2,474 ms**. Les cinq plans conservent la même structure, retournent 100 lignes et indiquent `shared hit=90` au nœud racine (dont 2 accès aux blocs de l’index), avec 88 blocs de table distincts et un tri en mémoire de 29 kB. Les compteurs des nœuds parents incluent ceux de leurs enfants et ne doivent pas être additionnés. La variation des temps ne s’accompagne d’aucun changement de plan ni de lectures `shared read` rapportées ; sa cause ne peut pas être établie à partir de ces seuls plans.

### Commande de mesure de la requête 2

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT statut,
       count(*) AS nombre_commandes,
       sum(total) AS montant_total
FROM shopflow.commandes
GROUP BY statut
ORDER BY statut;
```

#### Échauffement — requête 2

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

Le parcours séquentiel traite 100 000 lignes et l’agrégation produit 3 groupes. L’agrégation tient en mémoire (32 kB, une seule partition rapportée par `Batches: 1`) et le tri utilise 25 kB. Aucun accès `shared read` ni débordement sur disque n’est rapporté.

#### Mesure 1 — requête 2

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

#### Mesure 2 — requête 2

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

#### Mesure 3 — requête 2

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

#### Mesure 4 — requête 2

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

#### Mesure 5 — requête 2

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

État du rapport : **finalisé**. Les contrôles fonctionnels, les cinq mesures de chaque requête, les deux plans d’échauffement et les dix plans de mesure ont été conservés.
