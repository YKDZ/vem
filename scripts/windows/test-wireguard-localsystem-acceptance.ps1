[CmdletBinding()]
param(
  [string]$ReadyFilePath = "C:\ProgramData\VEM\vending-daemon\daemon-ready.json",
  [string]$DaemonServiceName = "VemVendingDaemon",
  [string]$TunnelServiceName = 'WireGuardTunnel$VEM-Maintenance',
  [string]$TunnelName = "VEM-Maintenance",
  [string]$ConfigPath = "C:\Program Files\WireGuard\Data\Configurations\VEM-Maintenance.conf.dpapi",
  [string]$ExpectedRelayPublicKey,
  [string]$EvidencePath = "C:\ProgramData\VEM\evidence\wireguard-localsystem-acceptance.json",
  [ValidateRange(10, 180)][int]$TimeoutSeconds = 90
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Get-LocalSystemServiceEvidence([string]$Name) {
  $service = Get-Service -Name $Name -ErrorAction Stop
  $cim = Get-CimInstance Win32_Service -Filter ("Name = '{0}'" -f $Name.Replace("'", "''")) -ErrorAction Stop
  $localSystem = [string]$cim.StartName -match '(?i)^(LocalSystem|NT AUTHORITY\\SYSTEM)$'
  if ($service.Status -ne "Running" -or [string]$cim.StartMode -ne "Auto" -or -not $localSystem) {
    throw "required LocalSystem service is not running and automatic"
  }
  return [ordered]@{ name=$Name; running=$true; automatic=$true; localSystem=$true }
}

function Assert-SecretConfigAcl([string]$Path) {
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if ($item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) -or $item.Length -lt 1) { throw "WireGuard encrypted configuration is not a regular protected file" }
  $acl = Get-Acl -LiteralPath $item.FullName -ErrorAction Stop
  if (-not $acl.AreAccessRulesProtected) { throw "WireGuard encrypted configuration inherits ACLs" }
  $allowed = @("S-1-5-18", "S-1-5-32-544")
  $rules = @($acl.Access | Where-Object { -not $_.IsInherited })
  foreach ($rule in $rules) {
    $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    if ($rule.AccessControlType -ne "Allow" -or $sid -notin $allowed -or (($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne [Security.AccessControl.FileSystemRights]::FullControl)) {
      throw "WireGuard encrypted configuration ACL is not restricted to SYSTEM and Administrators"
    }
  }
  if (@($rules | Where-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -eq "S-1-5-18" }).Count -ne 1 -or @($rules | Where-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -eq "S-1-5-32-544" }).Count -ne 1) { throw "WireGuard encrypted configuration ACL does not contain exactly SYSTEM and Administrators" }
  return "sha256:" + (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-MaintenanceStatus([string]$ReadyPath) {
  $ready = Get-Content -LiteralPath $ReadyPath -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
  if ([string]::IsNullOrWhiteSpace([string]$ready.healthzUrl) -or [string]::IsNullOrWhiteSpace([string]$ready.ipcToken)) { throw "daemon ready file does not expose a usable local IPC endpoint" }
  $uri = ([string]$ready.healthzUrl -replace '/healthz$', '/v1/maintenance/status')
  return Invoke-RestMethod -Uri $uri -Headers @{ Authorization=("Bearer " + [string]$ready.ipcToken) } -TimeoutSec 5 -ErrorAction Stop
}

function Wait-ClaimHandshake([string]$ReadyPath, [string]$ExpectedPublicKey, [datetime]$Deadline) {
  do {
    try {
      $status = Get-MaintenanceStatus $ReadyPath
      if ($status.handshakeVerified -eq $true -and [string]$status.state -eq "handshake_verified" -and [string]$status.publicKey -eq $ExpectedPublicKey -and -not [string]::IsNullOrWhiteSpace([string]$status.lastHandshakeAt)) { return $status }
    } catch {}
    Start-Sleep -Seconds 1
  } while ([DateTime]::UtcNow -lt $Deadline)
  throw "daemon did not restore a claim-bound WireGuard handshake after LocalSystem restart"
}

function Get-WireGuardHandshake([string]$Name, [string]$ExpectedPeer) {
  $wg = Join-Path $env:ProgramFiles "WireGuard\wg.exe"
  if (-not (Test-Path -LiteralPath $wg -PathType Leaf)) { throw "WireGuard handshake executable is unavailable" }
  $lines = @(& $wg show $Name latest-handshakes)
  if ($LASTEXITCODE -ne 0) { throw "WireGuard cannot report latest handshakes" }
  $observed = @($lines | ForEach-Object {
    $parts = ([string]$_).Split([char[]]" `t", [StringSplitOptions]::RemoveEmptyEntries)
    if ($parts.Count -eq 2 -and $parts[1] -match '^[1-9][0-9]*$') { [pscustomobject]@{ publicKey=$parts[0]; unixSeconds=[Int64]$parts[1] } }
  })
  if (-not [string]::IsNullOrWhiteSpace($ExpectedPeer)) { $observed = @($observed | Where-Object { $_.publicKey -ceq $ExpectedPeer }) }
  if ($observed.Count -ne 1) { throw "WireGuard did not report exactly one claim-bound relay handshake" }
  return $observed[0]
}

function Write-Evidence([object]$Value) {
  $parent = Split-Path -Parent $EvidencePath
  New-Item -ItemType Directory -Path $parent -Force | Out-Null
  $temporary = Join-Path $parent ("." + [guid]::NewGuid().ToString("N") + ".tmp")
  try { [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 12 -Compress), [Text.UTF8Encoding]::new($false)); Move-Item -LiteralPath $temporary -Destination $EvidencePath -Force } finally { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
}

$evidence = [ordered]@{
  schemaVersion="vem-wireguard-localsystem-acceptance/v1"; kind="wireguard-localsystem-acceptance"; ok=$false
  daemonService=$null; tunnelService=$null; configAclProtected=$false; configDigestBefore=$null; configDigestAfter=$null
  claimPublicKey=$null; handshakePublicKey=$null; handshakeUnixSeconds=$null; daemonRestartRead=$false; failure=""
}
try {
  $evidence.daemonService = Get-LocalSystemServiceEvidence $DaemonServiceName
  $evidence.tunnelService = Get-LocalSystemServiceEvidence $TunnelServiceName
  $evidence.configDigestBefore = Assert-SecretConfigAcl $ConfigPath
  $evidence.configAclProtected = $true
  $before = Get-MaintenanceStatus $ReadyFilePath
  if ($before.handshakeVerified -ne $true -or [string]$before.state -ne "handshake_verified" -or [string]::IsNullOrWhiteSpace([string]$before.publicKey)) { throw "claim-to-handshake precondition is not verified" }
  $evidence.claimPublicKey = [string]$before.publicKey
  Restart-Service -Name $TunnelServiceName -Force -ErrorAction Stop
  Restart-Service -Name $DaemonServiceName -Force -ErrorAction Stop
  $after = Wait-ClaimHandshake $ReadyFilePath $evidence.claimPublicKey ([DateTime]::UtcNow.AddSeconds($TimeoutSeconds))
  $evidence.daemonRestartRead = $true
  $evidence.configDigestAfter = Assert-SecretConfigAcl $ConfigPath
  if ($evidence.configDigestAfter -cne $evidence.configDigestBefore) { throw "LocalSystem restart changed the protected WireGuard configuration bytes" }
  $handshake = Get-WireGuardHandshake $TunnelName $ExpectedRelayPublicKey
  $evidence.handshakePublicKey = $handshake.publicKey
  $evidence.handshakeUnixSeconds = $handshake.unixSeconds
  $evidence.ok = $true
} catch {
  $evidence.failure = "wireguard_localsystem_acceptance_failed"
  throw
} finally {
  Write-Evidence $evidence
}
