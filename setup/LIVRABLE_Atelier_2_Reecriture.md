# Atelier 2 — Une réécriture équivalente

## Contexte

Base `shopflow`, schéma `shopflow`, consultation depuis pgAdmin. Version communiquée à l’atelier 1 : PostgreSQL 18.6 (Debian), architecture aarch64, 64 bits. Données contrôlées à l’atelier 1 : 1 000 clients, 200 produits, 100 000 commandes et 300 000 lignes. Objectifs : comparer une jointure qui duplique les clients avec une version `EXISTS`, puis calculer un total par commande sans multiplier `commandes.total`. Le résultat pertinent pour la première comparaison est une ligne par client ayant au moins une commande. La jointure brute et `EXISTS` ne sont pas équivalents en multiplicité ; la comparaison équivalente portera sur `JOIN` avec `DISTINCT` et `EXISTS`.

## 1. Clients ayant plusieurs commandes

Client retenu : **42**. Contrôle à exécuter :

```sql
SELECT c.id, c.nom, count(*) AS nombre_commandes
FROM shopflow.clients c
JOIN shopflow.commandes o ON o.client_id = c.id
WHERE c.id = 42
GROUP BY c.id, c.nom;
```

Résultat observé : client **42**, nom **Client 42**, **100 commandes**. Ce client satisfait le cas demandé d’un client ayant plusieurs commandes. Contrôle de la duplication par la jointure brute :

```sql
SELECT count(*) AS lignes_retournees,
       count(DISTINCT c.id) AS clients_distincts
FROM shopflow.clients c
JOIN shopflow.commandes o ON o.client_id = c.id
WHERE c.id = 42;
```

Résultat observé : **100 lignes retournées**, pour **1 client distinct**. La jointure produit une occurrence du client par commande correspondante. Version `EXISTS` testée sur le client 42 :

```sql
SELECT c.id, c.nom
FROM shopflow.clients c
WHERE c.id = 42
  AND EXISTS (
    SELECT 1
    FROM shopflow.commandes o
    WHERE o.client_id = c.id
  );
```

Résultat communiqué : **une ligne**, `42, Client 42`. Le client apparaît une fois, contre 100 occurrences dans la jointure brute. Les deux variantes identifient le même client mais n’ont pas la même multiplicité. Pour le résultat pertinent « une ligne par client ayant une commande », la comparaison équivalente doit porter sur `JOIN DISTINCT` et `EXISTS`. Jointure dédupliquée testée sur le même périmètre :

```sql
SELECT DISTINCT c.id, c.nom
FROM shopflow.clients c
JOIN shopflow.commandes o ON o.client_id = c.id
WHERE c.id = 42;
```

Résultat communiqué : **une ligne**, `42, Client 42`, identique à la version `EXISTS`. L’équivalence du contenu et de la multiplicité est vérifiée sur le client 42. Plus généralement, pour ces colonnes du client, `JOIN DISTINCT` et `EXISTS` expriment la même condition : le client possède au moins une commande. La comparaison de performance sera réalisée sur le même périmètre `c.id = 42` pour les deux variantes.

## 2. Total par commande

Commande retenue : **42**. Contrôle exécuté :

```sql
SELECT o.id,
       o.total AS total_commande,
       count(l.produit_id) AS nombre_lignes,
       sum(l.qte * l.prix_unitaire) AS total_calcule
FROM shopflow.commandes o
JOIN shopflow.lignes l ON l.commande_id = o.id
WHERE o.id = 42
GROUP BY o.id, o.total;
```

Résultat observé : commande **42**, total enregistré **240,00**, **3 lignes**, total calculé **240,00**. Le total des lignes correspond au total enregistré. Ce contrôle porte sur la commande 42 ; le numéro de commande n’implique pas qu’elle appartienne au client 42.

### Version incorrecte — multiplication du total enregistré

```sql
SELECT o.id,
       sum(o.total) AS total_incorrect
FROM shopflow.commandes o
JOIN shopflow.lignes l ON l.commande_id = o.id
WHERE o.id = 42
GROUP BY o.id;
```

Résultat observé : **42, 720,00**, soit trois fois le total enregistré de **240,00**. Chaque ligne de la commande répète `o.total` dans la jointure ; `SUM(o.total)` additionne donc trois occurrences du même montant. Cette version est fonctionnellement incorrecte et ne sera pas considérée comme une variante équivalente dans la comparaison des performances.

### Version corrigée — préagrégation des lignes

```sql
SELECT o.id,
       o.total AS total_commande,
       t.total_calcule
FROM shopflow.commandes o
LEFT JOIN (
  SELECT commande_id,
         sum(qte * prix_unitaire) AS total_calcule
  FROM shopflow.lignes
  GROUP BY commande_id
) t ON t.commande_id = o.id
WHERE o.id = 42;
```

Résultat observé : **42, 240,00, 240,00**. Le montant calculé correspond au total enregistré. La sous-requête produit au plus une ligne par commande, ce qui évite de répéter le montant enregistré. Le `LEFT JOIN` conserve les commandes sans ligne ; leur total calculé reste `NULL`.

### Variante correcte — agrégation après jointure

```sql
SELECT o.id,
       o.total AS total_commande,
       sum(l.qte * l.prix_unitaire) AS total_calcule
FROM shopflow.commandes o
LEFT JOIN shopflow.lignes l ON l.commande_id = o.id
WHERE o.id = 42
GROUP BY o.id, o.total;
```

Résultat observé : **42, 240,00, 240,00**, identique à la préagrégation. Le contenu et la multiplicité sont vérifiés sur la commande 42. Les deux écritures conservent le total enregistré sans le sommer, calculent la somme des montants des lignes et conservent les commandes sans ligne avec un total calculé `NULL`. La clé primaire de `commandes` garantit une seule commande par identifiant. La comparaison des performances portera sur le même filtre `o.id = 42`.

## 3. Plans et mesures

Protocole : preuve du contenu avant les mesures, puis une exécution d’échauffement et cinq mesures `EXPLAIN (ANALYZE, BUFFERS)` par variante équivalente. Conserver les SQL et les plans complets. Ne pas conclure à un gain si une variante perd des lignes ; expliquer des plans identiques le cas échéant. Le protocole est porté à cinq mesures par variante pour respecter le modèle. Les répétitions 4 et 5 sont recueillies dans une seconde série après les trois premières ; la continuité de session et la charge concurrente ne sont pas documentées. Les statistiques finales portent sur les cinq observations de chaque variante.

### Comparaison des clients — périmètre client 42

| Variante | Échauffement (ms, exclu) | Mesure 1 | Mesure 2 | Mesure 3 | Mesure 4 | Mesure 5 |
|---|---:|---|---|---|---|---|
| JOIN DISTINCT | 0,616 | 0,455 | 0,245 | 0,295 | 0,862 | 0,366 |
| EXISTS | 0,479 | 0,219 | 0,384 | 0,296 | 0,498 | 0,459 |

#### SQL et plan complet — échauffement JOIN DISTINCT

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT DISTINCT c.id, c.nom
FROM shopflow.clients c
JOIN shopflow.commandes o ON o.client_id = c.id
WHERE c.id = 42;
```

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

Observation initiale : la jointure produit 100 lignes avant que `HashAggregate` ne les déduplique en une ligne. Le parcours des commandes utilise l’index initial, avec `Heap Fetches: 0`. Le nœud racine rapporte 6 accès aux blocs en cache ; l’agrégation utilise 32 kB en mémoire. Les temps et buffers des parents incluent ceux des enfants et ne doivent pas être additionnés.

#### Mesure 1 — JOIN DISTINCT

SQL : identique au bloc `EXPLAIN (ANALYZE, BUFFERS)` de l’échauffement JOIN DISTINCT ci-dessus.

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

#### Mesure 2 — JOIN DISTINCT

SQL : identique au bloc de l’échauffement JOIN DISTINCT ci-dessus.

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

#### Mesure 3 — JOIN DISTINCT

SQL : identique au bloc de l’échauffement JOIN DISTINCT ci-dessus.

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



#### SQL et plan complet — échauffement EXISTS

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT c.id, c.nom
FROM shopflow.clients c
WHERE c.id = 42
  AND EXISTS (
    SELECT 1
    FROM shopflow.commandes o
    WHERE o.client_id = c.id
  );
```

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

Observation initiale : `EXISTS` est exécuté par une `Nested Loop Semi Join`. Le parcours de l’index des commandes retourne une seule ligne avant arrêt, contre 100 dans JOIN DISTINCT ; le nœud de déduplication `HashAggregate` disparaît. Les plans diffèrent donc sur ce périmètre. Les accès aux blocs en cache restent à 6 et `Heap Fetches` à 0. Le gain de temps éventuel sera évalué sur les cinq mesures, hors échauffement.

#### Mesure 1 — EXISTS

SQL : identique au bloc de l’échauffement EXISTS ci-dessus.

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

#### Mesure 2 — EXISTS

SQL : identique au bloc de l’échauffement EXISTS ci-dessus.

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

#### Mesure 3 — EXISTS

SQL : identique au bloc de l’échauffement EXISTS ci-dessus.

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





### Comparaison des totaux — périmètre commande 42

| Variante | Échauffement (ms, exclu) | Mesure 1 | Mesure 2 | Mesure 3 | Mesure 4 | Mesure 5 |
|---|---:|---|---|---|---|---|
| Agrégation après jointure | 1,354 | 0,849 | 0,448 | 0,609 | 0,460 | 1,296 |
| Préagrégation avant jointure | 1,563 | 0,575 | 0,437 | 0,577 | 0,293 | 1,228 |

#### Échauffement — agrégation après jointure

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT o.id,
       o.total AS total_commande,
       sum(l.qte * l.prix_unitaire) AS total_calcule
FROM shopflow.commandes o
LEFT JOIN shopflow.lignes l ON l.commande_id = o.id
WHERE o.id = 42
GROUP BY o.id, o.total;
```

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

Le plan utilise les index des clés primaires pour récupérer une commande et trois lignes. La jointure externe produit trois lignes et `GroupAggregate` les réduit à un résultat. Le nœud racine rapporte 10 accès aux blocs en cache, dont 4 pour le parcours de la commande et 6 pour celui des lignes.

#### Mesure 1 — agrégation après jointure

SQL : identique au bloc de l’échauffement de l’agrégation après jointure ci-dessus.

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

#### Mesure 2 — agrégation après jointure

SQL : identique au bloc de l’échauffement de l’agrégation après jointure ci-dessus.

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

#### Mesure 3 — agrégation après jointure

SQL : identique au bloc de l’échauffement de l’agrégation après jointure ci-dessus.

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



#### SQL et plan complet — échauffement de la préagrégation

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT o.id,
       o.total AS total_commande,
       t.total_calcule
FROM shopflow.commandes o
LEFT JOIN (
  SELECT commande_id,
         sum(qte * prix_unitaire) AS total_calcule
  FROM shopflow.lignes
  GROUP BY commande_id
) t ON t.commande_id = o.id
WHERE o.id = 42;
```

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

Observation initiale : le filtre sur la commande est propagé vers le parcours des lignes (`Index Cond: commande_id = 42`). La sous-requête agrège donc seulement trois lignes, puis la jointure reçoit une ligne agrégée. Les deux variantes utilisent les mêmes index et rapportent 10 accès aux blocs en cache, mais leurs plans ne sont pas identiques : `GroupAggregate` est placé avant la jointure dans la préagrégation, et après dans l’autre variante. La préagrégation ne calcule pas ici les totaux de toutes les commandes.

#### Mesure 1 — préagrégation

SQL : identique au bloc de l’échauffement de la préagrégation ci-dessus.

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

#### Mesure 2 — préagrégation

SQL : identique au bloc de l’échauffement de la préagrégation ci-dessus.

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

#### Mesure 3 — préagrégation

SQL : identique au bloc de l’échauffement de la préagrégation ci-dessus.

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



## 4. Interprétation

| Variante | Moyenne ms | p50 ms | p95 empirique ms | Min–max ms | Écart-type ms |
|---|---:|---:|---:|---|---:|
| JOIN DISTINCT | 0,445 | 0,366 | 0,862 | 0,245–0,862 | 0,220 |
| EXISTS | 0,371 | 0,384 | 0,498 | 0,219–0,498 | 0,103 |
| Agrégation après jointure | 0,732 | 0,609 | 1,296 | 0,448–1,296 | 0,317 |
| Préagrégation avant jointure | 0,622 | 0,575 | 1,228 | 0,293–1,228 | 0,321 |

Statistiques calculées sur cinq mesures, hors échauffement. p50 est la médiane ; p95 utilise le rang ceil(0,95 × 5), donc le maximum observé. Sur un si petit échantillon, il ne représente pas une estimation fiable de la latence en queue.

**Clients :** JOIN DISTINCT et EXISTS retournent une ligne identique pour le client 42. EXISTS remplace la jointure suivie de déduplication par une semi-jointure s’arrêtant à la première commande. La moyenne diminue d’environ **16,5 %**, mais la médiane augmente d’environ **4,9 %**. Le gain de temps n’est donc pas uniforme ; la réduction des lignes intermédiaires est démontrée. Les deux plans rapportent 6 accès aux blocs en cache.

**Totaux :** la version SUM(commandes.total) est rejetée : 720,00 au lieu de 240,00. Les deux écritures correctes retournent la même ligne 42, 240,00, 240,00. La préagrégation déplace GroupAggregate avant la jointure ; le filtre est propagé à commande_id = 42, limitant le calcul aux trois lignes concernées. Les plans diffèrent mais utilisent les mêmes index et 10 accès aux blocs en cache. La moyenne de la préagrégation diminue d’environ **15,1 %** et sa médiane de **5,6 %**. Les durées sont variables et les deux variantes présentent une cinquième mesure supérieure à une milliseconde. Sur une seule commande et cinq répétitions, cela ne démontre pas un avantage généralisable. Les deux écritures correctes restent acceptables. L’équivalence expérimentale porte sur le client 42 et la commande 42, sans comparaison exhaustive de la base. Aucun code API ni index ajouté. Les mesures 4 et 5 ont été recueillies dans une seconde série après les trois premières. La continuité de session, la charge concurrente et les ressources Docker ne sont pas documentées. Les valeurs sont celles de Execution Time, hors Planning Time. État : **finalisé sur cinq mesures par variante**. Quatre échauffements et vingt plans de mesure sont conservés, avec SQL, contrôles du contenu et interprétation. CSV, métadonnées et graphique figurent dans le dossier `preuves` ; le dossier principal suit `MODELE_DOSSIER.txt`.

## Complément de collecte — cinq répétitions

### Mesure 4 — JOIN DISTINCT

SQL : identique au bloc de l’échauffement JOIN DISTINCT.

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

### Mesure 5 — JOIN DISTINCT

SQL : identique au bloc de l’échauffement JOIN DISTINCT.

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



### Mesure 4 — EXISTS

SQL : identique au bloc de l’échauffement EXISTS.

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

### Mesure 5 — EXISTS

SQL : identique au bloc de l’échauffement EXISTS.

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



### Mesure 4 — agrégation après jointure

SQL : identique au bloc de l’échauffement de l’agrégation après jointure.

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

### Mesure 5 — agrégation après jointure

SQL : identique au bloc de l’échauffement de l’agrégation après jointure.

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



### Mesure 4 — préagrégation

SQL : identique au bloc de l’échauffement de la préagrégation.

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

### Mesure 5 — préagrégation

SQL : identique au bloc de l’échauffement de la préagrégation.

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
