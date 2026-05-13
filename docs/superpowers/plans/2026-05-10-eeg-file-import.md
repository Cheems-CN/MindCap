# EEG File Import Interface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add CSV file upload and parsing for EEG data, supporting multi-channel raw signals and frequency band imports, with drag-and-drop UI preview.

**Architecture:** New `eeg_imports` table tracks import batches. New `eeg_channels` table stores per-channel per-band data linked to an import. Existing `eeg_events` gets new columns for backward compatibility. Backend parses CSV via streaming (no temp files), maps frequency bands to emotion labels via threshold rules. Frontend adds an import panel inside the session view with FileReader-based drag-and-drop.

**Tech Stack:** better-sqlite3 (existing), Node.js built-in http + csv-parse (new dep), Vanilla JS frontend

---

## File Map

| Action | File | Responsibility |
|---|---|---|
| Modify | `server/db.js:50-57` | Extend eeg_events + new tables |
| Modify | `server/db.js` (bottom) | New query functions |
| New | `server/eeg-parser.js` | CSV parsing + emotion mapping |
| Modify | `server/server.js` | New POST /api/eeg/import + GET /api/eeg/imports |
| Modify | `public/index.html` | Import panel in session view |
| Modify | `public/app.js` | Upload, preview, import logic |
| Modify | `public/styles.css` | Drop zone + preview styles |

---

### Task 1: Install csv-parse dependency

**Files:**
- Modify: `mindcap-mvp/package.json`

- [ ] **Step 1: Install csv-parse**

```bash
cd mindcap-mvp && npm install csv-parse
```

Expected: package.json updated with `"csv-parse"` dependency, no errors.

---

### Task 2: Extend database schema and queries

**Files:**
- Modify: `mindcap-mvp/server/db.js`

- [ ] **Step 1: Add new tables to schema block**

In `db.js`, after the existing `eeg_events` CREATE TABLE statement (around line 57), add:

```js
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
```

- [ ] **Step 2: Add import query functions at the bottom of db.js**

Before the final `module.exports = { ... }` block, add:

```js
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
  return db.prepare(`
    SELECT * FROM eeg_imports WHERE session_id = ? ORDER BY time DESC
  `).all(sessionId);
}

function getEEGImportChannels(importId) {
  return db.prepare(`
    SELECT * FROM eeg_channels WHERE import_id = ? ORDER BY channel_name, band
  `).all(importId);
}

function getEEGImportFull(importId) {
  const imp = db.prepare("SELECT * FROM eeg_imports WHERE id = ?").get(importId);
  if (!imp) return null;
  const channels = db.prepare(
    "SELECT * FROM eeg_channels WHERE import_id = ? ORDER BY channel_name, band"
  ).all(importId);
  return { ...imp, channels };
}
```

- [ ] **Step 3: Add exports for new functions**

Update the `module.exports` block at the bottom to include the new functions:

```js
module.exports = {
  db,
  createId,
  // ... existing exports ...
  createEEGImport,
  insertEEGChannel,
  getEEGImports,
  getEEGImportChannels,
  getEEGImportFull
};
```

- [ ] **Step 4: Verify table creation**

```bash
cd mindcap-mvp && node -e "
const db = require('./server/db');
const tables = db.db.prepare(\"SELECT name FROM sqlite_master WHERE type='table'\").all();
console.log('Tables:', tables.map(t => t.name).join(', '));
"
```

Expected: `Tables: users, sessions, eeg_events, chat_turns, feedback, safety_logs, strategy_config, safety_config, export_records, eeg_imports, eeg_channels`

- [ ] **Step 5: Commit**

```bash
git add mindcap-mvp/server/db.js
git commit -m "feat(db): add eeg_imports and eeg_channels tables for file import"
```

---

### Task 3: Create EEG CSV parser and emotion mapper

**Files:**
- Create: `mindcap-mvp/server/eeg-parser.js`

- [ ] **Step 1: Create the parser module**

```js
// mindcap-mvp/server/eeg-parser.js
const { parse } = require("csv-parse/sync");

/**
 * Detect CSV format type from headers:
 *  - "raw": columns are channel names, rows are time samples
 *  - "bands": first column is 'channel', remaining are band names (delta, theta, alpha, beta, gamma)
 *  - "unknown": cannot determine
 */
function detectFormat(headers) {
  const lowerHeaders = headers.map((h) => String(h || "").toLowerCase().trim());

  // Check for band format: first col is "channel" or "electrode"
  if (
    lowerHeaders[0] === "channel" ||
    lowerHeaders[0] === "electrode" ||
    lowerHeaders[0] === "通道" ||
    lowerHeaders[0] === "电极"
  ) {
    const bandKeywords = ["delta", "theta", "alpha", "beta", "gamma",
      "δ", "θ", "α", "β", "γ"];
    const bandCols = lowerHeaders.slice(1);
    if (bandCols.length >= 2 && bandCols.some((c) => bandKeywords.includes(c))) {
      return "bands";
    }
  }

  // Check for raw format: headers look like channel names (AF3, TP9, etc.)
  const channelLike = lowerHeaders.filter(
    (h) => /^[a-z]{1,3}\d{1,2}$/i.test(h) || /^(af|fp|f|fc|c|cp|p|po|o|t)\d/i.test(h)
  );
  if (channelLike.length >= 2) {
    return "raw";
  }

  return "unknown";
}

/**
 * Parse CSV content string and return structured data.
 */
function parseCsvContent(csvText) {
  const records = parse(csvText, {
    columns: true,
    skip_empty_lines: true,
    bom: true,
    relax_column_count: true,
    delimiter: [",", "\t", ";"],
  });

  if (!records || records.length === 0) {
    throw new Error("CSV file is empty or has no data rows");
  }

  const headers = Object.keys(records[0]);
  const format = detectFormat(headers);

  return { headers, records, format, rowCount: records.length };
}

/**
 * Extract channels from parsed data based on format.
 * Returns array of { channelName, band, values[] } or { channelName, band, value }.
 */
function extractChannels(parsed) {
  const channels = [];

  if (parsed.format === "bands") {
    // Each row is one channel with multiple band columns
    const bandHeaders = parsed.headers.slice(1);
    for (const row of parsed.records) {
      const channelName = row[parsed.headers[0]];
      if (!channelName) continue;
      for (const band of bandHeaders) {
        const val = parseFloat(row[band]);
        if (!Number.isNaN(val)) {
          channels.push({ channelName: String(channelName).trim(), band: String(band).trim(), value: val });
        }
      }
    }
  } else {
    // Raw format: each row is a time sample, each column is a channel
    const channelHeaders = parsed.headers;
    for (const chName of channelHeaders) {
      const values = [];
      for (const row of parsed.records) {
        const val = parseFloat(row[chName]);
        if (!Number.isNaN(val)) {
          values.push(val);
        }
      }
      if (values.length > 0) {
        channels.push({ channelName: String(chName).trim(), band: "raw", value: values.reduce((a, b) => a + b, 0) / values.length });
      }
    }
  }

  return channels;
}

/**
 * Simple threshold-based emotion mapping from channel/band data.
 *
 * Rules (literature-based heuristics):
 *  - High alpha/beta ratio at frontal sites → relaxed/calm
 *  - Low alpha/beta ratio at frontal sites → stress/anxiety
 *  - High frontal alpha asymmetry (left > right) → positive/calm
 *  - Low frontal alpha asymmetry (right > left) → negative/sad
 *  - Elevated beta at all sites → anxiety
 *  - Very low all-band power → neutral/baseline
 */
function mapToEmotion(channels) {
  // Aggregate bands by channel
  const bandByChannel = {};
  for (const ch of channels) {
    if (!bandByChannel[ch.channelName]) {
      bandByChannel[ch.channelName] = {};
    }
    bandByChannel[ch.channelName][ch.band] = ch.value;
  }

  // Find frontal channels (AF*, F*, FP*)
  const frontalChannels = Object.keys(bandByChannel).filter((name) =>
    /^(af|fp|f)\d/i.test(name)
  );

  let alphaBetaRatio = null;
  let leftAlpha = 0;
  let rightAlpha = 0;
  let leftCount = 0;
  let rightCount = 0;
  let totalBeta = 0;
  let betaCount = 0;

  for (const chName of frontalChannels) {
    const bands = bandByChannel[chName];
    const alpha = bands["alpha"] || bands["α"] || 0;
    const beta = bands["beta"] || bands["β"] || 0;
    const theta = bands["theta"] || bands["θ"] || 0;

    totalBeta += beta;
    betaCount += 1;

    if (alpha > 0 && beta > 0) {
      const ratio = alpha / beta;
      if (alphaBetaRatio === null) alphaBetaRatio = ratio;
      else alphaBetaRatio = (alphaBetaRatio + ratio) / 2;
    }

    // Left channels: odd-numbered (F3, AF3) or ending in odd digit
    const match = chName.match(/(\d+)$/);
    if (match) {
      const num = parseInt(match[1], 10);
      if (num % 2 !== 0) {
        leftAlpha += alpha;
        leftCount += 1;
      } else {
        rightAlpha += alpha;
        rightCount += 1;
      }
    }
  }

  // If no frontal channel data, use all channels
  if (betaCount === 0) {
    for (const chName of Object.keys(bandByChannel)) {
      const beta = bandByChannel[chName]["beta"] || bandByChannel[chName]["β"] || 0;
      totalBeta += beta;
      betaCount += 1;
    }
  }

  let label = "neutral";
  let confidence = 0.5;
  const reasons = [];

  // Rule 1: Alpha/beta ratio
  if (alphaBetaRatio !== null) {
    if (alphaBetaRatio > 1.5) {
      label = "calm";
      confidence = Math.min(0.95, 0.5 + (alphaBetaRatio - 1.5) * 0.3);
      reasons.push(`高α/β比 (${alphaBetaRatio.toFixed(2)})`);
    } else if (alphaBetaRatio > 1.0) {
      // moderate: stay neutral-ish
      reasons.push(`中α/β比 (${alphaBetaRatio.toFixed(2)})`);
    } else {
      label = "stress";
      confidence = Math.min(0.9, 0.5 + (1.0 - alphaBetaRatio) * 0.4);
      reasons.push(`低α/β比 (${alphaBetaRatio.toFixed(2)})`);
    }
  }

  // Rule 2: Frontal asymmetry
  if (leftCount > 0 && rightCount > 0) {
    const leftAvg = leftAlpha / leftCount;
    const rightAvg = rightAlpha / rightCount;
    if (rightAvg > leftAvg * 1.3) {
      // Right-dominant alpha suggests negative affect
      if (label === "neutral" || label === "calm") {
        label = "sad";
        confidence = Math.min(0.85, 0.5 + (rightAvg / Math.max(leftAvg, 0.01) - 1) * 0.25);
      }
      reasons.push(`右额叶α优势 (L:${leftAvg.toFixed(2)}, R:${rightAvg.toFixed(2)})`);
    }
  }

  // Rule 3: Globally elevated beta → anxiety
  const avgBeta = betaCount > 0 ? totalBeta / betaCount : 0;
  if (avgBeta > 10) {
    label = "anxiety";
    confidence = Math.min(0.9, 0.5 + (avgBeta - 10) * 0.05);
    reasons.push(`全脑高β (avg:${avgBeta.toFixed(2)})`);
  }

  return {
    label,
    confidence: Number(confidence.toFixed(2)),
    reasons: reasons.length > 0 ? reasons.join("; ") : "默认判断",
    alphaBetaRatio: alphaBetaRatio !== null ? Number(alphaBetaRatio.toFixed(2)) : null,
    avgFrontalBeta: betaCount > 0 ? Number(avgBeta.toFixed(2)) : null,
  };
}

/**
 * Main parse function: takes CSV text, returns { import, channels, emotion }.
 */
function parseEEGFile(csvText, filename, sessionId) {
  const parsed = parseCsvContent(csvText);
  const channels = extractChannels(parsed);
  const emotion = mapToEmotion(channels);

  const imp = {
    id: null, // caller sets via db.createId
    sessionId: sessionId || null,
    filename: filename || "unknown.csv",
    channelCount: new Set(channels.map((c) => c.channelName)).size,
    sampleCount: parsed.format === "raw" ? parsed.rowCount : 0,
    durationSec: null,
    sampleRate: null,
    device: null,
    formatType: parsed.format,
    detectedEmotionLabel: emotion.label,
    detectedEmotionConfidence: emotion.confidence,
    time: new Date().toISOString(),
  };

  return { imp, channels, emotion };
}

module.exports = { parseEEGFile, detectFormat, parseCsvContent, extractChannels, mapToEmotion };
```

- [ ] **Step 2: Verify parser works with sample data**

```bash
cd mindcap-mvp && node -e "
const { parseEEGFile } = require('./server/eeg-parser');

// Sample band-format CSV
const bandCsv = 'channel,delta,theta,alpha,beta,gamma\nAF3,0.5,0.8,1.2,0.6,0.3\nAF4,0.4,0.7,1.0,0.9,0.2\nF3,0.6,0.9,0.8,1.5,0.4\nF4,0.5,0.8,0.7,1.6,0.3';
const result = parseEEGFile(bandCsv, 'test.csv', 'sess_test');
console.log('Format:', result.imp.formatType);
console.log('Emotion:', result.emotion);
console.log('Channels:', result.channels.length);
"
```

Expected: `Format: bands`, shows emotion detection result (likely "stress" due to high beta), channels > 0.

- [ ] **Step 3: Commit**

```bash
git add mindcap-mvp/server/eeg-parser.js mindcap-mvp/package.json mindcap-mvp/package-lock.json
git commit -m "feat: add EEG CSV parser with emotion detection rules"
```

---

### Task 4: Add import API endpoints to server

**Files:**
- Modify: `mindcap-mvp/server/server.js`

- [ ] **Step 1: Add require for new modules at top of server.js**

After the `const db = require("./db");` line, add:

```js
const { parseEEGFile } = require("./eeg-parser");
```

- [ ] **Step 2: Add POST /api/eeg/import handler**

Add inside the `handleApi` function, before `return false;` at the end:

```js
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

    const parseResult = parseEEGFile(body.csvData, body.filename, body.sessionId || null);

    const importId = db.createId("eegimp");
    const now = new Date().toISOString();

    const impRecord = {
      ...parseResult.imp,
      id: importId,
      sessionId: body.sessionId || null,
      time: now,
    };
    db.createEEGImport(impRecord);

    // Insert channel records
    const channelRecords = [];
    for (const ch of parseResult.channels) {
      const chId = db.createId("eegch");
      db.insertEEGChannel({
        id: chId,
        importId,
        channelName: ch.channelName,
        band: ch.band || null,
        value: ch.value,
      });
      channelRecords.push({ id: chId, channelName: ch.channelName, band: ch.band, value: ch.value });
    }

    // If a session is active, also push as an EEG event
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
        id: eegEventId,
        label: parseResult.emotion.label,
        confidence: parseResult.emotion.confidence,
        time: now,
        source: "import"
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
```

- [ ] **Step 3: Add GET /api/eeg/imports?sessionId=xxx handler**

```js
  // GET /api/eeg/imports
  if (req.method === "GET" && pathname === "/api/eeg/imports") {
    const sessionId = urlObj.searchParams.get("sessionId");
    if (!sessionId) {
      sendJson(res, 400, { error: "Missing sessionId query param" });
      return true;
    }
    const imports = db.getEEGImports(sessionId);
    sendJson(res, 200, { imports });
    return true;
  }

  // GET /api/eeg/import/:id
  if (req.method === "GET" && pathname.startsWith("/api/eeg/import/")) {
    const importId = pathname.split("/")[4];
    if (!importId) {
      sendJson(res, 400, { error: "Missing import ID" });
      return true;
    }
    const full = db.getEEGImportFull(importId);
    if (!full) {
      sendJson(res, 404, { error: "Import not found" });
      return true;
    }
    sendJson(res, 200, { import: full });
    return true;
  }
```

- [ ] **Step 4: Verify endpoints work**

Start server and test:

```bash
cd mindcap-mvp && node server/server.js &
sleep 2

# Test import
curl -s -X POST http://127.0.0.1:5050/api/eeg/import \
  -H "Content-Type: application/json" \
  -d '{"csvData":"channel,delta,theta,alpha,beta,gamma\nAF3,0.5,0.8,1.2,0.6,0.3\nAF4,0.4,0.7,1.0,0.9,0.2","filename":"test.csv"}'

kill %1 2>/dev/null
```

Expected: JSON response with `ok: true`, `importId`, `emotion` object with label/confidence/reasons.

- [ ] **Step 5: Commit**

```bash
git add mindcap-mvp/server/server.js
git commit -m "feat: add POST /api/eeg/import and GET /api/eeg/imports endpoints"
```

---

### Task 5: Add import UI panel to frontend

**Files:**
- Modify: `mindcap-mvp/public/index.html`
- Modify: `mindcap-mvp/public/app.js`
- Modify: `mindcap-mvp/public/styles.css`

- [ ] **Step 1: Add import panel HTML to session view**

In `index.html`, inside `#view-session`, add after the EEG real-time card (`<article class="panel">` with "EEG 实时情绪卡") and before the NLUX chat panel:

```html
<article class="panel" id="eeg-import-panel">
  <h3>EEG 文件导入</h3>
  <div id="eeg-drop-zone" class="eeg-drop-zone">
    <div class="drop-zone-content">
      <span class="drop-icon">📁</span>
      <p>拖拽 CSV 文件到此处</p>
      <p class="drop-hint">或点击选择文件</p>
      <input type="file" id="eeg-file-input" accept=".csv,.tsv,.txt" hidden />
    </div>
  </div>
  <div id="eeg-preview" class="eeg-preview hidden">
    <div class="preview-header">
      <strong id="preview-filename">-</strong>
      <button id="clear-preview-btn" class="btn-sm">清除</button>
    </div>
    <div class="preview-stats">
      <span>格式: <strong id="preview-format">-</strong></span>
      <span>通道: <strong id="preview-channels">-</strong></span>
      <span>行数: <strong id="preview-rows">-</strong></span>
    </div>
    <div class="preview-channels" id="preview-channel-list"></div>
    <button id="import-eeg-btn">导入并分析情绪</button>
  </div>
  <div id="eeg-import-result" class="eeg-import-result hidden"></div>
  <div id="eeg-import-error" class="eeg-import-error hidden"></div>
</article>
```

- [ ] **Step 2: Add CSS styles for import panel**

In `styles.css`, add at the end before the media query:

```css
/* EEG Import Panel */
.eeg-drop-zone {
  border: 2px dashed #bccfe0;
  border-radius: 12px;
  padding: 24px;
  text-align: center;
  cursor: pointer;
  transition: border-color 0.2s, background 0.2s;
  background: #fafcff;
}

.eeg-drop-zone:hover,
.eeg-drop-zone.drag-over {
  border-color: #0d9488;
  background: #f0fcfa;
}

.drop-zone-content {
  pointer-events: none;
}

.drop-icon {
  font-size: 32px;
  display: block;
  margin-bottom: 8px;
}

.drop-hint {
  font-size: 12px;
  color: #8899aa;
  margin-top: 4px;
}

.eeg-preview {
  margin-top: 12px;
  border: 1px solid #dce8f7;
  border-radius: 10px;
  padding: 12px;
  background: #f8fbff;
}

.preview-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}

.preview-stats {
  display: flex;
  gap: 16px;
  font-size: 13px;
  color: #5f6f81;
  margin-bottom: 10px;
}

.preview-channels {
  max-height: 150px;
  overflow-y: auto;
  font-size: 12px;
  margin-bottom: 10px;
  border: 1px solid #e6edf6;
  border-radius: 8px;
  padding: 8px;
  background: #fff;
}

.preview-channel-row {
  display: flex;
  justify-content: space-between;
  padding: 2px 4px;
  border-bottom: 1px solid #f0f4f8;
}

.preview-channel-row:last-child {
  border-bottom: none;
}

#import-eeg-btn {
  background: linear-gradient(120deg, #0ea5a1, #0d9488);
  color: #fff;
  border-color: transparent;
  width: 100%;
}

.eeg-import-result {
  margin-top: 10px;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid #b7e4c7;
  background: #f0fdf4;
  color: #166534;
}

.eeg-import-result .emotion-badge {
  display: inline-block;
  padding: 4px 10px;
  border-radius: 999px;
  font-weight: 600;
  margin-right: 8px;
}

.eeg-import-error {
  margin-top: 10px;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid #f5d1d1;
  background: #fff5f5;
  color: #8b1d1d;
}

.btn-sm {
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 6px;
  background: #fff;
  border: 1px solid #d0daea;
  cursor: pointer;
}

.hidden {
  display: none !important;
}
```

- [ ] **Step 3: Add JavaScript logic for import**

In `app.js`, add after the existing `bindActions` function and before `init`:

```js
// ── EEG File Import ─────────────────────────────────────────────────

let pendingCsvData = null;
let pendingFilename = null;

function setupEEGImport() {
  const dropZone = byId("eeg-drop-zone");
  const fileInput = byId("eeg-file-input");
  const preview = byId("eeg-preview");
  const resultBox = byId("eeg-import-result");
  const errorBox = byId("eeg-import-error");

  if (!dropZone || !fileInput) return;

  // Click to select file
  dropZone.addEventListener("click", () => fileInput.click());

  // Drag events
  dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropZone.classList.add("drag-over");
  });
  dropZone.addEventListener("dragleave", () => {
    dropZone.classList.remove("drag-over");
  });
  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("drag-over");
    const file = e.dataTransfer.files[0];
    if (file) readFile(file);
  });

  // File input change
  fileInput.addEventListener("change", () => {
    const file = fileInput.files[0];
    if (file) readFile(file);
  });

  // Clear preview
  byId("clear-preview-btn").addEventListener("click", () => {
    clearPreview();
  });

  // Import button
  byId("import-eeg-btn").addEventListener("click", () => {
    doImport().catch((err) => showImportError(err.message));
  });
}

function readFile(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const text = e.target.result;
    pendingCsvData = text;
    pendingFilename = file.name;
    showPreview(file.name, text);
  };
  reader.onerror = () => {
    showImportError("文件读取失败");
  };
  reader.readAsText(file);
}

function showPreview(filename, csvText) {
  const preview = byId("eeg-preview");
  const resultBox = byId("eeg-import-result");
  const errorBox = byId("eeg-import-error");

  preview.classList.remove("hidden");
  if (resultBox) resultBox.classList.add("hidden");
  if (errorBox) errorBox.classList.add("hidden");

  setText("preview-filename", filename);

  // Quick parse locally for preview
  const lines = csvText.trim().split("\n").filter(Boolean);
  if (lines.length < 2) {
    showImportError("CSV 文件至少需要标题行+1行数据");
    return;
  }

  const headers = lines[0].split(/[,\t;]/).map((h) => h.trim());
  const format = detectFormatLocal(headers);
  setText("preview-format", format === "bands" ? "频段格式" : format === "raw" ? "原始信号" : "未知");
  setText("preview-channels", format === "bands" ? String(lines.length - 1) : String(headers.length));
  setText("preview-rows", format === "raw" ? String(lines.length - 1) : "-");

  // Channel preview
  const channelList = byId("preview-channel-list");
  channelList.innerHTML = "";

  if (format === "bands") {
    // Show first 6 channels
    for (let i = 1; i < Math.min(lines.length, 7); i++) {
      const cols = lines[i].split(/[,\t;]/);
      const row = document.createElement("div");
      row.className = "preview-channel-row";
      row.innerHTML = `<span>${cols[0] || "-"}</span><span>${cols.slice(1).map((c) => parseFloat(c).toFixed(2)).join(", ")}</span>`;
      channelList.appendChild(row);
    }
    if (lines.length > 7) {
      const more = document.createElement("div");
      more.className = "preview-channel-row";
      more.textContent = `... 还有 ${lines.length - 7} 个通道`;
      channelList.appendChild(more);
    }
  } else if (format === "raw") {
    // Show first 5 channel names
    const firstDataLine = lines[1].split(/[,\t;]/);
    for (let i = 0; i < Math.min(headers.length, 6); i++) {
      const row = document.createElement("div");
      row.className = "preview-channel-row";
      row.innerHTML = `<span>${headers[i]}</span><span>${firstDataLine[i] ? parseFloat(firstDataLine[i]).toFixed(2) : "-"}</span>`;
      channelList.appendChild(row);
    }
    if (headers.length > 6) {
      const more = document.createElement("div");
      more.className = "preview-channel-row";
      more.textContent = `... 还有 ${headers.length - 6} 个通道`;
      channelList.appendChild(more);
    }
  }
}

function detectFormatLocal(headers) {
  const lowerHeaders = headers.map((h) => String(h || "").toLowerCase().trim());
  if (lowerHeaders[0] === "channel" || lowerHeaders[0] === "electrode" || lowerHeaders[0] === "通道" || lowerHeaders[0] === "电极") {
    const bandKeywords = ["delta", "theta", "alpha", "beta", "gamma"];
    if (lowerHeaders.slice(1).some((c) => bandKeywords.includes(c))) return "bands";
  }
  const channelLike = lowerHeaders.filter((h) => /^[a-z]{1,3}\d{1,2}$/i.test(h));
  if (channelLike.length >= 2) return "raw";
  return "unknown";
}

async function doImport() {
  if (!pendingCsvData || !pendingFilename) {
    showImportError("请先选择 CSV 文件");
    return;
  }

  const importBtn = byId("import-eeg-btn");
  importBtn.disabled = true;
  importBtn.textContent = "导入中...";

  try {
    const result = await api("/api/eeg/import", {
      method: "POST",
      body: JSON.stringify({
        csvData: pendingCsvData,
        filename: pendingFilename,
        sessionId: state.currentSessionId || null
      })
    });

    showImportResult(result);
    importBtn.textContent = "导入完成 ✓";

    // Update live EEG display if session is active
    if (result.eegPushed && result.emotion) {
      updateLiveEmotion({
        label: result.emotion.label,
        confidence: result.emotion.confidence,
        time: new Date().toISOString()
      });
      setSystemBadge(`EEG导入: ${result.emotion.label} (${result.emotion.confidence.toFixed(2)})`);
    }

    // Refresh session state if active
    if (state.currentSessionId) {
      refreshCurrentSessionState().catch(() => {});
    }

    setTimeout(() => {
      importBtn.disabled = false;
      importBtn.textContent = "导入并分析情绪";
    }, 2000);
  } catch (err) {
    importBtn.disabled = false;
    importBtn.textContent = "导入并分析情绪";
    throw err;
  }
}

function showImportResult(result) {
  const box = byId("eeg-import-result");
  const errorBox = byId("eeg-import-error");
  if (!box) return;

  box.classList.remove("hidden");
  if (errorBox) errorBox.classList.add("hidden");

  const e = result.emotion || {};
  const labelColors = {
    calm: "#15803d", neutral: "#5f6f81", stress: "#dc2626",
    sad: "#6366f1", anxiety: "#f59e0b"
  };

  box.innerHTML = `
    <div style="margin-bottom:6px">
      <span class="emotion-badge" style="background:${labelColors[e.label] || '#5f6f81'}; color:#fff">${e.label || "?"}</span>
      <span>置信度: ${(e.confidence || 0).toFixed(2)}</span>
    </div>
    <div style="font-size:13px; color:#5f6f81">判定依据: ${e.reasons || "-"}</div>
    <div style="font-size:13px; color:#5f6f81; margin-top:4px">
      导入 ${result.channelCount} 通道 | ${result.format} 格式 | ${result.eegPushed ? "已同步到当前会话" : "独立导入"}
    </div>
  `;
}

function showImportError(msg) {
  const box = byId("eeg-import-error");
  const resultBox = byId("eeg-import-result");
  if (!box) return;

  box.classList.remove("hidden");
  box.textContent = msg;
  if (resultBox) resultBox.classList.add("hidden");
}

function clearPreview() {
  pendingCsvData = null;
  pendingFilename = null;
  byId("eeg-preview").classList.add("hidden");
  byId("eeg-import-result").classList.add("hidden");
  byId("eeg-import-error").classList.add("hidden");
  byId("eeg-file-input").value = "";
}
```

- [ ] **Step 4: Wire setupEEGImport into init function**

In `app.js`, inside the `init()` function, add after `bindActions();`:

```js
  setupEEGImport();
```

- [ ] **Step 5: Test the UI flow**

Start server and open `http://127.0.0.1:5050`, navigate to session view, verify:
- Drop zone appears in the session view
- Clicking opens file picker
- Dragging a CSV file shows preview
- Clicking "导入并分析情绪" calls the API and shows result

- [ ] **Step 6: Commit**

```bash
git add mindcap-mvp/public/index.html mindcap-mvp/public/app.js mindcap-mvp/public/styles.css
git commit -m "feat: add EEG file import panel with drag-drop and preview"
```

---

### Task 6: End-to-end integration test

- [ ] **Step 1: Full flow test**

```bash
cd mindcap-mvp
node server/server.js &
sleep 2

# 1. Start session
SESSION=$(curl -s -X POST http://127.0.0.1:5050/api/session/start -H "Content-Type: application/json" -d '{"userId":"u001"}')
SID=$(echo "$SESSION" | grep -o '"sessionId":"[^"]*"' | head -1 | cut -d'"' -f4)
echo "Session: $SID"

# 2. Import EEG CSV (band format)
IMPORT=$(curl -s -X POST http://127.0.0.1:5050/api/eeg/import \
  -H "Content-Type: application/json" \
  -d "{\"csvData\":\"channel,delta,theta,alpha,beta,gamma\nAF3,0.5,0.8,1.2,0.6,0.3\nAF4,0.4,0.7,1.0,0.9,0.2\nF3,0.6,0.9,0.8,1.5,0.4\nF4,0.5,0.8,0.7,1.6,0.3\",\"filename\":\"test_bands.csv\",\"sessionId\":\"$SID\"}")
echo "Import result:"
echo "$IMPORT" | python3 -m json.tool 2>/dev/null || echo "$IMPORT"

# 3. Check that session state has the emotion updated
STATE=$(curl -s http://127.0.0.1:5050/api/session/$SID/state)
echo "Session emotion:" $(echo "$STATE" | grep -o '"currentEmotion":{"label":"[^"]*"' | head -1)

# 4. List imports for session
IMPORTS=$(curl -s "http://127.0.0.1:5050/api/eeg/imports?sessionId=$SID")
echo "Imports count:" $(echo "$IMPORTS" | grep -o '"id"' | wc -l)

kill %1 2>/dev/null
```

Expected: Import returns emotion detection, session emotion updated, imports listed.

- [ ] **Step 2: Commit any fixes**

```bash
git add -A && git status
```
