const CHECKPOINTS = new Set(["before_f0", "after_f1_before_f2", "after_f2"]);

function psLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function buildDaemonFulfillmentStoreCheckpointScript({
  stage,
  binding,
}) {
  if (!CHECKPOINTS.has(stage))
    throw new Error("daemon evidence checkpoint stage is invalid");
  const bindingJson = JSON.stringify(binding);
  return String.raw`
$ErrorActionPreference = 'Stop'
$readyPath = 'C:\ProgramData\VEM\vending-daemon\daemon-ready.json'
if (-not (Test-Path -LiteralPath $readyPath -PathType Leaf)) { throw 'daemon ready file is missing' }
$ready = Get-Content -LiteralPath $readyPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ([string]::IsNullOrWhiteSpace([string]$ready.ipcToken)) { throw 'daemon IPC token is missing' }
$health = [uri][string]$ready.healthzUrl
$baseUrl = "{0}://{1}:{2}" -f $health.Scheme, $health.Host, $health.Port
$headers = @{ Authorization = "Bearer $($ready.ipcToken)" }
$transaction = Invoke-RestMethod -Method Get -Uri "$baseUrl/v1/transactions/current" -Headers $headers -TimeoutSec 5
$saleView = Invoke-RestMethod -Method Get -Uri "$baseUrl/v1/sale-view" -Headers $headers -TimeoutSec 5
$binding = ${psLiteral(bindingJson)} | ConvertFrom-Json
[Console]::Out.WriteLine(([ordered]@{
  stage = ${psLiteral(stage)}
  capturedAt = [DateTime]::UtcNow.ToString('o')
  binding = $binding
  transaction = $transaction
  saleView = $saleView
} | ConvertTo-Json -Compress -Depth 32))
`.trim();
}

export function createDaemonFulfillmentStoreEvidence(binding, checkpoints) {
  if (!Array.isArray(checkpoints))
    throw new Error("daemon fulfillment checkpoints are required");
  return {
    schemaVersion: "daemon-fulfillment-store-evidence/v1",
    source: "vending_daemon_ipc",
    binding: { ...binding },
    checkpoints: structuredClone(checkpoints),
  };
}
