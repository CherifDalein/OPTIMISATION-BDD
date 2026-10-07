# Atelier 4 — Index spécialisés

## 1. Index partiel : solution et tests du prédicat

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

## 2. GIN : solution et tests des opérateurs

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

## 3. GiST : créer et vérifier les chevauchements

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

## 4. Tailles vérifiées et décision

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

**Preuves :** voir l’annexe A4 du présent document.

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
