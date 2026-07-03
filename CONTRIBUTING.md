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

## Machine 触屏 E2E

机器端 UI 是核心交付物。涉及 `apps/machine` 的购买链路、结果页、离线页、维护页、UI Debug 场景或视觉布局时，优先补充或更新触屏 E2E。

触屏 smoke：

```bash
pnpm -F machine test:e2e:touch-smoke
```

daemon / runtime E2E：

```bash
pnpm -F machine exec playwright test --project=machine-runtime-touchscreen tests/machine-daemon-client.spec.ts tests/machine-real-daemon.spec.ts
```

注意：

- 测试视口固定为 `1080x1920`。
- Playwright 项目会启动 machine dev server，避免同时跑多个需要端口 `1420` 的项目。
- 触屏交互应使用测试支持函数，避免只用鼠标点击覆盖触摸链路。

## Machine 截图巡检系统

截图系统用于人工快速检查 Machine Runtime Console 的主要 UI 状态是否崩坏、错位或风格不一致。它不替代断言型 E2E；它生成可下载 artifact 和拼接总览，方便 review。

本地生成全部截图：

```bash
pnpm -F machine test:e2e:screenshots
pnpm -F machine screenshots:runtime:stitch
```

产物位置：

```text
apps/machine/runtime-screenshot-artifacts/
├── manifest.json
├── screenshots/
└── overview/
```

其中：

- `screenshots/` 保存每个场景的 `1080x1920` 原图。
- `overview/runtime-screenshot-overview-*.png` 保存高分辨率拼接总览。
- `manifest.json` 记录场景 id、名称、分类、目标路由和截图路径。

只生成部分场景：

```bash
VEM_MACHINE_RUNTIME_SCREENSHOT_SCENARIOS=payment-qr,dispensing,maintenance pnpm -F machine test:e2e:screenshots
pnpm -F machine screenshots:runtime:stitch
```

新增截图场景：

1. 在 `apps/machine/src/dev/runtime-scenarios.ts` 增加或更新场景。
2. 确保场景能通过 UI Debug fixture 直接加载到目标页面。
3. 将场景标记为 `screenshot: "included"`。
4. 在 `apps/machine/tests/machine-runtime-screenshots.spec.ts` 添加必要的核心元素断言。
5. 运行截图命令并检查 `overview/` 总览。

CI 中的截图 artifact：

- PR 默认不上传截图 artifact，避免每个 PR 生成大文件。
- `workflow_dispatch` 和 `main` push 会运行 `Machine Runtime Screenshot Artifacts` job。
- 手动运行 CI 时可以填写 `machine_runtime_screenshot_scenarios`，用逗号分隔场景 id。
- job 完成后下载 artifact：`machine-runtime-screenshot-artifacts`。

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

如果改了 UI，请附截图、截图 artifact 或说明如何生成。Machine Runtime Console 的 UI 改动优先附 `runtime-screenshot-artifacts/overview` 总览。

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

```bash
pnpm -F machine test:e2e:touch-smoke
pnpm -F machine test:e2e:screenshots
pnpm -F machine screenshots:runtime:stitch
```
