# Vision Release Bundle

VEM consumes Vision as an independent Windows release. Vision owns source,
models, dependencies, packaging, SBOM, provenance, and release evidence. VEM
does not rebuild, repackage, or edit the vendor runtime.

## Release Contract

The versioned descriptor is `vem-vision-release-descriptor/v1`. It identifies:

- strict release version and immutable SHA-256 bundle digest;
- Windows platform and architecture, original bundle format, and a declared `vem-vision-extractor/v1` handler;
- relative entrypoint and arguments;
- interactive lifecycle requirement and shutdown timeout;
- external configuration format, schema version, and command-line option;
- loopback health port/path/status/timeout;
- Vision protocol version and WebSocket path;

The signed document formats are published as strict JSON Schemas: [descriptor](./vision-release-descriptor-v1.schema.json), [artifact attestation](./vision-artifact-attestation-v1.schema.json), [approval](./vision-release-approval-v1.schema.json), [conformance evidence](./vision-conformance-v1.schema.json), and the factory-installed [trust policy](./vision-release-trust-policy-v1.schema.json). Unknown fields and structurally nonempty placeholders are invalid; an inventory candidate remains unapproved until signed verification succeeds against both repository and factory trust roots.

- content-addressed SBOM, provenance, and artifact-attestation evidence.

The VEM approval is `vem-vision-release-approval/v1`. It binds release version,
bundle digest, descriptor digest, attestation digest, and black-box conformance
evidence digest. The Factory Manifest `vision-release.release` selection repeats
the descriptor, attestation, approval, and conformance identities. VEM rejects
any mismatch before it writes a current selection or extracts the bundle.

The descriptor, SBOM, provenance, attestation, conformance evidence, and
approval are exact UTF-8 signed documents. Factory build and Windows install
verify their bytes, detached signatures, and role-specific approved signer
identities; they do not approve a release from metadata equality alone.

## Windows Lifecycle

The original bundle is installed unchanged under
`C:\VEM\vision\releases\<version>-<digest-prefix>`. VEM-owned state is under
`C:\ProgramData\VEM\vision`: current selection, external configuration,
process record, metadata, staging, and sanitized evidence. The generated
`C:\VEM\bringup\start_vision.bat` delegates to a VEM-owned selection launcher;
the existing `VEM\StartVisionServer` interactive task remains the lifecycle
boundary.

After selection, VEM checks loopback HTTP health and opens the declared
WebSocket endpoint against the exact selected digest. Failed startup, health,
or WebSocket conformance restores the previous approved selection. Evidence
contains digests and boolean outcomes only; it excludes private release paths,
configuration values, credentials, and vendor internals.

## Candidate Status

`docs/vending-vision.zip` has SHA-256
`9dc9dda0fb60a69cfac142bbbfd09f769b8ef965c0f4d3bbc8ccf3a8e33d4b1b` and contains
a Windows executable bundle. It is not approved because it supplies none of
the required descriptor, attestation, SBOM, provenance, clean-Windows HTTP and
WebSocket conformance evidence, or VEM approval. Its internal configuration is
not adopted as VEM configuration; approved releases must support the declared
external configuration contract.
