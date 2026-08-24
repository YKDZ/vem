import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BusinessSetProcessReplay,
  type ProcessReplaySummary,
} from "./process-replay.ts";

type JsonRecord = Record<string, unknown>;

function recordValue(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

type ReplayIo = NonNullable<
  Parameters<typeof BusinessSetProcessReplay.run>[0]
>["io"];

function target(route = "#/catalog"): JsonRecord {
  return {
    id: "page-target-1",
    type: "page",
    title: "VEM",
    url: `http://tauri.localhost/${route}`,
    webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/page-target-1",
  };
}

async function withHttpTargets<T>(
  targets: JsonRecord[],
  callback: (endpoint: string) => Promise<T>,
): Promise<T> {
  const server = createServer((request, response) => {
    if (request.url !== "/json") {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(targets));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const { port } = address;
  try {
    return await callback(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

class FakeWebSocket {
  url: string;
  handler: (message: JsonRecord, socket: FakeWebSocket) => JsonRecord | null;
  readyState: number;
  sent: JsonRecord[];
  listeners: Map<
    string,
    { handler: (event: unknown) => void; once: boolean }[]
  >;
  closed: boolean;
  failSend?: boolean;

  constructor(
    url: string,
    handler: (message: JsonRecord, socket: FakeWebSocket) => JsonRecord | null,
  ) {
    this.url = url;
    this.handler = handler;
    this.readyState = 0;
    this.sent = [];
    this.listeners = new Map();
    this.closed = false;
    queueMicrotask(() => {
      this.readyState = 1;
      this.#emit("open", {});
    });
  }

  addEventListener(
    type: string,
    handler: (event: unknown) => void,
    options: { once?: boolean } = {},
  ) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    const entries = this.listeners.get(type) ?? [];
    entries.push({ handler, once: options.once === true });
    this.listeners.set(type, entries);
  }

  removeEventListener(type: string, handler: (event: unknown) => void) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter(
        (entry) => entry.handler !== handler,
      ),
    );
  }

  send(raw: string) {
    if (this.failSend) throw new Error("socket send failed");
    const message = JSON.parse(raw);
    this.sent.push(message);
    const response = this.handler(message, this);
    if (response == null) return;
    queueMicrotask(() => this.emitMessage(response));
  }

  emitMessage(message: JsonRecord) {
    this.#emit("message", { data: JSON.stringify(message) });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.#emit("close", {});
  }

  #emit(type: string, event: unknown) {
    const entries = [...(this.listeners.get(type) ?? [])];
    for (const entry of entries) entry.handler(event);
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((entry) => !entry.once),
    );
  }
}

function inMemoryIo(): {
  files: Map<string, Buffer>;
  io: ReplayIo;
} {
  const files: Map<string, Buffer> = new Map();
  const io = {
    async mkdir() {},
    async writeFile(path: string, data: unknown) {
      files.set(path, Buffer.from(String(data)));
    },
    async clearDirectory(path: string) {
      const prefix = `${path}/`;
      for (const key of [...files.keys()]) {
        if (key.startsWith(prefix)) files.delete(key);
      }
    },
  } as unknown as ReplayIo;
  return {
    files,
    io,
  };
}

function replayFile(files: Map<string, Buffer>, path: string): Buffer {
  const file = files.get(path);
  assert.ok(file);
  return file;
}

function jpegFrame(index: number, timestampSeconds: number): JsonRecord {
  const data = Buffer.from(`jpeg-frame-${index}`).toString("base64");
  return {
    method: "Page.screencastFrame",
    params: {
      data,
      metadata: { timestamp: timestampSeconds },
      sessionId: index,
    },
  };
}

function respondingSocketHandler(
  message: JsonRecord,
  socket: FakeWebSocket,
  options: { frames?: JsonRecord[] } = {},
) {
  if (message.id == null) return null;
  if (message.method === "Page.enable") return { id: message.id, result: {} };
  if (message.method === "Page.startScreencast") {
    const frames = options.frames ?? [];
    for (const frame of frames) queueMicrotask(() => socket.emitMessage(frame));
    return { id: message.id, result: {} };
  }
  if (message.method === "Page.stopScreencast") {
    return { id: message.id, result: {} };
  }
  return { id: message.id, result: {} };
}

test("静态页：业务结果原样返回，回放零帧并仍写出清单与播放器", async () => {
  await withHttpTargets([target()], async (endpoint) => {
    const { files, io } = inMemoryIo();
    const outputDirectory = "/replay/static";
    let summary: ProcessReplaySummary | undefined;
    const value = await BusinessSetProcessReplay.run(
      {
        endpoint,
        outputDirectory,
        businessSet: "visionExperience",
        onSummary: (entry) => {
          summary = entry;
        },
        webSocketFactory: (url) =>
          new FakeWebSocket(url, (message, socket) =>
            respondingSocketHandler(message, socket),
          ),
        io,
      },
      async () => ({ business: "ok" }),
    );
    assert.deepEqual(value, { business: "ok" });
    assert.ok(summary);
    assert.equal(summary.status, "completed");
    assert.equal(summary.framesReceived, 0);
    assert.equal(summary.framesWritten, 0);
    assert.equal(summary.firstFrameTimestampMs, null);
    const capture = JSON.parse(
      replayFile(files, "/replay/static/capture.json").toString(),
    );
    assert.equal(
      capture.schemaVersion,
      "vem-business-set-process-replay-capture/v1",
    );
    assert.deepEqual(capture.frames, []);
    assert.match(
      replayFile(files, "/replay/static/player.html").toString(),
      /该业务集没有产生画面帧/,
    );
  });
});

test("动态页：screencast 帧被立即 ACK、按序落盘并写入时间戳清单", async () => {
  await withHttpTargets([target()], async (endpoint) => {
    const { files, io } = inMemoryIo();
    const socketList: FakeWebSocket[] = [];
    let summary: ProcessReplaySummary | undefined;
    const value = await BusinessSetProcessReplay.run(
      {
        endpoint,
        outputDirectory: "/replay/dynamic",
        businessSet: "visionExperience",
        onSummary: (entry) => {
          summary = entry;
        },
        webSocketFactory: (url) => {
          const socket = new FakeWebSocket(url, (message, current) =>
            respondingSocketHandler(message, current, {
              frames: [
                jpegFrame(1, 1_000.25),
                jpegFrame(2, 1_000.5),
                jpegFrame(3, 1_000.75),
              ],
            }),
          );
          socketList.push(socket);
          return socket;
        },
        io,
      },
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return "business-result";
      },
    );
    assert.equal(value, "business-result");
    assert.ok(summary);
    assert.equal(summary.status, "completed");
    assert.equal(summary.framesReceived, 3);
    assert.equal(summary.framesWritten, 3);
    assert.equal(summary.framesDropped, 0);
    assert.equal(summary.firstFrameTimestampMs, 1_000_250);
    assert.equal(summary.lastFrameTimestampMs, 1_000_750);
    const socket = socketList[0];
    const acks = socket.sent.filter(
      (entry) => entry.method === "Page.screencastFrameAck",
    );
    assert.equal(acks.length, 3);
    assert.deepEqual(
      acks.map((entry) => recordValue(entry.params).sessionId),
      [1, 2, 3],
    );
    const capture = JSON.parse(
      replayFile(files, "/replay/dynamic/capture.json").toString(),
    );
    assert.deepEqual(
      capture.frames.map((frame: JsonRecord) => frame.file),
      ["frames/000001.jpg", "frames/000002.jpg", "frames/000003.jpg"],
    );
    assert.equal(
      replayFile(files, "/replay/dynamic/frames/000002.jpg").toString(),
      "jpeg-frame-2",
    );
    assert.match(
      replayFile(files, "/replay/dynamic/player.html").toString(),
      /frames\/000001\.jpg/,
    );
    assert.equal(socket.closed, true);
  });
});

test("重跑前清理残留帧，避免上一轮更长的录制污染本轮清单", async () => {
  await withHttpTargets([target()], async (endpoint) => {
    const { files, io } = inMemoryIo();
    const outputDirectory = "/replay/reused";
    files.set("/replay/reused/frames/000001.jpg", Buffer.from("stale-1"));
    files.set("/replay/reused/frames/000099.jpg", Buffer.from("stale-99"));
    const value = await BusinessSetProcessReplay.run(
      {
        endpoint,
        outputDirectory,
        businessSet: "visionExperience",
        webSocketFactory: (url) =>
          new FakeWebSocket(url, (message, socket) =>
            respondingSocketHandler(message, socket, {
              frames: [jpegFrame(1, 2_000.25), jpegFrame(2, 2_000.5)],
            }),
          ),
        io,
      },
      async () => "business-result",
    );
    assert.equal(value, "business-result");
    assert.ok(!files.has("/replay/reused/frames/000099.jpg"));
    assert.equal(
      replayFile(files, "/replay/reused/frames/000001.jpg").toString(),
      "jpeg-frame-1",
    );
    assert.equal(
      replayFile(files, "/replay/reused/frames/000002.jpg").toString(),
      "jpeg-frame-2",
    );
  });
});

test("业务失败：原样抛出业务错误，回放仍正常收尾", async () => {
  await withHttpTargets([target()], async (endpoint) => {
    const { files, io } = inMemoryIo();
    let summary: ProcessReplaySummary | undefined;
    const failure = new Error("business boom");
    await assert.rejects(
      BusinessSetProcessReplay.run(
        {
          endpoint,
          outputDirectory: "/replay/failure",
          onSummary: (entry) => {
            summary = entry;
          },
          webSocketFactory: (url) =>
            new FakeWebSocket(url, (message, socket) =>
              respondingSocketHandler(message, socket),
            ),
          io,
        },
        async () => {
          throw failure;
        },
      ),
      (error) => error === failure,
    );
    assert.ok(summary);
    assert.equal(summary.status, "completed");
    assert.ok(files.has("/replay/failure/capture.json"));
    assert.ok(files.has("/replay/failure/player.html"));
  });
});

test("recorder failure：找不到 Machine UI target 也不改变业务结果", async () => {
  await withHttpTargets([], async (endpoint) => {
    let summary: ProcessReplaySummary | undefined;
    const value = await BusinessSetProcessReplay.run(
      {
        endpoint,
        outputDirectory: "/replay/no-target",
        onSummary: (entry) => {
          summary = entry;
        },
        io: inMemoryIo().io,
      },
      async () => "still-ok",
    );
    assert.equal(value, "still-ok");
    assert.ok(summary);
    assert.equal(summary.status, "recorder-failure");
    assert.match(String(summary.reason), /target was not found/);
  });
});

test("recorder failure：startScreencast 报错仍执行业务并暴露摘要", async () => {
  await withHttpTargets([target()], async (endpoint) => {
    let summary: ProcessReplaySummary | undefined;
    const value = await BusinessSetProcessReplay.run(
      {
        endpoint,
        outputDirectory: "/replay/start-error",
        onSummary: (entry) => {
          summary = entry;
        },
        webSocketFactory: (url) =>
          new FakeWebSocket(url, (message) => {
            if (message.method === "Page.startScreencast") {
              return {
                id: message.id,
                error: { code: -32601, message: "startScreencast disabled" },
              };
            }
            return { id: message.id, result: {} };
          }),
        io: inMemoryIo().io,
      },
      async () => "business-ran",
    );
    assert.equal(value, "business-ran");
    assert.ok(summary);
    assert.equal(summary.status, "recorder-failure");
    assert.match(String(summary.reason), /startScreencast disabled/);
  });
});

test("有界队列：同步突发超过队列上限时丢弃并计数，不回压业务", async () => {
  await withHttpTargets([target()], async (endpoint) => {
    const { files, io } = inMemoryIo();
    let summary: ProcessReplaySummary | undefined;
    const value = await BusinessSetProcessReplay.run(
      {
        endpoint,
        outputDirectory: "/replay/bounds",
        limits: { maxQueuedFrames: 2 },
        onSummary: (entry) => {
          summary = entry;
        },
        webSocketFactory: (url) => {
          const socket = new FakeWebSocket(url, (message) => {
            if (message.method === "Page.startScreencast") {
              // 同步突发 6 帧：pump 在当前同步块结束后才开始消费。
              for (let index = 1; index <= 6; index++) {
                socket.emitMessage(jpegFrame(index, 2_000 + index));
              }
              return { id: message.id, result: {} };
            }
            return { id: message.id, result: {} };
          });
          return socket;
        },
        io,
      },
      async () => "business-ran",
    );
    assert.equal(value, "business-ran");
    assert.ok(summary);
    assert.equal(summary.status, "completed");
    assert.equal(summary.framesReceived, 6);
    assert.equal(summary.framesDropped, 4);
    assert.equal(summary.framesWritten, 2);
    const capture = JSON.parse(
      replayFile(files, "/replay/bounds/capture.json").toString(),
    );
    assert.equal(capture.frames.length, 2);
  });
});

test("截断：总字节预算耗尽后停止落盘并标记 truncated", async () => {
  await withHttpTargets([target()], async (endpoint) => {
    const { files, io } = inMemoryIo();
    let summary: ProcessReplaySummary | undefined;
    await BusinessSetProcessReplay.run(
      {
        endpoint,
        outputDirectory: "/replay/truncate",
        limits: { maxTotalBytes: 18 },
        onSummary: (entry) => {
          summary = entry;
        },
        webSocketFactory: (url) => {
          const socket = new FakeWebSocket(url, (message) => {
            if (message.method === "Page.startScreencast") {
              for (let index = 1; index <= 5; index++) {
                queueMicrotask(() =>
                  socket.emitMessage(jpegFrame(index, 3_000 + index)),
                );
              }
              return { id: message.id, result: {} };
            }
            return { id: message.id, result: {} };
          });
          return socket;
        },
        io,
      },
      async () => {},
    );
    assert.ok(summary);
    assert.equal(summary.status, "recorder-failure");
    assert.equal(summary.truncated, true);
    assert.equal(summary.framesReceived, 5);
    assert.equal(summary.framesWritten, 1);
    assert.match(String(summary.reason), /byte budget/);
    const capture = JSON.parse(
      replayFile(files, "/replay/truncate/capture.json").toString(),
    );
    assert.equal(capture.frames.length, 1);
  });
});

test("超尺寸帧按单帧预算跳过并计数", async () => {
  await withHttpTargets([target()], async (endpoint) => {
    let summary: ProcessReplaySummary | undefined;
    await BusinessSetProcessReplay.run(
      {
        endpoint,
        outputDirectory: "/replay/oversize",
        limits: { maxFrameBytes: 2 },
        onSummary: (entry) => {
          summary = entry;
        },
        webSocketFactory: (url) =>
          new FakeWebSocket(url, (message, socket) =>
            respondingSocketHandler(message, socket, {
              frames: [jpegFrame(1, 4_000)],
            }),
          ),
        io: inMemoryIo().io,
      },
      async () => {},
    );
    assert.ok(summary);
    assert.equal(summary.framesReceived, 1);
    assert.equal(summary.framesSkipped, 1);
    assert.equal(summary.framesWritten, 0);
  });
});

test("窗口表面瞬态发出的极小退化帧被跳过并计数", async () => {
  const tinyJpegBase64 =
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCAAMAAwDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCVAHVmf//Z";
  await withHttpTargets([target()], async (endpoint) => {
    let summary: ProcessReplaySummary | undefined;
    await BusinessSetProcessReplay.run(
      {
        endpoint,
        outputDirectory: "/replay/degenerate",
        onSummary: (entry) => {
          summary = entry;
        },
        webSocketFactory: (url) =>
          new FakeWebSocket(url, (message, socket) =>
            respondingSocketHandler(message, socket, {
              frames: [
                {
                  method: "Page.screencastFrame",
                  params: {
                    data: tinyJpegBase64,
                    metadata: { timestamp: 4_300 },
                    sessionId: 1,
                  },
                },
              ],
            }),
          ),
        io: inMemoryIo().io,
      },
      async () => {},
    );
    assert.ok(summary);
    assert.equal(summary.framesReceived, 1);
    assert.equal(summary.framesSkipped, 1);
    assert.equal(summary.framesWritten, 0);
  });
});

test("stopScreencast 在途尾帧仍被写入并计数", async () => {
  await withHttpTargets([target()], async (endpoint) => {
    const { files, io } = inMemoryIo();
    let summary: ProcessReplaySummary | undefined;
    await BusinessSetProcessReplay.run(
      {
        endpoint,
        outputDirectory: "/replay/tail-frame",
        onSummary: (entry) => {
          summary = entry;
        },
        webSocketFactory: (url) =>
          new FakeWebSocket(url, (message, socket) => {
            if (message.method === "Page.startScreencast") {
              queueMicrotask(() => socket.emitMessage(jpegFrame(1, 4_100)));
              return { id: message.id, result: {} };
            }
            if (message.method === "Page.stopScreencast") {
              // 模拟已在途的尾帧：晚于 stop 到达的事件流。
              queueMicrotask(() => socket.emitMessage(jpegFrame(2, 4_200)));
              return { id: message.id, result: {} };
            }
            return { id: message.id, result: {} };
          }),
        io,
      },
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      },
    );
    assert.ok(summary);
    assert.equal(summary.framesReceived, 2);
    assert.equal(summary.framesWritten, 2);
    assert.equal(summary.framesDropped, 0);
    assert.equal(summary.framesSkipped, 0);
    const capture = JSON.parse(
      replayFile(files, "/replay/tail-frame/capture.json").toString(),
    );
    assert.equal(capture.frames.length, 2);
  });
});

test("渲染播放器输出可被独立复现（临时目录全量校验）", async () => {
  const root = mkdtempSync(join(tmpdir(), "vem-process-replay-player-"));
  await withHttpTargets([target()], async (endpoint) => {
    await BusinessSetProcessReplay.run(
      {
        endpoint,
        outputDirectory: root,
        webSocketFactory: (url) =>
          new FakeWebSocket(url, (message, socket) =>
            respondingSocketHandler(message, socket, {
              frames: [jpegFrame(1, 5_000.5)],
            }),
          ),
      },
      async () => {},
    );
    const player = readFileSync(join(root, "player.html"), "utf8");
    assert.match(player, /VEM 业务过程回放/);
    assert.match(player, /frames\/000001\.jpg/);
    assert.equal(
      readFileSync(join(root, "frames", "000001.jpg"), "utf8"),
      "jpeg-frame-1",
    );
  });
});
