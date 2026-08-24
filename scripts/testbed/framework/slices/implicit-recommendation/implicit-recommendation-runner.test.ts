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

  it("最终 full 显式开启时录制独立推荐回放并写入 supportingEvidence", async () => {
    const previousReplay = process.env.VEM_PROCESS_REPLAY;
    const previousReplayDirectory = process.env.VEM_PROCESS_REPLAY_DIR;
    process.env.VEM_PROCESS_REPLAY = "1";
    process.env.VEM_PROCESS_REPLAY_DIR = "/tmp/replay";
    const cdp = {
      endpoint: "http://127.0.0.1:9222",
      client: { send: async () => ({}) },
      async connect() {
        return this;
      },
      async close() {},
      async run() {
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    let replayDirectory: string | null = null;
    try {
      const report = await main(
        ["--mode", "full", "--out", "/result/implicit.json"],
        {
          createCdpAdapter: () => cdp,
          createAcceptanceAdapter: () => ({}) as never,
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
          runReplay: async (context, operation) => {
            replayDirectory = context.outputDirectory;
            const result = await operation();
            context.onSummary?.({
              status: "completed",
              reason: null,
              startedAt: "2026-08-24T12:00:00.000Z",
              finishedAt: "2026-08-24T12:00:01.000Z",
              durationMs: 1_000,
              framesReceived: 10,
              framesWritten: 10,
              framesDropped: 0,
              framesSkipped: 0,
              bytesWritten: 1_000,
              truncated: false,
              firstFrameTimestampMs: 1,
              lastFrameTimestampMs: 1_001,
              outputDirectory: context.outputDirectory,
              capturePath: `${context.outputDirectory}/capture.json`,
              playerPath: `${context.outputDirectory}/player.html`,
            });
            return result;
          },
          io: { writeFile: async () => undefined },
          writeStdout: () => undefined,
        },
      );
      assert.equal(replayDirectory, "/tmp/replay/implicit-recommendation");
      assert.equal(
        report.businessSets[0]?.supportingEvidence.some(
          (entry) =>
            (entry as { kind?: string }).kind === "business-set-process-replay",
        ),
        true,
      );
    } finally {
      if (previousReplay === undefined) delete process.env.VEM_PROCESS_REPLAY;
      else process.env.VEM_PROCESS_REPLAY = previousReplay;
      if (previousReplayDirectory === undefined)
        delete process.env.VEM_PROCESS_REPLAY_DIR;
      else process.env.VEM_PROCESS_REPLAY_DIR = previousReplayDirectory;
    }
  });
});
