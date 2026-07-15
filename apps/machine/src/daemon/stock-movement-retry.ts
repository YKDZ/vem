import { DaemonUnavailableError } from "./client";

// A timeout has no commit boundary. A conflict may be the daemon reporting
// that this idempotency key already committed, so both must keep the key.
const UNCERTAIN_CLIENT_RESPONSE_STATUSES = new Set([408, 409]);

export function isDefiniteStockMovementRejection(
  error: unknown,
): error is DaemonUnavailableError {
  return (
    error instanceof DaemonUnavailableError &&
    error.statusCode !== undefined &&
    error.statusCode >= 400 &&
    error.statusCode < 500 &&
    !UNCERTAIN_CLIENT_RESPONSE_STATUSES.has(error.statusCode)
  );
}
