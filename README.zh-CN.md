# pi-session-namer

[Pi](https://github.com/badlogic/pi-mono) 的自动会话命名扩展。

插件会根据当前对话内容，为 Pi session 自动生成并定期更新名称，格式为：

```text
MMDD｜类型｜主题｜进度
```

示例：

```text
0310｜修复｜处理 OAuth 回调错误｜测试中
0310｜Fix｜Handle OAuth callback errors｜testing
```

可选的进度段展示任务当前进展，让用户不仅能认出会话在做什么，还能想起进行到哪里了。

[English documentation / 英文文档](README.md)

## 功能

- 首轮 agent 运行结束后自动命名。
- session 压缩后重新判断当前任务。
- 不在每轮调用模型，按配置周期检查任务是否发生明显变化。
- 插件命令说明、状态提示、警告和错误统一使用英文。
- session 的类型、主题和进度使用当前对话的主要语言（也可配置固定语言）。
- 可选进度段（最多 16 字符）随任务推进自动更新。
- 支持自定义名称格式模板、类型列表和命名语言。
- 主题变化时保持 session 创建日期不变。
- 默认使用操作系统时区，也支持配置 IANA 时区。
- 默认使用当前主 agent 模型，也支持配置独立的命名模型。
- 默认继承主 agent 的思考强度，也支持配置固定思考强度。
- 用户通过 `/name` 设置名称后，自动命名会被锁定。
- 将命名状态和有限的名称历史持久化到 session 中。

## 安装

在仓库中本地测试：

```bash
pi -e ./src/index.ts
```

从 npm 安装为 Pi package：

```bash
pi install npm:pi-session-namer
```

从 Git 安装为 Pi package：

```bash
pi install git:github.com/joshua-zyy/pi-session-namer
```

安装或修改源码后，重新启动 Pi，或执行：

```text
/reload
```

## 命令

| 命令 | 行为 |
| --- | --- |
| `/session-name-refresh` | 分析当前对话并更新名称。只要对话里有内容，手动刷新一定会产出名称；`SKIP` 只用于自动检查。会显示开始提示和完成结果，不会绕过锁定。 |
| `/session-name-refresh force` | 强制重新评估类型和主题，而不是复用当前值。 |
| `/session-name-refresh <要求>` | 强制重新评估，并把该文本作为附加要求注入提示词；也可写成 `force <要求>`。 |
| `/session-name-lock` | 锁定当前名称，不调用模型。 |
| `/session-name-unlock` | 解除自动命名锁定，不调用模型，也不会自动刷新名称；需要时再执行 `/session-name-refresh`。 |
| `/session-name-status` | 显示当前名称、锁定状态和下一次周期检查状态。 |

session 被锁定后，所有自动更新都会跳过。

## 配置

插件首次加载时，如果全局配置文件不存在，会自动创建：

```text
~/.pi/agent/session-namer.json
```

插件不会覆盖已有配置文件。默认内容为：

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

完整示例见 [`session-namer.example.json`](session-namer.example.json)。

### 配置项

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `model` | `inherit` | 使用主 agent 模型，也可以指定 `provider/modelId`。指定模型不可用时回退到主 agent 模型。 |
| `thinkingLevel` | `inherit` | 继承主 agent 当前思考强度，也可以设置 `low`、`medium`、`high` 等固定等级。 |
| `timeZone` | `auto` | 使用操作系统时区，也可以指定 `America/New_York` 等 IANA 时区。 |
| `checkEveryTurns` | `4` | 每 N 次 settled 的 agent 运行检查一次。设置为 `0` 可关闭普通周期检查，但保留首次命名、压缩后检查和手动刷新。 |
| `nameFormat` | `{date}｜{type}｜{topic}｜{progress}` | 名称渲染模板。占位符：`{date}`、`{type}`、`{topic}`、`{progress}`。删除 `{progress}` 即关闭进度段。 |
| `types` | 八个默认类型 | 注入命名提示词的类型白名单，可增加、删除或翻译类别。 |
| `nameLanguage` | `auto` | `auto` 跟随对话主要语言；也可设置为 `en`、`zh` 等语言标签强制指定。 |

配置在插件启动时读取。修改配置后执行：

```text
/reload
```

### 思考强度

支持以下配置值：

```text
off, minimal, low, medium, high, xhigh, max, inherit
```

`inherit` 会在触发命名时读取主 agent 的当前思考等级。插件会根据 Pi 的模型元数据和已知 provider 格式处理思考参数；不支持的等级会降级到最近的可用等级，不支持 provider-specific 参数时不会伪造请求字段。

## 命名行为

命名模型只允许返回以下结果之一：

```text
SKIP
类型｜主题
```

- `SKIP`：仅用于自动检查，未命名 session 继续保持未命名，已有名称保持不变；手动刷新一定会产出名称。
- `类型｜主题`：插件会为其补充程序确定的 session 日期。

手动刷新无法命名时，提示会说明具体原因：对话没有内容、模型没有返回文本，或模型拒绝选择任务。

语义类型默认为：功能、设计、修复、优化、发布、探索、文档和研究（英文默认 Feature、Design、Fix 等）。模型会将选定类型表达为命名使用的语言；可以通过 `types` 配置自定义类别列表。

命名模型始终以分段形式描述任务；插件自身通过对比分段与前一次的结果来判断是否有变化：

- 无变化 → 什么都不发生（不改名、不写历史）。
- 仅进度变化 → 静默更新名称。
- 类型或主题变化 → 更新名称（首次命名和手动刷新会显示通知）。

当名称格式包含 `{progress}` 时，模型还会输出简短的进度状态（最多 16 字符），以对话末尾的最新证据为准。可选的进度段展示任务当前进展，让用户不仅能认出会话在做什么，还能想起进行到哪里了。

提示词要求模型在普通进展时保持原名称，只有主要任务发生明显变化时才更新名称。

普通 refresh 允许复用原有类型和主题；加上 `force`（或直接跟一段文字）会强制重新评估类型和主题，可以附带自己的要求（例如 `/session-name-refresh force 类型用中文`）。附加要求以最高优先级注入提示词，但不能突破输出格式和类型白名单，也不会绕过锁定。

命名上下文仅包含当前 session 文本、压缩摘要和工具名称，不发送工具参数和工具结果。插件不做额外敏感信息脱敏，请根据隐私要求选择 provider。

## 开发

安装开发依赖并执行检查：

```bash
npm install
npm test
npx tsc --noEmit
```

单元测试不会调用真实 provider，也不需要 API key。

## 许可证

MIT，详见 [LICENSE](LICENSE)。
