import { expect, type Page } from "@playwright/test";

declare global {
  interface Window {
    __vemRecordAdminContractValidationFailure?: (detail: unknown) => void;
  }
}

export const ADMIN_USERNAME = process.env.E2E_ADMIN_USERNAME ?? "admin";
export const ADMIN_PASSWORD =
  process.env.E2E_ADMIN_PASSWORD ?? "AdminPassword123!";

export type AdminBrowserContractMonitor = {
  failures: string[];
  assertNoFailures: () => Promise<void>;
};

function isIgnoredConsoleError(text: string): boolean {
  return /ResizeObserver loop completed with undelivered notifications/i.test(
    text,
  );
}

function isAdminApiUrl(url: string): boolean {
  try {
    return new URL(url).pathname.startsWith("/api/");
  } catch {
    return url.includes("/api/");
  }
}

export async function installAdminBrowserContractMonitor(
  page: Page,
): Promise<AdminBrowserContractMonitor> {
  const failures: string[] = [];
  const pendingResponses = new Set<Promise<void>>();

  await page.exposeFunction(
    "__vemRecordAdminContractValidationFailure",
    (detail: unknown) => {
      failures.push(
        `contract: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`,
      );
    },
  );

  const installContractEventBridge = () => {
    window.addEventListener("vem:admin-contract-validation-failed", (event) => {
      const bridge = window.__vemRecordAdminContractValidationFailure;
      if (typeof bridge !== "function") return;
      const detail = Reflect.get(event, "detail");
      bridge(detail);
    });
  };
  await page.addInitScript(installContractEventBridge);
  await page.evaluate(installContractEventBridge).catch((error: unknown) => {
    failures.push(`contract-monitor-install: ${String(error)}`);
  });

  page.on("pageerror", (error) => {
    failures.push(`page: ${error.message}`);
  });
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (isIgnoredConsoleError(text)) return;
    failures.push(`console: ${text}`);
  });
  page.on("requestfailed", (request) => {
    failures.push(
      `request: ${request.method()} ${request.url()} ${request.failure()?.errorText ?? "failed"}`,
    );
  });
  page.on("response", (response) => {
    if (!isAdminApiUrl(response.url())) return;
    if (response.status() >= 400) {
      failures.push(`response: ${response.status()} ${response.url()}`);
    }
    const contentType = response.headers()["content-type"] ?? "";
    if (!contentType.toLowerCase().includes("application/json")) return;
    const pending = response
      .json()
      .then((body: unknown) => {
        if (
          typeof body === "object" &&
          body !== null &&
          Reflect.get(body, "code") !== 0
        ) {
          failures.push(
            `api-body: ${response.status()} ${response.url()} code=${String(
              Reflect.get(body, "code"),
            )} message=${String(Reflect.get(body, "message") ?? "")}`,
          );
        }
      })
      .catch((error: unknown) => {
        failures.push(`api-body-unreadable: ${response.url()} ${String(error)}`);
      });
    pendingResponses.add(pending);
    void pending.finally(() => pendingResponses.delete(pending));
  });

  return {
    failures,
    assertNoFailures: async () => {
      await Promise.all([...pendingResponses]);
      expect(failures).toEqual([]);
    },
  };
}

export async function loginAsAdmin(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("用户名").fill(ADMIN_USERNAME);
  await page.getByLabel("密码").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: /登录/ }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 10_000 });
}

export async function waitForAdminUiSettled(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const loading = [
        ...document.querySelectorAll(
          ".ant-spin-spinning, .ant-table-wrapper .ant-spin-spinning, [aria-busy='true']",
        ),
      ];
      return loading.every((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width === 0 || rect.height === 0;
      });
    },
    undefined,
    { timeout: 10_000 },
  );
  await expect(page.locator(".ant-skeleton, .ant-spin-spinning")).toHaveCount(
    0,
    { timeout: 10_000 },
  );
}
