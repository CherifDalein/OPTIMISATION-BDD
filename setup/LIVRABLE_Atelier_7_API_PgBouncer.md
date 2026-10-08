# Atelier 7 — API et mutualisation des connexions

## 1. Contrat et état initial

API ShopFlow sur port 3000, client autorisé **42**, **100 commandes**. `/observations` : HTTP 200, Redis prêt. Client fixé par le contexte pédagogique `LAB_CLIENT_ID`, pas par l’URL. Ordre : `created_at DESC, id DESC`. Limite par défaut 20, maximum 100. Réponse : `data`, `hasNextPage`, `nextCursor`. Identifiants et montants : chaînes JSON ; dates UTC à six chiffres de microsecondes. Curseur signé, lié au client.

## 2. Relations : tester N+1, appliquer le groupé, comparer

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

## 3. Pagination : tester OFFSET, comparer au curseur

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

## 4. Exactitude : égalité de dates, parcours et accès

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

## 5. PgBouncer : état direct, solution et méthode

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

### 40 clients persistants

| Chemin | TPS 1 / 2 / 3 | Médiane TPS | Latences moyennes 1 / 2 / 3 ms | Médiane ms | Pic serveur échantillonné | Échecs |
|---|---|---:|---|---:|---:|---:|
| Direct | 256,494 / 255,366 / 257,705 | 256,494 | 155,461 / 155,877 / 154,729 | 155,461 | 40 | 0 |
| Pool | 94,695 / 94,552 / 94,615 | 94,615 | 418,449 / 419,232 / 418,915 | 418,915 | 5 | 0 |
### 10 clients avec reconnexions

| Chemin | TPS 1 / 2 / 3 | Médiane TPS | Latences moyennes 1 / 2 / 3 ms | Médiane ms | Pic serveur échantillonné | Échecs |
|---|---|---:|---|---:|---:|---:|
| Direct | 48,414 / 47,999 / 48,933 | 48,414 | 172,510 / 173,885 / 173,841 | 173,841 | 10 | 0 |
| Pool | 50,487 / 49,869 / 53,835 | 50,487 | 175,122 / 176,305 / 168,138 | 175,122 | 5 | 0 |

**40 clients :** trace pooling/atelier avec cl_waiting=25, sv_active=5, sv_idle=0, maxwait_us=220128. Les sessions passent de 40 à 5 ; cinq transactions occupées 50 ms limitent le débit théorique à environ 100/s. L’attente explique l’augmentation de latence. **10 clients/reconnexions :** sessions 10 → 5, débit médian légèrement supérieur, sans baisse uniforme de latence.

### Saturation : 80 clients

| Chemin | Preuve | Résultat |
|---|---|---|
| Direct | FATAL: remaining connection slots are reserved for roles with the SUPERUSER attribute ; client 68 refusé | Code 1, essai interrompu |
| Pool | 5 sessions ; 65 clients en attente, maxwait_us=688754 | Code 0 ; 1 917 transactions, zéro échec ; 93,828 TPS ; 835,628 ms |

L’échantillon direct à zéro est insuffisant pour décrire les sessions ouvertes avant le refus. Un essai interrompu ne fournit pas un débit comparable à une campagne complète.

## 6. Décision

Retenir le chargement groupé : contenu identique et 21 → 2 SQL. Le curseur date/id garantit le cas d’égalité testé. PgBouncer limite les sessions et évite le refus à 80 clients, au prix d’une file d’attente ; il ne corrige ni N+1 ni les index. Un dimensionnement plus grand pourrait réduire l’attente, à vérifier par cl_waiting, latence, TPS et ressources serveur. En mode transaction, l’état de session ne doit pas être supposé conservé entre transactions.

Arrêt confirmé avec `node pooling.mjs down` : conteneurs et réseau du labo supprimés, volume conservé. Dates ShopFlow restaurées. Les campagnes de 20 secondes décrivent ce scénario pédagogique.

## Annexes — Réponses, traces et campagnes complètes

### api_traces.jsonl

```json
{"trace":"dd85795e-532d-4ed2-ad98-870186cf1632","route":"/observations","status":200,"sqlCount":0,"sqlMs":0,"durationMs":3.891,"poolWaiting":0}
{"trace":"64e6d66f-a8e3-46eb-9148-307a9760b1e0","route":"/observations","status":200,"sqlCount":0,"sqlMs":0,"durationMs":1.954,"poolWaiting":0}
{"trace":"898dcaab-ee60-44eb-bc2c-b0c78620b621","route":"/commandes?limit=20&pagination=curseur&relations=n1","status":200,"sqlCount":21,"sqlMs":76.884,"durationMs":81.344,"poolWaiting":0}
{"trace":"74ca8b34-459b-4054-bbc9-e173db5007ed","route":"/commandes?limit=20&pagination=curseur&relations=groupe","status":200,"sqlCount":2,"sqlMs":60.852,"durationMs":67.322,"poolWaiting":0}
{"trace":"04e5f5e3-cca0-422a-807c-a0dbde5666c6","route":"/commandes?limit=20&relations=groupe","status":200,"sqlCount":2,"sqlMs":25.445,"durationMs":29.856,"poolWaiting":0}
{"trace":"0af7d1e3-16e6-44f9-94f5-0073a9055097","route":"/commandes?limit=20&cursor=eyJ2IjoxLCJjbGllbnRJZCI6IjQyIiwiZGF0ZSI6IjIwMjYtMDktMTJUMDg6MDQ6MDIuMDAwMDAwWiIsImlkIjoiMjkwNDIifQ.-8akB0gWWnMKadehIh_owEhG5gkmQREIWKs9j8hbO0M&relations=groupe","status":200,"sqlCount":2,"sqlMs":42.684,"durationMs":46.102,"poolWaiting":0}
{"trace":"741c4d70-0716-47ab-8e2c-7e045323433a","route":"/commandes?limit=20&pagination=offset&offset=20&relations=groupe","status":200,"sqlCount":2,"sqlMs":25.77,"durationMs":28.667,"poolWaiting":0}

```

### atelier07_api_reponses.jsonl

```json
{"Label":"n1_20","Status":200,"SqlCount":21,"Cache":"","HttpMs":143.018,"TraceId":"898dcaab-ee60-44eb-bc2c-b0c78620b621","Body":{"data":[{"id":"86042","created_at":"2026-09-12T23:54:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"86042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"86042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"86042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"83042","created_at":"2026-09-12T23:04:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"83042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"83042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"83042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"80042","created_at":"2026-09-12T22:14:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"80042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"80042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"80042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"77042","created_at":"2026-09-12T21:24:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"77042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"77042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"77042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"74042","created_at":"2026-09-12T20:34:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"74042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"74042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"74042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"71042","created_at":"2026-09-12T19:44:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"71042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"71042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"71042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"68042","created_at":"2026-09-12T18:54:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"68042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"68042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"68042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"65042","created_at":"2026-09-12T18:04:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"65042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"65042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"65042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"62042","created_at":"2026-09-12T17:14:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"62042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"62042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"62042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"59042","created_at":"2026-09-12T16:24:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"59042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"59042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"59042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"56042","created_at":"2026-09-12T15:34:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"56042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"56042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"56042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"53042","created_at":"2026-09-12T14:44:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"53042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"53042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"53042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"50042","created_at":"2026-09-12T13:54:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"50042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"50042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"50042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"47042","created_at":"2026-09-12T13:04:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"47042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"47042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"47042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"44042","created_at":"2026-09-12T12:14:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"44042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"44042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"44042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"41042","created_at":"2026-09-12T11:24:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"41042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"41042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"41042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"38042","created_at":"2026-09-12T10:34:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"38042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"38042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"38042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"35042","created_at":"2026-09-12T09:44:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"35042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"35042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"35042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"32042","created_at":"2026-09-12T08:54:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"32042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"32042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"32042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"29042","created_at":"2026-09-12T08:04:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"29042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"29042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"29042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]}],"hasNextPage":true,"nextCursor":"eyJ2IjoxLCJjbGllbnRJZCI6IjQyIiwiZGF0ZSI6IjIwMjYtMDktMTJUMDg6MDQ6MDIuMDAwMDAwWiIsImlkIjoiMjkwNDIifQ.-8akB0gWWnMKadehIh_owEhG5gkmQREIWKs9j8hbO0M"}}
{"Label":"groupe_20","Status":200,"SqlCount":2,"Cache":"","HttpMs":144.114,"TraceId":"74ca8b34-459b-4054-bbc9-e173db5007ed","Body":{"data":[{"id":"86042","created_at":"2026-09-12T23:54:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"86042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"86042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"86042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"83042","created_at":"2026-09-12T23:04:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"83042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"83042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"83042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"80042","created_at":"2026-09-12T22:14:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"80042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"80042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"80042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"77042","created_at":"2026-09-12T21:24:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"77042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"77042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"77042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"74042","created_at":"2026-09-12T20:34:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"74042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"74042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"74042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"71042","created_at":"2026-09-12T19:44:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"71042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"71042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"71042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"68042","created_at":"2026-09-12T18:54:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"68042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"68042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"68042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"65042","created_at":"2026-09-12T18:04:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"65042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"65042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"65042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"62042","created_at":"2026-09-12T17:14:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"62042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"62042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"62042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"59042","created_at":"2026-09-12T16:24:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"59042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"59042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"59042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"56042","created_at":"2026-09-12T15:34:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"56042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"56042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"56042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"53042","created_at":"2026-09-12T14:44:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"53042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"53042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"53042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"50042","created_at":"2026-09-12T13:54:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"50042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"50042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"50042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"47042","created_at":"2026-09-12T13:04:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"47042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"47042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"47042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"44042","created_at":"2026-09-12T12:14:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"44042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"44042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"44042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"41042","created_at":"2026-09-12T11:24:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"41042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"41042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"41042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"38042","created_at":"2026-09-12T10:34:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"38042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"38042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"38042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"35042","created_at":"2026-09-12T09:44:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"35042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"35042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"35042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"32042","created_at":"2026-09-12T08:54:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"32042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"32042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"32042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"29042","created_at":"2026-09-12T08:04:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"29042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"29042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"29042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]}],"hasNextPage":true,"nextCursor":"eyJ2IjoxLCJjbGllbnRJZCI6IjQyIiwiZGF0ZSI6IjIwMjYtMDktMTJUMDg6MDQ6MDIuMDAwMDAwWiIsImlkIjoiMjkwNDIifQ.-8akB0gWWnMKadehIh_owEhG5gkmQREIWKs9j8hbO0M"}}
{"Label":"curseur_p1","Status":200,"SqlCount":2,"Cache":"","HttpMs":99.194,"TraceId":"04e5f5e3-cca0-422a-807c-a0dbde5666c6","Body":{"data":[{"id":"86042","created_at":"2026-09-12T23:54:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"86042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"86042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"86042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"83042","created_at":"2026-09-12T23:04:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"83042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"83042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"83042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"80042","created_at":"2026-09-12T22:14:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"80042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"80042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"80042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"77042","created_at":"2026-09-12T21:24:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"77042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"77042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"77042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"74042","created_at":"2026-09-12T20:34:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"74042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"74042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"74042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"71042","created_at":"2026-09-12T19:44:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"71042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"71042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"71042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"68042","created_at":"2026-09-12T18:54:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"68042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"68042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"68042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"65042","created_at":"2026-09-12T18:04:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"65042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"65042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"65042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"62042","created_at":"2026-09-12T17:14:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"62042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"62042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"62042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"59042","created_at":"2026-09-12T16:24:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"59042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"59042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"59042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"56042","created_at":"2026-09-12T15:34:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"56042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"56042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"56042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"53042","created_at":"2026-09-12T14:44:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"53042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"53042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"53042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"50042","created_at":"2026-09-12T13:54:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"50042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"50042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"50042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"47042","created_at":"2026-09-12T13:04:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"47042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"47042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"47042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"44042","created_at":"2026-09-12T12:14:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"44042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"44042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"44042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"41042","created_at":"2026-09-12T11:24:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"41042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"41042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"41042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"38042","created_at":"2026-09-12T10:34:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"38042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"38042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"38042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"35042","created_at":"2026-09-12T09:44:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"35042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"35042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"35042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"32042","created_at":"2026-09-12T08:54:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"32042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"32042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"32042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"29042","created_at":"2026-09-12T08:04:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"29042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"29042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"29042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]}],"hasNextPage":true,"nextCursor":"eyJ2IjoxLCJjbGllbnRJZCI6IjQyIiwiZGF0ZSI6IjIwMjYtMDktMTJUMDg6MDQ6MDIuMDAwMDAwWiIsImlkIjoiMjkwNDIifQ.-8akB0gWWnMKadehIh_owEhG5gkmQREIWKs9j8hbO0M"}}
{"Label":"curseur_p2","Status":200,"SqlCount":2,"Cache":"","HttpMs":70.89,"TraceId":"0af7d1e3-16e6-44f9-94f5-0073a9055097","Body":{"data":[{"id":"26042","created_at":"2026-09-12T07:14:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"26042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"26042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"26042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"23042","created_at":"2026-09-12T06:24:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"23042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"23042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"23042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"20042","created_at":"2026-09-12T05:34:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"20042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"20042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"20042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"17042","created_at":"2026-09-12T04:44:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"17042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"17042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"17042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"14042","created_at":"2026-09-12T03:54:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"14042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"14042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"14042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"98042","created_at":"2026-09-12T03:14:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"98042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"98042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"98042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"11042","created_at":"2026-09-12T03:04:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"11042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"11042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"11042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"95042","created_at":"2026-09-12T02:24:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"95042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"95042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"95042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"8042","created_at":"2026-09-12T02:14:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"8042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"8042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"8042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"92042","created_at":"2026-09-12T01:34:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"92042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"92042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"92042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"5042","created_at":"2026-09-12T01:24:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"5042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"5042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"5042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"89042","created_at":"2026-09-12T00:44:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"89042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"89042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"89042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"2042","created_at":"2026-09-12T00:34:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"2042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"2042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"2042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"85042","created_at":"2026-06-04T23:37:22.000000Z","statut":"payee","total":"480.00","lignes":[{"commande_id":"85042","produit_id":"43","qte":2,"prix_unitaire":"58.75"},{"commande_id":"85042","produit_id":"60","qte":2,"prix_unitaire":"80.00"},{"commande_id":"85042","produit_id":"77","qte":2,"prix_unitaire":"101.25"}]},{"id":"82042","created_at":"2026-06-04T22:47:22.000000Z","statut":"payee","total":"480.00","lignes":[{"commande_id":"82042","produit_id":"43","qte":2,"prix_unitaire":"58.75"},{"commande_id":"82042","produit_id":"60","qte":2,"prix_unitaire":"80.00"},{"commande_id":"82042","produit_id":"77","qte":2,"prix_unitaire":"101.25"}]},{"id":"79042","created_at":"2026-06-04T21:57:22.000000Z","statut":"payee","total":"480.00","lignes":[{"commande_id":"79042","produit_id":"43","qte":2,"prix_unitaire":"58.75"},{"commande_id":"79042","produit_id":"60","qte":2,"prix_unitaire":"80.00"},{"commande_id":"79042","produit_id":"77","qte":2,"prix_unitaire":"101.25"}]},{"id":"76042","created_at":"2026-06-04T21:07:22.000000Z","statut":"payee","total":"480.00","lignes":[{"commande_id":"76042","produit_id":"43","qte":2,"prix_unitaire":"58.75"},{"commande_id":"76042","produit_id":"60","qte":2,"prix_unitaire":"80.00"},{"commande_id":"76042","produit_id":"77","qte":2,"prix_unitaire":"101.25"}]},{"id":"73042","created_at":"2026-06-04T20:17:22.000000Z","statut":"payee","total":"480.00","lignes":[{"commande_id":"73042","produit_id":"43","qte":2,"prix_unitaire":"58.75"},{"commande_id":"73042","produit_id":"60","qte":2,"prix_unitaire":"80.00"},{"commande_id":"73042","produit_id":"77","qte":2,"prix_unitaire":"101.25"}]},{"id":"70042","created_at":"2026-06-04T19:27:22.000000Z","statut":"payee","total":"480.00","lignes":[{"commande_id":"70042","produit_id":"43","qte":2,"prix_unitaire":"58.75"},{"commande_id":"70042","produit_id":"60","qte":2,"prix_unitaire":"80.00"},{"commande_id":"70042","produit_id":"77","qte":2,"prix_unitaire":"101.25"}]},{"id":"67042","created_at":"2026-06-04T18:37:22.000000Z","statut":"payee","total":"480.00","lignes":[{"commande_id":"67042","produit_id":"43","qte":2,"prix_unitaire":"58.75"},{"commande_id":"67042","produit_id":"60","qte":2,"prix_unitaire":"80.00"},{"commande_id":"67042","produit_id":"77","qte":2,"prix_unitaire":"101.25"}]}],"hasNextPage":true,"nextCursor":"eyJ2IjoxLCJjbGllbnRJZCI6IjQyIiwiZGF0ZSI6IjIwMjYtMDYtMDRUMTg6Mzc6MjIuMDAwMDAwWiIsImlkIjoiNjcwNDIifQ.jriOXv7bL-PqYoYq33QjVz-ZV6ptspT23ENzyRVo_c8"}}
{"Label":"offset_p2","Status":200,"SqlCount":2,"Cache":"","HttpMs":92.359,"TraceId":"741c4d70-0716-47ab-8e2c-7e045323433a","Body":{"data":[{"id":"26042","created_at":"2026-09-12T07:14:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"26042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"26042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"26042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"23042","created_at":"2026-09-12T06:24:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"23042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"23042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"23042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"20042","created_at":"2026-09-12T05:34:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"20042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"20042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"20042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"17042","created_at":"2026-09-12T04:44:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"17042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"17042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"17042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"14042","created_at":"2026-09-12T03:54:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"14042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"14042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"14042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"98042","created_at":"2026-09-12T03:14:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"98042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"98042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"98042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"11042","created_at":"2026-09-12T03:04:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"11042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"11042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"11042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"95042","created_at":"2026-09-12T02:24:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"95042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"95042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"95042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"8042","created_at":"2026-09-12T02:14:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"8042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"8042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"8042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"92042","created_at":"2026-09-12T01:34:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"92042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"92042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"92042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"5042","created_at":"2026-09-12T01:24:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"5042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"5042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"5042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"89042","created_at":"2026-09-12T00:44:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"89042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"89042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"89042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"2042","created_at":"2026-09-12T00:34:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"2042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"2042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"2042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"85042","created_at":"2026-06-04T23:37:22.000000Z","statut":"payee","total":"480.00","lignes":[{"commande_id":"85042","produit_id":"43","qte":2,"prix_unitaire":"58.75"},{"commande_id":"85042","produit_id":"60","qte":2,"prix_unitaire":"80.00"},{"commande_id":"85042","produit_id":"77","qte":2,"prix_unitaire":"101.25"}]},{"id":"82042","created_at":"2026-06-04T22:47:22.000000Z","statut":"payee","total":"480.00","lignes":[{"commande_id":"82042","produit_id":"43","qte":2,"prix_unitaire":"58.75"},{"commande_id":"82042","produit_id":"60","qte":2,"prix_unitaire":"80.00"},{"commande_id":"82042","produit_id":"77","qte":2,"prix_unitaire":"101.25"}]},{"id":"79042","created_at":"2026-06-04T21:57:22.000000Z","statut":"payee","total":"480.00","lignes":[{"commande_id":"79042","produit_id":"43","qte":2,"prix_unitaire":"58.75"},{"commande_id":"79042","produit_id":"60","qte":2,"prix_unitaire":"80.00"},{"commande_id":"79042","produit_id":"77","qte":2,"prix_unitaire":"101.25"}]},{"id":"76042","created_at":"2026-06-04T21:07:22.000000Z","statut":"payee","total":"480.00","lignes":[{"commande_id":"76042","produit_id":"43","qte":2,"prix_unitaire":"58.75"},{"commande_id":"76042","produit_id":"60","qte":2,"prix_unitaire":"80.00"},{"commande_id":"76042","produit_id":"77","qte":2,"prix_unitaire":"101.25"}]},{"id":"73042","created_at":"2026-06-04T20:17:22.000000Z","statut":"payee","total":"480.00","lignes":[{"commande_id":"73042","produit_id":"43","qte":2,"prix_unitaire":"58.75"},{"commande_id":"73042","produit_id":"60","qte":2,"prix_unitaire":"80.00"},{"commande_id":"73042","produit_id":"77","qte":2,"prix_unitaire":"101.25"}]},{"id":"70042","created_at":"2026-06-04T19:27:22.000000Z","statut":"payee","total":"480.00","lignes":[{"commande_id":"70042","produit_id":"43","qte":2,"prix_unitaire":"58.75"},{"commande_id":"70042","produit_id":"60","qte":2,"prix_unitaire":"80.00"},{"commande_id":"70042","produit_id":"77","qte":2,"prix_unitaire":"101.25"}]},{"id":"67042","created_at":"2026-06-04T18:37:22.000000Z","statut":"payee","total":"480.00","lignes":[{"commande_id":"67042","produit_id":"43","qte":2,"prix_unitaire":"58.75"},{"commande_id":"67042","produit_id":"60","qte":2,"prix_unitaire":"80.00"},{"commande_id":"67042","produit_id":"77","qte":2,"prix_unitaire":"101.25"}]}],"hasNextPage":true,"nextCursor":"eyJ2IjoxLCJjbGllbnRJZCI6IjQyIiwiZGF0ZSI6IjIwMjYtMDYtMDRUMTg6Mzc6MjIuMDAwMDAwWiIsImlkIjoiNjcwNDIifQ.jriOXv7bL-PqYoYq33QjVz-ZV6ptspT23ENzyRVo_c8"}}

```

### atelier07_dates_pages.jsonl

```json
{"Label":"dates_p1","Status":200,"SqlCount":2,"Cache":"","HttpMs":107.638,"TraceId":"3903570f-e728-4db8-b9f9-759716a90872","Body":{"data":[{"id":"2042","created_at":"2026-09-13T23:54:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"2042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"2042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"2042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"1042","created_at":"2026-09-13T23:54:02.000000Z","statut":"payee","total":"480.00","lignes":[{"commande_id":"1042","produit_id":"43","qte":2,"prix_unitaire":"58.75"},{"commande_id":"1042","produit_id":"60","qte":2,"prix_unitaire":"80.00"},{"commande_id":"1042","produit_id":"77","qte":2,"prix_unitaire":"101.25"}]}],"hasNextPage":true,"nextCursor":"eyJ2IjoxLCJjbGllbnRJZCI6IjQyIiwiZGF0ZSI6IjIwMjYtMDktMTNUMjM6NTQ6MDIuMDAwMDAwWiIsImlkIjoiMTA0MiJ9.mZMzRKkTUumXjBzdZaAnxFBTeVdJSN7egwtYDCl1Ork"}}
{"Label":"dates_p2","Status":200,"SqlCount":2,"Cache":"","HttpMs":38.771,"TraceId":"ec61477c-57aa-4e6a-bf4b-5a5a62bcae44","Body":{"data":[{"id":"42","created_at":"2026-09-13T23:54:02.000000Z","statut":"payee","total":"240.00","lignes":[{"commande_id":"42","produit_id":"43","qte":1,"prix_unitaire":"58.75"},{"commande_id":"42","produit_id":"60","qte":1,"prix_unitaire":"80.00"},{"commande_id":"42","produit_id":"77","qte":1,"prix_unitaire":"101.25"}]},{"id":"86042","created_at":"2026-09-12T23:54:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"86042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"86042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"86042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]}],"hasNextPage":true,"nextCursor":"eyJ2IjoxLCJjbGllbnRJZCI6IjQyIiwiZGF0ZSI6IjIwMjYtMDktMTJUMjM6NTQ6MDIuMDAwMDAwWiIsImlkIjoiODYwNDIifQ.oyiz7nwDInJ1sB2RYNVyL7hSbKy5RGemicnC3kYU2i4"}}

```

### atelier07_parcours.txt

```text
Pages=5 Total=100 Uniques=     100

```

### mesures_linux_20261007T120021290Z_2a5fd8.csv

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

### pgbouncer_demarrage_controle.txt

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

### pooling_10_reconnexion/1_direct_connexions.csv

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

### pooling_10_reconnexion/1_direct_pgbench.txt

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

### pooling_10_reconnexion/1_pool_connexions.csv

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

### pooling_10_reconnexion/1_pool_observations.txt

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

### pooling_10_reconnexion/1_pool_pgbench.txt

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

### pooling_10_reconnexion/2_direct_connexions.csv

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

### pooling_10_reconnexion/2_direct_pgbench.txt

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

### pooling_10_reconnexion/2_pool_connexions.csv

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

### pooling_10_reconnexion/2_pool_observations.txt

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

### pooling_10_reconnexion/2_pool_pgbench.txt

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

### pooling_10_reconnexion/3_direct_connexions.csv

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

### pooling_10_reconnexion/3_direct_pgbench.txt

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

### pooling_10_reconnexion/3_pool_connexions.csv

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

### pooling_10_reconnexion/3_pool_observations.txt

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

### pooling_10_reconnexion/3_pool_pgbench.txt

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

### pooling_10_reconnexion/configuration.txt

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

### pooling_10_reconnexion/synthese.csv

```csv
"essai","route","clients","secondes_demandees","mode","code_sortie","transactions","transactions_echouees","tps","latence_moyenne_ms","pic_connexions_echantillonne","nb_echantillons","duree_pilote_s"
"1_direct","direct","10","20","reconnexion","0","970","0","48.413819","172.510","10","18","20.558"
"1_pool","pool","10","20","reconnexion","0","1018","0","50.487084","175.122","5","17","21.004"
"2_pool","pool","10","20","reconnexion","0","1007","0","49.869107","176.305","5","17","20.547"
"2_direct","direct","10","20","reconnexion","0","960","0","47.998716","173.885","10","18","20.688"
"3_direct","direct","10","20","reconnexion","0","980","0","48.932942","173.841","10","18","21.161"
"3_pool","pool","10","20","reconnexion","0","1085","0","53.835355","168.138","5","17","21.034"

```

### pooling_40_persistant/1_direct_connexions.csv

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

### pooling_40_persistant/1_direct_pgbench.txt

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

### pooling_40_persistant/1_pool_connexions.csv

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

### pooling_40_persistant/1_pool_observations.txt

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

### pooling_40_persistant/1_pool_pgbench.txt

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

### pooling_40_persistant/2_direct_connexions.csv

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

### pooling_40_persistant/2_direct_pgbench.txt

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

### pooling_40_persistant/2_pool_connexions.csv

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

### pooling_40_persistant/2_pool_observations.txt

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

### pooling_40_persistant/2_pool_pgbench.txt

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

### pooling_40_persistant/3_direct_connexions.csv

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

### pooling_40_persistant/3_direct_pgbench.txt

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

### pooling_40_persistant/3_pool_connexions.csv

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

### pooling_40_persistant/3_pool_observations.txt

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

### pooling_40_persistant/3_pool_pgbench.txt

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

### pooling_40_persistant/configuration.txt

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

### pooling_40_persistant/synthese.csv

```csv
"essai","route","clients","secondes_demandees","mode","code_sortie","transactions","transactions_echouees","tps","latence_moyenne_ms","pic_connexions_echantillonne","nb_echantillons","duree_pilote_s"
"1_direct","direct","40","20","persistant","0","5120","0","256.493571","155.461","40","18","20.737"
"1_pool","pool","40","20","persistant","0","1908","0","94.695217","418.449","5","17","20.729"
"2_pool","pool","40","20","persistant","0","1908","0","94.551556","419.232","5","17","21.217"
"2_direct","direct","40","20","persistant","0","5120","0","255.366283","155.877","40","18","20.54"
"3_direct","direct","40","20","persistant","0","5120","0","257.705404","154.729","40","18","20.968"
"3_pool","pool","40","20","persistant","0","1912","0","94.615132","418.915","5","17","21.451"

```

### pooling_80_saturation/1_direct_connexions.csv

```csv
"timestamp","total","active","idle","idle_in_transaction"
"2026-10-07T13:30:39.709Z","0","0","0","0"

```

### pooling_80_saturation/1_direct_pgbench.txt

```text
pgbench (17.11 (Debian 17.11-1.pgdg12+2))

pgbench: error: connection to server at "db" (172.21.0.2), port 5432 failed: FATAL:  remaining connection slots are reserved for roles with the SUPERUSER attribute
pgbench: error: could not create connection for client 68

```

### pooling_80_saturation/1_pool_connexions.csv

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

### pooling_80_saturation/1_pool_observations.txt

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

### pooling_80_saturation/1_pool_pgbench.txt

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

### pooling_80_saturation/configuration.txt

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

### pooling_80_saturation/synthese.csv

```csv
"essai","route","clients","secondes_demandees","mode","code_sortie","transactions","transactions_echouees","tps","latence_moyenne_ms","pic_connexions_echantillonne","nb_echantillons","duree_pilote_s"
"1_direct","direct","80","20","persistant","1","","","","","0","1","1.152"
"1_pool","pool","80","20","persistant","0","1917","0","93.827593","835.628","5","17","21.501"

```

### 07_dates_identiques.sql

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

### 07_restaurer_dates.sql

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
