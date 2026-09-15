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
      $explorer = Get-Process -Name explorer -ErrorAction SilentlyContinue
      if ($null -eq $explorer) {
        Start-Process -FilePath $explorerPath
      }
    }
  } catch {
    # The holder must survive any probe failure; it only keeps the session alive.
  }
  Start-Sleep -Seconds ([Math]::Max(1, $PollSeconds))
}
