Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# The watchdog's tailnet-offline escape decision is a pure function; extract it
# from the script under test so the decision table can be exercised without a
# Windows host, a Tailscale installation, or any filesystem state.
$source = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot "watch-vem-runtime-owners.ps1")
$match = [regex]::Match($source, "function Get-TailnetEscapeDecision\([^\n]*\n(?:.*\n)*?\}\n")
if (-not $match.Success) { throw "Get-TailnetEscapeDecision not found in watchdog script" }
. ([scriptblock]::Create($match.Value))

$now = [datetime]::UtcNow
$cases = @(
  [ordered]@{ name = "unknown-or-not-installed"; online = $null; since = $null; grace = 10; expected = "not-applicable" },
  [ordered]@{ name = "online"; online = $true; since = $now.AddHours(-1); grace = 10; expected = "online" },
  [ordered]@{ name = "offline-arms"; online = $false; since = $null; grace = 10; expected = "arm" },
  [ordered]@{ name = "offline-waits"; online = $false; since = $now.AddMinutes(-3); grace = 10; expected = "wait" },
  [ordered]@{ name = "offline-escapes"; online = $false; since = $now.AddMinutes(-11); grace = 10; expected = "escape" }
)

$results = @(
  foreach ($case in $cases) {
    [ordered]@{
      name = $case.name
      actual = Get-TailnetEscapeDecision -Online $case.online -OfflineSince $case.since -GraceMinutes $case.grace -Now $now
      expected = $case.expected
    }
  }
)

$result = [ordered]@{
  schemaVersion = "vem-watchdog-decision-harness/v1"
  cases = $results
  allMatched = @($results | Where-Object { $_.actual -ne $_.expected }).Count -eq 0
}

$result | ConvertTo-Json -Depth 5 -Compress
