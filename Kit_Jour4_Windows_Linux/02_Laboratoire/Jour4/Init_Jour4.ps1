# À charger avec un point depuis optimisationBDD\01_server\api.
# Compatible Windows PowerShell 5.1 et PowerShell 7.
if (-not (Test-Path -LiteralPath '.env') -or
    -not (Test-Path -LiteralPath 'server.mjs')) {
    throw 'Placez-vous dans optimisationBDD\01_server\api avant de charger ce fichier.'
}
$j4EnvValues = @{}
foreach ($line in Get-Content -LiteralPath '.env') {
    if ($line -match '^\s*([A-Z_]+)\s*=(.*)$') {
        $j4EnvValues[$matches[1]] = $matches[2].Trim().Trim('"').Trim("'")
    }
}
if (-not $j4EnvValues['LAB_TOKEN']) { throw 'LAB_TOKEN manque dans .env.' }
$J4Client = if ($j4EnvValues['LAB_CLIENT_ID']) {
    [int]$j4EnvValues['LAB_CLIENT_ID']
} else { 42 }
if ($J4Client -ne 42) { throw 'Ces fiches utilisent LAB_CLIENT_ID=42. Corrigez .env puis redémarrez l API.' }
$J4Port = if ($j4EnvValues['PORT']) { [int]$j4EnvValues['PORT'] } else { 3000 }
$J4Ttl = if ($j4EnvValues['CACHE_TTL_SECONDS']) {
    [int]$j4EnvValues['CACHE_TTL_SECONDS']
} else { 5 }
$J4Base = 'http://127.0.0.1:' + $J4Port
$J4Headers = @{ Authorization = 'Bearer ' + $j4EnvValues['LAB_TOKEN'] }
$j4ResultDir = Join-Path $PSScriptRoot 'resultats'
New-Item -ItemType Directory -Path $j4ResultDir -Force | Out-Null
$j4RunId = (Get-Date -Format 'yyyyMMdd_HHmmss') + '_' + ([guid]::NewGuid().ToString('N').Substring(0,6))
$J4Csv = Join-Path $j4ResultDir ('mesures_' + $j4RunId + '.csv')

function Invoke-ShopFlow {
    param(
        [Parameter(Mandatory=$true)][string]$Path,
        [Parameter(Mandatory=$true)][string]$Label,
        [ValidateSet('GET','PATCH')][string]$Method = 'GET',
        [string]$Body
    )
    $requestOptions = @{
        Uri = $J4Base + $Path; Headers = $J4Headers; Method = $Method
        UseBasicParsing = $true; ErrorAction = 'Stop'; TimeoutSec = 15
    }
    if ($PSBoundParameters.ContainsKey('Body')) {
        $requestOptions['Body'] = $Body
        $requestOptions['ContentType'] = 'application/json'
    }
    $requestTimer = [Diagnostics.Stopwatch]::StartNew()
    $response = Invoke-WebRequest @requestOptions
    $requestTimer.Stop()
    $parsed = $response.Content | ConvertFrom-Json
    $result = [pscustomobject]@{
        Label = $Label; Status = [int]$response.StatusCode
        SqlCount = [int]([string]$response.Headers['X-SQL-Count'])
        Cache = [string]$response.Headers['X-Cache']
        HttpMs = [math]::Round($requestTimer.Elapsed.TotalMilliseconds,3)
        TraceId = [string]$response.Headers['X-Trace-Id']; Body = $parsed
    }
    $ids = if ($Path.StartsWith('/commandes')) {
        ($parsed.data | ForEach-Object { $_.id }) -join ','
    } else { '' }
    $price = if ($Path.StartsWith('/produits/')) { $parsed.data.prix } else { '' }
    [pscustomobject]@{
        Date = (Get-Date).ToString('o'); Label = $Label; Method = $Method
        Path = $Path; Status = $result.Status; SqlCount = $result.SqlCount
        Cache = $result.Cache; HttpMs = $result.HttpMs; TraceId = $result.TraceId
        Prix = $price; Ids = $ids
    } | Export-Csv -LiteralPath $J4Csv -NoTypeInformation -Append -Encoding UTF8
    return $result
}

function Wait-ShopFlowRedis {
    param([Parameter(Mandatory=$true)][bool]$Ready, [int]$TimeoutSeconds = 20)
    $readyTimer = [Diagnostics.Stopwatch]::StartNew()
    do {
        $state = Invoke-ShopFlow -Path '/observations' -Label 'etat_redis'
        if ([bool]$state.Body.redisPret -eq $Ready) { return }
        Start-Sleep -Milliseconds 500
    } while ($readyTimer.Elapsed.TotalSeconds -lt $TimeoutSeconds)
    throw 'L état Redis attendu n a pas été observé. Consultez le terminal API et Docker.'
}
Write-Host ('API : ' + $J4Base + ' | Client : ' + $J4Client + ' | TTL : ' + $J4Ttl + ' s')
Write-Host ('Mesures enregistrées dans : ' + $J4Csv)
