# 反馈驱动策略优化设计

> 2026-05-13 | Demo 用

## 目标

利用"有帮助/无帮助"反馈数据，让系统学会针对不同情绪状态优先使用哪个干预轨道。

## 核心机制

```
情绪=anxiety → 系统查历史: 呼吸稳定 4/5 (80%), 任务减压 1/3 (33%)
            → 选最优: 呼吸稳定
            → 标注来源: "基于历史数据 (80% 有效)"

情绪=sad   → 系统查历史: 数据不足 (< 3 次)
            → 回退关键词匹配: 情绪落地
            → 标注来源: "基于关键词匹配"
```

## 架构

| 组件 | 文件 | 职责 |
|---|---|---|
| track_stats 表 | server/db.js | 存储 (emotion, track, helpful_count, total_count) |
| TrackLearner | server/track-learner.js | recordFeedback(), getBestTrack(), getTrackMatrix() |
| 干预选择 | server/server.js | matchTrackByContext 加历史优先 |
| 策略面板 | public/index.html + app.js | 情绪-轨道矩阵表格 |
| 报告页 | public/report.html | 新增"最有效轨道"统计卡片 |

## API

无新增 API。现有接口行为变化：
- `POST /api/feedback` 额外调用 recordFeedback()
- `GET /api/strategy` 返回中新增 trackMatrix 字段
- `GET /api/report/:id` 返回中新增 bestTrack 字段
