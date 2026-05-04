# VEM Service API

NestJS 后端服务，提供自动售货机管理系统的核心业务逻辑。

## 技术栈

- **框架**: NestJS 11 + TypeScript
- **数据库**: PostgreSQL 16（Drizzle ORM）
- **消息队列**: Eclipse Mosquitto 2（MQTT）
- **测试**: Vitest（单元 + e2e）

## 快速启动

### 1. 依赖安装

```bash
pnpm install
```

### 2. 环境变量配置

```bash
cp .env.example .env
# 根据实际环境修改 .env 中的配置
```

### 3. 启动基础设施

```bash
# 从项目根目录运行
pnpm compose:up
```

等待 PostgreSQL 和 MQTT 健康检查通过。

### 4. 数据库迁移

```bash
pnpm db:migrate
```

### 5. 启动开发服务器

```bash
pnpm dev:service
# 服务运行于 http://localhost:3000
```

## 测试

```bash
# 单元测试
pnpm -F service-api test

# e2e 测试（需要先启动基础设施和运行迁移）
pnpm -F service-api test:e2e

# TypeScript 类型检查
pnpm -F service-api typecheck

# 构建
pnpm -F service-api build
```

## 环境变量说明

参见 `.env.example` 文件获取完整的环境变量列表及说明。

## 项目结构

```
src/
├── access/          # 访问控制（JWT 守卫、权限装饰器）
├── admin-users/     # 后台用户管理
├── audit/           # 审计日志
├── auth/            # 认证（登录、刷新 token）
├── bootstrap/       # 应用启动初始化（种子管理员账户）
├── common/          # 公共工具（响应拦截、异常过滤）
├── config/          # 环境配置服务
├── dashboard/       # 仪表盘统计
├── database/        # Drizzle DB 模块
├── flows/           # e2e 测试（业务流程）
├── health/          # 健康检查端点
├── inventory/       # 库存管理
├── machines/        # 机器管理
├── mqtt/            # MQTT 连接服务
├── notifications/   # 通知中心
├── orders/          # 订单管理
├── payments/        # 支付管理（含 Mock 支付）
├── products/        # 商品管理
├── roles/           # 角色权限管理
└── vending/         # 出货调度（MQTT 命令下发、结果处理）
```
