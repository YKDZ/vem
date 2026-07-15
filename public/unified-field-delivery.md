# 统一的现场恢复交付单元

这一条路径把 VM 验收、非 ISO 真机现场测试、以及 Factory ISO 绑定到同一组 exact bytes，而不是分别维护开发/生产安装法。

- Runtime exact artifacts 只认 `WINDOWS-RUNTIME-ARTIFACTS.json` 描述的 `vending-daemon.exe`、`machine.exe`、`WebView2Loader.dll`。
- Vision 只认一个操作员钉住的 immutable Candidate digest；非 ISO 预批准与后续 Factory/ISO 必须引用同一个 digest。当前试验约束要求该 Candidate 自带固定 Python 3.11.9 与 pinned dependencies。
- Power-on 前的全部材料放在仓库外临时目录；现场传输通道只负责传输、调用、取证，不得直接替换 exe。
- 非 ISO 仍然通过 `apply-managed-update.ps1` 执行 daemon/UI 更新、校验、服务/任务生命周期和 rollback。

## 首次 L3 Vision 预批准阶段

首次真实 Vision 现场测试还没有 conformance，因此也不可能已经具备合法的 Factory delivery。先只输入 exact runtime artifacts、自包含 Vision preapproval delivery 和操作员钉住的 digest：

```bash
node scripts/windows/prepare-unified-field-delivery.mjs prepare-preapproval \
  --output /tmp/vem-field-preapproval-20260715T120000Z \
  --update-id field-20260715T120000Z \
  --runtime-directory /tmp/windows-runtime-artifacts \
  --vision-preapproval-directory /tmp/vision-preapproval/VEM-VISION-PREAPPROVAL \
  --expected-vision-bundle-digest sha256:<operator-pinned-exact-bundle-digest>
```

这个阶段不接受或要求 `--vision-factory-directory`，也不会输出 `vision-factory/`。输出只包含当前适用的 runtime、`managed-update.json`、`candidate.json`、`vision-preapproval/`、`progressive-acceptance.json`、`APPLY-FIELD-UPDATE.ps1` 和 `SHA256SUMS`。APPLY 指引在 Candidate conformance 后停止，不会提前调用 `provision-vision-factory-release.ps1`，也不声明 Factory acceptance。Vision Python 未显式指定时固定为 3.11.9。

取得 `vision-conformance.json` 后，再针对同一个 immutable Candidate digest 运行 `experimental-vision-candidate.mjs finalize`。后续 final stage 必须复用同一个 update ID、同一个 runtime 目录和同一个 preapproval 目录；因此 runtime bytes 与 `managed-update.json` 保持完全相同，只增加 conformance 所授权的 Factory delivery。不得重建 Candidate、维护另一份 managed update，或创建第二套 Vision installer。

## Factory final stage 准备入口

当 exact runtime artifact 目录、Vision preapproval delivery、Vision experimental Factory delivery 都已具备时：

```bash
node scripts/windows/prepare-unified-field-delivery.mjs prepare \
  --output /tmp/vem-field-test-candidate-20260715T120000Z \
  --update-id field-20260715T120000Z \
  --runtime-directory /tmp/windows-runtime-artifacts \
  --vision-preapproval-directory /tmp/vision-preapproval/VEM-VISION-PREAPPROVAL \
  --vision-factory-directory /tmp/vision-experimental-delivery \
  --expected-vision-bundle-digest sha256:<operator-pinned-exact-bundle-digest>
```

该目录会生成：

- `runtime/`：exact runtime bytes 与 `WINDOWS-RUNTIME-ARTIFACTS.json`
- `managed-update.json`：真机现场仍使用的托管更新清单
- `vision-preapproval/`：自包含 Candidate 预批准交付单元
- `vision-factory/`：与 Factory/ISO 同源的 Vision experimental delivery
- `candidate.json`：统一身份绑定，供后续渐进验收引用
- `APPLY-FIELD-UPDATE.ps1`：Windows 侧确定性调用顺序
- `SHA256SUMS`：整个 staging 树的本地摘要

## exact inputs 尚未齐备时

不要临时从源码现编现装。先生成 skeleton，把缺少的 exact inputs 暴露出来：

```bash
node scripts/windows/prepare-unified-field-delivery.mjs skeleton \
  --output /tmp/vem-field-test-candidate-skeleton \
  --update-id field-20260715T120000Z \
  --source-commit <40-hex-git-sha>
```

Skeleton 会保留下一步命令，要求你补齐：

- runtime descriptor + 三个 runtime bytes；
- `experimental-vision-candidate.mjs prepare-preapproval` 输出；
- `experimental-vision-candidate.mjs finalize` 输出；
- 操作员钉住的同一个 Vision digest。

## 渐进验收 identity 校验

同一个 `candidate.json` 必须贯穿：

- L2 VM runtime acceptance 的 `daemonSha256` / `machineUiSha256`
- L3 非 ISO managed-update manifest/evidence/source binding
- L4 Factory Manifest 的 `vem-daemon` / `vem-machine-ui` / `webview2-loader` / `vision-release`

用统一校验入口比对：

```bash
node scripts/windows/verify-progressive-delivery.mjs \
  --candidate /tmp/vem-field-test-candidate-20260715T120000Z/candidate.json \
  --vm-runtime-acceptance artifacts/vm-runtime-acceptance/runtime-acceptance.json \
  --managed-update-manifest /tmp/vem-field-test-candidate-20260715T120000Z/managed-update.json \
  --managed-update-evidence /tmp/managed-update-evidence.json \
  --factory-manifest /trusted/factory-manifest.json \
  --experimental-acceptance /tmp/vision-experimental-delivery/experimental-acceptance.json
```

## 合并保护说明

并行的 Factory 或现场恢复工作都必须保住这个边界：

- 不能重新引入 direct exe replacement；
- 不能为 VM、非 ISO、Factory 维护三套 Vision digest 或三套构件；
- `FactoryProfile`、managed update、Vision materialization 继续共用同一条 exact-byte 路径。
