# 托管机器更新运行手册

托管机器更新是首台试点机器替换 Windows 机器 daemon、顾客侧机器 UI 和视觉应用的常规路径。受控 SSH 仅用于紧急访问：可用于复制产物、收集证据或恢复故障主机，不得作为常规安装机制。

## 范围

- daemon 产物：`C:\VEM\bringup\vending-daemon.exe`
- 机器 UI 交付单元：`C:\VEM\bringup\machine.exe` 与 `C:\VEM\bringup\WebView2Loader.dll`
- Vision Release Bundle：供应方原始不可变 bundle、descriptor、attestation、SBOM、provenance、conformance evidence 和 VEM approval
- Vision 版本目录：`C:\VEM\vision\releases\<version>-<digest-prefix>`
- Vision 外部配置与 current selection：`C:\ProgramData\VEM\vision`
- 视觉启动入口：`C:\VEM\bringup\start_vision.bat`
- daemon 服务：`VemVendingDaemon`
- 机器 UI 任务：`VEMMachineUI`
- 视觉任务：`VEM\StartVisionServer`
- 证据 JSON：由 `scripts/windows/apply-managed-update.ps1` 写入

daemon、UI 和视觉分别独立更新。UI 更新只停止 `VEMMachineUI` 和 `machine.exe`，不得停止 daemon 服务。daemon 更新只重启 `VemVendingDaemon`，不得结束机器 UI。

daemon 或 UI 的受控传输仍使用 `scripts/windows/deploy-windows-artifact.sh`；它只接受 `--kind daemon|ui`。Vision 不得通过该脚本传输，因为它会创建新的 zip，从而改变供应方 release bundle。

Vision 是独立本地能力。它通过既有 `VEM\StartVisionServer` 交互式任务启动；更新只停止该任务和 VEM 记录的 Vision 子进程，不得停止 daemon 或机器 UI。

更新器会把每个组件绑定到生产目标路径。`daemon` 只能替换 `C:\VEM\bringup\vending-daemon.exe`；`ui` 只能替换 `C:\VEM\bringup\machine.exe`。UI 清单还可携带唯一允许的 sidecar `C:\VEM\bringup\WebView2Loader.dll`。清单或直接调用如果提供了不同的 `targetPath`，会在替换前失败。省略 `targetPath` 时，使用所选组件允许的默认路径。

## 清单

将产物放到 Windows 主机上，计算 SHA256 值，并写入本地清单：

```json
{
  "updateId": "2026-06-27-local",
  "sourceCommit": "replace-with-full-40-hex-git-commit",
  "components": [
    {
      "component": "daemon",
      "artifactPath": "C:\\VEM\\updates\\vending-daemon.exe",
      "sha256": "replace-with-64-hex-sha256",
      "targetPath": "C:\\VEM\\bringup\\vending-daemon.exe"
    },
    {
      "component": "ui",
      "artifactPath": "C:\\VEM\\updates\\machine.exe",
      "sha256": "replace-with-64-hex-sha256",
      "targetPath": "C:\\VEM\\bringup\\machine.exe",
      "sidecars": [
        {
          "artifactPath": "C:\\VEM\\updates\\WebView2Loader.dll",
          "sha256": "replace-with-64-hex-sha256",
          "targetPath": "C:\\VEM\\bringup\\WebView2Loader.dll"
        }
      ]
    }
  ]
}
```

`updateId` 与完整 40 位十六进制 `sourceCommit` 均为清单模式必填。`components` 至少必须包含一个组件；空数组会被拒绝。`sidecars` 只在 UI 清单模式中支持；省略它时旧的单文件 UI 清单保持兼容。更新器会在停止 UI 前验证并备份 UI 主程序和 sidecar，然后一次停止、整组替换、一次启动。

在 Windows 主机上使用管理员 PowerShell 运行：

```powershell
.\scripts\windows\apply-managed-update.ps1 `
  -ManifestPath C:\VEM\updates\managed-update.json `
  -EvidencePath C:\VEM\updates\evidence-managed-update.json
```

不使用清单更新单个组件时：

```powershell
.\scripts\windows\apply-managed-update.ps1 `
  -Component ui `
  -ArtifactPath C:\VEM\updates\machine.exe `
  -Sha256 replace-with-64-hex-sha256 `
  -EvidencePath C:\VEM\updates\evidence-ui-update.json
```

如果直接输入时提供 `-TargetPath`，它必须匹配该组件的固定目标路径。直接输入模式保留给兼容和紧急恢复，无法生成可用于生产验收的不可变来源绑定；生产交付和验收必须使用清单模式。

## UI 启动模式

默认的 `-UiLaunchMode auto` 支持两种顾客侧启动模式：

- 如果存在 `VEMMachineUI` 计划任务，更新器会停止并启动该任务。
- 如果计划任务不存在，更新器会将主机视为 Shell Launcher 或直接进程安装模式，并直接启动 `C:\VEM\bringup\machine.exe`。

只有在计划任务必须存在时才使用 `-UiLaunchMode scheduledTask`。在明确的 Shell Launcher 或直接进程维护窗口中使用 `-UiLaunchMode directProcess`。证据会记录解析后的 `launchMode`。

## 验收证据

将证据 JSON 与发布记录一起保存。它会记录：

- 请求的组件、产物路径、目标路径和预期 sha256
- 清单 `updateId`
- `managed-update-source-binding/v1` 来源绑定，其中包含清单原始字节的 `manifestSha256`、完整 `sourceCommit`、`updateId`，以及规范化后的所有组件和 sidecar 哈希
- 旧可执行文件和 UI sidecar 的备份路径
- 主程序和 sidecar 的已安装哈希
- 更新后健康检查结果
- 适用时的 rollbackAttempted、rollbackOk 和回滚健康详情

来源绑定在替换开始前由同一份已解析清单生成。后续验收会把当前部署清单的字节哈希、来源提交、更新 ID、组件哈希，与更新证据和运行时报告中的已部署 UI 哈希双向比对；部署后改写清单，即使替换成另一个格式合法的提交号，也会使验收失败。

daemon 健康通过 daemon ready 文件检查。`healthzUrl` 和 `readyzUrl` 都必须携带 ready 文件令牌并返回 HTTP 成功。证据会记录 `healthzOk`、`readyzOk`、daemon `status`、ready `mode`、ready `status` 和 `blockingCodes`。更新验收不要要求 `canSell=true`，因为真实机器可能正处于维护窗口或硬件未接入状态。

机器 UI 健康检查会确认已部署主程序与清单中的 sidecar 哈希均匹配请求的 SHA256，并且存在从 `C:\VEM\bringup\machine.exe` 精确路径运行的 `machine.exe` 进程。`Path` 为空或不同的机器进程不视为健康。

## 回滚

脚本会在替换前备份当前可执行文件。UI 清单包含 sidecar 时，主程序和 sidecar 是同一个原子交付单元；若任一替换、重启或健康检查失败，它会整组恢复备份，只重启 UI 一次，并记录回滚证据。

UI 回滚使用与正常 UI 重启相同的启动模式解析。任务存在时可通过 `VEMMachineUI` 恢复；主机基于 Shell Launcher 或直接进程时，可通过直接启动 `machine.exe` 恢复。

如果回滚证据显示 `rollbackOk=false`，使用紧急受控 SSH 或现场维护访问检查主机。在机器为 daemon 和 UI 生成干净证据 JSON 之前，不要继续常规更新。

## Linux 静态检查

将产物交给现场运维前运行：

```bash
node scripts/check-managed-machine-update.mjs
node scripts/check-machine-vision-deployment.mjs
```

该检查会验证脚本契约，包括固定组件目标路径、拒绝空组件、daemon `healthz` 和 `readyz` 证据、UI 目标哈希校验、任务或直接启动回退，以及组件隔离的停止和重启行为。它不能证明 Windows 主机可以重启服务或任务。Windows 实际运行及其证据 JSON 仍是生产验收记录。

## Vision Release Bundle

Vision 的源码、模型、依赖、打包、SBOM 和 provenance 由 Vision 发布方负责。VEM 只消费原始 immutable bundle，绝不重新构建、重新打包或修改版本目录中的私有运行时文件。每个 Factory Manifest 的 `vision-release` 必须绑定同一 bundle digest 的 descriptor、artifact attestation、SBOM、provenance、black-box conformance evidence 和 VEM approval；任一 digest 不一致都不得安装或作为 Factory Manifest 选择。

现场测试使用与 Factory/ISO 相同的供应方 Candidate、提取器、外部配置、运行入口和最终安装器，不再维护 Development bundle 或另一套安装路径。唯一放宽的是验收层级：先在目标机的隔离暂存目录执行候选包黑盒测试，摄像头未接入时允许 `cameraReady=false`，但模型、HTTP、WebSocket、版本和进程身份必须通过；通过后才由 VEM 验收密钥签署 conformance 与 approval，并从已有 Factory Manifest 派生一次性的 Experimental Candidate 交付目录。

在可信工作站上先验证供应方签名和操作者固定的 tag、bundle digest、supplier identity：

```bash
node scripts/factory/experimental-vision-candidate.mjs verify \
  --candidate-dir /tmp/vision-candidate \
  --tag v0.2.1-rc.1 \
  --expected-bundle-digest sha256:... \
  --expected-supplier-identity spki-sha256:...
```

不要零散复制 bundle、descriptor 或 PowerShell 模块。验证 Candidate 后先生成自包含的预批准交付单元；它包含 exact bundle、descriptor、测试入口 `test-vision-candidate.ps1`、共享 materializer `vision-release-materialization.psm1`、共享脱敏模块 `vision-diagnostic-redaction.psm1`、`preapproval-manifest.json` 与 `SHA256SUMS`。manifest 把操作员钉住的 `ExpectedDigest` 与每个实际执行文件的 digest 一起写入可哈希边界：

```bash
node scripts/factory/experimental-vision-candidate.mjs prepare-preapproval \
  --candidate-dir /tmp/vision-candidate \
  --tag v0.2.1-rc.1 \
  --expected-bundle-digest sha256:<operator-pinned-exact-bundle-digest> \
  --expected-supplier-identity spki-sha256:... \
  --output /tmp/vision-preapproval-delivery
```

将 `/tmp/vision-preapproval-delivery/VEM-VISION-PREAPPROVAL` 整个目录原样传输到 `C:\VEM\updates\vision-preapproval`；传输前后都验证 `SHA256SUMS`。不得重新压缩 bundle、重命名 manifest 中的文件，或以本机仓库中的脚本替换目录内的测试入口或模块。Windows 入口会再次校验 manifest identity、每个文件 digest、无 reparse traversal，以及 manifest 的 `ExpectedDigest` 与显式参数完全一致。该脚本只暂时停止 Vision 任务和 VEM 已记录且身份验证过的 Vision 进程，不会停止 daemon 或 Machine UI；结束后会验证地恢复旧 release，并输出 conformance JSON：

Candidate 验收的唯一规范执行入口是自包含预批准交付单元中的 `C:\VEM\updates\vision-preapproval\test-vision-candidate.ps1`（即下例的 `$delivery\test-vision-candidate.ps1`）。仓库内 `scripts/windows/test-vision-candidate.ps1` 只是生成该单元的受审源文件；Factory 不安装另一份常驻 Candidate 入口。必须从 `$delivery` 一起执行已由 manifest 钉住的测试入口、materializer 和 redactor，不能以本机 bringup 或仓库中的同名文件替换其中任何成员。

```powershell
$delivery = "C:\VEM\updates\vision-preapproval"
$manifest = Get-Content -LiteralPath "$delivery\preapproval-manifest.json" -Raw -Encoding UTF8 | ConvertFrom-Json
if ($manifest.expectedDigest -cne "sha256:<operator-pinned-exact-bundle-digest>") { throw "operator ExpectedDigest differs from preapproval delivery" }
& "$delivery\test-vision-candidate.ps1" `
  -BundlePath "$delivery\bundle.bin" `
  -ExpectedDigest $manifest.expectedDigest `
  -DescriptorPath "$delivery\vision-release-descriptor.json" `
  -PreapprovalManifestPath "$delivery\preapproval-manifest.json" `
  -ConformanceEvidencePath "$delivery\vision-conformance.json" `
  -ReportPath "$delivery\vision-conformance-report.json"
```

取回 conformance 后，在可信工作站生成签名的 Experimental Candidate Factory 交付目录。`--verifier` 与 `--base-manifest` 必须来自当前 Factory 信任域；验收私钥不得传到目标机或写入仓库：

```bash
node scripts/factory/experimental-vision-candidate.mjs finalize \
  --candidate-dir /tmp/vision-candidate \
  --tag v0.2.1-rc.1 \
  --expected-bundle-digest sha256:... \
  --expected-supplier-identity spki-sha256:... \
  --conformance /tmp/vision-conformance.json \
  --acceptance-private-key /tmp/vem-acceptance-private.pem \
  --expected-acceptance-identity spki-sha256:... \
  --verifier /trusted/vision-release-verifier.exe \
  --base-manifest /trusted/factory-manifest.json \
  --output /tmp/vision-experimental-delivery
```

目标机仍使用 `provision-vision-factory-release.ps1` 写入受保护的最终 Factory delivery/trust 路径，然后调用同一个 `install-vision-release.ps1`。预批准必须使用上述完整且可哈希验证的 preapproval delivery unit，并由操作员在 manifest 外再次钉住同一个 `-ExpectedDigest sha256:...`；它不会从 bundle 或 descriptor 隐式选择摘要。这次通过只证明软件与无摄像头 degraded 路径就绪，不替代插入真实摄像头后的视觉现场验收，也不把 Experimental Candidate 自动升级成 Factory/ISO acceptance。

在 Windows 管理员 PowerShell 中，以已验证的本地输入安装：

```powershell
.\scripts\windows\install-vision-release.ps1 `
  -BundlePath C:\VEM\updates\vision-release.zip `
  -DescriptorPath C:\VEM\updates\vision-descriptor.json `
  -AttestationPath C:\VEM\updates\vision-attestation.json `
  -SbomPath C:\VEM\updates\vision-sbom.json `
  -ProvenancePath C:\VEM\updates\vision-provenance.json `
  -ConformanceEvidencePath C:\VEM\updates\vision-conformance.json `
  -ApprovalPath C:\VEM\updates\vision-approval.json `
  -FactoryManifestPath C:\VEM\updates\factory-manifest.json `
  -ConfigurationPath C:\ProgramData\VEM\vision\config\site.json
```

首次安装不接受命令行传入的 release metadata：它只使用 Factory Media 的真实 `vision-release` delivery unit，位于 `C:\ProgramData\VEM\factory\vision-release`，其中的 bundle、Factory Manifest 和完整 evidence 必须一起交付。Windows 只从受保护的 `C:\ProgramData\VEM\factory-trust` 读取 trust anchor、policy 和 verifier；更新 bundle 不得携带或替换这些 trust roots。

安装器按版本和 digest 写入 `C:\VEM\vision\releases`，将 current selection、只允许 kiosk 原子写入的 `process-state`、版本 metadata 和外部配置保持在 `C:\ProgramData\VEM\vision`，并生成 VEM-owned launcher `C:\VEM\bringup\start_vision.bat`。它使用 `VEM\StartVisionServer` 启动，通过 loopback HTTP health 和 `vem.vision.v1` `vision.hello` / `vision.ready` 对 exact installed digest 做 black-box conformance；启动或健康失败时恢复上一已批准 selection，并写入不含路径、配置值、凭据或私有运行时细节的证据。

`docs/vending-vision.zip` 当前只可作为候选评估：digest 为 `sha256:9dc9dda0fb60a69cfac142bbbfd09f769b8ef965c0f4d3bbc8ccf3a8e33d4b1b`，但缺少 release descriptor、artifact attestation、SBOM、provenance、clean-Windows health/WebSocket conformance evidence 和 VEM approval，故不得标记为 approved 或安装。

首次装机或任务丢失时，在 release 成功安装后重新注册启动项：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass `
  -File C:\VEM\repo\scripts\windows\setup-scheduled-tasks.ps1
```

验证视觉部署：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass `
  -File C:\VEM\bringup\scripts\verify-vem-runtime.ps1 `
  -RequireBackendOnline `
  -RequireMqttConnected `
  -RequireVisionOnline
```

没有真实摄像头时，Vision 可能报告 degraded；这不应阻断售卖主流程。但新机器生产验收必须至少证明 approved digest、version-addressed directory、external configuration、launcher、任务、HTTP health 和 WebSocket conformance。
