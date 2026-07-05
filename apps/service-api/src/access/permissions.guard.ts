import type { PermissionCode } from "@vem/shared";

import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";

import type { AuthenticatedAdmin } from "../common/request-user";

import {
  ANY_REQUIRED_PERMISSIONS_KEY,
  REQUIRED_PERMISSIONS_KEY,
} from "./permissions.decorator";

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<PermissionCode[]>(
      REQUIRED_PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );
    const anyRequired = this.reflector.getAllAndOverride<PermissionCode[]>(
      ANY_REQUIRED_PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (
      (!required || required.length === 0) &&
      (!anyRequired || anyRequired.length === 0)
    ) {
      return true;
    }

    const request = context
      .switchToHttp()
      .getRequest<{ user?: AuthenticatedAdmin }>();
    const userPermissions = new Set(request.user?.permissions ?? []);
    const allowedEvery =
      !required ||
      required.length === 0 ||
      required.every((permission) => userPermissions.has(permission));
    const allowedAny =
      !anyRequired ||
      anyRequired.length === 0 ||
      anyRequired.some((permission) => userPermissions.has(permission));
    const allowed = allowedEvery && allowedAny;
    if (!allowed) {
      throw new ForbiddenException("Permission denied");
    }
    return true;
  }
}
