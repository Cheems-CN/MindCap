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

### 1. 数据持久化
- **SQLite 数据库**：12 张表，自动建表 + 种子数据
- **数据类别**：用户画像、会话记录、EEG 事件、对话轮次、反馈、安全日志、策略配置、导出记录
- **特性**：WAL 模式、外键约束、自动索引
- **文件**：`server/db.js`

### 2. EEG 文件导入
- **支持格式**：频段格式（channel -> delta/theta/alpha/beta/gamma）和原始信号格式（时间点 x 通道）
- **情绪映射**：规则引擎（alpha/beta 比率 -> calm/stress，额叶不对称 -> sad，全局 beta -> anxiety）
- **前端面板**：拖拽上传 + CSV 预览 + 一键导入
- **API**：`POST /api/eeg/import`、`GET /api/eeg/imports`、`GET /api/eeg/import/:id`
- **文件**：`server/eeg-parser.js`

### 3. LangChain 向量记忆持久化
- **短期记忆**：BufferWindowMemory（最近 6 轮对话）
- **长期记忆**：VectorStoreRetrieverMemory + MemoryVectorStore + SQLite 持久化
- **特性**：重启后对话历史保留，跨会话记忆积累
- **文件**：`server/memory-store.js`

### 4. LLM 心理对话
- **提供商**：DeepSeek（支持 deepseek-v4-flash）
- **回退机制**：未配置 API Key 时使用本地 mock 回复
- **对话 UI**：NLUX 气泡式界面 + Markdown 渲染
- **系统提示**：心理学专家角色设定 + 结构化回复模板

### 5. 干预策略引擎
- **5 条干预轨道**：呼吸稳定、任务减压、睡眠修复、社交安定、情绪落地
- **关键词匹配**：根据用户输入 + 历史画像自动匹配最合适的轨道
- **步骤推进**：每条轨道 3 步渐进式引导，按对话轮次推进
- **记忆锚点**：优先沿用历史有效策略

### 6. 安全风控
- **高风险检测**：4 条内置规则（自杀/轻生表达）+ 自定义关键词
- **安全话术替换**：高风险/中风险分级话术模板
- **告警系统**：SSE 实时推送 + 安全中心面板（指标卡 + 24h 趋势 + 高频原因）
- **升级流程**：命中 -> 安全模板 -> 人工求助入口 -> 告警记录

### 7. 用户画像
- **基础信息**：姓名、年龄、性别、标签
- **心理画像**：触发因素、偏好干预方式、规避话题、已验证有效策略
- **记忆时间线**：画像变更记录 + 会话记忆更新

### 8. Web UI
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
| GET | `/api/eeg/imports?sessionId=` | 查询会话的 EEG 导入记录 |
| GET | `/api/eeg/import/:id` | 查询 EEG 导入详情 |
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

共 19 个 API 接口。

## 数据库表清单

| 表名 | 用途 |
|---|---|
| `users` | 用户画像（基础信息 + JSON 心理档案） |
| `sessions` | 会话记录（状态、情绪、干预轨道） |
| `eeg_events` | EEG 情绪事件（手动/导入） |
| `eeg_imports` | EEG 文件导入批次 |
| `eeg_channels` | 导入的通道/频段详细数据 |
| `chat_turns` | 对话轮次记录 |
| `feedback` | 用户反馈（有帮助/无帮助 + 情绪变化） |
| `safety_logs` | 安全告警日志 |
| `strategy_config` | 策略配置（权重、动作空间、训练设置） |
| `safety_config` | 安全配置（规则、关键词、话术模板） |
| `export_records` | 导出记录 |
| `memory_vectors` | LangChain 长期记忆向量（128 维 embedding） |
