# VEM Windows Bring-up Bundle

The Windows Bring-up Bundle is an executable delivery unit: `vending-daemon.exe`,
`machine.exe`, `WebView2Loader.dll`, the initial machine configuration example,
and the two scripts under `scripts/windows/`. Verify the hashes in `VERSION.txt`
before placing it at `C:\VEM\bringup`.

Install or refresh the service and kiosk task with:

```powershell
powershell -ExecutionPolicy Bypass -File C:\VEM\bringup\scripts\windows\setup-scheduled-tasks.ps1 -StartNow
```

Before smoke testing, copy `machine-config.bringup.example.json` to
`C:\VEM\bringup\machine-config.json`, configure the target machine identity,
API/MQTT endpoints and COM ports, then deliver machine secrets through the
controlled field-secret path. Never put secrets, a maintenance PIN, or a
Factory capability into this bundle, its README, or its logs.

## Protected maintenance session for smoke

The smoke script must acquire a daemon-issued protected maintenance session;
it never accepts an invented session ID.

For the first Factory/Testbed smoke only, the Factory runtime bootstrap may
already have placed its single-use capability at
`C:\ProgramData\VEM\vending-daemon\factory\bootstrap-provisioning-capability`.
That protected file is created by the same Factory/Testbed bootstrap, is not
part of this bundle, and is consumed by the daemon. Do not copy, recreate, or
print it. If the file is present and unconsumed, run the smoke command without
`-MaintenancePin`; the script will use that one-shot capability.

For every later smoke, or whenever the one-shot file is absent, obtain a
maintenance PIN through the approved operator secret channel and make it
available only to the current PowerShell process. The following command is
runnable only after that secure input is present; it deliberately contains no
PIN value:

```powershell
if ([string]::IsNullOrWhiteSpace($env:VEM_MAINTENANCE_PIN)) { throw "obtain a maintenance PIN through the approved operator secret channel first" }
powershell -ExecutionPolicy Bypass -File C:\VEM\bringup\scripts\windows\vending-daemon-smoke.ps1 `
  -DaemonExe C:\VEM\bringup\vending-daemon.exe `
  -MachineUiExe C:\VEM\bringup\machine.exe `
  -DataDir C:\ProgramData\VEM\vending-daemon `
  -MachineConfig C:\VEM\bringup\machine-config.json `
  -ComPort COM3 `
  -ScannerPort COM4 `
  -MaintenancePin $env:VEM_MAINTENANCE_PIN
```

Use the same Factory/Testbed bootstrap origin as the installed runtime. A
generic bundle does not manufacture an alternate test credential or capability.
