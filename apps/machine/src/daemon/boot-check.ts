export class BootCheckTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`boot check exceeded ${timeoutMs}ms`);
    this.name = "BootCheckTimeoutError";
  }
}

export async function runBoundedBootCheck<T>(
  check: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new BootCheckTimeoutError(timeoutMs));
    }, timeoutMs);
  });
  try {
    return await Promise.race([check(controller.signal), timeout]);
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
  }
}
