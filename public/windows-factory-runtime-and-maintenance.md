# Windows Factory Runtime And Controlled Maintenance

Status: accepted target architecture. The existing testbed is the first
implementation target, but host paths, VM names, and disk operations are not
part of the repository contract. A gate may claim conformance only after the
implementation and evidence listed here are present.

## Stable Language

**Clean Base Bootstrap** starts from a declared Windows ISO and produces a clean
Windows installation that the factory runtime preparation stage can take over.
It establishes only the temporary bootstrap access and Windows baseline needed
for that handoff.

**Factory Runtime Preparation** installs and verifies VEM runtime components,
fixed-version OpenSSH and WireGuard, Windows startup policy, controlled
maintenance capability, and the selected production or testbed profile.

**Factory ISO** is the reproducible, bootable output of the repository-owned
media build. It contains no machine-specific private key, machine identity, or
shared production password.

**Factory Personalization Media** is a small, installation-scoped secret input
mounted only after a trusted protected gate alongside the Factory ISO. It
carries per-machine installation secrets or a testbed bootstrap identity and
must never be uploaded as a GitHub artifact or stored in the ordinary factory
asset cache.

**Controlled Maintenance Ingress** is the authorized path from a registered
runner or maintainer peer to one machine's SSH endpoint. WireGuard, the relay,
and OpenSSH implement the path; they are not themselves the authorization
boundary.

**Maintenance Session** is a time-bounded authorization with an exact source
peer, target machine, protocol, port, reason, actor, and expiry.

**Machine Maintenance Identity** is the machine's WireGuard key and assigned
tunnel address. It is distinct from VEM business runtime state even though it is
bound to the machine during Machine Claim.

**Vision Integration Contract** is the language-neutral health, WebSocket,
configuration, lifecycle, and evidence contract shared by VEM and the Vision
repository. It does not prescribe Python, Node, PyInstaller, or an installer
format.

## Ownership Boundary

The repository owns:

- Factory ISO composition, Factory Manifest schemas, Windows bootstrap and
  preparation payloads, verifiers, and evidence schemas.
- Service API maintenance authorization, peer registry, session state, SSH
  certificate issuance, and audit.
- The `maintenance-relay` application, Admin UI maintenance workflows, VEM
  runtime installation, and black-box Windows acceptance.
- Language-neutral Vision integration schemas and conformance fixtures.

The VM or factory platform owns:

- Creating and controlling VMs, mounting media, providing virtual devices,
  taking snapshots, exporting disks, and maintaining destructive path
  allowlists.
- A runner-local VM host adapter implementing the repository JSON contract.

The Vision repository owns:

- Vision source, models, dependency locking, Windows packaging, release
  metadata, SBOM, build provenance, and its self-tests.
- An immutable release bundle whose internal runtime technology may change.

The VEM repository must not contain platform-specific VM scripts, host
filesystem paths, destructive disk allowlists, or deployment adapters. Platform
implementations live on their hosts. The repository may contain only the
request/report schemas and platform-neutral fake adapters used by tests.

## Factory Media Contract

The canonical media workflow takes:

- a source Windows ISO identity and SHA-256;
- a Factory Manifest;
- fixed-version OpenSSH and WireGuard packages with source, version, SHA-256,
  approved signer/root certificate thumbprints, and a valid Authenticode chain;
- CI-built VEM daemon, Machine UI, WebView2 sidecar, and selected Vision release
  artifacts;
- a production or testbed profile without machine-specific secrets.

`windows-serviced-iso` is the only deployable Factory ISO mode: the pinned 7-Zip
extractor reads the source UDF filesystem view, and the pinned `genisoimage`
writer rebuilds ISO9660, Joliet, and UDF media while replaying the verified BIOS
and UEFI El Torito semantics and injecting `Autounattend.xml` and `sources/$OEM$`.
The source must contain
`setup.exe`, `sources/boot.wim`, `sources/install.wim` or `install.esd`, BIOS
`boot/etfsboot.com`, EFI `efisys.bin`, and a complete BIOS+UEFI El Torito
catalog; fixture, non-Windows, and BIOS-only media are rejected. The unattended
file pins the image index, locale/OOBE behavior, and an explicit disk layout
selected by `source.targetFirmware`. A `uefi` target creates EFI, MSR, Windows,
and GPT recovery partitions; a `bios` target creates an active NTFS system
partition, Windows partition, and MBR recovery partition. The ISO remains
BIOS+UEFI bootable in either case, but acceptance must boot it using the
firmware mode declared by the manifest. The deterministic Factory ISO owns a
non-secret `oobeSystem` pass that fixes locale and suppresses interactive OOBE
pages and declares a restricted temporary `VEMOobeBootstrap` local account so
Win10 Pro can complete its supported account-creation phase. Its fixed bootstrap
password is a v1 prototype concession: the account has no maintenance ingress
and the first kiosk logon deletes it. Preclaim verification rejects any image in
which it remains. The ISO contains no machine-specific OOBE state. During
`specialize`, the installer consumes the restricted one-time
personalization media and configures the profile accounts, runtime, and kiosk
Winlogon state directly. No password-bearing answer file or Setup registry
override is generated.
The specialize bootstrap discovers that medium through the .NET drive API,
without loading the Storage module, and accepts exactly one ready CD-ROM with
the fixed `VEM_PERSONALIZATION` label. It also writes a credential-free staged
status record under `C:\\ProgramData\\VEM\\factory` so failed clean installs can
identify the bootstrap operation that stopped before OOBE.
Factory Manifest v1 accepts only the `Professional` install image and writes
Microsoft's published Windows 10 Pro Generic Volume License Key into unattended
setup for edition selection. This setup key is not an activation credential;
deployment licensing and activation remain outside Factory media assembly.
Adding `source.targetFirmware` and restricting `source.installImageEdition` to
`Professional` are hard v1 contract migrations: manifest producers, Factory
builders, acceptance inputs, and VM host adapters must move in lockstep, and no
compatibility reader for the earlier shape is retained.
The `specialize` SYSTEM process is the sole runtime-preparation owner. It
creates the profile accounts in a disabled state, records durable status, and
runs the baseline installer, `prepare-factory-runtime`, and
`verify-factory-runtime` before OOBE can expose any interactive desktop. The
configured Winlogon state then performs one automatic login directly to the
restricted kiosk account. A one-shot SYSTEM task triggered by that login removes
the OOBE login counter, temporary bootstrap account, and personalization medium
before deleting itself. Medium removal has bounded
retries and a verified-absent postcondition; a failed removal retains the logon
trigger for retry without introducing a pre-OOBE startup trigger. A preparation
failure stops Windows Setup before OOBE rather than exposing a partially
prepared administrator desktop.
Every failure path removes the staged plaintext personalization. Personalization
passwords are restricted to printable ASCII so command and account setup cannot
normalize them into a different Windows password.
On Windows editions without Shell Launcher, including Windows 10 Pro, the
interactive logon task is the sole Machine UI process owner; the per-user
Winlogon shell is configured only when Shell Launcher is available.
`prepare-factory-runtime` is the sole owner of the selected Vision
provision/install/evidence lifecycle. The common ISO carries no credential,
machine identity, private key, or personalization media.

The Factory media pipeline emits:

- `vem-factory-<manifest-id>.iso`;
- the ISO SHA-256;
- a provenance report containing every input identity and toolchain identity;
- a sanitized evidence index that records whether Windows Setup was customized.

The tracked builder definition is [`scripts/factory/Dockerfile`](../scripts/factory/Dockerfile).
The media builder runs in a pinned, platform-neutral Linux container. It executes
the manifest-pinned extractor, writer, and `wimlib-imagex`, and produces
byte-identical output from two independent build directories and processes.
ISO bytes are processed through bounded file ranges and streaming SHA-256; build
results and APIs expose only logical identity, digest, byte size, and path. Tests
inspect ISO9660/Joliet/UDF filesystem views, UDF descriptor checksums/CRCs, and
El Torito boot metadata. Source Windows media is not committed, cached by GitHub,
or uploaded to GitHub.

### Factory Manifest v1

The maintained schema is [`factory-manifest-v1.schema.json`](./factory-manifest-v1.schema.json).
The executable validator is stricter than structural JSON Schema validation and
requires `schemaVersion: vem-factory-manifest/v1`, `kind: factory-manifest`, a
self-derived `manifestId`, and exactly one immutable `factory-cas://sha256/...`
reference for the Windows source plus these runtime roles: `openssh-installer`,
`wireguard-installer`, `vem-daemon`, `vem-machine-ui`, `webview2-loader`, and
`vision-release`. Every reference carries a fixed version, matching SHA-256
digest, strict semantic version, content-addressed signature evidence, and
signed provenance evidence. Detached Ed25519 evidence is verified against an
approved SPKI identity. Authenticode evidence is verified from the embedded PE
signature by a pinned `osslsigncode`, an approved leaf-certificate SHA-256, and
a runner-owned CA bundle. Signed provenance must bind the asset digest,
predicate, source, builder, and build identity to approved signer and builder
identities. Manifest strings alone are never verification evidence. Roles are
unique and exact; missing or duplicate roles, schema-unknown fields, mutable
references, invalid semantic versions, profile contamination, file URIs,
encoded/absolute paths, secrets, and private keys fail validation.

The `vision-release` asset additionally carries a `release` selection with
content-addressed descriptor, artifact attestation, VEM approval, and
black-box conformance evidence identities. All four records must bind the
same immutable bundle digest before Factory Manifest selection or Windows
installation. VEM installs the original bundle into a version-addressed
directory, keeps configuration and current selection outside the vendor
runtime, launches it through `VEM\StartVisionServer`, and rolls back the
selection when HTTP health or WebSocket conformance fails. The release contract
does not name a programming language, packager, runtime, or service model.

### Factory Personalization Media v1

The maintained envelope is
[`factory-personalization-media-v1.schema.json`](./factory-personalization-media-v1.schema.json).
It is deliberately not a Factory Manifest asset and has no CAS identity,
digest, provenance, cache entry, build input, or ISO representation. The exact
envelope is `vem-factory-personalization-media/v1`, with an opaque media ID,
one profile, `encryptedAtRest: true`, `access: trusted-protected-gate`,
`cache: forbidden`, and `retention: installation-lifecycle-only`.

Production media contains exactly one unique `Admin` credential and one unique
`VEMKiosk` credential. Testbed media contains exactly one dedicated `YKDZ`
bootstrap credential and one `VEMKiosk` credential. The production envelope
rejects `YKDZ`, testbed CA/peer markers, simulators, and shared passwords. No
profile permits WireGuard private keys, peer state, certificates, tokens, or
additional raw secret fields. Each envelope also contains one
`maintenancePinVerifier`: a versioned PBKDF2-HMAC-SHA256 salted verifier, never
the maintenance PIN. Factory validates it, stages it under a SYSTEM and
Administrators-only one-shot daemon directory, and the daemon imports it into
its protected SecretStore before Bring-Up. Import removes staging only after a
valid protected write; a conflict or malformed verifier blocks production
provisioning. Claim and reclaim preserve that protected verifier. The Windows
host generates its WireGuard private key with `wg genkey`; only its public
identity may later participate in Machine Claim.

The runner reads `VEM_FACTORY_PERSONALIZATION_MEDIA_PATH` only after the
trusted remote identity and retained-state gates pass. It requires a runner
service-owned `0600` regular file, copies it into a restricted Windows staging
directory, and verifies removal on success, failure, and cancellation cleanup.
The dry-run plan emits schema-defined preview evidence with only
`not-configured` credentials and `mediaConsumed: false`; a prepared Windows
manifest emits consumed evidence with only `configured` credentials and
`mediaConsumed: true`. Both forms omit the media path, media ID, secret digest,
credential value, and private key. The Factory acceptance workflow always runs
an independent cleanup that removes and verifies deterministic remote and local
staging roots without passing the media path to the cleanup process. The Factory
ISO workflow rejects a personalization-media environment mount.
Windows retains only a protected local single-use marker so the same opaque
media cannot be applied again; the marker is not copied into factory evidence.

The runner-local asset store is addressed only by digest under
`sha256/<digest>`. A cache miss verifies the source bytes, publishes through an
exclusive owner lock and atomic rename, fsyncs the file and containing
directory, then verifies the published bytes. Locks carry PID, host, token,
start time, and heartbeat metadata; stale and dead owners are recoverable while
live owners are not removed. Sources and cache entries must be no-follow regular
files. Population and consumption use already-open verified handles so a path
swap cannot substitute bytes. A hit is rehash-verified before use, and a
provided downloaded source is hashed even when the CAS is already a hit. Cache
evidence reports only logical identity, digest, hit/miss, and byte count.
The Windows source ISO is the exception: it is verified from a separately
configured restricted source store and is never copied into the ordinary CAS.

`build-factory-iso.yml` accepts only a manifest identity. An unprivileged gate
rejects untrusted events, refs, actors, and workflow identities before the
protected `vem-factory-production` environment can schedule the labeled
`[self-hosted, Linux, X64, vem-factory]` runner. Restricted store, approval
policy, CA bundle, and tool paths are runner-service environment only; they are
not workflow inputs or repository variables. The trusted job then checks out
the trusted ref, verifies the reusable runtime descriptor's identity, commit,
artifact name, workflow run/attempt, exact file allowlist, sizes, hashes, and
toolchain, and runs the manifest-pinned builder offline. GitHub receives only
two bounded, structurally validated JSON files. Their recursive sanitizer
rejects path/URI/encoded/secret-like content and derives the upload policy
flags. The ISO remains in the runner-local CAS; source media, ISO bytes,
personalization, private keys, and restricted paths are never uploaded or put
in GitHub cache.

The build job explicitly clears `VEM_FACTORY_PERSONALIZATION_MEDIA_PATH` at the
job boundary. A protected runner may therefore keep its acceptance-only
personalization path in the runner service environment without leaking that
input into a generic Factory ISO build or requiring an operator to restart and
retune the runner between build and acceptance workflows.

OpenSSH and WireGuard are mandatory Factory Runtime capabilities. Windows
Capability installation and floating online downloads are not accepted. The
Factory Manifest pins the installer version and hash, and the Windows verifier
checks the installed binary and service versions. There is no fallback to
password SSH if the fixed OpenSSH package or SSH certificate path fails.

The repository supports two environment profiles through the same preparation
contract:

- `production`: installs the production runtime without `YKDZ`, testbed host
  identity, testbed WireGuard identity, simulators, or shared credentials.
- `testbed`: installs the VEM-owned simulators and accepts a dedicated testbed
  bootstrap identity from Factory Personalization Media.

`YKDZ` and its current testbed credential are testbed-only. Preparation requires
the profile administrator to exist already: `YKDZ` for testbed and `Admin` for
production. The profile-bound personalization media sets that existing local
account's unique installation credential and the kiosk credential. It never
creates a maintenance account or accepts a direct/shared maintenance password
input. Normal remote access uses SSH certificates; any local break-glass
credential remains outside Factory Runtime inputs.

## Reproducible Workflows

Three workflows compose the Windows gates:

1. `build-factory-iso.yml` builds a reproducible `windows-serviced-iso` and
   writes it to a runner-local content-addressed asset store. Its effective
   repository scripts, templates, trusted roots, verifier, release documents,
   and pinned builder are digest-recorded in provenance and embedded in the
   output identity.
2. `factory-image-acceptance.yml` directly invokes the typed Factory Image
   Acceptance orchestrator. It performs pre-claim verification from that ISO,
   captures an approved runtime base identity, creates a disposable overlay,
   binds protected ephemeral-platform inputs to the adapter-discovered guest
   endpoint, executes Machine Claim through daemon IPC, then verifies runtime
   acceptance and display capture. Its lifecycle finalizer and the independent
   cleanup-only invocation both require adapter proof that the overlay and
   personalization media were removed.
3. `vm-runtime-acceptance.yml` restores an approved runtime base, deploys the
   current commit's shared Windows artifacts, and runs the real API, MQTT, and
   simulated-device sale flow.

The workflows reuse the existing Windows artifact build workflow. They do not
duplicate Rust/Tauri build logic or consume a separately maintained executable.

Large or licensed inputs live in a runner-local content-addressed asset store
configured by `VEM_FACTORY_ASSET_STORE`. Manifests identify assets by SHA-256;
workflow inputs do not expose host paths. Factory Personalization Media uses a
separate restricted secret store.

The Factory ISO workflow has a reproducibility mode that builds twice and
requires identical ISO hashes. GitHub receives only sanitized provenance,
logs, and acceptance reports. A testbed ISO or personalization artifact that
contains private material must never be uploaded.

### Factory Tool Contract

`windows-serviced-iso` requires four manifest-pinned executable regular files:
the 7-Zip UDF-view extractor, the ISO/UDF writer, `wimlib-imagex`, and the
Factory builder image identity. The runner supplies two explicit path domains:
`VEM_FACTORY_*_CONTAINER_PATH` names the executable inside the pinned builder
image, while `VEM_FACTORY_*_HOST_PATH` names the executable used by Factory
admission on the Linux runner host. Both domains must resolve to the same
manifest-pinned executable bytes and reported versions; a container path must
never be passed to host admission merely because both are absolute paths. Any
runtime libraries and package support files required by a host executable must
be installed through the runner host's standard loader and filesystem contract
from the same pinned builder image or an equivalent verified package source;
workflow-wide dynamic-library path injection is not allowed.

Factory admission snapshots and extracts the multi-gigabyte ISO before VM
creation. Its `TMPDIR` must therefore be a run-scoped directory below the
protected, writable `VEM_FACTORY_WORK_ROOT`, backed by normal host storage with
the declared capacity. It must not use a RAM-backed system `/tmp`, a fixed-size
container filesystem, or the repository workspace. The workflow removes this
directory in its always-run cleanup after adapter finalization.

The builder and admission code open each executable with no-follow semantics,
hash the opened bytes, check the manifest digest and reported version, and
record or verify the exact tool identities. Factory admission repeats the
pinned extractor/WIM inspection against the runner-local ISO. Missing,
symlinked, non-regular, digest-mismatched, or wrong-version tools fail before
media inspection or build output admission. The host paths are protected
runner-service configuration, so any Linux host can materialize them from the
pinned builder image or an equivalent package source;
repository workflows contain no hypervisor- or storage-platform-specific
installation path. The extractor must first report a single authoritative
`Type = Udf` view; extraction then uses that UDF view and performs a no-follow
`lstat` tree inventory before any WIM inspection, hashing, overlay copy, or
timestamp adjustment; symlinks, special files, and Windows case-colliding
normalized paths are rejected.

## VM Host Adapter Contract

Repository workflows invoke the executable configured by the runner service as
`VEM_VM_HOST_ADAPTER`. A dispatch input cannot choose the executable or pass
host filesystem paths.

The adapter accepts a strict `vem-vm-host-adapter-request/v2` JSON request with
`contractVersion: vem-vm-host-adapter-contract/v2`; its report and adapter
declaration must repeat that exact contract version. This is a hard migration:
v1 requests and reports are rejected rather than translated.
only `runId`, `operation`, `operationNonce`, `operationReference`,
`lifecycleReference`, an optional cancel-operation reference, logical target
identity, content-addressed assets, and requested capabilities. Requests have
no host filesystem path, host URI, executable, VM name, disk path, guest
credential, or platform-specific option. `clean-install` requires both
`factory-iso` and `factory-personalization-media`; restore and overlay
operations require an `approved-runtime-base`. The operation and capability
vocabulary covers:

- `clean-install` from Factory ISO and Factory Personalization Media;
- `restore-approved-base` from an approved base identity;
- display screenshot capture;
- two role-addressed virtual serial devices;
- a virtual default audio output with host-side capture.

The adapter returns a strict `vem-vm-host-adapter-report/v2` report with its
identity and semantic version, echoed request binding, an `operationReference`,
a `lifecycleReference`, observed VM/base/overlay identities, consumed asset
hashes, guest maintenance endpoint identity, role-addressed device mappings,
default-audio identity, content-addressed display/audio evidence, ordered
canonical UTC timestamps, sanitized diagnostics, and an unambiguous cleanup
result. `observed.targetBinding` uses `relation: host-target-mapping/v1` and
repeats the exact requested logical target identity. It is the adapter's
explicit attestation that the observed VM is the configured host mapping for
that target; a different target identity or relation is rejected.

Capabilities are negotiated facts, not a statement that every capability was
used. A successful report must negotiate the complete requested capability set
and provide every requested role-addressed serial mapping before it is
accepted. `negotiatedCapabilities` is separate from `completedOperations` and
evidence. Restore or overlay preparation leaves the disposable overlay active;
runtime acceptance runs next; display and audio are separate capture operations
after acceptance; and `cleanup` is a separate, always-run operation that must
report `completed/removed`. Non-cleanup operations must report
`not-run/active`, preventing a restore report from claiming an overlay was
already removed.

Assets, consumed assets, serial mapping roles, evidence roles, request and
report objects all reject unknown keys and duplicates. Evidence is canonical
`factory-evidence://sha256/<digest>` and must bind exactly to its lowercase
digest. On failed, timed-out, or cancelled execution, the client writes a
validated, sanitized `vem-vm-host-adapter-diagnostic/v2` artifact for upload.
On `SIGINT` or `SIGTERM`, it aborts the active request, waits for the adapter
process group after `SIGTERM` and `SIGKILL` escalation, and completes recovery
cleanup before exiting; workflow `always()` cleanup remains the lifecycle
backstop. Those diagnostics describe adapter execution only; they are never
labeled as Windows SSH readiness.

The runner service alone supplies `VEM_VM_HOST_ADAPTER`; no workflow dispatch
input selects an executable. Repository workflows invoke
`scripts/testbed/run-vm-host-adapter.mjs`, which writes only the sanitized
report for upload. `scripts/testbed/fake-vm-host-adapter.mjs` is the
platform-neutral deterministic contract fixture for success, failure, timeout,
cancellation, and evidence-mismatch tests. No platform adapter implementation
is part of this workflow contract.

## Maintenance Control Plane

The Service API is the source of truth for:

- relay identities and address pools;
- machine, runner, and maintainer peer public keys;
- Machine Maintenance Identity binding;
- Maintenance Sessions and TTL policy;
- SSH certificate issuance;
- desired relay state, observed relay state, and audit records.

The Admin UI provides:

- relay and peer health;
- machine last-handshake state;
- creation of a session with source, machine, reason, and TTL;
- active-session listing and early revocation;
- peer revocation and session audit.

`maintenanceAccess.read` is required to view this surface.
`maintenanceAccess.write` is required to create or revoke a session. Machine,
machine-ops, and ordinary audit permissions do not imply host access. The first
version does not implement MFA or two-person approval.

Human sessions default to 30 minutes and may be 60, 120, or at most 180 minutes.
The Windows CI runner session is fixed at 150 minutes for a job capped at 120
minutes. The first version does not renew sessions. Cleanup revokes explicitly,
and TTL remains the crash-safe fallback.

## Relay Application

`apps/maintenance-relay` is an independently built and deployed application.
Shared Zod contracts live in `packages/shared`; the relay and Service API do not
import source from each other's app directories.

The relay:

- authenticates with its own long-lived relay credential and exchanges it for
  a short-lived `maintenance_relay` token;
- pulls versioned desired state from the Service API and reports observed
  state;
- keeps enforcing local session expiry when the Service API is unavailable;
- applies peers with `wg syncconf` and ACLs in a dedicated nftables table;
- represents active flows as source/target/protocol/port tuple-set elements
  with nftables timeouts;
- fails closed and never executes shell text supplied by an API response.

The Service API connection requires HTTPS by default. An explicit
`MAINTENANCE_RELAY_ALLOW_INSECURE_HTTP=true` exception is allowed only for
loopback, RFC1918, or single-label private container-network destinations. The
relay exposes this degraded transport state in health and Admin UI.

The relay container uses its own network namespace, publishes only UDP 51820,
drops all capabilities except `NET_ADMIN`, uses a read-only filesystem and
restricted tmpfs, and mounts its private key as a read-only secret. Its
management health endpoint is internal only. The relay data plane is kernel
WireGuard plus nftables; the Node process does not proxy SSH traffic.

The first default address pools are:

```text
relay:      10.91.0.0/24
runner:     10.91.1.0/24
maintainer: 10.91.3.0/24
machine:    10.91.16.0/20
```

These are deployment defaults, not protocol constants. The Service API checks
that configured pools are valid and non-overlapping and allocates exact `/32`
peer addresses. A relay should be sharded before exhausting its machine pool or
operational capacity.

## Peer And Session Security

WireGuard interfaces stay active, while access stays closed unless an active
Maintenance Session exists. Machines and registered maintainer workstations
keep long-lived peer identities, but peers have no standing machine access.

Each machine and workstation generates its own private key. Private keys never
leave their owning host and never enter the repository or a shared Factory ISO.
Machine Claim submits the machine public key and atomically binds the peer to
the claimed machine. The response supplies the relay public key, endpoint,
assigned address, and stable role routes.

Machine peers route the configured runner and maintainer role pools. Exact
source/target/port/TTL authorization is enforced at the relay. Windows accepts
SSH only on the WireGuard interface from the configured maintenance role pools.
SSH remains a second authentication layer if the relay host is compromised.

The Windows CI workflow uses GitHub Actions OIDC with audience
`vem-maintenance`. The Service API validates issuer, audience, immutable
repository identity, workflow identity, ref, event, SHA, run ID, and configured
trust policy before issuing a run-bound automation token. OIDC trust policy is
deployment configuration, not an Admin UI setting. It allowlists both the
registered runner peer UUIDs and target Platform Machine codes; an active peer
outside that list is not an automation identity. Password SSH helpers and the
testbed Windows password secret are not part of the accepted workflow.

VM Runtime Acceptance exchanges OIDC only with an independently deployed
Maintenance control-plane. The ephemeral business Service API used by a test
run is not an OIDC trust root. The `vem-maintenance-testbed` GitHub environment
must require its deployment reviewer and allow only the protected `main`
branch. It supplies these non-secret protected environment variables:

- `VEM_MAINTENANCE_CONTROL_PLANE_URL`: credential-free HTTPS base URL for the
  deployed Maintenance control-plane API;
- `VEM_MAINTENANCE_ALLOW_INSECURE_HTTP`: omit for production; the exact value
  `true` permits a credential-free HTTP URL only in the protected testbed while
  the first relay prototype has no domain or certificate;
- `VEM_MAINTENANCE_RUNNER_PEER_ID`: the registered runner peer UUID;
- `VEM_MAINTENANCE_TARGET_MACHINE_ID`: the permitted testbed Platform Machine
  UUID.

The control-plane deployment supplies trust material as read-only mounted files:
`MAINTENANCE_GITHUB_OIDC_TRUST_POLICY_PATH` and
`MAINTENANCE_AUTOMATION_JWT_SECRET_PATH`. An optional static GitHub key set may
be mounted at `MAINTENANCE_GITHUB_OIDC_JWKS_PATH`; otherwise the control plane
fetches only `https://token.actions.githubusercontent.com/.well-known/jwks`,
without redirects. Inline policy, inline signing secrets, and configurable JWKS
URLs are rejected.

The trust policy requires a non-empty `workflowIdentities` array. Each entry is
either the direct or reusable claim model, and an assertion must match every
field of one entry exactly. `workflowIdentity` is not accepted. A shared
control-plane policy can authorize both CI workflows, for example:

```json
{
  "repositoryId": "123456789",
  "workflowIdentities": [
    {
      "claimModel": "direct",
      "workflowRef": "example/vem/.github/workflows/vm-runtime-acceptance.yml@refs/heads/main",
      "allowedEnvironments": ["vem-maintenance-testbed"]
    },
    {
      "claimModel": "direct",
      "workflowRef": "example/vem/.github/workflows/factory-image-acceptance.yml@refs/heads/main",
      "allowedEnvironments": ["vem-factory-production"]
    }
  ],
  "refs": ["refs/heads/main"],
  "events": ["workflow_dispatch"],
  "requireRefProtected": true,
  "allowedRunnerPeerIds": ["11111111-1111-4111-8111-111111111111"],
  "targetMachineCodes": [
    "VEM-TESTBED-RUNTIME-ACCEPTANCE",
    "VEM-TESTBED-FACTORY-ACCEPTANCE"
  ]
}
```

Replace the repository, peer, and machine values with deployment-owned exact
identities. If Factory dispatches from a protected release tag, add that exact
tag ref to `refs`; wildcard refs are not supported.

The automation exchange endpoint has a process-local ceiling of 30 exchange
requests per minute per observed source. Every deployment must also configure
its reverse proxy or API gateway with an equal or stricter per-client limit for
`POST /api/maintenance-automation/exchange`, a bounded request body, HTTPS, and
no response-body logging. Process-local rejection audits are deduplicated by
source/reason/window so rejected-token traffic cannot create unbounded audit
writes. The issued automation token lasts 125 minutes, the job is capped at 120
minutes, and the CI Maintenance Session remains fixed at 150 minutes as the
cleanup-failure fallback.

The Service API signs short-lived OpenSSH user certificates from an
environment-specific Maintenance SSH CA mounted as a Docker secret. Test and
production CAs are different. `MAINTENANCE_SSH_TARGET_POLICY_PATH` points to a
read-only deployment file containing the same profile and its exact target
Machine code allowlist; a profile mismatch or out-of-scope target fails closed.
The Factory profile contains only the selected profile's CA public key. Human
certificates may be issued only by the administrator who created the
Maintenance Session. Certificates are bounded by the session TTL and
maintenance source IP. SSH password and keyboard-interactive authentication
are disabled.

The first version reuses the profile's existing maintenance administrator
account: `YKDZ` for the testbed and `Admin` for the first production profile.
It does not add a default SYSTEM SSH entrypoint. The authenticated maintenance
administrator must have complete host debugging capability; SYSTEM-only work is
performed explicitly from that session when required.

## Windows OpenSSH Certificate Consumption Contract

Issue 09 consumes, but does not redefine, this contract. A testbed profile
installs only the deployed test Maintenance SSH CA public key and accepts the
`YKDZ` principal. A production profile installs only the production CA public
key and accepts the `Admin` principal. `sshd` must require public-key
authentication, disable password and keyboard-interactive authentication, and
trust the CA through `TrustedUserCAKeys`. The CA file contains exactly one
Ed25519 key whose `vem-maintenance-ca:<profile>` comment matches the selected
profile; preparation derives its SHA-256 fingerprint with `ssh-keygen`.
Windows preparation accepts only declared fixed local OpenSSH and WireGuard
packages with version, SHA-256, approved signer/root thumbprints, and a valid
Authenticode chain. Production `sshd` listens only on the declared WireGuard
tunnel address, and its firewall source set is exactly the configured runner
and maintainer role pools. The testbed additionally uses the explicit
`testbed-runner-direct-plus-wireguard` bootstrap/recovery mode: `sshd` listens
on non-WireGuard guest interfaces so a platform-neutral VM adapter can reach
its discovered DHCP endpoint, but the direct TCP/22 firewall rule permits only
the existing exact `MaintenanceRunnerSourceAllowlist`. A separate WireGuard
rule retains the combined runner and maintainer role pools. The explicit direct
endpoint may be reused only for the same clean-install Factory lifecycle's
preclaim, claim, runtime, capture, and serial acceptance SSH work; it is not a
production or ordinary restore transport. Machine Claim still converges and
independently verifies WireGuard after enrollment, without pretending that the
already selected SSH endpoint changed transport. Testbed direct mode fails
without a non-empty runner allowlist; it does not encode a host bridge,
platform, or address assumption. Every other enabled inbound TCP/22 rule is
removed. No profile authorizes a `SYSTEM` principal or creates a default SYSTEM SSH
entrypoint. SYSTEM-only work requires explicit elevation from the authenticated
administrator session, which acceptance measures with an ephemeral SYSTEM task.

## Machine Maintenance Identity Lifecycle

The Vending Daemon owns enrollment and rotation control actions. It generates
the local key, submits the public key during Machine Claim, applies the returned
config, and verifies the first handshake. The independent WireGuard Windows
tunnel service then owns the persistent data plane and starts automatically.

Lifecycle operations are distinct:

- `Local Runtime Reset` clears local VEM business runtime state and preserves
  the active Machine Maintenance Identity, its DPAPI-protected key, and the
  stable `VEM-Maintenance` tunnel configuration.
- Ordinary machine credential rotation replaces only the business credentials;
  it does not rotate or revoke the WireGuard peer.
- `Machine Reclaim` creates a `pending_reclaim` peer and rotates the business
  credentials and WireGuard key. The daemon keeps separate protected active and
  pending keys and runs separate active and pending tunnel services. Ambiguous
  retries for the same reclaim code reuse the pending key. The old active peer
  remains in relay desired state until the relay reports a verified first
  handshake for the new peer and the daemon observes platform promotion.
  A failed or timed-out handshake becomes an auditable recovery state and does
  not revoke the last working peer. A verified reclaim atomically closes
  sessions targeting the old peer and projects only the new peer.
- `Secure Decommission` atomically revokes active sessions, business
  credentials, claim codes, and every machine peer from the platform
  perspective. An online machine receives a durable signed command that removes
  its local tunnel, logs the destructive message id, and persists a retryable
  signed result. Before a persisted platform acknowledgement, a restarted
  daemon fails closed and never starts normal runtime components with retained
  credentials: a partially failed local cleanup is therefore not a recoverable
  online state. The result is not subject to normal outbox expiry or capacity
  eviction. Once acknowledgement is durable, final secret/profile cleanup runs
  before both decommission markers are removed in one SQLite transaction.
  Duplicate command, result, and acknowledgement delivery is idempotent. An
  offline machine has no valid business credentials and is denied when it
  reconnects.

Ordinary machine credential rotation does not rotate the WireGuard key. A full
reinstall generates a new key and requires the previous peer to be revoked by
reclaim or decommission.

## Windows Device Acceptance

The approved runtime base is captured before Machine Claim. Factory Image
Acceptance then creates a disposable overlay, claims the machine against an
ephemeral platform, and proves the same installed image can reach the vending
screen without modifying the approved base.

The Windows acceptance requires:

- two hypervisor-backed virtual COM devices, one for the lower controller and
  one for the scanner;
- the production serial adapter and real Windows COM paths, never the daemon
  mock adapter or `tcp://` transport;
- repository-owned host-side lower-controller and scanner simulators;
- a testbed Vision implementation running through the real Windows launcher,
  task, localhost health, and WebSocket contract;
- a virtual Windows default audio endpoint and host-side PCM/WAV capture;
- real Tauri native audio playback with non-silent captured frames;
- an active kiosk console session, `machine.exe` as the foreground window,
  an exact `http://tauri.localhost/#/` WebView route, a same-session CDP
  `#app` visibility/non-empty-DOM probe, and a valid 1080x1920 platform
  framebuffer PNG screenshot;
- daemon `sell_ready`, real Admin API and MQTT interaction, simulated payment,
  and a successful dispense flow driven by scanner and lower-controller frames
  from one serial session. The serial capture binds each sale to its concrete
  order, payment, and vending-command identifiers. It records frame digests,
  lengths, and sequence numbers from the guest serial session, never a host
  semantic sidecar. Malformed-frame, device-disconnect, scanner-timeout, and
  dispense-failure paths are acceptance cases and must fail without inventing
  successful sale evidence. Scanner plaintext is an injection-only protected
  input and must not appear in reports, evidence uploads, adapter work roots,
  or sidecars.

Application-level audio device selection is not added. VEM uses the Windows
default output; physical 3.5 mm speaker wiring, direction, audibility, and
Customer Audio Zone remain field acceptance.

## Vision Release Boundary

Vision publishes an immutable Windows release bundle and language-neutral
descriptor. The descriptor, artifact attestation, SBOM, provenance, black-box
conformance evidence, VEM approval, and Factory Manifest selection must bind
the same SHA-256 digest. A failed candidate is abandoned under its own version;
assets are never overwritten.

VEM consumes the original release asset from the factory CAS without rebuilding
or repackaging it. It installs private vendor bytes unchanged into a
version-addressed directory, keeps configuration and selection in
`C:\ProgramData\VEM\vision`, generates the launcher, uses the
`VEM\StartVisionServer` interactive task, probes loopback HTTP health and the
declared WebSocket, and restores the preceding approved selection after a
failed startup or conformance check. The contract names no language, packager,
runtime, or service model.

The current `vending-vision.zip` remains a candidate until it supplies the
descriptor, version, supported external configuration, artifact attestation,
SBOM, provenance, clean-Windows conformance evidence, and VEM approval.

## Required Hard Migration

Acceptance of this architecture requires deleting, not retaining, superseded
paths:

- repository-owned platform adapters, host filesystem paths, and destructive
  allowlists;
- static control-plane renderers or host command generation;
- optional or online remote-access package installation and floating package
  sources;
- per-session `/32` route generation on machine configs;
- password SSH and the Windows testbed password secret;
- daemon mock/TCP hardware paths as evidence for Windows simulated-hardware
  readiness;
- VEM-side repackaging of the production Vision implementation.

No compatibility mode may satisfy Factory Image Acceptance or VM Runtime
Acceptance. A legacy path can exist only until its replacement is deployed and
must be removed before the corresponding gate is declared passing.
