export function createDelayedPickupPlatformF1Evidence({
  binding,
  snapshot,
  capturedAt = new Date().toISOString(),
}) {
  if (
    snapshot?.schemaVersion !==
      "installed-kiosk-sale-platform-raw-records/v2" ||
    snapshot.source !== "authoritative_ephemeral_platform_database"
  )
    throw new Error(
      "F1 evidence requires an authoritative raw platform snapshot",
    );
  return {
    schemaVersion: "delayed-pickup-platform-f1-evidence/v1",
    source: "authoritative_ephemeral_platform_database",
    capturedAt,
    binding: { ...binding },
    snapshot: structuredClone(snapshot),
  };
}
