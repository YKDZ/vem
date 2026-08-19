import type { TestAdapter } from "./test-adapter.ts";

import { condition, waitForCondition } from "./condition-waiter.ts";

export interface RoleDefinition {
  stopCommand: string[];
  probeCommand?: string[];
}

export interface ProcessRoleManifest {
  schemaVersion: string;
  roles: Record<string, RoleDefinition>;
}

/**
 * 产品声明的进程角色清单：testbed 只消费产品暴露的角色与停止命令，
 * 不按 PID 或创建时间猜测内部进程。
 */
export function createProcessRoleManifest({
  roles,
}: {
  roles: Record<string, RoleDefinition>;
}): Readonly<ProcessRoleManifest> {
  if (!roles || typeof roles !== "object" || Array.isArray(roles)) {
    throw new TypeError("roles must be an object");
  }
  for (const [role, definition] of Object.entries(roles)) {
    if (
      !definition ||
      !Array.isArray(definition.stopCommand) ||
      definition.stopCommand.length === 0 ||
      definition.stopCommand.some((part) => typeof part !== "string")
    ) {
      throw new TypeError(
        `role ${role} stopCommand must be a non-empty command array`,
      );
    }
  }
  return Object.freeze({
    schemaVersion: "vem-runtime-testbed-process-role-manifest/v1",
    roles: Object.fromEntries(
      Object.entries(roles).map(([role, definition]) => [
        role,
        Object.freeze({ ...definition }),
      ]),
    ),
  });
}

export function assertProcessRoleManifest(manifest: ProcessRoleManifest): void {
  if (
    !manifest ||
    manifest.schemaVersion !== "vem-runtime-testbed-process-role-manifest/v1" ||
    !manifest.roles ||
    typeof manifest.roles !== "object"
  ) {
    throw new TypeError("invalid process role manifest");
  }
  for (const [role, definition] of Object.entries(manifest.roles)) {
    if (
      !Array.isArray(definition.stopCommand) ||
      definition.stopCommand.length === 0
    ) {
      throw new TypeError(`role ${role} has no stop command`);
    }
  }
}

/**
 * 通过产品声明边界停止一个角色，并等待其死亡确认。
 */
export async function stopDeclaredRole(
  adapter: TestAdapter,
  manifest: ProcessRoleManifest,
  role: string,
  { timeoutMs = 60_000, pollMs = 250 } = {},
): Promise<{ confirmed: boolean; exitCode: number; stdout: string }> {
  assertProcessRoleManifest(manifest);
  const definition = manifest.roles[role];
  if (!definition) {
    throw new Error(`unknown role: ${role}`);
  }
  const stopped = await adapter.run(
    definition.stopCommand[0],
    definition.stopCommand.slice(1),
  );
  if (stopped.exitCode !== 0) {
    throw new Error(
      `stop role ${role} failed with exit code ${stopped.exitCode}: ${stopped.stderr}`,
    );
  }
  let confirmed = true;
  const probeCommand = definition.probeCommand;
  if (probeCommand && probeCommand.length > 0) {
    await waitForCondition(
      `role ${role} death confirmation`,
      async () => {
        const probe = await adapter.run(
          probeCommand[0]!,
          probeCommand.slice(1),
        );
        return condition(
          probe.exitCode === 0 && /dead/i.test(probe.stdout),
          probe.stdout,
        );
      },
      { timeoutMs, pollMs },
    );
  }
  return { confirmed, exitCode: stopped.exitCode, stdout: stopped.stdout };
}
