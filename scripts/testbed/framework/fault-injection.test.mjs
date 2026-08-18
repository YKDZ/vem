import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createProcessRoleManifest,
  assertProcessRoleManifest,
  stopDeclaredRole,
} from "./fault-injection.mjs";
import { createFakeTestAdapter } from "./test-adapter.mjs";

describe("product-declared process role boundary", () => {
  it("accepts a manifest that declares each role with an explicit stop command", () => {
    const manifest = createProcessRoleManifest({
      roles: {
        observer: {
          stopCommand: ["stop-vision-role", "--role", "observer"],
        },
        broker: {
          stopCommand: ["stop-vision-role", "--role", "broker"],
        },
      },
    });
    assertProcessRoleManifest(manifest);
  });

  it("rejects a manifest with an undeclared stop command shape", () => {
    assert.throws(
      () =>
        createProcessRoleManifest({
          roles: { observer: { stopCommand: "taskkill /PID 123" } },
        }),
      /stopCommand must be a non-empty command array/,
    );
  });

  it("stops a declared role through its own command and confirms death", async () => {
    const adapter = createFakeTestAdapter({
      commands: {
        "stop-vision-role --role observer": {
          exitCode: 0,
          stdout: "stopped observer",
        },
        "probe-vision-role observer": {
          exitCode: 0,
          stdout: "dead",
        },
      },
    });
    const manifest = createProcessRoleManifest({
      roles: {
        observer: {
          stopCommand: ["stop-vision-role", "--role", "observer"],
          probeCommand: ["probe-vision-role", "observer"],
        },
      },
    });
    const result = await stopDeclaredRole(adapter, manifest, "observer", {
      timeoutMs: 1_000,
      pollMs: 5,
    });
    assert.equal(result.confirmed, true);
    assert.match(result.stdout, /stopped observer/);
  });

  it("refuses to stop a role the product never declared", async () => {
    const adapter = createFakeTestAdapter({ commands: {} });
    const manifest = createProcessRoleManifest({ roles: {} });
    await assert.rejects(
      stopDeclaredRole(adapter, manifest, "mystery"),
      /unknown role: mystery/,
    );
  });
});
