import type { z } from "zod";

import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import {
  parseAdminApiResponse,
  type AdminApiResponseContract,
} from "@vem/shared";
import { map, type Observable } from "rxjs";

import { ADMIN_RESPONSE_CONTRACT } from "./admin-response-contract.decorator";

export type ApiResponse<T> = {
  code: number;
  message: string;
  data: T;
};

@Injectable()
export class ApiResponseInterceptor<T> implements NestInterceptor<
  T,
  ApiResponse<unknown>
> {
  constructor(private readonly reflector: Reflector) {}

  intercept(
    context: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<ApiResponse<unknown>> {
    const contract = this.reflector.get<
      AdminApiResponseContract<
        "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
        string,
        z.ZodType
      >
    >(ADMIN_RESPONSE_CONTRACT, context.getHandler());

    return next.handle().pipe(
      map((data) => {
        const responseData = contract
          ? parseAdminApiResponse(contract, data)
          : data;
        return {
          code: 0,
          message: "ok",
          data: responseData,
        };
      }),
    );
  }
}
