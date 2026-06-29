import {
  adminUserStatuses,
  categoryStatuses,
  inventoryMovementReasons,
  inventoryReservationStatuses,
  machineCommandStatuses,
  machineClaimCodeStates,
  machineClaimCodePurposes,
  machineSlotStatuses,
  machineStatuses,
  notificationDeliveryStatuses,
  notificationSeverities,
  notificationStatuses,
  notificationTargetTypes,
  notificationTypes,
  orderFulfillmentStates,
  orderLineFulfillmentStatuses,
  orderLineRefundStatuses,
  orderPaymentStates,
  orderSources,
  orderStatuses,
  paymentCodeAttemptStatuses,
  paymentMethods,
  paymentProviderStatuses,
  paymentProviderTypes,
  paymentStatuses,
  permissionCodes,
  productStatuses,
  refundStatuses,
  roleStatuses,
  variantStatuses,
  vendingCommandStatuses,
} from "@vem/shared";
import { sql } from "drizzle-orm";
import * as t from "drizzle-orm/pg-core";

type JsonObject = Record<string, unknown>;

const id = () => t.uuid("id").defaultRandom().primaryKey();
const createdAt = () =>
  t.timestamp("created_at", { withTimezone: true }).defaultNow().notNull();
const updatedAt = () =>
  t.timestamp("updated_at", { withTimezone: true }).defaultNow().notNull();
const deletedAt = () => t.timestamp("deleted_at", { withTimezone: true });

const asPgEnumValues = <T extends string>(values: readonly T[]): [T, ...T[]] =>
  // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  values as [T, ...T[]];

export const adminUserStatus = t.pgEnum(
  "admin_user_status",
  asPgEnumValues(adminUserStatuses),
);
export const roleStatus = t.pgEnum("role_status", asPgEnumValues(roleStatuses));
export const permissionCode = t.pgEnum(
  "permission_code",
  asPgEnumValues(permissionCodes),
);
export const categoryStatus = t.pgEnum(
  "category_status",
  asPgEnumValues(categoryStatuses),
);
export const productStatus = t.pgEnum(
  "product_status",
  asPgEnumValues(productStatuses),
);
export const variantStatus = t.pgEnum(
  "variant_status",
  asPgEnumValues(variantStatuses),
);
export const machineStatus = t.pgEnum(
  "machine_status",
  asPgEnumValues(machineStatuses),
);
export const machineSlotStatus = t.pgEnum(
  "machine_slot_status",
  asPgEnumValues(machineSlotStatuses),
);
export const machineCommandStatus = t.pgEnum(
  "machine_command_status",
  asPgEnumValues(machineCommandStatuses),
);
export const machineClaimCodeState = t.pgEnum(
  "machine_claim_code_state",
  asPgEnumValues(machineClaimCodeStates),
);
export const machineClaimCodePurpose = t.pgEnum(
  "machine_claim_code_purpose",
  asPgEnumValues(machineClaimCodePurposes),
);
export const inventoryReservationStatus = t.pgEnum(
  "inventory_reservation_status",
  asPgEnumValues(inventoryReservationStatuses),
);
export const inventoryMovementReason = t.pgEnum(
  "inventory_movement_reason",
  asPgEnumValues(inventoryMovementReasons),
);
export const orderStatus = t.pgEnum(
  "order_status",
  asPgEnumValues(orderStatuses),
);
export const orderPaymentState = t.pgEnum(
  "order_payment_state",
  asPgEnumValues(orderPaymentStates),
);
export const orderFulfillmentState = t.pgEnum(
  "order_fulfillment_state",
  asPgEnumValues(orderFulfillmentStates),
);
export const orderLineFulfillmentStatus = t.pgEnum(
  "order_line_fulfillment_status",
  asPgEnumValues(orderLineFulfillmentStatuses),
);
export const orderLineRefundStatus = t.pgEnum(
  "order_line_refund_status",
  asPgEnumValues(orderLineRefundStatuses),
);
export const orderSource = t.pgEnum(
  "order_source",
  asPgEnumValues(orderSources),
);
export const paymentProviderType = t.pgEnum(
  "payment_provider_type",
  asPgEnumValues(paymentProviderTypes),
);
export const paymentProviderStatus = t.pgEnum(
  "payment_provider_status",
  asPgEnumValues(paymentProviderStatuses),
);
export const paymentMethod = t.pgEnum(
  "payment_method",
  asPgEnumValues(paymentMethods),
);
export const paymentStatus = t.pgEnum(
  "payment_status",
  asPgEnumValues(paymentStatuses),
);
export const paymentCodeAttemptStatus = t.pgEnum(
  "payment_code_attempt_status",
  asPgEnumValues(paymentCodeAttemptStatuses),
);
export const refundStatus = t.pgEnum(
  "refund_status",
  asPgEnumValues(refundStatuses),
);
export const vendingCommandStatus = t.pgEnum(
  "vending_command_status",
  asPgEnumValues(vendingCommandStatuses),
);
export const notificationTargetType = t.pgEnum(
  "notification_target_type",
  asPgEnumValues(notificationTargetTypes),
);
export const notificationType = t.pgEnum(
  "notification_type",
  asPgEnumValues(notificationTypes),
);
export const notificationSeverity = t.pgEnum(
  "notification_severity",
  asPgEnumValues(notificationSeverities),
);
export const notificationStatus = t.pgEnum(
  "notification_status",
  asPgEnumValues(notificationStatuses),
);
export const notificationDeliveryStatus = t.pgEnum(
  "notification_delivery_status",
  asPgEnumValues(notificationDeliveryStatuses),
);

export const adminUsers = t.pgTable(
  "admin_users",
  {
    id: id(),
    username: t.varchar("username", { length: 64 }).notNull(),
    passwordHash: t.text("password_hash").notNull(),
    displayName: t.varchar("display_name", { length: 64 }).notNull(),
    mobile: t.varchar("mobile", { length: 32 }),
    email: t.varchar("email", { length: 255 }),
    status: adminUserStatus("status").default("active").notNull(),
    lastLoginAt: t.timestamp("last_login_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (table) => [
    t.uniqueIndex("admin_users_username_unique").on(table.username),
    t.index("admin_users_status_idx").on(table.status),
  ],
);

export const roles = t.pgTable(
  "roles",
  {
    id: id(),
    code: t.varchar("code", { length: 64 }).notNull(),
    name: t.varchar("name", { length: 64 }).notNull(),
    description: t.text("description"),
    isBuiltin: t.boolean("is_builtin").default(false).notNull(),
    status: roleStatus("status").default("active").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (table) => [
    t.uniqueIndex("roles_code_unique").on(table.code),
    t.index("roles_status_idx").on(table.status),
  ],
);

export const permissions = t.pgTable(
  "permissions",
  {
    id: id(),
    code: permissionCode("code").notNull(),
    name: t.varchar("name", { length: 128 }).notNull(),
    description: t.text("description"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [t.uniqueIndex("permissions_code_unique").on(table.code)],
);

export const adminUserRoles = t.pgTable(
  "admin_user_roles",
  {
    adminUserId: t
      .uuid("admin_user_id")
      .notNull()
      .references(() => adminUsers.id),
    roleId: t
      .uuid("role_id")
      .notNull()
      .references(() => roles.id),
    createdAt: createdAt(),
  },
  (table) => [
    t.primaryKey({ columns: [table.adminUserId, table.roleId] }),
    t.index("admin_user_roles_role_id_idx").on(table.roleId),
  ],
);

export const rolePermissions = t.pgTable(
  "role_permissions",
  {
    roleId: t
      .uuid("role_id")
      .notNull()
      .references(() => roles.id),
    permissionId: t
      .uuid("permission_id")
      .notNull()
      .references(() => permissions.id),
    createdAt: createdAt(),
  },
  (table) => [
    t.primaryKey({ columns: [table.roleId, table.permissionId] }),
    t.index("role_permissions_permission_id_idx").on(table.permissionId),
  ],
);

export const refreshTokens = t.pgTable(
  "refresh_tokens",
  {
    id: id(),
    adminUserId: t
      .uuid("admin_user_id")
      .notNull()
      .references(() => adminUsers.id),
    tokenHash: t.text("token_hash").notNull(),
    expiresAt: t.timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: t.timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    t.uniqueIndex("refresh_tokens_token_hash_unique").on(table.tokenHash),
    t.index("refresh_tokens_admin_user_id_idx").on(table.adminUserId),
  ],
);

export const auditLogs = t.pgTable(
  "audit_logs",
  {
    id: id(),
    adminUserId: t.uuid("admin_user_id").references(() => adminUsers.id),
    action: t.varchar("action", { length: 128 }).notNull(),
    resourceType: t.varchar("resource_type", { length: 64 }).notNull(),
    resourceId: t.uuid("resource_id"),
    ipAddress: t.varchar("ip_address", { length: 64 }),
    userAgent: t.text("user_agent"),
    beforeJson: t.jsonb("before_json").$type<JsonObject>(),
    afterJson: t.jsonb("after_json").$type<JsonObject>(),
    createdAt: createdAt(),
  },
  (table) => [
    t.index("audit_logs_admin_user_id_idx").on(table.adminUserId),
    t.index("audit_logs_resource_idx").on(table.resourceType, table.resourceId),
    t.index("audit_logs_created_at_idx").on(table.createdAt),
  ],
);

export const productCategories = t.pgTable(
  "product_categories",
  {
    id: id(),
    name: t.varchar("name", { length: 128 }).notNull(),
    parentId: t
      .uuid("parent_id")
      .references((): t.AnyPgColumn => productCategories.id),
    sortOrder: t.integer("sort_order").default(0).notNull(),
    status: categoryStatus("status").default("active").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (table) => [
    t.index("product_categories_parent_id_idx").on(table.parentId),
    t.index("product_categories_status_idx").on(table.status),
  ],
);

export const products = t.pgTable(
  "products",
  {
    id: id(),
    name: t.varchar("name", { length: 128 }).notNull(),
    categoryId: t.uuid("category_id").references(() => productCategories.id),
    description: t.text("description"),
    coverImageUrl: t.text("cover_image_url"),
    status: productStatus("status").default("draft").notNull(),
    sortOrder: t.integer("sort_order").default(0).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (table) => [
    t.index("products_category_id_idx").on(table.categoryId),
    t.index("products_status_idx").on(table.status),
  ],
);

export const productVariants = t.pgTable(
  "product_variants",
  {
    id: id(),
    productId: t
      .uuid("product_id")
      .notNull()
      .references(() => products.id),
    sku: t.varchar("sku", { length: 64 }).notNull(),
    size: t.varchar("size", { length: 32 }),
    color: t.varchar("color", { length: 32 }),
    barcode: t.varchar("barcode", { length: 128 }),
    targetGender: t.varchar("target_gender", { length: 8 }),
    priceCents: t.integer("price_cents").notNull(),
    costCents: t.integer("cost_cents"),
    status: variantStatus("status").default("active").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (table) => [
    t.uniqueIndex("product_variants_sku_unique").on(table.sku),
    t.index("product_variants_product_id_idx").on(table.productId),
    t.index("product_variants_status_idx").on(table.status),
    t.check(
      "product_variants_price_cents_non_negative",
      sql`${table.priceCents} >= 0`,
    ),
    t.check(
      "product_variants_cost_cents_non_negative",
      sql`${table.costCents} IS NULL OR ${table.costCents} >= 0`,
    ),
    t.check(
      "product_variants_target_gender_enum",
      sql`${table.targetGender} IS NULL OR ${table.targetGender} IN ('male', 'female')`,
    ),
  ],
);

export const machines = t.pgTable(
  "machines",
  {
    id: id(),
    code: t.varchar("code", { length: 64 }).notNull(),
    name: t.varchar("name", { length: 128 }).notNull(),
    locationText: t.text("location_text"),
    status: machineStatus("status").default("offline").notNull(),
    lastSeenAt: t.timestamp("last_seen_at", { withTimezone: true }),
    mqttClientId: t.varchar("mqtt_client_id", { length: 128 }),
    secretHash: t.text("secret_hash"),
    secretVersion: t.integer("secret_version").default(1).notNull(),
    secretRotatedAt: t.timestamp("secret_rotated_at", { withTimezone: true }),
    credentialRevokedAt: t.timestamp("credential_revoked_at", {
      withTimezone: true,
    }),
    mqttSigningSecretEncryptedJson: t
      .jsonb("mqtt_signing_secret_encrypted_json")
      .$type<JsonObject>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (table) => [
    t.uniqueIndex("machines_code_unique").on(table.code),
    t.index("machines_status_idx").on(table.status),
    t.index("machines_last_seen_at_idx").on(table.lastSeenAt),
    t.index("machines_credential_revoked_at_idx").on(table.credentialRevokedAt),
  ],
);

export const machineSlots = t.pgTable(
  "machine_slots",
  {
    id: id(),
    machineId: t
      .uuid("machine_id")
      .notNull()
      .references(() => machines.id),
    layerNo: t.integer("layer_no").notNull(),
    cellNo: t.integer("cell_no").notNull(),
    slotCode: t.varchar("slot_code", { length: 32 }).notNull(),
    capacity: t.integer("capacity").notNull(),
    status: machineSlotStatus("status").default("enabled").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (table) => [
    t
      .uniqueIndex("machine_slots_position_unique")
      .on(table.machineId, table.layerNo, table.cellNo),
    t.index("machine_slots_machine_id_idx").on(table.machineId),
    t.index("machine_slots_status_idx").on(table.status),
    t.check("machine_slots_layer_no_positive", sql`${table.layerNo} > 0`),
    t.check("machine_slots_cell_no_positive", sql`${table.cellNo} > 0`),
    t.check("machine_slots_capacity_non_negative", sql`${table.capacity} >= 0`),
  ],
);

export const machinePlanogramVersions = t.pgTable(
  "machine_planogram_versions",
  {
    id: id(),
    machineId: t
      .uuid("machine_id")
      .notNull()
      .references(() => machines.id),
    planogramVersion: t.varchar("planogram_version", { length: 128 }).notNull(),
    status: t.varchar("status", { length: 32 }).default("published").notNull(),
    publishedAt: t
      .timestamp("published_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    acknowledgedAt: t.timestamp("acknowledged_at", { withTimezone: true }),
    activeAt: t.timestamp("active_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    t
      .uniqueIndex("machine_planogram_versions_machine_version_unique")
      .on(table.machineId, table.planogramVersion),
    t
      .uniqueIndex("machine_planogram_versions_machine_active_unique")
      .on(table.machineId)
      .where(sql`${table.status} = 'active'`),
    t
      .index("machine_planogram_versions_machine_status_idx")
      .on(table.machineId, table.status),
    t.check(
      "machine_planogram_versions_status_enum",
      sql`${table.status} IN ('published', 'active', 'retired')`,
    ),
  ],
);

export const machineClaimCodes = t.pgTable(
  "machine_claim_codes",
  {
    id: id(),
    machineId: t
      .uuid("machine_id")
      .notNull()
      .references(() => machines.id),
    lookupDigest: t.text("lookup_digest"),
    verifierHash: t.text("verifier_hash").notNull(),
    purpose: machineClaimCodePurpose("purpose")
      .default("first_claim")
      .notNull(),
    state: machineClaimCodeState("state").default("pending").notNull(),
    failedAttemptCount: t.integer("failed_attempt_count").default(0).notNull(),
    maxFailedAttempts: t.integer("max_failed_attempts").default(5).notNull(),
    expiresAt: t.timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: t.timestamp("consumed_at", { withTimezone: true }),
    revokedAt: t.timestamp("revoked_at", { withTimezone: true }),
    lockedAt: t.timestamp("locked_at", { withTimezone: true }),
    createdByAdminUserId: t
      .uuid("created_by_admin_user_id")
      .references(() => adminUsers.id),
    revokedByAdminUserId: t
      .uuid("revoked_by_admin_user_id")
      .references(() => adminUsers.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    t
      .uniqueIndex("machine_claim_codes_lookup_digest_unique")
      .on(table.lookupDigest)
      .where(sql`${table.lookupDigest} IS NOT NULL`),
    t.index("machine_claim_codes_machine_id_idx").on(table.machineId),
    t.index("machine_claim_codes_state_idx").on(table.state),
    t.index("machine_claim_codes_expires_at_idx").on(table.expiresAt),
    t
      .index("machine_claim_codes_created_by_admin_user_id_idx")
      .on(table.createdByAdminUserId),
    t
      .index("machine_claim_codes_revoked_by_admin_user_id_idx")
      .on(table.revokedByAdminUserId),
    t
      .uniqueIndex("machine_claim_codes_machine_open_unique")
      .on(table.machineId)
      .where(sql`${table.state} IN ('pending', 'locked')`),
    t.check(
      "machine_claim_codes_failed_attempt_count_non_negative",
      sql`${table.failedAttemptCount} >= 0`,
    ),
    t.check(
      "machine_claim_codes_max_failed_attempts_positive",
      sql`${table.maxFailedAttempts} > 0`,
    ),
  ],
);

export const machinePlanogramSlots = t.pgTable(
  "machine_planogram_slots",
  {
    id: id(),
    machinePlanogramVersionId: t
      .uuid("machine_planogram_version_id")
      .notNull()
      .references(() => machinePlanogramVersions.id),
    slotId: t
      .uuid("slot_id")
      .notNull()
      .references(() => machineSlots.id),
    slotCode: t.varchar("slot_code", { length: 32 }).notNull(),
    layerNo: t.integer("layer_no").notNull(),
    cellNo: t.integer("cell_no").notNull(),
    capacity: t.integer("capacity").notNull(),
    parLevel: t.integer("par_level").notNull(),
    inventoryId: t.uuid("inventory_id").notNull(),
    variantId: t.uuid("variant_id").notNull(),
    productId: t.uuid("product_id").notNull(),
    productName: t.varchar("product_name", { length: 128 }).notNull(),
    productDescription: t.text("product_description"),
    coverImageUrl: t.text("cover_image_url"),
    categoryId: t.uuid("category_id"),
    categoryName: t.varchar("category_name", { length: 128 }),
    sku: t.varchar("sku", { length: 64 }).notNull(),
    size: t.varchar("size", { length: 64 }),
    color: t.varchar("color", { length: 64 }),
    priceCents: t.integer("price_cents").notNull(),
    productSortOrder: t.integer("product_sort_order").notNull(),
    targetGender: t.varchar("target_gender", { length: 16 }),
    createdAt: createdAt(),
  },
  (table) => [
    t
      .uniqueIndex("machine_planogram_slots_version_slot_unique")
      .on(table.machinePlanogramVersionId, table.slotId),
    t
      .index("machine_planogram_slots_version_idx")
      .on(table.machinePlanogramVersionId),
    t.check(
      "machine_planogram_slots_capacity_non_negative",
      sql`${table.capacity} >= 0`,
    ),
    t.check(
      "machine_planogram_slots_par_level_non_negative",
      sql`${table.parLevel} >= 0`,
    ),
    t.check(
      "machine_planogram_slots_price_cents_non_negative",
      sql`${table.priceCents} >= 0`,
    ),
    t.check(
      "machine_planogram_slots_target_gender_enum",
      sql`${table.targetGender} IS NULL OR ${table.targetGender} IN ('male', 'female')`,
    ),
  ],
);

export const inventories = t.pgTable(
  "inventories",
  {
    id: id(),
    machineId: t
      .uuid("machine_id")
      .notNull()
      .references(() => machines.id),
    slotId: t
      .uuid("slot_id")
      .notNull()
      .references(() => machineSlots.id),
    variantId: t
      .uuid("variant_id")
      .notNull()
      .references(() => productVariants.id),
    onHandQty: t.integer("on_hand_qty").notNull(),
    reservedQty: t.integer("reserved_qty").default(0).notNull(),
    lowStockThreshold: t.integer("low_stock_threshold").default(1).notNull(),
    soldOutNotifiedAt: t.timestamp("sold_out_notified_at", {
      withTimezone: true,
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    t.uniqueIndex("inventories_slot_id_unique").on(table.slotId),
    t.index("inventories_machine_id_idx").on(table.machineId),
    t.index("inventories_variant_id_idx").on(table.variantId),
    t.check(
      "inventories_on_hand_qty_non_negative",
      sql`${table.onHandQty} >= 0`,
    ),
    t.check(
      "inventories_reserved_qty_non_negative",
      sql`${table.reservedQty} >= 0`,
    ),
    t.check(
      "inventories_low_stock_threshold_non_negative",
      sql`${table.lowStockThreshold} >= 0`,
    ),
    t.check(
      "inventories_reserved_qty_lte_on_hand_qty",
      sql`${table.reservedQty} <= ${table.onHandQty}`,
    ),
  ],
);

export const orders = t.pgTable(
  "orders",
  {
    id: id(),
    orderNo: t.varchar("order_no", { length: 64 }).notNull(),
    machineId: t
      .uuid("machine_id")
      .notNull()
      .references(() => machines.id),
    status: orderStatus("status").default("pending_payment").notNull(),
    paymentState: orderPaymentState("payment_state")
      .default("awaiting_payment")
      .notNull(),
    fulfillmentState: orderFulfillmentState("fulfillment_state")
      .default("awaiting_fulfillment")
      .notNull(),
    totalAmountCents: t.integer("total_amount_cents").notNull(),
    currency: t.char("currency", { length: 3 }).default("CNY").notNull(),
    paymentId: t
      .uuid("payment_id")
      .references((): t.AnyPgColumn => payments.id),
    isDrill: t.boolean("is_drill").default(false).notNull(),
    drillScenario: t.varchar("drill_scenario", { length: 64 }),
    profileSnapshot: t.jsonb("profile_snapshot").$type<JsonObject>(),
    createdFrom: orderSource("created_from").default("machine_ui").notNull(),
    paidAt: t.timestamp("paid_at", { withTimezone: true }),
    dispensedAt: t.timestamp("dispensed_at", { withTimezone: true }),
    canceledAt: t.timestamp("canceled_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    t.uniqueIndex("orders_order_no_unique").on(table.orderNo),
    t.index("orders_machine_id_idx").on(table.machineId),
    t.index("orders_status_idx").on(table.status),
    t.index("orders_is_drill_idx").on(table.isDrill),
    t.index("orders_payment_state_idx").on(table.paymentState),
    t.index("orders_fulfillment_state_idx").on(table.fulfillmentState),
    t.index("orders_created_at_idx").on(table.createdAt),
    t.check(
      "orders_total_amount_cents_non_negative",
      sql`${table.totalAmountCents} >= 0`,
    ),
  ],
);

export const orderItems = t.pgTable(
  "order_items",
  {
    id: id(),
    orderId: t
      .uuid("order_id")
      .notNull()
      .references(() => orders.id),
    variantId: t
      .uuid("variant_id")
      .notNull()
      .references(() => productVariants.id),
    inventoryId: t
      .uuid("inventory_id")
      .notNull()
      .references(() => inventories.id),
    slotId: t
      .uuid("slot_id")
      .notNull()
      .references(() => machineSlots.id),
    quantity: t.integer("quantity").notNull(),
    unitPriceCents: t.integer("unit_price_cents").notNull(),
    planogramVersion: t
      .varchar("planogram_version", { length: 128 })
      .default("legacy")
      .notNull(),
    productSnapshot: t.jsonb("product_snapshot").$type<JsonObject>().notNull(),
    fulfillmentStatus: orderLineFulfillmentStatus("fulfillment_status")
      .default("pending")
      .notNull(),
    refundStatus: orderLineRefundStatus("refund_status")
      .default("not_required")
      .notNull(),
    refundId: t.uuid("refund_id").references((): t.AnyPgColumn => refunds.id),
    fulfilledAt: t.timestamp("fulfilled_at", { withTimezone: true }),
    failedAt: t.timestamp("failed_at", { withTimezone: true }),
    refundUpdatedAt: t.timestamp("refund_updated_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    t.index("order_items_order_id_idx").on(table.orderId),
    t.index("order_items_variant_id_idx").on(table.variantId),
    t.index("order_items_fulfillment_status_idx").on(table.fulfillmentStatus),
    t.index("order_items_refund_status_idx").on(table.refundStatus),
    t.check("order_items_quantity_positive", sql`${table.quantity} > 0`),
    t.check(
      "order_items_unit_price_cents_non_negative",
      sql`${table.unitPriceCents} >= 0`,
    ),
  ],
);

export const orderStatusEvents = t.pgTable(
  "order_status_events",
  {
    id: id(),
    orderId: t
      .uuid("order_id")
      .notNull()
      .references(() => orders.id),
    fromStatus: orderStatus("from_status"),
    toStatus: orderStatus("to_status").notNull(),
    reason: t.varchar("reason", { length: 128 }).notNull(),
    metadata: t.jsonb("metadata").$type<JsonObject>(),
    createdAt: createdAt(),
  },
  (table) => [
    t.index("order_status_events_order_id_idx").on(table.orderId),
    t.index("order_status_events_created_at_idx").on(table.createdAt),
  ],
);

export const paymentProviders = t.pgTable(
  "payment_providers",
  {
    id: id(),
    code: t.varchar("code", { length: 64 }).notNull(),
    name: t.varchar("name", { length: 128 }).notNull(),
    type: paymentProviderType("type").notNull(),
    status: paymentProviderStatus("status").default("enabled").notNull(),
    capabilities: t.jsonb("capabilities").$type<JsonObject>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    t.uniqueIndex("payment_providers_code_unique").on(table.code),
    t.index("payment_providers_status_idx").on(table.status),
  ],
);

export const paymentProviderConfigs = t.pgTable(
  "payment_provider_configs",
  {
    id: id(),
    providerId: t
      .uuid("provider_id")
      .notNull()
      .references(() => paymentProviders.id),
    machineId: t.uuid("machine_id").references(() => machines.id),
    merchantNo: t.varchar("merchant_no", { length: 128 }),
    appId: t.varchar("app_id", { length: 128 }),
    configEncryptedJson: t
      .jsonb("config_encrypted_json")
      .$type<JsonObject>()
      .notNull(),
    publicConfigJson: t
      .jsonb("public_config_json")
      .$type<JsonObject>()
      .notNull(),
    status: paymentProviderStatus("status").default("enabled").notNull(),
    updatedByAdminUserId: t
      .uuid("updated_by_admin_user_id")
      .references(() => adminUsers.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    t.index("payment_provider_configs_provider_id_idx").on(table.providerId),
    t.index("payment_provider_configs_machine_id_idx").on(table.machineId),
    t
      .uniqueIndex("payment_provider_configs_provider_machine_unique")
      .on(table.providerId, table.machineId),
    t
      .uniqueIndex("payment_provider_configs_provider_global_unique")
      .on(table.providerId)
      .where(sql`${table.machineId} IS NULL`),
  ],
);

export const paymentUserSnapshots = t.pgTable(
  "payment_user_snapshots",
  {
    id: id(),
    providerCode: t.varchar("provider_code", { length: 64 }).notNull(),
    providerUserIdHash: t.text("provider_user_id_hash"),
    maskedAccount: t.varchar("masked_account", { length: 128 }),
    displayNameMasked: t.varchar("display_name_masked", { length: 128 }),
    extraMaskedJson: t.jsonb("extra_masked_json").$type<JsonObject>(),
    createdAt: createdAt(),
  },
  (table) => [
    t.index("payment_user_snapshots_provider_code_idx").on(table.providerCode),
  ],
);

export const payments = t.pgTable(
  "payments",
  {
    id: id(),
    paymentNo: t.varchar("payment_no", { length: 64 }).notNull(),
    orderId: t
      .uuid("order_id")
      .notNull()
      .references(() => orders.id),
    providerId: t
      .uuid("provider_id")
      .notNull()
      .references(() => paymentProviders.id),
    paymentProviderConfigId: t
      .uuid("payment_provider_config_id")
      .references(() => paymentProviderConfigs.id),
    providerConfigSnapshotJson: t
      .jsonb("provider_config_snapshot_json")
      .$type<JsonObject>(),
    method: paymentMethod("method").notNull(),
    status: paymentStatus("status").default("created").notNull(),
    amountCents: t.integer("amount_cents").notNull(),
    providerTradeNo: t.varchar("provider_trade_no", { length: 128 }),
    isDrill: t.boolean("is_drill").default(false).notNull(),
    drillScenario: t.varchar("drill_scenario", { length: 64 }),
    paymentUrl: t.text("payment_url"),
    expiresAt: t.timestamp("expires_at", { withTimezone: true }),
    paidAt: t.timestamp("paid_at", { withTimezone: true }),
    failedReason: t.text("failed_reason"),
    payerSnapshotId: t
      .uuid("payer_snapshot_id")
      .references(() => paymentUserSnapshots.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    t.uniqueIndex("payments_payment_no_unique").on(table.paymentNo),
    t.index("payments_order_id_idx").on(table.orderId),
    t.index("payments_provider_id_idx").on(table.providerId),
    t.index("payments_status_idx").on(table.status),
    t.index("payments_is_drill_idx").on(table.isDrill),
    t.index("payments_created_at_idx").on(table.createdAt),
    t.check(
      "payments_amount_cents_non_negative",
      sql`${table.amountCents} >= 0`,
    ),
  ],
);

export const paymentCodeAttempts = t.pgTable(
  "payment_code_attempts",
  {
    id: id(),
    paymentId: t
      .uuid("payment_id")
      .notNull()
      .references(() => payments.id),
    orderId: t
      .uuid("order_id")
      .notNull()
      .references(() => orders.id),
    providerId: t
      .uuid("provider_id")
      .notNull()
      .references(() => paymentProviders.id),
    paymentProviderConfigId: t
      .uuid("payment_provider_config_id")
      .references(() => paymentProviderConfigs.id),
    attemptNo: t.integer("attempt_no").notNull(),
    providerPaymentNo: t
      .varchar("provider_payment_no", { length: 64 })
      .notNull(),
    idempotencyKey: t.varchar("idempotency_key", { length: 128 }).notNull(),
    status: paymentCodeAttemptStatus("status").default("created").notNull(),
    isActive: t.boolean("is_active").default(true).notNull(),
    amountCents: t.integer("amount_cents").notNull(),
    currency: t.varchar("currency", { length: 3 }).default("CNY").notNull(),
    authCodeHash: t.varchar("auth_code_hash", { length: 64 }).notNull(),
    authCodeMasked: t.varchar("auth_code_masked", { length: 32 }).notNull(),
    source: t.varchar("source", { length: 32 }).notNull(),
    scannerHealthJson: t.jsonb("scanner_health_json").$type<JsonObject>(),
    providerTradeNo: t.varchar("provider_trade_no", { length: 128 }),
    providerStatus: t.varchar("provider_status", { length: 64 }),
    failureCode: t.varchar("failure_code", { length: 128 }),
    failureMessage: t.text("failure_message"),
    rawPayloadJson: t.jsonb("raw_payload_json").$type<JsonObject>(),
    submittedAt: t.timestamp("submitted_at", { withTimezone: true }),
    lastCheckedAt: t.timestamp("last_checked_at", { withTimezone: true }),
    reversedAt: t.timestamp("reversed_at", { withTimezone: true }),
    finishedAt: t.timestamp("finished_at", { withTimezone: true }),
    manualReason: t.text("manual_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    t
      .uniqueIndex("payment_code_attempts_provider_payment_no_unique")
      .on(table.providerPaymentNo),
    t
      .uniqueIndex("payment_code_attempts_idempotency_unique")
      .on(table.paymentId, table.idempotencyKey),
    t
      .uniqueIndex("payment_code_attempts_order_attempt_unique")
      .on(table.orderId, table.attemptNo),
    t
      .uniqueIndex("payment_code_attempts_order_active_unique")
      .on(table.orderId)
      .where(sql`${table.isActive} = true`),
    t.index("payment_code_attempts_payment_id_idx").on(table.paymentId),
    t.index("payment_code_attempts_status_idx").on(table.status),
    t.index("payment_code_attempts_auth_hash_idx").on(table.authCodeHash),
    t.check(
      "payment_code_attempts_amount_cents_positive",
      sql`${table.amountCents} > 0`,
    ),
  ],
);

export const paymentEvents = t.pgTable(
  "payment_events",
  {
    id: id(),
    paymentId: t
      .uuid("payment_id")
      .notNull()
      .references(() => payments.id),
    providerId: t
      .uuid("provider_id")
      .notNull()
      .references(() => paymentProviders.id),
    eventType: t.varchar("event_type", { length: 128 }).notNull(),
    providerEventId: t.varchar("provider_event_id", { length: 128 }).notNull(),
    rawPayloadJson: t.jsonb("raw_payload_json").$type<JsonObject>().notNull(),
    signatureValid: t.boolean("signature_valid").default(false).notNull(),
    handledAt: t.timestamp("handled_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    t
      .uniqueIndex("payment_events_provider_event_unique")
      .on(table.providerId, table.providerEventId),
    t.index("payment_events_payment_id_idx").on(table.paymentId),
  ],
);

export const refunds = t.pgTable(
  "refunds",
  {
    id: id(),
    refundNo: t.varchar("refund_no", { length: 64 }).notNull(),
    paymentId: t
      .uuid("payment_id")
      .notNull()
      .references(() => payments.id),
    orderId: t
      .uuid("order_id")
      .notNull()
      .references(() => orders.id),
    amountCents: t.integer("amount_cents").notNull(),
    status: refundStatus("status").default("created").notNull(),
    providerRefundNo: t.varchar("provider_refund_no", { length: 128 }),
    isDrill: t.boolean("is_drill").default(false).notNull(),
    drillScenario: t.varchar("drill_scenario", { length: 64 }),
    reason: t.text("reason").notNull(),
    requestedByAdminUserId: t
      .uuid("requested_by_admin_user_id")
      .references(() => adminUsers.id),
    refundedAt: t.timestamp("refunded_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    t.uniqueIndex("refunds_refund_no_unique").on(table.refundNo),
    t.index("refunds_payment_id_idx").on(table.paymentId),
    t.index("refunds_order_id_idx").on(table.orderId),
    t.index("refunds_is_drill_idx").on(table.isDrill),
    t
      .uniqueIndex("refunds_order_reason_active_unique")
      .on(table.orderId, table.reason)
      .where(sql`${table.status} IN ('created', 'processing', 'succeeded')`),
    t.check(
      "refunds_amount_cents_non_negative",
      sql`${table.amountCents} >= 0`,
    ),
  ],
);

export const inventoryReservations = t.pgTable(
  "inventory_reservations",
  {
    id: id(),
    orderId: t
      .uuid("order_id")
      .notNull()
      .references(() => orders.id),
    inventoryId: t
      .uuid("inventory_id")
      .notNull()
      .references(() => inventories.id),
    orderItemId: t.uuid("order_item_id").references(() => orderItems.id),
    quantity: t.integer("quantity").notNull(),
    status: inventoryReservationStatus("status").default("active").notNull(),
    expiresAt: t.timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    t.index("inventory_reservations_order_id_idx").on(table.orderId),
    t.index("inventory_reservations_inventory_id_idx").on(table.inventoryId),
    t.index("inventory_reservations_order_item_id_idx").on(table.orderItemId),
    t.index("inventory_reservations_status_idx").on(table.status),
    t.check(
      "inventory_reservations_quantity_positive",
      sql`${table.quantity} > 0`,
    ),
  ],
);

export const inventoryMovements = t.pgTable(
  "inventory_movements",
  {
    id: id(),
    inventoryId: t
      .uuid("inventory_id")
      .notNull()
      .references(() => inventories.id),
    deltaQty: t.integer("delta_qty").notNull(),
    reason: inventoryMovementReason("reason").notNull(),
    orderId: t.uuid("order_id").references(() => orders.id),
    operatorAdminUserId: t
      .uuid("operator_admin_user_id")
      .references(() => adminUsers.id),
    note: t.text("note"),
    createdAt: createdAt(),
  },
  (table) => [
    t.index("inventory_movements_inventory_id_idx").on(table.inventoryId),
    t.index("inventory_movements_order_id_idx").on(table.orderId),
    t.index("inventory_movements_reason_idx").on(table.reason),
    t.index("inventory_movements_created_at_idx").on(table.createdAt),
  ],
);

export const machineRawStockMovements = t.pgTable(
  "machine_raw_stock_movements",
  {
    id: id(),
    machineId: t
      .uuid("machine_id")
      .notNull()
      .references(() => machines.id),
    movementId: t.varchar("movement_id", { length: 128 }).notNull(),
    planogramVersion: t.varchar("planogram_version", { length: 128 }).notNull(),
    slotId: t.uuid("slot_id").notNull(),
    movementType: t.varchar("movement_type", { length: 64 }).notNull(),
    quantity: t.integer("quantity").notNull(),
    source: t.varchar("source", { length: 128 }).notNull(),
    attributedTo: t.varchar("attributed_to", { length: 128 }),
    occurredAt: t.timestamp("occurred_at", { withTimezone: true }).notNull(),
    receivedAt: t
      .timestamp("received_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    payloadHash: t.varchar("payload_hash", { length: 64 }).notNull(),
    payloadJson: t.jsonb("payload_json").$type<JsonObject>().notNull(),
    normalizedJson: t.jsonb("normalized_json").$type<JsonObject>().notNull(),
    status: t.varchar("status", { length: 32 }).default("accepted").notNull(),
    reconciliationReason: t.varchar("reconciliation_reason", { length: 128 }),
    platformReviewStatus: t.varchar("platform_review_status", { length: 32 }),
    saleSafetyBlockerState: t.varchar("sale_safety_blocker_state", {
      length: 64,
    }),
    saleSafetyBlockerSlotId: t.uuid("sale_safety_blocker_slot_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    t
      .uniqueIndex("machine_raw_stock_movements_machine_movement_unique")
      .on(table.machineId, table.movementId),
    t.index("machine_raw_stock_movements_machine_idx").on(table.machineId),
    t.index("machine_raw_stock_movements_status_idx").on(table.status),
    t
      .index("machine_raw_stock_movements_sale_safety_blocker_idx")
      .on(table.machineId, table.saleSafetyBlockerSlotId),
    t.check(
      "machine_raw_stock_movements_quantity_non_negative",
      sql`${table.quantity} >= 0`,
    ),
    t.check(
      "machine_raw_stock_movements_type_enum",
      sql`${table.movementType} IN ('planned_refill', 'stock_count_correction', 'dispense_succeeded')`,
    ),
    t.check(
      "machine_raw_stock_movements_status_enum",
      sql`${table.status} IN ('accepted', 'rejected', 'reconciliation')`,
    ),
    t.check(
      "machine_raw_stock_movements_platform_review_status_enum",
      sql`${table.platformReviewStatus} IS NULL OR ${table.platformReviewStatus} IN ('open', 'resolved')`,
    ),
    t.check(
      "machine_raw_stock_movements_sale_safety_blocker_enum",
      sql`${table.saleSafetyBlockerState} IS NULL OR ${table.saleSafetyBlockerState} IN ('needs_count', 'blocked_for_planogram_change', 'movement_rejected', 'needs_platform_review')`,
    ),
  ],
);

export const machineRawStockMovementConflicts = t.pgTable(
  "machine_raw_stock_movement_conflicts",
  {
    id: id(),
    rawMovementId: t
      .uuid("raw_movement_id")
      .notNull()
      .references(() => machineRawStockMovements.id),
    machineId: t
      .uuid("machine_id")
      .notNull()
      .references(() => machines.id),
    movementId: t.varchar("movement_id", { length: 128 }).notNull(),
    payloadHash: t.varchar("payload_hash", { length: 64 }).notNull(),
    payloadJson: t.jsonb("payload_json").$type<JsonObject>().notNull(),
    normalizedJson: t.jsonb("normalized_json").$type<JsonObject>().notNull(),
    status: t
      .varchar("status", { length: 32 })
      .default("reconciliation")
      .notNull(),
    reconciliationReason: t
      .varchar("reconciliation_reason", { length: 128 })
      .notNull(),
    platformReviewStatus: t
      .varchar("platform_review_status", { length: 32 })
      .notNull(),
    saleSafetyBlockerState: t.varchar("sale_safety_blocker_state", {
      length: 64,
    }),
    saleSafetyBlockerSlotId: t.uuid("sale_safety_blocker_slot_id"),
    receivedAt: t
      .timestamp("received_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    t
      .index("machine_raw_stock_movement_conflicts_raw_idx")
      .on(table.rawMovementId),
    t
      .index("machine_raw_stock_movement_conflicts_machine_movement_idx")
      .on(table.machineId, table.movementId),
    t.check(
      "machine_raw_stock_movement_conflicts_status_enum",
      sql`${table.status} IN ('reconciliation')`,
    ),
    t.check(
      "machine_raw_stock_movement_conflicts_platform_review_status_enum",
      sql`${table.platformReviewStatus} IN ('open', 'resolved')`,
    ),
    t.check(
      "machine_raw_stock_movement_conflicts_sale_safety_blocker_enum",
      sql`${table.saleSafetyBlockerState} IS NULL OR ${table.saleSafetyBlockerState} IN ('needs_count', 'blocked_for_planogram_change', 'movement_rejected', 'needs_platform_review')`,
    ),
  ],
);

export const vendingCommands = t.pgTable(
  "vending_commands",
  {
    id: id(),
    commandNo: t.varchar("command_no", { length: 64 }).notNull(),
    orderId: t
      .uuid("order_id")
      .notNull()
      .references(() => orders.id),
    machineId: t
      .uuid("machine_id")
      .notNull()
      .references(() => machines.id),
    slotId: t
      .uuid("slot_id")
      .notNull()
      .references(() => machineSlots.id),
    orderItemId: t.uuid("order_item_id").references(() => orderItems.id),
    commandKind: t
      .varchar("command_kind", { length: 32 })
      .default("dispatch")
      .notNull(),
    recoveryActionId: t.uuid("recovery_action_id"),
    payloadJson: t.jsonb("payload_json").$type<JsonObject>().notNull(),
    status: vendingCommandStatus("status").default("pending").notNull(),
    sentAt: t.timestamp("sent_at", { withTimezone: true }),
    ackAt: t.timestamp("ack_at", { withTimezone: true }),
    resultAt: t.timestamp("result_at", { withTimezone: true }),
    retryCount: t.integer("retry_count").default(0).notNull(),
    lastError: t.text("last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    t.uniqueIndex("vending_commands_command_no_unique").on(table.commandNo),
    t
      .uniqueIndex("vending_commands_order_slot_unique")
      .on(table.orderId, table.slotId)
      .where(sql`${table.commandKind} = 'dispatch'`),
    t
      .uniqueIndex("vending_commands_recovery_action_unique")
      .on(table.recoveryActionId)
      .where(sql`${table.recoveryActionId} IS NOT NULL`),
    t.index("vending_commands_order_id_idx").on(table.orderId),
    t.index("vending_commands_order_item_id_idx").on(table.orderItemId),
    t.index("vending_commands_machine_id_idx").on(table.machineId),
    t.index("vending_commands_status_idx").on(table.status),
    t.index("vending_commands_command_kind_idx").on(table.commandKind),
    t.check(
      "vending_commands_retry_count_non_negative",
      sql`${table.retryCount} >= 0`,
    ),
    t.check(
      "vending_commands_command_kind_enum",
      sql`${table.commandKind} IN ('dispatch', 'compensation')`,
    ),
  ],
);

export const orderRecoveryActions = t.pgTable(
  "order_recovery_actions",
  {
    id: id(),
    orderId: t
      .uuid("order_id")
      .notNull()
      .references(() => orders.id),
    commandId: t
      .uuid("command_id")
      .notNull()
      .references(() => vendingCommands.id),
    action: t.varchar("action", { length: 64 }).notNull(),
    status: t.varchar("status", { length: 32 }).default("started").notNull(),
    note: t.text("note").notNull(),
    requestedByAdminUserId: t
      .uuid("requested_by_admin_user_id")
      .notNull()
      .references(() => adminUsers.id),
    resultJson: t.jsonb("result_json").$type<JsonObject>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    t.index("order_recovery_actions_order_id_idx").on(table.orderId),
    t.index("order_recovery_actions_command_id_idx").on(table.commandId),
    t.index("order_recovery_actions_status_idx").on(table.status),
    t
      .uniqueIndex("order_recovery_actions_order_action_unique")
      .on(table.orderId, table.action),
    t
      .uniqueIndex("order_recovery_actions_physical_outcome_unique")
      .on(table.orderId)
      .where(
        sql`${table.action} IN ('confirm_dispensed', 'confirm_not_dispensed')`,
      ),
    t
      .uniqueIndex("order_recovery_actions_remedy_unique")
      .on(table.orderId)
      .where(
        sql`${table.action} IN ('request_refund', 'compensation_dispense')`,
      ),
    t.check(
      "order_recovery_actions_action_enum",
      sql`${table.action} IN ('confirm_dispensed', 'confirm_not_dispensed', 'request_refund', 'compensation_dispense')`,
    ),
    t.check(
      "order_recovery_actions_status_enum",
      sql`${table.status} IN ('started', 'completed', 'failed')`,
    ),
  ],
);

export const machineCommands = t.pgTable(
  "machine_commands",
  {
    id: id(),
    commandNo: t.varchar("command_no", { length: 64 }).notNull(),
    machineId: t
      .uuid("machine_id")
      .notNull()
      .references(() => machines.id),
    type: t.varchar("type", { length: 64 }).notNull(),
    status: machineCommandStatus("status").default("pending").notNull(),
    payloadJson: t.jsonb("payload_json").$type<JsonObject>().notNull(),
    resultJson: t.jsonb("result_json").$type<JsonObject>(),
    sentAt: t.timestamp("sent_at", { withTimezone: true }),
    ackAt: t.timestamp("ack_at", { withTimezone: true }),
    resultAt: t.timestamp("result_at", { withTimezone: true }),
    timeoutAt: t.timestamp("timeout_at", { withTimezone: true }),
    requestedByAdminUserId: t
      .uuid("requested_by_admin_user_id")
      .references(() => adminUsers.id),
    lastError: t.text("last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    t.uniqueIndex("machine_commands_command_no_unique").on(table.commandNo),
    t.index("machine_commands_machine_id_idx").on(table.machineId),
    t.index("machine_commands_type_idx").on(table.type),
    t.index("machine_commands_status_idx").on(table.status),
    t.index("machine_commands_timeout_at_idx").on(table.timeoutAt),
    t
      .index("machine_commands_requested_by_admin_user_id_idx")
      .on(table.requestedByAdminUserId),
  ],
);

export const machineEvents = t.pgTable(
  "machine_events",
  {
    id: id(),
    machineId: t
      .uuid("machine_id")
      .notNull()
      .references(() => machines.id),
    eventType: t.varchar("event_type", { length: 128 }).notNull(),
    payloadJson: t.jsonb("payload_json").$type<JsonObject>().notNull(),
    mqttTopic: t.varchar("mqtt_topic", { length: 255 }).notNull(),
    messageId: t.varchar("message_id", { length: 128 }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    t
      .uniqueIndex("machine_events_machine_message_unique")
      .on(table.machineId, table.messageId),
    t.index("machine_events_machine_id_idx").on(table.machineId),
    t.index("machine_events_event_type_idx").on(table.eventType),
  ],
);

export const machineHeartbeats = t.pgTable(
  "machine_heartbeats",
  {
    id: id(),
    machineId: t
      .uuid("machine_id")
      .notNull()
      .references(() => machines.id),
    statusPayloadJson: t
      .jsonb("status_payload_json")
      .$type<JsonObject>()
      .notNull(),
    reportedAt: t.timestamp("reported_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    t.index("machine_heartbeats_machine_id_idx").on(table.machineId),
    t.index("machine_heartbeats_reported_at_idx").on(table.reportedAt),
  ],
);

export const notificationTargets = t.pgTable(
  "notification_targets",
  {
    id: id(),
    name: t.varchar("name", { length: 128 }).notNull(),
    type: notificationTargetType("type").notNull(),
    targetMasked: t.varchar("target_masked", { length: 128 }),
    configJson: t.jsonb("config_json").$type<JsonObject>().notNull(),
    status: paymentProviderStatus("status").default("enabled").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    t.uniqueIndex("notification_targets_name_unique").on(table.name),
    t.index("notification_targets_type_idx").on(table.type),
    t.index("notification_targets_status_idx").on(table.status),
  ],
);

export const notifications = t.pgTable(
  "notifications",
  {
    id: id(),
    type: notificationType("type").notNull(),
    title: t.varchar("title", { length: 128 }).notNull(),
    content: t.text("content").notNull(),
    severity: notificationSeverity("severity").default("info").notNull(),
    resourceType: t.varchar("resource_type", { length: 64 }),
    resourceId: t.uuid("resource_id"),
    status: notificationStatus("status").default("unread").notNull(),
    dedupeKey: t.varchar("dedupe_key", { length: 255 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    t.uniqueIndex("notifications_dedupe_key_unique").on(table.dedupeKey),
    t.index("notifications_type_idx").on(table.type),
    t.index("notifications_status_idx").on(table.status),
    t.index("notifications_created_at_idx").on(table.createdAt),
  ],
);

export const notificationDeliveries = t.pgTable(
  "notification_deliveries",
  {
    id: id(),
    notificationId: t
      .uuid("notification_id")
      .notNull()
      .references(() => notifications.id),
    targetId: t
      .uuid("target_id")
      .notNull()
      .references(() => notificationTargets.id),
    channel: notificationTargetType("channel").notNull(),
    status: notificationDeliveryStatus("status").default("pending").notNull(),
    sentAt: t.timestamp("sent_at", { withTimezone: true }),
    failedReason: t.text("failed_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    t
      .uniqueIndex("notification_deliveries_notification_target_unique")
      .on(table.notificationId, table.targetId),
    t
      .index("notification_deliveries_notification_id_idx")
      .on(table.notificationId),
    t.index("notification_deliveries_target_id_idx").on(table.targetId),
    t.index("notification_deliveries_status_idx").on(table.status),
  ],
);

export const hardwareErrorCodeConfigs = t.pgTable(
  "hardware_error_code_configs",
  {
    id: id(),
    errorCode: t.varchar("error_code", { length: 64 }).notNull(),
    restoreInventory: t.boolean("restore_inventory").notNull(),
    faultSlot: t.boolean("fault_slot").notNull(),
    requestRefund: t.boolean("request_refund").notNull(),
    createWorkOrder: t.boolean("create_work_order").notNull(),
    severity: notificationSeverity("severity").default("critical").notNull(),
    status: paymentProviderStatus("status").default("enabled").notNull(),
    updatedByAdminUserId: t
      .uuid("updated_by_admin_user_id")
      .references(() => adminUsers.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    t
      .uniqueIndex("hardware_error_code_configs_error_code_unique")
      .on(table.errorCode),
    t.index("hardware_error_code_configs_status_idx").on(table.status),
  ],
);

export const machineRemoteOps = t.pgTable(
  "machine_remote_ops",
  {
    id: id(),
    machineId: t
      .uuid("machine_id")
      .notNull()
      .references(() => machines.id),
    type: t.varchar("type", { length: 64 }).notNull(),
    status: t.varchar("status", { length: 32 }).default("pending").notNull(),
    requestedByAdminUserId: t
      .uuid("requested_by_admin_user_id")
      .references(() => adminUsers.id),
    requestedAt: createdAt(),
    acceptedAt: t.timestamp("accepted_at", { withTimezone: true }),
    finishedAt: t.timestamp("finished_at", { withTimezone: true }),
    failedReason: t.text("failed_reason"),
    resultJson: t.jsonb("result_json").$type<JsonObject>(),
  },
  (table) => [
    t.index("machine_remote_ops_machine_id_idx").on(table.machineId),
    t.index("machine_remote_ops_status_idx").on(table.status),
  ],
);

export const machineLogArtifacts = t.pgTable(
  "machine_log_artifacts",
  {
    id: id(),
    opId: t
      .uuid("op_id")
      .notNull()
      .references(() => machineRemoteOps.id),
    machineId: t
      .uuid("machine_id")
      .notNull()
      .references(() => machines.id),
    fileName: t.varchar("file_name", { length: 255 }).notNull(),
    contentType: t.varchar("content_type", { length: 128 }).notNull(),
    sizeBytes: t.integer("size_bytes").notNull(),
    storagePath: t.text("storage_path").notNull(),
    dedupeKey: t.varchar("dedupe_key", { length: 255 }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    t.index("machine_log_artifacts_op_id_idx").on(table.opId),
    t.index("machine_log_artifacts_machine_id_idx").on(table.machineId),
    t
      .uniqueIndex("machine_log_artifacts_dedupe_key_unique")
      .on(table.dedupeKey),
  ],
);

export const maintenanceWorkOrders = t.pgTable(
  "maintenance_work_orders",
  {
    id: id(),
    workOrderNo: t.varchar("work_order_no", { length: 64 }).notNull(),
    machineId: t.uuid("machine_id").references(() => machines.id),
    slotId: t.uuid("slot_id").references(() => machineSlots.id),
    orderId: t.uuid("order_id").references(() => orders.id),
    commandId: t.uuid("command_id").references(() => vendingCommands.id),
    title: t.varchar("title", { length: 128 }).notNull(),
    description: t.text("description").notNull(),
    priority: t.varchar("priority", { length: 32 }).default("medium").notNull(),
    status: t.varchar("status", { length: 32 }).default("open").notNull(),
    assigneeAdminUserId: t
      .uuid("assignee_admin_user_id")
      .references(() => adminUsers.id),
    resolutionNote: t.text("resolution_note"),
    dedupeKey: t.varchar("dedupe_key", { length: 255 }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    resolvedAt: t.timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [
    t.uniqueIndex("maintenance_work_orders_no_unique").on(table.workOrderNo),
    t
      .uniqueIndex("maintenance_work_orders_dedupe_key_unique")
      .on(table.dedupeKey),
    t.index("maintenance_work_orders_status_idx").on(table.status),
    t.index("maintenance_work_orders_machine_id_idx").on(table.machineId),
  ],
);

export const paymentWebhookAttempts = t.pgTable(
  "payment_webhook_attempts",
  {
    id: id(),
    providerId: t.uuid("provider_id").references(() => paymentProviders.id),
    providerCode: t.varchar("provider_code", { length: 64 }).notNull(),
    paymentId: t.uuid("payment_id").references(() => payments.id),
    refundId: t.uuid("refund_id").references(() => refunds.id),
    matchedConfigId: t
      .uuid("matched_config_id")
      .references(() => paymentProviderConfigs.id),
    eventKind: t
      .varchar("event_kind", { length: 32 })
      .default("unknown")
      .notNull(),
    eventType: t.varchar("event_type", { length: 128 }),
    providerEventId: t.varchar("provider_event_id", { length: 128 }),
    paymentNo: t.varchar("payment_no", { length: 64 }),
    refundNo: t.varchar("refund_no", { length: 64 }),
    orderNo: t.varchar("order_no", { length: 64 }),
    remoteIp: t.varchar("remote_ip", { length: 64 }),
    userAgent: t.text("user_agent"),
    headersHash: t.text("headers_hash").notNull(),
    headersSummaryJson: t
      .jsonb("headers_summary_json")
      .$type<JsonObject>()
      .notNull(),
    rawBodySha256: t.text("raw_body_sha256").notNull(),
    rawBodyBytes: t.integer("raw_body_bytes").notNull(),
    rawBodyExcerpt: t.text("raw_body_excerpt"),
    redactedPayloadJson: t.jsonb("redacted_payload_json").$type<JsonObject>(),
    signatureValid: t.boolean("signature_valid"),
    businessValid: t.boolean("business_valid"),
    handled: t.boolean("handled").default(false).notNull(),
    duplicate: t.boolean("duplicate").default(false).notNull(),
    failureReason: t.varchar("failure_reason", { length: 128 }),
    errorCode: t.varchar("error_code", { length: 128 }),
    httpStatus: t.integer("http_status"),
    retentionUntil: t
      .timestamp("retention_until", { withTimezone: true })
      .notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    t
      .index("payment_webhook_attempts_provider_created_idx")
      .on(table.providerCode, table.createdAt),
    t.index("payment_webhook_attempts_payment_id_idx").on(table.paymentId),
    t.index("payment_webhook_attempts_refund_id_idx").on(table.refundId),
    t.index("payment_webhook_attempts_signature_idx").on(table.signatureValid),
    t
      .index("payment_webhook_attempts_failure_reason_idx")
      .on(table.failureReason),
    t.index("payment_webhook_attempts_retention_idx").on(table.retentionUntil),
  ],
);

export const paymentReconciliationAttempts = t.pgTable(
  "payment_reconciliation_attempts",
  {
    id: id(),
    paymentId: t
      .uuid("payment_id")
      .notNull()
      .references(() => payments.id),
    providerId: t
      .uuid("provider_id")
      .notNull()
      .references(() => paymentProviders.id),
    trigger: t.varchar("trigger", { length: 32 }).notNull(),
    attemptNo: t.integer("attempt_no").notNull(),
    status: t.varchar("status", { length: 32 }).notNull(),
    providerPaymentStatus: t.varchar("provider_payment_status", { length: 64 }),
    providerTradeNo: t.varchar("provider_trade_no", { length: 128 }),
    errorCode: t.varchar("error_code", { length: 128 }),
    errorMessage: t.text("error_message"),
    rawPayloadSha256: t.text("raw_payload_sha256"),
    rawPayloadExcerpt: t.text("raw_payload_excerpt"),
    nextRetryAt: t.timestamp("next_retry_at", { withTimezone: true }),
    startedAt: t.timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: t.timestamp("finished_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    t
      .index("payment_reconciliation_attempts_payment_idx")
      .on(table.paymentId, table.createdAt),
    t
      .index("payment_reconciliation_attempts_next_retry_idx")
      .on(table.nextRetryAt),
    t.index("payment_reconciliation_attempts_status_idx").on(table.status),
  ],
);

export const refundEvents = t.pgTable(
  "refund_events",
  {
    id: id(),
    refundId: t
      .uuid("refund_id")
      .notNull()
      .references(() => refunds.id),
    paymentId: t
      .uuid("payment_id")
      .notNull()
      .references(() => payments.id),
    providerId: t
      .uuid("provider_id")
      .notNull()
      .references(() => paymentProviders.id),
    eventType: t.varchar("event_type", { length: 128 }).notNull(),
    providerEventId: t.varchar("provider_event_id", { length: 128 }).notNull(),
    providerRefundNo: t.varchar("provider_refund_no", { length: 128 }),
    status: refundStatus("status").notNull(),
    rawPayloadJson: t.jsonb("raw_payload_json").$type<JsonObject>().notNull(),
    signatureValid: t.boolean("signature_valid"),
    handledAt: t.timestamp("handled_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    t
      .uniqueIndex("refund_events_provider_event_unique")
      .on(table.providerId, table.providerEventId),
    t.index("refund_events_refund_id_idx").on(table.refundId),
  ],
);

export const refundReconciliationAttempts = t.pgTable(
  "refund_reconciliation_attempts",
  {
    id: id(),
    refundId: t
      .uuid("refund_id")
      .notNull()
      .references(() => refunds.id),
    providerId: t
      .uuid("provider_id")
      .notNull()
      .references(() => paymentProviders.id),
    trigger: t.varchar("trigger", { length: 32 }).notNull(),
    attemptNo: t.integer("attempt_no").notNull(),
    status: t.varchar("status", { length: 32 }).notNull(),
    providerRefundStatus: t.varchar("provider_refund_status", { length: 64 }),
    providerRefundNo: t.varchar("provider_refund_no", { length: 128 }),
    errorCode: t.varchar("error_code", { length: 128 }),
    errorMessage: t.text("error_message"),
    rawPayloadSha256: t.text("raw_payload_sha256"),
    rawPayloadExcerpt: t.text("raw_payload_excerpt"),
    nextRetryAt: t.timestamp("next_retry_at", { withTimezone: true }),
    startedAt: t.timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: t.timestamp("finished_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    t
      .index("refund_reconciliation_attempts_refund_idx")
      .on(table.refundId, table.createdAt),
    t
      .index("refund_reconciliation_attempts_next_retry_idx")
      .on(table.nextRetryAt),
  ],
);
