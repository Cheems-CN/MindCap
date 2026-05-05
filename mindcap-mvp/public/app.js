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

const TRACK_LABELS = {
  anxiety_relief: "焦虑缓解",
  grief_support: "低落支持",
  task: "任务解压",
  social: "社交支持"
};

function byId(id) {
  return document.getElementById(id);
}

function formatTime(iso) {
  if (!iso) return "-";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "-";
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
}

function formatPercent(value, digits = 1) {
  const num = Number(value || 0);
  return `${(num * 100).toFixed(digits)}%`;
}

function setText(id, text) {
  const node = byId(id);
  if (!node) return;
  node.textContent = text;
}

function createListItem(text, className = "") {
  const li = document.createElement("li");
  if (className) li.className = className;
  li.textContent = text;
  return li;
}

function renderTextList(containerId, items = [], options = {}) {
  const { emptyText = "暂无数据", mapItem = null, itemClassName = "list-card" } = options;
  const box = byId(containerId);
  if (!box) return;

  box.innerHTML = "";
  const array = Array.isArray(items) ? items.filter((item) => item !== null && item !== undefined && item !== "") : [];
  if (!array.length) {
    box.appendChild(createListItem(emptyText, itemClassName));
    return;
  }

  array.forEach((item, idx) => {
    const text = typeof mapItem === "function" ? mapItem(item, idx) : String(item);
    box.appendChild(createListItem(text, itemClassName));
  });
}

function renderChipList(containerId, items = [], emptyText = "暂无") {
  const box = byId(containerId);
  if (!box) return;
  box.innerHTML = "";

  const array = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!array.length) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = emptyText;
    box.appendChild(chip);
    return;
  }

  array.forEach((item) => {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = String(item);
    box.appendChild(chip);
  });
}

function renderKeyValueCards(containerId, objectValue = {}, emptyText = "暂无") {
  const box = byId(containerId);
  if (!box) return;
  box.innerHTML = "";

  const entries = Object.entries(objectValue || {});
  if (!entries.length) {
    const item = document.createElement("div");
    item.innerHTML = `<span class="k">状态</span><span class="v">${emptyText}</span>`;
    box.appendChild(item);
    return;
  }

  entries.forEach(([key, value]) => {
    const item = document.createElement("div");
    item.innerHTML = `<span class="k">${key}</span><span class="v">${String(value)}</span>`;
    box.appendChild(item);
  });
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Request failed: ${response.status}`);
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

function setSystemBadge(text) {
  setText("global-system-status", text);
}

function setChatEngineNote(text) {
  setText("chat-engine-note", text);
}

function setSessionHeader() {
  setText("current-session-id", state.currentSessionId || "未启动");
  setText("current-user-name", state.currentUserName || "未选择");
}

function renderInterventionProgress(interventionState) {
  const node = byId("intervention-progress");
  if (!node) return;

  if (!interventionState) {
    node.textContent = "干预轨道: 待建立";
    return;
  }

  const key = interventionState.trackKey || "task";
  const step = Number(interventionState.stepIndex || 0) + 1;
  const label = TRACK_LABELS[key] || key;
  node.textContent = `干预轨道: ${label} | 当前步骤: 第${step}步`;
}

function renderSuggestions(items = [], interventionState = null) {
  renderInterventionProgress(interventionState);
  renderTextList("suggestion-list", items, { emptyText: "暂无建议", itemClassName: "list-card" });
}

function renderEmotionTrend(items = []) {
  renderTextList("emotion-trend-list", items.slice(-10), {
    emptyText: "暂无情绪数据",
    mapItem: (item) => `${formatTime(item.time)} | ${item.label} (${Number(item.confidence || 0).toFixed(2)})`,
    itemClassName: "timeline-item"
  });
}

function updateLiveEmotion(emotion) {
  if (!emotion) return;
  setText("live-emotion-label", emotion.label || "neutral");
  setText("live-emotion-confidence", Number(emotion.confidence || 0).toFixed(2));
  setText("live-emotion-time", formatTime(emotion.time));
}

function updateSafetyAlert(text, level = "normal") {
  const alertNode = byId("live-safety-alert");
  if (!alertNode) return;

  alertNode.textContent = text;
  if (level === "high") {
    alertNode.style.borderColor = "#fca5a5";
    alertNode.style.background = "#fef2f2";
    alertNode.style.color = "#991b1b";
    return;
  }

  if (level === "medium") {
    alertNode.style.borderColor = "#fdba74";
    alertNode.style.background = "#fff7ed";
    alertNode.style.color = "#9a3412";
    return;
  }

  alertNode.style.borderColor = "#d8e5f5";
  alertNode.style.background = "#f8fbff";
  alertNode.style.color = "#20486f";
}

function setupNavigation() {
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      showView(btn.dataset.view);
      if (btn.dataset.view === "dashboard") loadDashboard().catch((err) => alert(err.message));
      if (btn.dataset.view === "history") loadHistory().catch((err) => alert(err.message));
      if (btn.dataset.view === "profile") loadProfile().catch((err) => alert(err.message));
      if (btn.dataset.view === "strategy") loadStrategy().catch((err) => alert(err.message));
      if (btn.dataset.view === "safety") loadSafety().catch((err) => alert(err.message));
      if (btn.dataset.view === "evaluation") loadEvaluation().catch((err) => alert(err.message));
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
    updateSafetyAlert("高风险命中: 已触发安全回复与人工升级提醒", "high");
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

  state.users.forEach((user) => {
    const text = `${user.name} (${user.id})`;

    const optionA = document.createElement("option");
    optionA.value = user.id;
    optionA.textContent = text;
    userSelect.appendChild(optionA);

    const optionB = document.createElement("option");
    optionB.value = user.id;
    optionB.textContent = text;
    profileSelect.appendChild(optionB);
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
  setChatEngineNote("聊天引擎已就绪");
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

    const currentLines = Array.from(byId("emotion-trend-list").querySelectorAll("li")).map((li) => li.textContent);
    currentLines.push(`${formatTime(event.time)} | ${event.label} (${Number(event.confidence || 0).toFixed(2)})`);
    renderTextList("emotion-trend-list", currentLines.slice(-10), { itemClassName: "timeline-item" });
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
    setSystemBadge("实时流已断开，可刷新重连");
  };
}

async function loadDashboard() {
  const data = await api("/api/dashboard");
  setText("metric-sessions", String(data.todaySessionCount || 0));
  setText("metric-risk", String(data.riskAlertCount || 0));
  setText("metric-mood", Number(data.avgMoodDelta || 0).toFixed(2));

  const grid = byId("system-status-grid");
  grid.innerHTML = "";
  Object.entries(data.systemStatus || {}).forEach(([key, value]) => {
    const item = document.createElement("div");
    item.className = "status-item";
    item.innerHTML = `<span class="k">${String(key).toUpperCase()}</span><span class="v">${String(value)}</span>`;
    grid.appendChild(item);
  });
}

async function loadHistory() {
  const data = await api("/api/sessions");
  const box = byId("session-list");
  box.innerHTML = "";

  if (!data.sessions?.length) {
    box.textContent = "暂无历史会话";
    return;
  }

  data.sessions.forEach((session) => {
    const btn = document.createElement("button");
    btn.className = "history-session-btn";
    btn.textContent = `${session.userName} | ${session.status} | ${formatTime(session.startedAt)}`;
    btn.addEventListener("click", () => {
      loadHistorySession(session.id).catch((err) => alert(err.message));
    });
    box.appendChild(btn);
  });
}

async function loadHistorySession(sessionId) {
  const data = await api(`/api/session/${sessionId}/state`);
  const session = data.session;

  setText("history-meta", `会话 ${session.id} | ${session.status} | ${formatTime(session.startedAt)}`);

  renderTextList("history-timeline", session.timeline || [], {
    emptyText: "暂无时间线记录",
    mapItem: (item) => `${formatTime(item.time)} | ${item.type} | ${item.detail}`,
    itemClassName: "timeline-item"
  });

  const chatBox = byId("history-chat");
  chatBox.innerHTML = "";
  const turns = session.chatTurns || [];
  if (!turns.length) {
    const empty = document.createElement("p");
    empty.className = "note";
    empty.textContent = "暂无对话回放";
    chatBox.appendChild(empty);
    return;
  }

  turns.forEach((turn) => {
    const card = document.createElement("div");
    card.className = "history-chat-card";
    const source = turn.llmSource ? `[${turn.llmSource}] ` : "";
    card.innerHTML = `
      <div class="history-chat-role user">用户</div>
      <div class="history-chat-content">${turn.userText || ""}</div>
      <div class="history-chat-role assistant">助手</div>
      <div class="history-chat-content">${source}${turn.assistantText || ""}</div>
      <div class="history-chat-meta">${formatTime(turn.time)} | 安全级别: ${turn.safetyLevel || "normal"}</div>
    `;
    chatBox.appendChild(card);
  });
}

async function loadProfile() {
  const userId = byId("profile-user-select").value || state.currentUserId;
  if (!userId) return;

  const data = await api(`/api/user/${userId}/profile`);
  const user = data.user || {};

  setText("profile-id", user.id || "-");
  setText("profile-name", user.name || "-");
  setText("profile-age", user.age ?? "-");
  setText("profile-gender", user.gender || "-");

  renderChipList("profile-tags", user.tags || [], "暂无标签");
  renderTextList("profile-short-memory", user.shortTermMemory || [], {
    emptyText: "暂无短期记忆",
    itemClassName: "list-card"
  });

  const longTerm = user.longTermProfile || {};
  renderTextList("profile-triggers", longTerm.triggers || [], {
    emptyText: "暂无触发因素",
    itemClassName: "list-card"
  });
  renderTextList("profile-preferred", longTerm.preferredInterventions || [], {
    emptyText: "暂无偏好干预方式",
    itemClassName: "list-card"
  });
  renderTextList("profile-avoid-topics", longTerm.avoidTopics || [], {
    emptyText: "暂无规避话题",
    itemClassName: "list-card"
  });

  renderTextList("profile-effective", user.verifiedEffectiveStrategies || [], {
    emptyText: "暂无已验证策略",
    itemClassName: "list-card"
  });

  renderTextList("profile-timeline", user.memoryTimeline || [], {
    emptyText: "暂无记忆时间线",
    mapItem: (item) => `${formatTime(item.time)} | ${item.event} | ${item.detail}`,
    itemClassName: "timeline-item"
  });
}

async function loadStrategy() {
  const data = await api("/api/strategy");
  const strategy = data.strategy || {};

  byId("strategy-version").value = strategy.version || "";
  byId("reward-immediate").value = strategy.rewardWeights?.immediateMoodGain ?? 0;
  byId("reward-longterm").value = strategy.rewardWeights?.longTermStability ?? 0;
  byId("reward-guideline").value = strategy.rewardWeights?.clinicalGuidelineFit ?? 0;

  renderTextList("strategy-actions", strategy.actionSpace || [], {
    emptyText: "暂无动作空间配置",
    itemClassName: "list-card"
  });

  const training = strategy.training || {};
  const trainingChips = Object.entries(training).map(([key, value]) => `${key}: ${String(value)}`);
  renderChipList("strategy-training", trainingChips, "暂无训练设置");

  renderKeyValueCards("strategy-abtest", strategy.abTestPlaceholder || {}, "暂无A/B配置");
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

  const maxCount = Math.max(1, ...points.map((point) => Number(point.count || 0)));
  points.forEach((point) => {
    const count = Number(point.count || 0);
    const height = Math.max(2, Math.round((count / maxCount) * 120));
    const hour = new Date(point.hour).getHours().toString().padStart(2, "0");

    const bar = document.createElement("div");
    bar.className = "trend-bar";
    bar.dataset.active = count > 0 ? "true" : "false";
    bar.style.height = `${height}px`;
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
  box.innerHTML = "";

  if (!topReasons.length) {
    box.textContent = "暂无触发记录";
    return;
  }

  const rows = topReasons
    .map((item, idx) => `<tr><td>${idx + 1}</td><td>${item.reason}</td><td>${item.count}</td></tr>`)
    .join("");

  box.innerHTML = `
    <table class="reason-table">
      <thead>
        <tr><th>#</th><th>触发原因</th><th>次数</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderSafetyRulesAndKeywords(safety = {}) {
  const ruleBox = byId("safety-rules");
  const keywordBox = byId("safety-keywords");

  ruleBox.innerHTML = "";
  keywordBox.innerHTML = "";

  const rules = safety.riskRules || [];
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
  renderChipList("safety-keywords", keywords, "暂无关键词");
}

function renderEscalationFlow(rawFlow = "") {
  const box = byId("safety-escalation-flow");
  box.innerHTML = "";

  const steps = String(rawFlow || "")
    .split(/->|→/)
    .map((step) => step.trim())
    .filter(Boolean);

  if (!steps.length) {
    box.appendChild(createListItem("暂无升级流程配置", "list-card"));
    return;
  }

  steps.forEach((step) => {
    box.appendChild(createListItem(step, "flow-step"));
  });
}

async function loadSafety() {
  const data = await api("/api/safety");
  const totals = data.analytics?.totals || {};

  setText("safety-total-alerts", String(totals.total || 0));
  setText("safety-high-alerts", String(totals.high || 0));
  setText("safety-medium-alerts", String(totals.medium || 0));
  setText("safety-last24-alerts", String(totals.last24h || 0));

  renderSafetySeverityBars(data.analytics?.byLevel || {}, totals.total || 0);
  renderSafetyTrendBars(data.analytics?.byHour || []);
  renderSafetyTopReasons(data.analytics?.topReasons || []);
  renderSafetyRulesAndKeywords(data.safety || {});
  renderEscalationFlow(data.safety?.escalationFlow || "");

  renderTextList("safety-logs", (data.logs || []).slice(0, 60), {
    emptyText: "暂无安全日志",
    mapItem: (log) => `${formatTime(log.time)} | [${log.level}] ${log.reason}`,
    itemClassName: "timeline-item"
  });
}

async function loadEvaluation() {
  const data = await api("/api/evaluation");
  const model = data.modelMetrics || {};
  const intervention = data.interventionMetrics || {};

  setText("eval-emotion-acc", formatPercent(model.emotionAcc, 2));
  setText("eval-f1", Number(model.f1Macro || 0).toFixed(2));
  setText("eval-cross-device", Number(model.crossDeviceScore || 0).toFixed(2));

  setText("eval-turns", String(intervention.totalTurns || 0));
  setText("eval-feedback", String(intervention.totalFeedback || 0));
  setText("eval-helpful-rate", formatPercent(intervention.helpfulRate, 0));

  renderTextList("evaluation-export-items", data.exportItems || [], {
    emptyText: "暂无导出项",
    itemClassName: "list-card"
  });
}

async function createExport(kind) {
  const result = await api("/api/export", {
    method: "POST",
    body: JSON.stringify({ kind })
  });

  setText("export-status", `导出任务已创建: ${result.export.id} (${result.export.status})`);
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
