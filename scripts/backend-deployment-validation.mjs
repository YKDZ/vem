const DIGEST_PINNED_IMAGE_RE =
  /^(?:(?:[a-z0-9.-]+(?::[0-9]+)?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*)@sha256:[a-f0-9]{64}$/;

export function validateDigestPinnedImage(value, name = "image") {
  if (!DIGEST_PINNED_IMAGE_RE.test(value)) {
    throw new Error(
      `${name} must be a digest-pinned image reference in the form <image>@sha256:<64hex>`,
    );
  }
  return value;
}

export function validatePaymentWebhookBaseUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("PAYMENT_WEBHOOK_BASE_URL must be a valid absolute URL");
  }
  const normalizedPath = parsed.pathname.replace(/\/+$/, "") || "/";
  if (!["/", "/api/payments/webhooks"].includes(normalizedPath)) {
    throw new Error(
      "PAYMENT_WEBHOOK_BASE_URL must be a service origin or /api/payments/webhooks base path",
    );
  }
  return value;
}

export function validateAdminProxyHealth(raw) {
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new Error("Admin UI API proxy did not return JSON");
  }
  if (body?.data?.database !== "ok" || body?.data?.mqtt !== "connected") {
    throw new Error("Admin UI API proxy did not return healthy backend state");
  }
  return body;
}
