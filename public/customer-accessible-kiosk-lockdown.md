# Historical Kiosk Lockdown Runbook

This runbook is retired. It must not be used for deployment, maintenance, or
runtime acceptance.

Use the Windows Machine Runtime Stabilization path in ADR 0075 and the current
Windows Runtime Stabilization PRD: prepare the host through the shared runtime
host preparation path, deploy Runtime Bootstrap and runtime artifacts directly
over certificate-only SSH, then verify dynamic device discovery and the Windows
default audio device.
