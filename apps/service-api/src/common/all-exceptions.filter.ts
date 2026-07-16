import type { Request, Response } from "express";

import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const response = context.getResponse<Response>();
    const request = context.getRequest<Request>();
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;
    const message = this.getMessage(exception, status);

    if (status >= 500) {
      this.logger.error(
        `${request.method} ${request.url} failed`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else if (
      request.method === "POST" &&
      request.url.split("?", 1)[0] === "/api/machines/claim"
    ) {
      // The machine daemon deliberately exposes one generic claim error.
      // Preserve the server-side classification without logging claim input.
      this.logger.warn(
        `${request.method} ${request.url} rejected with ${status}: ${message}`,
      );
    }

    response.status(status).json({
      code: status,
      message,
      data: null,
    });
  }

  private getMessage(exception: unknown, status: number): string {
    if (exception instanceof HttpException) {
      const response = exception.getResponse();
      if (
        typeof response === "object" &&
        response !== null &&
        "message" in response
      ) {
        const value = response.message;
        return Array.isArray(value) ? value.join("; ") : String(value);
      }
      return exception.message;
    }
    return status === 500 // HttpStatus.INTERNAL_SERVER_ERROR
      ? "Internal server error"
      : "Request failed";
  }
}
