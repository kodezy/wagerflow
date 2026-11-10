import { Catch, HttpException, HttpStatus, type ArgumentsHost, type ExceptionFilter } from "@nestjs/common";
import type { Response } from "express";

import { logError } from "../observability";
import { ValidationError } from "../wagering/errors";
import { TransientStoreError } from "../wagering/store";

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const request = host.switchToHttp().getRequest<{ headers: Record<string, unknown> }>();
    const correlationId = typeof request.headers["x-correlation-id"] === "string" ? request.headers["x-correlation-id"] : undefined;

    if (error instanceof ValidationError) {
      response.status(400).json({ code: error.code, field: error.field });
      return;
    }

    if (error instanceof TransientStoreError || (error instanceof HttpException && error.getStatus() === HttpStatus.SERVICE_UNAVAILABLE)) {
      response.setHeader("Retry-After", "1");
      response.status(503).json({ code: "SERVICE_UNAVAILABLE" });
      return;
    }

    logError({ correlationId }, error);
    response.status(500).json({ code: "INTERNAL_ERROR" });
  }
}
