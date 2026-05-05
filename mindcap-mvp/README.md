# MindCap MVP 样板

前后端样板，用于先打通：

- EEG 结果输入
- DeepSeek 情绪对话编排
- LangChain 记忆驱动干预建议（短期+长期）
- 记忆与画像展示
- 策略/奖励配置面板
- 安全告警可视化面板（指标卡+趋势图+触发原因）
- 评估与导出占位
- NLUX 聊天框架界面

## 运行

```powershell
cd D:\MindCap\mindcap-mvp
npm start
```

浏览器打开：

`http://127.0.0.1:5050`

## DeepSeek 接入

后端默认读取本地环境变量 `DEEPSEEK_API_KEY` 来调用真实 DeepSeek API。

可选环境变量：

- `DEEPSEEK_MODEL`（默认：`deepseek-v4-flash`）
- `DEEPSEEK_BASE_URL`（默认：`https://api.deepseek.com`）
- `DEEPSEEK_TIMEOUT_MS`（默认：`25000`）

未设置 `DEEPSEEK_API_KEY` 时，会自动回退到本地样板回复。

## 聊天 UI 框架

- 前端聊天组件使用 `@nlux/core`（Vanilla JS）
- 主题样式使用 `@nlux/themes`（Nova）
- 本地静态资源目录：`public/vendor/nlux-core.js`、`public/vendor/nlux-nova.css`

## LangChain 记忆

- 使用 `@langchain/classic` 记忆接口：
- `BufferWindowMemory`：保留近几轮短期会话记忆
- `VectorStoreRetrieverMemory` + `MemoryVectorStore`：保留并检索长期记忆
- `CombinedMemory`：将短期/长期记忆合并后注入对话上下文与干预建议

## 结构

- `server/server.js`：后端 API + SSE 实时流 + 静态资源服务
- `public/index.html`：8 个页面面板
- `public/app.js`：前端逻辑与接口调用
- `public/styles.css`：样式

## 核心接口（样板）

- `POST /api/session/start`
- `POST /api/session/end`
- `POST /api/eeg/push`
- `POST /api/chat/send`
- `POST /api/feedback`
- `GET /api/session/:id/state`
- `GET /api/session/:id/stream`（SSE）
- `GET /api/dashboard`
- `GET /api/sessions`
- `GET /api/user/:id/profile`
- `GET/PUT /api/strategy`
- `GET/PUT /api/safety`
- `GET /api/evaluation`
- `POST /api/export`

## 说明

- 已支持真实 DeepSeek 调用；仅在调用失败或未配置 key 时回退本地样板回复。
- 当前数据库为内存存储，重启后清空；后续可替换 MySQL/PostgreSQL。
