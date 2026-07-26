import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mediaRoot =
  process.env.MEDIA_ASSET_STORAGE_ROOT ??
  join(tmpdir(), `vem-service-api-e2e-media-assets-${process.pid}`);

mkdirSync(mediaRoot, { recursive: true });
process.env.MEDIA_ASSET_STORAGE_ROOT = mediaRoot;
