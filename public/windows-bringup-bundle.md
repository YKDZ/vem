# Windows Runtime Bring-Up Bundle

The bring-up bundle is a small runtime artifact set used by VM and physical
stabilization. It is not an installation image and does not define release
governance.

Bundle contents:

- `vending-daemon.exe`;
- `machine.exe`;
- `WebView2Loader.dll`;
- Runtime Bootstrap JSON;
- optional Vision runtime archive and Vision site configuration;
- SHA-256 manifest.

Bring-up sequence:

1. Prepare a clean Windows host with the shared runtime host preparation path.
2. Copy the bundle over certificate-only SSH.
3. Replace daemon and UI files under `C:\VEM\bringup`.
4. Restart only the daemon service for daemon changes.
5. Restart only the Machine UI task and `machine.exe` for UI changes.
6. Start Vision only when the selected site configuration requires it.
7. Verify daemon health, readiness, Machine UI route, default audio, and device
   discovery before running a sale.

Deployment scripts must not write a full legacy machine config document. Runtime
Bootstrap and the Provisioning Profile Cache remain the configuration authority.
