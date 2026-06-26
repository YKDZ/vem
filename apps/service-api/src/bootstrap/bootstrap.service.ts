import { Inject, Injectable, OnModuleInit } from "@nestjs/common";
import {
  adminUserRoles,
  adminUsers,
  and,
  eq,
  paymentProviders,
  permissions,
  productCategories,
  products,
  productVariants,
  rolePermissions,
  roles,
  isNull,
  type DrizzleClient,
} from "@vem/db";
import { permissionCodes } from "@vem/shared";

import { PasswordService } from "../auth/password.service";
import { AppConfigService } from "../config/app-config.service";
import { DRIZZLE_CLIENT } from "../database/database.constants";

type CatalogSeedProduct = {
  name: string;
  category: string;
  description: string;
  sortOrder: number;
  variants: {
    sku: string;
    size: string;
    color: string;
    barcode: string;
    targetGender: "male" | "female" | null;
    priceCents: number;
    costCents: number;
  }[];
};

type ProductLineSeed = {
  category: "袜子" | "内裤" | "T恤";
  name: string;
  description: string;
  sortOrder: number;
  skuPrefix: string;
  colors: readonly VariantOption[];
  sizes: readonly VariantOption[];
  targetGender: "male" | "female" | null;
  priceCents: number;
  costCents: number;
};

type VariantOption = {
  code: string;
  label: string;
};

const oneSize: readonly VariantOption[] = [{ code: "REG", label: "常规码" }];

const standardSizes: readonly VariantOption[] = [
  { code: "S", label: "小码" },
  { code: "M", label: "中码" },
  { code: "L", label: "大码" },
];

const threeColors: readonly VariantOption[] = [
  { code: "BLK", label: "黑色" },
  { code: "WHT", label: "白色" },
  { code: "GRY", label: "灰色" },
];

const fiveColors: readonly VariantOption[] = [
  ...threeColors,
  { code: "NVY", label: "藏青色" },
  { code: "BGE", label: "肤色" },
];

const sevenColors: readonly VariantOption[] = [
  ...fiveColors,
  { code: "BLU", label: "蓝色" },
  { code: "PNK", label: "粉色" },
];

function productLine(input: ProductLineSeed): CatalogSeedProduct {
  return {
    name: input.name,
    category: input.category,
    description: input.description,
    sortOrder: input.sortOrder,
    variants: input.colors.flatMap((color) =>
      input.sizes.map((size, index) => ({
        sku: `${input.skuPrefix}-${color.code}-${size.code}`,
        size: size.label,
        color: color.label,
        barcode: `${input.skuPrefix}-${color.code}-${size.code}`,
        targetGender: input.targetGender,
        priceCents: input.priceCents,
        costCents: input.costCents + index,
      })),
    ),
  };
}

const sockSeries = [
  { code: "SPORT", label: "运动袜" },
  { code: "BIZ", label: "商务袜" },
  { code: "CASUAL", label: "休闲袜" },
  { code: "FASHION", label: "时尚潮袜" },
] as const;

const middleUnderwearSeries = [
  { code: "FASHION", label: "时尚" },
  { code: "FORMAL", label: "正装" },
  { code: "SPORT", label: "运动" },
  { code: "BIZ", label: "商务" },
] as const;

const catalogSeedProducts: CatalogSeedProduct[] = [
  ...sockSeries.flatMap((series, seriesIndex) =>
    [
      { code: "M", label: "男士", targetGender: "male" as const },
      { code: "F", label: "女士", targetGender: "female" as const },
    ].map((gender, genderIndex) =>
      productLine({
        category: "袜子",
        name: `唐诗村${gender.label}${series.label}`,
        description: `唐诗村${gender.label}${series.label}，来自企业方商品清单。`,
        sortOrder: 100 + seriesIndex * 10 + genderIndex,
        skuPrefix: `TSC-SOCK-${gender.code}-${series.code}`,
        colors: threeColors,
        sizes: oneSize,
        targetGender: gender.targetGender,
        priceCents: 3900,
        costCents: 1500,
      }),
    ),
  ),
  ...[
    {
      code: "GIRL",
      label: "女童",
      targetGender: "female" as const,
    },
    {
      code: "BOY",
      label: "男童",
      targetGender: "male" as const,
    },
  ].map((group, index) =>
    productLine({
      category: "内裤",
      name: `唐诗村${group.label}内裤`,
      description: `唐诗村${group.label}儿童内裤，来自企业方商品清单。`,
      sortOrder: 200 + index,
      skuPrefix: `TSC-UND-KID-${group.code}`,
      colors: sevenColors,
      sizes: standardSizes,
      targetGender: group.targetGender,
      priceCents: 6900,
      costCents: 3000,
    }),
  ),
  ...[
    {
      genderCode: "M",
      genderLabel: "男士",
      ageGroups: [
        { code: "YOUTH", label: "青年" },
        { code: "ADULT", label: "成年" },
      ],
      targetGender: "male" as const,
    },
    {
      genderCode: "F",
      genderLabel: "女士",
      ageGroups: [
        { code: "YOUTH", label: "少女" },
        { code: "ADULT", label: "成年" },
      ],
      targetGender: "female" as const,
    },
  ].flatMap((gender, genderIndex) =>
    gender.ageGroups.flatMap((ageGroup, ageIndex) =>
      middleUnderwearSeries.map((series, seriesIndex) =>
        productLine({
          category: "内裤",
          name: `唐诗村${gender.genderLabel}${ageGroup.label}${series.label}内裤`,
          description: `唐诗村中年${gender.genderLabel}${ageGroup.label}${series.label}内裤，来自企业方商品清单。`,
          sortOrder: 300 + genderIndex * 100 + ageIndex * 40 + seriesIndex * 5,
          skuPrefix: `TSC-UND-MID-${gender.genderCode}-${ageGroup.code}-${series.code}`,
          colors: fiveColors,
          sizes: standardSizes,
          targetGender: gender.targetGender,
          priceCents: 6900,
          costCents: 3000,
        }),
      ),
    ),
  ),
  ...[
    {
      code: "M-OUTDOOR",
      label: "男士户外",
      targetGender: "male" as const,
    },
    {
      code: "F-DAILY",
      label: "女士日常",
      targetGender: "female" as const,
    },
  ].map((group, index) =>
    productLine({
      category: "内裤",
      name: `唐诗村老年${group.label}内裤`,
      description: `唐诗村老年${group.label}内裤，来自企业方商品清单。`,
      sortOrder: 500 + index,
      skuPrefix: `TSC-UND-ELDER-${group.code}`,
      colors: threeColors,
      sizes: standardSizes,
      targetGender: group.targetGender,
      priceCents: 6900,
      costCents: 3000,
    }),
  ),
  ...[
    {
      code: "GIRL-SS",
      label: "女童短袖",
      targetGender: "female" as const,
      colors: sevenColors,
      sortOrder: 600,
    },
    {
      code: "BOY-LS",
      label: "男童长袖",
      targetGender: "male" as const,
      colors: sevenColors,
      sortOrder: 610,
    },
    {
      code: "M-SS",
      label: "男士短袖",
      targetGender: "male" as const,
      colors: fiveColors,
      sortOrder: 700,
    },
    {
      code: "F-LS",
      label: "女士长袖",
      targetGender: "female" as const,
      colors: fiveColors,
      sortOrder: 710,
    },
    {
      code: "ELDER-M-SS",
      label: "老年男士短袖",
      targetGender: "male" as const,
      colors: threeColors,
      sortOrder: 800,
    },
    {
      code: "ELDER-F-LS",
      label: "老年女士长袖",
      targetGender: "female" as const,
      colors: threeColors,
      sortOrder: 810,
    },
  ].map((group) =>
    productLine({
      category: "T恤",
      name: `唐诗村${group.label}T恤`,
      description: `唐诗村${group.label}T恤，来自企业方商品清单。`,
      sortOrder: group.sortOrder,
      skuPrefix: `TSC-TEE-${group.code}`,
      colors: group.colors,
      sizes: standardSizes,
      targetGender: group.targetGender,
      priceCents: 5900,
      costCents: 2600,
    }),
  ),
];

@Injectable()
export class BootstrapService implements OnModuleInit {
  constructor(
    @Inject(DRIZZLE_CLIENT) private readonly db: DrizzleClient,
    @Inject(AppConfigService)
    private readonly config: AppConfigService,
    @Inject(PasswordService)
    private readonly passwordService: PasswordService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.seedPermissions();
    const superAdminRoleId = await this.seedSuperAdminRole();
    await this.seedBootstrapAdmin(superAdminRoleId);
    await this.seedMockPaymentProvider();
    await this.seedRealPaymentProviders();
    await this.seedCatalogFixtures();
  }

  private async seedPermissions(): Promise<void> {
    await this.db
      .insert(permissions)
      .values(
        permissionCodes.map((code) => ({
          code,
          name: code,
          description: code,
        })),
      )
      .onConflictDoNothing({ target: permissions.code });
  }

  private async seedSuperAdminRole(): Promise<string> {
    const [role] = await this.db
      .insert(roles)
      .values({
        code: "super_admin",
        name: "超级管理员",
        description: "所有权限",
        isBuiltin: true,
        status: "active",
      })
      .onConflictDoUpdate({
        target: roles.code,
        set: { name: "超级管理员", status: "active", updatedAt: new Date() },
      })
      .returning({ id: roles.id });

    const allPermissions = await this.db
      .select({ id: permissions.id })
      .from(permissions);
    await this.db
      .insert(rolePermissions)
      .values(
        allPermissions.map((permission) => ({
          roleId: role.id,
          permissionId: permission.id,
        })),
      )
      .onConflictDoNothing();
    return role.id;
  }

  private async seedBootstrapAdmin(roleId: string): Promise<void> {
    const username = this.config.bootstrapAdminUsername;
    const [existing] = await this.db
      .select({ id: adminUsers.id })
      .from(adminUsers)
      .where(eq(adminUsers.username, username));
    const adminId = existing?.id ?? (await this.createBootstrapAdmin(username));

    await this.db
      .insert(adminUserRoles)
      .values({ adminUserId: adminId, roleId })
      .onConflictDoNothing();
  }

  private async createBootstrapAdmin(username: string): Promise<string> {
    const [admin] = await this.db
      .insert(adminUsers)
      .values({
        username,
        passwordHash: await this.passwordService.hashPassword(
          this.config.bootstrapAdminPassword,
        ),
        displayName: "本地管理员",
        status: "active",
      })
      .returning({ id: adminUsers.id });
    return admin.id;
  }

  private async seedMockPaymentProvider(): Promise<void> {
    await this.db
      .insert(paymentProviders)
      .values({
        code: "mock",
        name: "Mock 支付",
        type: "mock",
        status: this.config.paymentMockEnabled ? "enabled" : "disabled",
        capabilities: {
          createPaymentIntent: true,
          webhook: true,
          refund: true,
        },
      })
      .onConflictDoUpdate({
        target: paymentProviders.code,
        set: {
          status: this.config.paymentMockEnabled ? "enabled" : "disabled",
          updatedAt: new Date(),
        },
      });
  }

  private async seedRealPaymentProviders(): Promise<void> {
    const realProviders = [
      {
        code: "wechat_pay",
        name: "微信支付",
        type: "wechat_pay" as const,
        capabilities: {
          createPaymentIntent: true,
          paymentCode: true,
          webhook: true,
          refund: true,
          query: true,
          cancel: true,
          reverse: true,
        },
      },
      {
        code: "alipay",
        name: "支付宝",
        type: "alipay" as const,
        capabilities: {
          createPaymentIntent: true,
          paymentCode: true,
          webhook: true,
          refund: true,
          query: true,
          cancel: true,
          reverse: true,
        },
      },
    ];
    await Promise.all(
      realProviders.map((provider) =>
        this.db
          .insert(paymentProviders)
          .values({
            code: provider.code,
            name: provider.name,
            type: provider.type,
            status: "disabled",
            capabilities: provider.capabilities,
          })
          .onConflictDoUpdate({
            target: paymentProviders.code,
            set: {
              name: provider.name,
              capabilities: provider.capabilities,
              updatedAt: new Date(),
            },
          }),
      ),
    );
  }

  private async findOrCreateCategory(
    name: string,
    sortOrder: number,
  ): Promise<string> {
    const [existing] = await this.db
      .select({ id: productCategories.id })
      .from(productCategories)
      .where(
        and(
          eq(productCategories.name, name),
          isNull(productCategories.deletedAt),
        ),
      );
    if (existing) return existing.id;

    const [created] = await this.db
      .insert(productCategories)
      .values({
        name,
        sortOrder,
        status: "active",
      })
      .returning({ id: productCategories.id });
    return created.id;
  }

  private async findOrCreateProduct(
    product: CatalogSeedProduct,
    categoryId: string,
  ): Promise<string> {
    const [existing] = await this.db
      .select({ id: products.id })
      .from(products)
      .where(and(eq(products.name, product.name), isNull(products.deletedAt)));
    if (existing) {
      await this.db
        .update(products)
        .set({
          categoryId,
          description: product.description,
          status: "active",
          sortOrder: product.sortOrder,
          updatedAt: new Date(),
        })
        .where(eq(products.id, existing.id));
      return existing.id;
    }

    const [created] = await this.db
      .insert(products)
      .values({
        name: product.name,
        categoryId,
        description: product.description,
        status: "active",
        sortOrder: product.sortOrder,
      })
      .returning({ id: products.id });
    return created.id;
  }

  private async seedCatalogFixtures(): Promise<void> {
    const categories = Array.from(
      new Set(catalogSeedProducts.map((product) => product.category)),
    );
    const categoryIds = new Map(
      await Promise.all(
        categories.map(
          async (category, index) =>
            [
              category,
              await this.findOrCreateCategory(category, (index + 1) * 10),
            ] as const,
        ),
      ),
    );

    await Promise.all(
      catalogSeedProducts.map(async (product) => {
        const categoryId = categoryIds.get(product.category);
        if (!categoryId) return;
        const productId = await this.findOrCreateProduct(product, categoryId);
        await Promise.all(
          product.variants.map((variant) =>
            this.db
              .insert(productVariants)
              .values({
                productId,
                sku: variant.sku,
                size: variant.size,
                color: variant.color,
                barcode: variant.barcode,
                targetGender: variant.targetGender,
                priceCents: variant.priceCents,
                costCents: variant.costCents,
                status: "active",
              })
              .onConflictDoUpdate({
                target: productVariants.sku,
                set: {
                  productId,
                  size: variant.size,
                  color: variant.color,
                  barcode: variant.barcode,
                  targetGender: variant.targetGender,
                  priceCents: variant.priceCents,
                  costCents: variant.costCents,
                  status: "active",
                  updatedAt: new Date(),
                },
              }),
          ),
        );
      }),
    );
  }
}
