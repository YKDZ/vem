[CmdletBinding()]
param(
  [string]$DesktopFlagPath = "C:\ProgramData\VEM\kiosk\desktop-mode.flag",
  [int]$PollSeconds = 5
)

$ErrorActionPreference = "Stop"

# This process replaces explorer.exe as the VEMKiosk shell. It renders nothing on
# purpose: with no shell UI there is no desktop, no taskbar and no screen-edge
# shell gesture, so a customer cannot swipe out of the kiosk application. The
# kiosk application itself is started by the installed runtime owner task.
#
# Operator escape hatch: while the desktop flag exists, this holder starts
# explorer.exe in the same interactive session, which restores the desktop for
# maintenance. Removing the flag plus terminating explorer returns to kiosk mode
# (see set-vem-desktop-mode.ps1).

$explorerPath = Join-Path $env:windir "explorer.exe"

while ($true) {
  try {
    if (Test-Path -LiteralPath $DesktopFlagPath) {
      $expired = $false
      $expiryLine = Get-Content -LiteralPath $DesktopFlagPath -ErrorAction SilentlyContinue |
        Where-Object { $_ -like "expires=*" } |
        Select-Object -First 1
      if ($expiryLine) {
        $expiryText = $expiryLine.Substring("expires=".Length).Trim()
        $expiry = [DateTime]::MinValue
        if ([DateTime]::TryParse($expiryText, [ref]$expiry)) {
          $expired = [DateTime]::UtcNow -gt $expiry.ToUniversalTime()
        }
      }
      if ($expired) {
        # A forgotten operator flag must not leave the kiosk open forever.
        Remove-Item -LiteralPath $DesktopFlagPath -Force -ErrorAction SilentlyContinue
        $sessionId = (Get-Process -Id $PID -ErrorAction SilentlyContinue).SessionId
        Get-Process -Name explorer -ErrorAction SilentlyContinue |
          Where-Object { $null -eq $sessionId -or [int]$_.SessionId -eq [int]$sessionId } |
          Stop-Process -Force -ErrorAction SilentlyContinue
      } else {
        $explorer = Get-Process -Name explorer -ErrorAction SilentlyContinue
        if ($null -eq $explorer) {
          Start-Process -FilePath $explorerPath
        }
      }
    }
  } catch {
    # The holder must survive any probe failure; it only keeps the session alive.
  }
  Start-Sleep -Seconds ([Math]::Max(1, $PollSeconds))
}
