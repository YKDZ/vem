Set-StrictMode -Version Latest

function Get-VisionRedactedDiagnostic {
  param(
    [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9 -]{1,80}$')][string]$Operation
  )

  # Diagnostics are persisted in machine-readable evidence.  Never transform an
  # exception message here: paths, credential URIs and query-string credentials
  # are all input-controlled and a "best effort" scrubber is not a boundary.
  return ("Vision {0} failed; inspect protected local diagnostics" -f $Operation)
}

function Test-VisionRedactedDiagnostic {
  param([string]$Value)

  return $Value -match '^Vision [A-Za-z0-9 -]{1,80} failed; inspect protected local diagnostics$'
}

Export-ModuleMember -Function Get-VisionRedactedDiagnostic,Test-VisionRedactedDiagnostic
