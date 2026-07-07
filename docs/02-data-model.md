# 02 — 数据模型与存储

> 上级文档：[DESIGN.md](../DESIGN.md) · 关联：[01 架构](./01-architecture.md) · [04 Agent 引擎](./04-agent-engine.md)
> 借鉴来源：OpenWebUI 消息树（及其双份存储的反面教训）、Pi Agent 会话树、Codex rollout（SessionMeta 头 + 重放式恢复）

---

## 1. 设计决策

1. **会话是一棵树，且只存树**。节点 `{id, parentId}`，编辑重发/重新生成/分叉全部表达为「追加兄弟节点 + 移动游标」。不维护任何平行的扁平消息数组（OpenWebUI 因双份存储产生孤儿节点与渲染死锁，引以为戒）。
2. **Append-only**。节点一经写入不修改（唯一例外：流式中的 assistant 节点在 `item.complete` 时写入终稿；删除操作见 §5.3）。恢复 = 回放，不是快照反序列化。
3. **给 LLM 的历史是派生视图**：`buildSessionContext(leafId)` 从叶子回溯到根产出线性消息序列。

## 2. Dexie Schema

```ts
// src/db/schema.ts
import Dexie, { Table } from 'dexie';

class PanelotDB extends Dexie {
  threads!: Table<ThreadMeta, string>;
  nodes!: Table<ThreadNode, string>;
  attachments!: Table<Attachment, string>;
  skills!: Table<SkillRecord, string>;       // 见 08
  memories!: Table<MemoryRecord, string>;    // memory_write 工具

  constructor() {
    super('panelot');
    this.version(1).stores({
      threads:     'id, updatedAt, folderId, archived, pinned',
      nodes:       'id, threadId, [threadId+seq], parentId',
      attachments: 'id, threadId, createdAt',
      skills:      'id, name, enabled',
      memories:    'id, key, updatedAt',
    });
  }
}
```

> Provider 配置、权限规则、UI 偏好走 `chrome.storage.local`（体量小、需跨上下文同步事件），不入 Dexie。见 03/06。

### 2.1 threads —— 轻量索引表

UI 会话列表只读这张表，永不扫 nodes：

```ts
interface ThreadMeta {
  id: string;                 // UUID
  title: string;              // task model 自动生成，可手改
  createdAt: number; updatedAt: number;
  leafId: string | null;      // 当前活跃分支的叶子节点 —— 树的游标
  folderId?: string;          // 文件夹（V1.5：文件夹可绑默认 preset/system prompt）
  tags: string[];
  pinned: boolean; archived: boolean;
  preset?: string;            // 默认 ModelPreset id
  parentThreadId?: string;    // fork 来源（预留子代理）
  stats: { turns: number; totalTokens: number; costUsd: number };
  scopeOrigins: string[];     // 本任务触达过的域名集合（跨域检测用，见 06）
}
```

### 2.2 nodes —— 会话树节点（核心表）

```ts
interface ThreadNode {
  id: string;                 // UUID
  threadId: string;
  parentId: string | null;    // 根节点为 null
  seq: number;                // thread 内单调递增，恢复回放的排序键
  ts: number;
  type: NodeType;
  payload: NodePayload;       // 按 type 判别
}

type NodeType =
  | 'user_message'       // { content: ContentBlock[], attachedContext?: ContextBlock[] }
  | 'assistant_message'  // { content: ContentBlock[], model: string, connectionId: string,
                         //   reasoning?: string, usage?: Usage }
  | 'tool_call'          // { itemId, toolName, params, level: 'L0'|'L1'|'L2'|'mcp'|'builtin' }
  | 'tool_result'        // { itemId, ok, contentForLlm: ContentBlock[], details?: unknown }
  | 'approval_decision'  // { approvalId, request: ApprovalRequestPayload, decision, ts }
  | 'turn_context'       // { turnId, model, approvalPolicy, capabilityScope, activeSkills[] }
                         //   —— 每轮开头一条，恢复时复原环境
  | 'system_notice';     // 用户可见但不进 LLM 历史的提示（如"已自动暂停"）
```

要点：

- `childrenIds` **不存储**，由 `parentId` 索引反查派生（避免双向引用失同步——这是 OpenWebUI 教训的直接应用）。
- `tool_call` / `tool_result` 分开两个节点：审批可能间隔任意长时间，且 result 的 `details`（截图等大对象）指向 attachments 表而非内联。
- **不落库的东西**：`item.delta` 流式增量、L1 快照的 selector_map（内存态，见 05）。

### 2.3 attachments

```ts
interface Attachment {
  id: string; threadId: string; createdAt: number;
  kind: 'image' | 'file' | 'page_snapshot' | 'screenshot';
  mime: string; bytes: Blob;
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

## 5. buildSessionContext —— 恢复与渲染的同一算法

```ts
function buildSessionContext(leafId: string): UnifiedMessage[] {
  // 1. 从 leaf 沿 parentId 回溯到根，reverse 得到线性节点序列（跳过墓碑与 system_notice）
  // 2. 输出 = [ systemPrompt 层（由最后一个 turn_context 复原）,
  //             序列节点转换为 UnifiedMessage ]
  // 3. tool_result 的大体积 contentForLlm 按 05 §7 的截断规则二次裁剪
}
```

同一函数服务三个消费者：LLM 请求组装（引擎）、`ThreadSnapshot`（UI 重连）、会话导出。**三方永不各写一套遍历逻辑。**

## 6. 存储配额与清理

- `navigator.storage.estimate()` 监控；总量超 80% 时设置页与侧边栏出提示。
- 会话保留策略（可配）：归档 N 天后物理删除 nodes 但保留 ThreadMeta + 导出的 Markdown 摘要。
- 一切物理删除前，threads 表先行标记 `deleting`，防半删状态被回放。

## 7. 已定事项

- nodes 表不加 `[threadId+parentId]` 复合索引：siblings 查询走单列 `parentId` 索引后内存过滤，兄弟分支数量级是个位数，复合索引没有可测收益。
- 附件存 IndexedDB Blob，不用 OPFS：大截图场景的性能差距抵不过 API 兼容成本；若未来成为瓶颈属 V2 议题。
