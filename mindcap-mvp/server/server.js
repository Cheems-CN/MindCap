const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const { BufferWindowMemory, VectorStoreRetrieverMemory, CombinedMemory } = require("@langchain/classic/memory");
const { MemoryVectorStore } = require("@langchain/classic/vectorstores/memory");
const { Embeddings } = require("@langchain/core/embeddings");
const db = require("./db");
const { parseEEGFile, getAvailableModels } = require("./eeg-parser");
const { createPopulatedVectorStore, persistContext } = require("./memory-store");

const HOST = "127.0.0.1";
const PORT = process.env.PORT ? Number(process.env.PORT) : 5050;
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || "";
const DEEPSEEK_BASE_URL = (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/+$/, "");
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-v4-flash";
const DEEPSEEK_TIMEOUT_MS = process.env.DEEPSEEK_TIMEOUT_MS ? Number(process.env.DEEPSEEK_TIMEOUT_MS) : 25000;
const LANGCHAIN_EMBED_DIM = 128;

const sseClients = new Map();
const langchainMemoryRegistry = new Map();

// ── Deterministic Embeddings (same as before) ───────────────────────

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
    const tokens = String(text || "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
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

// ── LangChain Memory ────────────────────────────────────────────────

function buildProfileSeedRecords(user) {
  const records = [];
  const triggers = user?.longTermProfile?.triggers || [];
  const preferred = user?.longTermProfile?.preferredInterventions || [];
  const effective = user?.verifiedEffectiveStrategies || [];
  const shortMem = user?.shortTermMemory || [];

  if (triggers.length) records.push(`用户压力触发因素：${triggers.join("、")}`);
  if (preferred.length) records.push(`用户偏好干预方式：${preferred.join("、")}`);
  if (effective.length) records.push(`历史有效策略：${effective.join("、")}`);
  for (const line of shortMem.slice(0, 4)) records.push(`短期记忆：${line}`);
  return records;
}

async function createLangChainMemoryRuntime(user) {
  const embeddings = new DeterministicEmbeddings();

  // Create vector store populated from SQLite (survives restart)
  const vectorStore = await createPopulatedVectorStore(user.id, embeddings);

  const longMemory = new VectorStoreRetrieverMemory({
    vectorStoreRetriever: vectorStore.asRetriever(4),
    memoryKey: "long_term_memory",
    inputKey: "input",
    returnDocs: false,
    metadata: { userId: user.id }
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
  return { vectorStore, longMemory, shortMemory, combinedMemory, seeded: false, embeddings };
}

async function ensureLangChainMemoryRuntime(user) {
  if (!user) return null;
  let runtime = langchainMemoryRegistry.get(user.id);
  if (!runtime) {
    runtime = await createLangChainMemoryRuntime(user);
    langchainMemoryRegistry.set(user.id, runtime);
  }
  if (!runtime.seeded) {
    const seeds = buildProfileSeedRecords(user);
    for (const seed of seeds) {
      await runtime.longMemory.saveContext({ input: seed }, { output: `画像归档:${seed}` });
    }
    runtime.seeded = true;
  }
  return runtime;
}

async function loadLangChainMemoryContext(runtime, message) {
  if (!runtime) return { recentMemory: "", longTermMemory: "" };
  const memoryVars = await runtime.combinedMemory.loadMemoryVariables({ input: message });
  return {
    recentMemory: String(memoryVars.recent_memory || ""),
    longTermMemory: String(memoryVars.long_term_memory || "")
  };
}

async function persistLangChainMemory(runtime, userText, assistantText) {
  if (!runtime) return;

  // Save to in-memory LangChain store
  await runtime.combinedMemory.saveContext({ input: userText }, { output: assistantText });

  // Also persist to SQLite so it survives restart
  const userId = runtime.longMemory?.metadata?.userId || null;
  await persistContext(userId, userText, assistantText, runtime.embeddings);
}

// ── HTTP helpers ────────────────────────────────────────────────────

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk.toString("utf8");
      if (data.length > 1_000_000) { reject(new Error("Payload too large")); req.destroy(); }
    });
    req.on("end", () => {
      if (!data) { resolve({}); return; }
      try { resolve(JSON.parse(data)); } catch (err) { reject(new Error("Invalid JSON")); }
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
  if (!resolved.startsWith(PUBLIC_DIR)) { sendJson(res, 403, { error: "Forbidden" }); return; }
  fs.readFile(resolved, (err, content) => {
    if (err) { sendJson(res, 404, { error: "Not found" }); return; }
    res.writeHead(200, { "Content-Type": getMimeType(resolved) });
    res.end(content);
  });
}

function clipText(value, maxLen = 220) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}...`;
}

// ── SSE ─────────────────────────────────────────────────────────────

function publishSessionEvent(sessionId, eventName, payload) {
  const set = sseClients.get(sessionId);
  if (!set) return;
  const line = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of set) res.write(line);
}

// ── Intervention tracks ─────────────────────────────────────────────

const interventionTracks = {
  breathing: {
    name: "呼吸稳定",
    keywords: ["焦虑", "紧张", "心慌", "stress", "anxiety", "呼吸", "胸闷"],
    steps: [
      [
        "做60秒方块呼吸：吸4秒-停4秒-呼4秒-停4秒。",
        "试试方块呼吸法：慢慢吸气4秒，屏住4秒，缓缓呼出4秒，再屏住4秒。重复60秒。",
        "我们先从呼吸锚定开始：4秒吸气、4秒停顿、4秒呼气、4秒停顿。跟着我的节奏来。"
      ],
      [
        "继续90秒呼气延长：吸4秒、呼6秒，观察肩颈是否放松。",
        "这次让呼气更长一些：吸4秒、呼6秒，把注意力放在肩膀下沉的感觉上。",
        "进阶呼吸：吸气不变，但让呼气拉长到6秒，感受横膈膜慢慢放松。"
      ],
      [
        "把身体感受写成三词（例如：心跳快、肩紧、手冷），只做观察不评判。",
        "用三个简单的词描述你现在身体的感觉，只是观察，不加评判。",
        "扫描身体，找一个词描述头部感受、一个词描述胸口、一个词描述手脚。只观察不改变。"
      ]
    ]
  },
  task: {
    name: "任务减压",
    keywords: ["考试", "任务", "ddl", "作业", "进度", "效率", "压力"],
    steps: [
      [
        "列出当前最困扰的3件事，并圈出今天必须完成的1件。",
        "拿出一张纸或打开备忘录，写下让你感到压力的3件事。然后只圈出今天必须完成的1件。",
        "我们先做减法：把所有要做的事写出来，然后问自己'今天必须完成的是哪一件？'"
      ],
      [
        "把这1件事拆成一个15分钟动作，马上启动计时。",
        "把选中的任务拆解到最小可执行单元——一个15分钟内能完成的动作。现在就启动倒计时。",
        "只做一件事：把你圈出的任务拆成第一个15分钟行动，然后立刻开始。不需要想后面的步骤。"
      ],
      [
        "完成后写一句复盘：这一步比预想更难还是更容易。",
        "15分钟到了！写一句简单的复盘，关注难度感受而非结果好坏。",
        "停一下，问问自己：实际做的感觉和预想有什么不同？记录这个差距就好。"
      ]
    ]
  },
  sleep: {
    name: "睡眠修复",
    keywords: ["失眠", "睡眠", "入睡", "夜醒", "疲惫"],
    steps: [
      [
        "今晚固定一个关灯时间，并提前30分钟关闭高刺激内容（短视频、游戏、刺眼灯）。",
        "给今晚设一个'光线切换点'：在这个时间关掉主灯，切换到暖黄夜灯模式，告诉大脑要准备休息了。",
        "今晚试试'数字日落'：提前30分钟放下手机/电脑，用纸质书或播客替代屏幕。"
      ],
      [
        "做2分钟腹式呼吸，把注意力放在呼气变长。",
        "躺下后做腹式呼吸：手放肚子上，吸气感觉肚子鼓起，呼气感觉手下降。呼气越长越好。",
        "睡前呼吸练习：用鼻子缓慢吸气4秒，用嘴巴微微呼气6-8秒，感受身体一点点变沉。"
      ],
      [
        "若20分钟仍未入睡，起身做低刺激活动5分钟（折衣服、翻杂志）再回床。",
        "如果躺了20分钟还睡不着，不要硬躺。起来做一件无聊的小事，困意会自然回来。",
        "睡不着就起来'重启'：离开床5分钟，喝一小口温水，做几个温和拉伸，然后重新躺下试试。"
      ]
    ]
  },
  social: {
    name: "社交安定",
    keywords: ["社交", "发言", "陌生人", "尴尬", "评价"],
    steps: [
      [
        "先写一句可复述开场白，并默念3遍。",
        "准备一句万能开场白写下来：'你好，我是XX，今天这个活动/会议我一直在期待'。默念到自然。",
        "社交的紧张来自不确定性。我们先给大脑一个确定的脚本：写好第一句话，反复读三遍。"
      ],
      [
        "为下一次社交设定最小目标：只完成一次主动问候。",
        "把社交目标降到最低：不是'表现完美'，而是'说一句你好'。完成即胜利。",
        "下一个社交场合，给自己唯一的任务：找到一个友善的面孔，微笑着说'你好'。不需要更多。"
      ],
      [
        "事后记录1个做得好的点，强化可复制动作。",
        "社交结束后，不要复盘'哪里出错了'，而是找到1个你做对了的时刻，记住它。",
        "给自己一个正面反馈：写下今天社交中哪怕最微小的成功（'我准时到达了'也算）。积累即是信心。"
      ]
    ]
  },
  grounding: {
    name: "情绪落地",
    keywords: ["低落", "悲伤", "空虚", "无力", "sad"],
    steps: [
      [
        "做30秒5-4-3-2-1感官定位：现在看到5样东西、触到4样、听到3种声音、闻到2种气味、尝到1种味道。",
        "着陆技术：找到5个你能看到的东西，4个你能摸到的物品，3种你能听到的声音，2种气味，1种味道。",
        "我们一起回到当下：说出你周围5样物品的颜色，感受4样东西的质地，听3种声音。"
      ],
      [
        "给自己一句非苛责陈述：'我现在很难受，但我在尝试自救'，在心里重复3遍。",
        "对自己说一句温柔的话：'这种感觉会过去的，我只需要度过接下来的5分钟'。",
        "如果好朋友正在经历你现在的心情，你会对TA说什么？把这句话说给自己听。"
      ],
      [
        "选择一个2分钟微行动（洗脸、喝温水、站立伸展、开窗透气），做完后感受一下掌控感是不是回来了一点。",
        "做一个小到不可能失败的动作：站起来伸展手臂、用冷水冲一下手、或者整理桌上的三样东西。",
        "找回掌控感的最小单位：给自己倒一杯温水，慢慢喝完。感受水从喉咙流过的温度。这就是'我能做到的事'。"
      ]
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
    if (score > bestScore) { bestScore = score; bestKey = key; }
  }
  return bestKey;
}

function updateInterventionState(session, selectedTrackKey, emotionLabel) {
  if (!session.interventionState || !session.interventionState.trackKey) {
    const state = { trackKey: selectedTrackKey, stepIndex: 0, lastEmotion: emotionLabel || "neutral" };
    db.updateSessionIntervention(session.id, selectedTrackKey, 0, emotionLabel || "neutral");
    return state;
  }

  const state = session.interventionState;
  if (state.trackKey !== selectedTrackKey) {
    db.updateSessionIntervention(session.id, selectedTrackKey, 0, emotionLabel || "neutral");
    return { trackKey: selectedTrackKey, stepIndex: 0, lastEmotion: emotionLabel || "neutral" };
  }

  const track = interventionTracks[state.trackKey] || interventionTracks.task;
  const shouldAdvance = session.chatTurns.length >= 1;
  const newStepIndex = shouldAdvance && state.stepIndex < track.steps.length - 1 ? state.stepIndex + 1 : state.stepIndex;
  db.updateSessionIntervention(session.id, state.trackKey, newStepIndex, emotionLabel || "neutral");
  return { trackKey: state.trackKey, stepIndex: newStepIndex, lastEmotion: emotionLabel || "neutral" };
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

  const selectedTrackKey = matchTrackByContext(contextText, user?.longTermProfile?.preferredInterventions, currentMessage) || defaultTrackKey;
  const interventionState = updateInterventionState(session, selectedTrackKey, emotion?.label);
  const track = interventionTracks[interventionState.trackKey] || interventionTracks.task;
  const step = Math.max(0, Math.min(interventionState.stepIndex, track.steps.length - 1));
  const stepVariants = Array.isArray(track.steps[step]) ? track.steps[step] : [track.steps[step]];
  const chosenStep = stepVariants[Math.floor(Math.random() * stepVariants.length)];

  const memoryAnchor =
    (user?.verifiedEffectiveStrategies || [])[0] ||
    (user?.longTermProfile?.preferredInterventions || [])[0] ||
    "先稳定呼吸再做最小动作";

  return [
    `延续方案【${track.name}】第${step + 1}步：${chosenStep}`,
    `记忆锚点：你历史上更有效的方式是「${memoryAnchor}」，本轮优先沿用。`,
    "执行后告诉我：情绪强度从0-10变成了几分，我会按同一方案继续下一步。"
  ];
}

// ── Safety detection ────────────────────────────────────────────────

const builtInHighRiskRules = [
  { id: "cn_suicide", pattern: /自杀|想自杀|我想死|想死|去死|轻生/iu, reason: "命中自杀/轻生意图" },
  { id: "cn_end_life", pattern: /(结束|了结).{0,4}(生命|自己)/iu, reason: "命中结束生命表达" },
  { id: "cn_not_live", pattern: /不想活了?|活着没意义/iu, reason: "命中绝望生存表达" },
  { id: "en_suicide", pattern: /suicide|kill\s*myself|end\s*my\s*life|don't\s*want\s*to\s*live/iu, reason: "命中英文自伤表达" }
];

function normalizeRiskText(input) {
  return String(input || "").toLowerCase().replace(/[\s\r\n\t]/g, "").replace(/[.,!?;:，。！？；：、'"`~\-_/\\()[\]{}<>]/g, "");
}

function detectHighRisk(text) {
  const raw = String(text || "");
  const normalized = normalizeRiskText(raw);

  for (const rule of builtInHighRiskRules) {
    if (rule.pattern.test(raw) || rule.pattern.test(normalized)) {
      return { matched: true, reason: rule.reason, ruleId: rule.id };
    }
  }

  const safetyConfig = db.getSafetyConfig();
  const blockedPatterns = safetyConfig?.blockedPatterns || [];
  for (const keyword of blockedPatterns) {
    const normalizedKeyword = normalizeRiskText(keyword);
    if (!normalizedKeyword) continue;
    if (normalized.includes(normalizedKeyword)) {
      return { matched: true, reason: `命中配置关键词: ${keyword}`, ruleId: "custom_keyword" };
    }
  }

  return { matched: false, reason: "", ruleId: "" };
}

function addSafetyLog(sessionId, level, reason, source) {
  const log = {
    id: db.createId("risk"),
    sessionId,
    level,
    reason,
    source,
    time: new Date().toISOString()
  };
  db.insertSafetyLog(log);
  db.appendSessionTimeline(sessionId, {
    id: db.createId("evt"),
    time: log.time,
    type: "safety_alert",
    detail: `${level.toUpperCase()}: ${reason}`
  });
  publishSessionEvent(sessionId, "safety", log);
  return log;
}

// ── LLM helpers ─────────────────────────────────────────────────────

function buildPsychologySystemPrompt() {
  return [
    "你是「心灵捕手」系统里的心理支持对话专家，风格接近心理咨询师与疗愈教练。",
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
    { role: "system", content: buildPsychologySystemPrompt() },
    { role: "system", content: buildContextPrompt({ session, user, emotion, memoryContext }) }
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
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content.map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item.text === "string") return item.text;
      return "";
    }).join("").trim();
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
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
      body: JSON.stringify({ model: DEEPSEEK_MODEL, messages, thinking: { type: "disabled" }, max_tokens: 500, temperature: 1.05, stream: false }),
      signal: controller.signal
    });

    const rawText = await response.text();
    if (!response.ok) throw new Error(`DeepSeek API ${response.status}: ${clipText(rawText, 260)}`);

    let payload;
    try { payload = JSON.parse(rawText); } catch (err) { throw new Error(`DeepSeek response parse failed: ${err.message}`); }

    const content = extractAssistantContent(payload);
    if (!content) throw new Error("DeepSeek returned empty assistant content");
    return content;
  } catch (err) {
    if (err.name === "AbortError") throw new Error(`DeepSeek timeout after ${timeout}ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function buildMockAssistantReply({ message, emotion, session, user, memoryContext }) {
  const tone =
    emotion?.label === "anxiety" || emotion?.label === "stress"
      ? "我听到你现在有些紧绷，我们先把状态稳下来。"
      : "谢谢你愿意说出来，我们一起慢慢梳理。";
  const suggestions = buildMemoryAwareSuggestions({ session, user, emotion, memoryContext, currentMessage: message });
  return {
    safetyLevel: "normal",
    text: `${tone} 你刚才说的是："${clipText(message, 60)}"。我建议先做一个最小动作，然后我再陪你看下一步。`,
    suggestions
  };
}

async function buildAssistantReply({ message, emotion, session, user }) {
  const runtime = await ensureLangChainMemoryRuntime(user);
  const memoryContext = await loadLangChainMemoryContext(runtime, message);
  const riskResult = detectHighRisk(message);

  if (riskResult.matched) {
    const safetyConfig = db.getSafetyConfig();
    return {
      safetyLevel: "high",
      text: safetyConfig?.replacementTemplates?.high || "我很重视你的安全。请优先联系身边可信任的人或当地紧急援助热线。",
      suggestions: ["如果你有立即风险，请马上联系当地紧急服务。", "可以先告诉我你现在是否独处，我会继续陪你。"],
      llmSource: "safety-template",
      riskReason: riskResult.reason,
      memoryContext,
      runtime
    };
  }

  if (!DEEPSEEK_API_KEY) {
    const mockReply = buildMockAssistantReply({ message, emotion, session, user, memoryContext });
    return { ...mockReply, llmSource: "mock-no-key", memoryContext, runtime };
  }

  try {
    const messages = buildDeepSeekMessages({ session, user, emotion, message, memoryContext });
    const content = await callDeepSeekChat(messages);
    return {
      safetyLevel: "normal",
      text: content,
      suggestions: buildMemoryAwareSuggestions({ session, user, emotion, memoryContext, currentMessage: message }),
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

// ── API handlers ────────────────────────────────────────────────────

async function handleApi(req, res, urlObj) {
  const { pathname } = urlObj;

  // GET /api/health
  if (req.method === "GET" && pathname === "/api/health") {
    sendJson(res, 200, {
      ok: true,
      time: new Date().toISOString(),
      llm: { provider: "deepseek", enabled: Boolean(DEEPSEEK_API_KEY), model: DEEPSEEK_MODEL, baseUrl: DEEPSEEK_BASE_URL }
    });
    return true;
  }

  // GET /api/users
  if (req.method === "GET" && pathname === "/api/users") {
    sendJson(res, 200, { users: db.getUsers() });
    return true;
  }

  // POST /api/session/start
  if (req.method === "POST" && pathname === "/api/session/start") {
    const body = await parseBody(req).catch((err) => ({ __error: err.message }));
    if (body.__error) { sendJson(res, 400, { error: body.__error }); return true; }
    const user = db.getUserFull(body.userId);
    if (!user) { sendJson(res, 400, { error: "Invalid userId" }); return true; }

    const sessionId = db.createId("sess");
    const startedAt = new Date().toISOString();
    db.createSession(sessionId, body.userId, startedAt);
    sendJson(res, 200, { sessionId, startedAt, user });
    return true;
  }

  // POST /api/session/end
  if (req.method === "POST" && pathname === "/api/session/end") {
    const body = await parseBody(req).catch((err) => ({ __error: err.message }));
    if (body.__error) { sendJson(res, 400, { error: body.__error }); return true; }
    const session = db.getSession(body.sessionId);
    if (!session) { sendJson(res, 404, { error: "Session not found" }); return true; }

    db.endSession(body.sessionId);
    db.appendSessionTimeline(body.sessionId, {
      id: db.createId("evt"),
      time: new Date().toISOString(),
      type: "session_end",
      detail: "会话结束"
    });
    publishSessionEvent(body.sessionId, "session_end", { sessionId: body.sessionId, endedAt: new Date().toISOString() });

    const summary = db.getSession(body.sessionId);
    sendJson(res, 200, {
      ok: true,
      session: {
        id: summary.id,
        userId: summary.userId,
        status: summary.status,
        startedAt: summary.startedAt,
        endedAt: summary.endedAt,
        messageCount: summary.chatTurns.length,
        latestEmotion: summary.currentEmotion
      }
    });
    return true;
  }

  // POST /api/eeg/push
  if (req.method === "POST" && pathname === "/api/eeg/push") {
    const body = await parseBody(req).catch((err) => ({ __error: err.message }));
    if (body.__error) { sendJson(res, 400, { error: body.__error }); return true; }
    const session = db.getSession(body.sessionId);
    if (!session) { sendJson(res, 404, { error: "Session not found" }); return true; }

    const event = {
      id: db.createId("eeg"),
      label: body.label || "neutral",
      confidence: Number(body.confidence || 0.5),
      time: body.time || new Date().toISOString()
    };

    db.insertEEGEvent(event.id, body.sessionId, event.label, event.confidence, event.time);
    db.updateSessionEmotion(body.sessionId, event.label, event.confidence, event.time);
    db.appendSessionTimeline(body.sessionId, {
      id: db.createId("evt"),
      time: event.time,
      type: "eeg_update",
      detail: `${event.label} (${event.confidence.toFixed(2)})`
    });

    if ((event.label === "sad" || event.label === "anxiety" || event.label === "stress") && event.confidence >= 0.85) {
      addSafetyLog(body.sessionId, "medium", `EEG高置信负性情绪: ${event.label}`, "eeg");
    }

    publishSessionEvent(body.sessionId, "eeg", event);
    sendJson(res, 200, { ok: true, currentEmotion: { label: event.label, confidence: event.confidence, time: event.time } });
    return true;
  }

  // POST /api/chat/send
  if (req.method === "POST" && pathname === "/api/chat/send") {
    const body = await parseBody(req).catch((err) => ({ __error: err.message }));
    if (body.__error) { sendJson(res, 400, { error: body.__error }); return true; }
    const session = db.getSession(body.sessionId);
    if (!session) { sendJson(res, 404, { error: "Session not found" }); return true; }
    const userText = String(body.message || "").trim();
    if (!userText) { sendJson(res, 400, { error: "Message is empty" }); return true; }

    const user = db.getUserFull(session.userId);
    const reply = await buildAssistantReply({
      message: userText,
      emotion: session.currentEmotion,
      session,
      user
    });

    const turnId = db.createId("turn");
    const now = new Date().toISOString();
    const turn = {
      id: turnId,
      sessionId: body.sessionId,
      userText,
      assistantText: reply.text,
      safetyLevel: reply.safetyLevel,
      emotionLabel: session.currentEmotion?.label,
      emotionConfidence: session.currentEmotion?.confidence,
      suggestions: reply.suggestions,
      llmSource: reply.llmSource || "unknown",
      llmError: reply.llmError || null,
      interventionTrackKey: session.interventionState?.trackKey || null,
      interventionStepIndex: session.interventionState?.stepIndex ?? null,
      time: now
    };

    db.insertChatTurn(turn);
    db.appendSessionTimeline(body.sessionId, {
      id: db.createId("evt"),
      time: now,
      type: "chat_turn",
      detail: `用户输入 + AI回复 (${reply.safetyLevel})`
    });
    db.upsertUserMemory(session.userId, `最近对话要点: ${userText.slice(0, 32)}`);
    await persistLangChainMemory(reply.runtime, userText, reply.text);

    if (reply.safetyLevel === "high") {
      addSafetyLog(body.sessionId, "high", reply.riskReason || "命中高风险关键词", "chat");
    }

    // Refresh session to get updated intervention state
    const refreshedSession = db.getSession(body.sessionId);

    publishSessionEvent(body.sessionId, "chat", turn);
    sendJson(res, 200, {
      turnId,
      assistantMessage: reply.text,
      safetyLevel: reply.safetyLevel,
      suggestions: reply.suggestions,
      llmSource: reply.llmSource,
      interventionState: refreshedSession?.interventionState || null
    });
    return true;
  }

  // POST /api/feedback
  if (req.method === "POST" && pathname === "/api/feedback") {
    const body = await parseBody(req).catch((err) => ({ __error: err.message }));
    if (body.__error) { sendJson(res, 400, { error: body.__error }); return true; }
    const session = db.getSession(body.sessionId);
    if (!session) { sendJson(res, 404, { error: "Session not found" }); return true; }

    const fb = {
      id: db.createId("fb"),
      sessionId: body.sessionId,
      turnId: body.turnId || null,
      helpful: Boolean(body.helpful),
      moodDelta: Number(body.moodDelta || 0),
      note: String(body.note || ""),
      time: new Date().toISOString()
    };
    db.insertFeedback(fb);
    db.appendSessionTimeline(body.sessionId, {
      id: db.createId("evt"),
      time: fb.time,
      type: "feedback",
      detail: `helpful=${fb.helpful}, moodDelta=${fb.moodDelta}`
    });
    publishSessionEvent(body.sessionId, "feedback", fb);
    sendJson(res, 200, { ok: true, feedback: fb });
    return true;
  }

  // GET /api/sessions
  if (req.method === "GET" && pathname === "/api/sessions") {
    sendJson(res, 200, { sessions: db.getSessions() });
    return true;
  }

  // GET /api/session/:id/state
  if (req.method === "GET" && pathname.startsWith("/api/session/") && pathname.endsWith("/state")) {
    const sessionId = pathname.split("/")[3];
    const session = db.getSession(sessionId);
    if (!session) { sendJson(res, 404, { error: "Session not found" }); return true; }
    const user = db.getUserFull(session.userId);
    sendJson(res, 200, { session, user });
    return true;
  }

  // GET /api/session/:id/stream (SSE)
  if (req.method === "GET" && pathname.startsWith("/api/session/") && pathname.endsWith("/stream")) {
    const sessionId = pathname.split("/")[3];
    const session = db.getSession(sessionId);
    if (!session) { sendJson(res, 404, { error: "Session not found" }); return true; }

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    });
    res.write(`event: ready\ndata: ${JSON.stringify({ sessionId, time: new Date().toISOString() })}\n\n`);

    let set = sseClients.get(sessionId);
    if (!set) { set = new Set(); sseClients.set(sessionId, set); }
    set.add(res);

    req.on("close", () => {
      const targetSet = sseClients.get(sessionId);
      if (!targetSet) return;
      targetSet.delete(res);
      if (targetSet.size === 0) sseClients.delete(sessionId);
    });
    return true;
  }

  // GET /api/dashboard
  if (req.method === "GET" && pathname === "/api/dashboard") {
    sendJson(res, 200, db.getDashboard());
    return true;
  }

  // GET /api/user/:id/profile
  if (req.method === "GET" && pathname.startsWith("/api/user/") && pathname.endsWith("/profile")) {
    const userId = pathname.split("/")[3];
    const user = db.getUserFull(userId);
    if (!user) { sendJson(res, 404, { error: "User not found" }); return true; }
    sendJson(res, 200, { user });
    return true;
  }

  // GET /api/strategy
  if (pathname === "/api/strategy" && req.method === "GET") {
    sendJson(res, 200, { strategy: db.getStrategyConfig() });
    return true;
  }

  // PUT /api/strategy
  if (pathname === "/api/strategy" && req.method === "PUT") {
    const body = await parseBody(req).catch((err) => ({ __error: err.message }));
    if (body.__error) { sendJson(res, 400, { error: body.__error }); return true; }
    db.updateStrategyConfig(body);
    sendJson(res, 200, { ok: true, strategy: db.getStrategyConfig() });
    return true;
  }

  // GET /api/safety
  if (pathname === "/api/safety" && req.method === "GET") {
    sendJson(res, 200, {
      safety: db.getSafetyConfig(),
      logs: db.getSafetyLogs(200),
      analytics: db.getSafetyAnalytics()
    });
    return true;
  }

  // PUT /api/safety
  if (pathname === "/api/safety" && req.method === "PUT") {
    const body = await parseBody(req).catch((err) => ({ __error: err.message }));
    if (body.__error) { sendJson(res, 400, { error: body.__error }); return true; }
    db.updateSafetyConfig(body);
    const updated = {
      safety: db.getSafetyConfig(),
      logs: db.getSafetyLogs(200),
      analytics: db.getSafetyAnalytics()
    };
    sendJson(res, 200, { ok: true, ...updated });
    return true;
  }

  // GET /api/evaluation
  if (pathname === "/api/evaluation" && req.method === "GET") {
    sendJson(res, 200, db.getEvaluation());
    return true;
  }

  // POST /api/export
  if (pathname === "/api/export" && req.method === "POST") {
    const body = await parseBody(req).catch((err) => ({ __error: err.message }));
    if (body.__error) { sendJson(res, 400, { error: body.__error }); return true; }
    const record = {
      id: db.createId("export"),
      kind: body.kind || "unknown",
      time: new Date().toISOString(),
      status: "queued-sample"
    };
    db.insertExport(record);
    sendJson(res, 200, { ok: true, export: record });
    return true;
  }

  // GET /api/models
  if (req.method === "GET" && pathname === "/api/models") {
    const models = await getAvailableModels();
    sendJson(res, 200, { models });
    return true;
  }

  // POST /api/eeg/import
  if (req.method === "POST" && pathname === "/api/eeg/import") {
    const body = await parseBody(req).catch((err) => ({ __error: err.message }));
    if (body.__error) { sendJson(res, 400, { error: body.__error }); return true; }

    if (!body.csvData || typeof body.csvData !== "string") {
      sendJson(res, 400, { error: "Missing csvData field" });
      return true;
    }
    if (!body.filename) {
      sendJson(res, 400, { error: "Missing filename field" });
      return true;
    }

    const session = body.sessionId ? db.getSession(body.sessionId) : null;
    if (body.sessionId && !session) {
      sendJson(res, 404, { error: "Session not found" });
      return true;
    }

    const model = body.model || "auto";
    const parseResult = await parseEEGFile(body.csvData, body.filename, body.sessionId || null, model);
    const importId = db.createId("eegimp");
    const now = new Date().toISOString();

    const impRecord = { ...parseResult.imp, id: importId, sessionId: body.sessionId || null, time: now };
    db.createEEGImport(impRecord);

    // Insert channel records
    const channelRecords = [];
    for (const ch of parseResult.channels) {
      const chId = db.createId("eegch");
      db.insertEEGChannel({ id: chId, importId, channelName: ch.channelName, band: ch.band || null, value: ch.value });
      channelRecords.push({ id: chId, channelName: ch.channelName, band: ch.band, value: ch.value });
    }

    // If session is active, also push as an EEG event
    if (session && session.status === "active") {
      const eegEventId = db.createId("eeg");
      db.insertEEGEvent(eegEventId, body.sessionId, parseResult.emotion.label, parseResult.emotion.confidence, now);
      db.updateSessionEmotion(body.sessionId, parseResult.emotion.label, parseResult.emotion.confidence, now);
      db.appendSessionTimeline(body.sessionId, {
        id: db.createId("evt"),
        time: now,
        type: "eeg_import",
        detail: `导入 ${body.filename} (${parseResult.imp.channelCount}通道, 判定: ${parseResult.emotion.label})`
      });
      publishSessionEvent(body.sessionId, "eeg", {
        id: eegEventId, label: parseResult.emotion.label, confidence: parseResult.emotion.confidence, time: now, source: "import"
      });
    }

    sendJson(res, 200, {
      ok: true,
      importId,
      format: parseResult.imp.formatType,
      channelCount: parseResult.imp.channelCount,
      channelPreview: channelRecords.slice(0, 20),
      emotion: parseResult.emotion,
      eegPushed: !!(session && session.status === "active")
    });
    return true;
  }

  // GET /api/eeg/imports
  if (req.method === "GET" && pathname === "/api/eeg/imports") {
    const sessionId = urlObj.searchParams.get("sessionId");
    if (!sessionId) { sendJson(res, 400, { error: "Missing sessionId query param" }); return true; }
    sendJson(res, 200, { imports: db.getEEGImports(sessionId) });
    return true;
  }

  // GET /api/eeg/import/:id
  if (req.method === "GET" && pathname.startsWith("/api/eeg/import/")) {
    const importId = pathname.split("/")[4];
    if (!importId) { sendJson(res, 400, { error: "Missing import ID" }); return true; }
    const full = db.getEEGImportFull(importId);
    if (!full) { sendJson(res, 404, { error: "Import not found" }); return true; }
    sendJson(res, 200, { import: full });
    return true;
  }

  return false;
}

// ── Server ──────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  try {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const isApiHandled = await handleApi(req, res, urlObj);
    if (!isApiHandled) {
      if (req.method !== "GET") { sendJson(res, 405, { error: "Method not allowed" }); return; }
      serveStatic(req, res, urlObj.pathname);
    }
  } catch (err) {
    sendJson(res, 500, { error: "Internal server error", detail: err.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`MindCap MVP server running at http://${HOST}:${PORT}`);
  console.log(`Database: ${path.join(__dirname, "..", "data", "mindcap.db")}`);
});
