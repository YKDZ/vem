import { defineRelations } from "drizzle-orm";

import {
  adminUserRoles,
  adminUsers,
  auditLogs,
  inventories,
  inventoryMovements,
  inventoryReservations,
  machineEvents,
  machineClaimCodes,
  machineCommands,
  machineHeartbeats,
  maintenancePeers,
  maintenanceSshCertificates,
  maintenanceSessions,
  machinePlanogramSlots,
  machinePlanogramVersions,
  machines,
  machineSlots,
  notificationDeliveries,
  notifications,
  notificationTargets,
  orderItems,
  orderRecoveryActions,
  orders,
  orderStatusEvents,
  paymentCodeAttempts,
  paymentEvents,
  paymentProviderConfigs,
  paymentProviders,
  paymentReconciliationAttempts,
  payments,
  paymentUserSnapshots,
  paymentWebhookAttempts,
  permissions,
  productCategories,
  products,
  productVariants,
  refreshTokens,
  refundEvents,
  refundReconciliationAttempts,
  refunds,
  rolePermissions,
  roles,
  vendingCommands,
} from "./schema";

export const relations = defineRelations(
  {
    adminUserRoles,
    adminUsers,
    auditLogs,
    inventories,
    inventoryMovements,
    inventoryReservations,
    machineEvents,
    machineClaimCodes,
    machineCommands,
    machineHeartbeats,
    maintenancePeers,
    maintenanceSshCertificates,
    maintenanceSessions,
    machinePlanogramSlots,
    machinePlanogramVersions,
    machines,
    machineSlots,
    notificationDeliveries,
    notifications,
    notificationTargets,
    paymentReconciliationAttempts,
    paymentWebhookAttempts,
    paymentCodeAttempts,
    refundEvents,
    refundReconciliationAttempts,
    orderItems,
    orderRecoveryActions,
    orders,
    orderStatusEvents,
    paymentEvents,
    paymentProviderConfigs,
    paymentProviders,
    payments,
    paymentUserSnapshots,
    permissions,
    productCategories,
    products,
    productVariants,
    refreshTokens,
    refunds,
    rolePermissions,
    roles,
    vendingCommands,
  },
  (r) => ({
    adminUsers: {
      roles: r.many.adminUserRoles(),
      refreshTokens: r.many.refreshTokens(),
      auditLogs: r.many.auditLogs(),
      maintenanceSessions: r.many.maintenanceSessions(),
    },
    refreshTokens: {
      adminUser: r.one.adminUsers({
        from: r.refreshTokens.adminUserId,
        to: r.adminUsers.id,
      }),
    },
    auditLogs: {
      adminUser: r.one.adminUsers({
        from: r.auditLogs.adminUserId,
        to: r.adminUsers.id,
      }),
    },
    adminUserRoles: {
      adminUser: r.one.adminUsers({
        from: r.adminUserRoles.adminUserId,
        to: r.adminUsers.id,
      }),
      role: r.one.roles({
        from: r.adminUserRoles.roleId,
        to: r.roles.id,
      }),
    },
    roles: {
      users: r.many.adminUserRoles(),
      permissions: r.many.rolePermissions(),
    },
    rolePermissions: {
      role: r.one.roles({
        from: r.rolePermissions.roleId,
        to: r.roles.id,
      }),
      permission: r.one.permissions({
        from: r.rolePermissions.permissionId,
        to: r.permissions.id,
      }),
    },
    permissions: {
      roles: r.many.rolePermissions(),
    },
    productCategories: {
      parent: r.one.productCategories({
        from: r.productCategories.parentId,
        to: r.productCategories.id,
        alias: "parent_category",
      }),
      products: r.many.products(),
    },
    products: {
      category: r.one.productCategories({
        from: r.products.categoryId,
        to: r.productCategories.id,
      }),
      variants: r.many.productVariants(),
    },
    productVariants: {
      product: r.one.products({
        from: r.productVariants.productId,
        to: r.products.id,
      }),
      inventories: r.many.inventories(),
      orderItems: r.many.orderItems(),
    },
    machines: {
      slots: r.many.machineSlots(),
      inventories: r.many.inventories(),
      orders: r.many.orders(),
      commands: r.many.machineCommands(),
      events: r.many.machineEvents(),
      claimCodes: r.many.machineClaimCodes(),
      heartbeats: r.many.machineHeartbeats(),
      planogramVersions: r.many.machinePlanogramVersions(),
      maintenancePeers: r.many.maintenancePeers(),
      maintenanceSessions: r.many.maintenanceSessions(),
    },
    maintenancePeers: {
      machine: r.one.machines({
        from: r.maintenancePeers.machineId,
        to: r.machines.id,
      }),
      sourceSessions: r.many.maintenanceSessions({
        alias: "maintenance_session_source_peer",
      }),
      targetSessions: r.many.maintenanceSessions({
        alias: "maintenance_session_target_peer",
      }),
    },
    maintenanceSessions: {
      sshCertificates: r.many.maintenanceSshCertificates(),
      sourcePeer: r.one.maintenancePeers({
        from: r.maintenanceSessions.sourcePeerId,
        to: r.maintenancePeers.id,
        alias: "maintenance_session_source_peer",
      }),
      targetPeer: r.one.maintenancePeers({
        from: r.maintenanceSessions.targetPeerId,
        to: r.maintenancePeers.id,
        alias: "maintenance_session_target_peer",
      }),
      targetMachine: r.one.machines({
        from: r.maintenanceSessions.targetMachineId,
        to: r.machines.id,
      }),
      actor: r.one.adminUsers({
        from: r.maintenanceSessions.issuedByAdminUserId,
        to: r.adminUsers.id,
      }),
    },
    maintenanceSshCertificates: {
      session: r.one.maintenanceSessions({
        from: r.maintenanceSshCertificates.sessionId,
        to: r.maintenanceSessions.id,
      }),
    },
    machineClaimCodes: {
      machine: r.one.machines({
        from: r.machineClaimCodes.machineId,
        to: r.machines.id,
      }),
      createdByAdminUser: r.one.adminUsers({
        from: r.machineClaimCodes.createdByAdminUserId,
        to: r.adminUsers.id,
      }),
      revokedByAdminUser: r.one.adminUsers({
        from: r.machineClaimCodes.revokedByAdminUserId,
        to: r.adminUsers.id,
      }),
    },
    machinePlanogramVersions: {
      machine: r.one.machines({
        from: r.machinePlanogramVersions.machineId,
        to: r.machines.id,
      }),
      slots: r.many.machinePlanogramSlots(),
    },
    machinePlanogramSlots: {
      version: r.one.machinePlanogramVersions({
        from: r.machinePlanogramSlots.machinePlanogramVersionId,
        to: r.machinePlanogramVersions.id,
      }),
      slot: r.one.machineSlots({
        from: r.machinePlanogramSlots.slotId,
        to: r.machineSlots.id,
      }),
    },
    machineSlots: {
      machine: r.one.machines({
        from: r.machineSlots.machineId,
        to: r.machines.id,
      }),
      inventory: r.one.inventories({
        from: r.machineSlots.id,
        to: r.inventories.slotId,
      }),
    },
    inventories: {
      machine: r.one.machines({
        from: r.inventories.machineId,
        to: r.machines.id,
      }),
      slot: r.one.machineSlots({
        from: r.inventories.slotId,
        to: r.machineSlots.id,
      }),
      variant: r.one.productVariants({
        from: r.inventories.variantId,
        to: r.productVariants.id,
      }),
      reservations: r.many.inventoryReservations(),
      movements: r.many.inventoryMovements(),
    },
    inventoryReservations: {
      order: r.one.orders({
        from: r.inventoryReservations.orderId,
        to: r.orders.id,
      }),
      inventory: r.one.inventories({
        from: r.inventoryReservations.inventoryId,
        to: r.inventories.id,
      }),
    },
    inventoryMovements: {
      inventory: r.one.inventories({
        from: r.inventoryMovements.inventoryId,
        to: r.inventories.id,
      }),
      order: r.one.orders({
        from: r.inventoryMovements.orderId,
        to: r.orders.id,
      }),
      operator: r.one.adminUsers({
        from: r.inventoryMovements.operatorAdminUserId,
        to: r.adminUsers.id,
      }),
    },
    orders: {
      machine: r.one.machines({
        from: r.orders.machineId,
        to: r.machines.id,
      }),
      items: r.many.orderItems(),
      statusEvents: r.many.orderStatusEvents(),
      payments: r.many.payments(),
      paymentCodeAttempts: r.many.paymentCodeAttempts(),
      vendingCommands: r.many.vendingCommands(),
      inventoryReservations: r.many.inventoryReservations(),
    },
    orderStatusEvents: {
      order: r.one.orders({
        from: r.orderStatusEvents.orderId,
        to: r.orders.id,
      }),
    },
    orderItems: {
      order: r.one.orders({
        from: r.orderItems.orderId,
        to: r.orders.id,
      }),
      variant: r.one.productVariants({
        from: r.orderItems.variantId,
        to: r.productVariants.id,
      }),
      inventory: r.one.inventories({
        from: r.orderItems.inventoryId,
        to: r.inventories.id,
      }),
      slot: r.one.machineSlots({
        from: r.orderItems.slotId,
        to: r.machineSlots.id,
      }),
    },
    payments: {
      order: r.one.orders({
        from: r.payments.orderId,
        to: r.orders.id,
      }),
      provider: r.one.paymentProviders({
        from: r.payments.providerId,
        to: r.paymentProviders.id,
      }),
      providerConfig: r.one.paymentProviderConfigs({
        from: r.payments.paymentProviderConfigId,
        to: r.paymentProviderConfigs.id,
      }),
      payerSnapshot: r.one.paymentUserSnapshots({
        from: r.payments.payerSnapshotId,
        to: r.paymentUserSnapshots.id,
      }),
      paymentCodeAttempts: r.many.paymentCodeAttempts(),
      events: r.many.paymentEvents(),
      refunds: r.many.refunds(),
      webhookAttempts: r.many.paymentWebhookAttempts(),
      reconciliationAttempts: r.many.paymentReconciliationAttempts(),
    },
    paymentUserSnapshots: {
      payments: r.many.payments(),
    },
    paymentProviders: {
      configs: r.many.paymentProviderConfigs(),
      payments: r.many.payments(),
      paymentCodeAttempts: r.many.paymentCodeAttempts(),
      events: r.many.paymentEvents(),
      webhookAttempts: r.many.paymentWebhookAttempts(),
      reconciliationAttempts: r.many.paymentReconciliationAttempts(),
      refundEvents: r.many.refundEvents(),
      refundReconciliationAttempts: r.many.refundReconciliationAttempts(),
    },
    paymentProviderConfigs: {
      provider: r.one.paymentProviders({
        from: r.paymentProviderConfigs.providerId,
        to: r.paymentProviders.id,
      }),
      machine: r.one.machines({
        from: r.paymentProviderConfigs.machineId,
        to: r.machines.id,
      }),
      paymentCodeAttempts: r.many.paymentCodeAttempts(),
    },
    paymentCodeAttempts: {
      payment: r.one.payments({
        from: r.paymentCodeAttempts.paymentId,
        to: r.payments.id,
      }),
      order: r.one.orders({
        from: r.paymentCodeAttempts.orderId,
        to: r.orders.id,
      }),
      provider: r.one.paymentProviders({
        from: r.paymentCodeAttempts.providerId,
        to: r.paymentProviders.id,
      }),
      providerConfig: r.one.paymentProviderConfigs({
        from: r.paymentCodeAttempts.paymentProviderConfigId,
        to: r.paymentProviderConfigs.id,
      }),
    },
    paymentEvents: {
      payment: r.one.payments({
        from: r.paymentEvents.paymentId,
        to: r.payments.id,
      }),
      provider: r.one.paymentProviders({
        from: r.paymentEvents.providerId,
        to: r.paymentProviders.id,
      }),
    },
    refunds: {
      payment: r.one.payments({
        from: r.refunds.paymentId,
        to: r.payments.id,
      }),
      order: r.one.orders({
        from: r.refunds.orderId,
        to: r.orders.id,
      }),
      events: r.many.refundEvents(),
      reconciliationAttempts: r.many.refundReconciliationAttempts(),
    },
    paymentWebhookAttempts: {
      payment: r.one.payments({
        from: r.paymentWebhookAttempts.paymentId,
        to: r.payments.id,
      }),
      refund: r.one.refunds({
        from: r.paymentWebhookAttempts.refundId,
        to: r.refunds.id,
      }),
      provider: r.one.paymentProviders({
        from: r.paymentWebhookAttempts.providerId,
        to: r.paymentProviders.id,
      }),
    },
    paymentReconciliationAttempts: {
      payment: r.one.payments({
        from: r.paymentReconciliationAttempts.paymentId,
        to: r.payments.id,
      }),
      provider: r.one.paymentProviders({
        from: r.paymentReconciliationAttempts.providerId,
        to: r.paymentProviders.id,
      }),
    },
    refundEvents: {
      refund: r.one.refunds({
        from: r.refundEvents.refundId,
        to: r.refunds.id,
      }),
      payment: r.one.payments({
        from: r.refundEvents.paymentId,
        to: r.payments.id,
      }),
      provider: r.one.paymentProviders({
        from: r.refundEvents.providerId,
        to: r.paymentProviders.id,
      }),
    },
    refundReconciliationAttempts: {
      refund: r.one.refunds({
        from: r.refundReconciliationAttempts.refundId,
        to: r.refunds.id,
      }),
      provider: r.one.paymentProviders({
        from: r.refundReconciliationAttempts.providerId,
        to: r.paymentProviders.id,
      }),
    },
    vendingCommands: {
      order: r.one.orders({
        from: r.vendingCommands.orderId,
        to: r.orders.id,
      }),
      machine: r.one.machines({
        from: r.vendingCommands.machineId,
        to: r.machines.id,
      }),
      slot: r.one.machineSlots({
        from: r.vendingCommands.slotId,
        to: r.machineSlots.id,
      }),
    },
    orderRecoveryActions: {
      order: r.one.orders({
        from: r.orderRecoveryActions.orderId,
        to: r.orders.id,
      }),
      command: r.one.vendingCommands({
        from: r.orderRecoveryActions.commandId,
        to: r.vendingCommands.id,
      }),
      requestedByAdminUser: r.one.adminUsers({
        from: r.orderRecoveryActions.requestedByAdminUserId,
        to: r.adminUsers.id,
      }),
    },
    machineCommands: {
      machine: r.one.machines({
        from: r.machineCommands.machineId,
        to: r.machines.id,
      }),
      requestedByAdminUser: r.one.adminUsers({
        from: r.machineCommands.requestedByAdminUserId,
        to: r.adminUsers.id,
      }),
    },
    machineEvents: {
      machine: r.one.machines({
        from: r.machineEvents.machineId,
        to: r.machines.id,
      }),
    },
    machineHeartbeats: {
      machine: r.one.machines({
        from: r.machineHeartbeats.machineId,
        to: r.machines.id,
      }),
    },
    notificationTargets: {
      deliveries: r.many.notificationDeliveries(),
    },
    notifications: {
      deliveries: r.many.notificationDeliveries(),
    },
    notificationDeliveries: {
      notification: r.one.notifications({
        from: r.notificationDeliveries.notificationId,
        to: r.notifications.id,
      }),
      target: r.one.notificationTargets({
        from: r.notificationDeliveries.targetId,
        to: r.notificationTargets.id,
      }),
    },
  }),
);
