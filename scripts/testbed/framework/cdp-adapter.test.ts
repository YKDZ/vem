import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { describe, it } from "node:test";

import {
  CapturedFrameEvidenceCache,
  CdpTestAdapter,
  hashPreviewScreenshot,
  isControlledCapturedFrameReference,
  readResultPngResource,
  readSourceGarmentPngResource,
  VisionProtocolEvidenceCollector,
} from "./cdp-adapter.ts";
import {
  isSourceGarmentAttemptBound,
  parseSourceGarmentMetadata,
} from "./slices/vision-experience/source-garment-evidence.ts";
import { assertAdapterContract } from "./test-adapter.ts";

describe("CDP test adapter", () => {
  it("以 CDP 截图哈希跨源 preview，canvas 受 CORS 限制时也不会静态假绿", () => {
    const frameA = Buffer.from("cross-origin-preview-a").toString("base64");
    const frameB = Buffer.from("cross-origin-preview-b").toString("base64");
    assert.notEqual(
      hashPreviewScreenshot(frameA),
      hashPreviewScreenshot(frameB),
    );
    assert.throws(() => hashPreviewScreenshot("not-base64!"), /预览截图/);
  });

  it("implements the shared adapter contract", () => {
    const adapter = new CdpTestAdapter({ endpoint: "http://127.0.0.1:1" });
    assertAdapterContract(adapter);
    assert.equal(typeof adapter.connect, "function");
    assert.equal(typeof adapter.close, "function");
  });

  it("通过公开 click command 经真实 CdpClient 发出 touch CDP 输入", async () => {
    const dispatched: { method: string; type?: string }[] = [];
    const fakeCdp = createFakeCdpWebSocketFactory((message) => {
      if (message.method === "Runtime.evaluate") {
        return {
          id: message.id,
          result: {
            result: {
              value: {
                exists: true,
                actionable: true,
                inViewport: true,
                pointerEvents: "auto",
                hitTarget: true,
                center: { x: 120, y: 240 },
                bounds: { x: 100, y: 220, width: 40, height: 40 },
              },
            },
          },
        };
      }
      if (message.method.startsWith("Input.")) {
        dispatched.push({ method: message.method, type: message.params.type });
      }
      return { id: message.id, result: {} };
    });
    const endpoint = await startFakeCdpEndpoint();
    const adapter = new CdpTestAdapter({
      endpoint: endpoint.url,
      cdpWebSocketFactory: fakeCdp.factory,
    });
    try {
      await adapter.connect();
      await adapter.run("click", ['[data-test="try-on"]']);
      assert.deepEqual(dispatched, [
        { method: "Input.dispatchTouchEvent", type: "touchStart" },
        { method: "Input.dispatchTouchEvent", type: "touchEnd" },
      ]);
    } finally {
      await adapter.close();
      await endpoint.close();
    }
  });

  it("通过公开 restore command 恰调用一次注入实现并透传结果", async () => {
    let calls = 0;
    const expected = {
      exitCode: 1,
      stdout: "restore output",
      stderr: "restore error",
    };
    const adapter = new CdpTestAdapter({
      endpoint: "http://127.0.0.1:1",
      restoreRecordedVideoFixturesImpl: () => {
        calls += 1;
        return expected;
      },
    });

    assert.deepEqual(
      await adapter.run("restore-recorded-video-fixtures"),
      expected,
    );
    assert.equal(calls, 1);
  });

  it("采集有界失败诊断且不保留 HTTP 头与正文", async () => {
    const stops: string[] = [];
    const server = createServer((request, response) => {
      stops.push(request.url ?? "");
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          roles: [
            { name: "api", pid: 4100, ready: true, token: "role-secret" },
          ],
        }),
      );
    });
    await new Promise<void>((resolvePromise) =>
      server.listen(0, "127.0.0.1", () => resolvePromise()),
    );
    server.unref();
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("test server did not bind");
    }
    const screenshot = readFileSync(
      new URL("../../../apps/machine/src-tauri/app-icon.png", import.meta.url),
    );
    const dom = {
      route: "#/products/product:1",
      state: null,
      attemptId: null,
      preview: { naturalWidth: 0, naturalHeight: 0 },
      resultUrl: null,
    };
    const adapter = new CdpTestAdapter({
      visionBaseUrl: `http://127.0.0.1:${address.port}`,
      selectRecordedVideoFixtureImpl: () => ({
        exitCode: 1,
        stdout: "restart began",
        stderr: "Authorization: Bearer fixture-secret\nowner exited",
      }),
    });
    (adapter as any).client = {
      async send(method: string, params: { expression?: string } = {}) {
        if (method === "Runtime.evaluate") {
          if (
            params.expression?.includes(
              "__VEM_MACHINE_RUNTIME_TRACE_SNAPSHOT__",
            )
          ) {
            return {
              result: {
                value: {
                  runtimeGenerationId: "runtime-1",
                  entries: [{ kind: "navigation", route: dom.route }],
                },
              },
            };
          }
          return { result: { value: JSON.stringify(dom) } };
        }
        if (method === "Page.captureScreenshot") {
          return { data: screenshot.toString("base64") };
        }
        throw new Error(`unexpected CDP method: ${method}`);
      },
    };
    adapter.observeDiagnosticEvent("Runtime.consoleAPICalled", {
      type: "error",
      args: [
        {
          type: "string",
          value:
            "token=console-secret Bearer standalone-console-secret crashed",
        },
      ],
    });
    adapter.observeDiagnosticEvent("Runtime.exceptionThrown", {
      exceptionDetails: {
        text: "uncaught",
        exception: { description: "password=exception-secret" },
      },
    });
    adapter.observeDiagnosticEvent("Network.responseReceived", {
      requestId: "request-1",
      type: "Fetch",
      response: {
        url: "http://127.0.0.1/fail?token=network-secret",
        status: 503,
        headers: { Authorization: "Bearer header-secret" },
        body: "response-body-secret",
      },
    });
    await adapter.readFile("ui/try-on-state.json");
    await adapter.run("select-recorded-video-fixture", ["far"]);
    adapter.recordMilestone("object-redaction", "failed", {
      token: "object-secret",
      password: "object-password",
      apiKey: "object-api-key",
      privateKeyPem: "object-private-key",
      databaseUrl: "postgres://object-user:object-password@db/test",
    });
    const failure = await adapter.captureFailureEvidence(
      new Error(
        "try-on-route timed out; token=error-secret dsn=postgres://dsn-user:dsn-password@db/test",
      ),
    );
    const serialized = JSON.stringify(failure.diagnostics);
    assert.equal(failure.diagnostics.lastDomState.route, dom.route);
    assert.equal(failure.diagnostics.lastDomState.attemptId, null);
    assert.deepEqual(failure.diagnostics.machineRuntimeTrace, [
      { kind: "navigation", route: dom.route },
    ]);
    assert.equal(failure.diagnostics.vision.listener.reachable, true);
    assert.deepEqual(failure.diagnostics.vision.roles, [
      { name: "api", pid: 4100, ready: true },
    ]);
    assert.match(serialized, /restart began/);
    assert.match(serialized, /owner exited/);
    assert.match(serialized, /\[REDACTED\]/);
    for (const secret of [
      "role-secret",
      "fixture-secret",
      "console-secret",
      "exception-secret",
      "network-secret",
      "header-secret",
      "response-body-secret",
      "error-secret",
      "standalone-console-secret",
      "object-secret",
      "object-password",
      "object-api-key",
      "object-private-key",
      "object-user",
      "dsn-user",
      "dsn-password",
    ]) {
      assert.doesNotMatch(serialized, new RegExp(secret));
    }
    assert.ok(failure.screenshotPng?.equals(screenshot));
    assert.deepEqual(stops, ["/v2/runtime/roles"]);
    await new Promise<void>((resolvePromise) =>
      server.close(() => resolvePromise()),
    );
  });

  it("把 ORB 图片失败关联到已净化的请求与响应且不泄漏凭据", async () => {
    const adapter = new CdpTestAdapter({
      visionBaseUrl: "http://127.0.0.1:1",
    });
    adapter.observeDiagnosticEvent("Network.requestWillBeSent", {
      requestId: "result-image",
      type: "Image",
      request: {
        url: "https://url-user:url-password@cdn.example.test/results/final.png?token=query-token&grant=query-grant&client_secret=query-secret#fragment-secret",
        headers: { Authorization: "Bearer request-header-secret" },
        postData: "request-body-secret",
      },
    });
    adapter.observeDiagnosticEvent("Network.responseReceived", {
      requestId: "result-image",
      type: "Image",
      response: {
        url: "https://url-user:url-password@cdn.example.test/results/final.png?token=query-token&grant=query-grant&client_secret=query-secret#fragment-secret",
        status: 404,
        mimeType: "application/json",
        headers: { Authorization: "Bearer response-header-secret" },
        body: "response-body-secret",
      },
    });
    adapter.observeDiagnosticEvent("Network.loadingFailed", {
      requestId: "result-image",
      type: "Image",
      errorText: "net::ERR_BLOCKED_BY_ORB",
      canceled: false,
    });

    const failure = await adapter.captureFailureEvidence(
      new Error("result image failed"),
    );
    const events = failure.diagnostics.cdp.networkErrors.map(
      ({ at: _at, ...event }: Record<string, unknown>) => event,
    );
    assert.deepEqual(events, [
      {
        kind: "httpError",
        requestId: "result-image",
        resourceType: "Image",
        url: "https://cdn.example.test/results/[REDACTED].png",
        status: 404,
        mimeType: "application/json",
      },
      {
        kind: "loadingFailed",
        requestId: "result-image",
        resourceType: "Image",
        errorText: "net::ERR_BLOCKED_BY_ORB",
        canceled: false,
        url: "https://cdn.example.test/results/[REDACTED].png",
        status: 404,
        mimeType: "application/json",
      },
    ]);
    const serialized = JSON.stringify(failure.diagnostics);
    for (const secret of [
      "url-user",
      "url-password",
      "query-token",
      "query-grant",
      "query-secret",
      "fragment-secret",
      "request-header-secret",
      "request-body-secret",
      "response-header-secret",
      "response-body-secret",
    ]) {
      assert.doesNotMatch(serialized, new RegExp(secret));
    }
  });

  it("为成功的图片响应保留有界状态与 MIME 支持证据", async () => {
    const adapter = new CdpTestAdapter({
      visionBaseUrl: "http://127.0.0.1:1",
    });
    adapter.observeDiagnosticEvent("Network.requestWillBeSent", {
      requestId: "successful-image",
      type: "Image",
      request: {
        url: "https://cdn.example.test/results/success.png?token=success-token",
      },
    });
    adapter.observeDiagnosticEvent("Network.responseReceived", {
      requestId: "successful-image",
      type: "Image",
      response: {
        url: "https://cdn.example.test/results/success.png?token=success-token",
        status: 200,
        mimeType: "image/png",
      },
    });

    const failure = await adapter.captureFailureEvidence(
      new Error("later business assertion failed"),
    );
    const events = failure.diagnostics.cdp.networkErrors.map(
      ({ at: _at, ...event }: Record<string, unknown>) => event,
    );
    assert.deepEqual(events, [
      {
        kind: "imageResponse",
        requestId: "successful-image",
        resourceType: "Image",
        url: "https://cdn.example.test/results/[REDACTED].png",
        status: 200,
        mimeType: "image/png",
      },
    ]);
    assert.doesNotMatch(JSON.stringify(failure.diagnostics), /success-token/);
  });

  it("响应事件缺失时仍把加载失败关联到安全请求路径", async () => {
    const adapter = new CdpTestAdapter({
      visionBaseUrl: "http://127.0.0.1:1",
    });
    adapter.observeDiagnosticEvent("Network.requestWillBeSent", {
      requestId: "missing-response",
      type: "Image",
      request: {
        url: "https://cdn.example.test/results/missing.png?grant=missing-grant",
      },
    });
    adapter.observeDiagnosticEvent("Network.loadingFailed", {
      requestId: "missing-response",
      type: "Image",
      errorText: "net::ERR_CONNECTION_RESET",
    });

    const failure = await adapter.captureFailureEvidence(
      new Error("result image did not load"),
    );
    const event = failure.diagnostics.cdp.networkErrors.at(-1);
    assert.equal(event.url, "https://cdn.example.test/results/[REDACTED].png");
    assert.equal(event.status, null);
    assert.equal(event.mimeType, null);
    assert.doesNotMatch(JSON.stringify(failure.diagnostics), /missing-grant/);
  });

  it("按 requestId 隔离响应前后的 ExtraInfo 状态与 MIME", async () => {
    const adapter = new CdpTestAdapter({
      visionBaseUrl: "http://127.0.0.1:1",
    });
    for (const requestId of ["image-a", "image-b"]) {
      adapter.observeDiagnosticEvent("Network.requestWillBeSent", {
        requestId,
        type: "Image",
        request: { url: `https://cdn.example.test/results/${requestId}.png` },
      });
    }
    adapter.observeDiagnosticEvent("Network.responseReceivedExtraInfo", {
      requestId: "image-b",
      statusCode: 403,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: "Bearer extra-info-secret",
      },
    });
    adapter.observeDiagnosticEvent("Network.responseReceived", {
      requestId: "image-a",
      type: "Image",
      response: {
        status: 200,
        mimeType: "image/png",
      },
    });
    adapter.observeDiagnosticEvent("Network.responseReceivedExtraInfo", {
      requestId: "image-a",
      statusCode: 206,
      headers: { "content-type": "image/webp" },
    });
    for (const requestId of ["image-a", "image-b"]) {
      adapter.observeDiagnosticEvent("Network.loadingFailed", {
        requestId,
        type: "Image",
        errorText: "net::ERR_BLOCKED_BY_ORB",
      });
    }

    const failure = await adapter.captureFailureEvidence(
      new Error("two images failed"),
    );
    const failures = failure.diagnostics.cdp.networkErrors.filter(
      (event: { kind?: string }) => event.kind === "loadingFailed",
    );
    assert.deepEqual(
      failures.map(({ at: _at, ...event }: Record<string, unknown>) => event),
      [
        {
          kind: "loadingFailed",
          requestId: "image-a",
          resourceType: "Image",
          errorText: "net::ERR_BLOCKED_BY_ORB",
          canceled: false,
          url: "https://cdn.example.test/results/[REDACTED].png",
          status: 206,
          mimeType: "image/webp",
        },
        {
          kind: "loadingFailed",
          requestId: "image-b",
          resourceType: "Image",
          errorText: "net::ERR_BLOCKED_BY_ORB",
          canceled: false,
          url: "https://cdn.example.test/results/[REDACTED].png",
          status: 403,
          mimeType: "application/json",
        },
      ],
    );
    assert.doesNotMatch(
      JSON.stringify(failure.diagnostics),
      /extra-info-secret/,
    );
  });

  it("任意事件先后序都回填同 requestId 的加载失败诊断", async () => {
    const adapter = new CdpTestAdapter({
      visionBaseUrl: "http://127.0.0.1:1",
    });
    adapter.observeDiagnosticEvent("Network.responseReceivedExtraInfo", {
      requestId: "extra-first",
      statusCode: 404,
      headers: { "content-type": "application/json" },
    });
    adapter.observeDiagnosticEvent("Network.requestWillBeSent", {
      requestId: "extra-first",
      type: "Image",
      request: { url: "https://cdn.example.test/results/final.png" },
    });
    adapter.observeDiagnosticEvent("Network.responseReceived", {
      requestId: "extra-first",
      type: "Image",
      response: { status: 404, mimeType: "application/octet-stream" },
    });
    adapter.observeDiagnosticEvent("Network.loadingFailed", {
      requestId: "extra-first",
      type: "Image",
      errorText: "net::ERR_BLOCKED_BY_ORB",
    });

    adapter.observeDiagnosticEvent("Network.requestWillBeSent", {
      requestId: "extra-late",
      type: "Image",
      request: { url: "https://cdn.example.test/results/final.png" },
    });
    adapter.observeDiagnosticEvent("Network.responseReceived", {
      requestId: "extra-late",
      type: "Image",
      response: { status: 200, mimeType: "image/png" },
    });
    adapter.observeDiagnosticEvent("Network.loadingFailed", {
      requestId: "extra-late",
      type: "Image",
      errorText: "net::ERR_BLOCKED_BY_ORB",
    });
    adapter.observeDiagnosticEvent("Network.responseReceivedExtraInfo", {
      requestId: "extra-late",
      statusCode: 502,
      headers: { "content-type": "application/problem+json" },
    });

    adapter.observeDiagnosticEvent("Network.responseReceived", {
      requestId: "response-first",
      type: "Image",
      response: {
        url: "https://response.example.test/results/response.png",
        status: 418,
        mimeType: "application/problem+json",
      },
    });
    adapter.observeDiagnosticEvent("Network.requestWillBeSent", {
      requestId: "response-first",
      type: "Image",
      request: { url: "https://request.example.test/results/request.png" },
    });
    adapter.observeDiagnosticEvent("Network.loadingFailed", {
      requestId: "response-first",
      type: "Image",
      errorText: "net::ERR_BLOCKED_BY_ORB",
    });

    const failure = await adapter.captureFailureEvidence(
      new Error("out-of-order image failures"),
    );
    const extraLateDiagnostics = failure.diagnostics.cdp.networkErrors.filter(
      (event: { requestId?: string }) => event.requestId === "extra-late",
    );
    assert.deepEqual(
      extraLateDiagnostics.map(
        ({ at: _at, ...event }: Record<string, unknown>) => event,
      ),
      [
        {
          kind: "httpError",
          requestId: "extra-late",
          resourceType: "Image",
          url: "https://cdn.example.test/results/[REDACTED].png",
          status: 502,
          mimeType: "application/problem+json",
        },
        {
          kind: "loadingFailed",
          requestId: "extra-late",
          resourceType: "Image",
          errorText: "net::ERR_BLOCKED_BY_ORB",
          canceled: false,
          url: "https://cdn.example.test/results/[REDACTED].png",
          status: 502,
          mimeType: "application/problem+json",
        },
      ],
    );
    const loadingFailures = failure.diagnostics.cdp.networkErrors.filter(
      (event: { kind?: string }) => event.kind === "loadingFailed",
    );
    assert.deepEqual(
      loadingFailures.map(
        ({ at: _at, ...event }: Record<string, unknown>) => event,
      ),
      [
        {
          kind: "loadingFailed",
          requestId: "extra-first",
          resourceType: "Image",
          errorText: "net::ERR_BLOCKED_BY_ORB",
          canceled: false,
          url: "https://cdn.example.test/results/[REDACTED].png",
          status: 404,
          mimeType: "application/json",
        },
        {
          kind: "loadingFailed",
          requestId: "extra-late",
          resourceType: "Image",
          errorText: "net::ERR_BLOCKED_BY_ORB",
          canceled: false,
          url: "https://cdn.example.test/results/[REDACTED].png",
          status: 502,
          mimeType: "application/problem+json",
        },
        {
          kind: "loadingFailed",
          requestId: "response-first",
          resourceType: "Image",
          errorText: "net::ERR_BLOCKED_BY_ORB",
          canceled: false,
          url: "https://response.example.test/results/[REDACTED].png",
          status: 418,
          mimeType: "application/problem+json",
        },
      ],
    );
  });

  it("迟到 ExtraInfo 把非图片 2xx 响应补记为 HTTP error", async () => {
    const adapter = new CdpTestAdapter({
      visionBaseUrl: "http://127.0.0.1:1",
    });
    adapter.observeDiagnosticEvent("Network.requestWillBeSent", {
      requestId: "late-fetch-error",
      type: "Fetch",
      request: { url: "https://api.example.test/api/results/data" },
    });
    adapter.observeDiagnosticEvent("Network.responseReceived", {
      requestId: "late-fetch-error",
      type: "Fetch",
      response: { status: 200, mimeType: "application/json" },
    });
    adapter.observeDiagnosticEvent("Network.loadingFailed", {
      requestId: "late-fetch-error",
      type: "Fetch",
      errorText: "net::ERR_FAILED",
    });
    adapter.observeDiagnosticEvent("Network.responseReceivedExtraInfo", {
      requestId: "late-fetch-error",
      statusCode: 503,
      headers: { "content-type": "application/problem+json" },
    });

    const failure = await adapter.captureFailureEvidence(
      new Error("fetch response failed"),
    );
    assert.deepEqual(
      failure.diagnostics.cdp.networkErrors.map(
        ({ at: _at, ...event }: Record<string, unknown>) => event,
      ),
      [
        {
          kind: "loadingFailed",
          requestId: "late-fetch-error",
          resourceType: "Fetch",
          errorText: "net::ERR_FAILED",
          canceled: false,
          url: "https://api.example.test/api/results/[REDACTED]",
          status: 503,
          mimeType: "application/problem+json",
        },
        {
          kind: "httpError",
          requestId: "late-fetch-error",
          resourceType: "Fetch",
          url: "https://api.example.test/api/results/[REDACTED]",
          status: 503,
          mimeType: "application/problem+json",
        },
      ],
    );
  });

  it("redirect 复用 requestId 时保留中间响应并重置到下一跳", async () => {
    const adapter = new CdpTestAdapter({
      visionBaseUrl: "http://127.0.0.1:1",
    });
    adapter.observeDiagnosticEvent("Network.requestWillBeSent", {
      requestId: "redirected-image",
      type: "Image",
      request: { url: "https://origin.example.test/results/final.png" },
    });
    adapter.observeDiagnosticEvent("Network.requestWillBeSent", {
      requestId: "redirected-image",
      type: "Image",
      redirectResponse: {
        url: "https://origin.example.test/results/final.png",
        status: 302,
        mimeType: "text/html",
      },
      request: { url: "https://cdn.example.test/images/final.png" },
    });
    adapter.observeDiagnosticEvent("Network.responseReceived", {
      requestId: "redirected-image",
      type: "Image",
      response: {
        url: "https://cdn.example.test/images/final.png",
        status: 200,
        mimeType: "image/png",
      },
    });
    adapter.observeDiagnosticEvent("Network.loadingFailed", {
      requestId: "redirected-image",
      type: "Image",
      errorText: "net::ERR_BLOCKED_BY_ORB",
    });

    const failure = await adapter.captureFailureEvidence(
      new Error("redirected image failed"),
    );
    assert.deepEqual(
      failure.diagnostics.cdp.networkErrors.map(
        ({ at: _at, ...event }: Record<string, unknown>) => event,
      ),
      [
        {
          kind: "imageResponse",
          requestId: "redirected-image",
          resourceType: "Image",
          url: "https://origin.example.test/results/[REDACTED].png",
          status: 302,
          mimeType: "text/html",
        },
        {
          kind: "imageResponse",
          requestId: "redirected-image",
          resourceType: "Image",
          url: "https://cdn.example.test/images/[REDACTED].png",
          status: 200,
          mimeType: "image/png",
        },
        {
          kind: "loadingFailed",
          requestId: "redirected-image",
          resourceType: "Image",
          errorText: "net::ERR_BLOCKED_BY_ORB",
          canceled: false,
          url: "https://cdn.example.test/images/[REDACTED].png",
          status: 200,
          mimeType: "image/png",
        },
      ],
    );
  });

  it("安全 URL 只保留 allowlist 路由形状与图片扩展类别", async () => {
    const adapter = new CdpTestAdapter({
      visionBaseUrl: "http://127.0.0.1:1",
    });
    const requests = [
      {
        requestId: "opaque-path",
        url: "https://url-user:url-password@cdn.example.test/results/opaque-credential/final.png?token=query-token#hash-secret",
      },
      {
        requestId: "jwt-path",
        url: "https://cdn.example.test/v2/try-on/results/eyJhbGciOiJIUzI1NiJ9.eyJhdHRlbXB0SWQiOiJzZWNyZXQifQ.signature",
      },
      {
        requestId: "uuid-path",
        url: "https://cdn.example.test/v2/try-on/results/550e8400-e29b-41d4-a716-446655440124",
      },
      {
        requestId: "hex-path",
        url: `https://cdn.example.test/assets/${"a1".repeat(32)}.png`,
      },
      {
        requestId: "base64-path",
        url: "https://cdn.example.test/images/c3VwZXItc2VjcmV0LWNyZWRlbnRpYWw.webp",
      },
    ];
    for (const request of requests) {
      adapter.observeDiagnosticEvent("Network.requestWillBeSent", {
        requestId: request.requestId,
        type: "Image",
        request: { url: request.url },
      });
      adapter.observeDiagnosticEvent("Network.loadingFailed", {
        requestId: request.requestId,
        type: "Image",
        errorText: "net::ERR_BLOCKED_BY_ORB",
      });
    }

    const failure = await adapter.captureFailureEvidence(
      new Error("unsafe paths failed"),
    );
    assert.deepEqual(
      failure.diagnostics.cdp.networkErrors.map(
        (event: { url?: unknown }) => event.url,
      ),
      [
        "https://cdn.example.test/results/[REDACTED]/[REDACTED].png",
        "https://cdn.example.test/v2/try-on/results/[REDACTED]",
        "https://cdn.example.test/v2/try-on/results/[REDACTED]",
        "https://cdn.example.test/assets/[REDACTED].png",
        "https://cdn.example.test/images/[REDACTED].webp",
      ],
    );
    const serialized = JSON.stringify(failure.diagnostics);
    for (const secret of [
      "url-user",
      "url-password",
      "opaque-credential",
      "query-token",
      "hash-secret",
      "eyJhbGciOiJIUzI1NiJ9",
      "550e8400-e29b-41d4-a716-446655440124",
      "a1".repeat(32),
      "c3VwZXItc2VjcmV0LWNyZWRlbnRpYWw",
    ]) {
      assert.doesNotMatch(serialized, new RegExp(secret));
    }
    assert.match(serialized, /\/v2\/try-on\/results\/\[REDACTED\]/);
    assert.match(serialized, /\[REDACTED\][.]png/);
  });

  it("对网络关联与诊断设置硬上限并在关闭时清空", async () => {
    const adapter = new CdpTestAdapter({
      visionBaseUrl: "http://127.0.0.1:1",
    });
    for (let index = 0; index < 129; index += 1) {
      adapter.observeDiagnosticEvent("Network.requestWillBeSent", {
        requestId: `bounded-request-${index}`,
        type: "Image",
        request: {
          url: `https://cdn.example.test/results/bounded-${index}.png`,
        },
      });
    }
    adapter.observeDiagnosticEvent("Network.loadingFailed", {
      requestId: "bounded-request-0",
      type: "Image",
      errorText: "net::ERR_FAILED",
    });
    adapter.observeDiagnosticEvent("Network.loadingFailed", {
      requestId: "bounded-request-128",
      type: "Image",
      errorText: "net::ERR_FAILED",
    });
    const correlated = await adapter.captureFailureEvidence(
      new Error("bounded correlation"),
    );
    assert.equal(correlated.diagnostics.cdp.networkErrors[0].url, null);
    assert.equal(
      correlated.diagnostics.cdp.networkErrors[1].url,
      "https://cdn.example.test/results/[REDACTED].png",
    );

    for (let index = 0; index < 129; index += 1) {
      adapter.observeDiagnosticEvent("Network.loadingFailed", {
        requestId: `bounded-failure-${index}`,
        type: "Image",
        errorText: "net::ERR_FAILED",
      });
    }
    const bounded = await adapter.captureFailureEvidence(
      new Error("bounded diagnostics"),
    );
    assert.equal(bounded.diagnostics.cdp.networkErrors.length, 128);
    assert.equal(
      bounded.diagnostics.cdp.networkErrors[0].requestId,
      "bounded-failure-1",
    );
    assert.equal(
      bounded.diagnostics.cdp.networkErrors.at(-1).requestId,
      "bounded-failure-128",
    );

    adapter.observeDiagnosticEvent("Network.requestWillBeSent", {
      requestId: "cleared-on-close",
      type: "Image",
      request: { url: "https://cdn.example.test/results/cleared.png" },
    });
    await adapter.close();
    adapter.observeDiagnosticEvent("Network.loadingFailed", {
      requestId: "cleared-on-close",
      type: "Image",
      errorText: "net::ERR_FAILED",
    });
    const failure = await adapter.captureFailureEvidence(
      new Error("after close"),
    );
    assert.equal(failure.diagnostics.cdp.networkErrors.length, 1);
    assert.equal(failure.diagnostics.cdp.networkErrors[0].url, null);
  });

  it("公开角色集合为空时不得报告 Vision 就绪", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ roles: [] }));
    });
    await new Promise<void>((resolvePromise) =>
      server.listen(0, "127.0.0.1", () => resolvePromise()),
    );
    server.unref();
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("test server did not bind");
    }
    try {
      const adapter = new CdpTestAdapter({
        visionBaseUrl: `http://127.0.0.1:${address.port}`,
      });
      const result = await adapter.run("vision-ready");
      assert.equal(result.exitCode, 1);
      assert.deepEqual(JSON.parse(result.stdout), { ready: false, pids: [] });
    } finally {
      await new Promise<void>((resolvePromise) =>
        server.close(() => resolvePromise()),
      );
    }
  });

  it("失败截图超过证据上限时不返回可落盘字节", async () => {
    const oversizedScreenshot = Buffer.alloc(2 * 1024 * 1024 + 1, 1);
    const adapter = new CdpTestAdapter({
      visionBaseUrl: "http://127.0.0.1:1",
    });
    (adapter as any).client = {
      async send(method: string, params: { expression?: string } = {}) {
        if (method === "Runtime.evaluate") {
          const value = params.expression?.includes(
            "__VEM_MACHINE_RUNTIME_TRACE_SNAPSHOT__",
          )
            ? { entries: [] }
            : JSON.stringify({
                route: "#/try-on",
                state: "starting",
                attemptId: "attempt-1",
              });
          return { result: { value } };
        }
        if (method === "Page.captureScreenshot") {
          return { data: oversizedScreenshot.toString("base64") };
        }
        throw new Error(`unexpected CDP method: ${method}`);
      },
    };
    const failure = await adapter.captureFailureEvidence(
      new Error("result-surface timed out"),
    );
    assert.equal(failure.screenshotPng, null);
    assert.ok(
      failure.diagnostics.milestones.some(
        (entry: { stage?: string; status?: string }) =>
          entry.stage === "failure-screenshot" && entry.status === "failed",
      ),
    );
  });

  it("拒绝超出响应、像素与解压上限的 result PNG", async () => {
    const reference = "http://127.0.0.1:27892/v2/try-on/results/x?token=t";
    const oversized = Buffer.alloc(8 * 1024 * 1024 + 1);
    const rejected = await readResultPngResource({
      reference,
      visionOrigin: "http://127.0.0.1:27892",
      fetchImpl: async () =>
        ({
          ok: true,
          status: 200,
          url: reference,
          headers: new Headers({
            "content-type": "image/png",
            "content-length": String(oversized.length),
          }),
          arrayBuffer: async () => oversized,
        }) as Response,
    });
    assert.equal(rejected, null);
  });

  it("将 source garment 限为本次 Service API 的精确资产 URL，拒绝外域、重定向和篡改字节", async () => {
    const assetId = "550e8400-e29b-41d4-a716-446655440126";
    const sourceOrigin = "http://127.0.0.1:26849";
    const metadata = {
      reference: `${sourceOrigin}/api/media-assets/${assetId}/content`,
      origin: sourceOrigin,
      assetId,
      digest: `sha256:${"a".repeat(64)}`,
      contentType: "image/png",
      byteSize: 12,
      template: "tshirt_short_sleeve",
      width: 512,
      height: 640,
    } as const;
    assert.equal(
      parseSourceGarmentMetadata(metadata, sourceOrigin)?.assetId,
      assetId,
    );
    assert.equal(
      parseSourceGarmentMetadata(
        {
          ...metadata,
          reference: "https://foreign.invalid/api/media-assets/x/content",
        },
        sourceOrigin,
      ),
      null,
    );
    assert.equal(
      parseSourceGarmentMetadata(
        {
          ...metadata,
          reference: `${sourceOrigin}/api/media-assets/other/content`,
        },
        sourceOrigin,
      ),
      null,
    );
    let fetched = false;
    assert.equal(
      await readSourceGarmentPngResource({
        metadata: { ...metadata, origin: "http://127.0.0.1:9" },
        serviceApiOrigin: sourceOrigin,
        fetchImpl: async () => {
          fetched = true;
          throw new Error("不得请求外部来源");
        },
      }),
      null,
    );
    assert.equal(fetched, false);
    assert.equal(
      await readSourceGarmentPngResource({
        metadata,
        serviceApiOrigin: sourceOrigin,
        fetchImpl: async () =>
          ({
            ok: true,
            status: 200,
            url: `${sourceOrigin}/redirected`,
            headers: new Headers({ "content-type": "image/png" }),
            arrayBuffer: async () => Buffer.alloc(12),
          }) as Response,
      }),
      null,
    );
  });

  it("仅把同 websocket、唯一 V2 start 的成衣描述绑定给对应 attempt", () => {
    const collector = new VisionProtocolEvidenceCollector(
      "http://127.0.0.1:27892",
    );
    collector.observeWebSocketCreated({
      requestId: "vision-current",
      url: "ws://127.0.0.1:27892/v2/machine",
    });
    const garment = {
      assetId: "550e8400-e29b-41d4-a716-446655440126",
      reference: "http://127.0.0.1:27892/media/garment?token=source-token",
      digest: `sha256:${"a".repeat(64)}`,
      byteSize: 12,
      contentType: "image/png",
      template: "tshirt_short_sleeve",
    };
    const start = {
      protocol: "vem.vision.v2",
      type: "vision.try_on.attempt.start",
      messageId: "start-1",
      timestamp: "2026-08-20T00:00:00.000Z",
      payload: {
        attemptId: "550e8400-e29b-41d4-a716-446655440124",
        variantId: "550e8400-e29b-41d4-a716-446655440125",
        garment,
      },
    };
    collector.observeWebSocketFrameSent({
      requestId: "vision-current",
      response: { payloadData: JSON.stringify(start) },
    });
    assert.deepEqual(
      collector.startGarmentForAttempt("550e8400-e29b-41d4-a716-446655440124"),
      garment,
    );
    assert.equal(
      isSourceGarmentAttemptBound(
        parseSourceGarmentMetadata(
          {
            reference:
              "http://127.0.0.1:26849/api/media-assets/550e8400-e29b-41d4-a716-446655440126/content",
            origin: "http://127.0.0.1:26849",
            ...garment,
            width: 512,
            height: 640,
          },
          "http://127.0.0.1:26849",
        ),
        { ...garment, assetId: "550e8400-e29b-41d4-a716-446655440127" },
      ),
      false,
    );
    collector.observeWebSocketFrameSent({
      requestId: "vision-current",
      response: { payloadData: JSON.stringify(start) },
    });
    assert.equal(
      collector.startGarmentForAttempt("550e8400-e29b-41d4-a716-446655440124"),
      null,
    );
  });

  it("只记录同 websocket 上唯一的绝对试衣调整及其 adjusted 结果", () => {
    const collector = new VisionProtocolEvidenceCollector(
      "http://127.0.0.1:27892",
    );
    const attemptId = "550e8400-e29b-41d4-a716-446655440124";
    collector.observeWebSocketCreated({
      requestId: "vision-current",
      url: "ws://127.0.0.1:27892/v2/machine",
    });
    collector.observeWebSocketFrameSent({
      requestId: "vision-current",
      response: {
        payloadData: JSON.stringify({
          protocol: "vem.vision.v2",
          type: "vision.try_on.attempt.adjust",
          messageId: "adjust-1",
          timestamp: "2026-08-20T00:00:00.000Z",
          payload: { attemptId, garmentScale: 1.05 },
        }),
      },
    });
    const reference = `http://127.0.0.1:27892/v2/try-on/results/${attemptId}?token=adjusted`;
    collector.observeWebSocketFrameReceived({
      requestId: "vision-current",
      response: {
        payloadData: JSON.stringify({
          protocol: "vem.vision.v2",
          type: "vision.try_on.result.adjusted",
          messageId: "adjusted-1",
          timestamp: "2026-08-20T00:00:01.000Z",
          payload: {
            attemptId,
            result: {
              reference,
              digest: `sha256:${"b".repeat(64)}`,
              contentType: "image/png",
              byteSize: 12,
              width: 1,
              height: 1,
            },
          },
        }),
      },
    });
    assert.deepEqual(collector.adjustmentForAttempt(attemptId).scales, [1.05]);
    assert.deepEqual(collector.adjustmentForAttempt(attemptId).results, [
      {
        reference,
        digest: `sha256:${"b".repeat(64)}`,
        contentType: "image/png",
        byteSize: 12,
        width: 1,
        height: 1,
      },
    ]);
  });

  it("exposes only the try-on state file the slice driver reads", async () => {
    const adapter = new CdpTestAdapter();
    await assert.rejects(
      adapter.readFile("other.json"),
      /unknown adapter file/,
    );
  });

  it("allows only the controlled V2 captured-frame reference before fetching it", () => {
    assert.equal(
      isControlledCapturedFrameReference(
        "http://127.0.0.1:7892/v2/try-on/captured/frame.png?token=captured-token",
      ),
      true,
    );
    assert.equal(
      isControlledCapturedFrameReference(
        "https://example.test/v2/try-on/captured/frame.png?token=captured-token",
      ),
      false,
    );
    assert.equal(
      isControlledCapturedFrameReference(
        "http://127.0.0.1:7892/v2/try-on/results/frame.png?token=captured-token",
      ),
      false,
    );
    assert.equal(
      isControlledCapturedFrameReference(
        "http://127.0.0.1:99999/v2/try-on/captured/frame.png?token=captured-token",
      ),
      false,
    );
  });

  it("records only frames from the configured Vision websocket origin", () => {
    const collector = new VisionProtocolEvidenceCollector(
      "http://127.0.0.1:27892",
    );
    const message = {
      protocol: "vem.vision.v2",
      type: "vision.try_on.attempt.captured",
      payload: {
        attemptId: "attempt-1",
        captured: {
          reference:
            "http://127.0.0.1:27892/v2/try-on/captured/frame.png?token=captured-token",
        },
      },
    };
    collector.observeWebSocketCreated({
      requestId: "foreign",
      url: "ws://127.0.0.1:27893/v2/machine",
    });
    collector.observeWebSocketFrameReceived({
      requestId: "foreign",
      response: { payloadData: JSON.stringify(message) },
    });
    collector.observeWebSocketCreated({
      requestId: "vision-current",
      url: "ws://127.0.0.1:27892/v2/machine",
    });
    collector.observeWebSocketFrameReceived({
      requestId: "vision-current",
      response: { payloadData: JSON.stringify(message) },
    });

    assert.deepEqual(collector.eventsForAttempt("attempt-1"), [
      {
        type: "vision.try_on.attempt.captured",
        requestId: "vision-current",
        origin: "http://127.0.0.1:27892",
        payload: message.payload,
      },
    ]);
  });

  it("refetches a captured URL when a different attempt claims it", async () => {
    let fetches = 0;
    const firstFrame = readFileSync(
      new URL("../../../apps/machine/src-tauri/app-icon.png", import.meta.url),
    );
    const secondFrame = readFileSync(
      new URL(
        "../../../apps/machine/src/assets/home/icon-socks.png",
        import.meta.url,
      ),
    );
    const cache = new CapturedFrameEvidenceCache({
      fetchImpl: async (reference) => {
        fetches += 1;
        const bytes = fetches === 1 ? firstFrame : secondFrame;
        return {
          ok: true,
          status: 200,
          url: reference.toString(),
          headers: new Headers({ "content-type": "image/png" }),
          arrayBuffer: async () =>
            bytes.buffer.slice(
              bytes.byteOffset,
              bytes.byteOffset + bytes.byteLength,
            ),
        } as Response;
      },
    });
    const captured = {
      reference:
        "http://127.0.0.1:27892/v2/try-on/captured/frame.png?token=captured-token",
      digest: `sha256:${"a".repeat(64)}`,
      contentType: "image/png" as const,
      byteSize: 2048,
      width: 640,
      height: 480,
      frameId: "frame-1",
    };
    const first = await cache.read({
      attemptId: "attempt-1",
      visionOrigin: "http://127.0.0.1:27892",
      captured,
    });
    const second = await cache.read({
      attemptId: "attempt-2",
      visionOrigin: "http://127.0.0.1:27892",
      captured,
    });

    assert.equal(fetches, 2);
    assert.notEqual(first?.digest, second?.digest);
    assert.equal(second?.attemptId, "attempt-2");
  });

  it("maps declared role commands to the Vision runtime boundary", async () => {
    const stops: string[] = [];
    const server = createServer((request, response) => {
      if (request.url === "/v2/runtime/roles" && request.method === "GET") {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            schemaVersion: "vem-vision-runtime-roles/v1",
            roles: [
              { name: "observer", pid: null, ready: false },
              { name: "broker", pid: 2002, ready: true },
            ],
          }),
        );
        return;
      }
      if (
        request.url === "/v2/runtime/roles/observer/stop" &&
        request.method === "POST"
      ) {
        stops.push(request.url);
        response.end(JSON.stringify({ role: "observer", stopped: true }));
        return;
      }
      response.statusCode = 404;
      response.end("not found");
    });
    await new Promise<void>((resolvePromise) =>
      server.listen(0, "127.0.0.1", () => resolvePromise()),
    );
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("test server did not bind a TCP port");
    }
    const { port } = address;
    try {
      const adapter = new CdpTestAdapter({
        endpoint: "http://127.0.0.1:1",
        visionBaseUrl: `http://127.0.0.1:${port}`,
      });
      const stopped = await adapter.run("stop-vision-role", [
        "--role",
        "observer",
      ]);
      assert.equal(stopped.exitCode, 0);
      const probe = await adapter.run("probe-vision-role", ["observer"]);
      assert.equal(probe.exitCode, 0);
      assert.equal(probe.stdout, "dead");
      assert.deepEqual(stops, ["/v2/runtime/roles/observer/stop"]);
    } finally {
      await new Promise<void>((resolvePromise) =>
        server.close(() => resolvePromise()),
      );
    }
  });
});

function createFakeCdpWebSocketFactory(
  handler: (message: {
    id: number;
    method: string;
    params: Record<string, any>;
  }) => Record<string, unknown>,
) {
  return {
    factory() {
      const listeners = new Map<string, Set<(event: any) => void>>();
      const emit = (type: string, event: unknown) => {
        for (const listener of [...(listeners.get(type) ?? [])]) {
          listener(event);
        }
      };
      const socket = {
        readyState: 1,
        addEventListener(type: string, listener: (event: any) => void) {
          if (!listeners.has(type)) listeners.set(type, new Set());
          listeners.get(type)!.add(listener);
        },
        removeEventListener(type: string, listener: (event: any) => void) {
          listeners.get(type)?.delete(listener);
        },
        send(raw: string) {
          const response = handler(JSON.parse(raw));
          queueMicrotask(() =>
            emit("message", { data: JSON.stringify(response) }),
          );
        },
        close() {
          socket.readyState = 3;
          emit("close", {});
        },
      };
      return socket;
    },
  };
}

async function startFakeCdpEndpoint(): Promise<{
  url: string;
  close(): Promise<void>;
}> {
  const server = createServer((request, response) => {
    if (request.url !== "/json") {
      response.statusCode = 404;
      response.end();
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify([
        {
          type: "page",
          url: "http://tauri.localhost/#/products/product:1",
          webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/machine-ui",
        },
      ]),
    );
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fake CDP endpoint did not bind a TCP port");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolvePromise, reject) =>
        server.close((error) => (error ? reject(error) : resolvePromise())),
      ),
  };
}
