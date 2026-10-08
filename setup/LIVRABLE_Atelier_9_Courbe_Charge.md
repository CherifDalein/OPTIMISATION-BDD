# Atelier 9 — Courbe de charge HTTP avant/après

Références : README Jour5 et fiche Linux de l’atelier 9.

## Protocole

Scénario : `/commandes?limit=20&pagination=curseur`, client autorisé 42. État initial : `relations=n1` ; solution : `relations=groupe`. Même contenu, même base et mêmes paramètres ; seul le chargement des relations change.

Charge fermée : chaque client attend sa réponse avant l’appel suivant. Niveaux : **1, 5, 10, 20 clients** ; échauffement **10 s**, mesure **30 s** par niveau ; timeout HTTP **15 s**. API et générateur sur le même poste. Contrôler l’équivalence des réponses avant la charge ; conserver p50, p95, débit, erreurs et SQL/requête, avec observations du pool, des sessions PostgreSQL et des ressources Docker pendant la charge.

Mesures effectuées avec le protocole ci-dessus ; résultats et observations présentés ci-dessous, réponses et résumés complets en annexe.

## Contrôle initial

Aide Jour5 chargée depuis `01_server/api`. `/observations` : **redisPret=true**, pool **total=0**, **inactives=0**, **enAttente=0**, avant charge.

Versions relevées : **Node v26.10.0**, **Docker Compose v5.5.1**, **PostgreSQL 18.6 Debian aarch64, 64 bits**.

| Conteneur avant charge | CPU | Mémoire utilisée | Limite affichée |
|---|---:|---:|---:|
| api-pgadmin-1 | 0,02 % | 335,2 MiB | 3,825 GiB |
| api-postgres-1 | 3,58 % | 80,02 MiB | 3,825 GiB |
| api-redis-1 | 8,28 % | 12,9 MiB | 3,825 GiB |
| fleetpulse-registry | 6,97 % | 261,3 MiB | 3,825 GiB |

Observation ponctuelle avant charge. Un conteneur extérieur au laboratoire (`fleetpulse-registry`) est actif sur le même poste ; les ressources sont partagées. La limite Docker affichée n’est pas une mesure de RAM hôte disponible.

## Contrôle fonctionnel avant charge

Deux appels avec même page (`limit=20`, pagination curseur) : comparaison des corps JSON complets → **Réponses identiques**.

| Mode | HTTP | SQL | HttpMs | TraceId |
|---|---:|---:|---:|---|
| N+1 | 200 | 21 | 127,259 | 7107a064-3564-4bc0-b353-018ffd053919 |
| Groupé | 200 | 2 | 27,571 | 3300796c-e934-45d7-a7d9-663a86b04e05 |

Appels de contrôle isolés, distincts des campagnes de charge. CSV : `02_Laboratoire/Jour4/resultats/mesures_linux_20261008T092117188Z_12e16f.csv`.

## Série AVANT — N+1

Campagne complète : clients 1, 5, 10, 20 ; 10 s d’échauffement et 30 s de mesure par point. Aucun arrêt manuel.

| Clients | Terminées | req/s | p50 ms | p95 ms | Erreurs | SQL/requête |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 3622 | 120.73 | 7.63 | 10.02 | 0 | 21.00 |
| 5 | 11474 | 382.36 | 10.56 | 24.30 | 0 | 21.00 |
| 10 | 12822 | 426.25 | 20.41 | 38.62 | 0 | 21.00 |
| 20 | 12851 | 428.01 | 43.79 | 59.96 | 0 | 21.00 |

Observation pendant la série (niveau exact non relevé) : pool total=5, inactives=0, enAttente=0 ; Redis prêt. PostgreSQL : 1 session active sans wait_type, 2 idle sans wait_type, 4 idle/Client. La commande de supervision elle-même peut contribuer à la session active. Docker : PostgreSQL CPU=95,00 %, mémoire=90,55 MiB ; Redis CPU=0,15 %, mémoire=12,93 MiB ; pgAdmin CPU=0,40 %, mémoire=335 MiB ; fleetpulse-registry CPU=2,42 %, mémoire=263,6 MiB. Limite affichée : 3,825 GiB.

Le débit plafonne vers 426–428 req/s entre 10 et 20 clients, tandis que le p95 passe de 38,62 à 59,96 ms. Cela signale une limite de capacité dans ce scénario sans erreur HTTP. L’observation CPU est compatible avec une forte sollicitation PostgreSQL, sans établir à elle seule la cause exacte ; aucune attente de pool n’a été observée à l’instant du relevé. 95 % dans docker stats correspond approximativement à l’occupation d’un cœur, pas nécessairement à celle de tout le poste.

## Série APRÈS — groupé

Même endpoint, données, niveaux et durées ; seul relations=n1 devient relations=groupe. Campagne complète sans erreur.

| Clients | Terminées | req/s | p50 ms | p95 ms | Erreurs | SQL/requête |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 20954 | 698.43 | 1.25 | 1.98 | 0 | 2.00 |
| 5 | 47163 | 1572.00 | 1.96 | 7.31 | 0 | 2.00 |
| 10 | 75344 | 2511.27 | 3.45 | 6.45 | 0 | 2.00 |
| 20 | 67679 | 2255.59 | 7.41 | 15.50 | 0 | 2.00 |

Observation pendant la série (niveau exact non relevé) : pool total=1, inactives=0, enAttente=0, Redis prêt. PostgreSQL : 1 session active sans wait_type et 2 idle/Client. Docker : PostgreSQL CPU=21,38 %, mémoire=83,46 MiB ; Redis CPU=0,14 %, mémoire=13,08 MiB ; pgAdmin CPU=0,02 %, mémoire=335,2 MiB ; fleetpulse-registry CPU=0,09 %, mémoire=263,6 MiB. Limite affichée : 3,825 GiB.

Ce relevé ponctuel n’est pas aligné sur un niveau identifié de la série avant : la baisse de CPU ne doit pas être utilisée comme un pourcentage de gain à charge égale. Le débit groupé baisse de 2511,27 à 2255,59 req/s entre 10 et 20 clients, tandis que le p95 monte de 6,45 à 15,50 ms : signe d’une limite de capacité dans ces conditions locales, sans erreur HTTP.

## Solution et SQL comparés

```bash
node "$J5_BENCH" run --label avant_n1 \
 --path '/commandes?limit=20&pagination=curseur&relations=n1' \
 --clients 1,5,10,20 --warmup 10 --seconds 30
node "$J5_BENCH" run --label apres_groupe \
 --path '/commandes?limit=20&pagination=curseur&relations=groupe' \
 --clients 1,5,10,20 --warmup 10 --seconds 30
node "$J5_BENCH" compare --before avant_n1 --after apres_groupe
```

La requête de commandes et le tri restent identiques. La correction remplace les vingt lectures individuelles des relations par une lecture groupée :

```sql
-- Page : paramètres client 42 et limit+1=21
SELECT id::text AS id,
 to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
 statut,total::text AS total
FROM shopflow.commandes WHERE client_id=$1
ORDER BY commandes.created_at DESC,commandes.id DESC LIMIT $2;

-- Avant : une fois par commande (20 fois)
SELECT commande_id::text AS commande_id,produit_id::text AS produit_id,
 qte,prix_unitaire::text AS prix_unitaire
FROM shopflow.lignes WHERE commande_id=$1 ORDER BY lignes.produit_id;

-- Après : une seule lecture pour les 20 commandes effectivement renvoyées
SELECT commande_id::text AS commande_id,produit_id::text AS produit_id,
 qte,prix_unitaire::text AS prix_unitaire
FROM shopflow.lignes WHERE commande_id=ANY($1::bigint[])
ORDER BY lignes.commande_id,lignes.produit_id;
```

## Comparaison à concurrence égale

| Clients | p95 avant ms | p95 après ms | Réduction p95 | req/s avant | req/s après | Facteur débit | Erreurs avant/après |
|---:|---:|---:|---:|---:|---:|---:|---|
| 1 | 10.02 | 1.98 | 80.2 % | 120.73 | 698.43 | ×5.79 | 0.00 % / 0.00 % |
| 5 | 24.30 | 7.31 | 69.9 % | 382.36 | 1572.00 | ×4.11 | 0.00 % / 0.00 % |
| 10 | 38.62 | 6.45 | 83.3 % | 426.25 | 2511.27 | ×5.89 | 0.00 % / 0.00 % |
| 20 | 59.96 | 15.50 | 74.1 % | 428.01 | 2255.59 | ×5.27 | 0.00 % / 0.00 % |

SQL moyen par requête : **21 avant, 2 après** aux quatre niveaux. Réduction p95 = (avant−après)/avant ; facteur débit = après/avant. Le résultat fonctionnel a été contrôlé avant la charge, sans changement de projection, pagination ni données.

## Explication et décision

**Retenir le chargement groupé.** Il évite 19 instructions SQL par page et les échanges correspondants. À 10 clients, p95 **38,62 → 6,45 ms (−83,3 %)** et débit **426,25 → 2511,27 req/s (×5,89)**, sans erreurs.

**Saturation observée :** avant, le débit plafonne entre 10 et 20 clients, avec p95 croissant. Après, le débit baisse de 10 à 20 clients tandis que le p95 augmente : limite de capacité visible à 20 clients sur ce scénario. Les observations ponctuelles ne permettent pas d’attribuer précisément ce coude au CPU, au pool ou au générateur ; elles ne montrent aucune attente de pool à leur instant de capture.

**Charge fermée :** chaque client attend sa réponse ; un service plus lent réduit le rythme des nouveaux appels. Il faut lire latence, débit et erreurs ensemble. X-SQL-Count prouve le travail SQL évité, pas une accélération identique de chaque couche. Le générateur et l’API partagent la machine ; fleetpulse-registry est actif. Séries successives, une campagne par état : conclusion locale, pas capacité de production.

**Test suivant :** répéter et alterner les séries, aligner les observations sur chaque niveau, puis tester avec générateur séparé, données et arrivées représentatives. Courbes et résumés ci-dessous proviennent des mesures brutes archivées.

## Courbes intégrées

<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1100" height="620" viewBox="0 0 1100 620"><rect width="100%" height="100%" fill="white"/><text x="95" y="38" font-family="Arial" font-size="28" font-weight="700" fill="#123a52">avant_n1 vs apres_groupe - p95</text><line x1="95" y1="535" x2="1060" y2="535" stroke="#d8e2e8"/><text x="83" y="540" text-anchor="end" font-family="Arial" font-size="14" fill="#4f5f69">0.0</text><line x1="95" y1="443" x2="1060" y2="443" stroke="#d8e2e8"/><text x="83" y="448" text-anchor="end" font-family="Arial" font-size="14" fill="#4f5f69">13</text><line x1="95" y1="351" x2="1060" y2="351" stroke="#d8e2e8"/><text x="83" y="356" text-anchor="end" font-family="Arial" font-size="14" fill="#4f5f69">27</text><line x1="95" y1="259" x2="1060" y2="259" stroke="#d8e2e8"/><text x="83" y="264" text-anchor="end" font-family="Arial" font-size="14" fill="#4f5f69">40</text><line x1="95" y1="167" x2="1060" y2="167" stroke="#d8e2e8"/><text x="83" y="172" text-anchor="end" font-family="Arial" font-size="14" fill="#4f5f69">54</text><line x1="95" y1="75" x2="1060" y2="75" stroke="#d8e2e8"/><text x="83" y="80" text-anchor="end" font-family="Arial" font-size="14" fill="#4f5f69">67</text><line x1="95" y1="75" x2="95" y2="535" stroke="#6b7d88"/><line x1="95" y1="535" x2="1060" y2="535" stroke="#6b7d88"/><text x="95" y="563" text-anchor="middle" font-family="Arial" font-size="15" fill="#33434d">1</text><text x="416.6666666666667" y="563" text-anchor="middle" font-family="Arial" font-size="15" fill="#33434d">5</text><text x="738.3333333333334" y="563" text-anchor="middle" font-family="Arial" font-size="15" fill="#33434d">10</text><text x="1060" y="563" text-anchor="middle" font-family="Arial" font-size="15" fill="#33434d">20</text><text x="577.5" y="598" text-anchor="middle" font-family="Arial" font-size="16" fill="#33434d">Clients simultanés</text><text transform="translate(24 305) rotate(-90)" text-anchor="middle" font-family="Arial" font-size="16" fill="#33434d">p95 (ms)</text><polyline fill="none" stroke="#123a52" stroke-width="4" points="95,466.3649575907748 416.6666666666667,368.5497474506814 738.3333333333334,270.4605451253217 1060,124.28571428571433"/><circle cx="95" cy="466.3649575907748" r="6" fill="#123a52"/><circle cx="416.6666666666667" cy="368.5497474506814" r="6" fill="#123a52"/><circle cx="738.3333333333334" cy="270.4605451253217" r="6" fill="#123a52"/><circle cx="1060" cy="124.28571428571433" r="6" fill="#123a52"/><rect x="95" y="562" width="22" height="5" fill="#123a52"/><text x="125" y="569" font-family="Arial" font-size="15" fill="#33434d">avant_n1</text><polyline fill="none" stroke="#00a5b5" stroke-width="4" points="95,521.4373868293147 416.6666666666667,484.92792814257126 738.3333333333334,490.8187601257982 1060,428.82802820928237"/><circle cx="95" cy="521.4373868293147" r="6" fill="#00a5b5"/><circle cx="416.6666666666667" cy="484.92792814257126" r="6" fill="#00a5b5"/><circle cx="738.3333333333334" cy="490.8187601257982" r="6" fill="#00a5b5"/><circle cx="1060" cy="428.82802820928237" r="6" fill="#00a5b5"/><rect x="345" y="562" width="22" height="5" fill="#00a5b5"/><text x="375" y="569" font-family="Arial" font-size="15" fill="#33434d">apres_groupe</text></svg>

<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1100" height="620" viewBox="0 0 1100 620"><rect width="100%" height="100%" fill="white"/><text x="95" y="38" font-family="Arial" font-size="28" font-weight="700" fill="#123a52">avant_n1 vs apres_groupe - débit</text><line x1="95" y1="535" x2="1060" y2="535" stroke="#d8e2e8"/><text x="83" y="540" text-anchor="end" font-family="Arial" font-size="14" fill="#4f5f69">0.0</text><line x1="95" y1="443" x2="1060" y2="443" stroke="#d8e2e8"/><text x="83" y="448" text-anchor="end" font-family="Arial" font-size="14" fill="#4f5f69">563</text><line x1="95" y1="351" x2="1060" y2="351" stroke="#d8e2e8"/><text x="83" y="356" text-anchor="end" font-family="Arial" font-size="14" fill="#4f5f69">1125</text><line x1="95" y1="259" x2="1060" y2="259" stroke="#d8e2e8"/><text x="83" y="264" text-anchor="end" font-family="Arial" font-size="14" fill="#4f5f69">1688</text><line x1="95" y1="167" x2="1060" y2="167" stroke="#d8e2e8"/><text x="83" y="172" text-anchor="end" font-family="Arial" font-size="14" fill="#4f5f69">2250</text><line x1="95" y1="75" x2="1060" y2="75" stroke="#d8e2e8"/><text x="83" y="80" text-anchor="end" font-family="Arial" font-size="14" fill="#4f5f69">2813</text><line x1="95" y1="75" x2="95" y2="535" stroke="#6b7d88"/><line x1="95" y1="535" x2="1060" y2="535" stroke="#6b7d88"/><text x="95" y="563" text-anchor="middle" font-family="Arial" font-size="15" fill="#33434d">1</text><text x="416.6666666666667" y="563" text-anchor="middle" font-family="Arial" font-size="15" fill="#33434d">5</text><text x="738.3333333333334" y="563" text-anchor="middle" font-family="Arial" font-size="15" fill="#33434d">10</text><text x="1060" y="563" text-anchor="middle" font-family="Arial" font-size="15" fill="#33434d">20</text><text x="577.5" y="598" text-anchor="middle" font-family="Arial" font-size="16" fill="#33434d">Clients simultanés</text><text transform="translate(24 305) rotate(-90)" text-anchor="middle" font-family="Arial" font-size="16" fill="#33434d">requêtes/s</text><polyline fill="none" stroke="#123a52" stroke-width="4" points="95,515.2547970890084 416.6666666666667,472.46561927402695 738.3333333333334,465.2874783333874 1060,464.99963308263494"/><circle cx="95" cy="515.2547970890084" r="6" fill="#123a52"/><circle cx="416.6666666666667" cy="472.46561927402695" r="6" fill="#123a52"/><circle cx="738.3333333333334" cy="465.2874783333874" r="6" fill="#123a52"/><circle cx="1060" cy="464.99963308263494" r="6" fill="#123a52"/><rect x="95" y="562" width="22" height="5" fill="#123a52"/><text x="125" y="569" font-family="Arial" font-size="15" fill="#33434d">avant_n1</text><polyline fill="none" stroke="#00a5b5" stroke-width="4" points="95,420.7728644982704 416.6666666666667,277.90185557791193 738.3333333333334,124.28571428571433 1060,166.10177889502694"/><circle cx="95" cy="420.7728644982704" r="6" fill="#00a5b5"/><circle cx="416.6666666666667" cy="277.90185557791193" r="6" fill="#00a5b5"/><circle cx="738.3333333333334" cy="124.28571428571433" r="6" fill="#00a5b5"/><circle cx="1060" cy="166.10177889502694" r="6" fill="#00a5b5"/><rect x="345" y="562" width="22" height="5" fill="#00a5b5"/><text x="375" y="569" font-family="Arial" font-size="15" fill="#33434d">apres_groupe</text></svg>

## Annexes — Preuves

### controle_equivalence.jsonl

```json
{"Label":"j9_controle_n1","Status":200,"SqlCount":21,"Cache":"","HttpMs":127.259,"TraceId":"7107a064-3564-4bc0-b353-018ffd053919","Body":{"data":[{"id":"86042","created_at":"2026-09-12T23:54:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"86042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"86042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"86042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"83042","created_at":"2026-09-12T23:04:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"83042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"83042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"83042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"80042","created_at":"2026-09-12T22:14:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"80042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"80042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"80042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"77042","created_at":"2026-09-12T21:24:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"77042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"77042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"77042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"74042","created_at":"2026-09-12T20:34:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"74042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"74042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"74042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"71042","created_at":"2026-09-12T19:44:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"71042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"71042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"71042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"68042","created_at":"2026-09-12T18:54:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"68042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"68042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"68042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"65042","created_at":"2026-09-12T18:04:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"65042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"65042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"65042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"62042","created_at":"2026-09-12T17:14:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"62042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"62042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"62042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"59042","created_at":"2026-09-12T16:24:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"59042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"59042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"59042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"56042","created_at":"2026-09-12T15:34:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"56042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"56042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"56042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"53042","created_at":"2026-09-12T14:44:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"53042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"53042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"53042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"50042","created_at":"2026-09-12T13:54:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"50042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"50042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"50042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"47042","created_at":"2026-09-12T13:04:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"47042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"47042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"47042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"44042","created_at":"2026-09-12T12:14:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"44042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"44042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"44042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"41042","created_at":"2026-09-12T11:24:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"41042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"41042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"41042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"38042","created_at":"2026-09-12T10:34:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"38042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"38042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"38042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"35042","created_at":"2026-09-12T09:44:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"35042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"35042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"35042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"32042","created_at":"2026-09-12T08:54:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"32042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"32042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"32042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"29042","created_at":"2026-09-12T08:04:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"29042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"29042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"29042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]}],"hasNextPage":true,"nextCursor":"eyJ2IjoxLCJjbGllbnRJZCI6IjQyIiwiZGF0ZSI6IjIwMjYtMDktMTJUMDg6MDQ6MDIuMDAwMDAwWiIsImlkIjoiMjkwNDIifQ.-8akB0gWWnMKadehIh_owEhG5gkmQREIWKs9j8hbO0M"}}
{"Label":"j9_controle_groupe","Status":200,"SqlCount":2,"Cache":"","HttpMs":27.571,"TraceId":"3300796c-e934-45d7-a7d9-663a86b04e05","Body":{"data":[{"id":"86042","created_at":"2026-09-12T23:54:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"86042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"86042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"86042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"83042","created_at":"2026-09-12T23:04:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"83042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"83042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"83042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"80042","created_at":"2026-09-12T22:14:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"80042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"80042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"80042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"77042","created_at":"2026-09-12T21:24:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"77042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"77042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"77042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"74042","created_at":"2026-09-12T20:34:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"74042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"74042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"74042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"71042","created_at":"2026-09-12T19:44:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"71042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"71042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"71042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"68042","created_at":"2026-09-12T18:54:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"68042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"68042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"68042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"65042","created_at":"2026-09-12T18:04:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"65042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"65042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"65042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"62042","created_at":"2026-09-12T17:14:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"62042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"62042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"62042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"59042","created_at":"2026-09-12T16:24:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"59042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"59042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"59042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"56042","created_at":"2026-09-12T15:34:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"56042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"56042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"56042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"53042","created_at":"2026-09-12T14:44:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"53042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"53042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"53042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"50042","created_at":"2026-09-12T13:54:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"50042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"50042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"50042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"47042","created_at":"2026-09-12T13:04:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"47042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"47042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"47042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"44042","created_at":"2026-09-12T12:14:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"44042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"44042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"44042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"41042","created_at":"2026-09-12T11:24:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"41042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"41042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"41042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"38042","created_at":"2026-09-12T10:34:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"38042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"38042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"38042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"35042","created_at":"2026-09-12T09:44:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"35042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"35042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"35042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"32042","created_at":"2026-09-12T08:54:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"32042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"32042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"32042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]},{"id":"29042","created_at":"2026-09-12T08:04:02.000000Z","statut":"payee","total":"720.00","lignes":[{"commande_id":"29042","produit_id":"43","qte":3,"prix_unitaire":"58.75"},{"commande_id":"29042","produit_id":"60","qte":3,"prix_unitaire":"80.00"},{"commande_id":"29042","produit_id":"77","qte":3,"prix_unitaire":"101.25"}]}],"hasNextPage":true,"nextCursor":"eyJ2IjoxLCJjbGllbnRJZCI6IjQyIiwiZGF0ZSI6IjIwMjYtMDktMTJUMDg6MDQ6MDIuMDAwMDAwWiIsImlkIjoiMjkwNDIifQ.-8akB0gWWnMKadehIh_owEhG5gkmQREIWKs9j8hbO0M"}}

```

### avant_n1_resume.csv

```csv
"Label","Path","Clients","WarmupSec","MeasureSec","Completed","Errors","ErrorPct","ThroughputReqSec","P50Ms","P95Ms","MeanMs","AvgSqlPerRequest"
"avant_n1","/commandes?limit=20&pagination=curseur&relations=n1","1","10","30","3622","0","0.00","120.73","7.63","10.02","8.23","21.00"
"avant_n1","/commandes?limit=20&pagination=curseur&relations=n1","5","10","30","11474","0","0.00","382.36","10.56","24.30","13.03","21.00"
"avant_n1","/commandes?limit=20&pagination=curseur&relations=n1","10","10","30","12822","0","0.00","426.25","20.41","38.62","23.39","21.00"
"avant_n1","/commandes?limit=20&pagination=curseur&relations=n1","20","10","30","12851","0","0.00","428.01","43.79","59.96","46.66","21.00"

```

### apres_groupe_resume.csv

```csv
"Label","Path","Clients","WarmupSec","MeasureSec","Completed","Errors","ErrorPct","ThroughputReqSec","P50Ms","P95Ms","MeanMs","AvgSqlPerRequest"
"apres_groupe","/commandes?limit=20&pagination=curseur&relations=groupe","1","10","30","20954","0","0.00","698.43","1.25","1.98","1.39","2.00"
"apres_groupe","/commandes?limit=20&pagination=curseur&relations=groupe","5","10","30","47163","0","0.00","1572.00","1.96","7.31","3.13","2.00"
"apres_groupe","/commandes?limit=20&pagination=curseur&relations=groupe","10","10","30","75344","0","0.00","2511.27","3.45","6.45","3.93","2.00"
"apres_groupe","/commandes?limit=20&pagination=curseur&relations=groupe","20","10","30","67679","0","0.00","2255.59","7.41","15.50","8.81","2.00"

```

### avant_n1_vs_apres_groupe_comparaison.csv

```csv
"Clients","AvantP95Ms","ApresP95Ms","ReductionP95Pct","AvantReqSec","ApresReqSec","FacteurDebit","AvantErreurPct","ApresErreurPct","AvantSqlReq","ApresSqlReq"
"1","10.02","1.98","80.2","120.73","698.43","5.79","0.00","0.00","21.00","2.00"
"5","24.30","7.31","69.9","382.36","1572.00","4.11","0.00","0.00","21.00","2.00"
"10","38.62","6.45","83.3","426.25","2511.27","5.89","0.00","0.00","21.00","2.00"
"20","59.96","15.50","74.1","428.01","2255.59","5.27","0.00","0.00","21.00","2.00"

```

### observations_charge.json

```json
{
  "avant": {
    "pool": {
      "total": 5,
      "inactives": 0,
      "enAttente": 0
    },
    "redisPret": true,
    "postgres_sessions": [
      {
        "state": "active",
        "wait_type": "-",
        "sessions": 1
      },
      {
        "state": "idle",
        "wait_type": "-",
        "sessions": 2
      },
      {
        "state": "idle",
        "wait_type": "Client",
        "sessions": 4
      }
    ],
    "docker": {
      "postgres": {
        "cpu_pct": 95,
        "memory_MiB": 90.55
      },
      "redis": {
        "cpu_pct": 0.15,
        "memory_MiB": 12.93
      },
      "pgadmin": {
        "cpu_pct": 0.4,
        "memory_MiB": 335
      },
      "fleetpulse-registry": {
        "cpu_pct": 2.42,
        "memory_MiB": 263.6
      }
    },
    "niveau_charge": "non identifié"
  },
  "apres": {
    "pool": {
      "total": 1,
      "inactives": 0,
      "enAttente": 0
    },
    "redisPret": true,
    "postgres_sessions": [
      {
        "state": "active",
        "wait_type": "-",
        "sessions": 1
      },
      {
        "state": "idle",
        "wait_type": "Client",
        "sessions": 2
      }
    ],
    "docker": {
      "postgres": {
        "cpu_pct": 21.38,
        "memory_MiB": 83.46
      },
      "redis": {
        "cpu_pct": 0.14,
        "memory_MiB": 13.08
      },
      "pgadmin": {
        "cpu_pct": 0.02,
        "memory_MiB": 335.2
      },
      "fleetpulse-registry": {
        "cpu_pct": 0.09,
        "memory_MiB": 263.6
      }
    },
    "niveau_charge": "non identifié"
  }
}

```

### avant_n1_terminal.txt

```text
bash-3.2$ printf '%s\n' "$n1" "$groupe" > ../../02_Laboratoire/Jour5/controle_equivalence.jsonl
bash-3.2$ node "$J5_BENCH" run --label avant_n1 --path '/commandes?limit=20&pagination=curseur&relations=n1' --clients 1,5,10,20 --warmup 10 --seconds 30
API http://127.0.0.1:3000 | client labo 42 | scénario avant_n1
Charge fermée | warmup 10s | mesure 30s | /commandes?limit=20&pagination=curseur&relations=n1

[avant_n1] 1 client(s) - échauffement...
[avant_n1] 1 client(s) - mesure...
┌─────────┬────────────┬───────────────────────────────────────────────────────┬─────────┬───────────┬────────────┬───────────┬────────┬──────────┬──────────────────┬────────┬─────────┬────────┬──────────────────┐
│ (index) │ Label      │ Path                                                  │ Clients │ WarmupSec │ MeasureSec │ Completed │ Errors │ ErrorPct │ ThroughputReqSec │ P50Ms  │ P95Ms   │ MeanMs │ AvgSqlPerRequest │
├─────────┼────────────┼───────────────────────────────────────────────────────┼─────────┼───────────┼────────────┼───────────┼────────┼──────────┼──────────────────┼────────┼─────────┼────────┼──────────────────┤
│ 0       │ 'avant_n1' │ '/commandes?limit=20&pagination=curseur&relations=n1' │ 1       │ 10        │ 30         │ 3622      │ 0      │ '0.00'   │ '120.73'         │ '7.63' │ '10.02' │ '8.23' │ '21.00'          │
└─────────┴────────────┴───────────────────────────────────────────────────────┴─────────┴───────────┴────────────┴───────────┴────────┴──────────┴──────────────────┴────────┴─────────┴────────┴──────────────────┘

[avant_n1] 5 client(s) - échauffement...
[avant_n1] 5 client(s) - mesure...
┌─────────┬────────────┬───────────────────────────────────────────────────────┬─────────┬───────────┬────────────┬───────────┬────────┬──────────┬──────────────────┬─────────┬─────────┬─────────┬──────────────────┐
│ (index) │ Label      │ Path                                                  │ Clients │ WarmupSec │ MeasureSec │ Completed │ Errors │ ErrorPct │ ThroughputReqSec │ P50Ms   │ P95Ms   │ MeanMs  │ AvgSqlPerRequest │
├─────────┼────────────┼───────────────────────────────────────────────────────┼─────────┼───────────┼────────────┼───────────┼────────┼──────────┼──────────────────┼─────────┼─────────┼─────────┼──────────────────┤
│ 0       │ 'avant_n1' │ '/commandes?limit=20&pagination=curseur&relations=n1' │ 5       │ 10        │ 30         │ 11474     │ 0      │ '0.00'   │ '382.36'         │ '10.56' │ '24.30' │ '13.03' │ '21.00'          │
└─────────┴────────────┴───────────────────────────────────────────────────────┴─────────┴───────────┴────────────┴───────────┴────────┴──────────┴──────────────────┴─────────┴─────────┴─────────┴──────────────────┘

[avant_n1] 10 client(s) - échauffement...
[avant_n1] 10 client(s) - mesure...
┌─────────┬────────────┬───────────────────────────────────────────────────────┬─────────┬───────────┬────────────┬───────────┬────────┬──────────┬──────────────────┬─────────┬─────────┬─────────┬──────────────────┐
│ (index) │ Label      │ Path                                                  │ Clients │ WarmupSec │ MeasureSec │ Completed │ Errors │ ErrorPct │ ThroughputReqSec │ P50Ms   │ P95Ms   │ MeanMs  │ AvgSqlPerRequest │
├─────────┼────────────┼───────────────────────────────────────────────────────┼─────────┼───────────┼────────────┼───────────┼────────┼──────────┼──────────────────┼─────────┼─────────┼─────────┼──────────────────┤
│ 0       │ 'avant_n1' │ '/commandes?limit=20&pagination=curseur&relations=n1' │ 10      │ 10        │ 30         │ 12822     │ 0      │ '0.00'   │ '426.25'         │ '20.41' │ '38.62' │ '23.39' │ '21.00'          │
└─────────┴────────────┴───────────────────────────────────────────────────────┴─────────┴───────────┴────────────┴───────────┴────────┴──────────┴──────────────────┴─────────┴─────────┴─────────┴──────────────────┘

[avant_n1] 20 client(s) - échauffement...
[avant_n1] 20 client(s) - mesure...
┌─────────┬────────────┬───────────────────────────────────────────────────────┬─────────┬───────────┬────────────┬───────────┬────────┬──────────┬──────────────────┬─────────┬─────────┬─────────┬──────────────────┐
│ (index) │ Label      │ Path                                                  │ Clients │ WarmupSec │ MeasureSec │ Completed │ Errors │ ErrorPct │ ThroughputReqSec │ P50Ms   │ P95Ms   │ MeanMs  │ AvgSqlPerRequest │
├─────────┼────────────┼───────────────────────────────────────────────────────┼─────────┼───────────┼────────────┼───────────┼────────┼──────────┼──────────────────┼─────────┼─────────┼─────────┼──────────────────┤
│ 0       │ 'avant_n1' │ '/commandes?limit=20&pagination=curseur&relations=n1' │ 20      │ 10        │ 30         │ 12851     │ 0      │ '0.00'   │ '428.01'         │ '43.79' │ '59.96' │ '46.66' │ '21.00'          │
└─────────┴────────────┴───────────────────────────────────────────────────────┴─────────┴───────────┴────────────┴───────────┴────────┴──────────┴──────────────────┴─────────┴─────────┴─────────┴──────────────────┘

Résultats : /Users/Cherif/Documents/Cours 26-27/Optimisation BDD/setup/02_Laboratoire/Jour5/resultats
bash-3.2$ 
```

### apres_groupe_terminal.txt

```text
bash-3.2$ node "$J5_BENCH" run --label apres_groupe --path '/commandes?limit=20&pagination=curseur&relations=groupe' --clients 1,5,10,20 --warmup 10 --seconds 30
API http://127.0.0.1:3000 | client labo 42 | scénario apres_groupe
Charge fermée | warmup 10s | mesure 30s | /commandes?limit=20&pagination=curseur&relations=groupe

[apres_groupe] 1 client(s) - échauffement...
[apres_groupe] 1 client(s) - mesure...
┌─────────┬────────────────┬───────────────────────────────────────────────────────────┬─────────┬───────────┬────────────┬───────────┬────────┬──────────┬──────────────────┬────────┬────────┬────────┬──────────────────┐
│ (index) │ Label          │ Path                                                      │ Clients │ WarmupSec │ MeasureSec │ Completed │ Errors │ ErrorPct │ ThroughputReqSec │ P50Ms  │ P95Ms  │ MeanMs │ AvgSqlPerRequest │
├─────────┼────────────────┼───────────────────────────────────────────────────────────┼─────────┼───────────┼────────────┼───────────┼────────┼──────────┼──────────────────┼────────┼────────┼────────┼──────────────────┤
│ 0       │ 'apres_groupe' │ '/commandes?limit=20&pagination=curseur&relations=groupe' │ 1       │ 10        │ 30         │ 20954     │ 0      │ '0.00'   │ '698.43'         │ '1.25' │ '1.98' │ '1.39' │ '2.00'           │
└─────────┴────────────────┴───────────────────────────────────────────────────────────┴─────────┴───────────┴────────────┴───────────┴────────┴──────────┴──────────────────┴────────┴────────┴────────┴──────────────────┘

[apres_groupe] 5 client(s) - échauffement...
[apres_groupe] 5 client(s) - mesure...
┌─────────┬────────────────┬───────────────────────────────────────────────────────────┬─────────┬───────────┬────────────┬───────────┬────────┬──────────┬──────────────────┬────────┬────────┬────────┬──────────────────┐
│ (index) │ Label          │ Path                                                      │ Clients │ WarmupSec │ MeasureSec │ Completed │ Errors │ ErrorPct │ ThroughputReqSec │ P50Ms  │ P95Ms  │ MeanMs │ AvgSqlPerRequest │
├─────────┼────────────────┼───────────────────────────────────────────────────────────┼─────────┼───────────┼────────────┼───────────┼────────┼──────────┼──────────────────┼────────┼────────┼────────┼──────────────────┤
│ 0       │ 'apres_groupe' │ '/commandes?limit=20&pagination=curseur&relations=groupe' │ 5       │ 10        │ 30         │ 47163     │ 0      │ '0.00'   │ '1572.00'        │ '1.96' │ '7.31' │ '3.13' │ '2.00'           │
└─────────┴────────────────┴───────────────────────────────────────────────────────────┴─────────┴───────────┴────────────┴───────────┴────────┴──────────┴──────────────────┴────────┴────────┴────────┴──────────────────┘

[apres_groupe] 10 client(s) - échauffement...
[apres_groupe] 10 client(s) - mesure...
┌─────────┬────────────────┬───────────────────────────────────────────────────────────┬─────────┬───────────┬────────────┬───────────┬────────┬──────────┬──────────────────┬────────┬────────┬────────┬──────────────────┐
│ (index) │ Label          │ Path                                                      │ Clients │ WarmupSec │ MeasureSec │ Completed │ Errors │ ErrorPct │ ThroughputReqSec │ P50Ms  │ P95Ms  │ MeanMs │ AvgSqlPerRequest │
├─────────┼────────────────┼───────────────────────────────────────────────────────────┼─────────┼───────────┼────────────┼───────────┼────────┼──────────┼──────────────────┼────────┼────────┼────────┼──────────────────┤
│ 0       │ 'apres_groupe' │ '/commandes?limit=20&pagination=curseur&relations=groupe' │ 10      │ 10        │ 30         │ 75344     │ 0      │ '0.00'   │ '2511.27'        │ '3.45' │ '6.45' │ '3.93' │ '2.00'           │
└─────────┴────────────────┴───────────────────────────────────────────────────────────┴─────────┴───────────┴────────────┴───────────┴────────┴──────────┴──────────────────┴────────┴────────┴────────┴──────────────────┘

[apres_groupe] 20 client(s) - échauffement...
[apres_groupe] 20 client(s) - mesure...
┌─────────┬────────────────┬───────────────────────────────────────────────────────────┬─────────┬───────────┬────────────┬───────────┬────────┬──────────┬──────────────────┬────────┬─────────┬────────┬──────────────────┐
│ (index) │ Label          │ Path                                                      │ Clients │ WarmupSec │ MeasureSec │ Completed │ Errors │ ErrorPct │ ThroughputReqSec │ P50Ms  │ P95Ms   │ MeanMs │ AvgSqlPerRequest │
├─────────┼────────────────┼───────────────────────────────────────────────────────────┼─────────┼───────────┼────────────┼───────────┼────────┼──────────┼──────────────────┼────────┼─────────┼────────┼──────────────────┤
│ 0       │ 'apres_groupe' │ '/commandes?limit=20&pagination=curseur&relations=groupe' │ 20      │ 10        │ 30         │ 67679     │ 0      │ '0.00'   │ '2255.59'        │ '7.41' │ '15.50' │ '8.81' │ '2.00'           │
└─────────┴────────────────┴───────────────────────────────────────────────────────────┴─────────┴───────────┴────────────┴───────────┴────────┴──────────┴──────────────────┴────────┴─────────┴────────┴──────────────────┘

Résultats : /Users/Cherif/Documents/Cours 26-27/Optimisation BDD/setup/02_Laboratoire/Jour5/resultats
```

### Sorties brutes par requête — extraits et contrôles

Les CSV complets sont archivés sous `preuves/atelier9`. Pour garder le document lisible, les extraits suivants présentent la première mesure de chaque niveau ; les résumés complets et les courbes sont intégrés ci-dessus.

#### avant_n1

Nombre de lignes brutes vérifié par niveau : 1 clients : 3622, 5 clients : 11474, 10 clients : 12822, 20 clients : 12851.

```csv
At,Clients,Worker,Seq,Status,Ok,HttpMs,SqlCount,TraceId,Error
2026-10-08T09:22:17.549Z,1,1,1,200,true,7.910,21,fee24dbd-80ec-477a-8ba5-c0ac03077e86,
2026-10-08T09:22:57.562Z,5,5,5,200,true,10.212,21,b228baf3-6fa1-4245-b9e1-af65ea16f3d3,
2026-10-08T09:23:37.586Z,10,8,8,200,true,23.573,21,86c2ecb1-7a54-4ef1-ac9d-039602599f18,
2026-10-08T09:24:17.706Z,20,4,4,200,true,81.573,21,6b9d393c-b1f7-4adf-892e-394f7fb5fbcf,
```

#### apres_groupe

Nombre de lignes brutes vérifié par niveau : 1 clients : 20954, 5 clients : 47163, 10 clients : 75344, 20 clients : 67679.

```csv
At,Clients,Worker,Seq,Status,Ok,HttpMs,SqlCount,TraceId,Error
2026-10-08T09:27:30.979Z,1,1,1,200,true,1.459,2,7845de0a-0db3-40ac-8f01-a7056fb4c4b3,
2026-10-08T09:28:10.994Z,5,4,4,200,true,1.519,2,b6b277b8-7fab-42ae-88c4-527ad95af1cf,
2026-10-08T09:28:51.032Z,10,3,3,200,true,2.964,2,fc2ac727-d83f-47e3-b8c3-23844fda5a6b,
2026-10-08T09:29:31.083Z,20,3,3,200,true,13.616,2,b6291dfc-dcdb-45fc-858a-6b8db19f26e6,
```
