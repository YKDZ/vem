# Windows Runtime Direct Deployment

This document now points operators at the stabilization deployment path.
The previous controlled update delivery unit is stopped for active runtime
work.

Active deployment replaces the daemon, Machine Runtime Console, Vision runtime,
and Runtime Bootstrap over certificate-only SSH on a clean prepared Windows
host. The deployment path must use the same runtime artifact set that the VM
runtime acceptance workflow verifies.

For Vision, resolve one successful `hbhjt/vending-vision` main commit with
`get-vision-main-artifacts.ps1`, cache its runtime and recorded-video fixture
archives by that commit SHA, then use `install-vision-main-artifact.ps1` to
replace `C:\VEM\vision\app`, write `C:\ProgramData\VEM\vision\site.json`,
restart `VEM\StartVisionServer` through `C:\VEM\bringup\start_vision.bat`, and
probe the machine protocol. Recorded-video
fixtures are supplied only to an explicit recorded-video site configuration;
they never belong in the production app archive.
Use `verify-vem-runtime.ps1 -RequireVisionOnline` after the restart.

Required operator evidence:

- source commit and artifact SHA-256 values;
- target machine identity and runtime base identity;
- daemon service restart result;
- Machine UI scheduled task restart result;
- Vision process health result when Vision is installed;
- daemon `/healthz` and `/readyz` observations;
- one customer journey acceptance result when field hardware is attached.

Do not add rollback, signing, approval, or compatibility gates to this path
during stabilization. A failed deployment is recovered by preparing a clean
Windows host and deploying the selected runtime artifact set again.
