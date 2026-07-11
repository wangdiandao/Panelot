# Provider 错误诊断设计

## 背景

Panelot 当前在 Provider 请求失败时会把 HTTP 响应归一化为少量 `ProviderErrorKind`。HTTP 状态码没有保存在错误对象中，上游响应体虽然进入 `raw` 字段，却没有跨消息协议传到 UI。聊天界面收到错误后又用按 kind 固定的人话文案替换实际 message。因此，模型不存在、请求参数无效、路径错误和真正的响应协议错误都可能显示为“端点协议不符”，用户无法看到真实状态码和上游说明。

本设计只改 Provider 错误诊断、传输和展示，不处理旧对话恢复或会话历史修复。

## 目标

- 在聊天错误和连接 Verify 结果中显示真实 HTTP 状态码。
- 提取并显示上游返回的错误码与错误 message。
- 根据状态码和上游内容提供更准确、可执行的修复指引。
- 保持 API Key、Authorization、自定义敏感 Header 和请求体不进入错误事件或 UI。
- 保持现有 `ProviderErrorKind` 与重试语义兼容，避免扩大本次改动范围。

## 非目标

- 不新增完整网络诊断面板或持久化请求日志。
- 不显示请求 Header、完整请求体或密钥。
- 不修复中断运行恢复、旧对话历史或 Provider 兼容性本身。
- 不保证识别所有第三方 OpenAI-compatible 端点的私有错误格式；未知格式仍提供安全的原始文本回退。

## 结构化错误模型

扩展 `ProviderError`，新增可选诊断字段：

- `status`：HTTP 状态码。
- `upstreamCode`：从上游 JSON 错误对象提取的字符串或数字错误码。
- `upstreamMessage`：从上游 JSON 提取的人类可读 message。
- `raw`：经过长度限制和控制字符清理的响应文本，保留为最后回退。
- `reason`：在现有 kind 下提供细粒度原因，例如 `model_not_found`、`endpoint_not_found`、`quota_exceeded`、`invalid_request`、`response_format`。

`kind` 继续承担稳定的顶层行为分类和重试决策；`reason` 只用于诊断和指引。这样不需要重写现有重试器，也不会把 HTTP 400 错误误标为可重试。

## HTTP 归因

共享 HTTP 层先安全解析常见错误格式：

- `{ "error": { "message", "code", "type" } }`
- `{ "message", "code" }`
- `{ "detail" }`
- 非 JSON 文本回退

分类顺序从具体到一般：

1. 401：认证失败。
2. 403：认证或账户权限问题，保留上游 message 辅助区分。
3. 402 或包含余额、额度、quota/balance/credit 语义：配额不足。
4. 404：端点路径不存在；提示检查 Base URL、`/v1` 与 API 风格。
5. 429：限流，保留 `Retry-After`。
6. 503、529 以及其他明确过载响应：服务过载。
7. 400/413/422 中包含上下文或 token 长度语义：上下文超长。
8. 包含 model not found/unknown model 语义：模型 ID 不存在或已下线。
9. 其他 400/409/422：请求参数无效。
10. 其他 5xx：上游服务错误。
11. HTTP 成功但响应体、SSE 或事件结构无法解析：真正的响应协议错误。

分类匹配采用状态码与有限关键词组合，不依赖特定供应商名称。未知情况仍显示状态码和安全响应详情，不猜测唯一原因。

## 数据流

1. OpenAI/Anthropic adapter 收到非 2xx 响应。
2. `normalizeHttpError` 提取诊断字段并创建 `ProviderError`。
3. Agent loop 发出 `error` 事件时携带结构化 Provider 诊断信息。
4. `engineClient` 原样保存该诊断信息，不再只保留 kind 和通用 message。
5. `ThreadView` 渲染简短结论、状态码、上游错误码/message 和操作指引。
6. Verify 将相同结构化信息放进 `VerifyResult`，设置页展示同一套诊断内容。

消息协议中的诊断字段均为可选，以兼容扩展页面与 Service Worker 短暂版本不一致的重载窗口。

## UI 展示

聊天错误条分两层：

- 主行：本地化的人话结论，例如“模型不存在”或“请求参数无效”。
- 详情行：`HTTP 400 · model_not_found · Model Not Exist`，可换行并以纯文本显示。

操作指引按 reason 映射：

- `model_not_found`：重新选择端点当前返回的模型。
- `endpoint_not_found`：检查 Base URL、版本路径和 API 风格。
- `quota_exceeded`：检查余额、额度或账户权限。
- `invalid_request`：检查模型能力、参数、工具调用历史；同时展示上游 message。
- `response_format`：端点返回内容不符合所选 API 风格。

认证与配置类错误显示“打开设置”；可重试错误保留“重试”。详情始终由 React 文本节点渲染，不解释 HTML。

Verify 结果复用同样的摘要和详情格式，并继续显示可达、Key、流式、工具调用和模型发现结果。

## 安全边界

- 不把请求 Header、请求体或 URL 查询参数加入错误诊断。
- 上游响应文本清除不可见控制字符并限制为 2,000 个字符。
- JSON 只提取已知错误字段；原始回退也只来自响应 body。
- UI 不使用 HTML 注入或 Markdown 渲染错误详情。
- 测试使用假 Key 和合成响应，不记录真实凭据。

## 测试策略

按 TDD 分层覆盖：

1. HTTP 单元测试：状态码、常见 JSON 格式、文本回退、长度限制与 reason 分类。
2. Adapter/Verify 测试：结构化诊断从非 2xx 响应进入 `VerifyResult`。
3. Agent loop 与协议测试：Provider 诊断字段进入 `error` 事件且保持可选兼容。
4. UI 测试：展示状态码、上游 message 和对应指引；不把敏感请求信息加入页面。
5. 回归测试：认证、限流、过载、上下文超长的现有 kind 与重试行为不变。

完成后运行相关 Vitest、完整 `pnpm test`、`pnpm compile`，并检查新增注释与临时文件符合仓库代码卫生规则。
