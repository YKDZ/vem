---
name: github-flow
description: >-
  VEM 标准 GitHub Flow 提交与 PR 流程指南。用于 agent 在准备修改、提交、推送、创建 PR、处理 rebase/冲突、跨模块开发、避免直接覆盖 main 或 force push main 时遵循仓库协作规范。
---

# VEM 标准 GitHub Flow

## 目标

引导 agent 在本仓库中始终按 GitHub Flow 协作：所有代码变更先进入独立分支，通过 Pull Request 合并到 `main`，避免直接提交、覆盖或强推 `main`。

## 何时使用

当用户要求或暗示以下任一操作时，必须使用本 Skill：

- 修改代码后进行 `commit`、`push`、创建 PR 或准备合并
- 新建分支、切换分支、同步 `main`、处理 rebase 或冲突
- 跨模块开发，例如同时改 `packages/shared`、`packages/db`、`apps/service-api`、`apps/machine`、`apps/admin-ui`
- 用户说“直接改 main”“覆盖 main”“推到主分支”等高风险操作
- 需要给用户规划标准协作流程或提交信息

## 不可违反的硬规则

1. **永远不要直接向 `main` 提交或推送。**
2. **在执行任何写入型 Git 操作前，先检查当前分支和工作区状态。**
3. **如果当前在 `main`，先从最新 `main` 创建独立分支。**
4. **不要使用 `git push --force`。** 如 rebase 后必须更新自己的功能分支，只能使用 `git push --force-with-lease`。
5. **永远不要对 `main` 执行 rebase、reset、force push 或覆盖式操作。**
6. **不要覆盖用户已有的未提交改动。** 如果发现工作区已有与本任务无关的改动，先向用户说明并等待确认。
7. **跨模块功能应放在同一个功能分支和同一个 PR 中，避免把 `main` 留在半成品状态。**

## 标准执行流程

### 1. 开始前检查状态

先确认分支、远程和工作区：

```bash
git status --short --branch
git remote -v
git fetch origin
```

判断结果：

- 如果当前是 `main`：先同步最新主分支，再创建新分支。
- 如果当前已经是功能分支：确认它适合当前任务；若不适合，建议新建分支。
- 如果有未提交改动：区分是本任务改动还是用户已有改动；不要擅自丢弃、覆盖或暂存无关文件。

### 2. 创建或确认工作分支

分支命名格式：`<类型>/<简短英文描述>`，描述使用小写英文和连字符。

常用类型：

| 类型        | 用途                        | 示例                           |
| ----------- | --------------------------- | ------------------------------ |
| `feat/`     | 新功能                      | `feat/barcode-scanner-payment` |
| `fix/`      | Bug 修复                    | `fix/mqtt-reconnect-crash`     |
| `chore/`    | 工具、依赖、CI 等非业务变更 | `chore/upgrade-pnpm`           |
| `refactor/` | 不改变行为的重构            | `refactor/checkout-store`      |
| `docs/`     | 仅文档变更                  | `docs/update-contributing`     |
| `test/`     | 测试补充或调整              | `test/payment-webhook-cases`   |

如果当前在 `main`，执行流程应为：

```bash
git switch main
git pull --ff-only origin main
git switch -c <type>/<short-description>
```

### 3. 按依赖顺序开发

Monorepo 中跨模块变更应从底层到上层推进，不涉及的层跳过：

```text
packages/db（DB schema + migration）
       ↓
packages/shared（TypeScript 类型 / Zod Schema）
       ↓
apps/service-api（后端接口实现）
       ↓
apps/machine / apps/admin-ui（前端）
```

注意事项：

- 如需改数据库表结构，先修改 `packages/db/src/drizzle/schema/`，再运行 `pnpm --filter @vem/db generate` 生成迁移。
- 不要手动编辑 `packages/db/drizzle/` 下由 drizzle-kit 生成的迁移文件。
- 接口契约先改 `packages/shared`，再改后端和前端，避免类型不一致。
- 一人负责的跨模块变更放在一个分支、一个 PR 中。
- 多人并行的大功能先建集成分支，再从集成分支拉子分支；子分支 PR 合并到集成分支，最终集成分支 PR 合并到 `main`。

### 4. 提交前本地验证

根据改动范围选择检查，能跑更完整就不要只跑最小集合。

常用检查：

```bash
pnpm exec oxfmt --check .
pnpm turbo typecheck
pnpm turbo lint
pnpm turbo test
```

只涉及单包时可用过滤器加速：

```bash
pnpm turbo typecheck --filter @vem/shared
pnpm turbo lint --filter service-api
pnpm turbo test --filter admin-ui
```

跨模块变更推送前优先执行全量检查：

```bash
pnpm exec oxfmt . && pnpm turbo typecheck && pnpm turbo lint && pnpm turbo test
```

若检查失败：

1. 阅读错误日志并定位根因。
2. 修复后重新运行相关检查。
3. 不要在已知失败的情况下宣称流程完成。

### 5. 暂存与提交

提交前再次检查：

```bash
git status --short
git diff
git diff --staged
```

只暂存本任务相关文件，避免把用户的无关改动带入提交：

```bash
git add <files-for-this-task>
git commit -m "<type>(<scope>): <简短中文描述>"
```

提交信息尽量遵循 Conventional Commits：

| 类型       | 含义             |
| ---------- | ---------------- |
| `feat`     | 新功能           |
| `fix`      | Bug 修复         |
| `chore`    | 构建、依赖、工具 |
| `refactor` | 重构             |
| `test`     | 测试相关         |
| `docs`     | 文档             |
| `style`    | 仅格式变更       |

范围建议写受影响包名或模块名：`shared`、`db`、`service-api`、`machine`、`admin-ui`。

示例：

```bash
git commit -m "docs: 新增 GitHub Flow agent skill"
git commit -m "feat(shared): 新增扫码支付接口类型"
git commit -m "fix(machine): 修复扫码结账状态流转"
```

### 6. 推送分支

首次推送当前功能分支：

```bash
git push -u origin <branch-name>
```

如果 rebase 后需要更新远程功能分支：

```bash
git push --force-with-lease origin <branch-name>
```

禁止对 `main` 使用上述强制更新方式。

### 7. 创建 Draft PR（推送后立刻执行）

**分支推送后立即创建 Draft PR，不要等到功能完成再开。** 这是让 CI 尽早发现问题的关键步骤，也让协作者持续了解进度、避免方向冲突。目标分支通常是 `main`。

**PR 标题和正文必须使用中文。** 标题格式与 commit 一致：类型前缀保留英文，描述部分用中文：

```text
feat(admin-ui): 新增独立退款管理页面
fix(service-api): 修复 MQTT 重连后订单状态丢失
chore: 升级 pnpm 到 10.34
```

PR 描述模板（所有内容用中文填写）：

```markdown
## 做了什么

简短说明本次变更的目的。

## 关联 Issue

closes #<Issue 编号>（如有）

## 改动范围

- [ ] packages/shared
- [ ] packages/db
- [ ] apps/service-api
- [ ] apps/machine
- [ ] apps/admin-ui
- [ ] docs / 仓库配置

## 测试验证

列出本地执行过的检查命令和结果。

## 截图（如有 UI 变动）
```

如果功能尚未完成，PR 保持 Draft；本地验证通过并准备评审后再转为 Ready for review，并在群里 @ 一下 @YKDZ 提醒审核。

## 同步 main 与处理冲突

功能分支需要同步最新 `main` 时，优先使用 rebase 保持历史线性：

```bash
git fetch origin
git rebase origin/main
```

遇到冲突时：

1. 用 `git status` 查看冲突文件。
2. 手动解决冲突，删除 `<<<<<<<` / `=======` / `>>>>>>>` 标记。
3. 用 `git add <resolved-files>` 标记已解决。
4. 执行 `git rebase --continue`。
5. 如需放弃本次 rebase，执行 `git rebase --abort`。

rebase 完成后，只能对自己的功能分支使用：

```bash
git push --force-with-lease origin <branch-name>
```

## PR 合并后的分支清理

PR 被 Squash and merge 合并到 `main` 后，功能分支已完成使命，立即清理：

```bash
# 1. 切回 main 并同步最新代码
git switch main
git pull --ff-only origin main

# 2. 删除本地分支
git branch -d <branch-name>

# 3. 如果 GitHub 未自动删除远程分支，手动删除
git push origin --delete <branch-name>
```

> GitHub 合并后通常会显示「Delete branch」按钮，点击即可删除远程分支；若仓库已启用自动删除，则远程分支无需手动操作。本地分支必须手动删除。

## Agent 完成任务前的汇报清单

结束前向用户简要说明：

- 当前分支名，确认不是直接在 `main` 上完成流程
- 已修改的关键文件
- 已执行的验证命令及结果
- 若已提交：提交 hash 和提交信息
- 若已推送或创建 PR：分支名和 PR 链接
- 若未执行某项检查：明确说明原因和风险

## 高风险请求的处理方式

如果用户要求“直接推 main”“覆盖 main”“强推 main”“跳过 PR 合并”等操作，应礼貌拒绝直接执行，并建议符合仓库规范的替代流程：

1. 从最新 `main` 创建合规功能分支。
2. 在功能分支完成变更和本地检查。
3. 推送分支并创建 Draft PR。
4. CI 通过后由仓库负责人 Review 并通过 Squash and merge 合并。

除非仓库维护者明确变更协作规范，否则本 Skill 的硬规则优先。
