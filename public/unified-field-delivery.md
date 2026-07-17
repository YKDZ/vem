# Unified Field Runtime Delivery

The active field path is the Windows runtime stabilization path: build the
daemon, Machine Runtime Console, and Vision artifact set for one source commit,
verify it through VM runtime acceptance, then deploy those exact artifacts to a
clean physical Windows host over certificate-only SSH.

The field package contains:

- daemon executable;
- Machine Runtime Console executable and WebView2 loader;
- Vision runtime archive and site configuration when Vision is in scope;
- Runtime Bootstrap;
- SHA-256 manifest for the selected files;
- a short operator checklist for service, task, health, ready, audio, camera,
  scanner, lower-controller, payment, dispense, and inventory checks.

The VM and physical paths differ only at the device boundary. VM acceptance uses
virtual serial roles, recorded Vision frames, local platform services, and the
Windows default audio device. Physical acceptance uses the real lower
controller, scanner, DirectShow cameras, display speaker, platform connectivity,
payment, dispense, and inventory synchronization.

Do not maintain a second installer, compatibility package, release gate, or
legacy update channel for stabilization.
