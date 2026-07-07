# 04 — Agent 核心引擎

> 上级文档：[DESIGN.md](../DESIGN.md) · 关联：[01 架构](./01-architecture.md) · [02 数据模型](./02-data-model.md) · [06 权限](./06-permissions.md) · [10 提示词](./10-prompts.md)
> 借鉴来源：Pi Agent 的极简 loop / AgentTool 双通道；Codex 的 steering-queueing-interrupt 三通路与 turnKind

---

## 1. 设计哲学

**Pi 的极简内核 + Codex 的安全外壳。** loop 本身保持最小——循环到模型不再调工具为止；复杂度全部推到外层（Gatekeeper、能力域、UI）。不加没有用例的旋钮：

- ~~maxSteps 硬中断~~ → 改为**软提醒**：单 turn 工具调用达 25 次时向 UI 发 `system_notice` + 在下一次 LLM 调用注入一条提醒（"已执行 25 步，确认方向是否正确"），不打断任务；
- **token 预算是唯一硬闸**（可选配置）：超预算 `turn.complete{stopReason:'budget_pause'}`，用户点继续再跑。

## 2. Agent Loop

```ts
// src/agent/loop.ts —— 伪代码，目标 <300 行
async function runTurn(thread: Thread, input: UserInput, overrides?: TurnOverrides) {
  appendNode(turn_context);                         // 复原环境的锚点
  appendNode(user_message);
  emit('turn.start');

  while (true) {
    const messages = buildSessionContext(thread.leafId);   // 02 §5

    const stream = provider.stream(messages, tools, signal);   // 03 章适配层
    for await (const ev of stream) emitDelta(ev);              // 文本/推理增量转 item.delta
    const { message, toolCalls, usage } = await stream.final();

    appendNode(assistant_message); emit('item.complete'); emit('token.usage');
    consumeSteerQueue();                              // §3：插话在此注入

    if (toolCalls.length === 0) break;                // ← 唯一的退出条件

    for (const call of toolCalls) {
      const verdict = await gatekeeper.check(call, thread);      // 06 章
      if (verdict === 'ask') await requestApproval(call);        // 双向 RPC，挂起等待
      appendNode(tool_call);
      try {
        const result = await tool.execute(call.id, call.params, signal, onUpdate);
        appendNode(tool_result{ ok:true, contentForLlm: result.content, details: result.details });
      } catch (e) {
        appendNode(tool_result{ ok:false, contentForLlm: [text(errorFor(e))] });  // 让模型自纠
      }
    }
  }
  emit('turn.complete', stopReason);
  scheduleTaskModelJobs(thread);                      // 标题生成 / follow-up（轻量模型，不阻塞）
}
```

行为规范：

- **错误靠 throw**：工具失败抛异常，引擎捕获后以 `isError` 语义回填给模型，loop 继续——模型自己重试或换路（元素找不到→重新快照，是 05 章工具的标准自纠路径）。
- **中断（interrupt）**：abort `signal` → 当前 fetch 与工具执行终止（L2 工具安全 detach）→ 已落库节点保留 → `turn.complete{stopReason:'interrupted'}`。
- **结束的定义**：`turn.complete` 在所有落库写入 ack 之后才发出（Pi 的 "await 所有订阅者" 语义）——防 SW 在持久化前被挂起。

## 3. Steering / Queueing / Interrupt 三通路

| 通路 | Op | 语义 | 约束 |
|---|---|---|---|
| **插话 steer** | `turn.steer{expectedTurnId}` | 注入**当前轮**：追加一条 user_message，在当前 LLM 调用结束后、下一次调用前生效 | `expectedTurnId` 不匹配报错；`steerable:false` 的轮（title）拒绝并建议排队 |
| **排队 enqueue** | `turn.enqueue` | 当前轮跑完后作为**下一轮**执行 | 队列有界（8 条），UI 显示 `queue.updated` |
| **打断 interrupt** | `turn.interrupt` | 立即停止当前轮 | 总是允许 |

UI 交互映射（见 09）：Agent 运行中输入框可继续打字，`Enter` = steer（不可插话时自动降级为 enqueue 并提示），`Shift+Alt+Enter` = 显式排队，`Esc` = interrupt。

## 4. AgentTool 接口

```ts
// src/agent/tool.ts —— 所有工具（浏览器/MCP/内置）的统一形态
interface AgentTool<P = unknown, D = unknown> {
  name: string;                  // 'browser_click'
  label: string;                 // UI 显示："点击元素"
  description: string;           // 给 LLM（文案见 10 §3）
  parameters: z.ZodType<P>;      // zod schema → 同时生成 JSON Schema 发给 LLM
  level: 'L0' | 'L1' | 'L2' | 'mcp' | 'builtin';
  effects: 'read' | 'write';     // Gatekeeper 默认裁决的依据（06）
  execute(
    toolCallId: string,
    params: P,
    signal: AbortSignal,
    onUpdate?: (partial: { progressText: string; details?: D }) => void,
  ): Promise<ToolResult<D>>;
}

interface ToolResult<D> {
  content: ContentBlock[];   // 给 LLM：精简文本/图片，计入上下文
  details?: D;               // 给 UI：截图、快照 diff、高亮坐标——不进 LLM，经 item.complete 下发
}
```

- **content/details 双通道是硬规范**：任何工具不得把 UI 富信息塞进 content（污染上下文），也不得把 LLM 需要的关键结论只放 details。
- 参数校验：LLM 给的原始参数先过 zod；失败不 throw 给用户，而是把校验错误作为 tool_result 回给模型自纠。
- `onUpdate`：长工具（等待页面加载、滚动抓取）推进度 → `item.delta{toolProgress}`。

## 5. 恢复语义

恢复（SW 重启 / 重开会话）永远走 `buildSessionContext(leafId)` 重放：从 leaf 到根的线性历史，**与当时喂给模型的历史逐字一致**。

## 6. 关键时序图

### 6.1 一轮 turn（含审批与工具）

```mermaid
sequenceDiagram
  participant UI
  participant EN as 引擎(SW)
  participant GK as Gatekeeper
  participant CS as Content Script
  participant LLM

  UI->>EN: Op turn.submit{input}
  EN->>EN: 落库 turn_context + user_message
  EN-->>UI: turn.start / item.start(assistant)
  EN->>LLM: stream(messages, tools)
  LLM-->>EN: text delta… + tool_call(browser_click)
  EN-->>UI: item.delta… item.complete(assistant)
  EN->>GK: check(browser_click, thread)
  GK-->>EN: 'ask'
  EN-->>UI: approval.request{完整参数}
  UI->>EN: approval.response{acceptForSite}
  EN->>EN: 落库 approval_decision + 更新站点规则
  EN-->>UI: item.start(tool_call)
  EN->>CS: execute click(ref)
  CS-->>EN: ToolResult{content, details:高亮坐标}
  EN->>EN: 落库 tool_call + tool_result
  EN-->>UI: item.complete{details}
  EN->>LLM: 下一轮调用（含 tool_result）
  LLM-->>EN: 纯文本（无工具调用）
  EN-->>UI: item.* / token.usage / turn.complete{done}
```

### 6.2 SW 休眠恢复

```mermaid
sequenceDiagram
  participant UI
  participant SW2 as 新 SW 实例
  participant DB

  Note over UI: Port onDisconnect（旧 SW 被杀）
  UI->>SW2: reconnect + initialize{subscribe}
  SW2->>DB: 读 ThreadMeta + buildSessionContext(leafId)
  SW2-->>UI: initialized{snapshot（含未完成 turn 标记）}
  UI->>UI: 全量渲染 + 显示「任务被中断，[继续]」
  UI->>SW2: turn.enqueue("继续刚才的任务")
  Note over SW2: 历史含全部 tool_result checkpoint，模型自然续接
```

## 7. Transport 抽象

```ts
interface EngineTransport {
  send(op: Op): void;
  onEvent(cb: (ev: AgentEvent) => void): () => void;
}
// 实现1：PortTransport（生产，chrome.runtime Port）
// 实现2：DirectTransport（单测/Node 集成测试，直连引擎实例，不依赖 chrome API）
```

引擎与 UI 组件对 transport 无感——这使 Agent loop 可在 Vitest 里用 mock provider + DirectTransport 完整回归，不开浏览器。

## 8. 已定事项

- steer 注入点固定在「LLM 调用间隙」，不做工具执行间隙注入：工具执行通常在秒级完成，中途注入的收益小，而中断/恢复工具执行的复杂度高。等不及的场景用 `interrupt`。
- 不做子代理（spawn_subagent）：单 loop + 好快照的收益先于多 Agent 编排；Thread 的 `parentThreadId` 字段由 fork 使用。
