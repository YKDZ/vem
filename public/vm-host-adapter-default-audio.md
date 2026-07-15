# Selected Audio Adapter Evidence

`capture-default-audio` is an external VM Host Adapter operation. It proves
that the daemon can complete its fixed non-silent calibration on the selected
stable Windows render endpoint while a synchronized PCM loopback capture is
active. It is not a physical-speaker audibility claim; placement and audibility
remain field acceptance.

The request contains logical identities and requires:

- the adapter request `runId`, `lifecycleReference`, and operation reference;
- the active `VEMKiosk` Windows session user and positive session id;
- the stable endpoint id selected through daemon maintenance;
- a runner-generated hexadecimal challenge for the protected daemon
  `audio_output_calibration` IPC command;
- positive minimum peak, duration, distinct-sample, and non-silent-frame
  thresholds.

The production adapter must begin endpoint-specific PCM capture before calling
the protected daemon calibration command and keep capture active until the
daemon response is complete. It writes that unmodified JSON response as a
separate digest-named evidence file. The semantic adapter result may reference
that file, but it must not copy or self-attest the daemon token, observation
revision/generation, effective-config revision/generation, or proposed-settings
digest.

The runner independently hashes and parses both evidence files. It requires the
raw daemon response to bind the requested endpoint and challenge, a live-format
evidence token and expiry, every revision and monotonic generation, and the
proposed-settings digest. It also parses the WAV PCM bytes and requires their
format and measurements to equal the semantic report. The capture interval must
enclose the complete daemon calibration interval, and the requested kiosk
session must equal the runtime acceptance observation.

The successful result repeats the request run, lifecycle, operation, kiosk
session, and selected endpoint identities. Both artifacts use immutable
`factory-evidence://sha256/<digest>` identities. `capture.source` is a
platform-neutral provenance label, while `capture.adapterIdentity` binds the
capture to the external adapter implementation.

The client rejects default-device substitution, browser or Tauri cue
substitution, missing raw daemon response, stale kiosk session binding,
endpoint or challenge mismatch, malformed evidence, digest mismatch, silent
PCM, and out-of-window calibration. Rejection invokes the normal adapter
recovery cleanup; the outer lifecycle still performs unconditional cleanup.

Run the platform-neutral contract suite with:

```sh
pnpm check:vm-host-adapter
```

This command exercises the deterministic external adapter fixture only. It
does not dispatch a runtime workflow, connect to a VM, or make a physical audio
claim.
