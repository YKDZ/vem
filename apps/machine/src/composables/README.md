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
- `useCustomerExperienceEvents`，来自 `./useCustomerExperienceEvents`：提供轻量的 `emit` / `on` 事件总线，供功能实现方订阅或派发这些语义事件。
- `createMachineAudioCuePlaybackAdapter().requestCustomerExperienceEvent(event)`：音频播放方消费顾客体验事件的入口。旧的 `requestCustomerAudioCue(event)` 仍可用，但新代码应优先使用通用命名。
- 这里仅提供事件基础设施；具体什么时候派发某个事件，应由对应功能流程负责。

## 本地温度信息

- 客户端或维护 UI 需要当前本地温湿度上下文时，优先使用 `useNaturalContextStore().snapshot?.localSiteSignals`。
- 只有在已经读取平台机器快照的 admin/操作员视图中，才优先使用 admin API 字段 `latestEnvironment` 和 `latestEnvironmentCommand`。
- 不要用天气温度替代本地 Temperature-Humidity Sensor。天气属于外部自然环境；传感器温度属于本地现场信号。
