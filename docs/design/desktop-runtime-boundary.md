# 桌面端、CLI 与 Runtime 分工

记录日期：2026-09-30。本文落盘架构确认后的交互修正和前后端讨论，是 ADR-0001 的实现说明；当前接线状态以 [实现状态](../development/implementation-status.md) 为准。

## 前后端分离的含义

Helm 逻辑上前后端分离，部署上本地一体化，桌面通信优先使用 IPC。它与互联网 Web 应用同样区分展示和业务逻辑，但首版不需要部署远程业务服务器，也不需要为了 CLI 单独启动 HTTP 服务。

以下是当前关系；虚线表示仍待后续接入的主要边界：

```mermaid
flowchart TD
    UI[React Renderer：对话与工作台] --> Bridge[typed preload / Electron IPC]
    Bridge --> Main[Electron Main：本地组合层]
    Main --> Runtime[TypeScript Runtime]
    CLI[CLI] --> Runtime
    Runtime --> Mock[Mock Provider]
    Runtime -. 待联调 .-> Adapter[Provider Adapter]
    Adapter -. HTTPS .-> LLM[DeepSeek / 智谱 / Kimi]
    Main -. Kimi Code 已接入；其他厂商待实现 .-> Keychain[macOS Keychain]
    Runtime --> SQLite[SQLite 事件账本：Node 原生适配器]
    Runtime -. 待接线 .-> Worker[Python Document Worker]
    Runtime -. 待实现 .-> Execution[路径守卫 / 工具 / Sandbox]
```

| 层 | 负责 | 交互边界 |
|---|---|---|
| Renderer | 消息、输入、进度、Diff、审批展示 | 通过 preload 请求操作，不直接访问 Node、文件、密钥 |
| Preload / IPC | 暴露明确的方法与事件订阅 | 请求校验、来源检查、错误归一化需要随接线补齐 |
| Electron Main | 组装 Runtime、存储、凭据、执行适配器 | 持有运行实例，组织 IPC 和后台任务生命周期 |
| Runtime | 状态机、预算、Policy、执行回执、Verification | 模型提出 proposal，Runtime 决定执行与完成 |
| CLI | 命令、输出、后续显式运行控制 | 直接导入同一 Runtime package |
| Python worker | 单次文件处理与结构化回执 | 无 Agent 循环和审批权；受限运行环境待实现 |
| Provider | 厂商请求与响应适配 | 云 API 推理；不拥有本地执行权 |

## 对话优先的工作台

用户已明确中栏应为对话区。最终布局约定为：

- 左栏选择 Workspace 和 Session。
- 中栏保留用户/助手消息、当前执行卡片、底部输入框。详细步骤、工具输出和长日志按需展开，不能占满主对话区。
- 右栏展示当前 Run 对应的 Artifact、Diff、Approval 和 Verification。
- 终端和原始 Trace 可进入底部抽屉；这部分目前仍是规划。

当前 UI 已改为由 Runtime 事件和快照驱动的消息流、输入框、执行卡片、Approval 和 Verification。Renderer 只调用 preload 暴露的 start/snapshot/control/approval 方法；主进程将 Runtime 事件按 runId/sequence 转发并做脱敏。Desktop 默认使用用户数据目录中的 Node SQLite 事件账本与 MockProvider；CLI 可通过 `HELM_STATE_DB` 指定同一账本；设置 `HELM_PROVIDER=kimi` 时，Main 从 macOS Keychain 读取 Kimi Code 凭据并调用真实 Provider。SQLite 重启恢复、checkpoint、approval、receipt 和 JSONL 脱敏导出已有 contract test；这不代表真实文件工具、跨客户端 owner/lease 或完整编码任务验收。

## 下一步的调用流程

1. Renderer 提交用户输入与已选择的工作区/会话标识。
2. Preload 调用限定 IPC；Main 校验请求并调用 Runtime 创建或推进任务。
3. Runtime 在事件写入成功后发布带 Run id 和序号的事件；Main 转发给对应窗口。
4. Renderer 根据事件和查询快照更新消息、执行卡片和验收状态；重连时去重、补齐遗漏事件。
5. 暂停/恢复/取消由 Runtime 处理。审批提交绑定的动作标识及决定，不能靠 UI 布尔值或模型文字放行。
6. Provider 结构化 Context/Tool/ToolResult 合同和 SQLite 持久恢复已接入；真实 SSE 流式、实际文件工具和跨客户端 owner/lease 逐步接入。

上述 Task → Session → Run → 事件 → 快照路径已在 #1–#4 的骨架中实现；持久化、真实 Provider、工具执行和跨进程恢复仍是后续切片。

## 进程与部署边界

桌面 app 和 CLI 复用代码，不代表它们共享同一个运行进程或内存。Desktop 默认打开用户数据目录 SQLite，CLI 设置 `HELM_STATE_DB` 后也可打开指定账本；跨客户端同时推进同一个 Run 仍需要应用级 owner/lease 和 stale-client 拒绝协议。

Node Runtime 首先以 package 形式嵌入。将来若长任务需要脱离窗口持续运行，可以移到本地独立进程；无需现在引入网络服务、账号或多租户部署。
