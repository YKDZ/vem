---
name: local-e2e-testing
description: >-
  VEM 售货机系统本地全流程端到端测试指南。覆盖基础设施启动、三个服务（service-api / admin-ui / machine）的构建与运行、
  机器售货机 UI 配置与引导、完整购买流程验证、管理后台核验、以及常见问题排查。
  当用户提到"本地测试"、"跑起来"、"全流程测试"、"启动所有服务"、"e2e 测试"、"验证购买流程"、"机器 UI 测试"、"模拟支付"、
  "看看系统运行正不正常"时使用此 Skill。
---

# VEM 本地全流程端到端测试

## 一、系统架构速览

```
service-api   NestJS 11    端口 3000   后端 API + MQTT 客户端
admin-ui      Vue 3 + Vite 端口 5175   管理后台
machine       Vue 3 + Vite 端口 1420   售货机 Kiosk UI（含 Tauri，本地开发以浏览器模式运行）

PostgreSQL    vem-service-api-postgres-1  172.31.0.2:5432   数据库
MQTT          vem-service-api-mqtt-1      172.31.0.4:1883 (TCP) / 9001 (WS)
```

> **注意**：容器 IP 由 devcontainer 所在网络动态分配。devcontainer 占用 `172.31.0.3`，故 postgres 固定分到 `.2`，mqtt 固定分到 `.4`。若 IP 有变，用 `docker inspect <容器名> | grep IPAddress` 查询并更新下方 `.env` 及 `vite.config.ts`。

---

## 二、前置条件检查

### 2.1 检查 Docker 容器

```bash
docker ps --format "{{.Names}}\t{{.Status}}" | grep -E "postgres|mqtt"
```

必须看到两个容器均处于 `Up` 状态：

- `vem-service-api-postgres-1` — PostgreSQL 数据库
- `vem-service-api-mqtt-1` — Mosquitto MQTT Broker

如果未启动，进入 `apps/service-api` 执行：

```bash
docker compose up -d --build
```

> **第一次运行**：MQTT 服务使用 Dockerfile 构建（`mosquitto/Dockerfile`），`--build` 会触发构建，后续无改动时可省略 `--build`。

### 2.2 检查 .env 文件

**`apps/service-api/.env`**（不存在则创建）：

```dotenv
NODE_ENV=development
SERVICE_PORT=3000
DATABASE_URL=postgresql://vem:vem_password@172.31.0.2:5432/vem
JWT_SECRET=vem-admin-jwt-secret-key-for-development-use-only-32chars
JWT_REFRESH_SECRET=vem-admin-refresh-secret-key-for-development-32chars
CORS_ORIGINS=http://localhost:5173,http://localhost:5174,http://localhost:5175,http://localhost:1420
MQTT_URL=mqtt://172.31.0.4:1883
MQTT_USERNAME=vem_mqtt
MQTT_PASSWORD=vem_mqtt_password
PAYMENT_MOCK_ENABLED=true
PAYMENT_WEBHOOK_BASE_URL=http://localhost:3000
BOOTSTRAP_ADMIN_USERNAME=admin
BOOTSTRAP_ADMIN_PASSWORD=AdminPassword123!
MACHINE_JWT_SECRET=local-machine-jwt-secret-change-before-production-min32
MACHINE_CREDENTIAL_ENCRYPTION_KEY=local-cred-enc-key-change-before-production!
MACHINE_ACCESS_TTL_SECONDS=900
```

关键项说明：

- `PAYMENT_MOCK_ENABLED=true` — 必须为 true，否则模拟支付按钮报 403
- `CORS_ORIGINS` — 必须包含所有前端端口（machine 用 1420）

**`apps/machine/.env`**（不存在则创建）：

```dotenv
VITE_ENABLE_MOCK_PAYMENT_CONTROLS=true
```

---

## 三、构建共享包

每次代码有变动时，先构建共享依赖（`@vem/shared`、`@vem/db`）：

```bash
cd /workspaces/vem
pnpm --filter @vem/shared build
pnpm --filter @vem/db build
```

---

## 四、运行数据库迁移

```bash
cd packages/db
DATABASE_URL=postgresql://vem:vem_password@172.31.0.2:5432/vem pnpm drizzle-kit migrate
```

如果是全新环境，迁移会创建所有表；已有数据的情况下该命令是幂等的。

> **注意**：`packages/db` 目录下没有 `.env`，必须通过环境变量传入 `DATABASE_URL`。如果报 "type already exists" 错误，说明数据库有旧版迁移记录，需要先重置数据库：
>
> ```bash
> docker exec vem-service-api-postgres-1 psql -U vem -d postgres -c "DROP DATABASE IF EXISTS vem;"
> docker exec vem-service-api-postgres-1 psql -U vem -d postgres -c "CREATE DATABASE vem;"
> DATABASE_URL=postgresql://vem:vem_password@172.31.0.2:5432/vem pnpm drizzle-kit migrate
> ```

---

## 五、启动三个服务

### 5.1 service-api（后端）

```bash
cd apps/service-api
pnpm exec nest build
node dist/main.js > /tmp/service-api.log 2>&1 &
```

验证启动成功：

```bash
curl -s http://localhost:3000/api/health | python3 -m json.tool
```

期望结果：

```json
{
  "status": "ok",
  "database": "ok",
  "mqtt": "connected"
}
```

如果 `mqtt` 显示为 `disconnected`，检查 MQTT 容器是否运行，以及 `.env` 中的 IP 是否与 `docker inspect vem-service-api-mqtt-1` 一致。

### 5.2 admin-ui（管理后台）

```bash
cd apps/admin-ui
pnpm dev
```

默认监听 5175 端口（`vite.config.ts` 中 `port: 5175, strictPort: true`）。访问 `http://localhost:5175`，用 `admin / AdminPassword123!` 登录。

### 5.3 machine（售货机 UI）

```bash
cd apps/machine
pnpm dev
```

默认监听 1420 端口（`vite.config.ts` 中 strictPort）。

> **重要**：machine 的 `vite.config.ts` 必须包含两个代理：
>
> - `/api` → `http://localhost:3000`（API 转发）
> - `/mqtt-ws` → `ws://172.31.0.4:9001`（WebSocket 代理，浏览器不能直连 MQTT 容器）
>
> 如果 MQTT 容器 IP 变化，在 `vite.config.ts` 中更新 `/mqtt-ws` 代理的 `target`。

---

## 六、在管理后台完成数据准备

### 6.1 创建机器

1. 打开 `http://localhost:5175/machines` → 新建机器
2. 记录生成的 **机器编号**（如 `M-TEST-001`）和 **Machine Secret**（`vms_xxx...`）
3. 记录 **MQTT Signing Secret**

> Machine Secret 和 MQTT Signing Secret 仅在创建时可见，务必保存。

### 6.2 创建商品 + SKU

1. `http://localhost:5175/products` → 新建商品 → 新建 SKU（设置价格）

### 6.3 创建库存槽位

1. `http://localhost:5175/inventories` → 选择机器 → 新建槽位 → 关联 SKU → 设置 `on_hand_qty`

---

## 七、配置售货机 UI

首次访问 `http://localhost:1420` 会进入 **维护配置页**（`MaintenanceView`），也可以直接访问 `http://localhost:1420/#/maintenance`。

填写以下字段：

| 字段           | 值                                               |
| -------------- | ------------------------------------------------ |
| 机器编号       | 管理后台创建的机器编号，如 `M-TEST-001`          |
| API 地址       | `http://localhost:3000/api`                      |
| MQTT 地址      | `ws://localhost:1420/mqtt-ws`（通过 Vite proxy） |
| MQTT 用户名    | `vem_mqtt`                                       |
| 硬件适配器     | `mock`                                           |
| Machine Secret | `vms_xxx...`（从管理后台复制）                   |
| MQTT 签名密钥  | 从管理后台复制                                   |
| MQTT 密码      | `vem_mqtt_password`                              |

填写完成后点击"保存并重启"。机器会经历 Boot 页面（认证 → MQTT 连接 → 加载目录）后自动跳转到 `/catalog`。

> **注意**：Machine Secret 等密钥存储在内存中（`browserRuntimeSecrets`），**硬刷新页面会丢失**，需要重新进入 `/maintenance` 重新引导。

---

## 八、完整购买流程测试

### 步骤

1. **目录页** (`/catalog`)：确认商品显示，状态为"在线"，`剩余 N`
2. 点击**查看详情** → 商品详情页
3. 点击**立即购买** → 结账页
4. 点击**确认并生成支付二维码** → 支付页
5. 等待支付页加载出二维码和订单号（状态 `pending_payment`）
6. 点击**模拟支付成功**（仅在 `VITE_ENABLE_MOCK_PAYMENT_CONTROLS=true` 时出现）
7. 等待约 1-3 秒，机器自动跳转 `/result/success`
8. 确认显示"出货成功 ✓"、订单状态 `fulfilled`、支付状态 `succeeded`
9. 点击**返回首页**，确认目录页剩余数量已减少 1

### 预期状态流转

```
pending_payment → (mock succeed) → succeeded (支付) → fulfilled (订单)
```

---

## 九、管理后台核验

| 验证项   | 路径           | 预期                       |
| -------- | -------------- | -------------------------- |
| 订单记录 | `/orders`      | 最新订单状态为 `fulfilled` |
| 支付记录 | `/payments`    | 对应支付状态为 `succeeded` |
| 库存数量 | `/inventories` | `on_hand_qty` 减少 1       |
| 仪表盘   | `/dashboard`   | 今日销售额、订单数更新     |

---

## 十、常见问题与排查

### Q1: 模拟支付按钮点击后 401 Unauthorized

**原因**：机器 JWT Token 已过期或被清除，`clearPlaintextSecrets()` 清除了 Pinia store 中的 machineSecret，导致无法刷新 Token。

**解决**：

- `mock-payments.ts` 使用 `getMachineRuntimeConfig()` 直接从 `browserRuntimeSecrets`（内存，不受 `clearPlaintextSecrets` 影响）获取密钥并请求新 Token
- 如果仍然 401，执行**硬刷新**（Ctrl+Shift+R）后重新从 `/maintenance` 引导

> **HMR 陷阱**：Pinia store 的 action 实现不通过 HMR 更新，修改 store 相关代码后必须**硬刷新**页面，否则旧的 action 逻辑仍在运行。

### Q2: 模拟支付按钮点击后 403 Forbidden

**原因**：后端未开启模拟支付，`PAYMENT_MOCK_ENABLED` 未设置。

**解决**：确认 `apps/service-api/.env` 中 `PAYMENT_MOCK_ENABLED=true`，并重新构建/启动 service-api。

### Q3: Boot 页面卡住 / MQTT 连接失败

**原因**：

1. MQTT 容器未运行
2. `MQTT_URL` 中的 IP 与容器实际 IP 不匹配
3. machine UI 的 Vite proxy `/mqtt-ws` 未配置

**解决**：

```bash
# 检查 MQTT 容器 IP
docker inspect vem-service-api-mqtt-1 | grep '"IPAddress"'

# 检查 Vite proxy 配置（apps/machine/vite.config.ts）
# 应包含:
# '/mqtt-ws': { target: 'ws://172.31.0.4:9001', ws: true, changeOrigin: true }
```

> `BootView.vue` 中 MQTT 连接失败已用 try/catch 包裹，不会导致 Boot 崩溃，但机器将在无 MQTT 的情况下继续运行（状态指示器显示连接状态）。

### Q4: service-api 启动后 health 显示 mqtt: disconnected

检查 `.env` 中 `MQTT_URL` 的 IP 是否正确，与 `docker inspect` 结果一致。

### Q5: admin-ui 出现 HMR 错误 "Cannot access 'AdminLayout' before initialization"

这是 Vite HMR 热更新的循环引用问题，执行硬刷新（F5 或 Ctrl+Shift+R）即可恢复。

### Q6: 目录页显示机器"离线"

service-api 通过 MQTT 心跳判断机器状态，machine UI 每隔固定时间发送心跳。检查：

1. MQTT 是否已连接（machine UI 状态指示器）
2. `machineCode` 是否与管理后台记录一致

---

## 十一、关键文件速查

| 文件                                                       | 作用                                                            |
| ---------------------------------------------------------- | --------------------------------------------------------------- |
| `apps/service-api/.env`                                    | 后端所有环境变量                                                |
| `apps/machine/.env`                                        | 控制 `VITE_ENABLE_MOCK_PAYMENT_CONTROLS`                        |
| `apps/machine/vite.config.ts`                              | API 代理 + MQTT WebSocket 代理                                  |
| `apps/machine/src/views/MaintenanceView.vue`               | 机器首次配置页，包含所有密钥输入                                |
| `apps/machine/src/views/BootView.vue`                      | 启动序列：认证 → MQTT → 目录加载                                |
| `apps/machine/src/native/local-config.ts`                  | `browserRuntimeSecrets` 内存存储（密钥不持久化到 localStorage） |
| `apps/machine/src/api/mock-payments.ts`                    | 模拟支付 API，每次调用独立获取新 Token                          |
| `apps/service-api/src/orders/machine-orders.controller.ts` | 机器端订单接口，含 mock-payment 端点                            |

---

## 十二、快速重置测试数据（可选）

若需要清空历史订单重新测试：

```bash
# 将指定机器库存重置为目标数量（直接操作数据库）
docker exec cat_postgresql psql -U user -d vem \
  -c "UPDATE inventories SET on_hand_qty = 10, reserved_qty = 0 WHERE machine_slot_label = 'TO1';"

# 将所有 pending_payment 订单标记为过期（可选）
docker exec cat_postgresql psql -U user -d vem \
  -c "UPDATE orders SET status = 'payment_expired' WHERE status = 'pending_payment';"
```

> 警告：以上操作直接修改数据库，仅用于本地开发环境。
