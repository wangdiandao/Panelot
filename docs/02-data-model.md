# 02 — 数据模型与存储

> 文档索引：[README.md](../README.md) · 关联：[01 架构](./01-architecture.md) · [04 Agent 引擎](./04-agent-engine.md)
> 借鉴来源：OpenWebUI 消息树（及其双份存储的反面教训）、Pi Agent 会话树、Codex rollout（SessionMeta 头 + 重放式恢复）

---

## 1. 设计决策

1. **会话是一棵树，且只存树**。节点 `{id, parentId}`，编辑重发/重新生成/分叉全部表达为「追加兄弟节点 + 移动游标」。不维护任何平行的扁平消息数组（OpenWebUI 因双份存储产生孤儿节点与渲染死锁，引以为戒）。
2. **Append-only**。流式 delta 不建节点；Provider stream 完成后一次写入 assistant 终稿。节点写入后不修改，墓碑删除只更新 `deleted` 标记（见 §3.3）。恢复 = 回放，不是快照反序列化。
3. **给 LLM 的历史是派生视图**：`buildSessionContext(leafId)` 从叶子回溯到根产出线性消息序列。

## 2. Dexie Schema

```ts
// src/db/schema.ts
import Dexie, { Table } from 'dexie';

class PanelotDB extends Dexie {
  threads!: Table<ThreadMeta, string>;
  nodes!: Table<ThreadNode, string>;
  attachments!: Table<Attachment, string>;
  skills!: Table<SkillRecord, string>; // 见 08
  memories!: Table<MemoryRecord, string>; // memory_write 工具
  runs!: Table<RunRecord, string>;
  commandReceipts!: Table<CommandReceipt, string>;
  approvals!: Table<ApprovalRecord, string>;
  plugins!: Table<PluginRecord, string>;
  pluginAssets!: Table<PluginAssetRecord, string>;

  constructor() {
    super('panelot_v1');
    this.version(1).stores({
      threads: 'id, updatedAt, folderId, archived, pinned',
      nodes: 'id, threadId, [threadId+seq], parentId',
      attachments: 'id, threadId, createdAt',
      skills: 'id, name, enabled, sourceRef',
      memories: 'id, key, updatedAt',
      runs: 'id, threadId, [threadId+state], submissionId, updatedAt',
      commandReceipts: 'id, [clientId+submissionId], status, createdAt, expiresAt',
      approvals: 'id, threadId, runId, [threadId+status], requestedAt',
      plugins: 'id, name, enabled, updatedAt',
      pluginAssets: 'id, pluginId, [pluginId+path], kind, createdAt',
    });
  }
}
```

> Provider 配置、权限规则、UI 偏好走 `chrome.storage.local`（体量小、需跨上下文同步事件），不入 Dexie。见 03/06。

### 2.1 threads —— 轻量索引表

UI 会话列表只读这张表，永不扫 nodes：

```ts
interface ThreadMeta {
  id: string; // UUID
  title: string; // task model 自动生成，可手改
  createdAt: number;
  updatedAt: number;
  leafId: string | null; // 当前活跃分支的叶子节点 —— 树的游标
  folderId?: string; // 文件夹归组
  tags: string[];
  pinned: boolean;
  archived: boolean;
  preset?: string; // 默认 ModelPreset id
  parentThreadId?: string; // fork 来源（预留子代理）
  stats: { turns: number; totalTokens: number; costUsd: number };
  scopeOrigins: string[]; // 已触达/批准过的 origin；用于敏感 payload 的第三方出域判断与审计（见 06）
}
```

### 2.2 nodes —— 会话树节点（核心表）

```ts
interface ThreadNode {
  id: string; // UUID
  threadId: string;
  parentId: string | null; // 根节点为 null
  seq: number; // thread 内单调递增，恢复回放的排序键
  ts: number;
  type: NodeType;
  payload: NodePayload; // 按 type 判别
}

type NodeType =
  | 'user_message' // { content: ContentBlock[], attachedContext?: ContextBlock[] }
  | 'assistant_message' // { content: ContentBlock[], model: string, connectionId: string,
  //   reasoning?: string, usage?: Usage }
  | 'tool_call' // { itemId, toolName, params, level: 'L0'|'L1'|'L2'|'mcp'|'builtin' }
  | 'tool_result' // { itemId, ok, contentForLlm: ContentBlock[], details?: unknown }
  | 'approval_decision' // { approvalId, request: ApprovalRequestPayload, decision, ts }
  | 'turn_context' // { turnId, model, permissionPolicy, activeSkills[] }
  //   —— 每轮开头一条，恢复时复原环境
  | 'system_notice'; // 用户可见但不进 LLM 历史的提示（如"已自动暂停"）
```

要点：

- `childrenIds` **不存储**，由 `parentId` 索引反查派生（避免双向引用失同步——这是 OpenWebUI 教训的直接应用）。
- `tool_call` / `tool_result` 分开两个节点：审批可能间隔任意长时间，且 result 的 `details`（截图等大对象）指向 attachments 表而非内联。
- **不落库的东西**：`item.delta` 流式增量、L1 快照的 selector_map（内存态，见 05）。

### 2.3 attachments

```ts
interface Attachment {
  id: string;
  threadId: string;
  createdAt: number;
  kind: 'image' | 'file' | 'page_snapshot' | 'screenshot' | 'page_text';
  mime: string;
  bytes: Blob;
  trust?: 'trusted' | 'untrusted';
  provenance?: 'user' | 'page' | 'mcp' | 'tool' | 'import' | 'plugin';
  sourceRef?: string;
  refs?: { nodeIds?: string[]; runIds?: string[]; pluginId?: string };
  deleting?: boolean;
  meta?: { url?: string; title?: string; w?: number; h?: number };
}
```

截图/快照单独设配额（默认 200MB），超限按 `createdAt` LRU 清理并在对应节点标记 `evicted`。

## 3. 树操作规范

### 3.1 追加（正常对话）

```
appendNode(threadId, parentId = thread.leafId, node)
→ 写 node（seq = max(seq)+1）
→ thread.leafId = node.id; thread.updatedAt = now
```

### 3.2 编辑重发 / 重新生成（分叉）

- 编辑用户消息：以**被编辑消息的 parentId** 为父，追加新 `user_message` 兄弟节点，`leafId` 移到新节点 → 新分支从此生长。
- 重新生成回答：以 assistant 消息的 parentId（即那条 user 消息）为父追加新分支。
- UI 的 `< n/m >` 分支切换器：`siblings = nodes.where(parentId)`，按 seq 排序；切换 = `leafId` 移到目标兄弟的**最深默认后代**（每层取 seq 最大的子节点下钻）。

### 3.3 删除消息

采用 OpenWebUI 的 grandchildren 重链，但受 append-only 约束改为**墓碑标记**：节点加 `payload.deleted = true`，`buildSessionContext` 跳过墓碑并把其子节点视为直连祖父。物理删除仅发生在「删除整个 Thread」与配额清理。

### 3.4 完整性校验

写入前校验：`parentId` 必须存在于同 thread（或为 null 根）；加载时校验 `leafId` 可回溯到根，失败则回退到 seq 最大的可达叶子并记 `system_notice`。**任何情况下渲染层不因坏数据死循环**——回溯步数上限 = 节点总数。

## 4. buildSessionContext —— LLM 上下文派生

```ts
async function buildSessionContext(
  tree: ThreadTree,
  threadId: string,
  leafId: string,
): Promise<SessionContext> {
  // 1. 从 leaf 沿 parentId 回溯到根，reverse 得到线性节点序列（跳过墓碑与 system_notice）
  // 2. 输出 provider-neutral messages + 最新 turn_context + 完整可见 path
  // 3. system prompt 由 src/prompts/assemble.ts 另行拼装，不在本函数返回值中
}
```

`buildSessionContext` 服务 LLM 请求组装，从当前 `leafId` 派生统一消息序列。UI snapshot 和会话导出复用同一棵 `parentId` 树及相同的回溯约束，但分别生成适合 UI/Markdown 的载荷，不共享这一函数的返回类型。

`runTurn` 在进入 `preparing` 前把规范化输入与 `RunEnvironmentSnapshot` 同事务写入。快照带格式版本和 SHA-256 完整性摘要，固化实际 connection/model/参数、完整 system prompt、Skill 目录与正文、Provider-facing tool schemas、工具执行绑定、审批策略、能力域、浏览器提交上下文和价格/能力元数据。Provider 与 MCP 秘密不进入快照，只记录 credential reference；恢复要求当前非秘密 transport 与引用形状仍完全一致，只允许同一引用的密文值轮换。已开始但没有快照的旧 Run、摘要不匹配、执行绑定漂移或超过结构/体积上限均 fail closed，不重新解析可变设置。

## 5. 存储配额与清理

- 设置页通过 `navigator.storage.estimate()` 展示用量；总量超 80% 时只在“数据”设置页提示，侧边栏当前没有配额告警。
- 附件总量超过 200MB 后按 `createdAt` 删除最旧附件并跳过活跃 Thread；删除事务先把引用节点标记为 `evicted`，再物理删除附件。启动时清理遗留的半删除记录。
- “归档 N 天后删除 nodes、保留 ThreadMeta/Markdown 摘要”与删除前 `deleting` 两阶段流程尚未接入设置页或定时任务，属于目标策略。

## 6. 已定事项

- nodes 表不加 `[threadId+parentId]` 复合索引：siblings 查询走单列 `parentId` 索引后内存过滤，兄弟分支数量级是个位数，复合索引没有可测收益。
- 附件存 IndexedDB Blob，不用 OPFS：大截图场景的性能差距抵不过 API 兼容成本。
