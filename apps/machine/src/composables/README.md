# 机器运行时 Composables 与 Stores

机器 UI 中涉及天气、自然上下文、本地温度信号和环境控制时，使用这些入口。调用侧要保持外部天气、本地传感器读数和空调命令彼此分离。

## 自然上下文与天气

- `useNaturalContextStore`，来自 `../stores/natural-context`：从 `/v1/natural-context` 读取 daemon 的 Natural Context Projection。
- `snapshot.externalEnvironment`：平台提供的外部自然环境。配置完成后包含天气、本地时间、日出和日落。
- `snapshot.localSiteSignals`：机器观测到的本地现场信号。当机器环境传感器有有效样本时，包含温度和湿度。
- `degraded` 和 `operatorMessage`：面向操作员的就绪度/诊断辅助信息，用于提示 Natural Context 输入不完整。

## 空调控制

- `useEnvironmentControlStore`，来自 `../stores/environment-control`：向本地 daemon 发送环境控制意图。
- `controlAirConditioner({ airConditionerOn, targetTemperatureCelsius })`:
  切换空调开关和/或修改目标温度。
- `latestResult`, `airConditionerOn`, `targetTemperatureCelsius`, and
  `latestControlSucceeded`：最近一次已确认的本地命令结果。

## 顾客体验事件

- `CustomerExperienceEvent`，来自 `../customer-events/events`：面向顾客体验功能的语义事件类型。它覆盖迎宾、触屏唤醒、多人围观、选品、支付提示、支付成功、出货/取货结果、超时提示、休眠提示、彩蛋和设备故障等事件。
- `useCustomerEvents`，来自 `./useCustomerEvents`：提供轻量的 `emit` / `on` 事件总线，供功能实现方订阅或派发这些语义事件。
- `useCustomerEventSources`，来自 `./useCustomerEventSources`：把顾客旅程事实转换成顾客体验事件，音频提示只是这些事件的消费者之一。
- `createMachineAudioCuePlaybackAdapter().handleCustomerEvent(event)`：音频播放方消费顾客体验事件的入口。
- 这里仅提供事件基础设施；具体什么时候派发某个事件，应由对应功能流程负责。

## 机器音频播放

- 生产客户流程的机器音频应通过统一的 Machine Audio Playback helper 播放和停止，不要在页面里直接 new `Audio()` 或直接调用 Tauri 命令。
- 打包音频放在 `apps/machine/src/assets/audio/`，由 TypeScript import 进入 Vite 构建；Tauri 打包时随 `dist` 一起进入应用包。不要在客户流程里手写不受构建校验的本地文件路径。
- 客户流程调用 `playLocal()` 时应传入 Vite import 得到的音频 URL，而不是手写文件名字符串或本机文件路径。
- 第一版只支持单个 active playback。新的播放请求默认停止并替换当前播放；`stop()` 停止当前播放并记录 stopped 诊断；不支持多路混播或按句柄精确停止。
- 播放诊断可记录 requested、started、completed、failed、stopped。`completed` 仅用于诊断和测试观察，不参与交易、出货、页面跳转或 sale readiness。
- #150 首版客户流程只支持本地打包音频。平台托管音频属于后续能力，届时应使用 service-api 管理的媒体资产 URL；任意外部 URL 只允许用于 protected maintenance/debug 诊断，不作为客户流程输入。
- 整体 Machine Audio Playback 规划包含单一全局机器音频音量，由维护页以 0-100% 呈现并应用到本地打包音频、未来平台托管音频和测试播放；不要为每个音频单独配置音量。
- Machine Audio Playback helper 应自动解析 playback driver：E2E/单元测试使用 mock driver；生产 Tauri runtime 在 native playback 可用时优先使用 native driver；非 Tauri 或 native 不可用时使用 browser driver。native 不可用时允许自动降级到 browser driver，但必须记录降级诊断。
- 单次播放请求最多执行一次 native -> browser fallback；如果 browser 也失败，只记录失败诊断，不在底层 helper 内自动循环重试。
- E2E 和单元测试不得依赖真实声卡、系统音量或浏览器实际发声。测试应使用 mock/test playback driver，并断言播放请求、停止请求、driver 降级、失败诊断等可观察状态。
- Protected maintenance 应提供测试播放入口，支持播放本地打包测试音频、停止当前播放、显示当前 playback driver、显示最近一次 started/completed/failed 结果，并提示操作员确认 Customer Audio Zone 内清晰且周边不扰民。
- 真实喇叭接入属于现场验收，不属于默认 E2E。验收时在 Win10/Tauri 生产环境通过 protected maintenance 测试播放真实 native audio，软件侧确认 started/completed/failed 结果，操作员确认 Customer Audio Zone 内可听清且周边不扰民。

## 本地温度信息

- 客户端或维护 UI 需要当前本地温湿度上下文时，优先使用 `useNaturalContextStore().snapshot?.localSiteSignals`。
- 只有在已经读取平台机器快照的 admin/操作员视图中，才优先使用 admin API 字段 `latestEnvironment` 和 `latestEnvironmentCommand`。
- 不要用天气温度替代本地 Temperature-Humidity Sensor。天气属于外部自然环境；传感器温度属于本地现场信号。
