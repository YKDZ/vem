import {
  CdpClient,
  activateVisibleSelector,
  discoverMachineUiTarget,
  enablePageRuntime,
  evaluateExpression,
  rewriteWebSocketDebuggerUrl,
} from "../machine-ui-cdp-driver.mjs";

const STATE_EXPRESSION = `(() => {
  const view = document.querySelector("[data-test='try-on-view']");
  const preview = document.querySelector("[data-test='try-on-acquisition-preview']");
  const result = document.querySelector("[data-test='try-on-result-image']");
  return JSON.stringify({
    route: location.hash,
    state: view?.dataset?.state ?? null,
    preview: {
      naturalWidth: Number(preview?.naturalWidth ?? 0),
      naturalHeight: Number(preview?.naturalHeight ?? 0),
    },
    resultUrl: result?.getAttribute("src") ?? null,
  });
})()`;

/**
 * 真实 VM 适配器：把 CDP 页面状态读取与触摸点击映射为 testAdapter 接口。
 * 与本地 fake 实现同一契约，visionExperience 切片代码无需区分环境。
 */
export class CdpTestAdapter {
  constructor({ endpoint = process.env.CDP_ENDPOINT ?? "http://127.0.0.1:19222" } = {}) {
    this.endpoint = endpoint;
    this.client = null;
  }

  async connect({ timeoutMs = 15_000 } = {}) {
    const target = await discoverMachineUiTarget({
      endpoint: this.endpoint,
      timeoutMs,
    });
    this.client = new CdpClient(
      rewriteWebSocketDebuggerUrl(target.webSocketDebuggerUrl, this.endpoint),
    );
    await this.client.connect({ timeoutMs });
    await enablePageRuntime(this.client);
    return this;
  }

  async readFile(path) {
    if (path !== "ui/try-on-state.json") {
      throw new Error(`unknown adapter file: ${path}`);
    }
    return await evaluateExpression(this.client, STATE_EXPRESSION);
  }

  async writeFile() {
    throw new Error("CDP adapter does not support remote file writes");
  }

  async run(command, args = []) {
    if (command === "navigate") {
      const hash = args[0];
      if (typeof hash !== "string" || hash.length === 0) {
        throw new Error("navigate requires a hash argument");
      }
      await evaluateExpression(
        this.client,
        `location.hash = ${JSON.stringify(hash)}; true`,
      );
      return { exitCode: 0, stdout: "navigated", stderr: "" };
    }
    if (command === "click") {
      const selector = args[0];
      if (typeof selector !== "string" || selector.length === 0) {
        throw new Error("click requires a selector argument");
      }
      await activateVisibleSelector(this.client, selector, {
        kind: "mouse",
        timeoutMs: 15_000,
        pollMs: 100,
      });
      return { exitCode: 0, stdout: "clicked", stderr: "" };
    }
    throw new Error(`CDP adapter does not implement command: ${command}`);
  }

  async close() {
    await this.client?.close().catch(() => {});
    this.client = null;
  }
}
