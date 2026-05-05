const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const { BufferWindowMemory, VectorStoreRetrieverMemory, CombinedMemory } = require("@langchain/classic/memory");
const { MemoryVectorStore } = require("@langchain/classic/vectorstores/memory");
const { Embeddings } = require("@langchain/core/embeddings");

const HOST = "127.0.0.1";
const PORT = process.env.PORT ? Number(process.env.PORT) : 5050;
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || "";
const DEEPSEEK_BASE_URL = (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(
  /\/+$/,
  ""
);
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-v4-flash";
const DEEPSEEK_TIMEOUT_MS = process.env.DEEPSEEK_TIMEOUT_MS
  ? Number(process.env.DEEPSEEK_TIMEOUT_MS)
  : 25000;
const LANGCHAIN_EMBED_DIM = 128;

const store = createSeedStore();
const sseClients = new Map();
const langchainMemoryRegistry = new Map();

function createSeedStore() {
  const now = new Date().toISOString();
  return {
    users: {
      u001: {
        id: "u001",
        name: "受试者A",
        age: 22,
        gender: "女",
        tags: ["学习压力", "睡眠不足"],
        shortTermMemory: ["昨天复盘时提到晚上入睡困难。"],
        longTermProfile: {
          triggers: ["考试周", "公开展示"],
          preferredInterventions: ["呼吸放松", "结构化鼓励"],
          avoidTopics: ["高压绩效对比"]
        },
        verifiedEffectiveStrategies: ["4-7-8呼吸法", "番茄钟拆解任务"],
        memoryTimeline: [
          {
            time: now,
            event: "创建用户画像",
            detail: "录入初始压力触发因素与有效策略"
          }
        ]
      },
      u002: {
        id: "u002",
        name: "受试者B",
        age: 23,
        gender: "男",
        tags: ["社交焦虑"],
        shortTermMemory: ["上次会话中对即兴发言表现出明显紧张。"],
        longTermProfile: {
          triggers: ["陌生社交场景"],
          preferredInterventions: ["暴露分级练习", "积极自我陈述"],
          avoidTopics: []
        },
        verifiedEffectiveStrategies: ["3句自我鼓励脚本"],
        memoryTimeline: [
          {
            time: now,
            event: "创建用户画像",
            detail: "记录社交焦虑相关触发因素"
          }
        ]
      }
    },
    sessions: {},
    sessionOrder: [],
    strategyConfig: {
      version: "v0.1-mock",
      actionSpace: ["安抚对话", "呼吸引导", "认知重评", "任务分解建议"],
      rewardWeights: {
        immediateMoodGain: 0.5,
        longTermStability: 0.3,
        clinicalGuidelineFit: 0.2
      },
      training: {
        mode: "offline-mock",
        metaLearning: true,
        onlineFineTune: false
      },
      abTestPlaceholder: {
        groupA: "支持型语气",
        groupB: "教练型语气"
      }
    },
    safetyConfig: {
      riskRules: [
        { level: "high", name: "自伤风险语句", enabled: true },
        { level: "medium", name: "持续绝望表达", enabled: true },
        { level: "low", name: "轻度负面倾向", enabled: true }
      ],
      blockedPatterns: ["不想活了", "结束生命", "伤害自己"],
      replacementTemplates: {
        high:
          "我很重视你的安全。你现在的感受很重要，请优先联系身边可信任的人或当地紧急援助热线。",
        medium: "我听到了你的痛苦，我们先做一分钟呼吸稳定，再一步步梳理当前压力源。"
      },
      escalationFlow: "命中高风险 -> 立即安全模板 -> 弹窗显示人工求助入口 -> 记录告警"
    },
    safetyLogs: [],
    exports: []
  };
}

class DeterministicEmbeddings extends Embeddings {
  constructor() {
    super({});
    this.dimension = LANGCHAIN_EMBED_DIM;
  }

  hashToken(token) {
    let h = 2166136261;
    for (let i = 0; i < token.length; i += 1) {
      h ^= token.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return Math.abs(h >>> 0);
  }

  textToVector(text) {
    const vector = new Array(this.dimension).fill(0);
    const tokens = String(text || "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter(Boolean);
    if (!tokens.length) return vector;

    for (const token of tokens) {
      const h = this.hashToken(token);
      const idx = h % this.dimension;
      const sign = h % 2 === 0 ? 1 : -1;
      vector[idx] += sign;
    }

    const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0)) || 1;
    return vector.map((x) => x / norm);
  }

  async embedDocuments(documents) {
    return documents.map((doc) => this.textToVector(doc));
  }

  async embedQuery(document) {
    return this.textToVector(document);
  }
}

function buildProfileSeedRecords(user) {
  const records = [];
  const triggers = user?.longTermProfile?.triggers || [];
  const preferred = user?.longTermProfile?.preferredInterventions || [];
  const effective = user?.verifiedEffectiveStrategies || [];
  const shortMem = user?.shortTermMemory || [];

  if (triggers.length) {
    records.push(`用户压力触发因素：${triggers.join("、")}`);
  }
  if (preferred.length) {
    records.push(`用户偏好干预方式：${preferred.join("、")}`);
  }
  if (effective.length) {
    records.push(`历史有效策略：${effective.join("、")}`);
  }
  for (const line of shortMem.slice(0, 4)) {
    records.push(`短期记忆：${line}`);
  }
  return records;
}

function createLangChainMemoryRuntime(user) {
  const embeddings = new DeterministicEmbeddings();
  const vectorStore = new MemoryVectorStore(embeddings);
  const longMemory = new VectorStoreRetrieverMemory({
    vectorStoreRetriever: vectorStore.asRetriever(4),
    memoryKey: "long_term_memory",
    inputKey: "input",
    returnDocs: false,
    metadata: {
      userId: user.id
    }
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

  return {
    vectorStore,
    longMemory,
    shortMemory,
    combinedMemory,
    seeded: false
  };
}

async function ensureLangChainMemoryRuntime(user) {
  if (!user) return null;

  let runtime = langchainMemoryRegistry.get(user.id);
  if (!runtime) {
    runtime = createLangChainMemoryRuntime(user);
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

async function loadLangChainMemoryContext(runtime, message) {
  if (!runtime) {
    return {
      recentMemory: "",
      longTermMemory: ""
    };
  }

  const memoryVars = await runtime.combinedMemory.loadMemoryVariables({
    input: message
  });
  return {
    recentMemory: String(memoryVars.recent_memory || ""),
    longTermMemory: String(memoryVars.long_term_memory || "")
  };
}

async function persistLangChainMemory(runtime, userText, assistantText) {
  if (!runtime) return;
  await runtime.combinedMemory.saveContext(
    { input: userText },
    { output: assistantText }
  );
}

function createId(prefix) {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now()}_${rand}`;
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk.toString("utf8");
      if (data.length > 1_000_000) {
        reject(new Error("Payload too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!data) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js") return "application/javascript; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  return "application/octet-stream";
}

function serveStatic(req, res, pathname) {
  const cleanPath = pathname === "/" ? "/index.html" : pathname;
  const resolved = path.resolve(PUBLIC_DIR, `.${cleanPath}`);
  if (!resolved.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }
  fs.readFile(resolved, (err, content) => {
    if (err) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }
    res.writeHead(200, { "Content-Type": getMimeType(resolved) });
    res.end(content);
  });
}

function computeDashboard() {
  const sessions = Object.values(store.sessions);
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const todaySessionCount = sessions.filter((s) => s.startedAt.slice(0, 10) === todayStr).length;
  const riskAlertCount = store.safetyLogs.filter((log) => log.time.slice(0, 10) === todayStr).length;
  const feedbacks = sessions.flatMap((s) => s.feedback || []);
  const moodScores = feedbacks
    .map((f) => Number(f.moodDelta))
    .filter((n) => !Number.isNaN(n));
  const avgMoodDelta =
    moodScores.length > 0 ? moodScores.reduce((a, b) => a + b, 0) / moodScores.length : 0;

  return {
    todaySessionCount,
    riskAlertCount,
    avgMoodDelta: Number(avgMoodDelta.toFixed(2)),
    systemStatus: {
      eeg: "online",
      llm: DEEPSEEK_API_KEY ? `deepseek-ready (${DEEPSEEK_MODEL})` : "mock-fallback(no-key)",
      db: "memory-store-online"
    }
  };
}

function computeSafetyAnalytics() {
  const logs = store.safetyLogs || [];
  const now = Date.now();
  const last24h = logs.filter((log) => now - new Date(log.time).getTime() <= 24 * 60 * 60 * 1000);
  const byLevel = { high: 0, medium: 0, low: 0, other: 0 };

  for (const log of logs) {
    const key = String(log.level || "").toLowerCase();
    if (Object.prototype.hasOwnProperty.call(byLevel, key)) byLevel[key] += 1;
    else byLevel.other += 1;
  }

  const byHour = [];
  for (let i = 23; i >= 0; i -= 1) {
    const hourStart = new Date(now - i * 60 * 60 * 1000);
    hourStart.setMinutes(0, 0, 0);
    const hourEnd = new Date(hourStart.getTime() + 60 * 60 * 1000);
    const count = logs.filter((log) => {
      const t = new Date(log.time).getTime();
      return t >= hourStart.getTime() && t < hourEnd.getTime();
    }).length;
    byHour.push({
      hour: hourStart.toISOString(),
      count
    });
  }

  const reasonCount = {};
  for (const log of logs) {
    const reason = log.reason || "未标注原因";
    reasonCount[reason] = (reasonCount[reason] || 0) + 1;
  }
  const topReasons = Object.entries(reasonCount)
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  return {
    totals: {
      total: logs.length,
      high: byLevel.high,
      medium: byLevel.medium,
      low: byLevel.low,
      last24h: last24h.length
    },
    byLevel,
    byHour,
    topReasons
  };
}

function summarySession(session) {
  return {
    id: session.id,
    userId: session.userId,
    userName: store.users[session.userId]?.name || "未知用户",
    status: session.status,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    messageCount: session.chatTurns.length,
    latestEmotion: session.currentEmotion
  };
}

function pushTimeline(session, type, detail) {
  session.timeline.push({
    id: createId("evt"),
    time: new Date().toISOString(),
    type,
    detail
  });
}

function addSafetyLog(sessionId, level, reason, source) {
  const log = {
    id: createId("risk"),
    sessionId,
    level,
    reason,
    source,
    time: new Date().toISOString()
  };
  store.safetyLogs.push(log);
  const session = store.sessions[sessionId];
  if (session) {
    session.safetyEvents.push(log);
    pushTimeline(session, "safety_alert", `${level.toUpperCase()}: ${reason}`);
  }
  publishSessionEvent(sessionId, "safety", log);
  return log;
}

const interventionTracks = {
  breathing: {
    name: "呼吸稳定",
    keywords: ["焦虑", "紧张", "心慌", "stress", "anxiety", "呼吸", "胸闷"],
    steps: [
      "做60秒方块呼吸：吸4秒-停4秒-呼4秒-停4秒。",
      "继续90秒呼气延长：吸4秒、呼6秒，观察肩颈是否放松。",
      "把身体感受写成三词（例如：心跳快、肩紧、手冷），只做观察不评判。"
    ]
  },
  task: {
    name: "任务减压",
    keywords: ["考试", "任务", "ddl", "作业", "进度", "效率", "压力"],
    steps: [
      "列出当前最困扰的3件事，并圈出今天必须完成的1件。",
      "把这1件事拆成一个15分钟动作，马上启动计时。",
      "完成后写一句复盘：这一步比预想更难还是更容易。"
    ]
  },
  sleep: {
    name: "睡眠修复",
    keywords: ["失眠", "睡眠", "入睡", "夜醒", "疲惫"],
    steps: [
      "今晚固定一个关灯时间，并提前30分钟关闭高刺激内容。",
      "做2分钟腹式呼吸，把注意力放在呼气变长。",
      "若20分钟仍未入睡，起身做低刺激活动5分钟再回床。"
    ]
  },
  social: {
    name: "社交安定",
    keywords: ["社交", "发言", "陌生人", "尴尬", "评价"],
    steps: [
      "先写一句可复述开场白，并默念3遍。",
      "为下一次社交设定最小目标：只完成一次主动问候。",
      "事后记录1个做得好的点，强化可复制动作。"
    ]
  },
  grounding: {
    name: "情绪落地",
    keywords: ["低落", "悲伤", "空虚", "无力", "sad"],
    steps: [
      "做30秒5-4-3-2-1感官定位（看到5样、触到4样...）。",
      "给自己一句非苛责陈述：我现在很难受，但我在尝试自救。",
      "选择一个2分钟微行动（洗脸、喝温水、站立伸展）恢复掌控感。"
    ]
  }
};

function matchTrackByContext(contextText, preferredInterventions, currentMessage) {
  const combined = String(contextText || "").toLowerCase();
  const current = String(currentMessage || "").toLowerCase();
  const preferred = (preferredInterventions || []).join("、").toLowerCase();
  let bestKey = "task";
  let bestScore = -1;

  for (const [key, track] of Object.entries(interventionTracks)) {
    let score = 0;
    for (const keyword of track.keywords) {
      if (combined.includes(keyword.toLowerCase())) score += 2;
      if (current.includes(keyword.toLowerCase())) score += 5;
    }
    if (preferred && track.keywords.some((kw) => preferred.includes(kw.toLowerCase()))) score += 1;
    if (score > bestScore) {
      bestScore = score;
      bestKey = key;
    }
  }
  return bestKey;
}

function updateInterventionState(session, selectedTrackKey, emotionLabel) {
  if (!session.interventionState) {
    session.interventionState = {
      trackKey: selectedTrackKey,
      stepIndex: 0,
      lastEmotion: emotionLabel || "neutral"
    };
    return session.interventionState;
  }

  const state = session.interventionState;
  if (state.trackKey !== selectedTrackKey) {
    state.trackKey = selectedTrackKey;
    state.stepIndex = 0;
    state.lastEmotion = emotionLabel || "neutral";
    return state;
  }

  const track = interventionTracks[state.trackKey] || interventionTracks.task;
  const shouldAdvance = session.chatTurns.length >= 1;
  if (shouldAdvance && state.stepIndex < track.steps.length - 1) {
    state.stepIndex += 1;
  }
  state.lastEmotion = emotionLabel || "neutral";
  return state;
}

function buildMemoryAwareSuggestions({ session, user, emotion, memoryContext, currentMessage }) {
  const contextText = [
    memoryContext?.recentMemory || "",
    memoryContext?.longTermMemory || "",
    (user?.longTermProfile?.triggers || []).join("、"),
    (user?.shortTermMemory || []).join("、"),
    emotion?.label || ""
  ].join(" ");

  let defaultTrackKey = "task";
  if (emotion?.label === "anxiety" || emotion?.label === "stress") defaultTrackKey = "breathing";
  if (emotion?.label === "sad") defaultTrackKey = "grounding";

  const selectedTrackKey =
    matchTrackByContext(contextText, user?.longTermProfile?.preferredInterventions, currentMessage) || defaultTrackKey;
  const interventionState = updateInterventionState(session, selectedTrackKey, emotion?.label);
  const track = interventionTracks[interventionState.trackKey] || interventionTracks.task;
  const step = Math.max(0, Math.min(interventionState.stepIndex, track.steps.length - 1));

  const memoryAnchor =
    (user?.verifiedEffectiveStrategies || [])[0] ||
    (user?.longTermProfile?.preferredInterventions || [])[0] ||
    "先稳定呼吸再做最小动作";

  const continuation = `延续方案【${track.name}】第${step + 1}步：${track.steps[step]}`;
  const memoryBased = `记忆锚点：你历史上更有效的方式是「${memoryAnchor}」，本轮优先沿用。`;
  const followUp = "执行后告诉我：情绪强度从0-10变成了几分，我会按同一方案继续下一步。";

  return [continuation, memoryBased, followUp];
}

const builtInHighRiskRules = [
  { id: "cn_suicide", pattern: /自杀|想自杀|我想死|想死|去死|轻生/iu, reason: "命中自杀/轻生意图" },
  { id: "cn_end_life", pattern: /(结束|了结).{0,4}(生命|自己)/iu, reason: "命中结束生命表达" },
  { id: "cn_not_live", pattern: /不想活了?|活着没意义/iu, reason: "命中绝望生存表达" },
  { id: "en_suicide", pattern: /suicide|kill\s*myself|end\s*my\s*life|don't\s*want\s*to\s*live/iu, reason: "命中英文自伤表达" }
];

function normalizeRiskText(input) {
  return String(input || "")
    .toLowerCase()
    .replace(/[\s\r\n\t]/g, "")
    .replace(/[.,!?;:，。！？；：、'"`~\-_/\\()[\]{}<>]/g, "");
}

function detectHighRisk(text) {
  const raw = String(text || "");
  const normalized = normalizeRiskText(raw);

  for (const rule of builtInHighRiskRules) {
    if (rule.pattern.test(raw) || rule.pattern.test(normalized)) {
      return { matched: true, reason: rule.reason, ruleId: rule.id };
    }
  }

  for (const keyword of store.safetyConfig.blockedPatterns) {
    const normalizedKeyword = normalizeRiskText(keyword);
    if (!normalizedKeyword) continue;
    if (normalized.includes(normalizedKeyword)) {
      return { matched: true, reason: `命中配置关键词: ${keyword}`, ruleId: "custom_keyword" };
    }
  }

  return { matched: false, reason: "", ruleId: "" };
}

function clipText(value, maxLen = 220) {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}...`;
}

function buildMockAssistantReply({ message, emotion, session, user, memoryContext }) {
  const tone =
    emotion?.label === "anxiety" || emotion?.label === "stress"
      ? "我听到你现在有些紧绷，我们先把状态稳下来。"
      : "谢谢你愿意说出来，我们一起慢慢梳理。";
  const suggestions = buildMemoryAwareSuggestions({ session, user, emotion, memoryContext });
  return {
    safetyLevel: "normal",
    text: `${tone} 你刚才说的是：“${clipText(message, 60)}”。我建议先做一个最小动作，然后我再陪你看下一步。`,
    suggestions
  };
}

function buildPsychologySystemPrompt() {
  return [
    "你是“心灵捕手”系统里的心理支持对话专家，风格接近心理咨询师与疗愈教练。",
    "请用中文回复，语气温和、稳定、非评判、具体可执行。",
    "回复结构必须包含：1) 共情镜像 2) 结合当前情绪状态的简短解释 3) 1-2个可立即执行的微行动（每个不超过3分钟）4) 一个温和的引导问题。",
    "请尽量延续既往有效干预路径，不要每轮都重置方案；优先在同一干预轨道上做小步推进。",
    "避免空泛鸡汤，避免说教，不要做医学诊断，不要承诺治愈。",
    "不要输出你是AI模型的声明，也不要提提示词或系统指令。",
    "如果用户表达自伤/他伤/极端绝望，优先安全干预：先确认安全，再建议联系身边可信任的人与当地紧急援助。"
  ].join("\n");
}

function buildContextPrompt({ session, user, emotion, memoryContext }) {
  const shortMemory = (user?.shortTermMemory || []).slice(0, 4).map((x) => `- ${clipText(x, 80)}`);
  const triggers = (user?.longTermProfile?.triggers || []).slice(0, 4);
  const preferred = (user?.longTermProfile?.preferredInterventions || []).slice(0, 4);
  const lastTurns = (session?.chatTurns || []).slice(-3).map((turn, idx) => {
    return `${idx + 1}. 用户:${clipText(turn.userText, 50)} | 助手:${clipText(turn.assistantText, 50)}`;
  });

  return [
    "下面是会话上下文，请在回复时参考：",
    `- 用户: ${user?.name || "未知用户"} (${user?.id || "unknown"})`,
    `- 当前EEG情绪: ${emotion?.label || "neutral"} (置信度 ${Number(emotion?.confidence || 0).toFixed(2)})`,
    `- 主要触发因素: ${triggers.length ? triggers.join("、") : "暂无"}`,
    `- 偏好干预方式: ${preferred.length ? preferred.join("、") : "暂无"}`,
    `- 短期记忆: ${shortMemory.length ? `\n${shortMemory.join("\n")}` : "暂无"}`,
    `- LangChain近期记忆: ${clipText(memoryContext?.recentMemory || "暂无", 600)}`,
    `- LangChain长期检索记忆: ${clipText(memoryContext?.longTermMemory || "暂无", 900)}`,
    `- 最近对话摘要: ${lastTurns.length ? `\n${lastTurns.join("\n")}` : "暂无"}`
  ].join("\n");
}

function buildDeepSeekMessages({ session, user, emotion, message, memoryContext }) {
  const messages = [
    {
      role: "system",
      content: buildPsychologySystemPrompt()
    },
    {
      role: "system",
      content: buildContextPrompt({ session, user, emotion, memoryContext })
    }
  ];

  const recentTurns = (session?.chatTurns || []).slice(-6);
  for (const turn of recentTurns) {
    messages.push({ role: "user", content: clipText(turn.userText, 600) });
    messages.push({ role: "assistant", content: clipText(turn.assistantText, 800) });
  }
  messages.push({ role: "user", content: clipText(message, 1200) });
  return messages;
}

function extractAssistantContent(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === "string") {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item.text === "string") return item.text;
        return "";
      })
      .join("")
      .trim();
  }
  return "";
}

async function callDeepSeekChat(messages) {
  const controller = new AbortController();
  const timeout = Number.isFinite(DEEPSEEK_TIMEOUT_MS) && DEEPSEEK_TIMEOUT_MS > 0 ? DEEPSEEK_TIMEOUT_MS : 25000;
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        messages,
        thinking: { type: "disabled" },
        max_tokens: 500,
        temperature: 1.05,
        stream: false
      }),
      signal: controller.signal
    });

    const rawText = await response.text();
    if (!response.ok) {
      throw new Error(`DeepSeek API ${response.status}: ${clipText(rawText, 260)}`);
    }

    let payload;
    try {
      payload = JSON.parse(rawText);
    } catch (err) {
      throw new Error(`DeepSeek response parse failed: ${err.message}`);
    }

    const content = extractAssistantContent(payload);
    if (!content) {
      throw new Error("DeepSeek returned empty assistant content");
    }
    return content;
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`DeepSeek timeout after ${timeout}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function buildAssistantReply({ message, emotion, session, user }) {
  const runtime = await ensureLangChainMemoryRuntime(user);
  const memoryContext = await loadLangChainMemoryContext(runtime, message);
  const riskResult = detectHighRisk(message);
  if (riskResult.matched) {
    return {
      safetyLevel: "high",
      text: store.safetyConfig.replacementTemplates.high,
      suggestions: [
        "如果你有立即风险，请马上联系当地紧急服务。",
        "可以先告诉我你现在是否独处，我会继续陪你。"
      ],
      llmSource: "safety-template",
      riskReason: riskResult.reason,
      memoryContext,
      runtime
    };
  }

  if (!DEEPSEEK_API_KEY) {
    const mockReply = buildMockAssistantReply({ message, emotion, session, user, memoryContext });
    return {
      ...mockReply,
      llmSource: "mock-no-key",
      memoryContext,
      runtime
    };
  }

  try {
    const messages = buildDeepSeekMessages({ session, user, emotion, message, memoryContext });
    const content = await callDeepSeekChat(messages);
    return {
      safetyLevel: "normal",
      text: content,
      suggestions: buildMemoryAwareSuggestions({ session, user, emotion, memoryContext }),
      llmSource: "deepseek",
      memoryContext,
      runtime
    };
  } catch (err) {
    const fallback = buildMockAssistantReply({ message, emotion, session, user, memoryContext });
    return {
      ...fallback,
      text: `${fallback.text}\n\n[系统提示] DeepSeek调用异常，已自动回退到样板回复。`,
      llmSource: "mock-fallback",
      llmError: err.message,
      memoryContext,
      runtime
    };
  }
}

function upsertUserMemory(userId, summaryLine) {
  const user = store.users[userId];
  if (!user) return;
  user.shortTermMemory.unshift(summaryLine);
  user.shortTermMemory = user.shortTermMemory.slice(0, 8);
  user.memoryTimeline.unshift({
    time: new Date().toISOString(),
    event: "会话记忆更新",
    detail: summaryLine
  });
  user.memoryTimeline = user.memoryTimeline.slice(0, 30);
}

function publishSessionEvent(sessionId, eventName, payload) {
  const set = sseClients.get(sessionId);
  if (!set) return;
  const line = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of set) {
    res.write(line);
  }
}

function ensureSession(id) {
  const session = store.sessions[id];
  if (!session) return null;
  return session;
}

async function handleApi(req, res, urlObj) {
  const { pathname } = urlObj;

  if (req.method === "GET" && pathname === "/api/health") {
    sendJson(res, 200, {
      ok: true,
      time: new Date().toISOString(),
      llm: {
        provider: "deepseek",
        enabled: Boolean(DEEPSEEK_API_KEY),
        model: DEEPSEEK_MODEL,
        baseUrl: DEEPSEEK_BASE_URL
      }
    });
    return true;
  }

  if (req.method === "GET" && pathname === "/api/users") {
    const users = Object.values(store.users).map((u) => ({
      id: u.id,
      name: u.name,
      age: u.age,
      tags: u.tags
    }));
    sendJson(res, 200, { users });
    return true;
  }

  if (req.method === "POST" && pathname === "/api/session/start") {
    const body = await parseBody(req).catch((err) => ({ __error: err.message }));
    if (body.__error) {
      sendJson(res, 400, { error: body.__error });
      return true;
    }
    const userId = body.userId;
    if (!store.users[userId]) {
      sendJson(res, 400, { error: "Invalid userId" });
      return true;
    }
    const sessionId = createId("sess");
    const startedAt = new Date().toISOString();
    const session = {
      id: sessionId,
      userId,
      startedAt,
      endedAt: null,
      status: "active",
      currentEmotion: {
        label: "neutral",
        confidence: 0.5,
        time: startedAt
      },
      emotionTrend: [],
      chatTurns: [],
      feedback: [],
      safetyEvents: [],
      timeline: [],
      interventionState: {
        trackKey: "task",
        stepIndex: 0,
        lastEmotion: "neutral"
      }
    };
    pushTimeline(session, "session_start", "会话启动");
    store.sessions[sessionId] = session;
    store.sessionOrder.unshift(sessionId);
    sendJson(res, 200, {
      sessionId,
      startedAt,
      user: store.users[userId]
    });
    return true;
  }

  if (req.method === "POST" && pathname === "/api/session/end") {
    const body = await parseBody(req).catch((err) => ({ __error: err.message }));
    if (body.__error) {
      sendJson(res, 400, { error: body.__error });
      return true;
    }
    const session = ensureSession(body.sessionId);
    if (!session) {
      sendJson(res, 404, { error: "Session not found" });
      return true;
    }
    session.status = "ended";
    session.endedAt = new Date().toISOString();
    pushTimeline(session, "session_end", "会话结束");
    publishSessionEvent(session.id, "session_end", { sessionId: session.id, endedAt: session.endedAt });
    sendJson(res, 200, { ok: true, session: summarySession(session) });
    return true;
  }

  if (req.method === "POST" && pathname === "/api/eeg/push") {
    const body = await parseBody(req).catch((err) => ({ __error: err.message }));
    if (body.__error) {
      sendJson(res, 400, { error: body.__error });
      return true;
    }
    const session = ensureSession(body.sessionId);
    if (!session) {
      sendJson(res, 404, { error: "Session not found" });
      return true;
    }
    const event = {
      id: createId("eeg"),
      label: body.label || "neutral",
      confidence: Number(body.confidence || 0.5),
      time: body.time || new Date().toISOString()
    };
    session.currentEmotion = {
      label: event.label,
      confidence: event.confidence,
      time: event.time
    };
    session.emotionTrend.push(event);
    session.emotionTrend = session.emotionTrend.slice(-100);
    pushTimeline(session, "eeg_update", `${event.label} (${event.confidence.toFixed(2)})`);

    if (
      (event.label === "sad" || event.label === "anxiety" || event.label === "stress") &&
      event.confidence >= 0.85
    ) {
      addSafetyLog(session.id, "medium", `EEG高置信负性情绪: ${event.label}`, "eeg");
    }

    publishSessionEvent(session.id, "eeg", event);
    sendJson(res, 200, { ok: true, currentEmotion: session.currentEmotion });
    return true;
  }

  if (req.method === "POST" && pathname === "/api/chat/send") {
    const body = await parseBody(req).catch((err) => ({ __error: err.message }));
    if (body.__error) {
      sendJson(res, 400, { error: body.__error });
      return true;
    }
    const session = ensureSession(body.sessionId);
    if (!session) {
      sendJson(res, 404, { error: "Session not found" });
      return true;
    }
    const userText = String(body.message || "").trim();
    if (!userText) {
      sendJson(res, 400, { error: "Message is empty" });
      return true;
    }
    const reply = await buildAssistantReply({
      message: userText,
      emotion: session.currentEmotion,
      session,
      user: store.users[session.userId]
    });
    const turnId = createId("turn");
    const turn = {
      id: turnId,
      time: new Date().toISOString(),
      userText,
      assistantText: reply.text,
      safetyLevel: reply.safetyLevel,
      emotionAtTurn: session.currentEmotion,
      suggestions: reply.suggestions,
      llmSource: reply.llmSource || "unknown",
      llmError: reply.llmError || null,
      interventionState: session.interventionState || null
    };
    session.chatTurns.push(turn);
    pushTimeline(session, "chat_turn", `用户输入 + AI回复 (${reply.safetyLevel})`);
    upsertUserMemory(session.userId, `最近对话要点: ${userText.slice(0, 32)}`);
    await persistLangChainMemory(reply.runtime, userText, reply.text);

    if (reply.safetyLevel === "high") {
      addSafetyLog(session.id, "high", reply.riskReason || "命中高风险关键词", "chat");
    }

    publishSessionEvent(session.id, "chat", turn);
    sendJson(res, 200, {
      turnId,
      assistantMessage: reply.text,
      safetyLevel: reply.safetyLevel,
      suggestions: reply.suggestions,
      llmSource: reply.llmSource,
      interventionState: session.interventionState || null
    });
    return true;
  }

  if (req.method === "POST" && pathname === "/api/feedback") {
    const body = await parseBody(req).catch((err) => ({ __error: err.message }));
    if (body.__error) {
      sendJson(res, 400, { error: body.__error });
      return true;
    }
    const session = ensureSession(body.sessionId);
    if (!session) {
      sendJson(res, 404, { error: "Session not found" });
      return true;
    }
    const feedback = {
      id: createId("fb"),
      turnId: body.turnId || null,
      helpful: Boolean(body.helpful),
      moodDelta: Number(body.moodDelta || 0),
      note: String(body.note || ""),
      time: new Date().toISOString()
    };
    session.feedback.push(feedback);
    pushTimeline(session, "feedback", `helpful=${feedback.helpful}, moodDelta=${feedback.moodDelta}`);
    publishSessionEvent(session.id, "feedback", feedback);
    sendJson(res, 200, { ok: true, feedback });
    return true;
  }

  if (req.method === "GET" && pathname === "/api/sessions") {
    const sessions = store.sessionOrder.map((id) => summarySession(store.sessions[id]));
    sendJson(res, 200, { sessions });
    return true;
  }

  if (req.method === "GET" && pathname.startsWith("/api/session/") && pathname.endsWith("/state")) {
    const parts = pathname.split("/");
    const sessionId = parts[3];
    const session = ensureSession(sessionId);
    if (!session) {
      sendJson(res, 404, { error: "Session not found" });
      return true;
    }
    sendJson(res, 200, { session, user: store.users[session.userId] });
    return true;
  }

  if (req.method === "GET" && pathname.startsWith("/api/session/") && pathname.endsWith("/stream")) {
    const parts = pathname.split("/");
    const sessionId = parts[3];
    const session = ensureSession(sessionId);
    if (!session) {
      sendJson(res, 404, { error: "Session not found" });
      return true;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    });
    res.write(`event: ready\ndata: ${JSON.stringify({ sessionId, time: new Date().toISOString() })}\n\n`);

    let set = sseClients.get(sessionId);
    if (!set) {
      set = new Set();
      sseClients.set(sessionId, set);
    }
    set.add(res);

    req.on("close", () => {
      const targetSet = sseClients.get(sessionId);
      if (!targetSet) return;
      targetSet.delete(res);
      if (targetSet.size === 0) {
        sseClients.delete(sessionId);
      }
    });
    return true;
  }

  if (req.method === "GET" && pathname === "/api/dashboard") {
    sendJson(res, 200, computeDashboard());
    return true;
  }

  if (req.method === "GET" && pathname.startsWith("/api/user/") && pathname.endsWith("/profile")) {
    const parts = pathname.split("/");
    const userId = parts[3];
    const user = store.users[userId];
    if (!user) {
      sendJson(res, 404, { error: "User not found" });
      return true;
    }
    sendJson(res, 200, { user });
    return true;
  }

  if (pathname === "/api/strategy" && req.method === "GET") {
    sendJson(res, 200, { strategy: store.strategyConfig });
    return true;
  }

  if (pathname === "/api/strategy" && req.method === "PUT") {
    const body = await parseBody(req).catch((err) => ({ __error: err.message }));
    if (body.__error) {
      sendJson(res, 400, { error: body.__error });
      return true;
    }
    store.strategyConfig = {
      ...store.strategyConfig,
      ...body
    };
    sendJson(res, 200, { ok: true, strategy: store.strategyConfig });
    return true;
  }

  if (pathname === "/api/safety" && req.method === "GET") {
    sendJson(res, 200, {
      safety: store.safetyConfig,
      logs: store.safetyLogs.slice(-200).reverse(),
      analytics: computeSafetyAnalytics()
    });
    return true;
  }

  if (pathname === "/api/safety" && req.method === "PUT") {
    const body = await parseBody(req).catch((err) => ({ __error: err.message }));
    if (body.__error) {
      sendJson(res, 400, { error: body.__error });
      return true;
    }
    store.safetyConfig = {
      ...store.safetyConfig,
      ...body
    };
    sendJson(res, 200, { ok: true, safety: store.safetyConfig });
    return true;
  }

  if (pathname === "/api/evaluation" && req.method === "GET") {
    const sessions = Object.values(store.sessions);
    const totalTurns = sessions.reduce((n, s) => n + s.chatTurns.length, 0);
    const totalFeedback = sessions.reduce((n, s) => n + s.feedback.length, 0);
    const helpfulRateBase = sessions.flatMap((s) => s.feedback).filter((f) => f.helpful).length;
    const helpfulRate = totalFeedback > 0 ? helpfulRateBase / totalFeedback : 0;
    const fakeModelMetrics = {
      emotionAcc: 0.5718,
      f1Macro: 0.54,
      crossDeviceScore: 0.49
    };
    sendJson(res, 200, {
      modelMetrics: fakeModelMetrics,
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
    });
    return true;
  }

  if (pathname === "/api/export" && req.method === "POST") {
    const body = await parseBody(req).catch((err) => ({ __error: err.message }));
    if (body.__error) {
      sendJson(res, 400, { error: body.__error });
      return true;
    }
    const record = {
      id: createId("export"),
      kind: body.kind || "unknown",
      time: new Date().toISOString(),
      status: "queued-sample"
    };
    store.exports.unshift(record);
    sendJson(res, 200, { ok: true, export: record });
    return true;
  }

  return false;
}

const server = http.createServer(async (req, res) => {
  try {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const isApiHandled = await handleApi(req, res, urlObj);
    if (!isApiHandled) {
      if (req.method !== "GET") {
        sendJson(res, 405, { error: "Method not allowed" });
        return;
      }
      serveStatic(req, res, urlObj.pathname);
    }
  } catch (err) {
    sendJson(res, 500, { error: "Internal server error", detail: err.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`MindCap MVP server running at http://${HOST}:${PORT}`);
});
