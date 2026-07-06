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
  apiKeys: string[];                     // 多 key：轮询 + 429/401 failover
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

能力标注三来源，优先级递减：用户手改 > 内置已知模型表（打包一份常见模型的静态 JSON）> 保守默认（toolUse:true, vision:false）。

### 1.3 ModelPreset —— 命名 Agent（OpenWebUI Models Workspace 的移植）

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

同一底层模型可派生「翻译官」「比价助手」「纯聊天」多个预设；新会话选 preset 而非裸模型。文件夹可绑默认 preset（02 §2.1）。

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

全局设置一个「任务模型」（可指向任意 connection 的廉价模型）：标题生成、follow-up 建议全部走它。未配置时回退主对话模型并在设置页提示。

## 2. 适配层接口

```ts
// src/providers/adapter.ts
interface ProviderAdapter {
  stream(req: {
    messages: UnifiedMessage[];          // 02 章定义的内部统一格式
    tools: ToolSchema[];                 // 由 AgentTool.parameters 生成的 JSON Schema
    params: GenParams;
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
  toolCalls: { id: string; name: string; params: unknown }[];  // 已完成 JSON 拼接与解析
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

添加自定义 baseUrl 时动态申请该 origin 的 host permission（`chrome.permissions.request`，见 DESIGN 12 章）。

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

- **Verify**：依次 ① `GET /models`（3s 超时）② 最小 chat 请求（`max_tokens:1`）③ 带一个 echo 工具的请求探测 toolUse。产出结构化结果：可达性 / key 有效性 / 流式可用 / 工具可用，错误归因到「key 无效 / 域名不可达 / 需申请 host 权限 / 协议不符」。
- **模型拉取**：所有 enabled 连接**并发**拉取，各自独立 `AbortController` + 4s 超时；失败连接单独标红，绝不阻塞模型选择器（OpenWebUI 串行等满超时的教训）。结果缓存 1h，选择器带手动刷新。

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

## 8. 开放问题

- [ ] 多 key 轮换粒度：per-request round-robin（当前设计）vs 粘性 key + 失败才切换（对 prompt cache 更友好——Anthropic cache 按账号，OpenAI 按 key）。V1 先做「粘性 + failover」。
- [ ] Gemini 原生协议是否值得第三种 kind（其 OpenAI 兼容层已够用，V1 不做）。
