import { Module } from "@nestjs/common";

import { ConfigModule } from "../config/config.module";
import { MediaAssetsController } from "./media-assets.controller";
import { MediaAssetsService } from "./media-assets.service";

@Module({
  imports: [ConfigModule],
  controllers: [MediaAssetsController],
  providers: [MediaAssetsService],
  exports: [MediaAssetsService],
})
export class MediaAssetsModule {}
