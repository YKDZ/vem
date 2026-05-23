# 协作开发规范（GitHub Flow）

本项目采用 **GitHub Flow** 进行协作开发，所有变更通过 Pull Request 合并进 `main` 分支。本文档面向团队所有成员，包含从环境搭建到 PR 合并的完整流程与具体命令。

---

## 目录

1. [前置准备](#1-前置准备)
2. [核心原则](#2-核心原则)
3. [分支命名规范](#3-分支命名规范)
4. [提交信息规范](#4-提交信息规范)
5. [单模块开发流程](#5-单模块开发流程)
6. [跨模块开发流程](#6-跨模块开发流程)
7. [模块重构与 turbo.json 维护](#7-模块重构与-turbojson-维护)
8. [本地检查（推送前必做）](#8-本地检查推送前必做)
9. [PR 流程](#9-pr-流程)
10. [合并后清理](#10-合并后清理)
11. [处理冲突](#11-处理冲突)
12. [常用命令速查](#12-常用命令速查)

---

## 1. 前置准备

### 使用 Dev Container（推荐）

仓库根目录已包含 `.devcontainer` 配置，内置 Node.js、Rust、pnpm、Docker 等全部依赖，**无需手动安装任何环境**。

1. 安装 [VS Code](https://code.visualstudio.com/) 及 [Dev Containers 扩展](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers)
2. 打开仓库后，VS Code 会弹出提示 "Reopen in Container"，点击即可
3. 等待镜像构建完成，环境即刻就绪

> 镜像构建过程需要访问外网下载镜像，若没有梯子配置经验那么只能使用下方说的方式手动配置开发环境。

### 手动配置（不使用 Dev Container）

若不使用 Dev Container，需自行安装：

- **Node.js** 24+
- **pnpm** 10+（`npm install -g pnpm`）
- **Rust** stable（用于 `apps/machine` 的 Tauri 原生层）
- **Git** 2.x+

### 首次克隆

```bash
git clone https://github.com/YKDZ/vem.git
cd vem
pnpm install
```

### 配置 Git 用户信息

```bash
git config user.name "你的 GitHub 名称"
git config user.email "你的 GitHub 邮箱"
```

---

## 2. 核心原则

GitHub Flow 只有一条核心规则：**`main` 分支永远保持可部署状态**。

```
main ──────●──────────────●──────────────●──── ...
           │              ↑              ↑
           └─ feat/xxx ───┘  fix/yyy ───┘
```

- 所有功能开发、Bug 修复、重构都在独立分支上进行
- **不直接向 `main` 提交**（仓库已启用 Branch Ruleset，直接 push 会被拒绝）
- 分支完成后发起 PR，CI 全部通过且 @YKDZ Approve 后才能合并
- 合并后立即删除分支，下次开发不再使用

---

## 3. 分支命名规范

格式：`<类型>/<简短描述>`，描述用小写英文单词，以连字符 `-` 分隔。

| 类型        | 用途                        | 示例                           |
| ----------- | --------------------------- | ------------------------------ |
| `feat/`     | 新功能                      | `feat/barcode-scanner-payment` |
| `fix/`      | Bug 修复                    | `fix/mqtt-reconnect-crash`     |
| `chore/`    | 工具、依赖、CI 等非业务变更 | `chore/upgrade-pnpm`           |
| `refactor/` | 重构（不改变行为）          | `refactor/checkout-store`      |
| `docs/`     | 仅文档变更                  | `docs/update-contributing`     |

跨模块大功能可以适当描述主题而不加模块前缀，例如 `feat/vision-profile-ipc`。

---

## 4. 提交信息规范

遵循 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/) 格式：

```
<类型>(<范围>): <简短描述>

[可选：详细说明]
```

| 类型       | 含义                     |
| ---------- | ------------------------ |
| `feat`     | 新功能                   |
| `fix`      | Bug 修复                 |
| `chore`    | 构建/依赖/工具           |
| `refactor` | 重构                     |
| `test`     | 测试相关                 |
| `docs`     | 文档                     |
| `style`    | 仅格式变更（不影响逻辑） |

**范围（可选）** 写受影响的包名或模块名：`shared`、`service-api`、`machine`、`admin-ui`、`db`。

```bash
# 示例
git commit -m "feat(shared): add scan_pay to paymentMethodSchema"
git commit -m "feat(service-api): add POST /machine-orders/scan endpoint"
git commit -m "fix(machine): handle barcode_scanned event when checkout locked"
git commit -m "chore: upgrade pnpm to 10.34"
```

一个 commit 尽量只做一件事。跨模块开发时不要把所有改动堆在同一个 commit 里。不过不做强制要求，尽力即可。

---

## 5. 单模块开发流程

适用于改动只涉及单个 app 或 package 的情况，例如只修改 `apps/admin-ui`。

### 第一步：从最新 main 签出新分支

```bash
# 确保本地 main 是最新的
git checkout main
git pull origin main

# 创建并切换到新分支
git checkout -b feat/refund-standalone-page
```

### 第二步：开发与提交

```bash
# 开发...

# 查看改动
git diff
git status

# 暂存并提交（可多次提交）
git add apps/admin-ui/src/views/refunds/
git commit -m "feat(admin-ui): add standalone refund management page"
```

> **提示**：小步提交，每个 commit 对应一个有意义的变更点，便于 CR 和回溯。

### 第三步：推送到远程

```bash
git push origin feat/refund-standalone-page
```

首次推送后，命令行会输出创建 PR 的链接，直接点击即可。

### 第四步：在 GitHub 创建 PR

见 [PR 流程](#8-pr-流程)。

---

## 6. 跨模块开发流程

适用于改动横跨多个包的情况，例如"扫码枪支付"功能需要同时修改 `packages/shared`、`apps/service-api`、`apps/machine`。

### 情形 A：一个人负责所有模块

**关键原则：同一功能的所有模块变更放在同一个分支和同一个 PR 中。** 不要拆成多个 PR 再合并，因为这会导致 `main` 中出现残缺的半成品状态。

### 情形 B：多人分工，各负责不同模块

使用**集成分支模式**，不要多人直接在同一分支上互相推送（冲突频繁、难追责）：

```
main
 └─ feat/vision-recommend          ← 集成分支，完成后 PR → main
      ├─ feat/vision-recommend-api    ← 协作者 A 负责 service-api
      └─ feat/vision-recommend-ui     ← 协作者 B 负责 machine UI
```

**① 由发起人从 main 创建集成分支并推送**

```bash
git switch -c feat/vision-recommend main
git push -u origin feat/vision-recommend
```

**② 各协作者从集成分支拉出自己的子分支**

```bash
git fetch origin
git switch -c feat/vision-recommend-api origin/feat/vision-recommend
```

**③ 各自完成后，发 PR 目标选集成分支（不是 main）**

Ruleset 只保护 `main`，集成分支之间的 PR 不受限，可以自己合并，无需 @YKDZ 审核。

**④ 所有子模块合并进集成分支后，联调验证通过，发最终 PR → main 由 @YKDZ 审核**

**⑤ 在开发期间，定期把 main 的最新变更同步到集成分支**

```bash
# 在集成分支上执行
git fetch origin
git rebase origin/main
git push --force-with-lease origin feat/vision-recommend
```

> 子分支也需要定期 rebase 到集成分支，方式相同。

---

```bash
git checkout main
git pull origin main
git checkout -b feat/barcode-scanner-payment
```

### 按依赖顺序开发（情形 A/B 均适用）

Monorepo 中包之间存在依赖关系（`packages/shared` → `apps/*`），开发顺序应从底层向上：

```
packages/shared（类型/Schema 定义）
       ↓
apps/service-api（后端接口）
       ↓
apps/machine（前端 + 原生层）
```

**① 先改 `packages/shared`（类型契约层）**

```bash
# 修改 packages/shared/src/enums/payment-status.ts
# 添加 scan_pay 枚举值

git add packages/shared/
git commit -m "feat(shared): add scan_pay to paymentMethodSchema"
```

**② 再改 `apps/service-api`**

```bash
# 实现 POST /machine-orders/scan 接口

git add apps/service-api/
git commit -m "feat(service-api): add barcode scan order creation endpoint"
```

**③ 最后改 `apps/machine`**

```bash
# Rust 层：HID 读取 + Tauri 事件
# Vue 层：监听事件，调接口

git add apps/machine/
git commit -m "feat(machine): integrate barcode scanner HID read and checkout flow"
```

### 本地全量验证（推送前必做）

跨模块变更需要验证所有受影响包都能正确构建：

```bash
# 构建所有受影响的包（turbo 自动处理依赖顺序）
pnpm turbo build --filter @vem/shared --filter service-api

# 全量类型检查（会检测到跨包类型不匹配）
pnpm turbo typecheck

# 全量 lint
pnpm turbo lint

# 全量单元测试
pnpm turbo test
```

### 推送与 PR（情形 A）

```bash
git push origin feat/barcode-scanner-payment
```

在 PR 描述中需要说明各个包的改动目的（见 [PR 流程](#9-pr-流程)）。

---

## 7. 模块重构与 turbo.json 维护

若某个模块需要整体重构（例如将机器 UI 从 Vue 切换到 React，或视觉识别模块从 Python 迁移到其他语言），**必须同时维护该包与 `turbo.json` 的兼容性**，确保 monorepo 的统一构建与 CI 仍然可用。

### 约束：每个包必须暴露的标准脚本

`turbo.json` 引用以下任务名，各包的 `package.json` 中 `scripts` 必须包含对应条目：

| 任务名      | 说明                         | 示例实现                                          |
| ----------- | ---------------------------- | ------------------------------------------------- |
| `build`     | 构建产物，**输出到 `dist/`** | `vite build` / `nest build` / `go build -o dist/` |
| `typecheck` | 静态类型检查，不产生输出文件 | `tsc --noEmit` / `pyright`                        |
| `lint`      | 代码风格检查                 | `oxlint` / `eslint` / `ruff check`                |
| `test`      | 运行单元测试                 | `vitest run` / `pytest` / `cargo test`            |
| `fmt`       | 格式化（可选）               | `oxfmt` / `ruff format`                           |

`build` 的输出目录必须是 `dist/`（`turbo.json` 中 `"outputs": ["dist/**"]`），否则 turbo 缓存会失效。

### 操作步骤

**① 内部重构（包名和目录不变）**

只需确保 `package.json` 中 `scripts` 的**键名不变**，内部命令换成新技术栈的等价命令。无需改动 `turbo.json`。

```jsonc
// apps/machine/package.json（示例：UI 框架从 Vue 换为 React）
{
  "name": "machine", // 保持不变
  "scripts": {
    "build": "vite build", // 内部命令可以换，键名不能换
    "typecheck": "tsc --noEmit",
    "lint": "eslint src",
    "test": "vitest run",
  },
}
```

**② 整体重写（旧代码彻底丢弃，可能新建目录）**

1. 在新目录（如 `apps/machine-new/`）完成开发
2. 新目录的 `package.json` 中添加全部标准脚本
3. `pnpm-workspace.yaml` 当前配置 `apps/*` 已自动覆盖新目录，无需额外修改
4. 在**同一个 PR** 中删除旧目录、提交新目录，并在 PR 描述中说明重构理由

**③ 新模块语言不支持某项检查**（例如纯 Python 无 tsc）

用该语言的等价工具替换，或用 `echo` 占位确保任务不报错：

```jsonc
// apps/vision/package.json（Python 视觉识别模块示例）
{
  "name": "vision",
  "scripts": {
    "build": "python -m build --outdir dist",
    "typecheck": "pyright src",
    "lint": "ruff check src",
    "test": "pytest",
    "fmt": "ruff format src",
  },
}
```

若某个模块完全不参与 turbo 构建（例如视觉识别是独立进程，不被任何其他包 `import`），可以不将其加入 pnpm workspace，但**必须在 PR 中说明理由并经 @YKDZ 确认**。

---

## 8. 本地检查（推送前必做）

CI 会执行以下检查，推送前本地先跑一遍可以省去等待时间。

### 格式检查

```bash
# 检查（不修改）
pnpm exec oxfmt --check .

# 自动修复格式问题
pnpm exec oxfmt .
```

### 类型检查

```bash
# 全量
pnpm turbo typecheck

# 只检查单个包（更快）
pnpm turbo typecheck --filter @vem/shared
pnpm turbo typecheck --filter service-api
pnpm turbo typecheck --filter admin-ui
```

### Lint

```bash
# 全量
pnpm turbo lint

# 只检查单个包
pnpm turbo lint --filter @vem/shared
pnpm turbo lint --filter machine
```

### 单元测试

```bash
# 全量
pnpm turbo test

# 只跑单个包
pnpm turbo test --filter @vem/shared
pnpm turbo test --filter service-api
```

### 一键全检（推荐在推送前执行）

```bash
pnpm exec oxfmt . && pnpm turbo typecheck && pnpm turbo lint && pnpm turbo test
```

---

## 9. PR 流程

### 创建 PR

推送分支后在 GitHub 上创建 PR，目标分支选 `main`。

**PR 标题格式** 与 commit 一致：

```
feat(admin-ui): add standalone refund management page
```

**PR 描述模板**（复制填写）：

```markdown
## 做了什么

简短说明本次变更的目的。

## 改动范围

- [ ] packages/shared
- [ ] apps/service-api
- [ ] apps/machine
- [ ] apps/admin-ui
- [ ] packages/db

## 测试验证

本地如何验证这个改动是正确的。

## 截图（如有 UI 变动）
```

### CI 检查

PR 创建后，GitHub Actions 会自动运行以下三个 job：

| Job               | 内容                                                                  |
| ----------------- | --------------------------------------------------------------------- |
| **Static Checks** | 格式（oxfmt）、类型检查（turbo typecheck）、Lint（turbo lint）        |
| **Unit Tests**    | 构建 shared + db，然后运行 `turbo test`                               |
| **E2E Tests**     | 启动完整服务（PostgreSQL + MQTT + service-api），运行 Playwright 测试 |

**所有 job 通过后才能合并。** 如果某个 job 失败，点击 "Details" 查看日志，修复后重新推送即可触发重新检查。

### Code Review

**所有 PR 由 @YKDZ（仓库主）负责最终 Review 和合并**，团队其他成员也可以留评论，但合并操作由 @YKDZ 执行。提交 PR 后请在群里 @ 一下以便及时通知。

Review 重点：

- 逻辑正确性
- 跨模块接口是否一致（尤其是 `packages/shared` 的 Schema 变更）
- 错误处理是否完整
- 模块重构时 `turbo.json` 兼容性是否维护（见[第 7 节](#7-模块重构与-turbojson-维护)）
- 不要 Review 格式（CI 已覆盖）

### 合并方式

使用 **Squash and merge**（在 GitHub 上合并时选择此选项），将分支上的多个 commit 压成一个干净的 commit 合并进 `main`，保持 `main` 历史线性清晰。

---

## 10. 合并后清理

PR 合并后：

```bash
# 切回 main 并拉取最新
git checkout main
git pull origin main

# 删除本地分支
git branch -d feat/refund-standalone-page

# 如果 GitHub 没有自动删除远程分支，手动删除
git push origin --delete feat/refund-standalone-page
```

---

## 11. 处理冲突

当你的分支与 `main` 存在冲突时，使用 **rebase** 而非 merge 来更新分支，保持提交历史清洁。

```bash
# 获取最新 main
git fetch origin

# 在当前功能分支上 rebase
git rebase origin/main
```

如果 rebase 中途遇到冲突：

```bash
# 查看冲突文件
git status

# 手动编辑解决冲突（找到 <<<<<<< 标记）
# 解决后标记为已解决
git add <冲突文件>

# 继续 rebase
git rebase --continue

# 如果想放弃本次 rebase（回到原状态）
git rebase --abort
```

rebase 完成后强制推送更新远程分支（rebase 会改写提交历史，必须用 `--force-with-lease`）：

```bash
# --force-with-lease 比 --force 更安全：
# 只有当远程分支没有被别人推送过时才允许强推
git push --force-with-lease origin feat/your-feature-name
```

> **注意**：只对自己的功能分支做 rebase 和强制推送，**永远不要对 `main` 分支执行这些操作**。

---

## 12. 常用命令速查

### Git 基本操作

```bash
# 查看当前状态
git status

# 查看未暂存的改动
git diff

# 查看已暂存的改动
git diff --staged

# 查看提交历史（精简版）
git log --oneline --graph

# 撤销最后一次 commit（保留改动在工作区）
git reset --soft HEAD~1

# 丢弃工作区的改动（危险，不可恢复）
git checkout -- <文件>
```

### 分支操作

```bash
# 查看所有本地分支
git branch

# 查看所有分支（含远程）
git branch -a

# 从 main 创建并切换新分支
git checkout main && git pull origin main && git checkout -b feat/xxx

# 切换分支
git checkout feat/xxx

# 删除本地分支（已合并）
git branch -d feat/xxx

# 强制删除本地分支（未合并）
git branch -D feat/xxx
```

### pnpm / Turbo

```bash
# 安装所有依赖
pnpm install

# 只在特定包运行命令（--filter 支持包名或路径）
pnpm --filter service-api dev
pnpm --filter @vem/shared build
pnpm --filter admin-ui test

# Turbo 任务（自动处理包间依赖顺序）
pnpm turbo build                        # 构建所有包
pnpm turbo build --filter service-api   # 构建 service-api 及其依赖
pnpm turbo typecheck                    # 全量类型检查
pnpm turbo lint                         # 全量 lint
pnpm turbo test                         # 全量单元测试

# 新增依赖到特定包
pnpm --filter service-api add <package>
pnpm --filter admin-ui add -D <package>   # 开发依赖

# 新增依赖到根 workspace（共享工具）
pnpm add -D <package> -w
```

### 格式化

```bash
# 检查格式（不修改文件）
pnpm exec oxfmt --check .

# 自动修复格式
pnpm exec oxfmt .
```
