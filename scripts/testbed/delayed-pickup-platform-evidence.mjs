export function createDelayedPickupPlatformF1Evidence({ snapshot }) {
  if (
    snapshot?.schemaVersion !==
      "installed-kiosk-sale-platform-raw-records/v3" ||
    snapshot.source !== "authoritative_ephemeral_platform_database"
  )
    throw new Error(
      "F1 evidence requires an authoritative raw platform snapshot",
    );
  return structuredClone(snapshot);
}
