import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  renderProcessReplayConcat,
  synthesizeProcessReplayVideos,
} from "./process-replay-video.ts";

function capture(businessSet: string) {
  return {
    schemaVersion: "vem-business-set-process-replay-capture/v1",
    businessSet,
    frames: [
      { file: "frames/000001.jpg", timestampMs: 1_000 },
      { file: "frames/000002.jpg", timestampMs: 1_250 },
      { file: "frames/000003.jpg", timestampMs: 2_250 },
    ],
    summary: { durationMs: 2_000 },
    segments:
      businessSet === "vision-experience"
        ? [
            {
              id: "automatic-try-on",
              status: "completed",
              startMs: 100,
              endMs: 900,
              durationMs: 800,
            },
            {
              id: "manual-try-on",
              status: "completed",
              startMs: 900,
              endMs: 1_500,
              durationMs: 600,
            },
          ]
        : [],
  };
}

describe("process replay video synthesis", () => {
  it("preserves captured frame timing and holds the final frame to operation end", () => {
    assert.equal(
      renderProcessReplayConcat(capture("visionExperience")),
      [
        "ffconcat version 1.0",
        "file 'frames/000001.jpg'",
        "duration 0.250",
        "file 'frames/000002.jpg'",
        "duration 1.000",
        "file 'frames/000003.jpg'",
        "duration 0.750",
        "file 'frames/000003.jpg'",
        "",
      ].join("\n"),
    );
  });

  it("finds each business-set capture and synthesizes an independent MP4", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-replay-video-"));
    const calls: Array<{ cwd: string; args: string[] }> = [];
    try {
      for (const businessSet of [
        "vision-experience",
        "implicit-recommendation",
      ]) {
        const directory = join(root, "process-replay-pass-2", businessSet);
        mkdirSync(join(directory, "frames"), { recursive: true });
        writeFileSync(
          join(directory, "capture.json"),
          `${JSON.stringify(capture(businessSet))}\n`,
        );
      }

      const outputs = await synthesizeProcessReplayVideos({
        root,
        runFfmpeg: async ({ cwd, args }) => {
          calls.push({ cwd, args });
        },
      });

      assert.deepEqual(
        outputs.map((output) => output.businessSet),
        ["implicit-recommendation", "vision-experience"],
      );
      assert.equal(calls.length, 4);
      assert.deepEqual(
        calls.map((call) => call.args.at(-1)),
        [
          "replay.mp4",
          "replay.mp4",
          "replay-automatic-try-on.mp4",
          "replay-manual-try-on.mp4",
        ],
      );
      const visionOutput = outputs.find(
        (output) => output.businessSet === "vision-experience",
      );
      assert.deepEqual(
        visionOutput?.segmentVideos.map((segment) => ({
          id: segment.id,
          video: segment.videoPath.split("/").at(-1),
        })),
        [
          {
            id: "automatic-try-on",
            video: "replay-automatic-try-on.mp4",
          },
          { id: "manual-try-on", video: "replay-manual-try-on.mp4" },
        ],
      );
      const automaticCall = calls.find(
        (call) => call.args.at(-1) === "replay-automatic-try-on.mp4",
      );
      assert.ok(automaticCall);
      assert.deepEqual(automaticCall.args.slice(0, 8), [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-ss",
        "0.100",
        "-i",
        "replay.mp4",
      ]);
      assert.deepEqual(automaticCall.args.slice(8, 10), ["-t", "0.800"]);
      assert.equal(
        readFileSync(
          join(
            root,
            "process-replay-pass-2",
            "vision-experience",
            "replay.ffconcat",
          ),
          "utf8",
        ),
        renderProcessReplayConcat(capture("visionExperience")),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
