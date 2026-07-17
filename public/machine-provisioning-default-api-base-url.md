# Machine Provisioning Default API Base URL

Runtime Bootstrap is the only pre-claim source for the initial platform API
base URL. It contains the provisioning entrypoint, hardware model, and topology
identity needed for a clean machine to claim its Platform Machine.

After claim, the daemon uses the accepted Provisioning Profile Cache for
platform API and MQTT endpoints. Local UI and deployment scripts must not
rewrite a full machine configuration document or import old machine config
files.

Acceptance checks:

- clean Windows host starts without a cached machine identity;
- Runtime Bootstrap points at the intended platform API;
- claim writes one accepted profile cache atomically;
- later runtime reads use the profile cache rather than a seeded local config;
- local settings remain limited to stable device bindings, scanner parameters,
  audio preferences, and Vision site reference.
