# A charger avec un point depuis optimisationBDD\01_server\api.
# Compatible Windows PowerShell 5.1 et PowerShell 7.
if (-not (Test-Path -LiteralPath '.env') -or -not (Test-Path -LiteralPath 'server.mjs')) {
    throw 'Placez-vous dans optimisationBDD\01_server\api avant de charger ce fichier.'
}
$J5Dir = $PSScriptRoot
$J5Bench = Join-Path $J5Dir 'jour5_bench.mjs'
if (-not (Test-Path -LiteralPath $J5Bench)) { throw 'jour5_bench.mjs introuvable.' }
$envValues = @{}
foreach ($line in Get-Content -LiteralPath '.env') {
    if ($line -match '^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$') {
        $envValues[$matches[1]] = $matches[2].Trim().Trim('"').Trim("'")
    }
}
if (-not $envValues['LAB_TOKEN']) { throw 'LAB_TOKEN manque dans .env.' }
$port = if ($envValues['PORT']) { [int]$envValues['PORT'] } else { 3000 }
$J5Base = 'http://127.0.0.1:' + $port
$J5Headers = @{ Authorization = 'Bearer ' + $envValues['LAB_TOKEN'] }

function Get-J5Observation {
    $r = Invoke-RestMethod -Uri ($J5Base + '/observations') -Headers $J5Headers -TimeoutSec 15
    $r | ConvertTo-Json -Depth 8
}

function Get-J5PgActivity {
    $sql = "SELECT state, coalesce(wait_event_type,'-') AS wait_type, count(*) AS sessions FROM pg_stat_activity WHERE datname=current_database() GROUP BY 1,2 ORDER BY 1,2;"
    docker compose exec -T postgres psql -U cours -d shopflow -c $sql
}

function Get-J5DockerStats {
    docker stats --no-stream
}

Write-Host ('Jour 5 prêt. API : ' + $J5Base)
Write-Host ('Benchmark : node "' + $J5Bench + '" run ...')
Write-Host 'Observations : Get-J5Observation ; Get-J5PgActivity ; Get-J5DockerStats'
