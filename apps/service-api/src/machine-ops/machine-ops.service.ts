import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  and,
  eq,
  machineLogArtifacts,
  machineRemoteOps,
  machines,
  type DrizzleClient,
} from "@vem/db";

import { DRIZZLE_CLIENT } from "../database/database.constants";

@Injectable()
export class MachineOpsService {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleClient) {}

  async requestLogExport(machineId: string, adminUserId: string) {
    const [machine] = await this.db
      .select({ id: machines.id })
      .from(machines)
      .where(eq(machines.id, machineId))
      .limit(1);
    if (!machine) throw new NotFoundException("Machine not found");

    const [op] = await this.db
      .insert(machineRemoteOps)
      .values({
        machineId,
        type: "export_logs",
        status: "pending",
        requestedByAdminUserId: adminUserId,
        requestedAt: new Date(),
      })
      .returning();
    return op;
  }

  async listAllOps(machineId?: string) {
    const conditions = machineId
      ? [eq(machineRemoteOps.machineId, machineId)]
      : [];
    return await this.db
      .select()
      .from(machineRemoteOps)
      .where(and(...conditions))
      .orderBy(machineRemoteOps.requestedAt);
  }

  async listPendingForMachine(machineId: string) {
    return await this.db
      .select()
      .from(machineRemoteOps)
      .where(
        and(
          eq(machineRemoteOps.machineId, machineId),
          eq(machineRemoteOps.status, "pending"),
        ),
      )
      .orderBy(machineRemoteOps.requestedAt);
  }

  async acceptOp(opId: string, machineId: string) {
    const [op] = await this.db
      .update(machineRemoteOps)
      .set({ status: "running", acceptedAt: new Date() })
      .where(
        and(
          eq(machineRemoteOps.id, opId),
          eq(machineRemoteOps.machineId, machineId),
          eq(machineRemoteOps.status, "pending"),
        ),
      )
      .returning();
    if (!op)
      throw new NotFoundException("Op not found or not in pending state");
    return op;
  }

  async completeLogExport(
    opId: string,
    machineId: string,
    artifact: {
      fileName: string;
      contentType: string;
      base64: string;
      sizeBytes: number;
    },
  ) {
    const { default: fs } = await import("node:fs");
    const { default: path } = await import("node:path");

    const storageDir = path.join(
      process.cwd(),
      "storage",
      "machine-logs",
      machineId,
    );
    fs.mkdirSync(storageDir, { recursive: true });
    const storagePath = path.join(storageDir, `${opId}.zip`);
    const buffer = Buffer.from(artifact.base64, "base64");
    fs.writeFileSync(storagePath, buffer);

    const dedupeKey = `log_export:${machineId}:${opId}:${artifact.fileName}:${artifact.sizeBytes}`;

    return await this.db.transaction(async (tx) => {
      const [art] = await tx
        .insert(machineLogArtifacts)
        .values({
          opId,
          machineId,
          fileName: artifact.fileName,
          contentType: artifact.contentType,
          sizeBytes: artifact.sizeBytes,
          storagePath,
          dedupeKey,
          createdAt: new Date(),
        })
        .onConflictDoNothing()
        .returning();

      const resultJson = {
        fileName: artifact.fileName,
        sizeBytes: artifact.sizeBytes,
        uploadedAt: new Date().toISOString(),
        artifactId: art?.id ?? dedupeKey,
      };

      const [op] = await tx
        .update(machineRemoteOps)
        .set({
          status: "succeeded",
          finishedAt: new Date(),
          resultJson,
        })
        .where(
          and(
            eq(machineRemoteOps.id, opId),
            eq(machineRemoteOps.machineId, machineId),
          ),
        )
        .returning();

      return { op, artifact: art };
    });
  }

  async failOp(opId: string, machineId: string, reason: string) {
    const [op] = await this.db
      .update(machineRemoteOps)
      .set({ status: "failed", finishedAt: new Date(), failedReason: reason })
      .where(
        and(
          eq(machineRemoteOps.id, opId),
          eq(machineRemoteOps.machineId, machineId),
        ),
      )
      .returning();
    return op;
  }
}
