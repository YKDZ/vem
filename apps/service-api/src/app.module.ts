import { Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";

import { AccessModule } from "./access/access.module";
import { PermissionsGuard } from "./access/permissions.guard";
import { AdminUsersModule } from "./admin-users/admin-users.module";
import { AuditModule } from "./audit/audit.module";
import { AuthModule } from "./auth/auth.module";
import { JwtAuthGuard } from "./auth/jwt-auth.guard";
import { BootstrapModule } from "./bootstrap/bootstrap.module";
import { AllExceptionsFilter } from "./common/all-exceptions.filter";
import { ApiResponseInterceptor } from "./common/api-response.interceptor";
import { ConfigModule } from "./config/config.module";
import { DashboardModule } from "./dashboard/dashboard.module";
import { DatabaseModule } from "./database/database.module";
import { HardwareErrorPoliciesModule } from "./hardware-error-policies/hardware-error-policies.module";
import { HealthModule } from "./health/health.module";
import { InventoryModule } from "./inventory/inventory.module";
import { MachineAuthModule } from "./machine-auth/machine-auth.module";
import { MachineOpsModule } from "./machine-ops/machine-ops.module";
import { MachinesModule } from "./machines/machines.module";
import { MaintenanceWorkOrdersModule } from "./maintenance-work-orders/maintenance-work-orders.module";
import { MqttModule } from "./mqtt/mqtt.module";
import { NotificationsModule } from "./notifications/notifications.module";
import { OrdersModule } from "./orders/orders.module";
import { PaymentsModule } from "./payments/payments.module";
import { ProductsModule } from "./products/products.module";
import { RolesModule } from "./roles/roles.module";
import { VendingModule } from "./vending/vending.module";

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    MqttModule,
    HealthModule,
    AccessModule,
    AuthModule,
    MachineAuthModule,
    BootstrapModule,
    ProductsModule,
    MachinesModule,
    InventoryModule,
    PaymentsModule,
    OrdersModule,
    VendingModule,
    NotificationsModule,
    DashboardModule,
    AuditModule,
    AdminUsersModule,
    RolesModule,
    MachineOpsModule,
    HardwareErrorPoliciesModule,
    MaintenanceWorkOrdersModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: ApiResponseInterceptor },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AppModule {}
