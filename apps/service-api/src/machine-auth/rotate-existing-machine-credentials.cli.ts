/**
 * CLI 脚本：为所有 secret_hash 为空的机器生成凭证 bundle。
 * 执行者必须把 stdout 通过受控运维通道交付现场。
 * 脚本不写日志文件保存明文 secret。
 *
 * 使用方式：
 *   pnpm -F service-api credentials:rotate-missing
 *
 * 必须设置环境变量 DATABASE_URL 和 MACHINE_CREDENTIAL_ENCRYPTION_KEY。
 */

import { and, DrizzleDB, eq, isNull, machines } from "@vem/db";

import {
  encryptCredentialSecret,
  generateMachineSecret,
  hashMachineSecret,
} from "./machine-credentials.util";

const DATABASE_URL = process.env["DATABASE_URL"];
const MACHINE_CREDENTIAL_ENCRYPTION_KEY =
  process.env["MACHINE_CREDENTIAL_ENCRYPTION_KEY"];

if (!DATABASE_URL) {
  console.error("ERROR: DATABASE_URL is required");
  process.exit(1);
}
if (
  !MACHINE_CREDENTIAL_ENCRYPTION_KEY ||
  MACHINE_CREDENTIAL_ENCRYPTION_KEY.length < 32
) {
  console.error(
    "ERROR: MACHINE_CREDENTIAL_ENCRYPTION_KEY is required (min 32 chars)",
  );
  process.exit(1);
}

const db = new DrizzleDB(DATABASE_URL);

await db.connect();
try {
  const rows = await db.client
    .select({ id: machines.id, code: machines.code })
    .from(machines)
    .where(and(isNull(machines.secretHash), isNull(machines.deletedAt)));

  console.log("machineCode,machineSecret,mqttSigningSecret,secretVersion");
  for (const machine of rows) {
    const machineSecret = generateMachineSecret();
    const mqttSigningSecret = generateMachineSecret();
    await db.client
      .update(machines)
      .set({
        secretHash: hashMachineSecret(machineSecret),
        secretVersion: 1,
        secretRotatedAt: new Date(),
        credentialRevokedAt: null,
        mqttSigningSecretEncryptedJson: encryptCredentialSecret(
          mqttSigningSecret,
          MACHINE_CREDENTIAL_ENCRYPTION_KEY,
        ) as Record<string, unknown>,
        updatedAt: new Date(),
      })
      .where(eq(machines.id, machine.id));
    console.log(`${machine.code},${machineSecret},${mqttSigningSecret},1`);
  }
} finally {
  await db.disconnect();
}
