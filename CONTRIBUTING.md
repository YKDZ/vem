# 开发协作说明

本项目由小团队集中维护。提交可以直接进入 `main`，也可以通过 PR 合并；无论采用哪种方式，都应保持提交可读、变更聚焦、验证结果明确。

## 提交规范

提交信息使用 Conventional Commit，摘要使用中文：

```text
feat(machine): 增加扫码支付恢复提示
fix(daemon): 修复库存可售状态同步
test(testbed): 覆盖出货失败恢复链路
docs: 更新后端部署说明
```

常用类型：

| 类型       | 用途             |
| ---------- | ---------------- |
| `feat`     | 新功能           |
| `fix`      | 缺陷修复         |
| `test`     | 测试和验收链路   |
| `refactor` | 不改变行为的重构 |
| `docs`     | 文档             |
| `build`    | 构建和镜像       |
| `ci`       | CI 配置          |
| `chore`    | 维护性变更       |

## 变更边界

- 修改数据库结构时，同步更新 `packages/db` 的 schema 和 migration。
- 修改 API 契约时，先更新共享契约，再更新后端和前端调用。
- 修改 daemon IPC 时，同步更新 schema、生成代码和迁移守卫。
- 修改机器端核心链路时，优先补充或更新 VM 运行时验收。
- 修改后台管理端时，优先补充或更新 Playwright 验收。
- 不保留已经废弃的兼容入口和死代码。

## 验证命令

静态检查：

```bash
pnpm ci:static
```

单元测试：

```bash
pnpm ci:unit
```

Rust 检查：

```bash
pnpm ci:rust
```

后台浏览器验收：

```bash
pnpm ci:admin-browser
```

后端 Compose 冒烟：

```bash
pnpm compose-smoke:backend \
  --service-api-image ghcr.io/ykdz/vem-service-api@sha256:<64-hex> \
  --admin-ui-image ghcr.io/ykdz/vem-admin-ui@sha256:<64-hex>
```

机器端 VM full 验收：

```bash
node scripts/testbed/runtime-testbed-trigger.mjs run \
  --mode full \
  --commit "$(git rev-parse HEAD)" \
  --config /abs/path/to/runtime-testbed-host.json \
  --out /abs/path/to/runtime-testbed-result.json
```

VM fast 验收可指定一个或多个业务集合：

```bash
node scripts/testbed/runtime-testbed-trigger.mjs run \
  --mode fast \
  --focus sale \
  --focus paymentRecovery \
  --commit "$(git rev-parse HEAD)" \
  --config /abs/path/to/runtime-testbed-host.json \
  --out /abs/path/to/runtime-testbed-result.json
```

业务集合以 `scripts/testbed/business-check-registry.mjs` 为准。

## CI

GitHub CI 负责静态检查、单元测试、Service API E2E、后台浏览器验收、后端部署契约、Rust 检查和 Windows 专项检查。机器端完整业务验收优先在 2.22 这类测试宿主机上运行，避免 GitHub Actions 调度和网络波动影响反馈。

CI 失败时，先定位失败命令和最小复现路径，再提交修复。测试平台问题和业务问题应分开判断；业务缺陷优先修业务代码。

## 文档

持久文档放在 `public/`。临时 PRD、issue、handoff、调查记录和 agent 上下文保留在本地 `.scratch/`、`.agents/` 或其他未跟踪目录中。

面向交付和操作人员的文档使用简体中文，避免内部笔记语气和过多技术细节。
