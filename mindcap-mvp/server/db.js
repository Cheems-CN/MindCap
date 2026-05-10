const Database = require("better-sqlite3");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "data", "mindcap.db");

// Ensure data directory exists
const fs = require("fs");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

// Performance & safety
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");

// ── Schema ──────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    age INTEGER,
    gender TEXT,
    tags TEXT DEFAULT '[]',
    short_term_memory TEXT DEFAULT '[]',
    long_term_profile TEXT DEFAULT '{}',
    verified_effective_strategies TEXT DEFAULT '[]',
    memory_timeline TEXT DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    status TEXT NOT NULL DEFAULT 'active',
    started_at TEXT NOT NULL,
    ended_at TEXT,
    current_emotion_label TEXT DEFAULT 'neutral',
    current_emotion_confidence REAL DEFAULT 0.5,
    current_emotion_time TEXT,
    intervention_track_key TEXT DEFAULT 'task',
    intervention_step_index INTEGER DEFAULT 0,
    intervention_last_emotion TEXT DEFAULT 'neutral',
    timeline TEXT DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS eeg_events (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    label TEXT NOT NULL,
    confidence REAL NOT NULL,
    time TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS eeg_imports (
    id TEXT PRIMARY KEY,
    session_id TEXT REFERENCES sessions(id),
    filename TEXT NOT NULL,
    channel_count INTEGER DEFAULT 0,
    sample_count INTEGER DEFAULT 0,
    duration_sec REAL DEFAULT 0,
    sample_rate REAL,
    device TEXT,
    format_type TEXT DEFAULT 'raw',
    detected_emotion_label TEXT,
    detected_emotion_confidence REAL,
    time TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS eeg_channels (
    id TEXT PRIMARY KEY,
    import_id TEXT NOT NULL REFERENCES eeg_imports(id),
    channel_name TEXT NOT NULL,
    band TEXT,
    value REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_eeg_imports_session ON eeg_imports(session_id);
  CREATE INDEX IF NOT EXISTS idx_eeg_channels_import ON eeg_channels(import_id);

  CREATE TABLE IF NOT EXISTS chat_turns (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    user_text TEXT NOT NULL,
    assistant_text TEXT NOT NULL,
    safety_level TEXT DEFAULT 'normal',
    emotion_label TEXT,
    emotion_confidence REAL,
    suggestions TEXT DEFAULT '[]',
    llm_source TEXT DEFAULT 'unknown',
    llm_error TEXT,
    intervention_track_key TEXT,
    intervention_step_index INTEGER,
    time TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS feedback (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    turn_id TEXT,
    helpful INTEGER NOT NULL DEFAULT 0,
    mood_delta REAL DEFAULT 0,
    note TEXT DEFAULT '',
    time TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS safety_logs (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    level TEXT NOT NULL,
    reason TEXT,
    source TEXT,
    time TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS strategy_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version TEXT DEFAULT 'v0.1',
    action_space TEXT DEFAULT '[]',
    reward_immediate_mood REAL DEFAULT 0.5,
    reward_long_term REAL DEFAULT 0.3,
    reward_guideline REAL DEFAULT 0.2,
    training_mode TEXT DEFAULT 'offline-mock',
    training_meta_learning INTEGER DEFAULT 1,
    training_online_fine_tune INTEGER DEFAULT 0,
    ab_group_a TEXT DEFAULT '支持型语气',
    ab_group_b TEXT DEFAULT '教练型语气',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS safety_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    risk_rules TEXT DEFAULT '[]',
    blocked_patterns TEXT DEFAULT '[]',
    replacement_high TEXT DEFAULT '',
    replacement_medium TEXT DEFAULT '',
    escalation_flow TEXT DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS export_records (
    id TEXT PRIMARY KEY,
    kind TEXT DEFAULT 'unknown',
    status TEXT DEFAULT 'queued',
    time TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
  CREATE INDEX IF NOT EXISTS idx_eeg_session ON eeg_events(session_id);
  CREATE INDEX IF NOT EXISTS idx_chat_session ON chat_turns(session_id);
  CREATE INDEX IF NOT EXISTS idx_feedback_session ON feedback(session_id);
  CREATE INDEX IF NOT EXISTS idx_safety_time ON safety_logs(time);
`);

// ── Seed helpers ────────────────────────────────────────────────────

const seedUsers = [
  {
    id: "u001",
    name: "受试者A",
    age: 22,
    gender: "女",
    tags: JSON.stringify(["学习压力", "睡眠不足"]),
    shortTermMemory: JSON.stringify(["昨天复盘时提到晚上入睡困难。"]),
    longTermProfile: JSON.stringify({
      triggers: ["考试周", "公开展示"],
      preferredInterventions: ["呼吸放松", "结构化鼓励"],
      avoidTopics: ["高压绩效对比"]
    }),
    verifiedEffectiveStrategies: JSON.stringify(["4-7-8呼吸法", "番茄钟拆解任务"]),
    memoryTimeline: JSON.stringify([
      { time: new Date().toISOString(), event: "创建用户画像", detail: "录入初始压力触发因素与有效策略" }
    ])
  },
  {
    id: "u002",
    name: "受试者B",
    age: 23,
    gender: "男",
    tags: JSON.stringify(["社交焦虑"]),
    shortTermMemory: JSON.stringify(["上次会话中对即兴发言表现出明显紧张。"]),
    longTermProfile: JSON.stringify({
      triggers: ["陌生社交场景"],
      preferredInterventions: ["暴露分级练习", "积极自我陈述"],
      avoidTopics: []
    }),
    verifiedEffectiveStrategies: JSON.stringify(["3句自我鼓励脚本"]),
    memoryTimeline: JSON.stringify([
      { time: new Date().toISOString(), event: "创建用户画像", detail: "记录社交焦虑相关触发因素" }
    ])
  }
];

const defaultStrategyConfig = {
  version: "v0.1-mock",
  actionSpace: JSON.stringify(["安抚对话", "呼吸引导", "认知重评", "任务分解建议"]),
  rewardImmediateMood: 0.5,
  rewardLongTerm: 0.3,
  rewardGuideline: 0.2,
  trainingMode: "offline-mock",
  trainingMetaLearning: 1,
  trainingOnlineFineTune: 0,
  abGroupA: "支持型语气",
  abGroupB: "教练型语气"
};

const defaultSafetyConfig = {
  riskRules: JSON.stringify([
    { level: "high", name: "自伤风险语句", enabled: true },
    { level: "medium", name: "持续绝望表达", enabled: true },
    { level: "low", name: "轻度负面倾向", enabled: true }
  ]),
  blockedPatterns: JSON.stringify(["不想活了", "结束生命", "伤害自己"]),
  replacementHigh: "我很重视你的安全。你现在的感受很重要，请优先联系身边可信任的人或当地紧急援助热线。",
  replacementMedium: "我听到了你的痛苦，我们先做一分钟呼吸稳定，再一步步梳理当前压力源。",
  escalationFlow: "命中高风险 -> 立即安全模板 -> 弹窗显示人工求助入口 -> 记录告警"
};

function seed() {
  const userCount = db.prepare("SELECT COUNT(*) AS cnt FROM users").get().cnt;
  if (userCount > 0) return; // already seeded

  const insertUser = db.prepare(`
    INSERT INTO users (id, name, age, gender, tags, short_term_memory, long_term_profile, verified_effective_strategies, memory_timeline)
    VALUES (@id, @name, @age, @gender, @tags, @shortTermMemory, @longTermProfile, @verifiedEffectiveStrategies, @memoryTimeline)
  `);

  for (const u of seedUsers) {
    insertUser.run(u);
  }

  const insertStrategy = db.prepare(`
    INSERT OR IGNORE INTO strategy_config (id, version, action_space, reward_immediate_mood, reward_long_term, reward_guideline,
      training_mode, training_meta_learning, training_online_fine_tune, ab_group_a, ab_group_b)
    VALUES (1, @version, @actionSpace, @rewardImmediateMood, @rewardLongTerm, @rewardGuideline,
      @trainingMode, @trainingMetaLearning, @trainingOnlineFineTune, @abGroupA, @abGroupB)
  `);
  insertStrategy.run(defaultStrategyConfig);

  const insertSafety = db.prepare(`
    INSERT OR IGNORE INTO safety_config (id, risk_rules, blocked_patterns, replacement_high, replacement_medium, escalation_flow)
    VALUES (1, @riskRules, @blockedPatterns, @replacementHigh, @replacementMedium, @escalationFlow)
  `);
  insertSafety.run(defaultSafetyConfig);
}

seed();

// ── Query helpers ───────────────────────────────────────────────────

function createId(prefix) {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now()}_${rand}`;
}

// ── User queries ────────────────────────────────────────────────────

function getUsers() {
  return db.prepare("SELECT id, name, age, tags FROM users ORDER BY id").all().map(u => ({
    ...u,
    tags: JSON.parse(u.tags || "[]")
  }));
}

function getUser(userId) {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
}

function getUserFull(userId) {
  const raw = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  if (!raw) return null;
  return {
    id: raw.id,
    name: raw.name,
    age: raw.age,
    gender: raw.gender,
    tags: JSON.parse(raw.tags || "[]"),
    shortTermMemory: JSON.parse(raw.short_term_memory || "[]"),
    longTermProfile: JSON.parse(raw.long_term_profile || "{}"),
    verifiedEffectiveStrategies: JSON.parse(raw.verified_effective_strategies || "[]"),
    memoryTimeline: JSON.parse(raw.memory_timeline || "[]")
  };
}

function upsertUserMemory(userId, summaryLine) {
  const user = getUser(userId);
  if (!user) return;
  const shortMem = JSON.parse(user.short_term_memory || "[]");
  shortMem.unshift(summaryLine);
  const trimmed = shortMem.slice(0, 8);

  const timeline = JSON.parse(user.memory_timeline || "[]");
  timeline.unshift({
    time: new Date().toISOString(),
    event: "会话记忆更新",
    detail: summaryLine
  });
  const trimmedTimeline = timeline.slice(0, 30);

  db.prepare(`
    UPDATE users SET short_term_memory = ?, memory_timeline = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(JSON.stringify(trimmed), JSON.stringify(trimmedTimeline), userId);
}

// ── Session queries ─────────────────────────────────────────────────

function createSession(sessionId, userId, startedAt) {
  db.prepare(`
    INSERT INTO sessions (id, user_id, status, started_at, current_emotion_time, timeline)
    VALUES (?, ?, 'active', ?, ?, ?)
  `).run(sessionId, userId, startedAt, startedAt, JSON.stringify([{
    id: createId("evt"),
    time: startedAt,
    type: "session_start",
    detail: "会话启动"
  }]));
}

function getSession(sessionId) {
  const raw = db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId);
  if (!raw) return null;

  const emotionTrend = db.prepare("SELECT id, label, confidence, time FROM eeg_events WHERE session_id = ? ORDER BY time").all(raw.id);
  const chatTurns = db.prepare("SELECT * FROM chat_turns WHERE session_id = ? ORDER BY time").all(raw.id).map(t => ({
    ...t,
    emotionAtTurn: { label: t.emotion_label, confidence: t.emotion_confidence },
    suggestions: JSON.parse(t.suggestions || "[]"),
    interventionState: t.intervention_track_key ? {
      trackKey: t.intervention_track_key,
      stepIndex: t.intervention_step_index,
      lastEmotion: null
    } : null
  }));
  const feedbackList = db.prepare("SELECT * FROM feedback WHERE session_id = ? ORDER BY time").all(raw.id);
  const safetyEvents = db.prepare("SELECT * FROM safety_logs WHERE session_id = ? ORDER BY time").all(raw.id);

  return {
    id: raw.id,
    userId: raw.user_id,
    startedAt: raw.started_at,
    endedAt: raw.ended_at,
    status: raw.status,
    currentEmotion: {
      label: raw.current_emotion_label,
      confidence: raw.current_emotion_confidence,
      time: raw.current_emotion_time
    },
    emotionTrend,
    chatTurns,
    feedback: feedbackList,
    safetyEvents,
    timeline: JSON.parse(raw.timeline || "[]"),
    interventionState: {
      trackKey: raw.intervention_track_key,
      stepIndex: raw.intervention_step_index,
      lastEmotion: raw.intervention_last_emotion
    }
  };
}

function endSession(sessionId) {
  const now = new Date().toISOString();
  db.prepare("UPDATE sessions SET status = 'ended', ended_at = ? WHERE id = ?").run(now, sessionId);
}

function getSessions() {
  const rows = db.prepare(`
    SELECT s.id, s.user_id, s.status, s.started_at, s.ended_at, s.current_emotion_label, s.current_emotion_confidence,
           u.name AS user_name,
           (SELECT COUNT(*) FROM chat_turns WHERE session_id = s.id) AS message_count
    FROM sessions s JOIN users u ON s.user_id = u.id
    ORDER BY s.started_at DESC
  `).all();

  return rows.map(r => ({
    id: r.id,
    userId: r.user_id,
    userName: r.user_name,
    status: r.status,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    messageCount: r.message_count,
    latestEmotion: { label: r.current_emotion_label, confidence: r.current_emotion_confidence }
  }));
}

function updateSessionEmotion(sessionId, label, confidence, time) {
  db.prepare(`
    UPDATE sessions SET current_emotion_label = ?, current_emotion_confidence = ?, current_emotion_time = ?
    WHERE id = ?
  `).run(label, confidence, time, sessionId);
}

function updateSessionIntervention(sessionId, trackKey, stepIndex, lastEmotion) {
  db.prepare(`
    UPDATE sessions SET intervention_track_key = ?, intervention_step_index = ?, intervention_last_emotion = ?
    WHERE id = ?
  `).run(trackKey, stepIndex, lastEmotion, sessionId);
}

function appendSessionTimeline(sessionId, entry) {
  const session = db.prepare("SELECT timeline FROM sessions WHERE id = ?").get(sessionId);
  if (!session) return;
  const timeline = JSON.parse(session.timeline || "[]");
  timeline.push(entry);
  db.prepare("UPDATE sessions SET timeline = ? WHERE id = ?").run(JSON.stringify(timeline), sessionId);
}

// ── EEG queries ─────────────────────────────────────────────────────

function insertEEGEvent(id, sessionId, label, confidence, time) {
  db.prepare("INSERT INTO eeg_events (id, session_id, label, confidence, time) VALUES (?,?,?,?,?)")
    .run(id, sessionId, label, confidence, time);
}

// ── Chat queries ────────────────────────────────────────────────────

function insertChatTurn(turn) {
  db.prepare(`
    INSERT INTO chat_turns (id, session_id, user_text, assistant_text, safety_level, emotion_label, emotion_confidence,
      suggestions, llm_source, llm_error, intervention_track_key, intervention_step_index, time)
    VALUES (@id, @sessionId, @userText, @assistantText, @safetyLevel, @emotionLabel, @emotionConfidence,
      @suggestions, @llmSource, @llmError, @interventionTrackKey, @interventionStepIndex, @time)
  `).run({
    id: turn.id,
    sessionId: turn.sessionId,
    userText: turn.userText,
    assistantText: turn.assistantText,
    safetyLevel: turn.safetyLevel,
    emotionLabel: turn.emotionLabel || null,
    emotionConfidence: turn.emotionConfidence ?? null,
    suggestions: JSON.stringify(turn.suggestions || []),
    llmSource: turn.llmSource || "unknown",
    llmError: turn.llmError || null,
    interventionTrackKey: turn.interventionTrackKey || null,
    interventionStepIndex: turn.interventionStepIndex ?? null,
    time: turn.time
  });
}

// ── Feedback queries ────────────────────────────────────────────────

function insertFeedback(fb) {
  db.prepare("INSERT INTO feedback (id, session_id, turn_id, helpful, mood_delta, note, time) VALUES (?,?,?,?,?,?,?)")
    .run(fb.id, fb.sessionId, fb.turnId, fb.helpful ? 1 : 0, fb.moodDelta, fb.note, fb.time);
}

// ── Safety queries ──────────────────────────────────────────────────

function insertSafetyLog(log) {
  db.prepare("INSERT INTO safety_logs (id, session_id, level, reason, source, time) VALUES (?,?,?,?,?,?)")
    .run(log.id, log.sessionId, log.level, log.reason, log.source, log.time);
}

function getSafetyLogs(limit = 200) {
  return db.prepare("SELECT * FROM safety_logs ORDER BY time DESC LIMIT ?").all(limit);
}

function getSafetyConfig() {
  const raw = db.prepare("SELECT * FROM safety_config WHERE id = 1").get();
  if (!raw) return null;
  return {
    riskRules: JSON.parse(raw.risk_rules || "[]"),
    blockedPatterns: JSON.parse(raw.blocked_patterns || "[]"),
    replacementTemplates: {
      high: raw.replacement_high || "",
      medium: raw.replacement_medium || ""
    },
    escalationFlow: raw.escalation_flow || ""
  };
}

function updateSafetyConfig(config) {
  db.prepare(`
    UPDATE safety_config SET
      risk_rules = ?, blocked_patterns = ?, replacement_high = ?, replacement_medium = ?,
      escalation_flow = ?, updated_at = datetime('now')
    WHERE id = 1
  `).run(
    JSON.stringify(config.riskRules || []),
    JSON.stringify(config.blockedPatterns || []),
    config.replacementTemplates?.high || "",
    config.replacementTemplates?.medium || "",
    config.escalationFlow || ""
  );
}

function getSafetyAnalytics() {
  const now = Date.now();

  const totalRow = db.prepare("SELECT COUNT(*) AS cnt FROM safety_logs").get();
  const highRow = db.prepare("SELECT COUNT(*) AS cnt FROM safety_logs WHERE level = 'high'").get();
  const mediumRow = db.prepare("SELECT COUNT(*) AS cnt FROM safety_logs WHERE level = 'medium'").get();
  const lowRow = db.prepare("SELECT COUNT(*) AS cnt FROM safety_logs WHERE level = 'low'").get();
  const last24hRow = db.prepare(`
    SELECT COUNT(*) AS cnt FROM safety_logs
    WHERE (strftime('%s', 'now') - strftime('%s', time)) <= 86400
  `).get();

  // Per-hour trend for last 24 hours
  const byHour = [];
  for (let i = 23; i >= 0; i--) {
    const row = db.prepare(`
      SELECT COUNT(*) AS cnt FROM safety_logs
      WHERE time >= datetime('now', '-' || ? || ' hours')
      AND time < datetime('now', '-' || ? || ' hours')
    `).get(i + 1, i);
    byHour.push({ hour: new Date(now - i * 3600000).toISOString(), count: row.cnt });
  }

  // Top reasons
  const topReasons = db.prepare(`
    SELECT reason, COUNT(*) AS cnt FROM safety_logs
    GROUP BY reason ORDER BY cnt DESC LIMIT 8
  `).all().map(r => ({ reason: r.reason || "未标注原因", count: r.cnt }));

  return {
    totals: {
      total: totalRow.cnt,
      high: highRow.cnt,
      medium: mediumRow.cnt,
      low: lowRow.cnt,
      last24h: last24hRow.cnt
    },
    byLevel: { high: highRow.cnt, medium: mediumRow.cnt, low: lowRow.cnt, other: totalRow.cnt - highRow.cnt - mediumRow.cnt - lowRow.cnt },
    byHour,
    topReasons
  };
}

// ── Strategy queries ────────────────────────────────────────────────

function getStrategyConfig() {
  const raw = db.prepare("SELECT * FROM strategy_config WHERE id = 1").get();
  if (!raw) return null;
  return {
    version: raw.version,
    actionSpace: JSON.parse(raw.action_space || "[]"),
    rewardWeights: {
      immediateMoodGain: raw.reward_immediate_mood,
      longTermStability: raw.reward_long_term,
      clinicalGuidelineFit: raw.reward_guideline
    },
    training: {
      mode: raw.training_mode,
      metaLearning: Boolean(raw.training_meta_learning),
      onlineFineTune: Boolean(raw.training_online_fine_tune)
    },
    abTestPlaceholder: {
      groupA: raw.ab_group_a,
      groupB: raw.ab_group_b
    }
  };
}

function updateStrategyConfig(partial) {
  const current = getStrategyConfig() || {};
  const merged = { ...current, ...partial };

  db.prepare(`
    UPDATE strategy_config SET
      version = ?, action_space = ?,
      reward_immediate_mood = ?, reward_long_term = ?, reward_guideline = ?,
      updated_at = datetime('now')
    WHERE id = 1
  `).run(
    merged.version || "v0.1",
    JSON.stringify(merged.actionSpace || []),
    merged.rewardWeights?.immediateMoodGain ?? 0.5,
    merged.rewardWeights?.longTermStability ?? 0.3,
    merged.rewardWeights?.clinicalGuidelineFit ?? 0.2
  );
}

// ── Dashboard ───────────────────────────────────────────────────────

function getDashboard() {
  const todayStr = new Date().toISOString().slice(0, 10);
  const todaySessions = db.prepare(`
    SELECT COUNT(*) AS cnt FROM sessions WHERE started_at LIKE ?
  `).get(todayStr + "%").cnt;

  const riskAlerts = db.prepare(`
    SELECT COUNT(*) AS cnt FROM safety_logs WHERE time LIKE ?
  `).get(todayStr + "%").cnt;

  const feedbackRows = db.prepare(`
    SELECT mood_delta FROM feedback f JOIN sessions s ON f.session_id = s.id
  `).all();
  const moodDeltas = feedbackRows.map(r => r.mood_delta).filter(n => !Number.isNaN(n));
  const avgMood = moodDeltas.length > 0 ? moodDeltas.reduce((a, b) => a + b, 0) / moodDeltas.length : 0;

  const deepseekKey = process.env.DEEPSEEK_API_KEY || "";

  return {
    todaySessionCount: todaySessions,
    riskAlertCount: riskAlerts,
    avgMoodDelta: Number(avgMood.toFixed(2)),
    systemStatus: {
      eeg: "online",
      llm: deepseekKey ? `deepseek-ready (${process.env.DEEPSEEK_MODEL || "deepseek-v4-flash"})` : "mock-fallback(no-key)",
      db: "sqlite-persistent"
    }
  };
}

// ── Evaluation ──────────────────────────────────────────────────────

function getEvaluation() {
  const totalTurns = db.prepare("SELECT COUNT(*) AS cnt FROM chat_turns").get().cnt;
  const totalFeedback = db.prepare("SELECT COUNT(*) AS cnt FROM feedback").get().cnt;
  const helpfulCount = db.prepare("SELECT COUNT(*) AS cnt FROM feedback WHERE helpful = 1").get().cnt;
  const helpfulRate = totalFeedback > 0 ? helpfulCount / totalFeedback : 0;

  return {
    modelMetrics: {
      emotionAcc: 0.5718,
      f1Macro: 0.54,
      crossDeviceScore: 0.49
    },
    interventionMetrics: {
      totalTurns,
      totalFeedback,
      helpfulRate: Number(helpfulRate.toFixed(2))
    },
    exportItems: [
      "论文图表占位导出",
      "实验日志CSV占位导出",
      "软著材料清单模板"
    ]
  };
}

// ── EEG Import queries ─────────────────────────────────────────────

function createEEGImport(imp) {
  db.prepare(`
    INSERT INTO eeg_imports (id, session_id, filename, channel_count, sample_count,
      duration_sec, sample_rate, device, format_type, detected_emotion_label,
      detected_emotion_confidence, time)
    VALUES (@id, @sessionId, @filename, @channelCount, @sampleCount,
      @durationSec, @sampleRate, @device, @formatType, @detectedEmotionLabel,
      @detectedEmotionConfidence, @time)
  `).run({
    id: imp.id,
    sessionId: imp.sessionId || null,
    filename: imp.filename,
    channelCount: imp.channelCount || 0,
    sampleCount: imp.sampleCount || 0,
    durationSec: imp.durationSec || 0,
    sampleRate: imp.sampleRate || null,
    device: imp.device || null,
    formatType: imp.formatType || "raw",
    detectedEmotionLabel: imp.detectedEmotionLabel || null,
    detectedEmotionConfidence: imp.detectedEmotionConfidence || null,
    time: imp.time
  });
}

function insertEEGChannel(ch) {
  db.prepare(`
    INSERT INTO eeg_channels (id, import_id, channel_name, band, value)
    VALUES (@id, @importId, @channelName, @band, @value)
  `).run({
    id: ch.id,
    importId: ch.importId,
    channelName: ch.channelName,
    band: ch.band || null,
    value: ch.value
  });
}

function getEEGImports(sessionId) {
  return db.prepare("SELECT * FROM eeg_imports WHERE session_id = ? ORDER BY time DESC").all(sessionId);
}

function getEEGImportChannels(importId) {
  return db.prepare("SELECT * FROM eeg_channels WHERE import_id = ? ORDER BY channel_name, band").all(importId);
}

function getEEGImportFull(importId) {
  const imp = db.prepare("SELECT * FROM eeg_imports WHERE id = ?").get(importId);
  if (!imp) return null;
  const channels = db.prepare("SELECT * FROM eeg_channels WHERE import_id = ? ORDER BY channel_name, band").all(importId);
  return { ...imp, channels };
}

// ── Export ──────────────────────────────────────────────────────────

function insertExport(record) {
  db.prepare("INSERT INTO export_records (id, kind, status, time) VALUES (?,?,?,?)")
    .run(record.id, record.kind, record.status, record.time);
}

module.exports = {
  db,
  createId,
  getUsers,
  getUser,
  getUserFull,
  upsertUserMemory,
  createSession,
  getSession,
  endSession,
  getSessions,
  updateSessionEmotion,
  updateSessionIntervention,
  appendSessionTimeline,
  insertEEGEvent,
  insertChatTurn,
  insertFeedback,
  insertSafetyLog,
  getSafetyLogs,
  getSafetyConfig,
  updateSafetyConfig,
  getSafetyAnalytics,
  getStrategyConfig,
  updateStrategyConfig,
  getDashboard,
  getEvaluation,
  insertExport,
  createEEGImport,
  insertEEGChannel,
  getEEGImports,
  getEEGImportChannels,
  getEEGImportFull
};
