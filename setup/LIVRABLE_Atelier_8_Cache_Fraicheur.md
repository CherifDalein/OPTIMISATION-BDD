# Atelier 8 — Cache Redis et fraîcheur

## 1. État initial et méthode

Produit **42**, prix initial **57,50**, clé **shopflow:produit:v1:42**, TTL de séance **60 s**. API redémarrée, Redis prêt. PostgreSQL reste la source de vérité. Clé : application, objet, version de représentation, identifiant.

**Cache-aside :** GET Redis ; hit → réponse sans SQL ; miss/panne → SELECT PostgreSQL ; si Redis disponible, SET avec EX 60. PATCH : UPDATE en autocommit puis DEL après validation.

```sql
SELECT id::text AS id, nom, prix::text AS prix, stock, attributs
FROM shopflow.produits WHERE id=$1;

UPDATE shopflow.produits SET prix=$2::numeric
WHERE id=$1 RETURNING id::text AS id, prix::text AS prix;
```

Les durées HTTP proviennent de sf ; les durées serveur sont liées par TraceId. sqlMs inclut l’attente éventuelle du pool ; durationMs mesure le traitement API. Les premières lectures de contrôle sont séparées des cinq paires répétées.

## 2. Miss puis hit : mesurer et comparer

Méthode : supprimer uniquement la clé du produit 42 avant chaque paire, puis deux lectures immédiates.

```bash
for i in 1 2 3 4 5; do
 docker compose exec -T redis redis-cli DEL shopflow:produit:v1:42 > /dev/null
 m=$(sf "miss_$i" /produits/42)
 h=$(sf "hit_$i" /produits/42)
 sf_resume "$m" "$h"
done
```

**Contrôle initial : fiches miss/hit identiques.**

```json
{"id":"42","nom":"Produit 42","prix":"57.50","stock":100,"attributs":{"couleur":"bleu","categorie":"materiel"}}
```

| Chemin | 1 HTTP ms | 2 | 3 | 4 | 5 | Moyenne | Médiane | SQL par appel |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| miss | 73,709 | 23,893 | 28,695 | 26,077 | 24,690 | 35,413 | 26,077 | 1 |
| hit | 22,718 | 21,791 | 23,215 | 22,705 | 22,284 | 22,543 | 22,705 | 0 |

Tous les appels répondent HTTP 200. Médiane HTTP hit : **−12,9 %**. Premier miss nettement plus long, conservé dans l’échantillon. Première paire répétée : durée serveur miss **20,797 ms** (sqlMs **14,274**) contre hit **1,865 ms** (sqlMs **0**). Le hit évite le SELECT ; HttpMs inclut aussi le client et le transfert.

## 3. Écriture SQL directe : constater la copie ancienne, invalider

Méthode : charger le prix en cache, modifier PostgreSQL, lire avant expiration, DEL puis relire immédiatement.

```sql
UPDATE shopflow.produits SET prix=19.90 WHERE id=42 RETURNING id,prix;
-- Séquence immédiate suivante : copie chargée à 19.90
UPDATE shopflow.produits SET prix=24.90 WHERE id=42 RETURNING id,prix;
```

```bash
ancien=$(sf manuel_ancien /produits/42)
docker compose exec -T redis redis-cli DEL shopflow:produit:v1:42
nouveau=$(sf manuel_apres_del /produits/42)
```

| Étape | Prix PostgreSQL | Prix API | Cache | SQL HTTP | HttpMs |
|---|---:|---:|---|---:|---:|
| Premier UPDATE direct | 19,90 | 57,50 | hit | 0 | 22,138 |
| Nouvelle séquence, avant DEL | 24,90 | 19,90 | hit | 0 | 24,157 |
| Après DEL=1 | 24,90 | 24,90 | miss | 1 | 41,315 |

**Preuve :** l’UPDATE direct ne supprime pas Redis. DEL=1 retire une copie existante ; le GET recharge la nouvelle valeur. L’UPDATE terminal est extérieur au SqlCount HTTP. La lecture intermédiaire à 19,90 après DEL=0 est conservée dans le CSV : la clé y était déjà absente, donc elle ne prouve pas l’effet du DEL.

## 4. PATCH : appliquer l’invalidation automatique

```bash
patch=$(sf patch_prix /produits/42 PATCH '{"prix":"29.90"}')
apresPatch=$(sf patch_miss /produits/42)
hitPatch=$(sf patch_hit /produits/42)
```

Réponse PATCH : `{"data":{"id":"42","prix":"29.90"},"invalidation":"ok"}`.

| Appel | Prix | Cache | SQL | HttpMs | sqlMs | durationMs |
|---|---:|---|---:|---:|---:|---:|
| PATCH | 29,90 | — | 1 | 43,809 | 16,750 | 19,420 |
| GET suivant | 29,90 | miss | 1 | 27,700 | 2,660 | 5,967 |
| Deuxième GET | 29,90 | hit | 0 | 26,199 | 0,000 | 4,424 |

Le PATCH valide le prix puis supprime la copie ; le premier GET recharge, le suivant utilise Redis. Dans une transaction explicite, invalider après COMMIT. Un échec d’invalidation ne signifie pas que l’UPDATE a été annulé.

## 5. Expiration et panne : tester la correction

**Expiration :** GET pour charger la clé, TTL, attente de 61 s sans lecture, TTL puis GET.

```bash
docker compose exec -T redis redis-cli TTL shopflow:produit:v1:42
sleep "$((J4_TTL + 1))"
docker compose exec -T redis redis-cli TTL shopflow:produit:v1:42
expire=$(sf ttl_expire /produits/42)
```

**Preuve : TTL 60 → −2**, puis prix 29,90 en miss avec 1 SELECT.

**Panne :** arrêter uniquement Redis, attendre la détection API, lire, puis redémarrer Redis.

```bash
docker compose stop redis
sf_attendre_redis false
panne=$(sf redis_indisponible /produits/42)
docker compose start redis
sf_attendre_redis true
```

| Scénario | HTTP | Cache | SQL | Prix | HttpMs | durationMs |
|---|---:|---|---:|---:|---:|---:|
| Après expiration | 200 | miss | 1 | 29.90 | 40,862 | 15,397 |
| Redis arrêté | 200 | indisponible | 1 | 29.90 | 58,543 | 23,388 |
| Redis revenu, GET 1 | 200 | miss | 1 | 29.90 | 40,800 | 16,105 |
| Redis revenu, GET 2 | 200 | hit | 0 | 29.90 | 22,820 | 1,858 |

Le repli conserve la réponse correcte via PostgreSQL. Redis revenu, le cycle miss/hit reprend. Une panne multiplie les lectures SQL sous charge.

## 6. Fraîcheur, course de reconstruction et décision

Fraîcheur retenue pour ce catalogue de laboratoire : **jusqu’à environ une minute après publication d’une copie**. Le TTL expire la copie sans l’actualiser lors d’une écriture. Pour un achat, vérifier le prix et les conditions dans PostgreSQL au sein de la transaction.

**Course :** A lit l’ancien prix sur miss → B valide le nouveau prix → B fait DEL → A fait SET de l’ancien prix. Le DEL n’efface pas une copie republiée après lui. Piste : coordonner publication/invalidation à l’aide d’une version, pour refuser une publication périmée. Cette analyse décrit le risque ; ce n’est pas une simulation exécutée.

**Décision :** le cache-aside testé évite le SELECT sur hit ; utiliser l’invalidation après écriture et conserver le repli. Les preuves valident contenu, comptage et comportements ; les cinq paires décrivent les durées de cette séance.

## 7. Restauration vérifiée

```bash
bodyInitial=$(printf '{"prix":"%s"}' "$prixInitial")
retour=$(sf restauration_prix /produits/42 PATCH "$bodyInitial")
controle=$(sf prix_restaure /produits/42)
docker compose exec -T redis redis-cli DEL shopflow:produit:v1:42
```

**Prix restauré : 57,50 ; invalidation=ok ; contrôle « Prix restauré » ; DEL final=1.** Redis disponible. Le TTL de séance reste configuré à 60 secondes ; valeur d’origine archivée : 5 secondes.

## Annexes — Preuves complètes

### atelier08_reponses.jsonl

```json
{"Label":"prix_initial","Status":200,"SqlCount":1,"Cache":"miss","HttpMs":89.652,"TraceId":"2b311c5e-68ff-4155-a3cd-8af221651bd8","Body":{"data":{"id":"42","nom":"Produit 42","prix":"57.50","stock":100,"attributs":{"couleur":"bleu","categorie":"materiel"}},"cache":"miss"}}
{"Label":"cache_miss","Status":200,"SqlCount":1,"Cache":"miss","HttpMs":67.671,"TraceId":"4964bc74-aa81-4c70-86a3-bc8efcf2c920","Body":{"data":{"id":"42","nom":"Produit 42","prix":"57.50","stock":100,"attributs":{"couleur":"bleu","categorie":"materiel"}},"cache":"miss"}}
{"Label":"cache_hit","Status":200,"SqlCount":0,"Cache":"hit","HttpMs":22.891,"TraceId":"f19cd8fa-6440-47d2-bdcd-c9dbe881fd6d","Body":{"data":{"id":"42","nom":"Produit 42","prix":"57.50","stock":100,"attributs":{"couleur":"bleu","categorie":"materiel"}},"cache":"hit"}}
{"Label":"manuel_avant","Status":200,"SqlCount":0,"Cache":"hit","HttpMs":25.748,"TraceId":"18c84b1e-32f0-4f33-b0e0-12b5ba3a3b93","Body":{"data":{"id":"42","nom":"Produit 42","prix":"19.90","stock":100,"attributs":{"couleur":"bleu","categorie":"materiel"}},"cache":"hit"}}
{"Label":"manuel_ancien","Status":200,"SqlCount":0,"Cache":"hit","HttpMs":24.157,"TraceId":"7a76cced-82a0-421e-ad30-4f472fa1539a","Body":{"data":{"id":"42","nom":"Produit 42","prix":"19.90","stock":100,"attributs":{"couleur":"bleu","categorie":"materiel"}},"cache":"hit"}}
{"Label":"manuel_apres_del","Status":200,"SqlCount":1,"Cache":"miss","HttpMs":41.315,"TraceId":"a3c7b3c1-cd46-436c-a73c-dff9177029f5","Body":{"data":{"id":"42","nom":"Produit 42","prix":"24.90","stock":100,"attributs":{"couleur":"bleu","categorie":"materiel"}},"cache":"miss"}}
{"Label":"patch_prix","Status":200,"SqlCount":1,"Cache":"","HttpMs":43.809,"TraceId":"7ab090e9-e09a-44fd-908c-b85d20458137","Body":{"data":{"id":"42","prix":"29.90"},"invalidation":"ok"}}
{"Label":"patch_miss","Status":200,"SqlCount":1,"Cache":"miss","HttpMs":27.7,"TraceId":"513147b3-af35-4c4a-96d4-e18eff90a533","Body":{"data":{"id":"42","nom":"Produit 42","prix":"29.90","stock":100,"attributs":{"couleur":"bleu","categorie":"materiel"}},"cache":"miss"}}
{"Label":"patch_hit","Status":200,"SqlCount":0,"Cache":"hit","HttpMs":26.199,"TraceId":"0068a30f-3bc9-4565-8337-143b5dd203ea","Body":{"data":{"id":"42","nom":"Produit 42","prix":"29.90","stock":100,"attributs":{"couleur":"bleu","categorie":"materiel"}},"cache":"hit"}}
{"Label":"ttl_chargement","Status":200,"SqlCount":1,"Cache":"miss","HttpMs":81.082,"TraceId":"329b574b-5835-431c-b503-eea0412516fc","Body":{"data":{"id":"42","nom":"Produit 42","prix":"29.90","stock":100,"attributs":{"couleur":"bleu","categorie":"materiel"}},"cache":"miss"}}
{"Label":"ttl_expire","Status":200,"SqlCount":1,"Cache":"miss","HttpMs":40.862,"TraceId":"60370f13-ab35-4fce-9a1b-ebd1a0d635c6","Body":{"data":{"id":"42","nom":"Produit 42","prix":"29.90","stock":100,"attributs":{"couleur":"bleu","categorie":"materiel"}},"cache":"miss"}}
{"Label":"redis_indisponible","Status":200,"SqlCount":1,"Cache":"indisponible","HttpMs":58.543,"TraceId":"e991a696-21b8-4779-89fd-1720e7ec39fc","Body":{"data":{"id":"42","nom":"Produit 42","prix":"29.90","stock":100,"attributs":{"couleur":"bleu","categorie":"materiel"}},"cache":"indisponible"}}
{"Label":"retour_redis_miss","Status":200,"SqlCount":1,"Cache":"miss","HttpMs":40.8,"TraceId":"eedf73d6-060a-4313-ac85-68f81b847c2b","Body":{"data":{"id":"42","nom":"Produit 42","prix":"29.90","stock":100,"attributs":{"couleur":"bleu","categorie":"materiel"}},"cache":"miss"}}
{"Label":"retour_redis_hit","Status":200,"SqlCount":0,"Cache":"hit","HttpMs":22.82,"TraceId":"dc7c3c13-2a79-4a14-8cfe-2dc0eef19bd4","Body":{"data":{"id":"42","nom":"Produit 42","prix":"29.90","stock":100,"attributs":{"couleur":"bleu","categorie":"materiel"}},"cache":"hit"}}
{"Label":"restauration_prix","Status":200,"SqlCount":1,"Cache":"","HttpMs":43.805,"TraceId":"059faae2-565d-493f-8713-a293146fe355","Body":{"data":{"id":"42","prix":"57.50"},"invalidation":"ok"}}
{"Label":"prix_restaure","Status":200,"SqlCount":1,"Cache":"miss","HttpMs":26.167,"TraceId":"0eeb1b96-10d6-47dc-83bf-60b19f9e3b5a","Body":{"data":{"id":"42","nom":"Produit 42","prix":"57.50","stock":100,"attributs":{"couleur":"bleu","categorie":"materiel"}},"cache":"miss"}}

```

### mesures_linux_20261008T071529967Z_94ebc5.csv

```csv
"Date","Label","Method","Path","Status","SqlCount","Cache","HttpMs","TraceId","Prix","Ids"
"2026-10-08T07:15:42.949Z","etat_redis","GET","/observations","200","0","","31.043","1224b29d-d5c0-46a6-b5af-3746c5318612","",""
"2026-10-08T07:17:14.432Z","prix_initial","GET","/produits/42","200","1","miss","89.652","2b311c5e-68ff-4155-a3cd-8af221651bd8","57.50",""
"2026-10-08T07:21:54.751Z","cache_miss","GET","/produits/42","200","1","miss","67.671","4964bc74-aa81-4c70-86a3-bc8efcf2c920","57.50",""
"2026-10-08T07:21:54.895Z","cache_hit","GET","/produits/42","200","0","hit","22.891","f19cd8fa-6440-47d2-bdcd-c9dbe881fd6d","57.50",""
"2026-10-08T07:26:45.113Z","miss_1","GET","/produits/42","200","1","miss","73.709","3609e95d-73ed-40eb-ab9b-25182e534368","57.50",""
"2026-10-08T07:26:45.256Z","hit_1","GET","/produits/42","200","0","hit","22.718","aee6a8d1-d853-439d-af1f-2a848f0149a2","57.50",""
"2026-10-08T07:26:45.619Z","miss_2","GET","/produits/42","200","1","miss","23.893","845eefcf-35d1-4915-899c-d5cc677c2992","57.50",""
"2026-10-08T07:26:45.756Z","hit_2","GET","/produits/42","200","0","hit","21.791","54742dd6-72ed-4c94-aca2-154cad86cbd7","57.50",""
"2026-10-08T07:26:46.122Z","miss_3","GET","/produits/42","200","1","miss","28.695","7826f0b3-7b22-41de-87c2-1dd8178934bc","57.50",""
"2026-10-08T07:26:46.262Z","hit_3","GET","/produits/42","200","0","hit","23.215","293c7014-a7f5-41d4-b11f-27e5e4d30a63","57.50",""
"2026-10-08T07:26:46.624Z","miss_4","GET","/produits/42","200","1","miss","26.077","f46c50c4-e7f7-4b9e-a1fc-0f7060695a16","57.50",""
"2026-10-08T07:26:46.787Z","hit_4","GET","/produits/42","200","0","hit","22.705","8f64da34-b0a7-4279-a838-f97291401bc7","57.50",""
"2026-10-08T07:26:47.147Z","miss_5","GET","/produits/42","200","1","miss","24.69","da5dfccb-b284-41cf-875c-5acdc8e6989d","57.50",""
"2026-10-08T07:26:47.284Z","hit_5","GET","/produits/42","200","0","hit","22.284","3094f1aa-5f2e-4e02-8b82-a8fd27d0f4c2","57.50",""
"2026-10-08T07:31:09.052Z","sql_avant","GET","/produits/42","200","1","miss","73.339","32f73e1d-e46b-4f53-b725-b935bca7a3a1","57.50",""
"2026-10-08T07:31:09.366Z","sql_cache_ancien","GET","/produits/42","200","0","hit","22.138","a80b1ec3-6288-40b9-9cb5-2d42d2641d66","57.50",""
"2026-10-08T07:32:41.141Z","sql_apres_del","GET","/produits/42","200","1","miss","75.939","78cf02e6-d40f-4c16-a310-6f2f83ebe882","19.90",""
"2026-10-08T07:33:32.492Z","manuel_avant","GET","/produits/42","200","0","hit","25.748","18c84b1e-32f0-4f33-b0e0-12b5ba3a3b93","19.90",""
"2026-10-08T07:33:32.898Z","manuel_ancien","GET","/produits/42","200","0","hit","24.157","7a76cced-82a0-421e-ad30-4f472fa1539a","19.90",""
"2026-10-08T07:33:33.303Z","manuel_apres_del","GET","/produits/42","200","1","miss","41.315","a3c7b3c1-cd46-436c-a73c-dff9177029f5","24.90",""
"2026-10-08T07:34:59.835Z","patch_prix","PATCH","/produits/42","200","1","","43.809","7ab090e9-e09a-44fd-908c-b85d20458137","29.90",""
"2026-10-08T07:35:00.097Z","patch_miss","GET","/produits/42","200","1","miss","27.7","513147b3-af35-4c4a-96d4-e18eff90a533","29.90",""
"2026-10-08T07:35:00.240Z","patch_hit","GET","/produits/42","200","0","hit","26.199","0068a30f-3bc9-4565-8337-143b5dd203ea","29.90",""
"2026-10-08T07:42:22.953Z","ttl_chargement","GET","/produits/42","200","1","miss","81.082","329b574b-5835-431c-b503-eea0412516fc","29.90",""
"2026-10-08T07:43:24.634Z","ttl_expire","GET","/produits/42","200","1","miss","40.862","60370f13-ab35-4fce-9a1b-ebd1a0d635c6","29.90",""
"2026-10-08T07:44:46.737Z","etat_redis","GET","/observations","200","0","","25.572","e6fbb1ee-a3b6-4458-8653-966e3dd11958","",""
"2026-10-08T07:44:46.929Z","redis_indisponible","GET","/produits/42","200","1","indisponible","58.543","e991a696-21b8-4779-89fd-1720e7ec39fc","29.90",""
"2026-10-08T07:44:47.734Z","etat_redis","GET","/observations","200","0","","27.357","516727e7-226e-4e2b-8cf8-b3cbed513b63","",""
"2026-10-08T07:44:48.238Z","etat_redis","GET","/observations","200","0","","2.022","7c94cf0c-5f77-439a-bd96-d8966b84e16c","",""
"2026-10-08T07:46:39.968Z","retour_redis_miss","GET","/produits/42","200","1","miss","40.8","eedf73d6-060a-4313-ac85-68f81b847c2b","29.90",""
"2026-10-08T07:46:40.108Z","retour_redis_hit","GET","/produits/42","200","0","hit","22.82","dc7c3c13-2a79-4a14-8cfe-2dc0eef19bd4","29.90",""
"2026-10-08T07:47:59.041Z","restauration_prix","PATCH","/produits/42","200","1","","43.805","059faae2-565d-493f-8713-a293146fe355","57.50",""
"2026-10-08T07:47:59.191Z","prix_restaure","GET","/produits/42","200","1","miss","26.167","0eeb1b96-10d6-47dc-83bf-60b19f9e3b5a","57.50",""

```

### traces_api.jsonl

```json
{"trace":"2b311c5e-68ff-4155-a3cd-8af221651bd8","route":"/produits/42","status":200,"sqlCount":1,"sqlMs":30.928,"durationMs":38.324,"poolWaiting":0,"cache":"miss"}
{"trace":"4964bc74-aa81-4c70-86a3-bc8efcf2c920","route":"/produits/42","status":200,"sqlCount":1,"sqlMs":14.12,"durationMs":21.053,"poolWaiting":0,"cache":"miss"}
{"trace":"f19cd8fa-6440-47d2-bdcd-c9dbe881fd6d","route":"/produits/42","status":200,"sqlCount":0,"sqlMs":0,"durationMs":1.737,"poolWaiting":0,"cache":"hit"}
{"trace":"3609e95d-73ed-40eb-ab9b-25182e534368","route":"/produits/42","status":200,"sqlCount":1,"sqlMs":14.274,"durationMs":20.797,"poolWaiting":0,"cache":"miss"}
{"trace":"aee6a8d1-d853-439d-af1f-2a848f0149a2","route":"/produits/42","status":200,"sqlCount":0,"sqlMs":0,"durationMs":1.865,"poolWaiting":0,"cache":"hit"}
{"trace":"845eefcf-35d1-4915-899c-d5cc677c2992","route":"/produits/42","status":200,"sqlCount":1,"sqlMs":1.262,"durationMs":2.681,"poolWaiting":0,"cache":"miss"}
{"trace":"54742dd6-72ed-4c94-aca2-154cad86cbd7","route":"/produits/42","status":200,"sqlCount":0,"sqlMs":0,"durationMs":1.166,"poolWaiting":0,"cache":"hit"}
{"trace":"7826f0b3-7b22-41de-87c2-1dd8178934bc","route":"/produits/42","status":200,"sqlCount":1,"sqlMs":1.281,"durationMs":6.342,"poolWaiting":0,"cache":"miss"}
{"trace":"293c7014-a7f5-41d4-b11f-27e5e4d30a63","route":"/produits/42","status":200,"sqlCount":0,"sqlMs":0,"durationMs":1.153,"poolWaiting":0,"cache":"hit"}
{"trace":"f46c50c4-e7f7-4b9e-a1fc-0f7060695a16","route":"/produits/42","status":200,"sqlCount":1,"sqlMs":1.843,"durationMs":4.141,"poolWaiting":0,"cache":"miss"}
{"trace":"8f64da34-b0a7-4279-a838-f97291401bc7","route":"/produits/42","status":200,"sqlCount":0,"sqlMs":0,"durationMs":1.574,"poolWaiting":0,"cache":"hit"}
{"trace":"da5dfccb-b284-41cf-875c-5acdc8e6989d","route":"/produits/42","status":200,"sqlCount":1,"sqlMs":1.553,"durationMs":3.666,"poolWaiting":0,"cache":"miss"}
{"trace":"3094f1aa-5f2e-4e02-8b82-a8fd27d0f4c2","route":"/produits/42","status":200,"sqlCount":0,"sqlMs":0,"durationMs":1.399,"poolWaiting":0,"cache":"hit"}
{"trace":"32f73e1d-e46b-4f53-b725-b935bca7a3a1","route":"/produits/42","status":200,"sqlCount":1,"sqlMs":15.304,"durationMs":20.303,"poolWaiting":0,"cache":"miss"}
{"trace":"a80b1ec3-6288-40b9-9cb5-2d42d2641d66","route":"/produits/42","status":200,"sqlCount":0,"sqlMs":0,"durationMs":0.906,"poolWaiting":0,"cache":"hit"}
{"trace":"78cf02e6-d40f-4c16-a310-6f2f83ebe882","route":"/produits/42","status":200,"sqlCount":1,"sqlMs":14.213,"durationMs":20.246,"poolWaiting":0,"cache":"miss"}
{"trace":"18c84b1e-32f0-4f33-b0e0-12b5ba3a3b93","route":"/produits/42","status":200,"sqlCount":0,"sqlMs":0,"durationMs":3,"poolWaiting":0,"cache":"hit"}
{"trace":"7a76cced-82a0-421e-ad30-4f472fa1539a","route":"/produits/42","status":200,"sqlCount":0,"sqlMs":0,"durationMs":0.966,"poolWaiting":0,"cache":"hit"}
{"trace":"a3c7b3c1-cd46-436c-a73c-dff9177029f5","route":"/produits/42","status":200,"sqlCount":1,"sqlMs":14.328,"durationMs":16.675,"poolWaiting":0,"cache":"miss"}
{"trace":"7ab090e9-e09a-44fd-908c-b85d20458137","route":"/produits/42","status":200,"sqlCount":1,"sqlMs":16.75,"durationMs":19.42,"poolWaiting":0}
{"trace":"513147b3-af35-4c4a-96d4-e18eff90a533","route":"/produits/42","status":200,"sqlCount":1,"sqlMs":2.66,"durationMs":5.967,"poolWaiting":0,"cache":"miss"}
{"trace":"0068a30f-3bc9-4565-8337-143b5dd203ea","route":"/produits/42","status":200,"sqlCount":0,"sqlMs":0,"durationMs":4.424,"poolWaiting":0,"cache":"hit"}
{"trace":"329b574b-5835-431c-b503-eea0412516fc","route":"/produits/42","status":200,"sqlCount":1,"sqlMs":13.756,"durationMs":21.187,"poolWaiting":0,"cache":"miss"}
{"trace":"60370f13-ab35-4fce-9a1b-ebd1a0d635c6","route":"/produits/42","status":200,"sqlCount":1,"sqlMs":11.644,"durationMs":15.397,"poolWaiting":0,"cache":"miss"}
{"trace":"e991a696-21b8-4779-89fd-1720e7ec39fc","route":"/produits/42","status":200,"sqlCount":1,"sqlMs":22.888,"durationMs":23.388,"poolWaiting":0,"cache":"indisponible"}
{"trace":"eedf73d6-060a-4313-ac85-68f81b847c2b","route":"/produits/42","status":200,"sqlCount":1,"sqlMs":11.907,"durationMs":16.105,"poolWaiting":0,"cache":"miss"}
{"trace":"dc7c3c13-2a79-4a14-8cfe-2dc0eef19bd4","route":"/produits/42","status":200,"sqlCount":0,"sqlMs":0,"durationMs":1.858,"poolWaiting":0,"cache":"hit"}
{"trace":"059faae2-565d-493f-8713-a293146fe355","route":"/produits/42","status":200,"sqlCount":1,"sqlMs":16.422,"durationMs":18.493,"poolWaiting":0}
{"trace":"0eeb1b96-10d6-47dc-83bf-60b19f9e3b5a","route":"/produits/42","status":200,"sqlCount":1,"sqlMs":2.371,"durationMs":4.857,"poolWaiting":0,"cache":"miss"}

```

### configuration_initiale.json

```json
{
  "CACHE_TTL_SECONDS_avant": "5",
  "TTL_effectif_par_defaut_si_absent": 5
}

```
