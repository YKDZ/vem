# Default Audio Adapter Evidence

`capture-default-audio` is an external VM Host Adapter operation. It proves
the Windows default render path and the existing Tauri native cue path in one
active disposable-overlay lifecycle. It is not a physical-speaker audibility
claim and it does not select an application-specific device.

The request contains only logical identities and requires:

- the adapter request `runId`, `lifecycleReference`, and operation reference;
- the active `VEMKiosk` Windows session user and positive session id;
- `tauri_native_audio` and the existing `play_machine_audio` command;
- positive minimum peak and non-silent-frame thresholds.

The successful semantic result repeats the request `runId`, lifecycle, and
capture operation reference. It must contain a selected default render endpoint
whose logical identity equals `guest.defaultAudioIdentity`. Its native-cue
record echoes the requested Tauri command. The capture begins before the cue,
ends after it, and reports a canonical UTC cue timestamp inside that interval.
The capture artifact is an immutable `factory-evidence://sha256/<digest>` WAV
export. The runner hashes the exported bytes, parses PCM, and requires its
format, measurements, threshold, non-silent-frame count, and peak sample to
equal the semantic report.

The adapter client rejects missing endpoints, browser-only cues, stale kiosk
session bindings, malformed WAV data, digest mismatches, silent samples, and
measurements below the declared threshold. A rejected capture invokes the same
explicit cleanup recovery as an adapter failure. The outer lifecycle still
issues unconditional cleanup, which must attest removal of the overlay,
run-owned directory, and personalization media.

Run the platform-neutral verifier with:

```sh
pnpm check:vm-host-adapter
```

This command exercises the deterministic external adapter fixture only. It
does not dispatch a runtime workflow, connect to a VM, or make a production
audio claim. Physical speaker placement and audibility remain field acceptance.
