import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { AllExceptionsFilter } from "./all-exceptions.filter";

describe("AllExceptionsFilter", () => {
  it("maps Nest's wrapped Multer unexpected-field error to the upload reason code", () => {
    const response = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const request = {
      method: "POST",
      url: "/api/media-assets/try-on-garments",
    };
    const host = {
      switchToHttp: () => ({
        getResponse: () => response,
        getRequest: () => request,
      }),
    };

    new AllExceptionsFilter().catch(
      new BadRequestException("Unexpected field"),
      host as never,
    );

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith({
      code: 400,
      message: "TRY_ON_GARMENT_MULTIPART_INVALID",
      data: null,
    });
  });
});
