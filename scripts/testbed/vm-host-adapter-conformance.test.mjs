import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

const conformance = new URL(
  "./vm-host-adapter-conformance.mjs",
  import.meta.url,
).pathname;
const adapter = new URL("./fake-vm-host-adapter.mjs", import.meta.url).pathname;

describe("VM host adapter conformance", () => {
  it("binds contract-valid Factory media to a ready clean-install request", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-vm-host-conformance-"));
    const factoryIsoIdentity = `factory-cas://sha256/${"b".repeat(64)}`;
    const output = join(root, "conformance.json");
    try {
      execFileSync(process.execPath, [conformance, "--out", output], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          RUNNER_TEMP: root,
          GITHUB_RUN_ID: "9001",
          VEM_VM_HOST_ADAPTER: adapter,
          VEM_VM_HOST_ADAPTER_CONTRACT_TEST_ONLY: "1",
          VEM_VM_HOST_TARGET_ID: "vm-target://runtime-testbed",
          VEM_VM_HOST_APPROVED_BASE_ID: `factory-cas://sha256/${"a".repeat(64)}`,
          VEM_VM_HOST_FACTORY_ISO_ID: factoryIsoIdentity,
          VEM_VM_HOST_FACTORY_PERSONALIZATION_MEDIA_ID: `factory-cas://sha256/${"c".repeat(64)}`,
          VEM_VM_HOST_CLEAN_INSTALL_STATUS: "ready",
        },
      });
      const cleanInstall = JSON.parse(readFileSync(output, "utf8")).evidence
        .cleanInstall;
      assert.deepEqual(cleanInstall.request.factoryMedia, {
        assemblyMode: "windows-serviced-iso",
        targetFirmware: "bios",
        manifestIdentity: `sha256:${"b".repeat(64)}`,
        provenanceIdentity: `factory-evidence://sha256/${"b".repeat(64)}`,
        provenanceDigest: `sha256:${"b".repeat(64)}`,
        outputIdentity: factoryIsoIdentity,
        outputDigest: `sha256:${"b".repeat(64)}`,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
