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

const catalogSeedProducts: CatalogSeedProduct[] = [
  {
    name: "轻氧圆领短袖 T 恤",
    category: "上装",
    description: "180g 精梳棉基础款，适合视觉识别纯色上装和日常推荐测试。",
    sortOrder: 10,
    variants: [
      {
        sku: "APP-TS-CORE-WHT-M",
        size: "M",
        color: "白色",
        barcode: "6901000001011",
        targetGender: null,
        priceCents: 5900,
        costCents: 2600,
      },
      {
        sku: "APP-TS-CORE-BLK-L",
        size: "L",
        color: "黑色",
        barcode: "6901000001028",
        targetGender: null,
        priceCents: 5900,
        costCents: 2600,
      },
      {
        sku: "APP-TS-CORE-SKY-S",
        size: "S",
        color: "雾蓝",
        barcode: "6901000001035",
        targetGender: null,
        priceCents: 5900,
        costCents: 2600,
      },
    ],
  },
  {
    name: "速干运动背心",
    category: "运动服",
    description: "轻薄速干面料，覆盖运动场景和无袖轮廓识别样本。",
    sortOrder: 20,
    variants: [
      {
        sku: "APP-VEST-RUN-GRY-M",
        size: "M",
        color: "石墨灰",
        barcode: "6901000002018",
        targetGender: "male",
        priceCents: 4900,
        costCents: 2100,
      },
      {
        sku: "APP-VEST-RUN-PNK-S",
        size: "S",
        color: "珊瑚粉",
        barcode: "6901000002025",
        targetGender: "female",
        priceCents: 4900,
        costCents: 2100,
      },
    ],
  },
  {
    name: "轻量防晒外套",
    category: "外套",
    description: "连帽薄外套，适合测试外套、长袖、浅色大面积布料识别。",
    sortOrder: 30,
    variants: [
      {
        sku: "APP-JKT-SUN-IVY-M",
        size: "M",
        color: "象牙白",
        barcode: "6901000003015",
        targetGender: "female",
        priceCents: 12900,
        costCents: 6200,
      },
      {
        sku: "APP-JKT-SUN-NVY-L",
        size: "L",
        color: "海军蓝",
        barcode: "6901000003022",
        targetGender: "male",
        priceCents: 12900,
        costCents: 6200,
      },
    ],
  },
  {
    name: "高腰瑜伽九分裤",
    category: "下装",
    description: "弹力紧身裤型，覆盖贴身下装和深色细节识别样本。",
    sortOrder: 40,
    variants: [
      {
        sku: "APP-LEG-YOGA-BLK-S",
        size: "S",
        color: "黑色",
        barcode: "6901000004012",
        targetGender: "female",
        priceCents: 9900,
        costCents: 4800,
      },
      {
        sku: "APP-LEG-YOGA-MAU-M",
        size: "M",
        color: "豆沙紫",
        barcode: "6901000004029",
        targetGender: "female",
        priceCents: 9900,
        costCents: 4800,
      },
    ],
  },
  {
    name: "商务中筒袜三双装",
    category: "袜子",
    description: "棉混纺中筒袜，多件组合商品，用于小件包装检测和推荐搭配。",
    sortOrder: 50,
    variants: [
      {
        sku: "SOC-BIZ-MID-BLK-3P",
        size: "均码",
        color: "黑色三双",
        barcode: "6901000005019",
        targetGender: "male",
        priceCents: 3900,
        costCents: 1500,
      },
      {
        sku: "SOC-BIZ-MID-MIX-3P",
        size: "均码",
        color: "黑灰藏青",
        barcode: "6901000005026",
        targetGender: "male",
        priceCents: 3900,
        costCents: 1500,
      },
    ],
  },
  {
    name: "运动船袜五双装",
    category: "袜子",
    description: "低帮运动袜，多色组合，适合小包装和颜色多样性测试。",
    sortOrder: 60,
    variants: [
      {
        sku: "SOC-ANK-SPT-WHT-5P",
        size: "均码",
        color: "白色五双",
        barcode: "6901000006016",
        targetGender: null,
        priceCents: 3500,
        costCents: 1300,
      },
      {
        sku: "SOC-ANK-SPT-COL-5P",
        size: "均码",
        color: "彩色五双",
        barcode: "6901000006023",
        targetGender: null,
        priceCents: 3900,
        costCents: 1500,
      },
    ],
  },
  {
    name: "无痕舒适文胸",
    category: "内衣",
    description: "无钢圈贴身内衣，覆盖女性内衣 SKU 和尺码推荐样本。",
    sortOrder: 70,
    variants: [
      {
        sku: "UND-BRA-SEAM-BGE-M",
        size: "M",
        color: "肤色",
        barcode: "6901000007013",
        targetGender: "female",
        priceCents: 8900,
        costCents: 4200,
      },
      {
        sku: "UND-BRA-SEAM-BLK-L",
        size: "L",
        color: "黑色",
        barcode: "6901000007020",
        targetGender: "female",
        priceCents: 8900,
        costCents: 4200,
      },
    ],
  },
  {
    name: "莫代尔男士平角裤三条装",
    category: "内衣",
    description: "贴身基础内衣组合装，用于男士尺码和补货推荐测试。",
    sortOrder: 80,
    variants: [
      {
        sku: "UND-BOX-MOD-BLK-L-3P",
        size: "L",
        color: "黑色三条",
        barcode: "6901000008010",
        targetGender: "male",
        priceCents: 6900,
        costCents: 3000,
      },
      {
        sku: "UND-BOX-MOD-GRY-XL-3P",
        size: "XL",
        color: "灰色三条",
        barcode: "6901000008027",
        targetGender: "male",
        priceCents: 6900,
        costCents: 3000,
      },
    ],
  },
  {
    name: "家居棉质睡裙",
    category: "家居服",
    description: "宽松连身家居服，覆盖长款柔性衣物识别和女性推荐样本。",
    sortOrder: 90,
    variants: [
      {
        sku: "HOME-DRESS-COT-LAV-M",
        size: "M",
        color: "薰衣草紫",
        barcode: "6901000009017",
        targetGender: "female",
        priceCents: 11900,
        costCents: 5400,
      },
      {
        sku: "HOME-DRESS-COT-CRM-L",
        size: "L",
        color: "奶油白",
        barcode: "6901000009024",
        targetGender: "female",
        priceCents: 11900,
        costCents: 5400,
      },
    ],
  },
  {
    name: "轻薄保暖打底衫",
    category: "内衣",
    description: "贴身长袖打底，适合季节推荐、保暖属性和薄包装测试。",
    sortOrder: 100,
    variants: [
      {
        sku: "UND-BASE-WARM-BGE-M",
        size: "M",
        color: "米杏色",
        barcode: "6901000010013",
        targetGender: "female",
        priceCents: 7900,
        costCents: 3600,
      },
      {
        sku: "UND-BASE-WARM-GRY-L",
        size: "L",
        color: "浅灰色",
        barcode: "6901000010020",
        targetGender: "male",
        priceCents: 7900,
        costCents: 3600,
      },
    ],
  },
];

@Injectable()
export class BootstrapService implements OnModuleInit {
  constructor(
    @Inject(DRIZZLE_CLIENT) private readonly db: DrizzleClient,
    private readonly config: AppConfigService,
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
