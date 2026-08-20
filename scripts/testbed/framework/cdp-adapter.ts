import { createHash } from "node:crypto";

import type { CommandResult, TestAdapter } from "./test-adapter.ts";

import { visionV2CapturedFrameSchema } from "../../../packages/shared/src/schemas/vision-v2.ts";
import { isStructurallyValidPng } from "../../lib/png-structure.mjs";
import {
  CdpClient,
  activateVisibleSelector,
  enablePageRuntime,
  evaluateExpression,
  rewriteWebSocketDebuggerUrl,
} from "../machine-ui-cdp-driver.ts";

interface CdpTarget {
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}

interface RuntimeRole {
  name: string;
  pid: number | null;
  ready: boolean;
}

type TryOnProtocolEvent = {
  type: string;
  payload: {
    attemptId: string;
    captured?: {
      reference?: string;
    };
  };
};

type CapturedFrameResource = {
  reference: string;
  finalUrl: string | null;
  ok: boolean;
  httpStatus: number | null;
  contentType: string | null;
  byteSize: number;
  digest: string | null;
  width: number | null;
  height: number | null;
};

export function isControlledCapturedFrameReference(
  reference: unknown,
): reference is string {
  return (
    typeof reference === "string" &&
    visionV2CapturedFrameSchema.shape.reference.safeParse(reference).success
  );
}

const STATE_EXPRESSION = `(() => {
  const view = document.querySelector("[data-test='try-on-view']");
  const preview = document.querySelector("[data-test='try-on-acquisition-preview']");
  const result = document.querySelector("[data-test='try-on-result-image']");
  const scale = document.querySelector("[data-test='try-on-scale-value']");
  const detail = document.querySelector("[data-test='product-detail-page']");
  const buy = document.querySelector("[data-test='product-buy']");
  const tryOn = document.querySelector("[data-test='try-on']");
  const guidance = document.querySelector("[data-test='try-on-guidance']");
  const manual = document.querySelector("[data-test='try-on-manual-capture']");
  const phase = document.querySelector("[data-test='try-on-phase']");
  return JSON.stringify({
    route: location.hash,
    state: view?.dataset?.state ?? null,
    attemptId: view?.dataset?.attemptId ?? null,
    preview: {
      naturalWidth: Number(preview?.naturalWidth ?? 0),
      naturalHeight: Number(preview?.naturalHeight ?? 0),
    },
    resultUrl: result?.getAttribute("src") ?? null,
    scaleValue: scale?.textContent?.trim() ?? null,
    tryOnPresent: detail
      ? Boolean(tryOn instanceof HTMLElement)
      : null,
    buyDisabled: buy instanceof HTMLButtonElement ? buy.disabled : null,
    guidance: view?.dataset?.state === "acquiring"
      ? guidance?.textContent?.trim() ?? null
      : null,
    phaseText: phase?.textContent?.trim() ?? null,
    manualCaptureAllowed:
      manual instanceof HTMLButtonElement ? manual.disabled === false : null,
  });
})()`;

/**
 * 真实 VM 适配器：把 CDP 页面状态读取与触摸点击映射为 testAdapter 接口。
 * 与本地 fake 实现同一契约，visionExperience 切片代码无需区分环境。
 */
export class CdpTestAdapter implements TestAdapter {
  endpoint: string;
  visionBaseUrl: string;
  client: CdpClient | null = null;
  tryOnProtocolEvents: TryOnProtocolEvent[] = [];
  capturedFrameResources = new Map<string, Promise<CapturedFrameResource>>();
  stopTryOnProtocolObserver: (() => void) | null = null;

  constructor({
    endpoint = process.env.CDP_ENDPOINT ?? "http://127.0.0.1:19222",
    visionBaseUrl = process.env.VISION_BASE_URL ?? "http://127.0.0.1:27892",
  }: { endpoint?: string; visionBaseUrl?: string } = {}) {
    this.endpoint = endpoint;
    this.visionBaseUrl = visionBaseUrl;
  }

  async connect({
    timeoutMs = 15_000,
  }: { timeoutMs?: number } = {}): Promise<this> {
    const deadline = Date.now() + timeoutMs;
    let target: CdpTarget | undefined;
    while (Date.now() < deadline && !target) {
      const targets = (await (
        await fetch(`${this.endpoint}/json`)
      ).json()) as CdpTarget[];
      target = targets.find(
        (candidate) =>
          candidate.type === "page" &&
          candidate.url.includes("tauri.localhost"),
      );
      if (!target) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
      }
    }
    if (!target) {
      throw new Error("Machine UI CDP target was not found");
    }
    this.client = new CdpClient(
      rewriteWebSocketDebuggerUrl(target.webSocketDebuggerUrl, this.endpoint),
    );
    await this.client.connect({ timeoutMs });
    await enablePageRuntime(this.client);
    await this.client.send("Network.enable");
    this.stopTryOnProtocolObserver = this.client.on(
      "Network.webSocketFrameReceived",
      (event: unknown) => {
        const payloadData = (
          event as { response?: { payloadData?: unknown } } | null
        )?.response?.payloadData;
        if (typeof payloadData !== "string") return;
        try {
          const message = JSON.parse(payloadData) as {
            protocol?: unknown;
            type?: unknown;
            payload?: unknown;
          };
          const payload = message.payload as { attemptId?: unknown } | null;
          if (
            message.protocol !== "vem.vision.v2" ||
            typeof message.type !== "string" ||
            !/^vision[.]try_on[.]attempt[.](?:accepted|acquiring|captured|generating|completed|failed|canceled)$/.test(
              message.type,
            ) ||
            !payload ||
            typeof payload.attemptId !== "string"
          ) {
            return;
          }
          this.tryOnProtocolEvents.push({
            type: message.type,
            payload: structuredClone(payload) as TryOnProtocolEvent["payload"],
          });
          if (this.tryOnProtocolEvents.length > 256) {
            this.tryOnProtocolEvents.splice(
              0,
              this.tryOnProtocolEvents.length - 256,
            );
          }
        } catch {
          // Unrelated or malformed WebSocket frames cannot alter acceptance
          // evidence. The strict Machine adapter separately rejects them.
        }
      },
    );
    return this;
  }

  async readFile(path: string): Promise<string> {
    if (path !== "ui/try-on-state.json") {
      throw new Error(`unknown adapter file: ${path}`);
    }
    const state = JSON.parse(
      await evaluateExpression(this.client!, STATE_EXPRESSION),
    ) as { attemptId?: string | null };
    const protocolTimeline =
      typeof state.attemptId === "string"
        ? this.tryOnProtocolEvents.filter(
            (event) => event.payload.attemptId === state.attemptId,
          )
        : [];
    const captured = protocolTimeline.find(
      (event) => event.type === "vision.try_on.attempt.captured",
    )?.payload.captured;
    const capturedResource = isControlledCapturedFrameReference(
      captured?.reference,
    )
      ? await this.readCapturedFrameResource(captured.reference)
      : null;
    return JSON.stringify({ ...state, protocolTimeline, capturedResource });
  }

  async writeFile(): Promise<never> {
    throw new Error("CDP adapter does not support remote file writes");
  }

  async run(command: string, args: string[] = []): Promise<CommandResult> {
    if (command === "navigate") {
      const hash = args[0];
      if (typeof hash !== "string" || hash.length === 0) {
        throw new Error("navigate requires a hash argument");
      }
      await evaluateExpression(
        this.client!,
        `location.hash = ${JSON.stringify(hash)}; true`,
      );
      return { exitCode: 0, stdout: "navigated", stderr: "" };
    }
    if (command === "click") {
      const selector = args[0];
      if (typeof selector !== "string" || selector.length === 0) {
        throw new Error("click requires a selector argument");
      }
      await activateVisibleSelector(this.client!, selector, {
        kind: "mouse",
        timeoutMs: 15_000,
        pollMs: 100,
      });
      return { exitCode: 0, stdout: "clicked", stderr: "" };
    }
    if (command === "stop-vision-role") {
      const roleIndex = args.indexOf("--role");
      const role = roleIndex >= 0 ? args[roleIndex + 1] : args[0];
      if (typeof role !== "string" || role.length === 0) {
        throw new Error("stop-vision-role requires a role argument");
      }
      const response = await fetch(
        `${this.visionBaseUrl}/v2/runtime/roles/${encodeURIComponent(role)}/stop`,
        { method: "POST" },
      );
      if (!response.ok) {
        return { exitCode: 1, stdout: "", stderr: await response.text() };
      }
      return { exitCode: 0, stdout: "stopped", stderr: "" };
    }
    if (command === "probe-vision-role") {
      const role = args[0];
      const response = await fetch(`${this.visionBaseUrl}/v2/runtime/roles`);
      if (!response.ok) {
        return { exitCode: 1, stdout: "", stderr: await response.text() };
      }
      const payload = (await response.json()) as { roles?: RuntimeRole[] };
      const declared = (payload.roles ?? []).find(
        (entry) => entry.name === role,
      );
      const dead =
        !declared || declared.pid === null || declared.ready === false;
      return {
        exitCode: dead ? 0 : 1,
        stdout: dead ? "dead" : "alive",
        stderr: "",
      };
    }
    if (command === "vision-ready") {
      let response;
      try {
        response = await fetch(`${this.visionBaseUrl}/v2/runtime/roles`);
      } catch {
        return { exitCode: 1, stdout: "unreachable", stderr: "" };
      }
      if (!response.ok) {
        return { exitCode: 1, stdout: "", stderr: await response.text() };
      }
      const payload = (await response.json()) as { roles?: RuntimeRole[] };
      const ready = (payload.roles ?? []).every(
        (entry) => entry?.ready === true && entry?.pid !== null,
      );
      const pids = (payload.roles ?? [])
        .filter((entry) => entry?.pid !== null)
        .map((entry) => entry.pid);
      return {
        exitCode: ready ? 0 : 1,
        stdout: JSON.stringify({ ready, pids }),
        stderr: "",
      };
    }
    throw new Error(`CDP adapter does not implement command: ${command}`);
  }

  async close(): Promise<void> {
    this.stopTryOnProtocolObserver?.();
    this.stopTryOnProtocolObserver = null;
    this.tryOnProtocolEvents = [];
    this.capturedFrameResources.clear();
    await this.client?.close().catch(() => {});
    this.client = null;
  }

  private async readCapturedFrameResource(
    reference: string,
  ): Promise<CapturedFrameResource> {
    let resource = this.capturedFrameResources.get(reference);
    if (!resource) {
      resource = inspectCapturedFrameResource(reference);
      this.capturedFrameResources.set(reference, resource);
    }
    return await resource;
  }
}

async function inspectCapturedFrameResource(
  reference: string,
): Promise<CapturedFrameResource> {
  try {
    const response = await fetch(reference);
    const bytes = Buffer.from(await response.arrayBuffer());
    const dimensions = pngDimensions(bytes);
    return {
      reference,
      finalUrl: response.url,
      ok: response.ok,
      httpStatus: response.status,
      contentType:
        response.headers.get("content-type")?.split(";", 1)[0] ?? null,
      byteSize: bytes.byteLength,
      digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      width: dimensions?.width ?? null,
      height: dimensions?.height ?? null,
    };
  } catch {
    return {
      reference,
      finalUrl: null,
      ok: false,
      httpStatus: null,
      contentType: null,
      byteSize: 0,
      digest: null,
      width: null,
      height: null,
    };
  }
}

function pngDimensions(
  bytes: Buffer,
): { width: number; height: number } | null {
  if (!isStructurallyValidPng(bytes)) return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}
