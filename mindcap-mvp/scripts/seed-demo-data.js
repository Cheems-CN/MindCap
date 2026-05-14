/**
 * Demo data seeding script.
 * Populates the database with realistic historical sessions, conversations,
 * EEG imports, feedback, and track learning data.
 *
 * Usage: node scripts/seed-demo-data.js
 */
const db = require("../server/db");

console.log("Seeding demo data...\n");

// ── Simulated conversations ──────────────────────────────────────

const conversations = [
  // User u001 - anxiety/fear scenarios
  {
    userId: "u001",
    emotions: ["anxiety", "anxiety", "anxiety"],
    track: "breathing",
    messages: [
      { user: "我下周要做一个重要的课堂展示，现在想起来就心慌", feedback: { helpful: true, moodDelta: 0.2 } },
      { user: "刚才试了那个呼吸法，好像心跳慢了一点点", feedback: { helpful: true, moodDelta: 0.3 } },
      { user: "还是有点紧张，但比刚才好一些了", feedback: { helpful: true, moodDelta: 0.15 } },
    ]
  },
  {
    userId: "u001",
    emotions: ["stress", "stress", "stress"],
    track: "task",
    messages: [
      { user: "这学期四门课的期末作业堆在一起了，不知道该先做哪个", feedback: { helpful: true, moodDelta: 0.25 } },
      { user: "我把三件事列出来了，果然最紧急的是后天要交的那篇论文", feedback: { helpful: true, moodDelta: 0.3 } },
      { user: "其实写起来没那么难，我就是一开始被吓到了", feedback: { helpful: true, moodDelta: 0.35 } },
    ]
  },
  {
    userId: "u001",
    emotions: ["sad", "sad", "neutral"],
    track: "grounding",
    messages: [
      { user: "最近总是莫名其妙的感到低落，做什么都提不起劲", feedback: { helpful: true, moodDelta: 0.1 } },
      { user: "做了那个感官定位，发现自己其实在一个很安全的环境里", feedback: { helpful: true, moodDelta: 0.2 } },
      { user: "今天比昨天好一点了，至少完成了基本的事情", feedback: { helpful: false, moodDelta: 0.05 } },
    ]
  },
  // User u002 - social anxiety
  {
    userId: "u002",
    emotions: ["anxiety", "anxiety", "calm"],
    track: "social",
    messages: [
      { user: "明天有一个部门团建，想到要跟不熟的同事吃饭就紧张", feedback: { helpful: true, moodDelta: 0.15 } },
      { user: "我写好了一句开场白：'嗨，你是哪个部门的？我对你们的项目挺感兴趣的'", feedback: { helpful: true, moodDelta: 0.25 } },
      { user: "团建结束了！我主动跟三个人打了招呼，比预想的好", feedback: { helpful: true, moodDelta: 0.4 } },
    ]
  },
  {
    userId: "u002",
    emotions: ["stress", "stress", "calm"],
    track: "task",
    messages: [
      { user: "手上的项目进度落后了，老板虽然没有催但我自己压力很大", feedback: { helpful: true, moodDelta: 0.2 } },
      { user: "拆成小任务之后感觉清晰多了，今天先把数据整理完", feedback: { helpful: true, moodDelta: 0.3 } },
      { user: "今天完成了三个子任务，虽然加班了但不再那么焦虑了", feedback: { helpful: true, moodDelta: 0.35 } },
    ]
  },
];

// ── Create sessions and populate data ────────────────────────────

for (const conv of conversations) {
  const sessionId = db.createId("sess");
  const startedAt = new Date(Date.now() - Math.random() * 7 * 24 * 3600 * 1000).toISOString();
  db.createSession(sessionId, conv.userId, startedAt);

  console.log(`Session ${sessionId}: ${conv.userId} (${conv.emotions.length} turns)`);

  for (let i = 0; i < conv.messages.length; i++) {
    const turn = conv.messages[i];
    const emotionLabel = conv.emotions[i];
    const turnId = db.createId("turn");
    const turnTime = new Date(new Date(startedAt).getTime() + (i + 1) * 120000).toISOString();

    // Push EEG
    const eegId = db.createId("eeg");
    db.insertEEGEvent(eegId, sessionId, emotionLabel, 0.7 + Math.random() * 0.2, turnTime);
    db.updateSessionEmotion(sessionId, emotionLabel, 0.7 + Math.random() * 0.2, turnTime);

    // Build mock reply
    const assistantText = `[Mock回复] 听到你的分享，我们先稳住状态。${conv.track === "breathing" ? "做一次深呼吸" : conv.track === "task" ? "列一个清单" : conv.track === "grounding" ? "回到当下" : "试着迈出一小步"}，然后我们一步步梳理。`;

    // Insert chat turn
    db.insertChatTurn({
      id: turnId, sessionId,
      userText: turn.user, assistantText,
      safetyLevel: "normal",
      emotionLabel, emotionConfidence: 0.75,
      suggestions: JSON.stringify(["Demo建议1", "Demo建议2"]),
      llmSource: "mock-seed", llmError: null,
      interventionTrackKey: conv.track, interventionStepIndex: i,
      time: turnTime
    });

    // Feedback with learning
    const fbId = db.createId("fb");
    db.insertFeedback({
      id: fbId, sessionId, turnId,
      helpful: turn.feedback.helpful,
      moodDelta: turn.feedback.moodDelta,
      note: turn.feedback.helpful ? "种子数据-有帮助" : "种子数据-无帮助",
      time: new Date(new Date(turnTime).getTime() + 30000).toISOString()
    });

    // Record to track_stats
    db.upsertTrackStat(emotionLabel, conv.track, turn.feedback.helpful, turn.feedback.moodDelta);

    // Update intervention state
    db.updateSessionIntervention(sessionId, conv.track, i, emotionLabel);
  }

  // End session
  db.endSession(sessionId);
  console.log(`  Ended. Track: ${conv.track}, Emotions: ${conv.emotions.join(" → ")}`);
}

// ── Add multiple EEG imports for variety ─────────────────────────

const importSessions = db.getSessions();
for (let i = 0; i < 3; i++) {
  if (importSessions.length === 0) break;
  const s = importSessions[i % importSessions.length];
  const importId = db.createId("eegimp");
  const channels = ["AF3", "AF4", "F3", "F4"];
  db.createEEGImport({
    id: importId, sessionId: s.id,
    filename: `demo_eeg_${i + 1}.csv`,
    channelCount: 4, sampleCount: 30,
    durationSec: 0.5, sampleRate: 128,
    device: "DEMO-Device", formatType: "bands",
    detectedEmotionLabel: ["anxiety", "stress", "calm"][i],
    detectedEmotionConfidence: 0.7 + Math.random() * 0.2,
    time: new Date().toISOString()
  });
  // Add channel records
  const bands = ["delta", "theta", "alpha", "beta", "gamma"];
  for (const chName of channels) {
    for (const band of bands) {
      db.insertEEGChannel({
        id: db.createId("eegch"), importId,
        channelName: chName, band,
        value: Math.random() * 2
      });
    }
  }
  console.log(`EEG Import ${importId}: ${["anxiety", "stress", "calm"][i]}`);
}

// ── Summary ──────────────────────────────────────────────────────

const sessionCount = db.db.prepare("SELECT COUNT(*) AS cnt FROM sessions").get().cnt;
const turnCount = db.db.prepare("SELECT COUNT(*) AS cnt FROM chat_turns").get().cnt;
const feedbackCount = db.db.prepare("SELECT COUNT(*) AS cnt FROM feedback").get().cnt;
const trackCount = db.db.prepare("SELECT COUNT(*) AS cnt FROM track_stats").get().cnt;

console.log(`\n=== Demo Data Seeded ===`);
console.log(`Sessions: ${sessionCount}`);
console.log(`Chat turns: ${turnCount}`);
console.log(`Feedback: ${feedbackCount}`);
console.log(`Track stats: ${trackCount}`);
console.log(`Done.`);
