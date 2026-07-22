# Providers

> Related: [Architecture](./architecture.md), [Agent engine](./agent-engine.md), and [Prompts](./prompts.md).

## 1. Data model

### 1.1 Connection

A `Connection` represents one API endpoint. It has an ID, name, `openai` or `anthropic` wire kind, normalized base URL, one or more API keys, optional custom headers and display prefix, optional manual model IDs, enabled state, and compatibility flags.

Multiple keys are sticky. Panelot keeps the current usable key and fails over after authentication or rate-limit errors instead of rotating every request.

### 1.2 Model entries

A `ModelEntry` identifies a model within one connection and records tool-use, vision, optional reasoning, and optional context-window capabilities. Pricing can describe input, output, and cache-read dollars per million tokens.

Metadata comes from the built-in prefix registry or user JSON. Unknown models use the compatibility fallback of tool use enabled and vision disabled. A model explicitly marked with `toolUse:false` receives no tool schemas, and its Run snapshot has an empty tool catalog. `vision:false` rejects image history before a request. `reasoning:false` removes `reasoningEffort` from preset and Thread parameters. Pricing is fixed in the Run environment before usage and Thread cost are updated in one transaction.

### 1.3 Model presets

A preset combines a connection and model, optional system prompt, generation parameters, enabled tool levels, default permission policy, and default Skills. The resolver reads the Thread preset and stores the resolved values and prompt version in the Run environment. Folder binding is not implemented.

### 1.4 Parameters

`GenParams` supports temperature, top-p, maximum tokens, stop sequences, and reasoning effort. Thread overrides replace preset values. Undefined fields are omitted from the provider payload, and Panelot-only UI options never enter it.

### 1.5 Task model

The global task model can use any connection. Title generation prefers it and falls back to the conversation model. Follow-up suggestions are not connected to the UI.

## 2. Adapter interface

`ProviderAdapter.stream()` accepts unified messages, optional system text, tool schemas, parameters, model ID, and an AbortSignal. It yields text, reasoning, partial tool calls, and usage, then returns a final message, tool calls, usage, and stop reason. Optional `listModels()` supports discovery. Settings uses a separate `verifyConnection(adapter, connection)` workflow so diagnostics do not become part of the MV3 Service Worker runtime.

`Usage.input` is the total input count, including cache reads and writes. `cacheRead` and `cacheWrite` are subsets of that total. OpenAI-compatible responses use `prompt_tokens` and retain available detail fields. Anthropic responses add `input_tokens`, `cache_read_input_tokens`, and `cache_creation_input_tokens`. Cost calculation removes the cache-read subset before applying its configured price, so cached tokens are not charged twice as ordinary input.

A stream succeeds only after its protocol terminates completely. OpenAI requires a supported `finish_reason` and `[DONE]`. Anthropic requires `message_delta.stop_reason` and `message_stop`. A clean EOF after content is still incomplete. Unknown stop reasons fail closed.

## 3. Wire protocols

### 3.1 OpenAI-compatible

Panelot posts to `{baseUrl}/chat/completions`, parses SSE across chunk and line boundaries, groups partial `tool_calls` by index, and parses accumulated argument JSON at completion. Invalid arguments return a tool error to the model for correction.

Usage normally uses `stream_options.include_usage`. Cached prompt tokens and any reported cache-write tokens are retained as breakdowns of total input. Compatibility flags can disable usage, read reasoning from `<think>` tags or `reasoning_content`, force one tool call, omit the system role, or choose the maximum-token field. Native `reasoning_content` is persisted with assistant history and returned unchanged on follow-up requests after tool calls. The `thinkTagReasoning` mode does not send that native field.

### 3.2 Anthropic

Panelot posts to `{baseUrl}/v1/messages` and groups message, content-block, text, JSON input, thinking, signature, redacted thinking, and stop events by block index. Complete thinking blocks are stored as provider state and replayed with the assistant message after a tool result. Reasoning effort uses adaptive thinking and `output_config.effort` by default. A compatibility flag enables the legacy fixed thinking budget while reserving output space for the final answer. The single-tool flag sends Anthropic's `disable_parallel_tool_use` option. The last Tool and the stable kernel prefix use explicit ephemeral cache markers. Top-level automatic caching advances through message history. Cache creation and reads are retained in usage. Requests use `x-api-key`, `anthropic-version`, and the direct-browser access header required by Anthropic.

`model_context_window_exceeded` maps to an incomplete `max_tokens` stop. `pause_turn` requires a server-tool continuation loop that Panelot does not implement, so it is a protocol error.

## 4. URL and templates

Stored URLs omit a trailing slash. Settings suggests `/v1` for OpenAI-compatible services without forcing it and allows HTTP only for loopback hosts. Templates cover official Anthropic and OpenAI, OpenRouter, DeepSeek, Moonshot, Zhipu, Alibaba Bailian, local Ollama, local LM Studio, and custom endpoints.

Selecting Verify requests optional host access for the endpoint. Saving a form alone does not.

## 5. Compatibility flags

Per-connection flags isolate endpoint differences: no streaming usage option, reasoning in `<think>`, no parallel tool calls, Anthropic's legacy fixed thinking budget, an alternate maximum-token field, and no system role. Templates set known flags, while a custom connection uses verification and user configuration.

## 6. Verification and model listing

Verification performs model discovery with a shared four-second timeout and key failover, a minimal streaming request, and a complete echo tool round trip. The last step sends the assistant tool call and tool result back before accepting tool use as compatible. A probe model can come from manual IDs, manually described models, or endpoint discovery. Model-list data must be JSON with a `data` array of non-empty string IDs before it reaches settings.

Enabled connections list models concurrently with independent failures. The chat selector loads when first opened, while the settings default-model selector loads immediately. Component instances cache results. There is no one-hour TTL or manual refresh button.

## 7. Errors and retry

Errors normalize to authentication, rate limit, overloaded, context too long, content filter, network, or protocol categories. Rate-limit, overload, and network failures can retry. Authentication, context, content-filter errors, protocol failures, and unknown categories do not retry automatically.

Rate limiting respects numeric or HTTP-date `retry-after`, uses jittered exponential backoff from one second to 32 seconds, and tries configured keys before failing. Retries apply to one model call, not tool execution. Timers and abort listeners are removed on every terminal path.

Diagnostics preserve provider request IDs but not API keys or complete response bodies.

## 8. Current constraints

Key selection is sticky and changes only after failure. Streaming and model discovery share one retry boundary. Adapters own URLs, headers, and response protocols, while shared code owns failure semantics. Gemini uses its OpenAI-compatible layer instead of a third wire kind.
