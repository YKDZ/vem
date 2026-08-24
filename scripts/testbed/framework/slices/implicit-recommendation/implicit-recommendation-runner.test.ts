import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { businessAssertion } from "../../observation-record.ts";
import { main } from "./implicit-recommendation-runner.ts";

describe("implicit recommendation slice runner", () => {
  it("writes one V2 business-set report and closes the installed CDP boundary", async () => {
    const events: string[] = [];
    const writes: Array<{ path: string; content: string }> = [];
    const output: string[] = [];
    const cdp = {
      client: { send: async () => ({}) },
      async connect() {
        events.push("connect");
        return this;
      },
      async close() {
        events.push("close");
      },
      async run() {
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    let receivedArtifactRoot: string | null | undefined;

    const report = await main(
      ["--mode", "full", "--out", "/result/implicit.json"],
      {
        createCdpAdapter: () => cdp,
        createAcceptanceAdapter: ({ artifactRoot }) => {
          receivedArtifactRoot = artifactRoot;
          return {} as never;
        },
        runBusinessSet: async () => ({
          assertions: [
            businessAssertion({
              id: "near.neutral-visible-within-500ms",
              source: "machine.runtime_trace+semantic_dom",
              expected: true,
              observed: true,
            }),
          ],
          evidence: {
            kind: "implicit-recommendation-business-evidence" as const,
            baselineQuiescent: true,
            finalRestored: true,
            scenarios: [],
          },
        }),
        io: {
          writeFile: async (path, content) => {
            writes.push({ path: String(path), content: String(content) });
          },
        },
        writeStdout: (content) => output.push(content),
        runId: "run-recommendation",
      },
    );

    assert.equal(
      receivedArtifactRoot,
      "/result/implicit-recommendation-artifacts",
    );
    assert.deepEqual(events, ["connect", "close"]);
    assert.equal(report.schemaVersion, "vem-runtime-testbed-report/v2");
    assert.equal(report.mode, "full");
    assert.equal(report.runId, "run-recommendation");
    assert.equal(report.businessSets[0]?.name, "implicitRecommendation");
    assert.equal(report.businessSets[0]?.status, "passed");
    assert.equal(writes.length, 1);
    assert.equal(output.length, 1);
    assert.deepEqual(JSON.parse(writes[0]!.content), report);
    assert.deepEqual(JSON.parse(output[0]!), report);
  });

  it("always closes CDP when the business driver fails operationally", async () => {
    const events: string[] = [];
    const cdp = {
      client: { send: async () => ({}) },
      async connect() {
        events.push("connect");
        return this;
      },
      async close() {
        events.push("close");
      },
      async run() {
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };

    await assert.rejects(
      main([], {
        createCdpAdapter: () => cdp,
        createAcceptanceAdapter: () => ({}) as never,
        runBusinessSet: async () => {
          throw new Error("fixture switch failed");
        },
        writeStdout: () => undefined,
      }),
      /fixture switch failed/,
    );
    assert.deepEqual(events, ["connect", "close"]);
  });
});
