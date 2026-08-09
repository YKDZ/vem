import { Module } from "@nestjs/common";

import { TryOnGarmentsController } from "./try-on-garments.controller";
import { TryOnGarmentsService } from "./try-on-garments.service";

@Module({
  controllers: [TryOnGarmentsController],
  providers: [TryOnGarmentsService],
})
export class TryOnGarmentsModule {}
