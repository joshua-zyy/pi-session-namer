# pi-session-namer 实施方案

- **状态**：待实现
- **版本**：v0.1
- **仓库**：`D:\AI\agentBySelf\pi-extensions\pi-session-namer`
- **插件名称**：`pi-session-namer`
- **配置文件**：`~/.pi/agent/session-namer.json`

## 1. 背景

pi 的 session 名称默认不一定能准确反映当前工作内容。当一个 session 被压缩后继续复用、切换任务或进入新的功能阶段时，原名称可能已经失真，导致用户难以在 session 列表中快速定位目标对话。

本插件借鉴 `MMDD｜类型｜主题` 的命名思路，使用当前主 agent 或用户配置的命名模型，根据当前活动对话上下文自动生成和更新 session 名称。

## 2. 目标

1. 新 session 在首轮 agent 工作完成后自动生成简洁、规范的名称。
2. session 压缩完成后重新判断当前主要任务，必要时更新名称。
3. 普通对话按配置的轮次低频检查任务是否发生明显变化。
4. 用户可通过独立命令立即刷新、锁定、解锁和查看状态。
5. 默认使用用户所在系统时区计算 session 创建日期。
6. 默认继承当前主 agent 模型和思考强度，同时支持独立配置。
7. 自动名称、锁定状态和有限名称历史能够随 session resume/reload 恢复。

## 3. 非目标

本版本明确不做以下事情：

- 不批量重命名历史 session。
- 不修改项目名称。
- 不修改对话内容、项目归属、排序、置顶或归档状态。
- 不创建外部数据库或项目级状态文件。
- 不在每一轮对话都调用命名模型。
- 不做敏感信息识别、掩码或脱敏。
- 不依赖真实模型 API、网络或 API key 编写单元测试。
- 不自动删除、覆盖用户已有配置文件。
- 不允许自动命名绕过用户设置的锁定状态。

> 命名请求会包含插件选定的会话上下文。插件不额外脱敏，用户应根据所选 provider/model 的隐私策略进行配置。

## 4. 用户场景

### 4.1 首次命名

用户创建 session 并完成首轮工作后，插件根据当前对话生成：

```text
0310｜修复｜处理 OAuth 回调错误
```

### 4.2 压缩后复用

用户原先处理认证研究，压缩后改为实现支付页面。插件在压缩后的 agent 工作稳定后重新判断：

```text
0310｜探索｜研究认证方案
→ 0310｜功能｜实现支付页面
```

如果压缩没有改变主要任务，模型返回 `KEEP`，名称不变。

### 4.3 手动保护名称

用户执行 `/name 重要的登录问题` 后，插件将该名称视为用户意图并自动锁定。之后自动检查不会覆盖它，除非用户执行 `/session-name-unlock`。

## 5. 名称规则

最终名称格式（默认）：

```text
MMDD｜类型｜主题｜进度
```

进度段可选：名称格式模板包含 `{progress}` 占位符时才生成，用户可通过 `nameFormat` 配置删除它。进度最多 16 字符，由模型从当前任务状态提炼（如“已发布0.1.1”、“测试中”）。用户可通过 `nameFormat` 自定义整体格式，支持 `{date}`、`{type}`、`{topic}`、`{progress}` 占位符；日期始终由程序注入。

### 5.1 日期

- 日期取 session header 的创建时间 `timestamp`，对应 pi session 格式中的创建时间。
- 默认使用 Node.js 运行环境的系统时区。
- 用户可以在配置中指定 IANA 时区，例如 `America/New_York`。
- 日期使用 session 创建时计算出的本地日期。
- 日期在同一 session 后续重命名时保持不变，不因当前日期、时区配置变化而漂移。

### 5.2 类型

默认类型白名单为：

```text
Feature、Design、Fix、Optimization、Release、Exploration、Documentation、Research
```

用户可通过 `types` 配置自定义类型列表；提示词只允许模型从用户配置的类别中选择。模型以命名语言表达选定的类别标签。

### 5.3 主题

- 根据当前主要任务提炼。
- 简洁、具体，适合 session 列表显示。
- 类型和主题均跟随对话主要语言。
- 不重复项目名称。
- 不应包含项目路径或文件路径。
- 普通进展、措辞变化或文件变化不应触发改名。
- 只有主要任务发生明显变化时才生成新名称。

## 6. 事件与生命周期设计

### 6.1 `agent_settled`

作为统一执行入口。该事件表示当前 agent run 已结束，包括自动重试和压缩恢复流程已经稳定。

触发规则：

1. 没有 session 名称时，作为首次命名机会。
2. 首次命名成功后，周期计数从 0 开始。
3. 之后每 `checkEveryTurns` 轮触发一次周期检查。
4. 压缩事件设置待处理标志，随后在 `agent_settled` 执行一次检查。
5. 多个原因同时到达时合并为一次命名请求。

### 6.2 `session_compact`

不在事件 handler 中直接调用模型，只记录 `compact` 待处理原因。这样可以避免压缩仍在进行或自动 retry 时并行调用命名模型。

下一次 `agent_settled` 时优先执行压缩后的检查，并重置周期计数。

### 6.3 `session_info_changed`

事件本身没有来源字段，因此使用以下策略识别用户手动命名：

1. 插件调用 `pi.setSessionName()` 前设置内部变更标志。
2. 插件收到对应事件后消费该标志，视为自动变更。
3. 没有内部标志的名称变化视为外部/用户手动变更，并设置 `manualLock: true`。
4. reload/resume 后，如果当前名称不同于持久化的最近自动名称，也视为手动变更。
5. 通过 `/session-name-lock` 可以显式设置锁定，不依赖推断。

### 6.4 `session_start`

加载最新的插件 custom entry，恢复锁定状态、日期、名称历史和周期计数。配置在扩展加载时读取，修改配置后通过 `/reload` 生效。

## 7. 状态模型

状态使用 session custom entry 持久化，`customType` 固定为 `pi-session-namer`，不进入 LLM 上下文。

推荐数据结构：

```json
{
  "version": 1,
  "autoName": "0310｜功能｜实现 OAuth 登录｜已发布",
  "segments": { "type": "功能", "topic": "实现 OAuth 登录", "progress": "已发布" },
  "manualLock": false,
  "date": "0310",
  "timeZone": "America/New_York",
  "turnsSinceCheck": 2,
  "history": [
    {
      "name": "0310｜探索｜研究认证方案",
      "source": "auto",
      "reason": "initial",
      "updatedAt": "2026-03-10T12:00:00.000Z"
    },
    {
      "name": "重要的登录问题",
      "source": "manual",
      "reason": "manual",
      "updatedAt": "2026-03-10T13:00:00.000Z"
    }
  ]
}
```

约束：

- 每次状态变化追加一条 custom entry。
- 恢复时使用最后一条有效状态。
- 历史最多保留最近 5 次名称变更。
- 自动名称和用户手动名称都记录历史。
- `autoName` 表示最近一次由插件生成的名称，不一定等于当前名称。
- 当前名称仍以 pi 的 session info 为准。

## 8. 自动命名状态机

```text
未命名 / 未锁定
  ├─ 首轮 settled → 请求模型
  │                    ├─ 合法类型｜主题 → 设置名称，进入自动管理
  │                    ├─ SKIP → 保持未命名，允许以后重试
  │                    └─ 失败/非法 → 保持状态，自动重试但受失败上限约束
  │
自动管理中
  ├─ 周期到达 → 请求模型
  │               ├─ KEEP → 保持名称，重置周期计数
  │               ├─ 新的类型｜主题 → 更新名称，重置周期计数
  │               └─ SKIP/失败 → 保留名称，重置本次检查计数
  ├─ session_compact → 设置待处理标志
  ├─ settled → 合并待处理原因后检查
  ├─ 用户 /name → 当前名称变更，设置 manualLock
  └─ lock → manualLock = true

手动锁定
  ├─ 自动触发 → 跳过
  ├─ refresh → 提示先 unlock，不绕过锁定
  └─ unlock → 解除锁定、保留旧名称；等待用户主动 refresh
```

## 9. 命令设计

不注册 `/session-name`，避免与 pi 的同名命令和输入确认行为混淆。使用独立命令：

| 命令 | 行为 |
|---|---|
| `/session-name-refresh [force] [instruction]` | 立即分析当前上下文；`force` 前缀强制重评类型与主题，其余文本作为附加要求注入提示词；锁定时提示先 unlock；成功更新或 SKIP 都反馈结果 |
| `/session-name-lock` | 锁定当前已有名称；没有名称时提示，不调用模型 |
| `/session-name-unlock` | 解除锁定并保留旧名称；不调用模型，需要时再执行 refresh |
| `/session-name-status` | 显示当前名称、锁定状态、下次周期检查轮次 |

规则：

- 手动 refresh 重置周期计数，无论结果是成功、KEEP、SKIP 还是失败。
- unlock 后保持解锁，名称保持不变，直到用户主动执行 refresh。
- 没有名称时 refresh 返回 KEEP 只保持未命名并结束，不做兜底命名。
- lock 后 refresh 不能绕过锁定。

## 10. 配置设计

### 10.1 文件位置

```text
~/.pi/agent/session-namer.json
```

Windows 示例：

```text
C:\Users\<用户名>\.pi\agent\session-namer.json
```

插件不得硬编码用户名或平台路径，应使用 Node.js 的 home 目录解析。

### 10.2 默认配置

插件首次加载时，如果文件不存在则创建，已存在文件绝不覆盖：

```json
{
  "model": "inherit",
  "thinkingLevel": "inherit",
  "timeZone": "auto",
  "checkEveryTurns": 4,
  "nameFormat": "{date}｜{type}｜{topic}｜{progress}",
  "types": ["Feature", "Design", "Fix", "Optimization", "Release", "Exploration", "Documentation", "Research"],
  "nameLanguage": "auto"
}
```

旧版配置文件（仅含前四个字段）完全兼容：缺失的新字段自动使用默认值，不覆盖用户文件。

默认文件创建失败时，只警告一次并继续使用内存默认值，不阻止 pi 启动。

### 10.3 配置字段

| 字段 | 默认值 | 说明 |
|---|---|---|
| `model` | `inherit` | 使用当前主 agent；或配置 `provider/modelId` |
| `thinkingLevel` | `inherit` | 继承触发时主 agent；或配置固定等级 |
| `timeZone` | `auto` | 使用系统时区；或配置 IANA 时区名 |
| `checkEveryTurns` | `4` | 正整数表示周期；`0` 关闭普通周期检查 |
| `nameFormat` | `{date}｜{type}｜{topic}｜{progress}` | 名称渲染模板，占位符 `{date}` `{type}` `{topic}` `{progress}` |
| `types` | 八个默认类型 | 注入提示词的类型白名单 |
| `nameLanguage` | `auto` | `auto` 跟随对话语言；或语言标签强制指定 |

`nameFormat` 必须包含 `{type}` 和 `{topic}`，否则回退默认模板。

负数、非数字或不支持的配置使用对应默认值。配置 JSON 损坏时警告一次并使用默认配置，不重建或覆盖用户文件。

配置只在插件加载时读取，用户修改后执行：

```text
/reload
```

## 11. 模型选择与思考强度

### 11.1 模型选择

- `model: inherit`：使用触发时的 `ctx.model`。
- 配置独立模型：使用 `ctx.modelRegistry.find(provider, modelId)`。
- 独立模型不存在或没有认证：警告并回退到当前主 agent 模型。
- 主模型和配置模型都不可用：跳过命名，不影响主 agent。

### 11.2 思考强度

- `thinkingLevel: inherit`：读取触发时的主 agent 当前思考等级。
- 固定配置优先于主 agent 当前等级。
- 支持 `off / minimal / low / medium / high / xhigh / max`。
- 根据 provider/API 的实际能力映射参数，不跨 provider 原样传递参数。
- 不支持思考参数的模型不发送思考相关字段。
- 配置等级不被模型支持时逐级降级：

```text
max → xhigh → high → medium → low → minimal → off
```

- 最终不能使用思考时关闭思考，不使主任务失败。

模型调用使用 pi 提供的 `ctx.modelRegistry.complete()`，只使用短文本请求，并使用 `cacheRetention: "none"`。不启用深度思考以外的额外 agent 工具调用。

## 12. LLM 请求协议

### 12.1 输入上下文

命名请求只发送与当前任务相关的受限上下文：

- 当前活动分支。
- 压缩摘要和压缩后保留的上下文。
- 最近几轮 user/assistant 文本。
- assistant 的工具调用名称，不发送工具参数和工具结果。
- 限制消息数量和总字符数，避免请求过大。

不发送完整工具参数和结果，也不做额外敏感信息脱敏。

### 12.2 输出协议

模型始终返回分段描述：

```text
SKIP
```

```text
类型｜主题
```

```text
类型｜主题｜进度
```

（第三段仅在名称格式包含 `{progress}` 时请求。）程序解析为结构化分段（type/topic/progress）后，由代码 diff 决定行为：

- 分段与上次完全相同 → no-op（不改名、不写历史）。
- type/topic 不变、仅 progress 变化 → 静默更新名称，不通知。
- type/topic 变化 → 更新名称，首次命名与手动 refresh 通知。
- 模型违规输出 KEEP → 视为无效输出（null），本次不改名。
- 其他无法解析的输出 → 视为无效，不修改名称。

提示词要求模型：当前名称的 type/topic 仍能描述任务时必须逐字复用；进度必须以对话末尾的最新证据为准（如 "published 0.1.1"、"fix verified"），不得在更晚里程碑已达成时报告更早阶段。

## 13. 错误、并发与重试

- 自动命名失败不影响主 agent。
- 自动触发失败静默处理；手动 refresh 显示失败提示。
- `running` 标记防止并发命名请求。
- 触发原因使用集合合并，`manual > compact > initial > periodic`。
- 自动命名最多连续尝试 3 次；达到上限后暂停自动尝试，手动 refresh 仍可触发。
- 自动命名调用不应修改主 agent 的 session context。
- 名称设置必须通过统一的内部函数完成，以保证来源标记、历史和状态持久化一致。

## 14. 实现拆分

### 阶段 1：仓库与纯逻辑

- 创建 package 结构、MIT License、README 和配置示例。
- 实现配置读取、默认文件创建和配置校验。
- 实现系统/IANA 时区解析。
- 实现上下文文本提取和长度限制。
- 实现 `KEEP` / `SKIP` / `类型｜主题` 解析。
- 实现状态模型和历史裁剪。
- 编写纯逻辑单元测试。

### 阶段 2：pi 生命周期接入

- 接入 `session_start`、`agent_settled`、`session_compact`、`session_info_changed`。
- 实现首次命名、周期检查和压缩待处理标志。
- 实现 custom entry 持久化与恢复。
- 实现四个独立命令。

### 阶段 3：模型适配

- 接入当前主 agent 模型继承。
- 接入独立模型配置和 fallback。
- 接入思考强度继承、固定配置和 provider 适配。
- 接入重试、并发保护和错误提示。

### 阶段 4：文档与验证

- 完善 README、安装说明和配置说明。
- 执行类型检查、单元测试和 lint。
- 使用真实 pi session 做最小端到端验证。
- 检查最终 diff 和插件加载结果。

## 15. 测试计划

### 15.1 纯逻辑测试

- 系统时区和显式 IANA 时区转换。
- 无效时区回退。
- 默认配置创建且不覆盖已有文件。
- 损坏配置回退默认值。
- `inherit` 和固定配置解析。
- 文本提取、工具名称提取和长度限制。
- `KEEP`、`SKIP` 和合法类型主题解析。
- 错误日期被程序替换为 session 创建日期。
- 历史最多保留 5 条。
- 状态从最新 custom entry 恢复。

### 15.2 扩展行为测试

- 首轮 settled 触发命名。
- 已命名但未锁定的 session 可以周期更新。
- 周期值为 0 时不触发普通周期检查。
- 压缩只设置待处理标志，settled 后只调用一次。
- 手动 `/name` 后自动锁定。
- lock、unlock、refresh、status 命令符合约定。
- 锁定时自动触发和 refresh 都不改名。
- unlock 后保持解锁并保留旧名称，refresh 由用户主动触发。
- 模型不可用时不影响主 agent。
- 命名调用并发时只执行一次。

### 15.3 不做的测试

- 不在单元测试中调用真实 provider。
- 不依赖真实 API key、网络或具体模型输出。
- 不测试批量历史 session 重命名，因为该功能不在范围内。

## 16. 验收清单

- [ ] 新 session 首轮完成后自动命名。
- [ ] 名称符合 `MMDD｜类型｜主题`。
- [ ] 日期使用系统时区或用户配置的 IANA 时区。
- [ ] 同一 session 后续重命名时日期不漂移。
- [ ] 配置文件不存在时自动创建。
- [ ] 已有配置文件不会被覆盖。
- [ ] 配置损坏时警告并使用默认值。
- [ ] 默认使用主 agent 模型。
- [ ] 独立模型配置有效且不可用时 fallback。
- [ ] 默认思考强度继承主 agent。
- [ ] 固定思考强度配置有效并可降级。
- [ ] 压缩后在 agent settled 后重新判断。
- [ ] `KEEP` 不修改名称。
- [ ] `SKIP` 不创建或修改名称。
- [ ] 普通周期检查遵守 `checkEveryTurns`。
- [ ] 手动 `/name` 后自动锁定。
- [ ] lock/unlock/refresh/status 行为正确。
- [ ] 状态和名称历史可在 resume/reload 后恢复。
- [ ] 自动命名失败不影响主 agent。
- [ ] 不修改项目名称、对话内容及其他 session 元数据。
- [ ] 不执行敏感信息脱敏。

## 17. 设计决策记录

### Decision 1：独立命令而不是 `/session-name <subcommand>`

pi 中 `/session-name` 的交互方式会影响后续参数输入。使用 `/session-name-refresh`、`/session-name-lock` 等独立命令，复制和输入都更直接，也避免与内置命令冲突。

### Decision 2：`agent_settled` 作为统一命名入口

它能覆盖首轮结束、周期检查和压缩后的稳定状态，避免在 agent 仍处于工作或自动 retry 时调用命名模型。

### Decision 3：默认继承主 agent 模型和思考强度

零配置即可工作，并且符合用户当前 provider 的认证环境。由于命名调用是短文本任务，用户仍可配置独立模型和固定思考强度控制成本。

### Decision 4：使用 custom entry 保存插件状态

状态跟随 session 文件，不进入模型上下文，不需要外部数据库，并可在 resume/reload 后恢复。

### Decision 5：不做敏感信息处理

插件只截取有限的当前上下文，不额外实现凭证识别或掩码；复杂的脱敏规则容易产生误判，隐私边界交由用户选择的模型/provider 和 pi 现有配置管理。

### Decision 6：压缩事件延迟到 settled 后处理

压缩事件只设置标志，统一在 agent 完全稳定后分析，避免与压缩恢复和后续 agent 调用产生竞态。

### Decision 7：运行时 UI 使用英文，session 名称跟随对话语言

插件命令描述、状态提示、警告和错误统一使用英文，便于国际用户使用；命名模型根据当前对话的主要语言决定类型和主题的语言，不强制使用中文或英文。

## 18. 待实现时需验证的 API 事实

以下内容在正式编码阶段需要通过当前安装版本的类型定义和源码再次确认，不在本方案中凭假设实现：

- `ctx.thinkingLevel` 到各 provider API 参数的准确映射。
- `SessionManager` 压缩后的上下文构建方式。
- `session_info_changed` 与内置 `/name` 的实际事件时序。
- `pi.appendEntry()` 写入 custom entry 后的恢复顺序。
- package 安装时 `package.json` 的最小必需字段。
