# Dossier de preuves — ShopFlow

Auteur : Cherif / Date : 5 octobre 2026. Exécution des requêtes dans pgAdmin et transmission des résultats. Ce dossier présente les observations recueillies pour les quatre ateliers, organisées selon `MODELE_DOSSIER.txt`. Les rapports détaillés servent d’annexes : [atelier 1](LIVRABLE_Atelier_1_Diagnostic.md) et [atelier 2](LIVRABLE_Atelier_2_Reecriture.md). Volumes contrôlés : 1 000 clients, 200 produits, 100 000 commandes et 300 000 lignes. Granularités : une ligne par commande pour l’historique ; une ligne par statut pour l’agrégation ; une ligne par client pour le test d’existence ; une ligne par commande pour les totaux. Champs : identifiant, nom, date, statut, compte et montant selon le SQL complet conservé dans les annexes. Symptômes observés : la jointure client-commandes retourne 100 occurrences du client 42 pour un seul client distinct ; `SUM(o.total)` après jointure aux trois lignes de la commande 42 retourne 720,00 au lieu de 240,00. L’agrégation par statut traite toute la table et constitue la requête la plus longue de l’atelier 1. Les traces initiales et finales sont les résultats et plans complets des deux annexes. Droits : le compte PostgreSQL `cours` est configuré dans Compose. Les droits effectifs n’ont pas été audités ; les essais SQL ne prouvent pas les autorisations des endpoints de l’API.

## Environnement reproductible

Version PostgreSQL observée : `PostgreSQL 18.6 (Debian 18.6-1.pgdg13+2) on aarch64-unknown-linux-gnu, compiled by gcc (Debian 14.2.0-19) 14.2.0, 64-bit`. Configuration de référence : [PREPARATION.md](PREPARATION.md), [compose.yaml](01_server/api/compose.yaml), [schéma](02_Laboratoire/01_schema.sql), [données](02_Laboratoire/02_donnees.sql). Compose prévoit PostgreSQL 18, Redis 8 et pgAdmin 9.18. Node et Redis ne participent pas aux mesures SQL directes. Architecture du serveur PostgreSQL : aarch64. Aucun réglage PostgreSQL modifié n’a été rapporté. Les essais ne comprennent aucune création d’index. Index définis par le schéma initial : clés primaires de `clients`, `produits`, `commandes` et `lignes` ; unicité de `clients.email` ; unicité de `(commandes.client_id, commandes.cle_idempotence)`. Les plans confirment l’utilisation de `clients_pkey`, `commandes_pkey`, `lignes_pkey` et `commandes_client_id_cle_idempotence_key`. Aucun inventaire exhaustif des index effectifs n’a été demandé. Pool de l’API, d’après [server.mjs](01_server/api/server.mjs) : maximum par défaut 5, configurable via `POOL_MAX`, délai de connexion 1 000 ms, délai d’inactivité 10 000 ms, `statement_timeout` 5 000 ms. Reproduction : utiliser une base dédiée chargée avec les scripts fournis, vérifier les volumes, exécuter les contrôles fonctionnels des annexes, puis chaque SQL `EXPLAIN (ANALYZE, BUFFERS)` une fois pour l’échauffement et ensuite pour les répétitions. Les plans transmis indiquent uniquement des `shared hit`, sans `shared read` rapporté : observations en cache PostgreSQL. Aucun essai à cache froid forcé. SQL avant : `JOIN DISTINCT` ; SQL après : `EXISTS`, tous deux filtrés sur le client 42. Les SQL et plans complets figurent dans l’annexe atelier 2. La jointure brute illustre la duplication mais n’est pas équivalente en multiplicité au résultat attendu. Hypothèse totaux : agréger les montants des lignes par commande avant la jointure maintient une ligne par commande. L’écriture incorrecte `SUM(o.total)` est rejetée. La comparaison valide porte sur deux écritures correctes : somme de `l.qte * l.prix_unitaire` après `LEFT JOIN`, et préagrégation de cette même expression avant `LEFT JOIN`, filtrées sur la commande 42. SQL complets dans l’annexe atelier 2. Mécanisme observé : semi-jointure avec arrêt après une correspondance pour `EXISTS` ; déplacement du `GroupAggregate` avant la jointure pour la préagrégation. Le filtre de commande est propagé vers l’index des lignes. Aucun plan identique entre les paires comparées, mais les parcours indexés et buffers restent similaires. Coût attendu : moins de lignes intermédiaires pour la lecture ; aucune structure persistante ajoutée, donc aucun coût supplémentaire de maintenance d’index ou de stockage introduit. Aucun code API modifié ni coût d’écriture mesuré.

## Exactitude et fiabilité

Chronologie de collecte : version et volumes → contrôles de contenu → échauffement → répétitions pour chaque variante. La transcription complète des preuves est conservée dans les annexes ; aucun horodatage fin n’est disponible. Atelier 1 : 100 commandes du client 42, total 47 760,00. Agrégation : annulee 10 000 / 3 049 912,50 ; en_attente 10 000 / 2 974 962,50 ; payee 80 000 / 23 750 126,25. Trois lignes et total global contrôlé de 29 775 001,25. Atelier 2 : `JOIN DISTINCT` et `EXISTS` retournent la même ligne `42, Client 42`. La commande 42 possède trois lignes ; les deux versions correctes retournent `42, 240,00, 240,00`. La version incorrecte retourne `42, 720,00`. L’équivalence expérimentale est vérifiée sur le client et la commande choisis, pas par une différence exhaustive de toute la base. L’équivalence générale est justifiée par la granularité et les clés décrites dans l’annexe. Aucun test concurrent, de fraîcheur, de droits API ni de modification entre exécutions n’a été réalisé.

## Mesures réelles

Scénarios identiques à l’intérieur de chaque paire : mêmes colonnes, même filtre, même base et même méthode `EXPLAIN (ANALYZE, BUFFERS)`. Chaque variante est échauffée une fois. Cinq répétitions par variante pour les deux ateliers. Les essais sont des exécutions SQL manuelles séquentielles, sans campagne de charge fermée contrôlée. Aucun échec n’apparaît dans les plans fournis ; cela ne constitue pas une mesure du taux d’erreurs. `Execution Time` exclut `Planning Time` et ne représente pas la latence complète d’un endpoint.

| Scénario / état | n | Moyenne ms | p50 ms | p95 empirique ms | Min–max ms | Écart-type ms |
|---|---:|---:|---:|---:|---|---:|
| Atelier 1 : historique | 5 | 1,695 | 1,737 | 2,474 | 0,827–2,474 | 0,527 |
| Atelier 1 : par statut | 5 | 49,656 | 48,577 | 61,019 | 41,124–61,019 | 7,444 |
| Atelier 2 : JOIN DISTINCT | 5 | 0,445 | 0,366 | 0,862 | 0,245–0,862 | 0,220 |
| Atelier 2 : EXISTS | 5 | 0,371 | 0,384 | 0,498 | 0,219–0,498 | 0,103 |
| Atelier 2 : somme après jointure | 5 | 0,732 | 0,609 | 1,296 | 0,448–1,296 | 0,317 |
| Atelier 2 : préagrégation | 5 | 0,622 | 0,575 | 1,228 | 0,293–1,228 | 0,321 |

p50 : médiane. p95 empirique : rang `ceil(0,95 × n)`, soit le maximum sur ces petits échantillons ; il ne permet pas une estimation fiable de la latence en queue. Écart-type de population calculé sur les observations. Pièces jointes : [mesures brutes CSV](preuves/mesures.csv), [synthèse CSV](preuves/synthese.csv), [métadonnées](preuves/meta.json), [graphique](preuves/graphique_mesures.svg). Les statistiques utilisent exclusivement les observations transmises et excluent les échauffements.



## Décision et limites

Retenir `EXISTS` pour exprimer la présence d’au moins une commande sans duplication. Son avantage démontré est structurel : une correspondance depuis l’index contre 100 puis déduplication. Moyenne inférieure d’environ 16,5 %, mais médiane supérieure d’environ 4,9 % : gain de temps robuste non démontré. Rejeter `SUM(commandes.total)` après jointure aux lignes : résultat triplé sur le cas testé. Retenir une somme des montants des lignes ; la préagrégation est une écriture valide qui rend explicite la granularité par commande. Sur cet échantillon, moyenne inférieure de 15,1 % et médiane inférieure de 5,6 % par rapport à l’autre écriture correcte ; ces différences ne démontrent pas un avantage général. Les deux écritures correctes sont acceptables. Coût d’écriture/stockage : aucune modification persistante. Risques restants : faible nombre de répétitions, sous-milliseconde sensible à la charge, périmètre unitaire, absence de tests de concurrence et de droits. Les conclusions ne s’étendent pas automatiquement à toute la table, à un autre nombre de lignes par commande, à un cache froid ou à l’API sous charge. Prochaine expérience : réaliser une nouvelle série continue et davantage de répétitions par variante dans un environnement documenté, contrôler le contenu sur un périmètre élargi et tester les commandes sans ligne. Reproduire une requête dans pgAdmin. Pour l’API, conserver le contrat des champs, de la granularité, des droits et du traitement de NULL ; les essais SQL ne valident pas sa latence ni sa fiabilité sous charge. Le dossier est structuré selon le modèle avec toutes les preuves disponibles.
## Atelier 3 — observations recueillies

[Rapport et tableau de décision](LIVRABLE_Atelier_3_Indexation.md). La comparaison des quatre index porte sur les lectures du client 42, cinq mesures après échauffement. Les états initial et simple ont également été testés sur les clients 1 et 999.

| État | p50 lecture client 42 ms | Buffers hit | Taille index expérimental |
|---|---:|---:|---|
| Initial | 1,061 | 90 | Aucun |
| Simple | 1,989 | 90 | 688 kB |
| Composé | 0,496 | 23 | 3984 kB |
| Couvrant | 0,234 | 4 | 5792 kB |

L’index couvrant est utilisé en Index Only Scan avec zéro Heap Fetch dans les cinq plans. Les 20 lignes retournées sont identiques dans les quatre états. Les insertions mesurées sur les états initial et simple donnent respectivement des médianes de 20,052 ms et 22,712 ms pour 1 000 commandes dans une transaction annulée.


## Atelier 4 — Index spécialisés

[Rapport synthétique](LIVRABLE_Atelier_4_Index_Specialises.md), [plans et SQL complets](preuves/atelier4_plans.txt), [observations CSV](preuves/atelier4_mesures.csv).

Index partiel de 328 kB : utilisé pour les commandes en attente, exclu pour les commandes payées. GIN de 16 kB : compatible avec la contenance JSONB `@>`, mais parcours séquentiel observé sur les 200 produits (3 blocs en cache). GiST de 8 KiB : l’opérateur `&&` retrouve les deux périodes qui chevauchent l’intervalle testé ; la période disjointe est exclue. Sur les trois périodes, parcours séquentiel d’un bloc. Le rapport propose un test GIN à plus grand volume et distingue compatibilité et utilisation effective.

## Annexes intégrées — SQL, résultats et plans complets

Les preuves suivantes sont incluses dans ce document. Les liens vers les fichiers de travail sont facultatifs pour sa lecture.

## Annexe 1 — Atelier 1

## Atelier 1 — Diagnostic initial de ShopFlow

Date : 5 octobre 2026

### 1. Contexte et version

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

### 2. Requêtes et résultats fonctionnels

Les deux requêtes suivantes sont proposées pour répondre à la consigne de l’atelier ; aucun script de diagnostic dédié n’a été trouvé dans le dossier fourni.

#### Requête 1 — Historique du client 42

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

#### Requête 2 — Agrégation des commandes par statut

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

### 3. Mesures après échauffement

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

### 4. Nœud coûteux et hypothèse

Le nœud coûteux retenu est **`HashAggregate` de la requête 2**, alimenté par un `Seq Scan` de toutes les commandes. À la cinquième mesure, il termine à **54,463 ms**, contre **18,073 ms** pour son enfant, avec une seule boucle. La différence d’environ **36,390 ms** estime le temps propre à l’agrégation, sous réserve de l’instrumentation. Les temps des parents incluent ceux des enfants : ils ne doivent pas être additionnés.

**Hypothèse expliquant le coût :** l’agrégation traite les **100 000 commandes** pour déterminer le groupe de chaque ligne, incrémenter le compteur et additionner les montants de type `numeric`. Les trois groupes nécessitent peu de mémoire, mais toutes les lignes restent à traiter. Les cinq plans rapportent **1 674 accès aux blocs en cache** (`shared hit=1674`), sans `shared read` rapporté. L’agrégation tient en mémoire (**32 kB**, `Batches: 1`) et le tri final de trois lignes utilise **25 kB**. Aucun débordement sur disque n’est rapporté. Ces observations sont compatibles avec un coût de calcul et de parcours en mémoire. Les estimations de lignes correspondent aux observations : 100 000 pour le parcours et 3 pour l’agrégation. Pour la requête 1, l’index initial créé par `UNIQUE (client_id, cle_idempotence)` permet de retrouver 100 commandes sans parcourir toute la table. Le `Bitmap Heap Scan` et son enfant constituent la principale partie du temps avant le tri. Les lignes sont réparties sur **88 blocs de table distincts** ; cette dispersion explique le travail de récupération malgré le faible nombre de résultats. Les plans indiquent **90 accès aux blocs en cache**, dont 2 pour l’index, et un tri en mémoire de **29 kB**. Les structures de plans et les buffers restent stables malgré la variation des durées. Une variation de charge ou d’ordonnancement de l’environnement est une hypothèse possible, non vérifiée par ces seuls plans. Les résultats constituent une référence initiale sur cet environnement et ce jeu de données, sans ajout d’index lors de cet atelier.

### Annexe — Plans complets et informations BUFFERS

#### Commande de mesure de la requête 1

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, created_at, statut, total
FROM shopflow.commandes
WHERE client_id = 42
ORDER BY created_at DESC, id DESC;
```

##### Échauffement — requête 1

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

##### Mesure 1 — requête 1

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

##### Mesure 2 — requête 1

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

##### Mesure 3 — requête 1

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

##### Mesure 4 — requête 1

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

##### Mesure 5 — requête 1

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

#### Commande de mesure de la requête 2

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT statut,
       count(*) AS nombre_commandes,
       sum(total) AS montant_total
FROM shopflow.commandes
GROUP BY statut
ORDER BY statut;
```

##### Échauffement — requête 2

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

##### Mesure 1 — requête 2

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

##### Mesure 2 — requête 2

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

##### Mesure 3 — requête 2

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

##### Mesure 4 — requête 2

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

##### Mesure 5 — requête 2

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

## Annexe 2 — Atelier 2

## Atelier 2 — Une réécriture équivalente

### Contexte

Base `shopflow`, schéma `shopflow`, consultation depuis pgAdmin. Version communiquée à l’atelier 1 : PostgreSQL 18.6 (Debian), architecture aarch64, 64 bits. Données contrôlées à l’atelier 1 : 1 000 clients, 200 produits, 100 000 commandes et 300 000 lignes. Objectifs : comparer une jointure qui duplique les clients avec une version `EXISTS`, puis calculer un total par commande sans multiplier `commandes.total`. Le résultat pertinent pour la première comparaison est une ligne par client ayant au moins une commande. La jointure brute et `EXISTS` ne sont pas équivalents en multiplicité ; la comparaison équivalente portera sur `JOIN` avec `DISTINCT` et `EXISTS`.

### 1. Clients ayant plusieurs commandes

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

### 2. Total par commande

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

#### Version incorrecte — multiplication du total enregistré

```sql
SELECT o.id,
       sum(o.total) AS total_incorrect
FROM shopflow.commandes o
JOIN shopflow.lignes l ON l.commande_id = o.id
WHERE o.id = 42
GROUP BY o.id;
```

Résultat observé : **42, 720,00**, soit trois fois le total enregistré de **240,00**. Chaque ligne de la commande répète `o.total` dans la jointure ; `SUM(o.total)` additionne donc trois occurrences du même montant. Cette version est fonctionnellement incorrecte et ne sera pas considérée comme une variante équivalente dans la comparaison des performances.

#### Version corrigée — préagrégation des lignes

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

#### Variante correcte — agrégation après jointure

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

### 3. Plans et mesures

Protocole : preuve du contenu avant les mesures, puis une exécution d’échauffement et cinq mesures `EXPLAIN (ANALYZE, BUFFERS)` par variante équivalente. Conserver les SQL et les plans complets. Ne pas conclure à un gain si une variante perd des lignes ; expliquer des plans identiques le cas échéant. Le protocole est porté à cinq mesures par variante pour respecter le modèle. Les répétitions 4 et 5 sont recueillies dans une seconde série après les trois premières ; la continuité de session et la charge concurrente ne sont pas documentées. Les statistiques finales portent sur les cinq observations de chaque variante.

#### Comparaison des clients — périmètre client 42

| Variante | Échauffement (ms, exclu) | Mesure 1 | Mesure 2 | Mesure 3 | Mesure 4 | Mesure 5 |
|---|---:|---|---|---|---|---|
| JOIN DISTINCT | 0,616 | 0,455 | 0,245 | 0,295 | 0,862 | 0,366 |
| EXISTS | 0,479 | 0,219 | 0,384 | 0,296 | 0,498 | 0,459 |

##### SQL et plan complet — échauffement JOIN DISTINCT

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

##### Mesure 1 — JOIN DISTINCT

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

##### Mesure 2 — JOIN DISTINCT

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

##### Mesure 3 — JOIN DISTINCT

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



##### SQL et plan complet — échauffement EXISTS

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

##### Mesure 1 — EXISTS

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

##### Mesure 2 — EXISTS

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

##### Mesure 3 — EXISTS

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





#### Comparaison des totaux — périmètre commande 42

| Variante | Échauffement (ms, exclu) | Mesure 1 | Mesure 2 | Mesure 3 | Mesure 4 | Mesure 5 |
|---|---:|---|---|---|---|---|
| Agrégation après jointure | 1,354 | 0,849 | 0,448 | 0,609 | 0,460 | 1,296 |
| Préagrégation avant jointure | 1,563 | 0,575 | 0,437 | 0,577 | 0,293 | 1,228 |

##### Échauffement — agrégation après jointure

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

##### Mesure 1 — agrégation après jointure

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

##### Mesure 2 — agrégation après jointure

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

##### Mesure 3 — agrégation après jointure

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



##### SQL et plan complet — échauffement de la préagrégation

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

##### Mesure 1 — préagrégation

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

##### Mesure 2 — préagrégation

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

##### Mesure 3 — préagrégation

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



### 4. Interprétation

| Variante | Moyenne ms | p50 ms | p95 empirique ms | Min–max ms | Écart-type ms |
|---|---:|---:|---:|---|---:|
| JOIN DISTINCT | 0,445 | 0,366 | 0,862 | 0,245–0,862 | 0,220 |
| EXISTS | 0,371 | 0,384 | 0,498 | 0,219–0,498 | 0,103 |
| Agrégation après jointure | 0,732 | 0,609 | 1,296 | 0,448–1,296 | 0,317 |
| Préagrégation avant jointure | 0,622 | 0,575 | 1,228 | 0,293–1,228 | 0,321 |

Statistiques calculées sur cinq mesures, hors échauffement. p50 est la médiane ; p95 utilise le rang ceil(0,95 × 5), donc le maximum observé. Sur un si petit échantillon, il ne représente pas une estimation fiable de la latence en queue.

**Clients :** JOIN DISTINCT et EXISTS retournent une ligne identique pour le client 42. EXISTS remplace la jointure suivie de déduplication par une semi-jointure s’arrêtant à la première commande. La moyenne diminue d’environ **16,5 %**, mais la médiane augmente d’environ **4,9 %**. Le gain de temps n’est donc pas uniforme ; la réduction des lignes intermédiaires est démontrée. Les deux plans rapportent 6 accès aux blocs en cache.

**Totaux :** la version SUM(commandes.total) est rejetée : 720,00 au lieu de 240,00. Les deux écritures correctes retournent la même ligne 42, 240,00, 240,00. La préagrégation déplace GroupAggregate avant la jointure ; le filtre est propagé à commande_id = 42, limitant le calcul aux trois lignes concernées. Les plans diffèrent mais utilisent les mêmes index et 10 accès aux blocs en cache. La moyenne de la préagrégation diminue d’environ **15,1 %** et sa médiane de **5,6 %**. Les durées sont variables et les deux variantes présentent une cinquième mesure supérieure à une milliseconde. Sur une seule commande et cinq répétitions, cela ne démontre pas un avantage généralisable. Les deux écritures correctes restent acceptables. L’équivalence expérimentale porte sur le client 42 et la commande 42, sans comparaison exhaustive de la base. Aucun code API ni index ajouté. Les mesures 4 et 5 ont été recueillies dans une seconde série après les trois premières. La continuité de session, la charge concurrente et les ressources Docker ne sont pas documentées. Les valeurs sont celles de Execution Time, hors Planning Time. État : **finalisé sur cinq mesures par variante**. Quatre échauffements et vingt plans de mesure sont conservés, avec SQL, contrôles du contenu et interprétation. CSV, métadonnées et graphique figurent dans le dossier `preuves` ; le dossier principal suit `MODELE_DOSSIER.txt`.

### Complément de collecte — cinq répétitions

#### Mesure 4 — JOIN DISTINCT

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

#### Mesure 5 — JOIN DISTINCT

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



#### Mesure 4 — EXISTS

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

#### Mesure 5 — EXISTS

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



#### Mesure 4 — agrégation après jointure

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

#### Mesure 5 — agrégation après jointure

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



#### Mesure 4 — préagrégation

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

#### Mesure 5 — préagrégation

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

## Annexe 3 — Atelier 3

## Atelier 3 — L’historique client

Source : diapositive 12 de `J02_Indexer_modeliser.pptx`, exemples des diapositives 7 à 10. Base `shopflow` ; version PostgreSQL à reconfirmer si l’environnement a changé.

### Besoin et protocole

Comparer la base initiale, un index simple sur `client_id`, un index composé `(client_id, created_at DESC, id DESC)` et sa variante couvrante `INCLUDE (statut, total)`. Conserver les index des contraintes initiales ; tester un seul index expérimental à la fois. Contrôler l’inventaire avant toute suppression. Requête retenue, adaptée à l’exemple d’historique limité du cours :

```sql
SELECT id, created_at, statut, total
FROM shopflow.commandes
WHERE client_id = 42
ORDER BY created_at DESC, id DESC
LIMIT 20;
```

Clients retenus : 1, 42 et 999. Leurs effectifs ont été contrôlés : chacun possède 100 commandes. Le jeu initial distribue uniformément les commandes ; ces clients ne représentent pas à eux seuls une distribution déséquilibrée. Pour chaque état et chaque client : contrôle de contenu, une exécution d’échauffement puis cinq mesures `EXPLAIN (ANALYZE, BUFFERS)`. Relever plans complets, buffers, `Heap Fetches`, tailles des index et statistiques de durées. Les mesures de l’atelier 1 sans LIMIT ne constituent pas la référence de cette nouvelle requête. Comparer également un même lot d’insertion dans une transaction de laboratoire terminée par `ROLLBACK`, pour chaque état, avec échauffement et cinq mesures. Le retour arrière préserve le contenu logique mais n’annule pas tous les effets physiques (WAL, cache, tuples morts) ; documenter le protocole et éviter de comparer une série d’écritures avant les lectures suivantes sans tenir compte de la visibilité.

### Environnement et exactitude

Inventaire réel des index de `shopflow.commandes`, communiqué depuis pgAdmin :

```sql
CREATE UNIQUE INDEX commandes_client_id_cle_idempotence_key
ON shopflow.commandes USING btree (client_id, cle_idempotence);

CREATE UNIQUE INDEX commandes_pkey
ON shopflow.commandes USING btree (id);
```

Ces deux index correspondent aux contraintes initiales et doivent être conservés dans les quatre états. Aucun index expérimental n’est présent au contrôle initial. L’index unique commence déjà par `client_id` ; un nouvel index simple peut donc recouvrir une partie de son usage. Le gain éventuel devra être démontré par les plans, les mesures et les tailles. Contrôle initial des clients :

```sql
SELECT client_id,
       count(*) AS nombre_commandes,
       sum(total) AS montant_total
FROM shopflow.commandes
WHERE client_id IN (1, 42, 999)
GROUP BY client_id
ORDER BY client_id;
```

| Client | Nombre de commandes observé | Montant total observé |
|---|---:|---:|
| 1 | 100 | 17 250,00 |
| 42 | 100 | 47 760,00 |
| 999 | 100 | 25 621,25 |

Ces montants portent sur toutes les commandes de chaque client, et non sur les 20 lignes de l’historique limité. Le contenu initial avec `LIMIT 20` a été communiqué pour le client 42 : **20 lignes**, toutes au statut `payee`, chacune de montant **720,00**, soit **14 400,00** au total. Les identifiants vont de 86042 à 29042, par pas de −3000 dans l’ordre retourné ; les dates vont du 12 septembre 2026 à 23:54:02 UTC au même jour à 08:04:02 UTC, par pas de −50 minutes. La transcription complète et ordonnée est conservée dans [le CSV de référence](preuves/atelier3_reference_client42.csv). La référence du client 1 est également recueillie (voir ci-dessous). La référence du client 999 est également recueillie (voir ci-dessous). Après la collecte de l’état initial, l’étudiant a exécuté :

```sql
CREATE INDEX idx_atelier3_client_simple
ON shopflow.commandes (client_id);
```

Création annoncée avec succès par pgAdmin en **215 ms**. Cette durée est celle affichée par l’interface pour le DDL ; elle n’est pas une mesure `Execution Time` de lecture ou d’insertion. L’état testé suivant ajoute cet index simple aux deux index de contraintes initiaux. Sa définition et sa taille ont été vérifiées dans pg_indexes : index B-tree sur client_id, 704 512 octets (688 kB). Aucun autre index expérimental n’est présent.

### Tailles des index — état initial

| Index | Taille en octets | Taille lisible PostgreSQL |
|---|---:|---|
| commandes_client_id_cle_idempotence_key | 1 908 736 | 1864 kB |
| commandes_pkey | 4 513 792 | 4408 kB |

Total initial des deux index de `commandes` : **6 422 528 octets**. Tailles observées avant les tests d’insertion. Les contraintes et leurs index sont conservés pour les variantes suivantes.

### Contrôle après les insertions annulées — état initial

```sql
SELECT count(*) AS nombre_commandes,
       max(id) AS id_maximum,
       sum(total) AS montant_global
FROM shopflow.commandes;
```

Résultat communiqué après les lots d’insertion : **100 000 commandes**, **id maximal 100 000**, **montant global 29 775 001,25**. Ces trois valeurs correspondent à l’état initial. Ce contrôle valide les invariants relevés après les annulations, sans constituer une comparaison exhaustive ligne par ligne. Les effets physiques des insertions annulées restent possibles.

### Tableau de décision — lectures mesurées

| État | Client | p50 ms | p95 empirique ms | Buffers hit | Taille de l’index expérimental |
|---|---:|---:|---:|---:|---|
| Initial | 42 | 1,061 | 1,834 | 90 | Aucun |
| Initial | 1 | 1,656 | 2,336 | 99 | Aucun |
| Initial | 999 | 1,571 | 2,264 | 97 | Aucun |
| Simple | 42 | 1,989 | 2,907 | 90 | 688 kB |
| Simple | 1 | 1,785 | 2,050 | 99 | 688 kB |
| Simple | 999 | 1,707 | 1,886 | 97 | 688 kB |
| Composé | 42 | 0,496 | 0,684 | 23 | 3984 kB |
| Couvrant | 42 | 0,234 | 0,406 | 4 | 5792 kB |

### Insertions mesurées — lot de 1 000 commandes

| État | Répétitions | Moyenne ms | p50 ms | p95 empirique ms |
|---|---:|---:|---:|---:|
| Initial | 5 | 26,868 | 20,052 | 53,759 |
| Simple | 5 | 22,372 | 22,712 | 26,996 |

### Décision fondée sur les lectures du client 42

L’index couvrant donne la meilleure lecture observée : médiane de 0,234 ms, quatre accès aux blocs en cache et zéro Heap Fetch dans les cinq plans. Il occupe 5792 kB. L’index composé supprime aussi le tri et donne une médiane de 0,496 ms, pour 3984 kB. L’index simple conserve la récupération de 100 commandes avant tri et les mêmes buffers que l’état initial. Les résultats des 20 commandes du client 42 sont identiques dans les quatre états. Cette comparaison porte sur l’historique limité à 20 commandes du client 42 ; les tableaux d’insertion portent sur les états initial et simple.

[Mesures brutes](preuves/atelier3_mesures.csv), [statistiques](preuves/atelier3_synthese.csv), [tailles des index](preuves/atelier3_tailles_index.csv) et [graphique](preuves/atelier3_graphique.svg).



### Mesures de lecture — état initial, client 42

| Échauffement (exclu) | Mesure 1 | Mesure 2 | Mesure 3 | Mesure 4 | Mesure 5 |
|---|---|---|---|---|---|

#### Échauffement — état initial, client 42

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, created_at, statut, total
FROM shopflow.commandes
WHERE client_id = 42
ORDER BY created_at DESC, id DESC
LIMIT 20;
```

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

Le plan utilise l’index unique initial pour trouver 100 commandes, visite 88 blocs de table distincts et trie ces commandes en `top-N heapsort` (27 kB) pour retourner 20 lignes. Le nœud racine rapporte 90 accès aux blocs en cache, dont 2 pour l’index ; les compteurs parents incluent ceux des enfants. Aucun `shared read` n’est rapporté. Cet échauffement est exclu des cinq mesures.

#### Mesure 1 — état initial, client 42

SQL : identique au bloc de l’échauffement ci-dessus.

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

#### Mesure 2 — état initial, client 42

SQL : identique au bloc de l’échauffement ci-dessus.

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

#### Mesure 3 — état initial, client 42

SQL : identique au bloc de l’échauffement ci-dessus.

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

#### Mesure 4 — état initial, client 42

SQL : identique au bloc de l’échauffement ci-dessus.

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

#### Mesure 5 — état initial, client 42

SQL : identique au bloc de l’échauffement ci-dessus.

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

Synthèse initiale, client 42 : moyenne **1,177 ms**, p50 **1,061 ms**, p95 empirique **1,834 ms**, minimum **0,928 ms**, maximum **1,834 ms**. Les cinq plans récupèrent 100 commandes, puis retournent 20 lignes après tri top-N en mémoire (27 kB) ; 90 accès aux blocs en cache et 88 blocs de table distincts à chaque mesure. Le p95 utilise le rang ceil(0,95 × 5), donc le maximum de ce petit échantillon.

### Référence de contenu — client 1, état initial

Résultat communiqué : **20 lignes**, toutes au statut `annulee`, chacune de montant **86,25**, soit **1 725,00** au total. Les identifiants vont de 86001 à 29001, par pas de −3000 dans l’ordre retourné. Les dates vont du 26 août 2026 à 23:53:21 UTC au même jour à 08:03:21 UTC, par pas de −50 minutes. La transcription complète et ordonnée figure dans [le CSV de référence du client 1](preuves/atelier3_reference_client1.csv).

### Mesures de lecture — état initial, client 1

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, created_at, statut, total
FROM shopflow.commandes
WHERE client_id = 1
ORDER BY created_at DESC, id DESC
LIMIT 20;
```

| Échauffement (exclu) | Mesure 1 | Mesure 2 | Mesure 3 | Mesure 4 | Mesure 5 |
|---|---|---|---|---|---|
| 5,290 ms | 2,160 ms | 1,656 ms | 1,211 ms | 2,336 ms | 1,654 ms |

#### Échauffement — état initial, client 1

SQL : identique au bloc du client 1 ci-dessus.

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

Cet échauffement est exclu des cinq mesures. Le plan récupère 100 commandes réparties sur 97 blocs de table distincts, puis retourne 20 lignes après tri top-N en mémoire (27 kB). Le nœud racine rapporte 99 accès aux blocs en cache, dont 2 pour l’index. Aucun `shared read` n’est rapporté. La cause du temps plus élevé que celui de l’échauffement du client 42 ne peut pas être établie à partir de ce seul plan.

#### Mesure 1 — état initial, client 1

SQL : identique au bloc du client 1 ci-dessus.

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

#### Mesure 2 — état initial, client 1

SQL : identique au bloc du client 1 ci-dessus.

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

#### Mesure 3 — état initial, client 1

SQL : identique au bloc du client 1 ci-dessus.

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

#### Mesure 4 — état initial, client 1

SQL : identique au bloc du client 1 ci-dessus.

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

#### Mesure 5 — état initial, client 1

SQL : identique au bloc du client 1 ci-dessus.

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

Synthèse initiale, client 1 : moyenne **1,803 ms**, p50 **1,656 ms**, p95 empirique **2,336 ms**, minimum **1,211 ms**, maximum **2,336 ms**. Les cinq plans récupèrent 100 commandes puis retournent 20 lignes après tri top-N en mémoire (27 kB). Chaque plan rapporte 99 accès aux blocs en cache et 97 blocs de table distincts. Le p95 empirique correspond au maximum sur cinq mesures ; l’échauffement est exclu.

### Référence de contenu — client 999, état initial

Résultat communiqué : **20 lignes**, toutes au statut `payee`, chacune de montant **386,25**, soit **7 725,00** au total. Les identifiants vont de 83999 à 26999 par pas de −3000, dans l’ordre retourné. Les dates vont du 21 septembre 2026 à 23:19:59 UTC au même jour à 07:29:59 UTC, par pas de −50 minutes. La transcription complète et ordonnée est conservée dans [le CSV de référence du client 999](preuves/atelier3_reference_client999.csv).

### Mesures de lecture — état initial, client 999

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, created_at, statut, total
FROM shopflow.commandes
WHERE client_id = 999
ORDER BY created_at DESC, id DESC
LIMIT 20;
```

| Échauffement (exclu) | Mesure 1 | Mesure 2 | Mesure 3 | Mesure 4 | Mesure 5 |
|---|---|---|---|---|---|
| 2,364 ms | 1,309 ms | 1,693 ms | 1,220 ms | 2,264 ms | 1,571 ms |

#### Échauffement — état initial, client 999

SQL : identique au bloc du client 999 ci-dessus.

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

Cet échauffement est exclu des cinq mesures. Le plan récupère 100 commandes réparties sur 95 blocs de table distincts, puis retourne 20 lignes après tri top-N en mémoire (27 kB). Le nœud racine rapporte 97 accès aux blocs en cache, dont 2 pour l’index. Aucun `shared read` n’est rapporté.

#### Mesure 1 — état initial, client 999

SQL : identique au bloc du client 999 ci-dessus.

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

#### Mesure 2 — état initial, client 999

SQL : identique au bloc du client 999 ci-dessus.

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

#### Mesure 3 — état initial, client 999

SQL : identique au bloc du client 999 ci-dessus.

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

#### Mesure 4 — état initial, client 999

SQL : identique au bloc du client 999 ci-dessus.

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

#### Mesure 5 — état initial, client 999

SQL : identique au bloc du client 999 ci-dessus.

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

Synthèse initiale, client 999 : moyenne **1,611 ms**, p50 **1,571 ms**, p95 empirique **2,264 ms**, minimum **1,220 ms**, maximum **2,264 ms**. Les cinq plans rapportent 97 accès aux blocs en cache et 95 blocs de table distincts ; 100 commandes sont récupérées avant le tri top-N de 27 kB et la limitation à 20 lignes. Échauffement exclu.

### Insertion — protocole commun aux quatre états

Lot de 1 000 commandes synthétiques, réparties sur les clients 1, 42 et 999, sans lignes associées. Identifiants supérieurs au maximum courant, date fixe, statut `payee`, total 0 et clé d’idempotence NULL. Chaque exécution utilise une transaction terminée par `ROLLBACK`. Aucun autre écrivain ne doit intervenir pendant ces essais. Le lot mesure uniquement l’insertion dans `commandes`, pas un achat complet ni le commit durable. Une exécution d’échauffement, puis cinq mesures par état. Conserver chaque plan complet et `Execution Time`. Le calcul du maximum et la génération du lot sont inclus dans la mesure et restent identiques entre variantes. ROLLBACK restaure le contenu logique mais peut laisser des tuples morts, du WAL et des changements de cache ou de taille ; ces limites devront être prises en compte pour les comparaisons, notamment la visibilité de l’index couvrant.

```sql
BEGIN;

EXPLAIN (ANALYZE, BUFFERS)
INSERT INTO shopflow.commandes
  (id, client_id, created_at, statut, total)
SELECT b.max_id + g.n,
       CASE g.n % 3 WHEN 0 THEN 1 WHEN 1 THEN 42 ELSE 999 END,
       TIMESTAMPTZ '2026-10-05 12:00:00+00',
       'payee',
       0
FROM (SELECT max(id) AS max_id FROM shopflow.commandes) b
CROSS JOIN generate_series(1, 1000) AS g(n);

ROLLBACK;
```

État initial : un échauffement documenté et cinq mesures conservés. Les tailles initiales ont été relevées avant ce lot.

#### Échauffement documenté — insertion, état initial

Une première exécution du bloc complet a été annoncée par pgAdmin en 179 ms, sans plan transmis. Cette durée porte sur le bloc complet et n’est pas utilisée comme mesure d’Execution Time. Une seconde exécution, avec BEGIN, EXPLAIN et ROLLBACK séparés, fournit l’échauffement documenté ci-dessous. L’étudiant a confirmé l’exécution du ROLLBACK de cette seconde exécution ; les insertions de ce lot n’ont pas été conservées. SQL : lot de 1 000 insertions décrit dans le protocole commun ci-dessus.

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

Échauffement exclu des cinq mesures : **33,894 ms**. Le plan génère 1 000 lignes ; le nœud Insert affiche zéro ligne de sortie en l’absence de RETURNING. Il rapporte 5 484 accès aux blocs en cache et 8 blocs salis. Le contrôle de clé étrangère est appelé 1 000 fois (6,030 ms rapportées, incluses dans Execution Time). La recherche de max(id) rapporte 1 000 Heap Fetches, compatibles avec les tuples des insertions précédentes annulées ; cette cause est une hypothèse, non une vérification physique. Les répétitions avec ROLLBACK peuvent ainsi modifier le travail de recherche du maximum. Aucun nettoyage intermédiaire n’a été rapporté.

#### Mesure 1 — insertion, état initial

SQL : identique au lot de 1 000 insertions du protocole commun, entre BEGIN et ROLLBACK. Résultat transmis après la consigne d’annulation du lot.

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

Execution Time : **53,759 ms**. Le nœud Insert rapporte 5 485 accès aux blocs en cache, 28 blocs salis et 1 bloc écrit. Le calcul du maximum nécessite 1 000 Heap Fetches ; son travail est inclus dans cette mesure, ainsi que les contrôles de clé étrangère (1 000 appels, 5,044 ms rapportées). Les compteurs et temps parents incluent le travail des enfants et ne doivent pas être additionnés.

#### Mesure 2 — insertion, état initial

SQL : identique au lot de 1 000 insertions du protocole commun, entre BEGIN et ROLLBACK.

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

Execution Time : **27,691 ms**. Le nœud Insert rapporte 5 465 accès aux blocs en cache, 38 blocs salis et 9 blocs écrits. Le calcul du maximum rapporte toujours 1 000 Heap Fetches. Les contrôles de clé étrangère totalisent 1 000 appels et 7,480 ms, incluses dans Execution Time.

#### Mesure 3 — insertion, état initial

SQL : identique au lot de 1 000 insertions du protocole commun, entre BEGIN et ROLLBACK.

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

Execution Time : **18,113 ms**. Le nœud Insert rapporte 5 481 accès aux blocs en cache et 8 blocs salis. Les 1 000 contrôles de clé étrangère prennent 6,362 ms rapportées, incluses dans Execution Time. Le calcul du maximum conserve 1 000 Heap Fetches.

#### Mesure 4 — insertion, état initial

SQL : identique au lot de 1 000 insertions du protocole commun, entre BEGIN et ROLLBACK.

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

#### Mesure 5 — insertion, état initial

SQL : identique au lot de 1 000 insertions du protocole commun, entre BEGIN et ROLLBACK.

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

Synthèse insertion initiale : moyenne **26,868 ms**, p50 **20,052 ms**, p95 empirique **53,759 ms**, minimum **14,727 ms**, maximum **53,759 ms**. Échauffement exclu. La recherche de max(id) passe de 1 000 Heap Fetches aux quatre premières mesures à 1 dans la cinquième. Un nettoyage ou un changement de visibilité peut expliquer cette évolution, mais aucun événement de ce type n’a été relevé : la cause reste non vérifiée. La comparaison des écritures devra tenir compte de ce travail variable inclus dans Execution Time.

### Tailles des index — état avec index simple

| Index | Taille en octets | Taille lisible PostgreSQL |
|---|---:|---|
| commandes_client_id_cle_idempotence_key | 2 015 232 | 1968 kB |
| commandes_pkey | 4 554 752 | 4448 kB |
| idx_atelier3_client_simple | 704 512 | 688 kB |

Total des trois index : **7 274 496 octets**. Le seul index expérimental est `idx_atelier3_client_simple`, B-tree sur `client_id`. Les index initiaux ont augmenté respectivement de **106 496** et **40 960 octets** depuis le relevé avant insertions. Cette croissance est compatible avec les effets physiques des lots annulés ; elle ne doit pas être attribuée à la seule création de l’index simple. Sa taille propre est de 704 512 octets. Contrôle du contenu avec l’index simple, client 42 : les 20 lignes communiquées sont identiques à la référence initiale, pour toutes les colonnes et dans le même ordre (identifiants 86042 à 29042, dates du 12 septembre 2026 de 23:54:02 à 08:04:02 UTC, statut `payee`, montant 720,00 par ligne). Nombre de lignes et montant cumulé inchangés : **20**, **14 400,00**. Référence complète : [CSV du client 42](preuves/atelier3_reference_client42.csv). Contrôle du contenu avec l’index simple, client 1 : les 20 lignes communiquées sont identiques à la référence initiale pour toutes les colonnes et dans le même ordre. Identifiants 86001 à 29001, dates du 26 août 2026 de 23:53:21 à 08:03:21 UTC, statut `annulee`, montant 86,25 par ligne. Nombre de lignes et montant cumulé inchangés : **20**, **1 725,00**. Référence complète : [CSV du client 1](preuves/atelier3_reference_client1.csv).

### Mesures de lecture — index simple, client 42

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, created_at, statut, total
FROM shopflow.commandes
WHERE client_id = 42
ORDER BY created_at DESC, id DESC
LIMIT 20;
```

| Échauffement (exclu) | Mesure 1 | Mesure 2 | Mesure 3 | Mesure 4 | Mesure 5 |
|---|---|---|---|---|---|
| 1,937 ms | 1,498 ms | 2,445 ms | 2,907 ms | 1,989 ms | 1,323 ms |

#### Échauffement — index simple, client 42

SQL : identique au bloc de lecture index simple, client 42 ci-dessus.

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

**Utilisation de l’index expérimental confirmée** par `Bitmap Index Scan on idx_atelier3_client_simple`, avec la condition `client_id = 42`. L’échauffement de 1,937 ms est exclu des cinq mesures. Le plan récupère 100 commandes, visite 88 blocs de table et trie en top-N (27 kB) pour retourner 20 lignes ; 90 accès aux blocs en cache, dont 2 pour l’index. Cette structure est identique à la référence, à l’exception du nom de l’index utilisé. Chaque plan de mesure sera contrôlé pour vérifier l’index choisi. Un index non choisi sera signalé comme tel et ne constituera pas une preuve de son utilisation ; aucun réglage ne sera utilisé pour forcer artificiellement son choix.

#### Mesure 1 — index simple, client 42

SQL : identique au bloc de lecture index simple, client 42.

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

#### Mesure 2 — index simple, client 42

SQL : identique au bloc de lecture index simple, client 42.

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

#### Mesure 3 — index simple, client 42

SQL : identique au bloc de lecture index simple, client 42.

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

#### Mesure 4 — index simple, client 42

SQL : identique au bloc de lecture index simple, client 42.

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

#### Mesure 5 — index simple, client 42

SQL : identique au bloc de lecture index simple, client 42.

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

Synthèse index simple, client 42 : moyenne **2,032 ms**, p50 **1,989 ms**, p95 empirique **2,907 ms**, minimum **1,323 ms**, maximum **2,907 ms**. Les cinq plans utilisent effectivement `idx_atelier3_client_simple` et retournent 20 lignes après récupération de 100 commandes, visite de 88 blocs de table et tri top-N de 27 kB. Les 90 accès aux blocs en cache sont inchangés. Aucun gain structurel ni gain de durée n’est démontré : moyenne et médiane sont supérieures à la référence initiale (1,177 et 1,061 ms).```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, created_at, statut, total
FROM shopflow.commandes
WHERE client_id = 1
ORDER BY created_at DESC, id DESC
LIMIT 20;
```

| Échauffement (exclu) | Mesure 1 | Mesure 2 | Mesure 3 | Mesure 4 | Mesure 5 |
|---|---|---|---|---|---|
| 2,994 ms | 2,050 ms | 1,785 ms | 2,033 ms | 1,737 ms | 1,492 ms |

#### Échauffement — index simple, client 1

SQL : identique au bloc de lecture index simple, client 1 ci-dessus.

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

Utilisation de l’index simple confirmée. Échauffement **2,994 ms**, exclu des cinq mesures. Le plan récupère 100 commandes sur 97 blocs de table distincts, puis retourne 20 lignes après tri top-N de 27 kB. Le nœud racine rapporte 99 accès aux blocs en cache, dont 2 pour l’index, sans shared read rapporté.

#### Mesure 1 — index simple, client 1

SQL : identique au bloc de lecture index simple, client 1.

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

#### Mesure 2 — index simple, client 1

SQL : identique au bloc de lecture index simple, client 1.

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

#### Mesure 3 — index simple, client 1

SQL : identique au bloc de lecture index simple, client 1.

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

#### Mesure 4 — index simple, client 1

SQL : identique au bloc de lecture index simple, client 1.

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

#### Mesure 5 — index simple, client 1

SQL : identique au bloc de lecture index simple, client 1.

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

Synthèse index simple, client 1 : moyenne **1,819 ms**, p50 **1,785 ms**, p95 empirique **2,050 ms**, minimum **1,492 ms**, maximum **2,050 ms**. Les cinq plans utilisent idx_atelier3_client_simple ; 100 commandes sont récupérées sur 97 blocs de table, puis triées en top-N (27 kB) pour retourner 20 lignes. Les 99 accès aux blocs en cache restent identiques à la référence initiale. La moyenne est proche de la référence initiale (1,803 ms), avec une médiane supérieure (1,656 ms initialement) : aucun gain de durée ni réduction du travail n’est démontré sur cette série.

### Contrôle du contenu — index simple, client 999

Les 20 lignes communiquées sont identiques à la référence initiale, pour toutes les colonnes et dans le même ordre : identifiants 83999 à 26999, dates du 21 septembre 2026 de 23:19:59 à 07:29:59 UTC, statut `payee`, montant 386,25 par ligne. Nombre de lignes et montant cumulé inchangés : **20**, **7 725,00**. Référence complète : [CSV du client 999](preuves/atelier3_reference_client999.csv).

### Mesures de lecture — index simple, client 999

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, created_at, statut, total
FROM shopflow.commandes
WHERE client_id = 999
ORDER BY created_at DESC, id DESC
LIMIT 20;
```

| Échauffement (exclu) | Mesure 1 | Mesure 2 | Mesure 3 | Mesure 4 | Mesure 5 |
|---|---|---|---|---|---|
| 2,047 ms | 1,773 ms | 1,666 ms | 1,886 ms | 1,707 ms | 1,155 ms |

#### Échauffement — index simple, client 999

SQL : identique au bloc de lecture index simple, client 999 ci-dessus.

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

Utilisation de idx_atelier3_client_simple confirmée par le Bitmap Index Scan. Échauffement de **2,047 ms**, exclu des cinq mesures. Le plan récupère 100 commandes réparties sur 95 blocs de table puis retourne 20 lignes après tri top-N de 27 kB. Il rapporte 97 accès aux blocs en cache, dont 2 pour l’index, sans shared read rapporté.

#### Mesure 1 — index simple, client 999

SQL : identique au bloc de lecture index simple, client 999.

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

#### Mesure 2 — index simple, client 999

SQL : identique au bloc de lecture index simple, client 999.

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

#### Mesure 3 — index simple, client 999

SQL : identique au bloc de lecture index simple, client 999.

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

#### Mesure 4 — index simple, client 999

SQL : identique au bloc de lecture index simple, client 999.

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

#### Mesure 5 — index simple, client 999

SQL : identique au bloc de lecture index simple, client 999.

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

Synthèse index simple, client 999 : moyenne **1,637 ms**, p50 **1,707 ms**, p95 empirique **1,886 ms**, minimum **1,155 ms**, maximum **1,886 ms**. Index simple utilisé dans les cinq plans ; 100 commandes récupérées sur 95 blocs de table, tri top-N de 27 kB, 20 lignes retournées et 97 accès aux blocs en cache. La moyenne est proche de la référence initiale (1,611 ms), avec une médiane supérieure (1,571 ms initialement). Aucun gain structurel ni gain de durée démontré.

## Annexe 4 — Atelier 4

## Atelier 4 — Index spécialisés

Source : diapositive 26 de `J02_Indexer_modeliser_migration.pptx`, exemples des diapositives 13, 16 et 18.

### Besoins et requêtes étudiés

- Index partiel B-tree sur les commandes en attente : comparer `statut = 'en_attente'` et `statut = 'payee'`, avec tri par `created_at, id` et limite de 100 lignes.
- Index GIN sur `produits.attributs` : tester la contenance JSONB avec `@>` et comparer avec une extraction de propriété via `->>` ; relever les résultats, les plans et les tailles.
- Index GiST sur des périodes `tstzrange` : tester le chevauchement avec `&&` sur deux périodes qui se chevauchent et une période disjointe.

### État initial

Index présents : `commandes_pkey`, `commandes_client_id_cle_idempotence_key`, `idx_atelier3_hist_couvrant` et `produits_pkey`. Aucun index partiel ou GIN dans l’inventaire transmis. L’index couvrant de l’atelier 3 est conservé.

Le rapport synthétise les résultats ; les plans complets seront conservés en annexe séparée.

### Index partiel

Taille observée : **335 872 octets (328 kB)**.

Création confirmée :

```sql
CREATE INDEX idx_atelier4_attente
ON shopflow.commandes (created_at, id)
WHERE statut = 'en_attente';
```

Filtre `statut = 'en_attente'`, tri `created_at, id`, `LIMIT 100` : **100 lignes**, **Index Only Scan sur idx_atelier4_attente**, **Heap Fetches = 0**, **Execution Time = 0,280 ms**. Buffers d’exécution : **1 hit, 2 read**. Le prédicat correspond et l’index fournit l’ordre sans tri.

[Plans complets](preuves/atelier4_plans.txt).

| Filtre | Plan observé | Lignes retournées | Execution Time | Buffers d’exécution |
|---|---|---:|---:|---|
| en_attente | Index Only Scan partiel, sans tri | 100 | 0,280 ms | hit=1, read=2 |
| payee | Parallel Seq Scan, tri top-N, Gather Merge | 100 | 46,722 ms | hit=1720 |

Le filtre `payee` n’implique pas le prédicat de l’index. Le parcours traite **80 000 commandes payées** (40 000 lignes en moyenne × 2 boucles). Ces deux exécutions portent sur des sous-ensembles différents ; leurs durées illustrent les chemins observés, sans constituer une comparaison avant/après du même résultat.

### Index GIN

Définition vérifiée dans `pg_indexes` : GIN sur `attributs`. Taille : **16 384 octets (16 kB)**.

Création confirmée (classe d’opérateurs par défaut `jsonb_ops`) :

```sql
CREATE INDEX idx_atelier4_attributs_gin
ON shopflow.produits USING gin (attributs);
```

Recherche `attributs @> '{"categorie":"livre"}'::jsonb` : **50 lignes**, **Seq Scan**, **0,199 ms**, **shared hit=3** ; 150 lignes écartées. Les 200 produits tiennent dans seulement 3 blocs déjà en mémoire. PostgreSQL estime qu’un parcours complet est moins coûteux que consulter le GIN puis accéder à la table ; il choisit donc un `Seq Scan`, malgré la compatibilité de `@>` avec cet index.

| Filtre | Compatibilité avec ce GIN | Plan | Lignes | Execution Time |
|---|---|---|---:|---:|
| `attributs @> '{"categorie":"livre"}'::jsonb` | Oui | Seq Scan | 50 | 0,199 ms |
| `attributs ->> 'categorie' = 'livre'` | Non, pas directement | Seq Scan | 50 | 0,207 ms |

Les deux parcours rapportent **shared hit=3**. Pour `->>`, estimation de **1 ligne** contre **50 observées**. Un index B-tree d’expression sur `(attributs ->> 'categorie')` correspondrait à cette seconde condition. Ces durées isolées ne démontrent pas un gain entre écritures.

Test proposé à plus grand volume : dans une copie dédiée, générer davantage de produits, exécuter `ANALYZE`, puis comparer le même filtre `@>` avant/après GIN avec échauffement et cinq répétitions. Tester plusieurs sélectivités, sans forcer le choix de l’index.

### Index GiST

Création confirmée : table `shopflow.atelier4_reservations` (`id bigint PRIMARY KEY`, `periode tstzrange NOT NULL`) et index `idx_atelier4_periode_gist` utilisant GiST sur `periode`.

Trois périodes créées le 10 octobre 2026, fuseau UTC+02 : **1 : 14 h–16 h**, **2 : 15 h–17 h**, **3 : 18 h–19 h**. Bornes `[)` : début inclus, fin exclue. L’opérateur `&&` teste le chevauchement.

Contrôle `periode && tstzrange('2026-10-10 14:00+02', '2026-10-10 16:00+02', '[)')` : **2 lignes**, identifiants **1 et 2** ; période 3 exclue. Affichage UTC : période 1 `[12:00,14:00)`, période 2 `[13:00,15:00)`, le 10 octobre 2026. Résultat conforme aux chevauchements attendus.

Plan observé : **Seq Scan**, **2 lignes**, **1 ligne écartée**, **shared hit=1**, **Execution Time=0,180 ms**. Les trois périodes tiennent dans un seul bloc en mémoire : le parcours complet est préféré au GiST, compatible avec `&&`.

Définition vérifiée : GiST sur `periode`. Taille : **8 192 octets (8 KiB)**.

### Décision

| Index | Opérateur / condition | Taille | Conclusion observée |
|---|---|---:|---|
| Partiel B-tree | `statut = 'en_attente'`, ordre `created_at, id` | 328 kB | Utilisé, sans tri ; exclu pour `payee` |
| GIN JSONB | `@>` ; extraction `->>` non directement couverte | 16 kB | Compatible avec `@>`, mais Seq Scan préféré sur 200 produits |
| GiST périodes | `&&` | 8 KiB | Chevauchement correct ; Seq Scan préféré sur 3 périodes |

Le choix dépend du filtre, de l’opérateur et du volume. La présence d’un index compatible ne garantit pas son utilisation. Les durées présentées sont celles des exécutions observées ; les plans complets sont conservés dans l’annexe.

## Annexe 5 — Atelier 4 : SQL et plans complets

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

## Annexe 6 — Atelier 3 : plans composé et couvrant du client 42

### Index composé — SQL

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, created_at, statut, total
FROM shopflow.commandes
WHERE client_id = 42
ORDER BY created_at DESC, id DESC
LIMIT 20;
```

#### Échauffement

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

#### Mesure 1

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

#### Mesure 2

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

#### Mesure 3

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

#### Mesure 4

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

#### Mesure 5

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

### Index couvrant — SQL

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, created_at, statut, total
FROM shopflow.commandes
WHERE client_id = 42
ORDER BY created_at DESC, id DESC
LIMIT 20;
```

#### Échauffement

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

#### Mesure 1

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

#### Mesure 2

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

#### Mesure 3

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

#### Mesure 4

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

#### Mesure 5

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

## Annexe 7 — Mesures brutes et résultats de référence

### atelier3_mesures.csv

```csv
etat,client_id,operation,phase,repetition,execution_time_ms
initial,42,lecture,echauffement,0,1.872
initial,42,lecture,mesure,1,1.834
initial,42,lecture,mesure,2,0.951
initial,42,lecture,mesure,3,1.113
initial,42,lecture,mesure,4,1.061
initial,42,lecture,mesure,5,0.928
initial,1,lecture,echauffement,0,5.29
initial,1,lecture,mesure,1,2.16
initial,1,lecture,mesure,2,1.656
initial,1,lecture,mesure,3,1.211
initial,1,lecture,mesure,4,2.336
initial,1,lecture,mesure,5,1.654
initial,999,lecture,echauffement,0,2.364
initial,999,lecture,mesure,1,1.309
initial,999,lecture,mesure,2,1.693
initial,999,lecture,mesure,3,1.22
initial,999,lecture,mesure,4,2.264
initial,999,lecture,mesure,5,1.571
initial,1/42/999,insertion_1000,echauffement,0,33.894
initial,1/42/999,insertion_1000,mesure,1,53.759
initial,1/42/999,insertion_1000,mesure,2,27.691
initial,1/42/999,insertion_1000,mesure,3,18.113
initial,1/42/999,insertion_1000,mesure,4,14.727
initial,1/42/999,insertion_1000,mesure,5,20.052
simple,42,lecture,echauffement,0,1.937
simple,42,lecture,mesure,1,1.498
simple,42,lecture,mesure,2,2.445
simple,42,lecture,mesure,3,2.907
simple,42,lecture,mesure,4,1.989
simple,42,lecture,mesure,5,1.323
simple,1,lecture,echauffement,0,2.994
simple,1,lecture,mesure,1,2.05
simple,1,lecture,mesure,2,1.785
simple,1,lecture,mesure,3,2.033
simple,1,lecture,mesure,4,1.737
simple,1,lecture,mesure,5,1.492
simple,999,lecture,echauffement,0,2.047
simple,999,lecture,mesure,1,1.773
simple,999,lecture,mesure,2,1.666
simple,999,lecture,mesure,3,1.886
simple,999,lecture,mesure,4,1.707
simple,999,lecture,mesure,5,1.155
simple,1/42/999,insertion_1000,echauffement,0,28.261
simple,1/42/999,insertion_1000,mesure,1,22.712
simple,1/42/999,insertion_1000,mesure,2,25.532
simple,1/42/999,insertion_1000,mesure,3,26.996
simple,1/42/999,insertion_1000,mesure,4,17.117
simple,1/42/999,insertion_1000,mesure,5,19.502
compose,42,lecture,echauffement,0,0.388
compose,42,lecture,mesure,1,0.496
compose,42,lecture,mesure,2,0.684
compose,42,lecture,mesure,3,0.227
compose,42,lecture,mesure,4,0.562
compose,42,lecture,mesure,5,0.427
couvrant,42,lecture,echauffement,0,0.192
couvrant,42,lecture,mesure,1,0.406
couvrant,42,lecture,mesure,2,0.225
couvrant,42,lecture,mesure,3,0.234
couvrant,42,lecture,mesure,4,0.229
couvrant,42,lecture,mesure,5,0.375

```

### atelier3_reference_client1.csv

```csv
rang,id,created_at,statut,total
1,86001,2026-08-26 23:53:21+00,annulee,86.25
2,83001,2026-08-26 23:03:21+00,annulee,86.25
3,80001,2026-08-26 22:13:21+00,annulee,86.25
4,77001,2026-08-26 21:23:21+00,annulee,86.25
5,74001,2026-08-26 20:33:21+00,annulee,86.25
6,71001,2026-08-26 19:43:21+00,annulee,86.25
7,68001,2026-08-26 18:53:21+00,annulee,86.25
8,65001,2026-08-26 18:03:21+00,annulee,86.25
9,62001,2026-08-26 17:13:21+00,annulee,86.25
10,59001,2026-08-26 16:23:21+00,annulee,86.25
11,56001,2026-08-26 15:33:21+00,annulee,86.25
12,53001,2026-08-26 14:43:21+00,annulee,86.25
13,50001,2026-08-26 13:53:21+00,annulee,86.25
14,47001,2026-08-26 13:03:21+00,annulee,86.25
15,44001,2026-08-26 12:13:21+00,annulee,86.25
16,41001,2026-08-26 11:23:21+00,annulee,86.25
17,38001,2026-08-26 10:33:21+00,annulee,86.25
18,35001,2026-08-26 09:43:21+00,annulee,86.25
19,32001,2026-08-26 08:53:21+00,annulee,86.25
20,29001,2026-08-26 08:03:21+00,annulee,86.25

```

### atelier3_reference_client42.csv

```csv
rang,id,created_at,statut,total
1,86042,2026-09-12 23:54:02+00,payee,720.00
2,83042,2026-09-12 23:04:02+00,payee,720.00
3,80042,2026-09-12 22:14:02+00,payee,720.00
4,77042,2026-09-12 21:24:02+00,payee,720.00
5,74042,2026-09-12 20:34:02+00,payee,720.00
6,71042,2026-09-12 19:44:02+00,payee,720.00
7,68042,2026-09-12 18:54:02+00,payee,720.00
8,65042,2026-09-12 18:04:02+00,payee,720.00
9,62042,2026-09-12 17:14:02+00,payee,720.00
10,59042,2026-09-12 16:24:02+00,payee,720.00
11,56042,2026-09-12 15:34:02+00,payee,720.00
12,53042,2026-09-12 14:44:02+00,payee,720.00
13,50042,2026-09-12 13:54:02+00,payee,720.00
14,47042,2026-09-12 13:04:02+00,payee,720.00
15,44042,2026-09-12 12:14:02+00,payee,720.00
16,41042,2026-09-12 11:24:02+00,payee,720.00
17,38042,2026-09-12 10:34:02+00,payee,720.00
18,35042,2026-09-12 09:44:02+00,payee,720.00
19,32042,2026-09-12 08:54:02+00,payee,720.00
20,29042,2026-09-12 08:04:02+00,payee,720.00

```

### atelier3_reference_client999.csv

```csv
rang,id,created_at,statut,total
1,83999,2026-09-21 23:19:59+00,payee,386.25
2,80999,2026-09-21 22:29:59+00,payee,386.25
3,77999,2026-09-21 21:39:59+00,payee,386.25
4,74999,2026-09-21 20:49:59+00,payee,386.25
5,71999,2026-09-21 19:59:59+00,payee,386.25
6,68999,2026-09-21 19:09:59+00,payee,386.25
7,65999,2026-09-21 18:19:59+00,payee,386.25
8,62999,2026-09-21 17:29:59+00,payee,386.25
9,59999,2026-09-21 16:39:59+00,payee,386.25
10,56999,2026-09-21 15:49:59+00,payee,386.25
11,53999,2026-09-21 14:59:59+00,payee,386.25
12,50999,2026-09-21 14:09:59+00,payee,386.25
13,47999,2026-09-21 13:19:59+00,payee,386.25
14,44999,2026-09-21 12:29:59+00,payee,386.25
15,41999,2026-09-21 11:39:59+00,payee,386.25
16,38999,2026-09-21 10:49:59+00,payee,386.25
17,35999,2026-09-21 09:59:59+00,payee,386.25
18,32999,2026-09-21 09:09:59+00,payee,386.25
19,29999,2026-09-21 08:19:59+00,payee,386.25
20,26999,2026-09-21 07:29:59+00,payee,386.25

```

### atelier3_synthese.csv

```csv
etat,client_id,operation,n,moyenne_ms,p50_ms,p95_empirique_ms,min_ms,max_ms,ecart_type_population_ms
initial,42,lecture,5,1.177,1.061,1.834,0.928,1.834,0.335
initial,1,lecture,5,1.803,1.656,2.336,1.211,2.336,0.401
initial,999,lecture,5,1.611,1.571,2.264,1.22,2.264,0.368
initial,1/42/999,insertion_1000,5,26.868,20.052,53.759,14.727,53.759,14.102
simple,42,lecture,5,2.032,1.989,2.907,1.323,2.907,0.588
simple,1,lecture,5,1.819,1.785,2.05,1.492,2.05,0.207
simple,999,lecture,5,1.637,1.707,1.886,1.155,1.886,0.252
simple,1/42/999,insertion_1000,5,22.372,22.712,26.996,17.117,26.996,3.67
compose,42,lecture,5,0.479,0.496,0.684,0.227,0.684,0.152
couvrant,42,lecture,5,0.294,0.234,0.406,0.225,0.406,0.08

```

### atelier3_tailles_index.csv

```csv
etat,index,taille_octets,taille_lisible
initial,commandes_client_id_cle_idempotence_key,1908736,1864 kB
initial,commandes_pkey,4513792,4408 kB
simple,commandes_client_id_cle_idempotence_key,2015232,1968 kB
simple,commandes_pkey,4554752,4448 kB
simple,idx_atelier3_client_simple,704512,688 kB
compose,commandes_client_id_cle_idempotence_key,2113536,2064 kB
compose,commandes_pkey,4579328,4472 kB
compose,idx_atelier3_hist_compose,4079616,3984 kB
couvrant,commandes_client_id_cle_idempotence_key,2113536,2064 kB
couvrant,commandes_pkey,4579328,4472 kB
couvrant,idx_atelier3_hist_couvrant,5931008,5792 kB

```

### atelier4_mesures.csv

```csv
scenario,plan,lignes,execution_time_ms,shared_hit,shared_read
partiel_en_attente,Index Only Scan,100,0.28,1,2
partiel_payee,Parallel Seq Scan + Sort + Gather Merge,100,46.722,1720,0
gin_contenance,Seq Scan,50,0.199,3,0
gin_extraction,Seq Scan,50,0.207,3,0
gist_chevauchement,Seq Scan,2,0.18,1,0

```

### mesures.csv

```csv
atelier,variante,phase,repetition,execution_time_ms
atelier1,historique_client42,echauffement,0,1.466
atelier1,historique_client42,mesure,1,0.827
atelier1,historique_client42,mesure,2,1.737
atelier1,historique_client42,mesure,3,2.474
atelier1,historique_client42,mesure,4,1.829
atelier1,historique_client42,mesure,5,1.607
atelier1,agregation_statut,echauffement,0,54.149
atelier1,agregation_statut,mesure,1,42.761
atelier1,agregation_statut,mesure,2,41.124
atelier1,agregation_statut,mesure,3,61.019
atelier1,agregation_statut,mesure,4,48.577
atelier1,agregation_statut,mesure,5,54.799
atelier2,join_distinct,echauffement,0,0.616
atelier2,join_distinct,mesure,1,0.455
atelier2,join_distinct,mesure,2,0.245
atelier2,join_distinct,mesure,3,0.295
atelier2,exists,echauffement,0,0.479
atelier2,exists,mesure,1,0.219
atelier2,exists,mesure,2,0.384
atelier2,exists,mesure,3,0.296
atelier2,agregation_apres_jointure,echauffement,0,1.354
atelier2,agregation_apres_jointure,mesure,1,0.849
atelier2,agregation_apres_jointure,mesure,2,0.448
atelier2,agregation_apres_jointure,mesure,3,0.609
atelier2,preagregation,echauffement,0,1.563
atelier2,preagregation,mesure,1,0.575
atelier2,preagregation,mesure,2,0.437
atelier2,preagregation,mesure,3,0.577
atelier2,join_distinct,mesure,4,0.862
atelier2,join_distinct,mesure,5,0.366
atelier2,exists,mesure,4,0.498
atelier2,exists,mesure,5,0.459
atelier2,agregation_apres_jointure,mesure,4,0.46
atelier2,agregation_apres_jointure,mesure,5,1.296
atelier2,preagregation,mesure,4,0.293
atelier2,preagregation,mesure,5,1.228

```

### synthese.csv

```csv
atelier,variante,n,moyenne_ms,p50_ms,p95_empirique_ms,min_ms,max_ms,ecart_type_population_ms
atelier1,historique_client42,5,1.695,1.737,2.474,0.827,2.474,0.527
atelier1,agregation_statut,5,49.656,48.577,61.019,41.124,61.019,7.444
atelier2,join_distinct,5,0.445,0.366,0.862,0.245,0.862,0.22
atelier2,exists,5,0.371,0.384,0.498,0.219,0.498,0.103
atelier2,agregation_apres_jointure,5,0.732,0.609,1.296,0.448,1.296,0.317
atelier2,preagregation,5,0.622,0.575,1.228,0.293,1.228,0.321

```

## Annexe 8 — Graphiques intégrés

### graphique_mesures.svg

<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="700" viewBox="0 0 1000 700">
<rect width="1000" height="700" fill="white"/>
<style>text{font-family:Arial,sans-serif;fill:#17243a}.label{font-size:14px}</style>
<text x="35" y="32" font-size="22">ShopFlow — cinq mesures par variante après échauffement</text>
<text x="35" y="55" font-size="13">Points : répétitions • trait vertical : médiane • échelles différentes selon le panneau</text>
<text x="35" y="90" font-size="17">Atelier 1 : historique du client 42</text>
<line x1="280" y1="105" x2="280" y2="245" stroke="#e3e7ed"/><text x="280" y="265" font-size="12" text-anchor="middle">0 ms</text>
<line x1="410" y1="105" x2="410" y2="245" stroke="#e3e7ed"/><text x="410" y="265" font-size="12" text-anchor="middle">0.6 ms</text>
<line x1="540" y1="105" x2="540" y2="245" stroke="#e3e7ed"/><text x="540" y="265" font-size="12" text-anchor="middle">1.2 ms</text>
<line x1="670" y1="105" x2="670" y2="245" stroke="#e3e7ed"/><text x="670" y="265" font-size="12" text-anchor="middle">1.8 ms</text>
<line x1="800" y1="105" x2="800" y2="245" stroke="#e3e7ed"/><text x="800" y="265" font-size="12" text-anchor="middle">2.4 ms</text>
<line x1="930" y1="105" x2="930" y2="245" stroke="#e3e7ed"/><text x="930" y="265" font-size="12" text-anchor="middle">3 ms</text>
<text class="label" x="35" y="130">historique_client42</text>
<circle cx="459.18" cy="125" r="5" fill="#167ca1" fill-opacity="0.7"/>
<circle cx="656.35" cy="125" r="5" fill="#167ca1" fill-opacity="0.7"/>
<circle cx="816.03" cy="125" r="5" fill="#167ca1" fill-opacity="0.7"/>
<circle cx="676.28" cy="125" r="5" fill="#167ca1" fill-opacity="0.7"/>
<circle cx="628.18" cy="125" r="5" fill="#167ca1" fill-opacity="0.7"/>
<line x1="656.3499999999999" y1="115" x2="656.3499999999999" y2="135" stroke="#a43c21" stroke-width="3"/>
<text x="35" y="280" font-size="17">Atelier 1 : agrégation par statut</text>
<line x1="280" y1="295" x2="280" y2="435" stroke="#e3e7ed"/><text x="280" y="455" font-size="12" text-anchor="middle">0 ms</text>
<line x1="410" y1="295" x2="410" y2="435" stroke="#e3e7ed"/><text x="410" y="455" font-size="12" text-anchor="middle">14 ms</text>
<line x1="540" y1="295" x2="540" y2="435" stroke="#e3e7ed"/><text x="540" y="455" font-size="12" text-anchor="middle">28 ms</text>
<line x1="670" y1="295" x2="670" y2="435" stroke="#e3e7ed"/><text x="670" y="455" font-size="12" text-anchor="middle">42 ms</text>
<line x1="800" y1="295" x2="800" y2="435" stroke="#e3e7ed"/><text x="800" y="455" font-size="12" text-anchor="middle">56 ms</text>
<line x1="930" y1="295" x2="930" y2="435" stroke="#e3e7ed"/><text x="930" y="455" font-size="12" text-anchor="middle">70 ms</text>
<text class="label" x="35" y="320">agregation_statut</text>
<circle cx="677.07" cy="315" r="5" fill="#167ca1" fill-opacity="0.7"/>
<circle cx="661.87" cy="315" r="5" fill="#167ca1" fill-opacity="0.7"/>
<circle cx="846.61" cy="315" r="5" fill="#167ca1" fill-opacity="0.7"/>
<circle cx="731.07" cy="315" r="5" fill="#167ca1" fill-opacity="0.7"/>
<circle cx="788.85" cy="315" r="5" fill="#167ca1" fill-opacity="0.7"/>
<line x1="731.0721428571428" y1="305" x2="731.0721428571428" y2="325" stroke="#a43c21" stroke-width="3"/>
<text x="35" y="470" font-size="17">Atelier 2 : variantes équivalentes</text>
<line x1="280" y1="485" x2="280" y2="625" stroke="#e3e7ed"/><text x="280" y="645" font-size="12" text-anchor="middle">0 ms</text>
<line x1="410" y1="485" x2="410" y2="625" stroke="#e3e7ed"/><text x="410" y="645" font-size="12" text-anchor="middle">0.3 ms</text>
<line x1="540" y1="485" x2="540" y2="625" stroke="#e3e7ed"/><text x="540" y="645" font-size="12" text-anchor="middle">0.6 ms</text>
<line x1="670" y1="485" x2="670" y2="625" stroke="#e3e7ed"/><text x="670" y="645" font-size="12" text-anchor="middle">0.9 ms</text>
<line x1="800" y1="485" x2="800" y2="625" stroke="#e3e7ed"/><text x="800" y="645" font-size="12" text-anchor="middle">1.2 ms</text>
<line x1="930" y1="485" x2="930" y2="625" stroke="#e3e7ed"/><text x="930" y="645" font-size="12" text-anchor="middle">1.5 ms</text>
<text class="label" x="35" y="510">join_distinct</text>
<circle cx="477.17" cy="505" r="5" fill="#167ca1" fill-opacity="0.7"/>
<circle cx="386.17" cy="505" r="5" fill="#167ca1" fill-opacity="0.7"/>
<circle cx="407.83" cy="505" r="5" fill="#167ca1" fill-opacity="0.7"/>
<circle cx="653.53" cy="505" r="5" fill="#167ca1" fill-opacity="0.7"/>
<circle cx="438.60" cy="505" r="5" fill="#167ca1" fill-opacity="0.7"/>
<line x1="438.6" y1="495" x2="438.6" y2="515" stroke="#a43c21" stroke-width="3"/>
<text class="label" x="35" y="543">exists</text>
<circle cx="374.90" cy="538" r="5" fill="#167ca1" fill-opacity="0.7"/>
<circle cx="446.40" cy="538" r="5" fill="#167ca1" fill-opacity="0.7"/>
<circle cx="408.27" cy="538" r="5" fill="#167ca1" fill-opacity="0.7"/>
<circle cx="495.80" cy="538" r="5" fill="#167ca1" fill-opacity="0.7"/>
<circle cx="478.90" cy="538" r="5" fill="#167ca1" fill-opacity="0.7"/>
<line x1="446.4" y1="528" x2="446.4" y2="548" stroke="#a43c21" stroke-width="3"/>
<text class="label" x="35" y="576">agregation_apres_jointure</text>
<circle cx="647.90" cy="571" r="5" fill="#167ca1" fill-opacity="0.7"/>
<circle cx="474.13" cy="571" r="5" fill="#167ca1" fill-opacity="0.7"/>
<circle cx="543.90" cy="571" r="5" fill="#167ca1" fill-opacity="0.7"/>
<circle cx="479.33" cy="571" r="5" fill="#167ca1" fill-opacity="0.7"/>
<circle cx="841.60" cy="571" r="5" fill="#167ca1" fill-opacity="0.7"/>
<line x1="543.9" y1="561" x2="543.9" y2="581" stroke="#a43c21" stroke-width="3"/>
<text class="label" x="35" y="609">preagregation</text>
<circle cx="529.17" cy="604" r="5" fill="#167ca1" fill-opacity="0.7"/>
<circle cx="469.37" cy="604" r="5" fill="#167ca1" fill-opacity="0.7"/>
<circle cx="530.03" cy="604" r="5" fill="#167ca1" fill-opacity="0.7"/>
<circle cx="406.97" cy="604" r="5" fill="#167ca1" fill-opacity="0.7"/>
<circle cx="812.13" cy="604" r="5" fill="#167ca1" fill-opacity="0.7"/>
<line x1="529.1666666666666" y1="594" x2="529.1666666666666" y2="614" stroke="#a43c21" stroke-width="3"/>
</svg>

### atelier3_graphique.svg

<svg xmlns="http://www.w3.org/2000/svg" width="950" height="330"><rect width="950" height="330" fill="white"/><style>text{font-family:Arial;fill:#17243a}</style><text x="25" y="30" font-size="21">Atelier 3 — lecture du client 42, cinq mesures par état</text><text x="25" y="55" font-size="13">Points : répétitions ; trait rouge : médiane ; durées hors échauffement</text>
<line x1="200" y1="75" x2="200" y2="270" stroke="#eee"/><text x="200" y="300" font-size="12" text-anchor="middle">0 ms</text>
<line x1="310" y1="75" x2="310" y2="270" stroke="#eee"/><text x="310" y="300" font-size="12" text-anchor="middle">0.5 ms</text>
<line x1="420" y1="75" x2="420" y2="270" stroke="#eee"/><text x="420" y="300" font-size="12" text-anchor="middle">1 ms</text>
<line x1="530" y1="75" x2="530" y2="270" stroke="#eee"/><text x="530" y="300" font-size="12" text-anchor="middle">1.5 ms</text>
<line x1="640" y1="75" x2="640" y2="270" stroke="#eee"/><text x="640" y="300" font-size="12" text-anchor="middle">2 ms</text>
<line x1="750" y1="75" x2="750" y2="270" stroke="#eee"/><text x="750" y="300" font-size="12" text-anchor="middle">2.5 ms</text>
<line x1="860" y1="75" x2="860" y2="270" stroke="#eee"/><text x="860" y="300" font-size="12" text-anchor="middle">3 ms</text>
<text x="25" y="105" font-size="16">Initial</text>
<circle cx="603.48" cy="100" r="5" fill="#167ca1"/>
<circle cx="409.22" cy="100" r="5" fill="#167ca1"/>
<circle cx="444.86" cy="100" r="5" fill="#167ca1"/>
<circle cx="433.41999999999996" cy="100" r="5" fill="#167ca1"/>
<circle cx="404.15999999999997" cy="100" r="5" fill="#167ca1"/>
<line x1="433.41999999999996" x2="433.41999999999996" y1="88" y2="112" stroke="#a43c21" stroke-width="3"/>
<text x="25" y="155" font-size="16">Simple</text>
<circle cx="529.56" cy="150" r="5" fill="#167ca1"/>
<circle cx="737.9" cy="150" r="5" fill="#167ca1"/>
<circle cx="839.54" cy="150" r="5" fill="#167ca1"/>
<circle cx="637.58" cy="150" r="5" fill="#167ca1"/>
<circle cx="491.06" cy="150" r="5" fill="#167ca1"/>
<line x1="637.58" x2="637.58" y1="138" y2="162" stroke="#a43c21" stroke-width="3"/>
<text x="25" y="205" font-size="16">Composé</text>
<circle cx="309.12" cy="200" r="5" fill="#167ca1"/>
<circle cx="350.48" cy="200" r="5" fill="#167ca1"/>
<circle cx="249.94" cy="200" r="5" fill="#167ca1"/>
<circle cx="323.64" cy="200" r="5" fill="#167ca1"/>
<circle cx="293.94" cy="200" r="5" fill="#167ca1"/>
<line x1="309.12" x2="309.12" y1="188" y2="212" stroke="#a43c21" stroke-width="3"/>
<text x="25" y="255" font-size="16">Couvrant</text>
<circle cx="289.32" cy="250" r="5" fill="#167ca1"/>
<circle cx="249.5" cy="250" r="5" fill="#167ca1"/>
<circle cx="251.48000000000002" cy="250" r="5" fill="#167ca1"/>
<circle cx="250.38" cy="250" r="5" fill="#167ca1"/>
<circle cx="282.5" cy="250" r="5" fill="#167ca1"/>
<line x1="251.48000000000002" x2="251.48000000000002" y1="238" y2="262" stroke="#a43c21" stroke-width="3"/>
</svg>

## Annexe 9 — Insertion avec index simple : plans complets

SQL : lot de 1 000 commandes entre BEGIN et ROLLBACK reproduit dans l’annexe de l’atelier 3. Le premier plan de mesure transmis deux fois est compté une seule fois.

### Échauffement

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

### Mesure 1

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

### Mesure 2

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

### Mesure 3

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

### Mesure 4

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

### Mesure 5

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
