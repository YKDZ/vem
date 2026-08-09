import type { INestApplication } from "@nestjs/common";

import { Test } from "@nestjs/testing";
import { DrizzleDB } from "@vem/db";
import {
  adminCreateTryOnGarmentContract,
  adminGetTryOnGarmentContract,
  adminTryOnGarmentConfirmationContract,
  adminTryOnGarmentUploadContract,
} from "@vem/shared";
import { deflateSync } from "node:zlib";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { AppConfigService } from "../config/app-config.service";
import { MqttService } from "../mqtt/mqtt.service";
import {
  cleanupBusinessTables,
  loginAndGetToken,
  type ApiResponse,
} from "./flow-test-helpers";

describe("admin-try-on-garment-contract.e2e", { concurrent: false }, () => {
  let app: INestApplication;
  let appConfig: AppConfigService;
  let db: DrizzleDB;
  let api: ReturnType<typeof request>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(MqttService)
      .useValue({
        bindVendingService: () => undefined,
        registerMachineMessageHandler: () => undefined,
        isConnected: () => false,
        publish: async () => undefined,
      })
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix("api");
    await app.init();
    appConfig = app.get(AppConfigService);
    db = new DrizzleDB(appConfig.databaseUrl);
    await db.connect();
    api = request(app.getHttpServer() as Parameters<typeof request>[0]);
  }, 120_000);

  afterAll(async () => {
    await db?.disconnect();
    await app?.close();
  });

  beforeEach(async () => {
    await cleanupBusinessTables(db);
  });

  it("creates, previews, retrieves, and explicitly confirms a draft through the public Admin API", async () => {
    const token = await loginAndGetToken(api, appConfig);
    const auth = { Authorization: `Bearer ${token}` };
    const productResponse = await api
      .post("/api/products")
      .set(auth)
      .send({ name: "试衣 T 恤", status: "draft", sortOrder: 0 });
    expect(productResponse.status).toBe(201);
    const productId = (productResponse.body as ApiResponse<{ id: string }>).data
      .id;

    const uploadResponse = await api
      .post(`/api${adminTryOnGarmentUploadContract.path}`)
      .set(auth)
      .attach("file", rgbaPng(768, 1024, 0), {
        filename: "navy-shirt.png",
        contentType: "image/png",
      });
    expect(uploadResponse.status).toBe(201);
    const asset = adminTryOnGarmentUploadContract.responseSchema.parse(
      (uploadResponse.body as ApiResponse<unknown>).data,
    );
    expect(asset).toMatchObject({
      purpose: "try_on_garment",
      contentType: "image/png",
      width: 768,
      height: 1024,
      hasTransparency: true,
    });
    expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/);

    const draftResponse = await api
      .post(`/api${adminCreateTryOnGarmentContract.path}`)
      .set(auth)
      .send({
        productId,
        colorLabel: "海军蓝",
        sourceMediaAssetId: asset.id,
        template: "tshirt_short_sleeve",
      });
    expect(draftResponse.status).toBe(201);
    const draft = adminCreateTryOnGarmentContract.responseSchema.parse(
      (draftResponse.body as ApiResponse<unknown>).data,
    );
    expect(draft).toMatchObject({
      productId,
      colorLabel: "海军蓝",
      status: "draft",
      confirmedAt: null,
      sourceMediaAsset: asset,
    });

    const fetchedResponse = await api
      .get(`/api${adminGetTryOnGarmentContract.path.replace(":id", draft.id)}`)
      .set(auth);
    expect(fetchedResponse.status).toBe(200);
    expect(
      adminGetTryOnGarmentContract.responseSchema.parse(
        (fetchedResponse.body as ApiResponse<unknown>).data,
      ),
    ).toEqual(draft);

    const confirmedResponse = await api
      .post(
        `/api${adminTryOnGarmentConfirmationContract.path.replace(":id", draft.id)}`,
      )
      .set(auth)
      .send({});
    expect(confirmedResponse.status).toBe(201);
    const confirmed =
      adminTryOnGarmentConfirmationContract.responseSchema.parse(
        (confirmedResponse.body as ApiResponse<unknown>).data,
      );
    expect(confirmed.status).toBe("draft");
    expect(confirmed.confirmedAt).toEqual(expect.any(String));
  }, 60_000);

  it("returns stable validation failures for model-photo-like opacity and unsupported templates", async () => {
    const token = await loginAndGetToken(api, appConfig);
    const auth = { Authorization: `Bearer ${token}` };
    const opaqueResponse = await api
      .post(`/api${adminTryOnGarmentUploadContract.path}`)
      .set(auth)
      .attach("file", rgbaPng(512, 512, 255), {
        filename: "model-photo.png",
        contentType: "image/png",
      });
    expect(opaqueResponse.status).toBe(400);
    expect((opaqueResponse.body as ApiResponse<unknown>).message).toBe(
      "TRY_ON_GARMENT_TRANSPARENCY_REQUIRED",
    );

    const invalidTemplateResponse = await api
      .post(`/api${adminCreateTryOnGarmentContract.path}`)
      .set(auth)
      .send({
        productId: "550e8400-e29b-41d4-a716-446655440124",
        colorLabel: "海军蓝",
        sourceMediaAssetId: "550e8400-e29b-41d4-a716-446655440125",
        template: "hoodie",
      });
    expect(invalidTemplateResponse.status).toBe(400);
    expect(
      (invalidTemplateResponse.body as ApiResponse<unknown>).message,
    ).toContain("TRY_ON_GARMENT_TEMPLATE_INVALID");
  }, 60_000);
});

function rgbaPng(width: number, height: number, alpha: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const pixels = Buffer.alloc((width * 4 + 1) * height);
  for (let row = 0; row < height; row += 1) {
    const offset = row * (width * 4 + 1);
    for (let pixel = 0; pixel < width; pixel += 1) {
      pixels[offset + 1 + pixel * 4 + 3] = alpha;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.byteLength, 0);
  header.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), data])), 0);
  return Buffer.concat([header, data, crc]);
}

function crc32(value: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
