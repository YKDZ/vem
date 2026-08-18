import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createFakeTestAdapter, assertAdapterContract } from "./test-adapter.mjs";

describe("test adapter contract", () => {
  it("reads and writes files through the same capability surface", async () => {
    const adapter = createFakeTestAdapter({ files: {} });
    await adapter.writeFile("C:\\VEM\\testbed\\ready.json", '{"ok":true}');
    assert.equal(
      await adapter.readFile("C:\\VEM\\testbed\\ready.json"),
      '{"ok":true}',
    );
  });

  it("runs commands and returns exit code plus output", async () => {
    const adapter = createFakeTestAdapter({
      commands: {
        "netstat -ano": { exitCode: 0, stdout: "LISTENING 7892" },
      },
    });
    const result = await adapter.run("netstat", ["-ano"]);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /7892/);
  });

  it("reports a missing remote file as an observable error", async () => {
    const adapter = createFakeTestAdapter({ files: {} });
    await assert.rejects(
      adapter.readFile("C:\\missing.json"),
      /missing file/,
    );
  });

  it("passes the shared adapter contract", async () => {
    const adapter = createFakeTestAdapter({
      files: { "C:\\evidence.json": "{}" },
      commands: { "whoami": { exitCode: 0, stdout: "vemkiosk" } },
    });
    await assertAdapterContract(adapter);
  });
});
