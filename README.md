# VEM

VEM 是面向服装零售场景的智能售货机软件系统。仓库包含售货机触屏端、本机 daemon、后端 API、运营管理后台、共享契约、硬件模拟器和验收工具。真实视觉运行程序由 `hbhjt/vending-vision` 仓库交付、下位机程序由 `Luminescence114/F4_shoppingmach` 仓库交付，本仓库负责安装、配置和集成。

## 主要模块

| 模块         | 位置                                             | 说明                                                            |
| ------------ | ------------------------------------------------ | --------------------------------------------------------------- |
| 售货机触屏端 | `apps/machine`                                   | Vue 3 + Tauri，提供商品浏览、支付、出货、结果页和维护界面。     |
| 本机 daemon  | `apps/vending-daemon`                            | Rust 运行时，负责硬件通信、扫码器、MQTT、出货、库存和本地 IPC。 |
| 后端 API     | `apps/service-api`                               | NestJS 服务，负责商品、库存、订单、支付、机器管理和 MQTT 桥接。 |
| 运营管理后台 | `apps/admin-ui`                                  | Vue 3 + Ant Design Vue，提供商品、订单、机器、支付和运维管理。  |
| 共享契约     | `packages/shared`、`crates/daemon-ipc-contracts` | 前后端、daemon 和机器端共享的数据契约。                         |
| 数据库       | `packages/db`                                    | Drizzle schema、migration 和数据库客户端。                      |
| 核心领域库   | `crates/vending-core`                            | Rust 共享领域逻辑和协议实现。                                   |
| 视觉模拟服务 | `apps/vision-mock`                               | VM 验收和本地测试使用的视觉边界模拟。                           |
| 下位机模拟器 | `apps/lower-controller-sim`                      | 下位机串口协议模拟器。                                          |

## 运行依赖

开发环境建议使用 Dev Container。手动配置时需要：

- Node.js 24
- pnpm 11.9
- Rust stable
- Docker 和 Docker Compose
- Playwright Chromium 运行依赖

机器端验收依赖可重置的 Windows 10 VM。基线构建和运行说明见 [VM 运行时验收平台](public/development/vm-runtime-acceptance.md)。

## 安装依赖

```bash
pnpm install
```

## 常用命令

```bash
pnpm fmt:check
pnpm typecheck
pnpm lint
pnpm ci:unit
pnpm ci:static
```

格式化：

```bash
pnpm fmt
```

后端 Compose 冒烟：

```bash
pnpm compose-smoke:backend \
  --service-api-image ghcr.io/ykdz/vem-service-api@sha256:<64-hex> \
  --admin-ui-image ghcr.io/ykdz/vem-admin-ui@sha256:<64-hex>
```

后台浏览器验收：

```bash
pnpm ci:admin-browser
```

## 本地开发

后端依赖 PostgreSQL 和 Mosquitto。仓库维护的部署入口是：

```bash
docker compose -f apps/service-api/docker-compose.yml up -d
```

常用开发服务：

```bash
pnpm --filter service-api dev
pnpm --filter admin-ui dev
pnpm --filter machine dev
pnpm --filter vision-mock dev
```

数据库迁移：

```bash
pnpm --filter @vem/db migrate
```

## 验收方式

机器端购买、支付、出货、视觉、语音、维护和错误恢复以 Windows VM 安装态验收为准。运行当前提交的 full 验收：

```bash
node scripts/testbed/runtime-testbed-trigger.mjs run \
  --mode full \
  --commit "$(git rev-parse HEAD)" \
  --config /abs/path/to/runtime-testbed-host.json \
  --out /abs/path/to/runtime-testbed-result.json
```

日常调试可使用 fast 模式选择一个或多个业务集合：

```bash
node scripts/testbed/runtime-testbed-trigger.mjs run \
  --mode fast \
  --focus sale \
  --focus scannerPayment \
  --commit "$(git rev-parse HEAD)" \
  --config /abs/path/to/runtime-testbed-host.json \
  --out /abs/path/to/runtime-testbed-result.json
```

后台管理端使用 Playwright 浏览器验收，机器端不再维护独立浏览器 E2E 路径。

## 部署和操作文档

- 后端部署：[public/deployment/backend-deployment.md](public/deployment/backend-deployment.md)
- 运营操作：[public/manual/operator-manual.md](public/manual/operator-manual.md)
- 开发协作：[CONTRIBUTING.md](CONTRIBUTING.md)
