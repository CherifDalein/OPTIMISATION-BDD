#!/usr/bin/env bash
# A sourcer depuis optimisationBDD/01_server/api : source ../../02_Laboratoire/Jour5/Init_Jour5.sh
set -u
if [[ ! -f .env || ! -f server.mjs ]]; then
  echo 'Placez-vous dans optimisationBDD/01_server/api avant de sourcer ce fichier.' >&2
  return 1 2>/dev/null || exit 1
fi
J5_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
J5_BENCH="$J5_DIR/jour5_bench.mjs"
J5_PORT="$(sed -n 's/^[[:space:]]*PORT[[:space:]]*=[[:space:]]*//p' .env | head -n 1 | tr -d '\r\"' | tr -d "'")"
J5_PORT="${J5_PORT:-3000}"
J5_TOKEN="$(sed -n 's/^[[:space:]]*LAB_TOKEN[[:space:]]*=[[:space:]]*//p' .env | head -n 1 | tr -d '\r\"' | tr -d "'")"
if [[ -z "$J5_TOKEN" ]]; then
  echo 'LAB_TOKEN manque dans .env.' >&2
  return 1 2>/dev/null || exit 1
fi
J5_BASE="http://127.0.0.1:$J5_PORT"
export J5_DIR J5_BENCH J5_BASE J5_TOKEN
j5obs() { curl -fsS -H "Authorization: Bearer $J5_TOKEN" "$J5_BASE/observations"; echo; }
j5pg() { docker compose exec -T postgres psql -U cours -d shopflow -c "SELECT state, coalesce(wait_event_type,'-') AS wait_type, count(*) AS sessions FROM pg_stat_activity WHERE datname=current_database() GROUP BY 1,2 ORDER BY 1,2;"; }
j5stats() { docker stats --no-stream; }
echo "Jour 5 prêt. API : $J5_BASE"
echo "Benchmark : node \"$J5_BENCH\" run ..."
echo 'Observations : j5obs ; j5pg ; j5stats'
