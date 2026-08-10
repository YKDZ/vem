import type { INestApplication } from "@nestjs/common";

import { Test } from "@nestjs/testing";
import {
  DrizzleDB,
  eq,
  inventories,
  productVariants,
  tryOnGarments,
} from "@vem/db";
import {
  adminCreateTryOnGarmentContract,
  adminGetTryOnGarmentContract,
  adminListTryOnGarmentsByProductContract,
  adminTryOnGarmentConfirmationContract,
  adminTryOnGarmentActivationContract,
  adminTryOnGarmentAssociationContract,
  adminTryOnGarmentRetirementContract,
  adminTryOnGarmentSourceReplacementContract,
  adminTryOnGarmentUploadContract,
} from "@vem/shared";
import { deflateSync } from "node:zlib";
import request from "supertest";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { AppModule } from "../app.module";
import { AppConfigService } from "../config/app-config.service";
import { MqttService } from "../mqtt/mqtt.service";
import { TryOnGarmentsService } from "../try-on-garments/try-on-garments.service";
import {
  cleanupBusinessTables,
  getMachineAuthHeader,
  loginAndGetToken,
  seedSingleSlotInventory,
  type ApiResponse,
} from "./flow-test-helpers";

describe("admin-try-on-garment-contract.e2e", { concurrent: false }, () => {
  let app: INestApplication;
  let appConfig: AppConfigService;
  let db: DrizzleDB;
  let api: ReturnType<typeof request>;
  const originalMediaAssetPublicBaseUrl =
    process.env.MEDIA_ASSET_PUBLIC_BASE_URL;

  beforeAll(async () => {
    process.env.MEDIA_ASSET_PUBLIC_BASE_URL = "https://media.example/api";
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
    if (originalMediaAssetPublicBaseUrl === undefined) {
      delete process.env.MEDIA_ASSET_PUBLIC_BASE_URL;
    } else {
      process.env.MEDIA_ASSET_PUBLIC_BASE_URL = originalMediaAssetPublicBaseUrl;
    }
  });

  beforeEach(async () => {
    await cleanupBusinessTables(db);
  });

  it("creates, previews, retrieves, and explicitly confirms a draft through the public Admin API", async () => {
    const token = await loginAndGetToken(api, appConfig);
    const auth = { Authorization: `Bearer ${token}` };
    const currentAdminResponse = await api.get("/api/auth/me").set(auth);
    expect(currentAdminResponse.status).toBe(200);
    const adminId = (currentAdminResponse.body as ApiResponse<{ id: string }>)
      .data.id;
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
    expect(asset.managedReference).toBe(
      `/api/media-assets/${asset.id}/content`,
    );

    const contentResponse = await api.get(asset.managedReference);
    expect(contentResponse.status).toBe(200);
    expect(contentResponse.headers["content-type"]).toContain("image/png");
    expect(contentResponse.body).toEqual(rgbaPng(768, 1024, 0));

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

    const productGarmentsResponse = await api
      .get(`/api${adminListTryOnGarmentsByProductContract.path}`)
      .set(auth)
      .query({ productId });
    expect(productGarmentsResponse.status).toBe(200);
    expect(
      adminListTryOnGarmentsByProductContract.responseSchema.parse(
        (productGarmentsResponse.body as ApiResponse<unknown>).data,
      ),
    ).toEqual([draft]);

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
    expect(confirmed.deletedAt).toBeNull();

    const activatedResponse = await api
      .post(
        `/api${adminTryOnGarmentActivationContract.path.replace(":id", draft.id)}`,
      )
      .set(auth)
      .send({});
    expect(activatedResponse.status).toBe(201);
    const active = adminTryOnGarmentActivationContract.responseSchema.parse(
      (activatedResponse.body as ApiResponse<unknown>).data,
    );
    expect(active.status).toBe("active");

    const retiredResponse = await api
      .post(
        `/api${adminTryOnGarmentRetirementContract.path.replace(":id", draft.id)}`,
      )
      .set(auth)
      .send({});
    expect(retiredResponse.status).toBe(201);
    expect(
      adminTryOnGarmentRetirementContract.responseSchema.parse(
        (retiredResponse.body as ApiResponse<unknown>).data,
      ).status,
    ).toBe("retired");

    const auditResponse = await api
      .get(`/api/audit-logs?resourceId=${draft.id}&page=1&pageSize=10`)
      .set(auth);
    expect(auditResponse.status).toBe(200);
    expect(
      (
        auditResponse.body as ApiResponse<{
          items: Array<{ adminUserId: string; action: string }>;
        }>
      ).data.items,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "try_on_garments.draft.create",
          adminUserId: adminId,
        }),
        expect.objectContaining({
          action: "try_on_garments.source.confirm",
          adminUserId: adminId,
        }),
        expect.objectContaining({
          action: "try_on_garments.activate",
          adminUserId: adminId,
        }),
        expect.objectContaining({
          action: "try_on_garments.retire",
          adminUserId: adminId,
        }),
      ]),
    );
  }, 60_000);

  it("returns stable validation failures for multipart, opaque, malformed, and unsupported contract input", async () => {
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

    const missingFileResponse = await api
      .post(`/api${adminTryOnGarmentUploadContract.path}`)
      .set(auth);
    expect(missingFileResponse.status).toBe(400);
    expect((missingFileResponse.body as ApiResponse<unknown>).message).toBe(
      "TRY_ON_GARMENT_FILE_REQUIRED",
    );

    const oversizedResponse = await api
      .post(`/api${adminTryOnGarmentUploadContract.path}`)
      .set(auth)
      .attach("file", Buffer.alloc(5 * 1024 * 1024 + 1), {
        filename: "too-large.png",
        contentType: "image/png",
      });
    expect(oversizedResponse.status).toBe(400);
    expect((oversizedResponse.body as ApiResponse<unknown>).message).toBe(
      "TRY_ON_GARMENT_FILE_TOO_LARGE",
    );

    const malformedResponse = await api
      .post(`/api${adminTryOnGarmentUploadContract.path}`)
      .set(auth)
      .attach("file", Buffer.from("not a PNG"), {
        filename: "corrupt.png",
        contentType: "image/png",
      });
    expect(malformedResponse.status).toBe(400);
    expect((malformedResponse.body as ApiResponse<unknown>).message).toBe(
      "TRY_ON_GARMENT_PNG_REQUIRED",
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

    const extraBodyResponse = await api
      .post(`/api${adminCreateTryOnGarmentContract.path}`)
      .set(auth)
      .send({
        productId: "550e8400-e29b-41d4-a716-446655440124",
        colorLabel: "海军蓝",
        sourceMediaAssetId: "550e8400-e29b-41d4-a716-446655440125",
        template: "tshirt_short_sleeve",
        unexpected: true,
      });
    expect(extraBodyResponse.status).toBe(400);

    const extraQueryResponse = await api
      .get(
        `/api${adminGetTryOnGarmentContract.path.replace(":id", "550e8400-e29b-41d4-a716-446655440124")}?unexpected=true`,
      )
      .set(auth);
    expect(extraQueryResponse.status).toBe(400);

    const unexpectedFieldResponse = await api
      .post(`/api${adminTryOnGarmentUploadContract.path}`)
      .set(auth)
      .field("unexpected", "true")
      .attach("file", rgbaPng(512, 512, 0), {
        filename: "shirt.png",
        contentType: "image/png",
      });
    expect(unexpectedFieldResponse.status).toBe(400);
    expect((unexpectedFieldResponse.body as ApiResponse<unknown>).message).toBe(
      "TRY_ON_GARMENT_MULTIPART_INVALID",
    );

    const multipleFilesResponse = await api
      .post(`/api${adminTryOnGarmentUploadContract.path}`)
      .set(auth)
      .attach("file", rgbaPng(512, 512, 0), {
        filename: "shirt-a.png",
        contentType: "image/png",
      })
      .attach("file", rgbaPng(512, 512, 0), {
        filename: "shirt-b.png",
        contentType: "image/png",
      });
    expect(multipleFilesResponse.status).toBe(400);
    expect((multipleFilesResponse.body as ApiResponse<unknown>).message).toBe(
      "TRY_ON_GARMENT_MULTIPART_INVALID",
    );

    const malformedFramingResponse = await api
      .post(`/api${adminTryOnGarmentUploadContract.path}`)
      .set(auth)
      .set("Content-Type", "multipart/form-data; boundary=vem-boundary")
      .send("--vem-boundary\r\n");
    expect(malformedFramingResponse.status).toBe(400);
    expect(
      (malformedFramingResponse.body as ApiResponse<unknown>).message,
    ).toBe("TRY_ON_GARMENT_MULTIPART_INVALID");
  }, 60_000);

  it("associates several same-product sizes atomically, rejects another product, and atomically replaces the source", async () => {
    const token = await loginAndGetToken(api, appConfig);
    const auth = { Authorization: `Bearer ${token}` };
    const createProduct = async (name: string) => {
      const response = await api
        .post("/api/products")
        .set(auth)
        .send({ name, status: "draft", sortOrder: 0 });
      expect(response.status).toBe(201);
      return (response.body as ApiResponse<{ id: string }>).data.id;
    };
    const upload = async (alpha: number) => {
      const response = await api
        .post(`/api${adminTryOnGarmentUploadContract.path}`)
        .set(auth)
        .attach("file", rgbaPng(768, 1024, alpha), {
          filename: `garment-${alpha}.png`,
          contentType: "image/png",
        });
      expect(response.status).toBe(201);
      return adminTryOnGarmentUploadContract.responseSchema.parse(
        (response.body as ApiResponse<unknown>).data,
      );
    };
    const productId = await createProduct("共享尺码 T 恤");
    const otherProductId = await createProduct("不可跨商品关联 T 恤");
    const createVariant = async (
      productId: string,
      sku: string,
      size: string,
    ) => {
      const response = await api
        .post("/api/product-variants")
        .set(auth)
        .send({ productId, sku, size, color: "海军蓝", priceCents: 1000 });
      expect(response.status).toBe(201);
      return (response.body as ApiResponse<{ id: string }>).data.id;
    };
    const smallId = await createVariant(productId, "SHARED-S", "S");
    const largeId = await createVariant(productId, "SHARED-L", "L");
    const otherId = await createVariant(otherProductId, "OTHER-M", "M");
    const source = await upload(0);
    const draftResponse = await api
      .post(`/api${adminCreateTryOnGarmentContract.path}`)
      .set(auth)
      .send({
        productId,
        colorLabel: "海军蓝",
        sourceMediaAssetId: source.id,
        template: "tshirt_short_sleeve",
      });
    expect(draftResponse.status).toBe(201);
    const draft = adminCreateTryOnGarmentContract.responseSchema.parse(
      (draftResponse.body as ApiResponse<unknown>).data,
    );
    await api
      .post(
        `/api${adminTryOnGarmentConfirmationContract.path.replace(":id", draft.id)}`,
      )
      .set(auth)
      .send({})
      .expect(201);
    await api
      .post(
        `/api${adminTryOnGarmentActivationContract.path.replace(":id", draft.id)}`,
      )
      .set(auth)
      .send({})
      .expect(201);

    const associationResponse = await api
      .put(
        `/api${adminTryOnGarmentAssociationContract.path.replace(":id", draft.id)}`,
      )
      .set(auth)
      .send({ variantIds: [smallId, largeId] });
    expect(associationResponse.status).toBe(200);
    expect(
      adminTryOnGarmentAssociationContract.responseSchema
        .parse((associationResponse.body as ApiResponse<unknown>).data)
        .associatedVariantIds.sort(),
    ).toEqual([largeId, smallId].sort());

    const confirmedAgain = await api
      .post(
        `/api${adminTryOnGarmentConfirmationContract.path.replace(":id", draft.id)}`,
      )
      .set(auth)
      .send({})
      .expect(201);
    expect(
      adminTryOnGarmentConfirmationContract.responseSchema
        .parse((confirmedAgain.body as ApiResponse<unknown>).data)
        .associatedVariantIds.sort(),
    ).toEqual([largeId, smallId].sort());
    const activeAgain = await api
      .post(
        `/api${adminTryOnGarmentActivationContract.path.replace(":id", draft.id)}`,
      )
      .set(auth)
      .send({})
      .expect(201);
    expect(
      adminTryOnGarmentActivationContract.responseSchema
        .parse((activeAgain.body as ApiResponse<unknown>).data)
        .associatedVariantIds.sort(),
    ).toEqual([largeId, smallId].sort());

    // Two real requests race on the same row.  The composite FK makes either
    // scheduling order safe: PATCH can never publish a cross-product pointer.
    const [concurrentAssociation, moveAssociatedVariantResponse] =
      await Promise.all([
        api
          .put(
            `/api${adminTryOnGarmentAssociationContract.path.replace(":id", draft.id)}`,
          )
          .set(auth)
          .send({ variantIds: [smallId, largeId] }),
        api
          .patch(`/api/product-variants/${smallId}`)
          .set(auth)
          .send({ productId: otherProductId }),
      ]);
    expect(concurrentAssociation.status).toBe(200);
    expect(moveAssociatedVariantResponse.status).toBe(400);
    expect(
      (
        await api
          .get(
            `/api${adminGetTryOnGarmentContract.path.replace(":id", draft.id)}`,
          )
          .set(auth)
          .expect(200)
      ).body as ApiResponse<unknown>,
    ).toMatchObject({
      data: {
        associatedVariantIds: expect.arrayContaining([smallId, largeId]),
      },
    });

    const crossProductResponse = await api
      .put(
        `/api${adminTryOnGarmentAssociationContract.path.replace(":id", draft.id)}`,
      )
      .set(auth)
      .send({ variantIds: [smallId, otherId] });
    expect(crossProductResponse.status).toBe(400);
    expect((crossProductResponse.body as ApiResponse<unknown>).message).toBe(
      "TRY_ON_GARMENT_VARIANT_PRODUCT_MISMATCH",
    );
    const afterRejectedAssociation = await api
      .get(`/api${adminGetTryOnGarmentContract.path.replace(":id", draft.id)}`)
      .set(auth);
    expect(
      adminGetTryOnGarmentContract.responseSchema
        .parse((afterRejectedAssociation.body as ApiResponse<unknown>).data)
        .associatedVariantIds.sort(),
    ).toEqual([largeId, smallId].sort());

    // A second immutable asset may have the same validated pixels; replacement
    // is about atomically switching the shared source identity and template.
    const replacement = await upload(0);
    const replacementResponse = await api
      .patch(
        `/api${adminTryOnGarmentSourceReplacementContract.path.replace(":id", draft.id)}`,
      )
      .set(auth)
      .send({
        sourceMediaAssetId: replacement.id,
        template: "tshirt_long_sleeve",
      });
    expect(replacementResponse.status).toBe(200);
    expect(
      adminTryOnGarmentSourceReplacementContract.responseSchema.parse(
        (replacementResponse.body as ApiResponse<unknown>).data,
      ),
    ).toMatchObject({
      sourceMediaAsset: { id: replacement.id },
      template: "tshirt_long_sleeve",
      associatedVariantIds: expect.arrayContaining([smallId, largeId]),
    });
    const sourceReplacementAudit = await api
      .get(`/api/audit-logs?resourceId=${draft.id}&page=1&pageSize=20`)
      .set(auth)
      .expect(200);
    expect(
      (
        sourceReplacementAudit.body as ApiResponse<{
          items: Array<{
            action: string;
            beforeJson: Record<string, unknown> | null;
            afterJson: Record<string, unknown> | null;
          }>;
        }>
      ).data.items.find(
        (item) => item.action === "try_on_garments.source.replace",
      ),
    ).toMatchObject({
      beforeJson: {
        sourceMediaAssetId: source.id,
        template: "tshirt_short_sleeve",
      },
      afterJson: {
        sourceMediaAssetId: replacement.id,
        template: "tshirt_long_sleeve",
      },
    });
    const invalidReplacement = await api
      .patch(
        `/api${adminTryOnGarmentSourceReplacementContract.path.replace(":id", draft.id)}`,
      )
      .set(auth)
      .send({
        sourceMediaAssetId: "550e8400-e29b-41d4-a716-446655440999",
        template: "tshirt_short_sleeve",
      });
    expect(invalidReplacement.status).toBe(400);
    const afterRejectedReplacement = await api
      .get(`/api${adminGetTryOnGarmentContract.path.replace(":id", draft.id)}`)
      .set(auth);
    expect(
      adminGetTryOnGarmentContract.responseSchema.parse(
        (afterRejectedReplacement.body as ApiResponse<unknown>).data,
      ),
    ).toMatchObject({
      sourceMediaAsset: { id: replacement.id },
      template: "tshirt_long_sleeve",
      associatedVariantIds: expect.arrayContaining([smallId, largeId]),
    });

    const retirementWithAssociations = await api
      .post(
        `/api${adminTryOnGarmentRetirementContract.path.replace(":id", draft.id)}`,
      )
      .set(auth)
      .send({});
    expect(retirementWithAssociations.status).toBe(201);
    expect(
      adminTryOnGarmentRetirementContract.responseSchema
        .parse((retirementWithAssociations.body as ApiResponse<unknown>).data)
        .associatedVariantIds.sort(),
    ).toEqual([largeId, smallId].sort());

    const clearAssociations = await api
      .put(
        `/api${adminTryOnGarmentAssociationContract.path.replace(":id", draft.id)}`,
      )
      .set(auth)
      .send({ variantIds: [] });
    expect(clearAssociations.status).toBe(200);
    expect(
      adminTryOnGarmentAssociationContract.responseSchema.parse(
        (clearAssociations.body as ApiResponse<unknown>).data,
      ).associatedVariantIds,
    ).toEqual([]);
  }, 60_000);

  it("projects only an active confirmed explicit association at the authenticated machine catalog boundary", async () => {
    const token = await loginAndGetToken(api, appConfig);
    const auth = { Authorization: `Bearer ${token}` };
    const seeded = await seedSingleSlotInventory(db, {
      machineCode: `M-TRY-ON-CATALOG-${Date.now().toString(36)}`,
      onHandQty: 1,
      lowStockThreshold: 0,
      rowNo: 1,
      cellNo: 1,
    });
    const [inventory] = await db.client
      .select({ variantId: inventories.variantId })
      .from(inventories)
      .where(eq(inventories.id, seeded.inventoryId));
    const [variant] = await db.client
      .select({ productId: productVariants.productId })
      .from(productVariants)
      .where(eq(productVariants.id, inventory.variantId));
    const uploadResponse = await api
      .post(`/api${adminTryOnGarmentUploadContract.path}`)
      .set(auth)
      .attach("file", rgbaPng(768, 1024, 0), {
        filename: "catalog-garment.png",
        contentType: "image/png",
      })
      .expect(201);
    const source = adminTryOnGarmentUploadContract.responseSchema.parse(
      (uploadResponse.body as ApiResponse<unknown>).data,
    );
    const draftResponse = await api
      .post(`/api${adminCreateTryOnGarmentContract.path}`)
      .set(auth)
      .send({
        productId: variant.productId,
        colorLabel: "黑色",
        sourceMediaAssetId: source.id,
        template: "tshirt_short_sleeve",
      })
      .expect(201);
    const draft = adminCreateTryOnGarmentContract.responseSchema.parse(
      (draftResponse.body as ApiResponse<unknown>).data,
    );
    const machineAuth = await getMachineAuthHeader(
      api,
      seeded.machineCode,
      seeded.machineSecret,
    );
    const readCatalog = async () =>
      await api
        .get(`/api/machines/${seeded.machineCode}/catalog`)
        .set(machineAuth)
        .expect(200);

    const draftCatalog = await readCatalog();
    expect(
      (draftCatalog.body as ApiResponse<Array<Record<string, unknown>>>)
        .data[0],
    ).not.toHaveProperty("tryOnGarmentMedia");

    await api
      .post(
        `/api${adminTryOnGarmentConfirmationContract.path.replace(":id", draft.id)}`,
      )
      .set(auth)
      .send({})
      .expect(201);
    await api
      .post(
        `/api${adminTryOnGarmentActivationContract.path.replace(":id", draft.id)}`,
      )
      .set(auth)
      .send({})
      .expect(201);
    const stillUnassociated = await readCatalog();
    expect(
      (stillUnassociated.body as ApiResponse<Array<Record<string, unknown>>>)
        .data[0],
    ).not.toHaveProperty("tryOnGarmentMedia");

    await api
      .put(
        `/api${adminTryOnGarmentAssociationContract.path.replace(":id", draft.id)}`,
      )
      .set(auth)
      .send({ variantIds: [inventory.variantId] })
      .expect(200);
    const eligibleCatalog = await readCatalog();
    expect(
      (eligibleCatalog.body as ApiResponse<Array<Record<string, unknown>>>)
        .data[0],
    ).toMatchObject({
      variantId: inventory.variantId,
      tryOnGarmentMedia: {
        id: source.id,
        purpose: "try_on_garment",
        reference: `/api/media-assets/${source.id}/content`,
      },
      tryOnGarmentTemplate: "tshirt_short_sleeve",
    });

    await api
      .post(
        `/api${adminTryOnGarmentRetirementContract.path.replace(":id", draft.id)}`,
      )
      .set(auth)
      .send({})
      .expect(201);
    const retiredCatalog = await readCatalog();
    expect(
      (retiredCatalog.body as ApiResponse<Array<Record<string, unknown>>>)
        .data[0],
    ).not.toHaveProperty("tryOnGarmentMedia");

    const longSourceResponse = await api
      .post(`/api${adminTryOnGarmentUploadContract.path}`)
      .set(auth)
      .attach("file", rgbaPng(768, 1024, 1), {
        filename: "catalog-garment-long.png",
        contentType: "image/png",
      })
      .expect(201);
    const longSource = adminTryOnGarmentUploadContract.responseSchema.parse(
      (longSourceResponse.body as ApiResponse<unknown>).data,
    );
    const longDraftResponse = await api
      .post(`/api${adminCreateTryOnGarmentContract.path}`)
      .set(auth)
      .send({
        productId: variant.productId,
        colorLabel: "黑色长袖",
        sourceMediaAssetId: longSource.id,
        template: "tshirt_long_sleeve",
      })
      .expect(201);
    const longDraft = adminCreateTryOnGarmentContract.responseSchema.parse(
      (longDraftResponse.body as ApiResponse<unknown>).data,
    );
    await api
      .post(
        `/api${adminTryOnGarmentConfirmationContract.path.replace(":id", longDraft.id)}`,
      )
      .set(auth)
      .send({})
      .expect(201);
    await api
      .post(
        `/api${adminTryOnGarmentActivationContract.path.replace(":id", longDraft.id)}`,
      )
      .set(auth)
      .send({})
      .expect(201);
    await api
      .put(
        `/api${adminTryOnGarmentAssociationContract.path.replace(":id", longDraft.id)}`,
      )
      .set(auth)
      .send({ variantIds: [inventory.variantId] })
      .expect(200);
    const longEligibleCatalog = await readCatalog();
    expect(
      (longEligibleCatalog.body as ApiResponse<Array<Record<string, unknown>>>)
        .data[0],
    ).toMatchObject({
      variantId: inventory.variantId,
      tryOnGarmentMedia: {
        id: longSource.id,
        purpose: "try_on_garment",
        reference: `/api/media-assets/${longSource.id}/content`,
      },
      tryOnGarmentTemplate: "tshirt_long_sleeve",
    });
  }, 60_000);

  it("serializes concurrent replacement sets for one shared garment", async () => {
    const token = await loginAndGetToken(api, appConfig);
    const auth = { Authorization: `Bearer ${token}` };
    const createProduct = async (name: string) => {
      const response = await api
        .post("/api/products")
        .set(auth)
        .send({ name, status: "draft", sortOrder: 0 })
        .expect(201);
      return (response.body as ApiResponse<{ id: string }>).data.id;
    };
    const productId = await createProduct("并发关联事务商品");
    const createVariant = async (sku: string) => {
      const response = await api
        .post("/api/product-variants")
        .set(auth)
        .send({ productId, sku, priceCents: 1000 })
        .expect(201);
      return (response.body as ApiResponse<{ id: string }>).data.id;
    };
    const firstVariantId = await createVariant("RACE-ASSOCIATION-S");
    const secondVariantId = await createVariant("RACE-ASSOCIATION-L");
    const sourceResponse = await api
      .post(`/api${adminTryOnGarmentUploadContract.path}`)
      .set(auth)
      .attach("file", rgbaPng(768, 1024, 0), {
        filename: "race-garment.png",
        contentType: "image/png",
      })
      .expect(201);
    const source = adminTryOnGarmentUploadContract.responseSchema.parse(
      (sourceResponse.body as ApiResponse<unknown>).data,
    );
    const draftResponse = await api
      .post(`/api${adminCreateTryOnGarmentContract.path}`)
      .set(auth)
      .send({
        productId,
        colorLabel: "黑色",
        sourceMediaAssetId: source.id,
        template: "tshirt_short_sleeve",
      })
      .expect(201);
    const draft = adminCreateTryOnGarmentContract.responseSchema.parse(
      (draftResponse.body as ApiResponse<unknown>).data,
    );
    const associationPath = `/api${adminTryOnGarmentAssociationContract.path.replace(":id", draft.id)}`;

    const [first, second] = await Promise.all([
      api
        .put(associationPath)
        .set(auth)
        .send({ variantIds: [firstVariantId] }),
      api
        .put(associationPath)
        .set(auth)
        .send({ variantIds: [secondVariantId] }),
    ]);
    expect([first.status, second.status]).toEqual([200, 200]);
    const finalResponse = await api
      .get(`/api${adminGetTryOnGarmentContract.path.replace(":id", draft.id)}`)
      .set(auth)
      .expect(200);
    const finalAssociations = adminGetTryOnGarmentContract.responseSchema.parse(
      (finalResponse.body as ApiResponse<unknown>).data,
    ).associatedVariantIds;
    expect([[firstVariantId], [secondVariantId]]).toContainEqual(
      finalAssociations,
    );
  }, 60_000);

  it("rejects a stale activation after another operator activates then retires the garment", async () => {
    const token = await loginAndGetToken(api, appConfig);
    const auth = { Authorization: `Bearer ${token}` };
    const productResponse = await api
      .post("/api/products")
      .set(auth)
      .send({ name: "迟到激活隔离商品", status: "draft", sortOrder: 0 })
      .expect(201);
    const productId = (productResponse.body as ApiResponse<{ id: string }>).data
      .id;
    const uploadResponse = await api
      .post(`/api${adminTryOnGarmentUploadContract.path}`)
      .set(auth)
      .attach("file", rgbaPng(768, 1024, 0), {
        filename: "lifecycle-barrier.png",
        contentType: "image/png",
      })
      .expect(201);
    const source = adminTryOnGarmentUploadContract.responseSchema.parse(
      (uploadResponse.body as ApiResponse<unknown>).data,
    );
    const draftResponse = await api
      .post(`/api${adminCreateTryOnGarmentContract.path}`)
      .set(auth)
      .send({
        productId,
        colorLabel: "黑色",
        sourceMediaAssetId: source.id,
        template: "tshirt_short_sleeve",
      })
      .expect(201);
    const draft = adminCreateTryOnGarmentContract.responseSchema.parse(
      (draftResponse.body as ApiResponse<unknown>).data,
    );
    await api
      .post(
        `/api${adminTryOnGarmentConfirmationContract.path.replace(":id", draft.id)}`,
      )
      .set(auth)
      .send({})
      .expect(201);

    const service = app.get(TryOnGarmentsService);
    const originalGetById = service.getById.bind(service);
    const activationRead = deferred<void>();
    const resumeActivation = deferred<void>();
    let pauseOnce = true;
    const getById = vi
      .spyOn(service, "getById")
      .mockImplementation(async (id) => {
        const garment = await originalGetById(id);
        if (pauseOnce) {
          pauseOnce = false;
          activationRead.resolve();
          await resumeActivation.promise;
        }
        return garment;
      });

    try {
      const lateActivation = api
        .post(
          `/api${adminTryOnGarmentActivationContract.path.replace(":id", draft.id)}`,
        )
        .set(auth)
        .send({})
        .then((response) => response);
      await activationRead.promise;
      await api
        .post(
          `/api${adminTryOnGarmentActivationContract.path.replace(":id", draft.id)}`,
        )
        .set(auth)
        .send({})
        .expect(201);
      await api
        .post(
          `/api${adminTryOnGarmentRetirementContract.path.replace(":id", draft.id)}`,
        )
        .set(auth)
        .send({})
        .expect(201);
      resumeActivation.resolve();

      const staleResponse = await lateActivation;
      expect(staleResponse.status).toBe(400);
      expect((staleResponse.body as ApiResponse<unknown>).message).toBe(
        "TRY_ON_GARMENT_ACTIVATION_INVALID",
      );
      const finalResponse = await api
        .get(
          `/api${adminGetTryOnGarmentContract.path.replace(":id", draft.id)}`,
        )
        .set(auth)
        .expect(200);
      expect(
        adminGetTryOnGarmentContract.responseSchema.parse(
          (finalResponse.body as ApiResponse<unknown>).data,
        ).status,
      ).toBe("retired");
    } finally {
      getById.mockRestore();
    }
  }, 60_000);

  it("treats a stale retirement as the stable retired idempotency result", async () => {
    const token = await loginAndGetToken(api, appConfig);
    const auth = { Authorization: `Bearer ${token}` };
    const product = await api
      .post("/api/products")
      .set(auth)
      .send({ name: "迟到退休隔离商品", status: "draft", sortOrder: 0 })
      .expect(201);
    const productId = (product.body as ApiResponse<{ id: string }>).data.id;
    const upload = await api
      .post(`/api${adminTryOnGarmentUploadContract.path}`)
      .set(auth)
      .attach("file", rgbaPng(768, 1024, 0), {
        filename: "late-retirement.png",
        contentType: "image/png",
      })
      .expect(201);
    const source = adminTryOnGarmentUploadContract.responseSchema.parse(
      (upload.body as ApiResponse<unknown>).data,
    );
    const created = await api
      .post(`/api${adminCreateTryOnGarmentContract.path}`)
      .set(auth)
      .send({
        productId,
        colorLabel: "黑色",
        sourceMediaAssetId: source.id,
        template: "tshirt_short_sleeve",
      })
      .expect(201);
    const garment = adminCreateTryOnGarmentContract.responseSchema.parse(
      (created.body as ApiResponse<unknown>).data,
    );
    const confirmationPath = `/api${adminTryOnGarmentConfirmationContract.path.replace(":id", garment.id)}`;
    const activationPath = `/api${adminTryOnGarmentActivationContract.path.replace(":id", garment.id)}`;
    const retirementPath = `/api${adminTryOnGarmentRetirementContract.path.replace(":id", garment.id)}`;
    await api.post(confirmationPath).set(auth).send({}).expect(201);
    await api.post(activationPath).set(auth).send({}).expect(201);

    const service = app.get(TryOnGarmentsService);
    const originalGetById = service.getById.bind(service);
    const retirementRead = deferred<void>();
    const resumeRetirement = deferred<void>();
    let pauseOnce = true;
    const getById = vi
      .spyOn(service, "getById")
      .mockImplementation(async (id) => {
        const current = await originalGetById(id);
        if (pauseOnce) {
          pauseOnce = false;
          retirementRead.resolve();
          await resumeRetirement.promise;
        }
        return current;
      });
    try {
      const lateRetirement = api
        .post(retirementPath)
        .set(auth)
        .send({})
        .then((response) => response);
      await retirementRead.promise;
      await api.post(retirementPath).set(auth).send({}).expect(201);
      resumeRetirement.resolve();
      const idempotentResponse = await lateRetirement;
      expect(idempotentResponse.status).toBe(201);
      expect(
        adminTryOnGarmentRetirementContract.responseSchema.parse(
          (idempotentResponse.body as ApiResponse<unknown>).data,
        ).status,
      ).toBe("retired");
    } finally {
      getById.mockRestore();
    }
  }, 60_000);

  it.each(["activate", "retire"] as const)(
    "returns the source committed after its %s pre-read",
    async (action) => {
      const token = await loginAndGetToken(api, appConfig);
      const auth = { Authorization: `Bearer ${token}` };
      const product = await api
        .post("/api/products")
        .set(auth)
        .send({
          name: `生命周期来源快照-${action}`,
          status: "draft",
          sortOrder: 0,
        })
        .expect(201);
      const productId = (product.body as ApiResponse<{ id: string }>).data.id;
      const upload = async (name: string) => {
        const response = await api
          .post(`/api${adminTryOnGarmentUploadContract.path}`)
          .set(auth)
          .attach("file", rgbaPng(768, 1024, 0), {
            filename: name,
            contentType: "image/png",
          })
          .expect(201);
        return adminTryOnGarmentUploadContract.responseSchema.parse(
          (response.body as ApiResponse<unknown>).data,
        );
      };
      const sourceA = await upload(`${action}-a.png`);
      const created = await api
        .post(`/api${adminCreateTryOnGarmentContract.path}`)
        .set(auth)
        .send({
          productId,
          colorLabel: "黑色",
          sourceMediaAssetId: sourceA.id,
          template: "tshirt_short_sleeve",
        })
        .expect(201);
      const garment = adminCreateTryOnGarmentContract.responseSchema.parse(
        (created.body as ApiResponse<unknown>).data,
      );
      const confirmationPath = `/api${adminTryOnGarmentConfirmationContract.path.replace(":id", garment.id)}`;
      const activationPath = `/api${adminTryOnGarmentActivationContract.path.replace(":id", garment.id)}`;
      const retirementPath = `/api${adminTryOnGarmentRetirementContract.path.replace(":id", garment.id)}`;
      await api.post(confirmationPath).set(auth).send({}).expect(201);
      if (action === "retire") {
        await api.post(activationPath).set(auth).send({}).expect(201);
      }
      const path = action === "activate" ? activationPath : retirementPath;
      const expectedStatus = action === "activate" ? "active" : "retired";
      const service = app.get(TryOnGarmentsService);
      const originalGetById = service.getById.bind(service);
      const preRead = deferred<void>();
      const resume = deferred<void>();
      let pauseOnce = true;
      const getById = vi
        .spyOn(service, "getById")
        .mockImplementation(async (id) => {
          const current = await originalGetById(id);
          if (pauseOnce) {
            pauseOnce = false;
            preRead.resolve();
            await resume.promise;
          }
          return current;
        });
      try {
        const lifecycle = api
          .post(path)
          .set(auth)
          .send({})
          .then((response) => response);
        await preRead.promise;
        const sourceB = await upload(`${action}-b.png`);
        await api
          .patch(
            `/api${adminTryOnGarmentSourceReplacementContract.path.replace(":id", garment.id)}`,
          )
          .set(auth)
          .send({
            sourceMediaAssetId: sourceB.id,
            template: "tshirt_long_sleeve",
          })
          .expect(200);
        resume.resolve();
        const response = await lifecycle;
        expect(response.status).toBe(201);
        expect((response.body as ApiResponse<unknown>).data).toMatchObject({
          status: expectedStatus,
          sourceMediaAsset: { id: sourceB.id },
          template: "tshirt_long_sleeve",
        });
        const finalState = await api
          .get(
            `/api${adminGetTryOnGarmentContract.path.replace(":id", garment.id)}`,
          )
          .set(auth)
          .expect(200);
        expect((finalState.body as ApiResponse<unknown>).data).toMatchObject({
          status: expectedStatus,
          sourceMediaAsset: { id: sourceB.id },
          template: "tshirt_long_sleeve",
        });
      } finally {
        getById.mockRestore();
      }
    },
    60_000,
  );

  it("linearizes concurrent confirmation and keeps late confirmations idempotent", async () => {
    const token = await loginAndGetToken(api, appConfig);
    const auth = { Authorization: `Bearer ${token}` };
    const product = await api
      .post("/api/products")
      .set(auth)
      .send({ name: "确认线性化商品", status: "draft", sortOrder: 0 })
      .expect(201);
    const productId = (product.body as ApiResponse<{ id: string }>).data.id;
    const upload = await api
      .post(`/api${adminTryOnGarmentUploadContract.path}`)
      .set(auth)
      .attach("file", rgbaPng(768, 1024, 0), {
        filename: "confirmation-race.png",
        contentType: "image/png",
      })
      .expect(201);
    const source = adminTryOnGarmentUploadContract.responseSchema.parse(
      (upload.body as ApiResponse<unknown>).data,
    );
    const created = await api
      .post(`/api${adminCreateTryOnGarmentContract.path}`)
      .set(auth)
      .send({
        productId,
        colorLabel: "紫色",
        sourceMediaAssetId: source.id,
        template: "tshirt_short_sleeve",
      })
      .expect(201);
    const garment = adminCreateTryOnGarmentContract.responseSchema.parse(
      (created.body as ApiResponse<unknown>).data,
    );
    const confirmationPath = `/api${adminTryOnGarmentConfirmationContract.path.replace(":id", garment.id)}`;
    const first = api
      .post(confirmationPath)
      .set(auth)
      .send({})
      .then((response) => response);
    const second = api
      .post(confirmationPath)
      .set(auth)
      .send({})
      .then((response) => response);
    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    expect(firstResponse.status).toBe(201);
    expect(secondResponse.status).toBe(201);
    const firstConfirmed =
      adminTryOnGarmentConfirmationContract.responseSchema.parse(
        (firstResponse.body as ApiResponse<unknown>).data,
      );
    const secondConfirmed =
      adminTryOnGarmentConfirmationContract.responseSchema.parse(
        (secondResponse.body as ApiResponse<unknown>).data,
      );
    expect(firstConfirmed.confirmedAt).toEqual(secondConfirmed.confirmedAt);

    const countConfirmAudits = async () => {
      const audits = await api
        .get(`/api/audit-logs?resourceId=${garment.id}&page=1&pageSize=100`)
        .set(auth)
        .expect(200);
      return (
        audits.body as ApiResponse<{
          items: Array<{ action: string }>;
        }>
      ).data.items.filter(
        (entry) => entry.action === "try_on_garments.source.confirm",
      ).length;
    };
    expect(await countConfirmAudits()).toBe(1);
    const activated = await api
      .post(
        `/api${adminTryOnGarmentActivationContract.path.replace(":id", garment.id)}`,
      )
      .set(auth)
      .send({})
      .expect(201);
    expect(
      adminTryOnGarmentActivationContract.responseSchema.parse(
        (activated.body as ApiResponse<unknown>).data,
      ).confirmedAt,
    ).toEqual(firstConfirmed.confirmedAt);
    const activeLateConfirmation = await api
      .post(confirmationPath)
      .set(auth)
      .send({})
      .expect(201);
    expect(
      adminTryOnGarmentConfirmationContract.responseSchema.parse(
        (activeLateConfirmation.body as ApiResponse<unknown>).data,
      ),
    ).toMatchObject({
      status: "active",
      confirmedAt: firstConfirmed.confirmedAt,
    });
    expect(await countConfirmAudits()).toBe(1);

    await api
      .post(
        `/api${adminTryOnGarmentRetirementContract.path.replace(":id", garment.id)}`,
      )
      .set(auth)
      .send({})
      .expect(201);
    const retiredLateConfirmation = await api
      .post(confirmationPath)
      .set(auth)
      .send({})
      .expect(201);
    expect(
      adminTryOnGarmentConfirmationContract.responseSchema.parse(
        (retiredLateConfirmation.body as ApiResponse<unknown>).data,
      ),
    ).toMatchObject({
      status: "retired",
      confirmedAt: firstConfirmed.confirmedAt,
    });
    expect(await countConfirmAudits()).toBe(1);
  }, 60_000);

  it("returns the locked current source and association snapshot for a stale confirmed read", async () => {
    const token = await loginAndGetToken(api, appConfig);
    const auth = { Authorization: `Bearer ${token}` };
    const product = await api
      .post("/api/products")
      .set(auth)
      .send({ name: "确认快照锁商品", status: "draft", sortOrder: 0 })
      .expect(201);
    const productId = (product.body as ApiResponse<{ id: string }>).data.id;
    const createVariant = async (sku: string, size: string) => {
      const response = await api
        .post("/api/product-variants")
        .set(auth)
        .send({ productId, sku, size, color: "蓝色", priceCents: 1000 })
        .expect(201);
      return (response.body as ApiResponse<{ id: string }>).data.id;
    };
    const source = async (name: string) => {
      const response = await api
        .post(`/api${adminTryOnGarmentUploadContract.path}`)
        .set(auth)
        .attach("file", rgbaPng(768, 1024, 0), {
          filename: name,
          contentType: "image/png",
        })
        .expect(201);
      return adminTryOnGarmentUploadContract.responseSchema.parse(
        (response.body as ApiResponse<unknown>).data,
      );
    };
    const smallId = await createVariant("CONFIRM-S", "S");
    const largeId = await createVariant("CONFIRM-L", "L");
    const sourceA = await source("confirm-source-a.png");
    const created = await api
      .post(`/api${adminCreateTryOnGarmentContract.path}`)
      .set(auth)
      .send({
        productId,
        colorLabel: "蓝色",
        sourceMediaAssetId: sourceA.id,
        template: "tshirt_short_sleeve",
      })
      .expect(201);
    const garment = adminCreateTryOnGarmentContract.responseSchema.parse(
      (created.body as ApiResponse<unknown>).data,
    );
    const confirmationPath = `/api${adminTryOnGarmentConfirmationContract.path.replace(":id", garment.id)}`;
    await api.post(confirmationPath).set(auth).send({}).expect(201);
    await api
      .post(
        `/api${adminTryOnGarmentActivationContract.path.replace(":id", garment.id)}`,
      )
      .set(auth)
      .send({})
      .expect(201);
    await api
      .put(
        `/api${adminTryOnGarmentAssociationContract.path.replace(":id", garment.id)}`,
      )
      .set(auth)
      .send({ variantIds: [smallId] })
      .expect(200);

    const sourceB = await source("confirm-source-b.png");
    const mutationReady = deferred<void>();
    const commitMutation = deferred<void>();
    const mutation = db.client.transaction(async (tx) => {
      await tx
        .select({ id: tryOnGarments.id })
        .from(tryOnGarments)
        .where(eq(tryOnGarments.id, garment.id))
        .for("update", { of: tryOnGarments });
      await tx
        .update(tryOnGarments)
        .set({
          sourceMediaAssetId: sourceB.id,
          template: "tshirt_long_sleeve",
          updatedAt: new Date(),
        })
        .where(eq(tryOnGarments.id, garment.id));
      await tx
        .update(productVariants)
        .set({ tryOnGarmentId: null, updatedAt: new Date() })
        .where(eq(productVariants.tryOnGarmentId, garment.id));
      await tx
        .update(productVariants)
        .set({ tryOnGarmentId: garment.id, updatedAt: new Date() })
        .where(eq(productVariants.id, largeId));
      mutationReady.resolve();
      await commitMutation.promise;
    });
    await mutationReady.promise;
    const confirmation = api
      .post(confirmationPath)
      .set(auth)
      .send({})
      .then((response) => response);
    await new Promise<void>((resolve) => setImmediate(resolve));
    commitMutation.resolve();
    await mutation;
    const response = await confirmation;
    expect(response.status).toBe(201);
    expect(
      adminTryOnGarmentConfirmationContract.responseSchema.parse(
        (response.body as ApiResponse<unknown>).data,
      ),
    ).toMatchObject({
      status: "active",
      sourceMediaAsset: { id: sourceB.id },
      template: "tshirt_long_sleeve",
      associatedVariantIds: [largeId],
    });
  }, 60_000);

  it("caps a product at 256 garments, including concurrent final creates", async () => {
    const token = await loginAndGetToken(api, appConfig);
    const auth = { Authorization: `Bearer ${token}` };
    const product = await api
      .post("/api/products")
      .set(auth)
      .send({ name: "试衣源上限商品", status: "draft", sortOrder: 0 })
      .expect(201);
    const productId = (product.body as ApiResponse<{ id: string }>).data.id;
    const upload = await api
      .post(`/api${adminTryOnGarmentUploadContract.path}`)
      .set(auth)
      .attach("file", rgbaPng(768, 1024, 0), {
        filename: "capacity-garment.png",
        contentType: "image/png",
      })
      .expect(201);
    const source = adminTryOnGarmentUploadContract.responseSchema.parse(
      (upload.body as ApiResponse<unknown>).data,
    );
    const create = (colorLabel: string) =>
      api.post(`/api${adminCreateTryOnGarmentContract.path}`).set(auth).send({
        productId,
        colorLabel,
        sourceMediaAssetId: source.id,
        template: "tshirt_short_sleeve",
      });

    for (let index = 0; index < 255; index += 1) {
      // Deliberately establish the exact pre-race boundary without flooding
      // the HTTP test server; only the final two creates race.
      // oxlint-disable-next-line no-await-in-loop
      await create(`容量-${index}`).expect(201);
    }
    const finalCreates = await Promise.all([
      create("并发-A"),
      create("并发-B"),
    ]);
    expect(
      finalCreates
        .map((response) => response.status)
        .sort((left, right) => left - right),
    ).toEqual([201, 400]);
    expect(
      finalCreates.find((response) => response.status === 400)?.body,
    ).toMatchObject({ message: "TRY_ON_GARMENT_PRODUCT_CAPACITY_REACHED" });
    const listed = await api
      .get(`/api${adminListTryOnGarmentsByProductContract.path}`)
      .set(auth)
      .query({ productId })
      .expect(200);
    expect(
      adminListTryOnGarmentsByProductContract.responseSchema.parse(
        (listed.body as ApiResponse<unknown>).data,
      ),
    ).toHaveLength(256);
  }, 90_000);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

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
  if (alpha === 0) {
    for (
      let row = Math.floor(height / 4);
      row < Math.ceil((height * 3) / 4);
      row += 1
    ) {
      const offset = row * (width * 4 + 1);
      for (
        let pixel = Math.floor(width / 4);
        pixel < Math.ceil((width * 3) / 4);
        pixel += 1
      ) {
        const pixelOffset = offset + 1 + pixel * 4;
        pixels[pixelOffset] = 20;
        pixels[pixelOffset + 1] = 50;
        pixels[pixelOffset + 2] = 180;
        pixels[pixelOffset + 3] = 255;
      }
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
