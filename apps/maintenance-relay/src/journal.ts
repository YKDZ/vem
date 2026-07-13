import {
  maintenanceRelayDesiredStateSchema,
  type MaintenanceRelayDesiredState,
} from "@vem/shared/schemas/maintenance-access";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";

const relayJournalSchema = z.strictObject({
  schemaVersion: z.literal("maintenance-relay-journal/v1"),
  appliedRevision: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .nullable(),
  canonicalPayloadHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  lastSuccessfulState: maintenanceRelayDesiredStateSchema.nullable(),
  updatedAt: z.iso.datetime(),
});

export type RelayJournal = z.infer<typeof relayJournalSchema>;

export type RelayJournalStore = {
  load: () => Promise<RelayJournal | undefined>;
  save: (journal: RelayJournal) => Promise<void>;
};

export class FileRelayJournalStore implements RelayJournalStore {
  constructor(private readonly path: string) {}

  async load(): Promise<RelayJournal | undefined> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if (isErrorWithCode(error) && error.code === "ENOENT") return undefined;
      throw error;
    }
    return parseRelayJournal(JSON.parse(text) as unknown);
  }

  async save(input: RelayJournal): Promise<void> {
    const journal = parseRelayJournal(input);
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = join(
      directory,
      `.${basename(this.path)}.${process.pid}.${randomUUID()}.tmp`,
    );
    let temporary: FileHandle | undefined;
    try {
      temporary = await open(temporaryPath, "wx", 0o600);
      await temporary.writeFile(`${JSON.stringify(journal)}\n`, "utf8");
      await temporary.sync();
      await temporary.close();
      temporary = undefined;
      await rename(temporaryPath, this.path);
      const directoryHandle = await open(directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } finally {
      await temporary?.close();
      await rm(temporaryPath, { force: true });
    }
  }
}

export function hashDesiredState(state: MaintenanceRelayDesiredState): string {
  const canonical = canonicalJson(
    maintenanceRelayDesiredStateSchema.parse(state),
  );
  return createHash("sha256").update(canonical).digest("hex");
}

export function createRelayJournal(
  state: MaintenanceRelayDesiredState,
  updatedAt: Date,
): RelayJournal {
  return parseRelayJournal({
    schemaVersion: "maintenance-relay-journal/v1",
    appliedRevision: state.desiredStateVersion,
    canonicalPayloadHash: hashDesiredState(state),
    lastSuccessfulState: state,
    updatedAt: updatedAt.toISOString(),
  });
}

function parseRelayJournal(input: unknown): RelayJournal {
  const journal = relayJournalSchema.parse(input);
  const empty =
    journal.appliedRevision === null &&
    journal.canonicalPayloadHash === null &&
    journal.lastSuccessfulState === null;
  const complete =
    journal.appliedRevision !== null &&
    journal.canonicalPayloadHash !== null &&
    journal.lastSuccessfulState !== null;
  if (!empty && !complete) {
    throw new Error("relay journal last-success fields are inconsistent");
  }
  if (
    journal.lastSuccessfulState &&
    (journal.appliedRevision !==
      journal.lastSuccessfulState.desiredStateVersion ||
      journal.canonicalPayloadHash !==
        hashDesiredState(journal.lastSuccessfulState))
  ) {
    throw new Error("relay journal revision or payload hash is invalid");
  }
  return journal;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  return `{${Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

function isErrorWithCode(error: unknown): error is Error & { code: string } {
  return (
    error instanceof Error && "code" in error && typeof error.code === "string"
  );
}
