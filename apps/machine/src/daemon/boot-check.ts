export class BootCheckTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`boot check exceeded ${timeoutMs}ms`);
    this.name = "BootCheckTimeoutError";
  }
}

export async function runBoundedBootCheck<T>(
  check: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      reject(new BootCheckTimeoutError(timeoutMs));
    }, timeoutMs);
  });
  try {
    return await Promise.race([check(), timeout]);
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
  }
}
