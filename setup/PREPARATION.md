# Laboratoire ShopFlow

Les scripts accompagnent les diapositives. Ils visent PostgreSQL 18 dans une base dédiée.

## Démarrage de l’API et des services

Prérequis : Node.js 22 ou supérieur (24 LTS conseillé), npm et Docker avec Compose, ou PostgreSQL/Redis locaux équivalents. Le compose utilise PostgreSQL 18 et Redis 8. Les ports locaux sont 55432, 56379 et 3000. Le jeton et le compte fournis sont uniquement des paramètres de laboratoire sur la machine locale. L’API écoute sur 127.0.0.1. PgAdmin écoute sur le port 5050

Dans le sous-dossier `api` :

# windows

Copy-Item -LiteralPath .env.example -Destination .env

# linux

cp ./.env.example .env

# Adapter LAB_TOKEN et CURSOR_SECRET dans .env.

docker compose up -d --wait
npm ci
npm test
npm start ## l'API est lancée

L’initialisation PostgreSQL charge automatiquement les deux scripts du laboratoire **au premier démarrage d’un volume vide**. Si le volume existe déjà, ces scripts ne sont pas relancés.

## ===============================================

# Pour ouvrir une session SQL

A partir d'un autre terminal, depuis le dossier api, pour ouvrir une session SQL : docker compose exec postgres psql -U cours -d shopflow

## Pour exécuter un fichier sans l'ouvrir dans un client graphique, depuis api :

# windows

Get-Content -LiteralPath ..\sql\TP01_diagnostic.sql -Raw | docker compose exec -T postgres psql -U cours -d shopflow -v ON_ERROR_STOP=1

# linux

cat ..\sql\TP01_diagnostic.sql | docker compose exec -T postgres psql -U cours -d shopflow -v ON_ERROR_STOP=1

## ===============================================

## Préparation / Réinitialisation

Exécuter `..\..\02_Laboratoire\01_schema.sql`, puis `..\..\02_Laboratoire\02_donnees.sql`. Le deuxième script réinitialise les quatre tables de laboratoire.

Dans **chaque nouvelle session**, exécuter :

```sql
SET search_path TO shopflow, public;
```

## pgadmin

http://localhost:5050

Compte de l’interface pgAdmin :

- Adresse e-mail : `etudiant@example.com`
- Mot de passe : `pgadmin-local

Se connecter à shopflow :

| Paramètre               | Valeur        |
| ----------------------- | ------------- |
| Hôte                    | `postgres`    |
| Port                    | `5432`        |
| Base                    | `shopflow`    |
| Utilisateur             | `cours`       |
| Mot de passe PostgreSQL | `cours-local` |
