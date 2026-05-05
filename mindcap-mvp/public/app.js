import { createAiChat } from "/vendor/nlux-core.js";

const state = {
  users: [],
  currentUserId: null,
  currentUserName: null,
  currentSessionId: null,
  lastTurnId: null,
  eventSource: null,
  aiChat: null
};

function byId(id) {
  return document.getElementById(id);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Request failed: ${res.status}`);
  }
  return data;
}

function showView(viewName) {
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === viewName);
  });
  document.querySelectorAll(".view").forEach((view) => {
    view.classList.toggle("active", view.id === `view-${viewName}`);
  });
}

function formatTime(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString()}`;
}

function setSystemBadge(text) {
  byId("global-system-status").textContent = text;
}

function setChatEngineNote(text) {
  const node = byId("chat-engine-note");
  if (node) {
    node.textContent = text;
  }
}

function setSessionHeader() {
  byId("current-session-id").textContent = state.currentSessionId || "未启动";
  byId("current-user-name").textContent = state.currentUserName || "未选择";
}

function renderInterventionProgress(interventionState) {
  const node = byId("intervention-progress");
  if (!node) return;
  if (!interventionState) {
    node.textContent = "干预轨道：待建立";
    return;
  }
  const track = interventionState.trackKey || "unknown";
  const step = Number(interventionState.stepIndex || 0) + 1;
  node.textContent = `干预轨道：${track} | 当前步骤：第${step}步`;
}

function renderSuggestions(items = [], interventionState = null) {
  const ul = byId("suggestion-list");
  ul.innerHTML = "";
  renderInterventionProgress(interventionState);
  if (!items.length) {
    const li = document.createElement("li");
    li.textContent = "暂无建议";
    ul.appendChild(li);
    return;
  }
  items.forEach((item) => {
    const li = document.createElement("li");
    li.textContent = item;
    ul.appendChild(li);
  });
}

function renderEmotionTrend(items = []) {
  const list = byId("emotion-trend-list");
  list.innerHTML = "";
  items.slice(-10).forEach((it) => {
    const li = document.createElement("li");
    li.textContent = `${formatTime(it.time)} - ${it.label} (${Number(it.confidence).toFixed(2)})`;
    list.appendChild(li);
  });
}

function updateLiveEmotion(emotion) {
  if (!emotion) return;
  byId("live-emotion-label").textContent = emotion.label;
  byId("live-emotion-confidence").textContent = Number(emotion.confidence).toFixed(2);
  byId("live-emotion-time").textContent = formatTime(emotion.time);
}

function updateSafetyAlert(text, level = "normal") {
  const alert = byId("live-safety-alert");
  alert.textContent = text;
  if (level === "high") {
    alert.style.borderColor = "#fca5a5";
    alert.style.background = "#fef2f2";
    alert.style.color = "#991b1b";
  } else if (level === "medium") {
    alert.style.borderColor = "#fdba74";
    alert.style.background = "#fff7ed";
    alert.style.color = "#9a3412";
  } else {
    alert.style.borderColor = "#d8e5f5";
    alert.style.background = "#f8fbff";
    alert.style.color = "#20486f";
  }
}

function setupNavigation() {
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      showView(btn.dataset.view);
      if (btn.dataset.view === "dashboard") loadDashboard();
      if (btn.dataset.view === "history") loadHistory();
      if (btn.dataset.view === "profile") loadProfile();
      if (btn.dataset.view === "strategy") loadStrategy();
      if (btn.dataset.view === "safety") loadSafety();
      if (btn.dataset.view === "evaluation") loadEvaluation();
    });
  });
}

function toInitialConversation(chatTurns = []) {
  const items = [];
  chatTurns.forEach((turn) => {
    items.push({ role: "user", message: turn.userText || "" });
    const source = turn.llmSource ? `[${turn.llmSource}] ` : "";
    items.push({ role: "assistant", message: `${source}${turn.assistantText || ""}` });
  });
  return items;
}

async function buildNlUxAdapterReply(message) {
  if (!state.currentSessionId) {
    return "请先开始会话，再进行对话。";
  }
  const result = await api("/api/chat/send", {
    method: "POST",
    body: JSON.stringify({
      sessionId: state.currentSessionId,
      message
    })
  });
  state.lastTurnId = result.turnId;

  const source = result.llmSource || "unknown";
  setSystemBadge(`回复引擎: ${source}`);
  setChatEngineNote(`当前引擎: ${source}`);

  renderSuggestions(result.suggestions || [], result.interventionState || null);
  if (result.safetyLevel === "high") {
    updateSafetyAlert("高风险命中：已触发安全替代回复与人工升级提醒", "high");
    loadSafety().catch(() => {});
  } else {
    updateSafetyAlert("当前无高风险命中", "normal");
  }

  return result.assistantMessage;
}

async function mountChat(initialConversation = []) {
  const root = byId("chat-ui-root");
  if (!root) return;

  if (state.aiChat) {
    try {
      state.aiChat.unmount();
    } catch (_) {
      // ignore
    }
    state.aiChat = null;
  }
  root.innerHTML = "";

  const adapter = {
    batchText: async (message) => {
      try {
        return await buildNlUxAdapterReply(message);
      } catch (err) {
        setSystemBadge(`聊天请求失败: ${err.message}`);
        setChatEngineNote("聊天请求失败，已记录错误");
        return "当前对话服务暂时不可用，请稍后重试。";
      }
    }
  };

  const aiChat = createAiChat()
    .withAdapter(adapter)
    .withDisplayOptions({
      width: "100%",
      height: "100%",
      themeId: "nova",
      colorScheme: "light"
    })
    .withConversationOptions({
      autoScroll: true,
      historyPayloadSize: 12,
      layout: "bubbles",
      showWelcomeMessage: true
    })
    .withComposerOptions({
      autoFocus: false,
      placeholder: "请输入用户消息..."
    })
    .withMessageOptions({
      markdownLinkTarget: "blank",
      showCodeBlockCopyButton: true
    })
    .withInitialConversation(initialConversation)
    .on("error", (event) => {
      setSystemBadge(`聊天组件错误: ${event.message}`);
    });

  aiChat.mount(root);
  state.aiChat = aiChat;
  if (!state.currentSessionId) {
    setChatEngineNote("尚未启动会话（可先在左侧选择受试者并开始会话）");
  }
}

async function loadUsers() {
  const data = await api("/api/users");
  state.users = data.users || [];

  const userSelect = byId("user-select");
  const profileSelect = byId("profile-user-select");
  userSelect.innerHTML = "";
  profileSelect.innerHTML = "";

  state.users.forEach((u) => {
    const text = `${u.name} (${u.id})`;
    const opt1 = document.createElement("option");
    opt1.value = u.id;
    opt1.textContent = text;
    userSelect.appendChild(opt1);

    const opt2 = document.createElement("option");
    opt2.value = u.id;
    opt2.textContent = text;
    profileSelect.appendChild(opt2);
  });

  if (state.users.length > 0) {
    state.currentUserId = state.users[0].id;
    state.currentUserName = state.users[0].name;
    userSelect.value = state.currentUserId;
    profileSelect.value = state.currentUserId;
    setSessionHeader();
  }
}

async function startSession() {
  const userId = byId("user-select").value;
  if (!userId) {
    alert("请先选择受试者");
    return;
  }
  const data = await api("/api/session/start", {
    method: "POST",
    body: JSON.stringify({ userId })
  });

  state.currentSessionId = data.sessionId;
  state.currentUserId = data.user.id;
  state.currentUserName = data.user.name;
  state.lastTurnId = null;
  setSessionHeader();

  setSystemBadge("会话已启动");
  setChatEngineNote("聊天引擎就绪");
  renderSuggestions([]);
  renderInterventionProgress(null);
  renderEmotionTrend([]);
  updateLiveEmotion({ label: "neutral", confidence: 0.5, time: new Date().toISOString() });
  updateSafetyAlert("当前无高风险命中", "normal");

  await mountChat([]);
  connectSessionStream(state.currentSessionId);
  await Promise.all([loadDashboard(), loadHistory(), loadProfile()]);
  showView("session");
}

async function endSession() {
  if (!state.currentSessionId) {
    alert("当前没有可结束的会话");
    return;
  }
  await api("/api/session/end", {
    method: "POST",
    body: JSON.stringify({ sessionId: state.currentSessionId })
  });
  setSystemBadge("会话已结束");
  await Promise.all([loadHistory(), loadDashboard()]);
}

async function pushMockEEG() {
  if (!state.currentSessionId) {
    alert("请先启动会话");
    return;
  }
  const label = byId("mock-eeg-label").value;
  const confidence = Number(byId("mock-eeg-confidence").value || 0.5);
  const data = await api("/api/eeg/push", {
    method: "POST",
    body: JSON.stringify({
      sessionId: state.currentSessionId,
      label,
      confidence,
      time: new Date().toISOString()
    })
  });
  updateLiveEmotion(data.currentEmotion);
}

async function sendFeedback(helpful) {
  if (!state.currentSessionId) {
    alert("请先启动会话");
    return;
  }
  await api("/api/feedback", {
    method: "POST",
    body: JSON.stringify({
      sessionId: state.currentSessionId,
      turnId: state.lastTurnId,
      helpful,
      moodDelta: helpful ? 1 : -1,
      note: helpful ? "用户认为本轮有帮助" : "用户认为本轮无帮助"
    })
  });
  setSystemBadge(helpful ? "已记录正向反馈" : "已记录负向反馈");
  await loadDashboard();
}

async function refreshCurrentSessionState() {
  if (!state.currentSessionId) return;
  const data = await api(`/api/session/${state.currentSessionId}/state`);
  const session = data.session;

  updateLiveEmotion(session.currentEmotion);
  renderEmotionTrend(session.emotionTrend || []);

  const lastTurn = session.chatTurns?.[session.chatTurns.length - 1];
  if (lastTurn) {
    state.lastTurnId = lastTurn.id;
    renderSuggestions(lastTurn.suggestions || [], lastTurn.interventionState || null);
    setChatEngineNote(`当前引擎: ${lastTurn.llmSource || "unknown"}`);
  }

  await mountChat(toInitialConversation(session.chatTurns || []));
}

function connectSessionStream(sessionId) {
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }
  const source = new EventSource(`/api/session/${sessionId}/stream`);
  state.eventSource = source;

  source.addEventListener("ready", () => {
    setSystemBadge("实时流已连接");
  });

  source.addEventListener("eeg", (evt) => {
    const event = JSON.parse(evt.data);
    updateLiveEmotion(event);

    const current = Array.from(byId("emotion-trend-list").querySelectorAll("li")).map((li) => li.textContent);
    current.push(`${formatTime(event.time)} - ${event.label} (${Number(event.confidence).toFixed(2)})`);
    byId("emotion-trend-list").innerHTML = "";
    current.slice(-10).forEach((txt) => {
      const li = document.createElement("li");
      li.textContent = txt;
      byId("emotion-trend-list").appendChild(li);
    });
  });

  source.addEventListener("safety", (evt) => {
    const log = JSON.parse(evt.data);
    updateSafetyAlert(`风险告警(${log.level}): ${log.reason}`, log.level);
    loadSafety().catch(() => {});
  });

  source.addEventListener("session_end", () => {
    setSystemBadge("会话已结束");
  });

  source.onerror = () => {
    setSystemBadge("实时流断开，稍后可刷新重连");
  };
}

async function loadDashboard() {
  const data = await api("/api/dashboard");
  byId("metric-sessions").textContent = data.todaySessionCount;
  byId("metric-risk").textContent = data.riskAlertCount;
  byId("metric-mood").textContent = Number(data.avgMoodDelta).toFixed(2);

  const grid = byId("system-status-grid");
  grid.innerHTML = "";
  Object.entries(data.systemStatus).forEach(([key, value]) => {
    const item = document.createElement("div");
    item.className = "status-item";
    item.textContent = `${key.toUpperCase()}: ${value}`;
    grid.appendChild(item);
  });
}

async function loadHistory() {
  const data = await api("/api/sessions");
  const box = byId("session-list");
  box.innerHTML = "";
  if (!data.sessions.length) {
    box.textContent = "暂无历史会话";
    return;
  }
  data.sessions.forEach((s) => {
    const btn = document.createElement("button");
    btn.textContent = `${s.userName} | ${s.status} | ${formatTime(s.startedAt)}`;
    btn.addEventListener("click", () => {
      loadHistorySession(s.id);
    });
    box.appendChild(btn);
  });
}

async function loadHistorySession(sessionId) {
  const data = await api(`/api/session/${sessionId}/state`);
  const { session } = data;
  byId("history-meta").textContent = `会话 ${session.id} | ${session.status} | ${formatTime(session.startedAt)}`;

  const timeline = byId("history-timeline");
  timeline.innerHTML = "";
  session.timeline.forEach((item) => {
    const li = document.createElement("li");
    li.textContent = `${formatTime(item.time)} - ${item.type} - ${item.detail}`;
    timeline.appendChild(li);
  });

  const chat = byId("history-chat");
  chat.innerHTML = "";
  session.chatTurns.forEach((turn) => {
    const p1 = document.createElement("p");
    p1.textContent = `用户: ${turn.userText}`;
    const p2 = document.createElement("p");
    const source = turn.llmSource ? `[${turn.llmSource}] ` : "";
    p2.textContent = `助手: ${source}${turn.assistantText}`;
    chat.appendChild(p1);
    chat.appendChild(p2);
    chat.appendChild(document.createElement("hr"));
  });
}

async function loadProfile() {
  const userId = byId("profile-user-select").value || state.currentUserId;
  if (!userId) return;
  const data = await api(`/api/user/${userId}/profile`);
  const user = data.user;

  byId("profile-basic").textContent = JSON.stringify(
    {
      id: user.id,
      name: user.name,
      age: user.age,
      gender: user.gender,
      tags: user.tags
    },
    null,
    2
  );
  byId("profile-long-memory").textContent = JSON.stringify(user.longTermProfile, null, 2);

  const shortBox = byId("profile-short-memory");
  shortBox.innerHTML = "";
  user.shortTermMemory.forEach((x) => {
    const li = document.createElement("li");
    li.textContent = x;
    shortBox.appendChild(li);
  });

  const effBox = byId("profile-effective");
  effBox.innerHTML = "";
  user.verifiedEffectiveStrategies.forEach((x) => {
    const li = document.createElement("li");
    li.textContent = x;
    effBox.appendChild(li);
  });

  const tlBox = byId("profile-timeline");
  tlBox.innerHTML = "";
  user.memoryTimeline.forEach((x) => {
    const li = document.createElement("li");
    li.textContent = `${formatTime(x.time)} - ${x.event} - ${x.detail}`;
    tlBox.appendChild(li);
  });
}

async function loadStrategy() {
  const data = await api("/api/strategy");
  const st = data.strategy;
  byId("strategy-version").value = st.version || "";
  byId("reward-immediate").value = st.rewardWeights?.immediateMoodGain ?? 0;
  byId("reward-longterm").value = st.rewardWeights?.longTermStability ?? 0;
  byId("reward-guideline").value = st.rewardWeights?.clinicalGuidelineFit ?? 0;
  byId("strategy-json").textContent = JSON.stringify(st, null, 2);
}

async function saveStrategy() {
  const payload = {
    version: byId("strategy-version").value,
    rewardWeights: {
      immediateMoodGain: Number(byId("reward-immediate").value || 0),
      longTermStability: Number(byId("reward-longterm").value || 0),
      clinicalGuidelineFit: Number(byId("reward-guideline").value || 0)
    }
  };
  await api("/api/strategy", {
    method: "PUT",
    body: JSON.stringify(payload)
  });
  setSystemBadge("策略配置已保存");
  await loadStrategy();
}

function renderSafetySeverityBars(byLevel = {}, total = 0) {
  const container = byId("safety-severity-bars");
  container.innerHTML = "";
  const entries = [
    { key: "high", label: "高风险", className: "level-high", color: "#ef4444" },
    { key: "medium", label: "中风险", className: "level-medium", color: "#f59e0b" },
    { key: "low", label: "低风险", className: "level-low", color: "#3b82f6" }
  ];

  entries.forEach((entry) => {
    const count = Number(byLevel[entry.key] || 0);
    const ratio = total > 0 ? (count / total) * 100 : 0;
    const row = document.createElement("div");
    row.className = "severity-row";
    row.innerHTML = `
      <div class="severity-meta ${entry.className}">
        <span>${entry.label}</span>
        <span>${count} (${ratio.toFixed(1)}%)</span>
      </div>
      <div class="severity-bar-bg">
        <div class="severity-bar-fill" style="width:${ratio}%; background:${entry.color};"></div>
      </div>
    `;
    container.appendChild(row);
  });
}

function renderSafetyTrendBars(points = []) {
  const container = byId("safety-trend-bars");
  container.innerHTML = "";
  const max = Math.max(1, ...points.map((p) => Number(p.count || 0)));

  points.forEach((p) => {
    const count = Number(p.count || 0);
    const h = Math.max(2, Math.round((count / max) * 120));
    const hour = new Date(p.hour).getHours().toString().padStart(2, "0");
    const bar = document.createElement("div");
    bar.className = "trend-bar";
    bar.dataset.active = count > 0 ? "true" : "false";
    bar.style.height = `${h}px`;
    bar.title = `${hour}:00 - ${count} 次`;
    if (count > 0) {
      const tip = document.createElement("span");
      tip.className = "trend-tip";
      tip.textContent = String(count);
      bar.appendChild(tip);
    }
    container.appendChild(bar);
  });
}

function renderSafetyTopReasons(topReasons = []) {
  const box = byId("safety-top-reasons");
  if (!topReasons.length) {
    box.textContent = "暂无触发记录";
    return;
  }
  const rows = topReasons
    .map((item, idx) => {
      return `<tr><td>${idx + 1}</td><td>${item.reason}</td><td>${item.count}</td></tr>`;
    })
    .join("");
  box.innerHTML = `
    <table class="reason-table">
      <thead><tr><th>#</th><th>触发原因</th><th>次数</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderSafetyRulesAndKeywords(safety = {}) {
  const ruleBox = byId("safety-rules");
  const keyBox = byId("safety-keywords");

  const rules = safety.riskRules || [];
  ruleBox.innerHTML = "";
  if (!rules.length) {
    ruleBox.textContent = "暂无规则";
  } else {
    const wrap = document.createElement("div");
    wrap.className = "chip-list";
    rules.forEach((rule) => {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.innerHTML = `<span class="dot ${rule.enabled ? "dot-ok" : "dot-off"}"></span>${rule.name}（${rule.level}）`;
      wrap.appendChild(chip);
    });
    ruleBox.appendChild(wrap);
  }

  const keywords = safety.blockedPatterns || [];
  keyBox.innerHTML = "";
  if (!keywords.length) {
    keyBox.textContent = "暂无关键词";
  } else {
    const wrap = document.createElement("div");
    wrap.className = "chip-list";
    keywords.forEach((kw) => {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.textContent = kw;
      wrap.appendChild(chip);
    });
    keyBox.appendChild(wrap);
  }
}

async function loadSafety() {
  const data = await api("/api/safety");
  const totals = data.analytics?.totals || {};
  byId("safety-total-alerts").textContent = String(totals.total || 0);
  byId("safety-high-alerts").textContent = String(totals.high || 0);
  byId("safety-medium-alerts").textContent = String(totals.medium || 0);
  byId("safety-last24-alerts").textContent = String(totals.last24h || 0);

  renderSafetySeverityBars(data.analytics?.byLevel || {}, totals.total || 0);
  renderSafetyTrendBars(data.analytics?.byHour || []);
  renderSafetyTopReasons(data.analytics?.topReasons || []);
  renderSafetyRulesAndKeywords(data.safety || {});

  byId("safety-escalation-flow").textContent = data.safety?.escalationFlow || "未配置升级流程";

  const logs = byId("safety-logs");
  logs.innerHTML = "";
  (data.logs || []).slice(0, 60).forEach((log) => {
    const li = document.createElement("li");
    li.textContent = `${formatTime(log.time)} [${log.level}] ${log.reason}`;
    logs.appendChild(li);
  });
}

async function loadEvaluation() {
  const data = await api("/api/evaluation");
  byId("evaluation-model").textContent = JSON.stringify(data.modelMetrics, null, 2);
  byId("evaluation-intervention").textContent = JSON.stringify(data.interventionMetrics, null, 2);
  const list = byId("evaluation-export-items");
  list.innerHTML = "";
  data.exportItems.forEach((x) => {
    const li = document.createElement("li");
    li.textContent = x;
    list.appendChild(li);
  });
}

async function createExport(kind) {
  const res = await api("/api/export", {
    method: "POST",
    body: JSON.stringify({ kind })
  });
  byId("export-status").textContent = `导出任务已创建: ${res.export.id} (${res.export.status})`;
}

function bindActions() {
  byId("show-ethics-btn").addEventListener("click", () => {
    byId("ethics-box").classList.toggle("hidden");
  });

  byId("start-session-btn").addEventListener("click", () => {
    startSession().catch((err) => alert(err.message));
  });
  byId("end-session-btn").addEventListener("click", () => {
    endSession().catch((err) => alert(err.message));
  });
  byId("push-eeg-btn").addEventListener("click", () => {
    pushMockEEG().catch((err) => alert(err.message));
  });
  byId("feedback-good-btn").addEventListener("click", () => {
    sendFeedback(true).catch((err) => alert(err.message));
  });
  byId("feedback-bad-btn").addEventListener("click", () => {
    sendFeedback(false).catch((err) => alert(err.message));
  });
  byId("refresh-session-btn").addEventListener("click", () => {
    refreshCurrentSessionState().catch((err) => alert(err.message));
  });
  byId("reload-history-btn").addEventListener("click", () => {
    loadHistory().catch((err) => alert(err.message));
  });
  byId("load-profile-btn").addEventListener("click", () => {
    loadProfile().catch((err) => alert(err.message));
  });
  byId("save-strategy-btn").addEventListener("click", () => {
    saveStrategy().catch((err) => alert(err.message));
  });
  byId("reload-safety-btn").addEventListener("click", () => {
    loadSafety().catch((err) => alert(err.message));
  });
  document.querySelectorAll(".export-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      createExport(btn.dataset.kind).catch((err) => alert(err.message));
    });
  });
}

async function init() {
  setupNavigation();
  bindActions();
  await loadUsers();
  await mountChat([]);
  await Promise.all([loadDashboard(), loadHistory(), loadProfile(), loadStrategy(), loadSafety(), loadEvaluation()]);
  setSystemBadge("系统初始化完成");
}

init().catch((err) => {
  setSystemBadge(`初始化失败: ${err.message}`);
});
