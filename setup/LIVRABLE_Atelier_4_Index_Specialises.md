# Atelier 4 — Index spécialisés

Source : diapositive 26 de `J02_Indexer_modeliser_migration.pptx`, exemples des diapositives 13, 16 et 18.

## Besoins et requêtes étudiés

- Index partiel B-tree sur les commandes en attente : comparer `statut = 'en_attente'` et `statut = 'payee'`, avec tri par `created_at, id` et limite de 100 lignes.
- Index GIN sur `produits.attributs` : tester la contenance JSONB avec `@>` et comparer avec une extraction de propriété via `->>` ; relever les résultats, les plans et les tailles.
- Index GiST sur des périodes `tstzrange` : tester le chevauchement avec `&&` sur deux périodes qui se chevauchent et une période disjointe.

## État initial

Index présents : `commandes_pkey`, `commandes_client_id_cle_idempotence_key`, `idx_atelier3_hist_couvrant` et `produits_pkey`. Aucun index partiel ou GIN dans l’inventaire transmis. L’index couvrant de l’atelier 3 est conservé.

Le rapport synthétise les résultats ; les plans complets seront conservés en annexe séparée.

## Index partiel

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

## Index GIN

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

## Index GiST

Création confirmée : table `shopflow.atelier4_reservations` (`id bigint PRIMARY KEY`, `periode tstzrange NOT NULL`) et index `idx_atelier4_periode_gist` utilisant GiST sur `periode`.

Trois périodes créées le 10 octobre 2026, fuseau UTC+02 : **1 : 14 h–16 h**, **2 : 15 h–17 h**, **3 : 18 h–19 h**. Bornes `[)` : début inclus, fin exclue. L’opérateur `&&` teste le chevauchement.

Contrôle `periode && tstzrange('2026-10-10 14:00+02', '2026-10-10 16:00+02', '[)')` : **2 lignes**, identifiants **1 et 2** ; période 3 exclue. Affichage UTC : période 1 `[12:00,14:00)`, période 2 `[13:00,15:00)`, le 10 octobre 2026. Résultat conforme aux chevauchements attendus.

Plan observé : **Seq Scan**, **2 lignes**, **1 ligne écartée**, **shared hit=1**, **Execution Time=0,180 ms**. Les trois périodes tiennent dans un seul bloc en mémoire : le parcours complet est préféré au GiST, compatible avec `&&`.

Définition vérifiée : GiST sur `periode`. Taille : **8 192 octets (8 KiB)**.

## Décision

| Index | Opérateur / condition | Taille | Conclusion observée |
|---|---|---:|---|
| Partiel B-tree | `statut = 'en_attente'`, ordre `created_at, id` | 328 kB | Utilisé, sans tri ; exclu pour `payee` |
| GIN JSONB | `@>` ; extraction `->>` non directement couverte | 16 kB | Compatible avec `@>`, mais Seq Scan préféré sur 200 produits |
| GiST périodes | `&&` | 8 KiB | Chevauchement correct ; Seq Scan préféré sur 3 périodes |

Le choix dépend du filtre, de l’opérateur et du volume. La présence d’un index compatible ne garantit pas son utilisation. Les durées présentées sont celles des exécutions observées ; les plans complets sont conservés dans l’annexe.
