import { Inject, Injectable, OnModuleInit } from "@nestjs/common";
import {
  adminUserRoles,
  adminUsers,
  eq,
  paymentProviders,
  permissions,
  rolePermissions,
  roles,
  type DrizzleClient,
} from "@vem/db";
import { permissionCodes } from "@vem/shared";

import { PasswordService } from "../auth/password.service";
import { AppConfigService } from "../config/app-config.service";
import { DRIZZLE_CLIENT } from "../database/database.constants";

@Injectable()
export class BootstrapService implements OnModuleInit {
  constructor(
    @Inject(DRIZZLE_CLIENT) private readonly db: DrizzleClient,
    private readonly config: AppConfigService,
    private readonly passwordService: PasswordService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.seedPermissions();
    const superAdminRoleId = await this.seedSuperAdminRole();
    await this.seedBootstrapAdmin(superAdminRoleId);
    await this.seedMockPaymentProvider();
    await this.seedRealPaymentProviders();
  }

  private async seedPermissions(): Promise<void> {
    await this.db
      .insert(permissions)
      .values(
        permissionCodes.map((code) => ({
          code,
          name: code,
          description: code,
        })),
      )
      .onConflictDoNothing({ target: permissions.code });
  }

  private async seedSuperAdminRole(): Promise<string> {
    const [role] = await this.db
      .insert(roles)
      .values({
        code: "super_admin",
        name: "超级管理员",
        description: "所有权限",
        isBuiltin: true,
        status: "active",
      })
      .onConflictDoUpdate({
        target: roles.code,
        set: { name: "超级管理员", status: "active", updatedAt: new Date() },
      })
      .returning({ id: roles.id });

    const allPermissions = await this.db
      .select({ id: permissions.id })
      .from(permissions);
    await this.db
      .insert(rolePermissions)
      .values(
        allPermissions.map((permission) => ({
          roleId: role.id,
          permissionId: permission.id,
        })),
      )
      .onConflictDoNothing();
    return role.id;
  }

  private async seedBootstrapAdmin(roleId: string): Promise<void> {
    const username = this.config.bootstrapAdminUsername;
    const [existing] = await this.db
      .select({ id: adminUsers.id })
      .from(adminUsers)
      .where(eq(adminUsers.username, username));
    const adminId = existing?.id ?? (await this.createBootstrapAdmin(username));

    await this.db
      .insert(adminUserRoles)
      .values({ adminUserId: adminId, roleId })
      .onConflictDoNothing();
  }

  private async createBootstrapAdmin(username: string): Promise<string> {
    const [admin] = await this.db
      .insert(adminUsers)
      .values({
        username,
        passwordHash: await this.passwordService.hashPassword(
          this.config.bootstrapAdminPassword,
        ),
        displayName: "本地管理员",
        status: "active",
      })
      .returning({ id: adminUsers.id });
    return admin.id;
  }

  private async seedMockPaymentProvider(): Promise<void> {
    await this.db
      .insert(paymentProviders)
      .values({
        code: "mock",
        name: "Mock 支付",
        type: "mock",
        status: this.config.paymentMockEnabled ? "enabled" : "disabled",
        capabilities: {
          createPaymentIntent: true,
          webhook: true,
          refund: true,
        },
      })
      .onConflictDoUpdate({
        target: paymentProviders.code,
        set: {
          status: this.config.paymentMockEnabled ? "enabled" : "disabled",
          updatedAt: new Date(),
        },
      });
  }

  private async seedRealPaymentProviders(): Promise<void> {
    const realProviders = [
      {
        code: "wechat_pay",
        name: "微信支付",
        type: "wechat_pay" as const,
        capabilities: {
          createPaymentIntent: true,
          paymentCode: true,
          webhook: true,
          refund: true,
          query: true,
          cancel: true,
          reverse: true,
        },
      },
      {
        code: "alipay",
        name: "支付宝",
        type: "alipay" as const,
        capabilities: {
          createPaymentIntent: true,
          paymentCode: true,
          webhook: true,
          refund: true,
          query: true,
          cancel: true,
          reverse: true,
        },
      },
    ];
    await Promise.all(
      realProviders.map((provider) =>
        this.db
          .insert(paymentProviders)
          .values({
            code: provider.code,
            name: provider.name,
            type: provider.type,
            status: "disabled",
            capabilities: provider.capabilities,
          })
          .onConflictDoUpdate({
            target: paymentProviders.code,
            set: {
              name: provider.name,
              capabilities: provider.capabilities,
              updatedAt: new Date(),
            },
          }),
      ),
    );
  }
}
