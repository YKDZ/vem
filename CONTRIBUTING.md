# 协作开发规范

本仓库使用 GitHub Flow。所有代码和文档变更都通过 Pull Request 合并进 `main`，不要直接向 `main` push。

## 基本流程

1. 从最新 `main` 创建分支。
2. 小步提交，提交信息尽量使用 Conventional Commits。
3. 推送分支后尽早创建 Draft PR。
4. 本地验证通过后把 PR 标记为 Ready for review。
5. CI 全部通过并完成 review 后使用 Squash and merge 合并。
6. 合并后删除本地和远程功能分支。

```bash
git switch main
git pull --ff-only origin main
git switch -c feat/short-description
```

分支命名：

| 类型        | 用途               | 示例                           |
| ----------- | ------------------ | ------------------------------ |
| `feat/`     | 新功能             | `feat/payment-retry`           |
| `fix/`      | Bug 修复           | `fix/mqtt-reconnect`           |
| `test/`     | 测试和测试基础设施 | `test/machine-touchscreen-e2e` |
| `docs/`     | 文档               | `docs/update-contributing`     |
| `chore/`    | 工具、依赖、CI     | `chore/update-actions`         |
| `refactor/` | 不改变行为的重构   | `refactor/runtime-scenarios`   |

提交信息示例：

```bash
git commit -m "feat(machine): 增加扫码支付恢复状态"
git commit -m "test(machine): 覆盖触屏购买旅程"
git commit -m "docs: 更新本地开发说明"
```

## 工作区和依赖

推荐使用 Dev Container。手动环境至少需要：

- Node.js 24+
- pnpm 11.9.0
- Rust stable
- Docker

安装依赖：

```bash
pnpm install
```

常用包过滤：

```bash
pnpm --filter service-api dev
pnpm --filter admin-ui dev
pnpm --filter machine dev
pnpm --filter @vem/shared build
pnpm --filter @vem/db migrate
```

## 模块开发顺序

跨模块变更按依赖方向推进：

```text
packages/db
  -> packages/shared
  -> apps/service-api
  -> apps/vending-daemon / apps/machine / apps/admin-ui / apps/vision-mock
```

原则：

- 改数据库 schema 时，先改 `packages/db` 并生成 migration。
- 改 API 契约时，先改 `packages/shared`，再改后端和前端。
- 跨模块功能放在同一个分支和 PR，避免 `main` 出现半成品。
- 不要手动编辑由工具生成且有明确生成命令的文件，除非文档明确要求。

## 本地验证

全量静态检查：

```bash
pnpm fmt:check
pnpm turbo typecheck
pnpm turbo lint
```

全量测试：

```bash
pnpm turbo test
```

按包验证：

```bash
pnpm -F machine lint
pnpm -F machine typecheck
pnpm -F machine test
pnpm -F service-api test
cargo test -p vending-daemon --all-targets
```

格式化：

```bash
pnpm fmt
cargo fmt --all
```

只检查格式：

```bash
pnpm fmt:check
cargo fmt --all -- --check
```

## Machine 安装态验收

Machine 的购买、支付、出货、恢复、视觉、音频和维护链路统一在可重置的 Windows VM 中验收。浏览器内的 Machine Playwright 路径已经移除；不要为测试新增绕过 daemon、真实路由控制或设备适配边界的业务路径。

从测试床主机运行当前提交的全部业务集合：

```bash
node scripts/testbed/runtime-testbed-trigger.mjs run \
  --mode full \
  --commit "$(git rev-parse HEAD)" \
  --config /path/to/host-config.json \
  --out /path/to/result.json
```

日常反馈可在已重建的平台上选择一个或多个业务集合执行 warm fast；可用集合以 `scripts/testbed/business-check-registry.mjs` 为准：

```bash
node scripts/testbed/runtime-testbed-trigger.mjs run \
  --mode fast \
  --focus sale \
  --focus paymentRecovery \
  --commit "$(git rev-parse HEAD)" \
  --config /path/to/host-config.json \
  --out /path/to/result.json
```

VM 固定使用 `1080x1920`。截图是可单独运行的辅助检查，复用安装态 Machine 的 CDP 会话；交易中页面应由对应业务集合自然到达，不能通过调试 fixture 伪造：

```bash
node scripts/testbed/machine-ui-screenshot-scenarios.mjs \
  --scenario catalog \
  --scenario maintenance-status \
  --remote VEMKiosk@windows-host \
  --identity /path/to/windows-key \
  --out /path/to/screenshots
```

## PR 要求

PR 标题使用中文描述，类型前缀保留英文：

```text
feat(machine): 新增扫码支付恢复状态
test(machine): 完善触屏 E2E 与截图巡检
docs: 更新贡献指南
```

PR 正文建议包含：

```markdown
## 做了什么

## 关联 Issue

## 改动范围

- [ ] packages/shared
- [ ] packages/db
- [ ] apps/service-api
- [ ] apps/vending-daemon
- [ ] apps/machine
- [ ] apps/admin-ui
- [ ] docs / CI

## 测试验证

## 截图或 artifact
```

如果改了 UI，请附安装态 VM 截图或说明对应的截图场景与业务集合。

## CI

PR 会运行主要检查：

| Job                     | 内容                                                        |
| ----------------------- | ----------------------------------------------------------- |
| Static Checks           | `pnpm fmt:check`、`pnpm turbo typecheck`、`pnpm turbo lint` |
| Unit Tests              | workspace 单元测试                                          |
| Machine UI Daemon E2E   | daemon runtime E2E 与 machine 触屏 smoke                    |
| E2E Tests               | service-api / admin-ui 端到端测试                           |
| Rust Tests              | Rust fmt/check/test                                         |
| Windows Service Compile | Windows target 编译检查                                     |

若 CI 失败：

1. 先读失败 job 的日志，定位具体命令和失败测试。
2. 本地复现最小失败命令。
3. 修复后运行相关验证。
4. 推送新提交，让 CI 自动重跑。

如果失败是明确的既有不稳定测试，也要在 PR 中说明日志和本地复现情况；不要把未知失败当作通过。

## 合并后清理

```bash
git switch main
git pull --ff-only origin main
git branch -d feat/short-description
git push origin --delete feat/short-description
```

## 常用命令

```bash
git status --short --branch
git diff
git diff --staged
git log --oneline --graph --decorate --max-count=20
```

```bash
pnpm turbo build
pnpm turbo typecheck
pnpm turbo lint
pnpm turbo test
pnpm turbo test:e2e
```
