# 会话评估报告页设计

> 2026-05-13 | Demo 演示用

## 目标

为 MindCap 创建一个独立的会话评估报告页面，Demo 时通过浏览器直接展示完整的数据闭环。

## 架构

```
GET /report?sessionId=sess_xxx
         │
         ├─► 返回独立 HTML 页面（public/report.html）
         │
         └─► 页面内 fetch GET /api/report/:sessionId
              │
              ├─► 情绪趋势（eeg_events 时序）
              ├─► 对话轮次 + 反馈统计
              ├─► 对话摘要（chat_turns）
              ├─► EEG 通道数据（如果有 eeg_imports）
              └─► Chart.js 渲染折线图
```

## 涉及文件

| 文件 | 操作 | 说明 |
|---|---|---|
| `public/report.html` | 新建 | 独立报告页面（含 JS + CSS） |
| `server/server.js` | 修改 | 新增 `GET /api/report/:id` + 静态路由 `/report` |

## 页面布局

```
┌────────────────────────────────────────────┐
│  MindCap 会话评估报告          [打印报告]  │
│  受试者: 受试者A | 会话: 2026-05-13 14:30 │
├────────────────────────────────────────────┤
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐     │
│  │ 轮次 │ │ 反馈 │ │有帮助│ │情绪  │     │
│  │  12  │ │  10  │ │ 70%  │ │+0.35 │     │
│  └──────┘ └──────┘ └──────┘ └──────┘     │
├────────────────────────────────────────────┤
│            情绪趋势图 (Chart.js 折线)       │
├────────────────────────────────────────────┤
│  对话时间线          EEG 频谱热力图         │
└────────────────────────────────────────────┘
```

## API: GET /api/report/:sessionId

返回数据聚合：

```json
{
  "session": { "id", "startedAt", "endedAt", "userName" },
  "stats": {
    "turns": 12,
    "feedbackCount": 10,
    "helpfulRate": 0.70,
    "avgMoodDelta": 0.35
  },
  "emotionTimeline": [
    { "time": "...", "label": "stress", "confidence": 0.82 }
  ],
  "chatTurns": [
    { "time": "...", "userText": "...", "assistantText": "...", "safetyLevel": "normal" }
  ],
  "eegChannels": {
    "importId": "...",
    "channels": [
      { "channelName": "AF3", "alpha": 1.2, "beta": 0.6, "delta": 0.5, "theta": 0.8 }
    ]
  }
}
```

## 技术选型

- **Chart.js v4 CDN** — 轻量，零构建，折线图
- **CSS print media** — `window.print()` 一键打印
- **无依赖** — 单 HTML 文件自包含

## 情绪趋势图

- X 轴：时间（HH:MM 格式）
- Y 轴：情绪映射为数值（calm=2, neutral=1, stress=0, sad=-1, anxiety=-2）
- 折线颜色按情绪分段
- 标注点：置信度 > 0.8 的点加粗

## EEG 频谱热力图

- 行 = 通道名
- 列 = 频段（delta, theta, alpha, beta, gamma）
- 颜色深度 = 功率值
- 纯 div + inline style 实现

## 不做的事情

- 不做 PDF 生成
- 不做交互式图表
- 不做文件导出下载（打印即可）
- 不修改现有 8 面板 UI
