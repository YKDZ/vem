# Windows Runtime Stabilization Supersedes The Old Image Path

This file is retained only to prevent operators from following the retired
image and controlled-maintenance instructions that previously lived here. The
active Windows runtime path is defined by ADR 0075 and the Windows Machine
Runtime Stabilization PRD.

Current rules:

- Active CI and acceptance use VM runtime acceptance, not the retired image
  acceptance path.
- Historical source under `scripts/factory` remains isolated for later cleanup.
- Runtime acceptance, baseline construction, and physical SSH deployment must
  not import or execute that historical source.
- Physical stabilization starts from a clean Windows host prepared by the
  shared runtime host preparation path.
- Deployment replaces daemon, Machine Runtime Console, Vision, and Runtime
  Bootstrap directly over certificate-only SSH.
- Customer audio uses the Windows default output device.
- Runtime Bootstrap, Local Runtime Settings, Provisioning Profile Cache, and the
  secret store are the configuration authorities.

Do not reintroduce signing, approval, rollback, release allowlists, legacy image
acceptance, or compatibility importers while the stabilization effort is in
progress.
