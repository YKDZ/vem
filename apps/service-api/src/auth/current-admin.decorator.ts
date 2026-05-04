import { createParamDecorator, ExecutionContext } from "@nestjs/common";

import type { AuthenticatedAdmin } from "../common/request-user";

export const CurrentAdmin = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedAdmin => {
    const request = context
      .switchToHttp()
      .getRequest<{ user: AuthenticatedAdmin }>();
    return request.user;
  },
);
