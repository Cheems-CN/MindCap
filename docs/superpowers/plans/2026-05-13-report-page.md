# 会话评估报告页 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a standalone report page at `/report?sessionId=xxx` showing emotion trend chart, intervention stats, conversation timeline, and EEG heatmap for Demo presentation.

**Architecture:** A single new `public/report.html` page (zero dependency besides Chart.js CDN) fetches aggregated data from a new `GET /api/report/:sessionId` endpoint. The existing static file server already maps `/report` → `public/report.html` automatically — no routing change needed.

**Tech Stack:** Chart.js v4 CDN, vanilla HTML/CSS/JS, existing better-sqlite3 + db.js query functions

---

## File Map

| Action | File | Responsibility |
|---|---|---|
| Modify | `server/server.js` | Add `GET /api/report/:id` endpoint |
| Create | `public/report.html` | Standalone report page with 4 sections |

---

### Task 1: Add report API endpoint

**Files:**
- Modify: `mindcap-mvp/server/server.js`

- [ ] **Step 1: Add GET /api/report/:id handler**

In `server.js`, inside `handleApi()`, before the final `return false;`, add:

```js
  // GET /api/report/:id
  if (req.method === "GET" && pathname.startsWith("/api/report/")) {
    const sessionId = pathname.split("/")[3];
    if (!sessionId) { sendJson(res, 400, { error: "Missing session ID" }); return true; }

    const session = db.getSession(sessionId);
    if (!session) { sendJson(res, 404, { error: "Session not found" }); return true; }

    const user = db.getUser(session.userId);

    // Stats
    const turns = session.chatTurns.length;
    const feedbackList = session.feedback || [];
    const feedbackCount = feedbackList.length;
    const helpfulCount = feedbackList.filter(f => f.helpful).length;
    const helpfulRate = feedbackCount > 0 ? helpfulCount / feedbackCount : 0;
    const moodDeltas = feedbackList.map(f => f.moodDelta).filter(n => !Number.isNaN(n));
    const avgMoodDelta = moodDeltas.length > 0
      ? moodDeltas.reduce((a, b) => a + b, 0) / moodDeltas.length
      : 0;

    // Emotion timeline
    const emotionTimeline = (session.emotionTrend || []).map(e => ({
      time: e.time,
      label: e.label,
      confidence: e.confidence
    }));

    // Chat turns (truncated)
    const chatTurns = turns.map(t => ({
      time: t.time,
      userText: t.userText ? t.userText.substring(0, 120) : "",
      assistantText: t.assistantText ? t.assistantText.substring(0, 200) : "",
      safetyLevel: t.safetyLevel || "normal",
      llmSource: t.llmSource || "unknown",
      suggestions: (t.suggestions || []).slice(0, 2)
    }));

    // EEG channels from imports
    const imports = db.getEEGImports(sessionId);
    let eegChannels = null;
    if (imports.length > 0) {
      const lastImport = imports[0];
      const channels = db.getEEGImportChannels(lastImport.id);
      const channelMap = {};
      for (const ch of channels) {
        if (!channelMap[ch.channel_name]) {
          channelMap[ch.channel_name] = { channelName: ch.channel_name };
        }
        if (ch.band) channelMap[ch.channel_name][ch.band] = ch.value;
      }
      eegChannels = {
        importId: lastImport.id,
        filename: lastImport.filename,
        formatType: lastImport.format_type,
        channels: Object.values(channelMap)
      };
    }

    sendJson(res, 200, {
      session: {
        id: session.id,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        status: session.status,
        userName: user ? user.name : "未知用户",
        userId: session.userId
      },
      stats: {
        turns,
        feedbackCount,
        helpfulRate: Number(helpfulRate.toFixed(2)),
        avgMoodDelta: Number(avgMoodDelta.toFixed(2))
      },
      emotionTimeline,
      chatTurns,
      eegChannels
    });
    return true;
  }
```

- [ ] **Step 2: Verify endpoint works**

```bash
cd mindcap-mvp && node server/server.js &
sleep 2

# Start a session, add data, then query report
SID=$(curl -s -X POST http://127.0.0.1:5050/api/session/start -H "Content-Type: application/json" -d '{"userId":"u001"}' | grep -o '"sessionId":"[^"]*"' | head -1 | cut -d'"' -f4)

# Push EEG
curl -s -X POST http://127.0.0.1:5050/api/eeg/push -H "Content-Type: application/json" -d "{\"sessionId\":\"$SID\",\"label\":\"anxiety\",\"confidence\":0.82}" > /dev/null

# Send chat
curl -s -X POST http://127.0.0.1:5050/api/chat/send -H "Content-Type: application/json" -d "{\"sessionId\":\"$SID\",\"message\":\"最近压力很大\"}" > /dev/null

# Get report
REPORT=$(curl -s http://127.0.0.1:5050/api/report/$SID)
echo "Stats:" $(echo $REPORT | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'turns={d[\"stats\"][\"turns\"]}, feedback={d[\"stats\"][\"feedbackCount\"]}')" 2>/dev/null || echo "Check raw output above")
echo "Emotion points:" $(echo $REPORT | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d['emotionTimeline']))" 2>/dev/null)

kill %1 2>/dev/null
```

Expected: `turns=1, feedback=0` and `Emotion points: 1` (the push + import from chat don't generate eeg_events through this path; actually just 1 from the push).

- [ ] **Step 3: Commit**

```bash
git add mindcap-mvp/server/server.js
git commit -m "feat: add GET /api/report/:id endpoint for session report aggregation"
```

---

### Task 2: Create report HTML page

**Files:**
- Create: `mindcap-mvp/public/report.html`

- [ ] **Step 1: Create the complete report page**

```html
<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>MindCap 会话评估报告</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"></script>
<style>
  :root { --bg: #f4f6f9; --card: #fff; --ink: #1c2733; --muted: #5f6f81; --accent: #0d9488; --line: #dde5ef; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--ink); font-family: "PingFang SC","Microsoft YaHei",sans-serif; padding: 20px; }
  .report { max-width: 1100px; margin: 0 auto; }
  .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 18px; }
  .header h1 { font-size: 24px; }
  .header .meta { color: var(--muted); font-size: 14px; }
  .print-btn { padding: 8px 18px; border: 1px solid var(--accent); border-radius: 8px; background: #fff; color: var(--accent); cursor: pointer; font-size: 14px; }
  .print-btn:hover { background: var(--accent); color: #fff; }
  .stats-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 18px; }
  .stat-card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 16px; text-align: center; }
  .stat-card .num { font-size: 32px; font-weight: 700; color: var(--accent); }
  .stat-card .label { font-size: 13px; color: var(--muted); margin-top: 4px; }
  .section { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 18px; margin-bottom: 16px; }
  .section h2 { font-size: 18px; margin-bottom: 12px; }
  .chart-wrap { height: 300px; position: relative; }
  .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .timeline-item { display: flex; gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--line); font-size: 13px; }
  .timeline-item .time { color: var(--muted); min-width: 48px; }
  .timeline-item .role { font-weight: 600; min-width: 40px; }
  .timeline-item .role.user { color: #1e3a8a; }
  .timeline-item .role.assistant { color: #166534; }
  .timeline-item .text { flex: 1; line-height: 1.5; }
  .heatmap { display: grid; gap: 4px; }
  .heatmap-header { display: grid; grid-template-columns: 80px repeat(5, 1fr); gap: 4px; font-size: 12px; color: var(--muted); margin-bottom: 4px; }
  .heatmap-header span { text-align: center; }
  .heatmap-row { display: grid; grid-template-columns: 80px repeat(5, 1fr); gap: 4px; margin-bottom: 2px; }
  .heatmap-row .ch-label { font-size: 13px; font-weight: 600; color: var(--ink); align-self: center; }
  .heatmap-cell { border-radius: 6px; padding: 8px 4px; text-align: center; font-size: 11px; color: #fff; min-height: 36px; display: flex; align-items: center; justify-content: center; }
  .empty-state { text-align: center; padding: 40px; color: var(--muted); }
  .empty-state p { margin: 8px 0; }
  .safety-high { color: #dc2626; font-weight: 600; }
  .loading { text-align: center; padding: 60px; color: var(--muted); font-size: 16px; }
  .error { text-align: center; padding: 60px; color: #dc2626; }

  @media print {
    body { background: #fff; padding: 0; }
    .print-btn { display: none; }
    .section { break-inside: avoid; box-shadow: none; }
  }

  @media (max-width: 768px) {
    .stats-grid { grid-template-columns: repeat(2, 1fr); }
    .two-col { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>
<div class="report" id="report-root">
  <div class="loading">正在加载报告数据...</div>
</div>

<script>
const params = new URLSearchParams(window.location.search);
const sessionId = params.get("sessionId");

if (!sessionId) {
  document.getElementById("report-root").innerHTML = '<div class="error"><h2>缺少参数</h2><p>请通过 <code>?sessionId=xxx</code> 指定会话 ID</p></div>';
} else {
  loadReport(sessionId);
}

async function loadReport(sessionId) {
  try {
    const resp = await fetch("/api/report/" + sessionId);
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || "Request failed: " + resp.status);
    }
    const data = await resp.json();
    render(data);
  } catch (err) {
    document.getElementById("report-root").innerHTML = '<div class="error"><h2>加载失败</h2><p>' + err.message + '</p></div>';
  }
}

function formatTime(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "-";
  return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function formatDate(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "-";
  return d.toLocaleDateString("zh-CN") + " " + d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function emotionToValue(label) {
  const map = { calm: 2, neutral: 1, stress: 0, sad: -1, anxiety: -2 };
  return map[label] !== undefined ? map[label] : 1;
}

function emotionColor(label) {
  const map = { calm: "#15803d", neutral: "#5f6f81", stress: "#dc2626", sad: "#6366f1", anxiety: "#f59e0b" };
  return map[label] || "#5f6f81";
}

function render(data) {
  const d = data;
  const root = document.getElementById("report-root");

  root.innerHTML = `
    <div class="header">
      <div>
        <h1>MindCap 会话评估报告</h1>
        <div class="meta">
          受试者: ${d.session.userName} (${d.session.userId}) |
          会话: ${d.session.id.substring(0, 16)}... |
          ${formatDate(d.session.startedAt)} |
          状态: ${d.session.status}
        </div>
      </div>
      <button class="print-btn" onclick="window.print()">打印报告</button>
    </div>

    <div class="stats-grid">
      <div class="stat-card"><div class="num">${d.stats.turns}</div><div class="label">对话轮次</div></div>
      <div class="stat-card"><div class="num">${d.stats.feedbackCount}</div><div class="label">反馈次数</div></div>
      <div class="stat-card"><div class="num">${(d.stats.helpfulRate * 100).toFixed(0)}%</div><div class="label">有帮助率</div></div>
      <div class="stat-card"><div class="num">${d.stats.avgMoodDelta >= 0 ? "+" : ""}${d.stats.avgMoodDelta.toFixed(2)}</div><div class="label">平均情绪改善</div></div>
    </div>

    <div class="section">
      <h2>情绪趋势</h2>
      <div class="chart-wrap"><canvas id="emotion-chart"></canvas></div>
    </div>

    <div class="two-col">
      <div class="section">
        <h2>对话时间线</h2>
        <div id="timeline-container"></div>
      </div>
      <div class="section">
        <h2>EEG 频谱分析</h2>
        <div id="heatmap-container"></div>
      </div>
    </div>
  `;

  renderEmotionChart(d.emotionTimeline);
  renderTimeline(d.chatTurns);
  renderHeatmap(d.eegChannels);
}

function renderEmotionChart(timeline) {
  const ctx = document.getElementById("emotion-chart");
  if (!ctx) return;

  if (!timeline || timeline.length === 0) {
    ctx.parentElement.innerHTML = '<div class="empty-state"><p>暂无情绪数据</p></div>';
    return;
  }

  const labels = timeline.map(p => formatTime(p.time));
  const values = timeline.map(p => emotionToValue(p.label));
  const colors = timeline.map(p => emotionColor(p.label));
  const pointSizes = timeline.map(p => p.confidence > 0.8 ? 8 : 4);

  new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: "情绪状态",
        data: values,
        borderColor: "#0d9488",
        backgroundColor: "rgba(13,148,136,0.08)",
        borderWidth: 2,
        fill: true,
        tension: 0.3,
        pointBackgroundColor: colors,
        pointBorderColor: colors,
        pointRadius: pointSizes,
        pointHoverRadius: 8
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const idx = ctx.dataIndex;
              return timeline[idx].label + " (" + (timeline[idx].confidence * 100).toFixed(0) + "%)";
            }
          }
        }
      },
      scales: {
        y: {
          min: -2.5,
          max: 2.5,
          ticks: {
            stepSize: 1,
            callback: (v) => ({ 2: "calm", 1: "neutral", 0: "stress", "-1": "sad", "-2": "anxiety" }[v] || "")
          }
        }
      }
    }
  });
}

function renderTimeline(turns) {
  const container = document.getElementById("timeline-container");
  if (!container) return;

  if (!turns || turns.length === 0) {
    container.innerHTML = '<div class="empty-state"><p>暂无对话记录</p></div>';
    return;
  }

  container.innerHTML = turns.slice(-20).map(t => `
    <div class="timeline-item">
      <span class="time">${formatTime(t.time)}</span>
      <span class="role user">用户</span>
      <span class="text">${escapeHtml(t.userText)}</span>
    </div>
    <div class="timeline-item">
      <span class="time"></span>
      <span class="role assistant">助手</span>
      <span class="text ${t.safetyLevel === 'high' ? 'safety-high' : ''}">${escapeHtml(t.assistantText)}</span>
    </div>
  `).join("");
}

function renderHeatmap(eegChannels) {
  const container = document.getElementById("heatmap-container");
  if (!container) return;

  if (!eegChannels || !eegChannels.channels || eegChannels.channels.length === 0) {
    container.innerHTML = '<div class="empty-state"><p>暂无 EEG 导入数据</p><p style="font-size:12px">在会话中导入 EEG CSV 文件后可查看频谱热力图</p></div>';
    return;
  }

  const bands = ["delta", "theta", "alpha", "beta", "gamma"];
  const channels = eegChannels.channels.slice(0, 8);
  const allVals = channels.flatMap(ch => bands.map(b => ch[b] || 0));
  const maxVal = Math.max(...allVals, 0.01);

  function heatColor(val) {
    const ratio = Math.min(val / maxVal, 1);
    const r = Math.round(13 + (239 - 13) * ratio);
    const g = Math.round(148 - 148 * ratio);
    const b = Math.round(136 - 136 * ratio * 0.7);
    return `rgb(${r},${g},${b})`;
  }

  container.innerHTML = `
    <div style="font-size:12px;color:var(--muted);margin-bottom:8px">
      来源: ${eegChannels.filename || "未知"} (${eegChannels.formatType || "unknown"} 格式)
    </div>
    <div class="heatmap-header">
      <span></span>
      ${bands.map(b => `<span>${b}</span>`).join("")}
    </div>
    ${channels.map(ch => `
      <div class="heatmap-row">
        <span class="ch-label">${ch.channelName}</span>
        ${bands.map(b => {
          const v = ch[b] || 0;
          return `<span class="heatmap-cell" style="background:${heatColor(v)}">${v.toFixed(2)}</span>`;
        }).join("")}
      </div>
    `).join("")}
  `;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
</script>
</body>
</html>
```

- [ ] **Step 2: Start server and open report page**

```bash
cd mindcap-mvp && node server/server.js &
sleep 2

# Start session, push EEG, chat, then open report
SID=$(curl -s -X POST http://127.0.0.1:5050/api/session/start -H "Content-Type: application/json" -d '{"userId":"u001"}' | grep -o '"sessionId":"[^"]*"' | head -1 | cut -d'"' -f4)

curl -s -X POST http://127.0.0.1:5050/api/eeg/push -H "Content-Type: application/json" -d "{\"sessionId\":\"$SID\",\"label\":\"stress\",\"confidence\":0.85}" > /dev/null
curl -s -X POST http://127.0.0.1:5050/api/chat/send -H "Content-Type: application/json" -d "{\"sessionId\":\"$SID\",\"message\":\"我考试前总是睡不着\"}" > /dev/null
curl -s -X POST http://127.0.0.1:5050/api/eeg/push -H "Content-Type: application/json" -d "{\"sessionId\":\"$SID\",\"label\":\"calm\",\"confidence\":0.72}" > /dev/null

# Import EEG to get heatmap data
curl -s -X POST http://127.0.0.1:5050/api/eeg/import -H "Content-Type: application/json" \
  -d "{\"csvData\":\"channel,delta,theta,alpha,beta,gamma\nAF3,0.45,0.78,1.15,0.52,0.21\nAF4,0.38,0.71,0.98,0.88,0.19\nF3,0.55,0.85,0.76,1.42,0.35\nF4,0.48,0.79,0.68,1.55,0.28\",\"filename\":\"demo_bands.csv\",\"sessionId\":\"$SID\"}" > /dev/null

echo "Report URL: http://127.0.0.1:5050/report?sessionId=$SID"
echo "Open this URL in browser to see the report page"

kill %1 2>/dev/null
```

Expected: Report URL is printed. Browser should show full report with 4 stat cards, emotion trend line chart, conversation timeline, and EEG heatmap.

- [ ] **Step 3: Commit**

```bash
git add mindcap-mvp/public/report.html
git commit -m "feat: add standalone session report page with charts and heatmap"
```

---

### Task 3: Full Demo flow verification

- [ ] **Step 1: Run complete Demo simulation**

```bash
cd mindcap-mvp && node server/server.js &
sleep 2

# Start session
SID=$(curl -s -X POST http://127.0.0.1:5050/api/session/start -H "Content-Type: application/json" -d '{"userId":"u001"}' | grep -o '"sessionId":"[^"]*"' | head -1 | cut -d'"' -f4)
echo "Session: $SID"

# Import EEG (shows heatmap)
curl -s -X POST http://127.0.0.1:5050/api/eeg/import -H "Content-Type: application/json" \
  -d "{\"csvData\":\"channel,delta,theta,alpha,beta,gamma\nAF3,0.45,0.78,1.15,0.52,0.21\nAF4,0.38,0.71,0.98,0.88,0.19\nF3,0.55,0.85,0.76,1.42,0.35\nF4,0.48,0.79,0.68,1.55,0.28\",\"filename\":\"demo_bands.csv\",\"sessionId\":\"$SID\"}" > /dev/null

# Simulate 3 rounds of conversation
for i in 1 2 3; do
  curl -s -X POST http://127.0.0.1:5050/api/chat/send -H "Content-Type: application/json" \
    -d "{\"sessionId\":\"$SID\",\"message\":\"我最近压力很大，失眠严重\"}" > /dev/null
  curl -s -X POST http://127.0.0.1:5050/api/feedback -H "Content-Type: application/json" \
    -d "{\"sessionId\":\"$SID\",\"helpful\":true,\"moodDelta\":0.15}" > /dev/null
done

# Add a few more varied emotions
curl -s -X POST http://127.0.0.1:5050/api/eeg/push -H "Content-Type: application/json" -d "{\"sessionId\":\"$SID\",\"label\":\"stress\",\"confidence\":0.85}" > /dev/null
curl -s -X POST http://127.0.0.1:5050/api/eeg/push -H "Content-Type: application/json" -d "{\"sessionId\":\"$SID\",\"label\":\"anxiety\",\"confidence\":0.78}" > /dev/null
curl -s -X POST http://127.0.0.1:5050/api/eeg/push -H "Content-Type: application/json" -d "{\"sessionId\":\"$SID\",\"label\":\"calm\",\"confidence\":0.65}" > /dev/null

# Verify report API returns all sections
REPORT=$(curl -s http://127.0.0.1:5050/api/report/$SID)
echo "Turns:" $(echo $REPORT | python3 -c "import sys,json; print(json.load(sys.stdin)['stats']['turns'])" 2>/dev/null)
echo "Has emotion:" $(echo $REPORT | python3 -c "import sys,json; print(len(json.load(sys.stdin)['emotionTimeline']) > 0)" 2>/dev/null)
echo "Has chat:" $(echo $REPORT | python3 -c "import sys,json; print(len(json.load(sys.stdin)['chatTurns']) > 0)" 2>/dev/null)
echo "Has EEG:" $(echo $REPORT | python3 -c "import sys,json; print(json.load(sys.stdin)['eegChannels'] is not None)" 2>/dev/null)

curl -s -X POST http://127.0.0.1:5050/api/session/end -H "Content-Type: application/json" -d "{\"sessionId\":\"$SID\"}" > /dev/null
kill %1 2>/dev/null
```

Expected: `Turns: 3`, `Has emotion: True`, `Has chat: True`, `Has EEG: True`.

- [ ] **Step 2: Open in browser for manual visual check**

Open `http://127.0.0.1:5050/report?sessionId=<SID>` in browser and verify:
- 4 stat cards show correct numbers
- Emotion chart renders with multi-colored dots
- Timeline shows user/assistant pairs
- EEG heatmap shows colored cells per channel/band
- Print button opens print dialog

- [ ] **Step 3: Commit any fixes and push**

```bash
git add -A && git status
git push origin main
```
