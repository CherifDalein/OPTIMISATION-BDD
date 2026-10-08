#!/usr/bin/env bash
# À charger avec source depuis optimisationBDD/01_server/api.
# Ce fichier ne lance pas l'API. Il définit les aides aux mesures.
if [[ -z "${BASH_VERSION:-}" ]]; then
    printf '%s\n' 'Ouvrir Bash et utiliser source Init_Jour4.sh.' >&2
    return 1 2>/dev/null || exit 1
fi
if ! command -v node >/dev/null 2>&1; then
    printf '%s\n' 'Node.js 22 ou supérieur est requis.' >&2
    return 1
fi
_j4_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)" || return 1
export J4_HELPER="$_j4_dir/jour4_http.mjs"
J4_CSV="$(node "$J4_HELPER" init)" || return 1
export J4_CSV
J4_BASE="$(node "$J4_HELPER" config base)" || return 1
J4_TTL="$(node "$J4_HELPER" config ttl)" || return 1
export J4_BASE J4_TTL
sf() { node "$J4_HELPER" request "$@"; }
sf_champ() { node "$J4_HELPER" field "$@"; }
sf_ids() { node "$J4_HELPER" ids "$@"; }
sf_encoder() { node "$J4_HELPER" encode "$@"; }
sf_liste() { node "$J4_HELPER" list "$@"; }
sf_resume() { node "$J4_HELPER" summary "$@"; }
sf_code() { node "$J4_HELPER" code "$@"; }
sf_attendre_redis() { node "$J4_HELPER" wait "$@"; }
printf 'API : %s | Client : 42 | TTL : %s s\n' "$J4_BASE" "$J4_TTL"
printf 'Mesures enregistrées dans : %s\n' "$J4_CSV"
