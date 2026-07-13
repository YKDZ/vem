import type { MaintenanceRelayDesiredState } from "@vem/shared/schemas/maintenance-access";

import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  createRelayJournal,
  FileRelayJournalStore,
  hashDesiredState,
} from "./journal";

const state: MaintenanceRelayDesiredState = {
  schemaVersion: "maintenance-relay-desired-state/v1",
  desiredStateVersion: 7,
  generatedAt: "2026-07-10T12:00:00.000Z",
  peers: [],
  authorizations: [],
};

describe("relay journal", () => {
  it("atomically persists and validates the canonical last-success state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vem-relay-journal-"));
    const path = join(directory, "state", "journal.json");
    try {
      const store = new FileRelayJournalStore(path);
      const journal = createRelayJournal(
        state,
        new Date("2026-07-10T12:00:01.000Z"),
      );

      await store.save(journal);

      await expect(store.load()).resolves.toEqual(journal);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(await readFile(path, "utf8")).not.toMatch(/privateKey|shell/i);
      expect(journal.canonicalPayloadHash).toBe(hashDesiredState(state));

      await expect(
        store.save({ ...journal, canonicalPayloadHash: "0".repeat(64) }),
      ).rejects.toThrow("revision or payload hash is invalid");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
