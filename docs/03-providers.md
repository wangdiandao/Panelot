# 03 — Provider 体系

> 上级文档：[DESIGN.md](../DESIGN.md) · 关联：[01 架构](./01-architecture.md) · [04 Agent 引擎](./04-agent-engine.md)
> 借鉴来源：OpenWebUI 的协议优先抽象 / 模型预设 / task model（并补其 customHeaders、多 key、并发拉取三处短板）

---

## 1. 数据模型

### 1.1 Connection —— 一个 API 端点

```ts
// chrome.storage.local: 'connections'
interface Connection {
  id: string;
  name: string;                          // "OpenAI"、"公司中转"、"本地 Ollama"
  kind: 'openai' | 'anthropic';          // 线协议，唯一分叉点
  baseUrl: string;                       // 规范化存储（见 §4）
  apiKeys: string[];                     // 多 key：粘性 + 429/401 failover（见 §8）
  customHeaders?: Record<string, string>;// OpenRouter 的 HTTP-Referer、Azure 的 api-key 等
  prefixId?: string;                     // 模型显示前缀，区分多连接下的同名模型
  modelIds?: string[];                   // 手动白名单（/models 不可用时）
  enabled: boolean;                      // 停用不删除
  quirks?: QuirkFlags;                   // §5 兼容性开关
}
```

### 1.2 ModelEntry 与能力标注

```ts
interface ModelEntry {
  connectionId: string;
  id: string;                            // 请求用 model id
  displayName?: string;
  capabilities: {
    toolUse: boolean;                    // false 则该模型不可用于 Agent 模式（仅纯聊天）
    vision: boolean;                     // 决定 screenshot 工具与图片附件可用性
    reasoning?: boolean;                 // 显示思考块 / 支持 reasoning_effort
    maxContext?: number;                 // 上下文窗口大小（能力元数据）
  };
  pricing?: { input: number; output: number; cacheRead?: number };  // $/Mtok
}
```

能力标注来自 `src/providers/registry.ts` 内置前缀表或 Connection 的手动 ModelEntry JSON；未命中时保守默认 `toolUse:true, vision:false`。设置页可为自定义模型填写 capabilities 与可选 pricing。

resolver 将 ModelEntry pricing 固化进 Run 环境，usage 与 Thread 统计同事务累计 `costUsd`；未配置价格时成本为 0。

### 1.3 ModelPreset —— 命名 Agent（OpenWebUI Models Workspace 的移植）

数据类型、`chrome.storage.local` 访问层和独立 ModelPreset 管理页已经实现；支持新建、编辑、删除以及把 Plugin 只读 preset 复制为用户资产。

```ts
interface ModelPreset {
  id: string; name: string; icon?: string;
  base: { connectionId: string; modelId: string };
  systemPrompt?: string;                 // 拼装层级见 10 §6
  params?: GenParams;                    // 覆盖项，未设不发（§1.4）
  enabledToolLevels?: ('L0'|'L1'|'L2'|'mcp')[];  // 例如"纯聊天预设"关掉全部浏览器工具
  defaultApprovalPolicy?: ApprovalPolicy;
  skills?: string[];                     // 默认激活的 Skill id
}
```

resolver 读取 Thread preset，消费 `base`、`params`、`systemPrompt`、`enabledToolLevels`、`defaultApprovalPolicy`、`defaultCapabilityScope`、`skills` 与 promptVersion，并把实际解析结果固化进 Run 环境。文件夹绑定仍未实现。

### 1.4 参数体系：两层合并，未设不发

```ts
interface GenParams {
  temperature?: number; topP?: number; maxTokens?: number;
  stopSequences?: string[]; reasoningEffort?: 'low'|'medium'|'high';
}
// effective = { ...preset.params, ...thread.paramOverrides }
// 规则1：undefined 字段不出现在请求 payload（尊重后端默认，避免不适用参数报错）
// 规则2：Panelot 自有控制字段（如 UI 渲染选项）绝不混入 payload
```

### 1.5 Task Model —— 副任务路由

Presets 设置页提供全局任务模型选择器（可指向任意 connection）；标题生成优先使用它，未配置时回退主对话模型。follow-up 建议尚未接入 UI。

## 2. 适配层接口

```ts
// src/providers/types.ts
interface ProviderAdapter {
  stream(req: {
    messages: UnifiedMessage[];          // 02 章定义的内部统一格式
    system?: string;
    tools: ToolSchema[];                 // 由 AgentTool.parameters 生成的 JSON Schema
    params: GenParams;
    model: string;
    signal: AbortSignal;
  }): AsyncIterable<StreamEvent> & { final(): Promise<FinalResult> };
  listModels?(): Promise<string[]>;      // GET /models（可选实现）
  verify(): Promise<VerifyResult>;       // 连接测试
}

type StreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'tool_call_partial'; index: number; id?: string; name?: string; argsDelta: string }
  | { type: 'usage'; usage: Usage };

interface FinalResult {
  message: ContentBlock[];
  reasoning?: string;
  toolCalls: { id: string; name: string; params: unknown; parseError?: string }[];
  usage: Usage;
  stopReason: 'end' | 'tool_use' | 'max_tokens' | 'content_filter';
}
```

## 3. 两个适配器的线协议要点

### 3.1 OpenAIAdapter（`POST {baseUrl}/chat/completions`）

- SSE 分帧：按 `\n\n` 切事件，`data: [DONE]` 结束；**必须容忍**一帧内多 data 行、跨 chunk 断行（手写缓冲式解析器，状态机：`buffer → 完整行 → 完整事件`）。
- tool_calls 增量：`choices[0].delta.tool_calls[i]` 按 `index` 聚合，`function.arguments` 字符串拼接，流结束后 `JSON.parse`；解析失败 → 该 call 以参数错误回给模型自纠（04 §4）。
- usage：请求带 `stream_options: {include_usage: true}`（quirk 开关，部分中转不支持）。
- reasoning：兼容 `delta.reasoning_content`（DeepSeek 等）与 `<think>` 标签内联两种形态（quirk）。

### 3.2 AnthropicAdapter（`POST {baseUrl}/v1/messages`）

- 事件类型：`message_start / content_block_start / content_block_delta(text_delta | input_json_delta | thinking_delta) / content_block_stop / message_delta / message_stop`；按 `content_block index` 聚合。
- **Prompt caching**：system prompt 与 tools 定义打 `cache_control: {type:'ephemeral'}`——Agent 场景每 turn 多次调用，缓存收益极大；布局配合 10 §6 的分层拼装（稳定层在前）。
- 头：`x-api-key` + `anthropic-version`；扩展环境直连需 `anthropic-dangerous-direct-browser-access: true`。

## 4. URL 规范化与预置模板

规范化（存储前执行）：去尾斜杠；openai kind 缺 `/v1` 时提示补全（不强制，兼容 Azure 形态）；协议缺省补 https（localhost 允许 http）。

预置模板（一键填充 baseUrl+kind+已知 quirks，用户只填 key）：Anthropic 官方 / OpenAI 官方 / OpenRouter / DeepSeek / Moonshot / 智谱 / 阿里百炼 / Ollama 本地 / LM Studio 本地 / 自定义。

设置页点击 Verify 时动态申请该 origin 的 host permission（`chrome.permissions.request`）；仅保存表单不会申请。

## 5. Quirks 兼容表

「OpenAI 兼容」端点细节参差，用 per-connection 开关吸收，不污染适配器主逻辑：

```ts
interface QuirkFlags {
  noStreamOptions?: boolean;       // 不支持 stream_options.include_usage
  thinkTagReasoning?: boolean;     // reasoning 走 <think> 内联标签
  noParallelToolCalls?: boolean;   // 强制单工具调用
  maxTokensField?: 'max_tokens' | 'max_completion_tokens';
  noSystemRole?: boolean;          // system 需转成首条 user
}
```

预置模板自带正确 quirks；自定义连接由 Verify 探测 + 用户手动开关。

## 6. Verify 连接测试与模型拉取

- **Verify**：OpenAI 路径依次 ① `GET /models`（底层 4s 超时）② 最小 streaming chat 请求 ③ echo 工具探测；Anthropic 路径执行最小 streaming/tool 探测。产出可达性 / key / 流式 / 工具结构化结果，设置页在发请求前动态申请 endpoint host permission。
- **模型拉取**：所有 enabled 连接并发拉取，adapter `listModels()` 各自使用 4s timeout；失败连接独立返回 error。ModelSelector 只在组件首次打开时拉取并缓存到该组件实例，当前没有 1h TTL 或手动刷新按钮。

## 7. 错误归一化与重试

```ts
type ProviderError =
  | { kind: 'auth' }               // 401/403 → 换下一个 key；全失败则提示用户
  | { kind: 'rate_limit'; retryAfterMs?: number }  // 429 → 尊重 retry-after，指数退避（1s 起 ×2 上限 32s，最多 4 次）；多 key 时先 failover
  | { kind: 'overloaded' }         // 529/503 → 同 429 策略
  | { kind: 'context_too_long' }   // → 不重试，直接报错并建议用户新开会话
  | { kind: 'content_filter' } | { kind: 'network' } | { kind: 'protocol'; raw: string };
```

重试只发生在「本次 LLM 调用」层；工具执行错误不在此层（那是模型自纠的领域）。

## 8. 已定事项

- 多 key 轮换粒度：**粘性 key + 失败才切换**（非 round-robin）——对 provider 侧 prompt cache 更友好（Anthropic cache 按账号，OpenAI 按 key）。429/401 时先 failover 到下一个 key，全部失效才报错。
- Gemini 不做第三种 kind：其 OpenAI 兼容层已覆盖需求，新增线协议的维护成本不值。
