import type { ZodType } from "zod";

import { BadRequestException, Injectable, PipeTransform } from "@nestjs/common";

@Injectable()
export class ZodValidationPipe<
  TInput = unknown,
  TOutput = unknown,
> implements PipeTransform<TInput, TOutput> {
  constructor(private readonly schema: ZodType<TOutput, TInput>) {}

  transform(value: TInput): TOutput {
    const parsed = this.schema.safeParse(value);
    if (!parsed.success) {
      throw new BadRequestException(
        parsed.error.issues
          .map(
            (issue) => `${issue.path.join(".") || "value"}: ${issue.message}`,
          )
          .join("; "),
      );
    }
    return parsed.data;
  }
}
