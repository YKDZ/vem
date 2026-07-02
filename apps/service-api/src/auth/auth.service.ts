import { Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import {
  and,
  adminUsers,
  eq,
  gt,
  isNull,
  refreshTokens,
  type DrizzleClient,
} from "@vem/db";
import { createHash, randomUUID } from "node:crypto";

import type { AuthenticatedAdmin } from "../common/request-user";

import { AccessService } from "../access/access.service";
import { AppConfigService } from "../config/app-config.service";
import { DRIZZLE_CLIENT } from "../database/database.constants";
import { PasswordService } from "./password.service";

@Injectable()
export class AuthService {
  constructor(
    @Inject(DRIZZLE_CLIENT) private readonly db: DrizzleClient,
    @Inject(JwtService)
    private readonly jwtService: JwtService,
    @Inject(AppConfigService)
    private readonly config: AppConfigService,
    @Inject(PasswordService)
    private readonly passwordService: PasswordService,
    @Inject(AccessService)
    private readonly accessService: AccessService,
  ) {}

  async login(
    username: string,
    password: string,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const [admin] = await this.db
      .select()
      .from(adminUsers)
      .where(
        and(
          eq(adminUsers.username, username),
          eq(adminUsers.status, "active"),
          isNull(adminUsers.deletedAt),
        ),
      );
    if (
      !admin ||
      !(await this.passwordService.verifyPassword(password, admin.passwordHash))
    ) {
      throw new UnauthorizedException("Invalid username or password");
    }

    const accessToken = await this.signAccessToken(admin.id, admin.username);
    const refreshToken = randomUUID();
    await this.db.insert(refreshTokens).values({
      adminUserId: admin.id,
      tokenHash: this.hashToken(refreshToken),
      expiresAt: new Date(Date.now() + this.config.jwtRefreshTtlSeconds * 1000),
    });
    await this.db
      .update(adminUsers)
      .set({ lastLoginAt: new Date(), updatedAt: new Date() })
      .where(eq(adminUsers.id, admin.id));

    return { accessToken, refreshToken };
  }

  async refresh(
    refreshToken: string,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const [tokenRow] = await this.db
      .select()
      .from(refreshTokens)
      .where(
        and(
          eq(refreshTokens.tokenHash, this.hashToken(refreshToken)),
          isNull(refreshTokens.revokedAt),
          gt(refreshTokens.expiresAt, new Date()),
        ),
      );
    if (!tokenRow) {
      throw new UnauthorizedException("Invalid refresh token");
    }

    const admin = await this.accessService.getAuthenticatedAdmin(
      tokenRow.adminUserId,
    );
    const accessToken = await this.signAccessToken(admin.id, admin.username);
    return { accessToken, refreshToken };
  }

  async me(admin: AuthenticatedAdmin): Promise<AuthenticatedAdmin> {
    return admin;
  }

  private async signAccessToken(
    adminUserId: string,
    username: string,
  ): Promise<string> {
    return await this.jwtService.signAsync(
      { sub: adminUserId, username },
      {
        secret: this.config.jwtSecret,
        expiresIn: this.config.jwtAccessTtlSeconds,
      },
    );
  }

  private hashToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }
}
