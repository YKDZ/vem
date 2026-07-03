# VEM

VEM 是智能自动售货机软件系统，覆盖机器端触屏 UI、机器本地 daemon、后端 API、运营管理后台、视觉模拟服务、下位机模拟器和共享类型契约。

## 模块

| 模块         | 位置                        | 说明                                                                                                       |
| ------------ | --------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 机器端 UI    | `apps/machine`              | Vue 3 + Tauri shell。面向 1080x1920 触屏售货体验，包含目录、支付、出货、结果、离线和维护界面。             |
| 机器 daemon  | `apps/vending-daemon`       | Rust 本地运行时。负责机器配置、daemon IPC、硬件/扫码器适配、MQTT、心跳、出货指令、离线 outbox 和本地状态。 |
| 核心领域库   | `crates/vending-core`       | Rust 共享领域逻辑。                                                                                        |
| 后端 API     | `apps/service-api`          | NestJS 11 + PostgreSQL。负责管理接口、机器鉴权、目录/库存/订单、支付、MQTT 桥接和审计。                    |
| 管理后台     | `apps/admin-ui`             | Vue 3 + Ant Design Vue。负责商品、库存、订单、机器和运维管理。                                             |
| 视觉模拟服务 | `apps/vision-mock`          | WebSocket 视觉 runtime mock，用于本地开发和测试。                                                          |
| 下位机模拟器 | `apps/lower-controller-sim` | 下位机协议/硬件模拟辅助。                                                                                  |
| 共享类型     | `packages/shared`           | TypeScript + Zod 契约，被前后端共享。                                                                      |
| 数据库包     | `packages/db`               | Drizzle schema、migration 和 DB 客户端。                                                                   |

## 仓库结构

```text
vem/
├── apps/
│   ├── admin-ui/
│   ├── lower-controller-sim/
│   ├── machine/
│   ├── service-api/
│   ├── vending-daemon/
│   └── vision-mock/
├── crates/
│   └── vending-core/
├── packages/
│   ├── db/
│   └── shared/
├── docs/
├── protocol/
├── scripts/
├── CONTRIBUTING.md
├── Cargo.toml
├── package.json
├── pnpm-workspace.yaml
└── turbo.json
```

## 环境要求

推荐使用仓库内置 Dev Container。手动配置时需要：

- Node.js 24+
- pnpm 11.9.0
- Rust stable
- Docker（本地 PostgreSQL / MQTT）
- Chrome 或 Playwright 浏览器依赖

安装依赖：

```bash
pnpm install
```

## 常用开发命令

启动后端基础设施：

```bash
docker compose -f apps/service-api/docker-compose.yml up -d
```

运行数据库迁移：

```bash
pnpm --filter @vem/db migrate
```

启动服务：

```bash
pnpm --filter service-api dev
pnpm --filter admin-ui dev
pnpm --filter machine dev
pnpm --filter vision-mock dev
```

启动本地机器 daemon console：

```bash
cargo run -p vending-daemon -- --console --data-dir ./.local/vending-daemon --bind 127.0.0.1:7891
```

daemon console 会在数据目录写入 ready file、token、SQLite state 和日志。浏览器 UI 通过 ready file 中的 token 访问 daemon IPC。

## 检查与测试

推送前优先运行：

```bash
pnpm fmt:check
pnpm turbo typecheck
pnpm turbo lint
pnpm turbo test
```

机器端触屏 E2E：

```bash
pnpm -F machine test:e2e:touch-smoke
```

机器端截图巡检：

```bash
pnpm -F machine test:e2e:screenshots
pnpm -F machine screenshots:runtime:stitch
```

截图产物写入：

```text
apps/machine/runtime-screenshot-artifacts/
```

更多协作、PR、CI 和截图系统说明见 [CONTRIBUTING.md](./CONTRIBUTING.md)。
