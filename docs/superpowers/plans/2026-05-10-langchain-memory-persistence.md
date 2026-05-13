# LangChain Vector Memory Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make LangChain long-term vector memory survive server restarts by backing MemoryVectorStore with SQLite, so user conversation history and preferences accumulate across sessions.

**Architecture:** New `memory_vectors` SQLite table stores (user_id, input_text, output_text, embedding_vector). On user's first interaction, load all existing vectors from SQLite into MemoryVectorStore. On each `saveContext`, persist the new entry to SQLite alongside the in-memory operation. No changes to the LangChain API — the MemoryVectorStore remains the active store; SQLite acts as a durable mirror.

**Tech Stack:** better-sqlite3 (existing), LangChain MemoryVectorStore (existing), DeterministicEmbeddings (existing 128-dim)

---

## File Map

| Action | File | Responsibility |
|---|---|---|
| Modify | `server/db.js` | Add `memory_vectors` table + CRUD |
| New | `server/memory-store.js` | Wrapper: load from SQLite into MemoryVectorStore, persist on save |
| Modify | `server/server.js` | Replace direct MemoryVectorStore usage with wrapper |
| New | `docs/PROGRESS.md` | Project progress document |

---

### Task 1: Add memory_vectors table and queries to db.js

**Files:**
- Modify: `mindcap-mvp/server/db.js`

- [ ] **Step 1: Add table to schema block**

In `db.js`, after the `eeg_channels` CREATE TABLE statement, add:

```js
  CREATE TABLE IF NOT EXISTS memory_vectors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id),
    input_text TEXT NOT NULL,
    output_text TEXT NOT NULL,
    embedding TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_memory_vectors_user ON memory_vectors(user_id);
```

- [ ] **Step 2: Add query functions before module.exports**

Before the `// ── Export` comment, add:

```js
// ── Memory vectors ─────────────────────────────────────────────────

function saveMemoryVector(userId, inputText, outputText, embedding) {
  db.prepare(`
    INSERT INTO memory_vectors (user_id, input_text, output_text, embedding)
    VALUES (?, ?, ?, ?)
  `).run(userId, inputText, outputText, JSON.stringify(embedding));
}

function loadMemoryVectors(userId) {
  const rows = db.prepare(`
    SELECT id, user_id, input_text, output_text, embedding
    FROM memory_vectors WHERE user_id = ? ORDER BY id
  `).all(userId);
  return rows.map(r => ({
    id: r.id,
    userId: r.user_id,
    inputText: r.input_text,
    outputText: r.output_text,
    embedding: JSON.parse(r.embedding)
  }));
}

function clearMemoryVectors(userId) {
  db.prepare("DELETE FROM memory_vectors WHERE user_id = ?").run(userId);
}
```

- [ ] **Step 3: Add exports**

Add to module.exports block:

```js
  saveMemoryVector,
  loadMemoryVectors,
  clearMemoryVectors
```

- [ ] **Step 4: Verify table creation**

```bash
cd mindcap-mvp && node -e "
const db = require('./server/db');
const tables = db.db.prepare(\"SELECT name FROM sqlite_master WHERE type='table'\").all();
console.log('Has memory_vectors:', tables.some(t => t.name === 'memory_vectors'));
"
```

Expected: `Has memory_vectors: true`

- [ ] **Step 5: Commit**

```bash
git add mindcap-mvp/server/db.js
git commit -m "feat(db): add memory_vectors table for LangChain persistence"
```

---

### Task 2: Create SQLite-backed memory store wrapper

**Files:**
- Create: `mindcap-mvp/server/memory-store.js`

- [ ] **Step 1: Create the wrapper module**

```js
// mindcap-mvp/server/memory-store.js
const { MemoryVectorStore } = require("@langchain/classic/vectorstores/memory");
const db = require("./db");

/**
 * Load all saved vectors from SQLite into a MemoryVectorStore.
 * Returns the populated store, ready for VectorStoreRetrieverMemory.
 */
async function createPopulatedVectorStore(userId, embeddings) {
  const vectorStore = new MemoryVectorStore(embeddings);

  const rows = db.loadMemoryVectors(userId);
  if (rows.length === 0) return vectorStore;

  // Build documents and vectors arrays for batch add
  const vectors = [];
  const documents = [];
  for (const row of rows) {
    vectors.push(row.embedding);
    documents.push({ pageContent: row.inputText, metadata: { outputText: row.outputText, userId } });
  }

  // Use internal addVectors to populate (avoid re-computing embeddings)
  await vectorStore.addVectors(vectors, documents);
  return vectorStore;
}

/**
 * Persist a saveContext call to SQLite.
 * Must be called after vectorStore.addVectors().
 */
async function persistContext(userId, inputText, outputText, embeddings) {
  if (!embeddings) return;

  // Compute embedding for the input text
  const embedding = await embeddings.embedQuery(inputText);
  db.saveMemoryVector(userId, inputText, outputText, embedding);
}

module.exports = { createPopulatedVectorStore, persistContext };
```

- [ ] **Step 2: Verify module loads**

```bash
cd mindcap-mvp && node -e "
const { createPopulatedVectorStore } = require('./server/memory-store');
console.log('Module loaded OK');
"
```

Expected: `Module loaded OK`

- [ ] **Step 3: Commit**

```bash
git add mindcap-mvp/server/memory-store.js
git commit -m "feat: add SQLite-backed memory store wrapper for LangChain"
```

---

### Task 3: Update server.js to use persistent memory

**Files:**
- Modify: `mindcap-mvp/server/server.js` (lines 63-130, the LangChain Memory section)

- [ ] **Step 1: Add require for memory-store**

After `const db = require("./db");`, add:

```js
const { createPopulatedVectorStore, persistContext } = require("./memory-store");
```

- [ ] **Step 2: Replace createLangChainMemoryRuntime**

Replace the existing `createLangChainMemoryRuntime` function (lines 79-102) with:

```js
async function createLangChainMemoryRuntime(user) {
  const embeddings = new DeterministicEmbeddings();

  // Create vector store populated from SQLite (survives restart)
  const vectorStore = await createPopulatedVectorStore(user.id, embeddings);

  const longMemory = new VectorStoreRetrieverMemory({
    vectorStoreRetriever: vectorStore.asRetriever(4),
    memoryKey: "long_term_memory",
    inputKey: "input",
    returnDocs: false,
    metadata: { userId: user.id }
  });
  const shortMemory = new BufferWindowMemory({
    memoryKey: "recent_memory",
    inputKey: "input",
    outputKey: "output",
    returnMessages: false,
    k: 6
  });
  const combinedMemory = new CombinedMemory({
    memories: [shortMemory, longMemory],
    inputKey: "input",
    outputKey: "output"
  });
  return { vectorStore, longMemory, shortMemory, combinedMemory, seeded: false, embeddings };
}
```

- [ ] **Step 3: Update persistLangChainMemory**

Replace the existing `persistLangChainMemory` function with:

```js
async function persistLangChainMemory(runtime, userText, assistantText) {
  if (!runtime) return;

  // Save to in-memory LangChain store
  await runtime.combinedMemory.saveContext(
    { input: userText },
    { output: assistantText }
  );

  // Also persist to SQLite so it survives restart
  await persistContext(
    runtime.longMemory.metadata?.userId || "unknown",
    userText,
    assistantText,
    runtime.embeddings
  );
}
```

- [ ] **Step 4: Update ensureLangChainMemoryRuntime to handle async creation**

Replace `ensureLangChainMemoryRuntime` with:

```js
async function ensureLangChainMemoryRuntime(user) {
  if (!user) return null;
  let runtime = langchainMemoryRegistry.get(user.id);
  if (!runtime) {
    runtime = await createLangChainMemoryRuntime(user);
    langchainMemoryRegistry.set(user.id, runtime);
  }
  if (!runtime.seeded) {
    const seeds = buildProfileSeedRecords(user);
    for (const seed of seeds) {
      await runtime.longMemory.saveContext(
        { input: seed },
        { output: `画像归档:${seed}` }
      );
    }
    runtime.seeded = true;
  }
  return runtime;
}
```

- [ ] **Step 5: Update persistLangChainMemory caller**

In the chat endpoint, find the line `await persistLangChainMemory(reply.runtime, userText, reply.text);` and replace with:

```js
    await persistLangChainMemory(reply.runtime, userText, reply.text);
```

(No change needed if the signature of `persistLangChainMemory` is already correct — verify the call site passes `reply.runtime` which has the `embeddings` field.)

Actually, let me check: the current code returns `{ ... mockReply, llmSource, memoryContext, runtime }`. The `runtime` object comes from `createLangChainMemoryRuntime` which now returns `{ vectorStore, longMemory, shortMemory, combinedMemory, seeded, embeddings }`. So `reply.runtime.embeddings` will be available.

But wait — in `buildAssistantReply`, the `runtime` is returned via the result. Let me verify the call site passes it correctly. Looking at the chat handler:

```js
const reply = await buildAssistantReply({ ... });
// later:
await persistLangChainMemory(reply.runtime, userText, reply.text);
```

And `persistLangChainMemory` now uses `runtime.embeddings` and `runtime.longMemory.metadata`. Both are on the runtime object returned by `createLangChainMemoryRuntime`. Good.

- [ ] **Step 6: Verify server starts**

```bash
cd mindcap-mvp && timeout 4 node server/server.js 2>&1 || true
```

Expected: `MindCap MVP server running at http://127.0.0.1:5050` with no errors.

- [ ] **Step 7: Commit**

```bash
git add mindcap-mvp/server/server.js
git commit -m "feat: wire SQLite-backed LangChain memory into server"
```

---

### Task 4: Integration test — verify memory survives restart

- [ ] **Step 1: Run the persistence cycle test**

```bash
cd mindcap-mvp

# First run: create a session, chat, persist memory
node server/server.js &
sleep 2

SESSION=$(curl -s -X POST http://127.0.0.1:5050/api/session/start -H "Content-Type: application/json" -d '{"userId":"u001"}')
SID=$(echo "$SESSION" | grep -o '"sessionId":"[^"]*"' | head -1 | cut -d'"' -f4)

# Send a distinctive chat message that should be remembered
curl -s -X POST http://127.0.0.1:5050/api/chat/send -H "Content-Type: application/json" \
  -d "{\"sessionId\":\"$SID\",\"message\":\"我下周三有一个重要的论文答辩\"}" > /dev/null

curl -s -X POST http://127.0.0.1:5050/api/session/end -H "Content-Type: application/json" \
  -d "{\"sessionId\":\"$SID\"}" > /dev/null

kill %1 2>/dev/null
sleep 1

# Verify memory was saved to SQLite
node -e "
const db = require('./server/db');
const rows = db.loadMemoryVectors('u001');
console.log('Memory rows for u001:', rows.length);
const hasPaperDefense = rows.some(r => r.inputText.includes('论文答辩'));
console.log('Has paper defense memory:', hasPaperDefense);
"

# Second run: verify memory loads back
node server/server.js &
sleep 2

SESSION2=$(curl -s -X POST http://127.0.0.1:5050/api/session/start -H "Content-Type: application/json" -d '{"userId":"u001"}')
SID2=$(echo "$SESSION2" | grep -o '"sessionId":"[^"]*"' | head -1 | cut -d'"' -f4)

# Send a follow-up that references the remembered context
REPLY=$(curl -s -X POST http://127.0.0.1:5050/api/chat/send -H "Content-Type: application/json" \
  -d "{\"sessionId\":\"$SID2\",\"message\":\"我上次提到的那个答辩，有什么建议吗？\"}")
echo "Reply (first 300 chars):" $(echo "$REPLY" | head -c 300)

curl -s -X POST http://127.0.0.1:5050/api/session/end -H "Content-Type: application/json" \
  -d "{\"sessionId\":\"$SID2\"}" > /dev/null

kill %1 2>/dev/null
```

Expected:
- First run: `Memory rows for u001: >= 1` and `Has paper defense memory: true`
- Second run: Reply references "答辩" context from LangChain long-term memory

- [ ] **Step 2: Commit any fixes if needed**

```bash
git add -A && git status
```

---

### Task 5: Write project progress document

**Files:**
- Create: `docs/PROGRESS.md`

- [ ] **Step 1: Create the progress document**

```markdown
# MindCap 项目进度文档

> 最后更新：2026-05-10

## 项目概述

**MindCap（心灵捕手）** 是一个基于脑电信号（EEG）的情绪识别与智能心理干预平台。核心目标是将 EEG 神经信号与 LLM 心理对话结合，提供个性化、数据驱动的心理健康支持。

## 技术栈

| 层 | 技术 |
|---|---|
| 后端 | Node.js 原生 HTTP Server |
| LLM | DeepSeek API (`deepseek-v4-flash`) |
| 向量记忆 | LangChain (MemoryVectorStore + SQLite 持久化) |
| 聊天 UI | NLUX (@nlux/core + Nova 主题) |
| 数据库 | SQLite (better-sqlite3, WAL 模式) |
| EEG 解析 | csv-parse (频段格式 + 原始信号格式) |
| 实时通信 | SSE (Server-Sent Events) |
| 前端 | 原生 HTML/CSS/JS (SPA 8 页面面板) |

## 已完成功能

### 1. 数据持久化 ✅
- **SQLite 数据库**：12 张表，自动建表 + 种子数据
- **数据类别**：用户画像、会话记录、EEG 事件、对话轮次、反馈、安全日志、策略配置、导出记录
- **特性**：WAL 模式、外键约束、自动索引

### 2. EEG 文件导入 ✅
- **支持格式**：频段格式（channel → delta/theta/alpha/beta/gamma）和原始信号格式（时间点 × 通道）
- **情绪映射**：规则引擎（α/β 比率 → calm/stress，额叶不对称 → sad，全局 β → anxiety）
- **前端面板**：拖拽上传 + CSV 预览 + 一键导入
- **API**：`POST /api/eeg/import`、`GET /api/eeg/imports`、`GET /api/eeg/import/:id`

### 3. LangChain 向量记忆持久化 ✅
- **短期记忆**：BufferWindowMemory（最近 6 轮对话）
- **长期记忆**：VectorStoreRetrieverMemory + MemoryVectorStore + SQLite 持久化
- **特性**：重启后对话历史保留，跨会话记忆积累

### 4. LLM 心理对话 ✅
- **提供商**：DeepSeek（支持 deepseek-v4-flash）
- **回退机制**：未配置 API Key 时使用本地 mock 回复
- **对话 UI**：NLUX 气泡式界面 + Markdown 渲染
- **系统提示**：心理学专家角色设定 + 结构化回复模板

### 5. 干预策略引擎 ✅
- **5 条干预轨道**：呼吸稳定、任务减压、睡眠修复、社交安定、情绪落地
- **关键词匹配**：根据用户输入 + 历史画像自动匹配最合适的轨道
- **步骤推进**：每条轨道 3 步渐进式引导，按对话轮次推进
- **记忆锚点**：优先沿用历史有效策略

### 6. 安全风控 ✅
- **高风险检测**：4 条内置规则（自杀/轻生表达） + 自定义关键词
- **安全话术替换**：高风险/中风险分级话术模板
- **告警系统**：SSE 实时推送 + 安全中心面板（指标卡 + 24h 趋势 + 高频原因）
- **升级流程**：命中 → 安全模板 → 人工求助入口 → 告警记录

### 7. 用户画像 ✅
- **基础信息**：姓名、年龄、性别、标签
- **心理画像**：触发因素、偏好干预方式、规避话题、已验证有效策略
- **记忆时间线**：画像变更记录 + 会话记忆更新

### 8. Web UI ✅
- **8 个页面面板**：登录/总览/实时会话/历史回放/画像与记忆/策略配置/安全中心/评估导出
- **响应式布局**：桌面端 2-4 列网格，移动端自适应单列
- **实时更新**：SSE 驱动的 EEG 情绪卡、安全告警实时推送

## 未完成功能

| 功能 | 优先级 | 说明 |
|---|---|---|
| 真实 EEG 设备接入 | 高 | 当前支持 CSV 导入，需对接 Muse/Emotiv/OpenBCI 等设备 |
| 反馈驱动策略优化 | 高 | "有帮助/无帮助"反馈已收集但未用于策略更新 |
| EEG 情绪识别模型 | 中 | 当前使用规则映射，可替换为 EEGNet 等深度学习模型 |
| 评估指标真实化 | 低 | 模型指标当前为硬编码假数据 |
| 导出功能 | 低 | 论文图表/软著材料导出为队列占位 |
| 用户认证 | 低 | 无登录/权限管理 |
| 自动化测试 | 低 | 无测试覆盖 |

## API 接口清单

| 方法 | 路径 | 功能 |
|---|---|---|
| GET | `/api/health` | 健康检查 |
| GET | `/api/users` | 获取用户列表 |
| POST | `/api/session/start` | 开始会话 |
| POST | `/api/session/end` | 结束会话 |
| POST | `/api/eeg/push` | 推送 EEG 事件（手动模拟） |
| POST | `/api/eeg/import` | 导入 EEG CSV 文件 |
| GET | `/api/eeg/imports?sessionId=` | 查询会话的导入记录 |
| GET | `/api/eeg/import/:id` | 查询导入详情 |
| POST | `/api/chat/send` | 发送对话消息 |
| POST | `/api/feedback` | 提交对话反馈 |
| GET | `/api/session/:id/state` | 获取会话状态 |
| GET | `/api/session/:id/stream` | SSE 实时流 |
| GET | `/api/sessions` | 获取所有会话列表 |
| GET | `/api/user/:id/profile` | 获取用户画像 |
| GET/PUT | `/api/strategy` | 策略配置 |
| GET/PUT | `/api/safety` | 安全配置 |
| GET | `/api/evaluation` | 评估指标 |
| POST | `/api/export` | 导出 |

## 数据库表清单

| 表名 | 用途 |
|---|---|
| `users` | 用户画像 |
| `sessions` | 会话记录 |
| `eeg_events` | EEG 情绪事件 |
| `eeg_imports` | EEG 文件导入批次 |
| `eeg_channels` | 导入的通道/频段数据 |
| `chat_turns` | 对话轮次 |
| `feedback` | 用户反馈 |
| `safety_logs` | 安全告警日志 |
| `strategy_config` | 策略配置 |
| `safety_config` | 安全配置 |
| `export_records` | 导出记录 |
| `memory_vectors` | LangChain 长期记忆向量 |
```

- [ ] **Step 2: Commit**

```bash
git add docs/PROGRESS.md
git commit -m "docs: add project progress document covering all features and remaining work"
```

---

### Task 6: Final verification and push

- [ ] **Step 1: Full restart persistence test**

```bash
cd mindcap-mvp

# Start, chat, stop
node server/server.js &
sleep 2
SID=$(curl -s -X POST http://127.0.0.1:5050/api/session/start -H "Content-Type: application/json" -d '{"userId":"u001"}' | grep -o '"sessionId":"[^"]*"' | head -1 | cut -d'"' -f4)
curl -s -X POST http://127.0.0.1:5050/api/chat/send -H "Content-Type: application/json" -d "{\"sessionId\":\"$SID\",\"message\":\"我最近总是失眠，这已经持续两周了\"}" > /dev/null
curl -s -X POST http://127.0.0.1:5050/api/session/end -H "Content-Type: application/json" -d "{\"sessionId\":\"$SID\"}" > /dev/null
kill %1 2>/dev/null; sleep 1

# Check persistence
node -e "
const db = require('./server/db');
const rows = db.loadMemoryVectors('u001');
console.log('Total memories:', rows.length);
const hasInsomnia = rows.some(r => r.inputText.includes('失眠'));
console.log('Memory persisted after restart:', hasInsomnia ? 'YES' : 'NO');
"

# Restart and verify
node server/server.js &
sleep 2
SID2=$(curl -s -X POST http://127.0.0.1:5050/api/session/start -H "Content-Type: application/json" -d '{"userId":"u001"}' | grep -o '"sessionId":"[^"]*"' | head -1 | cut -d'"' -f4)
REPLY=$(curl -s -X POST http://127.0.0.1:5050/api/chat/send -H "Content-Type: application/json" -d "{\"sessionId\":\"$SID2\",\"message\":\"我还是睡不着，上次提到的方法效果不太好\"}")
# Verify the reply references sleep track
echo "Reply mentions sleep:" $(echo "$REPLY" | grep -c '睡')
curl -s -X POST http://127.0.0.1:5050/api/session/end -H "Content-Type: application/json" -d "{\"sessionId\":\"$SID2\"}" > /dev/null
kill %1 2>/dev/null
```

Expected: `Memory persisted after restart: YES`, reply references sleep-related interventions.

- [ ] **Step 2: Push all commits**

```bash
git push origin main
```
