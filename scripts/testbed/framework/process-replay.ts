import { mkdir as fsMkdir, writeFile as fsWriteFile } from "node:fs/promises";
import { join } from "node:path";

import {
  CdpClient,
  rewriteWebSocketDebuggerUrl,
} from "../machine-ui-cdp-driver.ts";

const CAPTURE_SCHEMA = "vem-business-set-process-replay-capture/v1";
const TARGET_URL_MARKER = "tauri.localhost";

interface ReplayLimits {
  maxDurationMs: number;
  maxTotalBytes: number;
  maxFrameBytes: number;
  maxQueuedFrames: number;
  maxFrameCount: number;
}

interface ReplayBrowserSocket {
  addEventListener(
    type: string,
    handler: (event: unknown) => void,
    options?: { once?: boolean },
  ): void;
  removeEventListener(type: string, handler: (event: unknown) => void): void;
  send(data: string): void;
  close(): void;
  readyState: number;
}

type ReplayWebSocketFactory = (url: string) => ReplayBrowserSocket;

const DEFAULT_SCREENCAST: Readonly<{
  format: string;
  quality: number;
  maxWidth: number;
  maxHeight: number;
  everyNthFrame: number;
  maxFramesInFlight: number;
  sendLastFrame: boolean;
}> = Object.freeze({
  format: "jpeg",
  quality: 70,
  maxWidth: 540,
  maxHeight: 960,
  everyNthFrame: 1,
  maxFramesInFlight: 2,
  sendLastFrame: false,
});

const DEFAULT_LIMITS: Readonly<ReplayLimits> = Object.freeze({
  maxDurationMs: 10 * 60_000,
  maxTotalBytes: 512 * 1024 * 1024,
  maxFrameBytes: 4 * 1024 * 1024,
  maxQueuedFrames: 64,
  maxFrameCount: 60_000,
});

export interface ProcessReplaySummary {
  status: "completed" | "recorder-failure";
  reason: string | null;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  framesReceived: number;
  framesWritten: number;
  framesDropped: number;
  framesSkipped: number;
  bytesWritten: number;
  truncated: boolean;
  firstFrameTimestampMs: number | null;
  lastFrameTimestampMs: number | null;
  outputDirectory: string;
  capturePath: string;
  playerPath: string;
}

interface ReplayFrameRecord {
  file: string;
  timestampMs: number;
  receivedAtMs: number;
  sizeBytes: number;
  width: number | null;
  height: number | null;
}

interface RecorderState {
  received: number;
  dropped: number;
  skipped: number;
  written: number;
  bytesWritten: number;
  truncated: boolean;
  stoppedWriting: boolean;
  stopRequested: boolean;
  firstFrameTimestampMs: number | null;
  lastFrameTimestampMs: number | null;
  queue: {
    data: string;
    timestampMs: number;
    receivedAtMs: number;
  }[];
  frameRecords: ReplayFrameRecord[];
  wakeups: (() => void)[];
  writeError: string | null;
  pump: Promise<void>;
}

function shortReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 512);
}

function jpegDimensions(buffer: Buffer): {
  width: number;
  height: number;
} | null {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return null;
  }
  const limit = Math.min(buffer.length - 1, 4_096);
  let offset = 2;
  while (offset + 4 <= limit) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    if (
      marker === 0xd8 ||
      (marker >= 0xd0 && marker <= 0xd7) ||
      marker === 0x01
    ) {
      offset += 2;
      continue;
    }
    const segmentSize = buffer.readUInt16BE(offset + 2);
    if (segmentSize < 2) return null;
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      if (offset + 9 >= buffer.length) return null;
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + segmentSize;
  }
  return null;
}

function recordFromFrame(
  frame: RecorderState["queue"][number],
  index: number,
  dimensions: { width: number; height: number } | null,
): ReplayFrameRecord {
  return {
    file: `frames/${String(index).padStart(6, "0")}.jpg`,
    timestampMs: frame.timestampMs,
    receivedAtMs: frame.receivedAtMs,
    sizeBytes: Math.ceil(frame.data.length * 0.75),
    width: dimensions?.width ?? null,
    height: dimensions?.height ?? null,
  };
}

function captureJson({
  businessSet,
  createdAt,
  frames,
  summary,
}: {
  businessSet: string | null;
  createdAt: string;
  frames: ReplayFrameRecord[];
  summary: ProcessReplaySummary;
}) {
  return `${JSON.stringify(
    {
      schemaVersion: CAPTURE_SCHEMA,
      createdAt,
      businessSet,
      frames,
      summary,
    },
    null,
    2,
  )}\n`;
}

/**
 * 生成自包含 HTML 播放器：按真实时间间隔推进帧，帧间隔内保持上一帧，
 * 页面冻结会被忠实呈现。不依赖任何外部资源。
 */
export function renderProcessReplayPlayer({
  capture,
}: {
  capture: {
    createdAt: string;
    businessSet: string | null;
    frames: ReplayFrameRecord[];
    summary: ProcessReplaySummary;
  };
}): string {
  const payload = JSON.stringify(capture).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>VEM 业务过程回放</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; background: #101418; color: #e8edf2;
         font: 14px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; }
  #stage { display: flex; align-items: center; justify-content: center;
           height: calc(100vh - 96px); overflow: hidden; }
  img { max-width: 100%; max-height: 100%; background: #000; }
  #empty { color: #8aa0b4; }
  #bar { height: 96px; padding: 12px 16px; box-sizing: border-box;
          border-top: 1px solid #2a3440; display: flex; flex-wrap: wrap;
          align-items: center; gap: 8px 12px; }
  button { background: #1d2833; color: #e8edf2; border: 1px solid #3a4857;
           padding: 6px 12px; border-radius: 6px; cursor: pointer; }
  button:hover { background: #2a3a49; }
  #status { color: #8aa0b4; }
  #warn { color: #ffb454; }
</style>
</head>
<body>
<div id="stage"><span id="empty">正在载入…</span></div>
<div id="bar">
  <button id="play">暂停</button>
  <button id="restart">重播</button>
  <button id="prev">上一帧</button>
  <button id="next">下一帧</button>
  <span id="status"></span>
  <span id="warn"></span>
</div>
<script>
const CAPTURE = ${payload};
const FRAMES = Array.isArray(CAPTURE.frames) ? CAPTURE.frames : [];
const img = document.createElement("img");
const stage = document.getElementById("stage");
const empty = document.getElementById("empty");
const playButton = document.getElementById("play");
const status = document.getElementById("status");
const warn = document.getElementById("warn");
let index = -1;
let playing = true;
let anchor = null;

function renderStatus() {
  status.textContent = FRAMES.length
    ? "帧 " + (index + 1) + "/" + FRAMES.length + " | t=" + (FRAMES[index].timestampMs - FRAMES[0].timestampMs) + "ms | 已丢弃 " + CAPTURE.summary.framesDropped + " | 已截断 " + CAPTURE.summary.truncated
    : "该业务集没有产生画面帧（页面可能全程静止）";
  warn.textContent = CAPTURE.summary.status === "recorder-failure"
    ? "录制器异常：" + (CAPTURE.summary.reason ?? "未知")
    : (CAPTURE.summary.truncated ? "达到存储上限，已截断" : "");
}

function show(frameIndex) {
  if (!FRAMES.length) { empty.textContent = "该业务集没有产生画面帧（页面可能全程静止）"; stage.replaceChildren(empty); index = -1; return; }
  index = Math.max(0, Math.min(FRAMES.length - 1, frameIndex));
  img.src = FRAMES[index].file;
  if (img.parentElement !== stage) stage.replaceChildren(img);
  renderStatus();
}

function tick(nowMs) {
  if (!playing || !FRAMES.length) return;
  anchor ??= nowMs - (FRAMES[index < 0 ? 0 : index].timestampMs - FRAMES[0].timestampMs);
  const elapsed = nowMs - anchor;
  let next = FRAMES.length - 1;
  for (let i = index < 0 ? 0 : index; i < FRAMES.length; i++) {
    if (FRAMES[i].timestampMs - FRAMES[0].timestampMs <= elapsed) next = i;
    else break;
  }
  if (next !== index) show(next);
  requestAnimationFrame(tick);
}

playButton.addEventListener("click", () => {
  playing = !playing;
  playButton.textContent = playing ? "暂停" : "播放";
  if (playing) { anchor = null; requestAnimationFrame(tick); }
});
document.getElementById("restart").addEventListener("click", () => {
  anchor = performance.now();
  playing = true;
  playButton.textContent = "暂停";
  show(0);
});
document.getElementById("prev").addEventListener("click", () => { playing = false; playButton.textContent = "播放"; show(index - 1); });
document.getElementById("next").addEventListener("click", () => { playing = false; playButton.textContent = "播放"; show(index + 1); });

show(0);
requestAnimationFrame(tick);
</script>
</body>
</html>
`;
}

/**
 * 按业务集显式开启的页面过程回放。run() 总是原样返回或抛出业务操作的结果；
 * 录制器自身状态只通过 summary 暴露，录制失败、丢帧或截断都不得改变业务结果。
 */
export class BusinessSetProcessReplay {
  static async run<T>(
    context: {
      endpoint: string;
      outputDirectory: string;
      businessSet?: string | null;
      onSummary?: (summary: ProcessReplaySummary) => void;
      webSocketFactory?: ReplayWebSocketFactory;
      screencast?: Record<string, unknown>;
      limits?: Partial<ReplayLimits>;
      io?: { mkdir: typeof fsMkdir; writeFile: typeof fsWriteFile };
      now?: () => number;
    },
    operation: () => Promise<T> | T,
  ): Promise<T> {
    const io = context.io ?? { mkdir: fsMkdir, writeFile: fsWriteFile };
    const now = context.now ?? Date.now;
    const limits = { ...DEFAULT_LIMITS, ...(context.limits ?? {}) };
    const screencast = { ...DEFAULT_SCREENCAST, ...(context.screencast ?? {}) };
    const outputDirectory = context.outputDirectory;
    const capturePath = join(outputDirectory, "capture.json");
    const playerPath = join(outputDirectory, "player.html");
    const framesDirectory = join(outputDirectory, "frames");
    const startedAtMs = now();
    const summary: ProcessReplaySummary = {
      status: "completed",
      reason: null,
      startedAt: new Date(startedAtMs).toISOString(),
      finishedAt: new Date(startedAtMs).toISOString(),
      durationMs: 0,
      framesReceived: 0,
      framesWritten: 0,
      framesDropped: 0,
      framesSkipped: 0,
      bytesWritten: 0,
      truncated: false,
      firstFrameTimestampMs: null,
      lastFrameTimestampMs: null,
      outputDirectory,
      capturePath,
      playerPath,
    };

    let recorder: {
      client: CdpClient;
      state: RecorderState;
      stop: () => Promise<void>;
    } | null = null;
    try {
      recorder = await startProcessReplay({
        context,
        io,
        now,
        limits,
        screencast,
        outputDirectory,
        framesDirectory,
      });
    } catch (error) {
      summary.status = "recorder-failure";
      summary.reason = shortReason(error);
    }

    let result: T | null = null;
    let thrown: unknown = null;
    try {
      result = await operation();
    } catch (error) {
      thrown = error;
    } finally {
      if (recorder) {
        try {
          await recorder.stop();
        } catch (error) {
          summary.status = "recorder-failure";
          summary.reason = shortReason(error);
        }
      }
    }

    const finishedAtMs = now();
    summary.finishedAt = new Date(finishedAtMs).toISOString();
    summary.durationMs = Math.max(0, finishedAtMs - startedAtMs);
    if (recorder) {
      const state = recorder.state;
      summary.framesReceived = state.received;
      summary.framesWritten = state.written;
      summary.framesDropped = state.dropped;
      summary.framesSkipped = state.skipped;
      summary.bytesWritten = state.bytesWritten;
      summary.truncated = state.truncated;
      summary.firstFrameTimestampMs = state.firstFrameTimestampMs;
      summary.lastFrameTimestampMs = state.lastFrameTimestampMs;
      if (state.writeError && summary.status === "completed") {
        summary.status = "recorder-failure";
        summary.reason = state.writeError;
      }
    }

    const createdAt = new Date(finishedAtMs).toISOString();
    const capture = {
      createdAt,
      businessSet: context.businessSet ?? null,
      frames: recorder?.state.frameRecords ?? [],
      summary,
    };
    try {
      await io.mkdir(outputDirectory, { recursive: true });
      await io.writeFile(capturePath, captureJson(capture), "utf8");
      await io.writeFile(
        playerPath,
        renderProcessReplayPlayer({ capture }),
        "utf8",
      );
    } catch (error) {
      summary.status = "recorder-failure";
      summary.reason =
        summary.reason ?? `manifest write failed: ${shortReason(error)}`;
    }

    if (context.onSummary) {
      try {
        context.onSummary(summary);
      } catch {
        // 摘要回调只做旁路通知，不得改变业务结果。
      }
    }

    if (thrown !== null) throw thrown;
    return result as T;
  }
}

async function startProcessReplay({
  context,
  io,
  now,
  limits,
  screencast,
  outputDirectory,
  framesDirectory,
}: {
  context: {
    endpoint: string;
    webSocketFactory?: ReplayWebSocketFactory;
  };
  io: { mkdir: typeof fsMkdir; writeFile: typeof fsWriteFile };
  now: () => number;
  limits: ReplayLimits;
  screencast: typeof DEFAULT_SCREENCAST;
  outputDirectory: string;
  framesDirectory: string;
}) {
  const startedAtMs = now();
  const targets = (await (await fetch(`${context.endpoint}/json`)).json()) as {
    type?: string;
    url?: string;
    webSocketDebuggerUrl?: string;
  }[];
  const target = targets.find(
    (candidate) =>
      candidate.type === "page" &&
      typeof candidate.url === "string" &&
      candidate.url.includes(TARGET_URL_MARKER) &&
      typeof candidate.webSocketDebuggerUrl === "string",
  );
  if (!target) {
    throw new Error("Machine UI CDP target was not found");
  }
  const webSocketUrl = rewriteWebSocketDebuggerUrl(
    target.webSocketDebuggerUrl!,
    context.endpoint,
  );
  const client = new CdpClient(
    webSocketUrl,
    context.webSocketFactory
      ? { webSocketFactory: context.webSocketFactory }
      : {},
  );
  await client.connect({ timeoutMs: 10_000 });
  await client.send("Page.enable");
  await io.mkdir(framesDirectory, { recursive: true });

  const state: RecorderState = {
    received: 0,
    dropped: 0,
    skipped: 0,
    written: 0,
    bytesWritten: 0,
    truncated: false,
    stoppedWriting: false,
    stopRequested: false,
    firstFrameTimestampMs: null,
    lastFrameTimestampMs: null,
    queue: [],
    frameRecords: [],
    wakeups: [],
    writeError: null,
    pump: Promise.resolve(),
  };

  const notify = () => {
    const wakeup = state.wakeups.shift();
    if (wakeup) wakeup();
  };
  const waitWakeup = () =>
    new Promise<void>((resolve) => state.wakeups.push(resolve));

  const writeFrame = async (frame: RecorderState["queue"][number]) => {
    if (state.stoppedWriting) return;
    const sizeBytes = Math.ceil(frame.data.length * 0.75);
    if (sizeBytes > limits.maxFrameBytes) {
      state.skipped += 1;
      return;
    }
    if (now() - startedAtMs > limits.maxDurationMs) {
      state.truncated = true;
      state.stoppedWriting = true;
      state.writeError = "process replay exceeded its duration limit";
      return;
    }
    if (state.bytesWritten + sizeBytes > limits.maxTotalBytes) {
      state.truncated = true;
      state.stoppedWriting = true;
      state.writeError = "process replay exceeded its total byte budget";
      return;
    }
    const decoded = Buffer.from(frame.data, "base64");
    const dimensions = jpegDimensions(decoded);
    if (dimensions && (dimensions.width < 64 || dimensions.height < 64)) {
      // WebView2 在窗口表面瞬态切换时会发出极小的退化帧；跳过并计数。
      state.skipped += 1;
      return;
    }
    const record = recordFromFrame(frame, state.written + 1, dimensions);
    try {
      await io.writeFile(join(outputDirectory, record.file), decoded);
    } catch (error) {
      state.stoppedWriting = true;
      state.writeError = shortReason(error);
      return;
    }
    state.written += 1;
    state.bytesWritten += sizeBytes;
    state.firstFrameTimestampMs ??= frame.timestampMs;
    state.lastFrameTimestampMs = frame.timestampMs;
    state.frameRecords.push(record);
  };

  state.pump = (async () => {
    for (;;) {
      if (state.stoppedWriting) {
        state.skipped += state.queue.length;
        state.queue.length = 0;
      }
      const frame = state.queue.shift();
      if (frame) {
        await writeFrame(frame);
        continue;
      }
      if (state.stopRequested) return;
      await waitWakeup();
    }
  })();

  client.on("Page.screencastFrame", (params: unknown) => {
    const receivedAtMs = now();
    const event = params as {
      data?: unknown;
      sessionId?: unknown;
      metadata?: { timestamp?: unknown };
    } | null;
    const data = typeof event?.data === "string" ? event.data : null;
    void client
      .send("Page.screencastFrameAck", { sessionId: event?.sessionId })
      .catch(() => {});
    state.received += 1;
    if (data === null) {
      state.skipped += 1;
      return;
    }
    if (state.received > limits.maxFrameCount) {
      state.dropped += 1;
      return;
    }
    if (state.queue.length >= limits.maxQueuedFrames) {
      state.dropped += 1;
      return;
    }
    const timestampMs =
      typeof event?.metadata?.timestamp === "number"
        ? Math.round(event.metadata.timestamp * 1_000)
        : receivedAtMs;
    state.queue.push({ data, timestampMs, receivedAtMs });
    notify();
  });

  await client.send("Page.startScreencast", screencast);

  return {
    client,
    state,
    stop: async () => {
      await client.send("Page.stopScreencast").catch(() => {});
      state.stopRequested = true;
      notify();
      await state.pump;
      // stopScreencast 在途的尾帧可能晚于 pump 退出到达；再排空一次并照常计数。
      while (state.queue.length > 0 && !state.stoppedWriting) {
        const frame = state.queue.shift()!;
        await writeFrame(frame);
      }
      await client.close();
    },
  };
}
