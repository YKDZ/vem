import { spawn } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const CAPTURE_SCHEMA = "vem-business-set-process-replay-capture/v1";
const FRAME_PATH = /^frames\/[0-9]{6}\.jpg$/;

type JsonRecord = Record<string, unknown>;

interface ReplayFrame {
  file: string;
  timestampMs: number;
}

interface ReplaySegment {
  id: string;
  status: "completed" | "interrupted";
  startMs: number;
  endMs: number;
  durationMs: number;
}

interface ReplayCapture extends JsonRecord {
  businessSet: string;
  frames: ReplayFrame[];
  segments: ReplaySegment[];
  summary: JsonRecord & { durationMs: number };
}

interface FfmpegInvocation {
  cwd: string;
  args: string[];
}

function recordValue(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function parseCapture(value: unknown): ReplayCapture {
  const capture = recordValue(value);
  const summary = recordValue(capture.summary);
  if (capture.schemaVersion !== CAPTURE_SCHEMA) {
    throw new Error("process replay capture schema is invalid");
  }
  if (
    typeof capture.businessSet !== "string" ||
    capture.businessSet.trim() === ""
  ) {
    throw new Error("process replay business set is missing");
  }
  if (!Number.isFinite(summary.durationMs) || Number(summary.durationMs) < 0) {
    throw new Error("process replay duration is invalid");
  }
  if (!Array.isArray(capture.frames) || capture.frames.length === 0) {
    throw new Error("process replay has no frames to synthesize");
  }
  let previousTimestamp = -Infinity;
  const frames = capture.frames.map((value, index) => {
    const frame = recordValue(value);
    if (
      typeof frame.file !== "string" ||
      !FRAME_PATH.test(frame.file) ||
      !Number.isFinite(frame.timestampMs) ||
      Number(frame.timestampMs) < previousTimestamp
    ) {
      throw new Error(`process replay frame ${index + 1} is invalid`);
    }
    previousTimestamp = Number(frame.timestampMs);
    return {
      file: frame.file,
      timestampMs: Number(frame.timestampMs),
    };
  });
  const segmentIds = new Set<string>();
  const segments = (
    Array.isArray(capture.segments) ? capture.segments : []
  ).map((value, index) => {
    const segment = recordValue(value);
    if (
      typeof segment.id !== "string" ||
      !/^[a-z][a-z0-9-]{0,63}$/.test(segment.id) ||
      segmentIds.has(segment.id) ||
      (segment.status !== "completed" && segment.status !== "interrupted") ||
      !Number.isFinite(segment.startMs) ||
      !Number.isFinite(segment.endMs) ||
      !Number.isFinite(segment.durationMs) ||
      Number(segment.startMs) < 0 ||
      Number(segment.endMs) < Number(segment.startMs) ||
      Number(segment.endMs) > Number(summary.durationMs) ||
      Number(segment.durationMs) !==
        Number(segment.endMs) - Number(segment.startMs)
    ) {
      throw new Error(`process replay segment ${index + 1} is invalid`);
    }
    segmentIds.add(segment.id);
    return {
      id: segment.id,
      status: segment.status,
      startMs: Number(segment.startMs),
      endMs: Number(segment.endMs),
      durationMs: Number(segment.durationMs),
    } as ReplaySegment;
  });
  return {
    ...capture,
    businessSet: capture.businessSet,
    frames,
    segments,
    summary: { ...summary, durationMs: Number(summary.durationMs) },
  } as ReplayCapture;
}

/** FFmpeg concat 清单直接复用录制时间轴；最后一帧保持到业务操作结束。 */
export function renderProcessReplayConcat(value: unknown): string {
  const capture = parseCapture(value);
  const firstTimestamp = capture.frames[0]!.timestampMs;
  const lines = ["ffconcat version 1.0"];
  for (let index = 0; index < capture.frames.length; index += 1) {
    const frame = capture.frames[index]!;
    const next = capture.frames[index + 1];
    const durationMs = next
      ? Math.max(1, next.timestampMs - frame.timestampMs)
      : Math.max(
          33,
          capture.summary.durationMs - (frame.timestampMs - firstTimestamp),
        );
    lines.push(
      `file '${frame.file}'`,
      `duration ${(durationMs / 1_000).toFixed(3)}`,
    );
  }
  lines.push(`file '${capture.frames.at(-1)!.file}'`, "");
  return lines.join("\n");
}

async function findCapturePaths(root: string): Promise<string[]> {
  const found: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name === "capture.json")
        found.push(path);
    }
  };
  await visit(root);
  return found.sort();
}

async function runFfmpegProcess({
  cwd,
  args,
}: FfmpegInvocation): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn("ffmpeg", args, {
      cwd,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 8_192) stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else {
        reject(
          new Error(
            `ffmpeg exited with ${code ?? `signal ${signal ?? "unknown"}`}: ${stderr.trim()}`,
          ),
        );
      }
    });
  });
}

export async function synthesizeProcessReplayVideos({
  root,
  runFfmpeg = runFfmpegProcess,
}: {
  root: string;
  runFfmpeg?: (invocation: FfmpegInvocation) => Promise<void>;
}): Promise<
  Array<{
    businessSet: string;
    capturePath: string;
    videoPath: string;
    segmentVideos: Array<{ id: string; videoPath: string }>;
  }>
> {
  const canonicalRoot = resolve(root);
  const capturePaths = await findCapturePaths(canonicalRoot);
  if (capturePaths.length === 0) {
    throw new Error(`no process replay captures found under ${canonicalRoot}`);
  }
  const outputs = [];
  for (const capturePath of capturePaths) {
    const directory = dirname(capturePath);
    const capture = parseCapture(
      JSON.parse(await readFile(capturePath, "utf8")),
    );
    const concatPath = join(directory, "replay.ffconcat");
    const videoPath = join(directory, "replay.mp4");
    await writeFile(concatPath, renderProcessReplayConcat(capture), "utf8");
    await runFfmpeg({
      cwd: directory,
      args: [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-safe",
        "0",
        "-f",
        "concat",
        "-i",
        "replay.ffconcat",
        "-vf",
        "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p",
        "-fps_mode",
        "vfr",
        "-movflags",
        "+faststart",
        "replay.mp4",
      ],
    });
    const segmentVideos: Array<{ id: string; videoPath: string }> = [];
    for (const segment of capture.segments) {
      const segmentVideoName = `replay-${segment.id}.mp4`;
      const segmentVideoPath = join(directory, segmentVideoName);
      await runFfmpeg({
        cwd: directory,
        args: [
          "-hide_banner",
          "-loglevel",
          "error",
          "-y",
          "-ss",
          (segment.startMs / 1_000).toFixed(3),
          "-i",
          "replay.mp4",
          "-t",
          (Math.max(33, segment.durationMs) / 1_000).toFixed(3),
          "-vf",
          "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p",
          "-fps_mode",
          "vfr",
          "-movflags",
          "+faststart",
          segmentVideoName,
        ],
      });
      segmentVideos.push({ id: segment.id, videoPath: segmentVideoPath });
    }
    outputs.push({
      businessSet: capture.businessSet,
      capturePath,
      videoPath,
      segmentVideos,
    });
  }
  return outputs.sort((left, right) =>
    left.businessSet.localeCompare(right.businessSet),
  );
}
