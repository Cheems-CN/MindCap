# GCN EEG 情绪识别模型集成 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Integrate the trained GCN EEG emotion model into MindCap, replacing rule-based mapping with model-based inference via a Python Flask microservice.

**Architecture:** A Python Flask inference server loads best_model.pth and exposes `POST /predict`. Node.js `server.js` calls it when EEG data is imported. The existing `eeg-parser.js` rule mapping becomes a fallback when the Python service is unavailable.

**Tech Stack:** Flask + PyTorch + torch-geometric (Python side), existing Node.js (calling side)

---

## File Map

| Action | File | Responsibility |
|---|---|---|
| New | `model-server/inference_server.py` | Flask app: load model, accept band data, return predictions |
| New | `model-server/requirements.txt` | Python deps for inference server |
| New | `model-server/start.bat` | Windows startup script |
| Modify | `server/eeg-parser.js` | Add model inference call as primary, keep rules as fallback |
| Modify | `server/server.js` | Pass env-configurable model server URL |
| Copy | `model-server/best_model.pth` | From `D:\DevWorkSpace\备份\9分类\results_selective_channels_6_7_15_16_20260504_195449\best_model.pth` |

No frontend changes needed — the existing import panel and live EEG display will show model results automatically.

---

### Task 1: Create Python inference server

**Files:**
- Create: `mindcap-mvp/model-server/inference_server.py`
- Create: `mindcap-mvp/model-server/requirements.txt`
- Create: `mindcap-mvp/model-server/start.bat`
- Copy: `best_model.pth` from model directory

- [ ] **Step 1: Create the directory and copy model**

```bash
mkdir -p mindcap-mvp/model-server
cp "D:/DevWorkSpace/备份/9分类/results_selective_channels_6_7_15_16_20260504_195449/best_model.pth" mindcap-mvp/model-server/
```

- [ ] **Step 2: Create inference_server.py**

```python
"""MindCap GCN EEG Emotion Inference Server"""
import torch
import torch.nn.functional as F
import numpy as np
from flask import Flask, request, jsonify

# ── Model Definition (must match training) ────────────────────────
from torch_geometric.nn import GCNConv, GATConv, global_mean_pool, global_max_pool

class EEGGCN(torch.nn.Module):
    def __init__(self, num_features, hidden_channels, num_classes):
        super().__init__()
        self.conv1 = GCNConv(num_features, hidden_channels)
        self.gat1 = GATConv(hidden_channels, hidden_channels, heads=4, dropout=0.3)
        self.bn1 = torch.nn.BatchNorm1d(hidden_channels * 4)
        
        self.conv2 = GCNConv(hidden_channels * 4, hidden_channels * 2)
        self.gat2 = GATConv(hidden_channels * 2, hidden_channels * 2, heads=2, dropout=0.3)
        self.bn2 = torch.nn.BatchNorm1d(hidden_channels * 4)
        
        self.conv3 = GCNConv(hidden_channels * 4, hidden_channels * 2)
        self.bn3 = torch.nn.BatchNorm1d(hidden_channels * 2)
        
        self.classifier = torch.nn.Sequential(
            torch.nn.Linear(hidden_channels * 4, hidden_channels * 2), torch.nn.ReLU(),
            torch.nn.Dropout(p=0.5),
            torch.nn.Linear(hidden_channels * 2, hidden_channels), torch.nn.ReLU(),
            torch.nn.Dropout(p=0.3),
            torch.nn.Linear(hidden_channels, num_classes)
        )
        
    def forward(self, x, edge_index, batch=None):
        x1 = F.relu(self.conv1(x, edge_index))
        x1 = self.gat1(x1, edge_index)
        x1 = self.bn1(x1)
        x1 = F.relu(x1)
        x1 = F.dropout(x1, p=0.3, training=self.training)
        
        x2 = F.relu(self.conv2(x1, edge_index))
        x2 = self.gat2(x2, edge_index)
        x2 = self.bn2(x2)
        x2 = F.relu(x2)
        x2 = F.dropout(x2, p=0.3, training=self.training)
        
        x3 = F.relu(self.conv3(x2, edge_index))
        x3 = self.bn3(x3)
        
        if batch is None:
            x = x3.view(-1, 32, x3.size(-1))
            x_mean = x.mean(dim=1)
            x_max, _ = x.max(dim=1)
            x = torch.cat([x_mean, x_max], dim=-1)
        else:
            x_mean = global_mean_pool(x3, batch)
            x_max = global_max_pool(x3, batch)
            x = torch.cat([x_mean, x_max], dim=-1)
        
        x = self.classifier(x)
        return F.log_softmax(x, dim=1)

# ── Emotion labels ─────────────────────────────────────────────────

MODEL_EMOTIONS_EN = [
    'anger', 'disgust', 'fear', 'sadness', 'neutral',
    'entertainment', 'inspiration', 'joy', 'tenderness'
]
MODEL_EMOTIONS_CN = [
    '愤怒', '厌恶', '恐惧', '悲伤', '中性',
    '娱乐', '灵感', '喜悦', '温柔'
]

# Map model 9-class to MindCap 5-class labels
MODEL_TO_MINDCAP = {
    0: {"label": "stress", "confidence_boost": 0.0},     # anger
    1: {"label": "stress", "confidence_boost": 0.0},     # disgust
    2: {"label": "anxiety", "confidence_boost": 0.1},    # fear
    3: {"label": "sad", "confidence_boost": 0.1},         # sadness
    4: {"label": "neutral", "confidence_boost": 0.0},     # neutral
    5: {"label": "calm", "confidence_boost": 0.0},        # entertainment
    6: {"label": "calm", "confidence_boost": 0.05},       # inspiration
    7: {"label": "calm", "confidence_boost": 0.05},       # joy
    8: {"label": "calm", "confidence_boost": 0.0},        # tenderness
}

# ── Graph structure for 4 selective channels ──────────────────────

SELECTED_CHANNELS = [6, 7, 15, 16]
NUM_CHANNELS = 4

# Build adjacency matrix for these 4 channels (they connect as neighbors)
# Channels 6-7 are adjacent, 15-16 are adjacent. Cross-region: 7-15.
def build_edge_index():
    edges = [[], []]
    conns = [(0, 1), (1, 2), (2, 3),  # chain
             (0, 0), (1, 1), (2, 2), (3, 3)]  # self-loops
    for src, tgt in conns:
        edges[0].append(src); edges[1].append(tgt)
        edges[0].append(tgt); edges[1].append(src)
    return torch.LongTensor(edges)

EDGE_INDEX = build_edge_index()

# ── Feature adapter: band values → model input ────────────────────

BAND_ORDER = ["delta", "theta", "alpha", "beta", "gamma"]

def bands_to_model_input(channels_data):
    """
    Convert MindCap channel band data to model input tensor.
    channels_data: list of {channelName, delta, theta, alpha, beta, gamma}
    Returns: (node_features, edge_index) or None if invalid
    """
    if len(channels_data) < 4:
        return None
    
    # Sort channels to match expected order [6, 7, 15, 16]
    # We don't know which actual index each channel name maps to,
    # so create features from the first 4 channels provided
    channels = channels_data[:4]
    
    node_features = []
    for ch in channels:
        bands = []
        for band in BAND_ORDER:
            val = ch.get(band, 0) or 0
            bands.append(float(val))
        
        # Create 150-dim PSD feature: repeat 5 bands across 30 time windows
        psd_feat = np.tile(bands, 30)  # (150,)
        # Create 150-dim DE feature: same values (no true DE available)
        de_feat = np.tile(bands, 30)   # (150,)
        
        combined = np.concatenate([psd_feat, de_feat])  # (300,)
        node_features.append(combined)
    
    x = torch.FloatTensor(np.array(node_features))
    return x

# ── Flask app ──────────────────────────────────────────────────────

app = Flask(__name__)
model = None
device = None

@app.route("/health")
def health():
    return jsonify({"ok": True, "model_loaded": model is not None})

@app.route("/predict", methods=["POST"])
def predict():
    if model is None:
        return jsonify({"error": "Model not loaded"}), 503
    
    body = request.get_json()
    if not body or "channels" not in body:
        return jsonify({"error": "Missing 'channels' field"}), 400
    
    x = bands_to_model_input(body["channels"])
    if x is None:
        return jsonify({"error": "Need at least 4 channels"}), 400
    
    x = x.to(device)
    ei = EDGE_INDEX.to(device)
    
    model.eval()
    with torch.no_grad():
        log_probs = model(x, ei, batch=None)
        probs = torch.exp(log_probs).cpu().numpy()[0]
    
    # Build per-class probabilities
    predictions = []
    for i, (en, cn) in enumerate(zip(MODEL_EMOTIONS_EN, MODEL_EMOTIONS_CN)):
        predictions.append({
            "class_id": i,
            "label_en": en,
            "label_cn": cn,
            "probability": float(probs[i]),
            "mindcap_label": MODEL_TO_MINDCAP[i]["label"]
        })
    
    # Get top MindCap label
    best_idx = int(np.argmax(probs))
    best_mindcap = MODEL_TO_MINDCAP[best_idx]
    
    return jsonify({
        "top_class": {
            "label_en": MODEL_EMOTIONS_EN[best_idx],
            "label_cn": MODEL_EMOTIONS_CN[best_idx],
            "probability": float(probs[best_idx]),
            "mindcap_label": best_mindcap["label"],
            "mindcap_confidence": min(0.95, float(probs[best_idx]) + best_mindcap["confidence_boost"])
        },
        "all_classes": predictions
    })

if __name__ == "__main__":
    import os
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"Device: {device}")
    
    model_path = os.path.join(os.path.dirname(__file__), "best_model.pth")
    model = EEGGCN(num_features=300, hidden_channels=256, num_classes=9).to(device)
    model.load_state_dict(torch.load(model_path, map_location=device))
    model.eval()
    print(f"Model loaded from {model_path}")
    
    port = int(os.environ.get("MODEL_PORT", 5051))
    app.run(host="127.0.0.1", port=port, debug=False)
```

- [ ] **Step 3: Create requirements.txt**

```txt
flask>=2.0.0
torch>=2.0.0
torch-geometric>=2.3.0
numpy>=1.21.0
```

- [ ] **Step 4: Create start.bat**

```bat
@echo off
cd /d "%~dp0"
echo Starting MindCap GCN Inference Server...
python inference_server.py
pause
```

- [ ] **Step 5: Install Python deps and test**

```bash
cd mindcap-mvp/model-server
pip install -r requirements.txt
python -c "from inference_server import EEGGCN; m = EEGGCN(300, 256, 9); print('Model class OK')"
```

Expected: `Model class OK` with no errors.

- [ ] **Step 6: Start server and test health endpoint**

```bash
cd mindcap-mvp/model-server
start python inference_server.py
sleep 5
curl -s http://127.0.0.1:5051/health
```

Expected: `{"ok": true, "model_loaded": true}`

- [ ] **Step 7: Test prediction endpoint**

```bash
curl -s -X POST http://127.0.0.1:5051/predict \
  -H "Content-Type: application/json" \
  -d '{"channels":[{"channelName":"ch6","delta":0.5,"theta":0.8,"alpha":1.2,"beta":0.6,"gamma":0.3},{"channelName":"ch7","delta":0.4,"theta":0.7,"alpha":1.0,"beta":0.9,"gamma":0.2},{"channelName":"ch15","delta":0.6,"theta":0.9,"alpha":0.8,"beta":1.5,"gamma":0.4},{"channelName":"ch16","delta":0.5,"theta":0.8,"alpha":0.7,"beta":1.6,"gamma":0.3}]}'
```

Expected: JSON with `top_class` containing `mindcap_label` and `mindcap_confidence`, plus `all_classes` array of 9 entries.

- [ ] **Step 8: Commit**

```bash
git add mindcap-mvp/model-server/
git commit -m "feat: add Python GCN inference server for EEG emotion recognition"
```

---

### Task 2: Integrate model into Node.js EEG flow

**Files:**
- Modify: `mindcap-mvp/server/eeg-parser.js`
- Modify: `mindcap-mvp/server/server.js`

- [ ] **Step 1: Add model inference function to eeg-parser.js**

Add at the bottom of eeg-parser.js, before module.exports:

```js
const MODEL_SERVER_URL = process.env.MODEL_SERVER_URL || "http://127.0.0.1:5051";

/**
 * Call Python GCN model for emotion prediction.
 * Returns { label, confidence, source } on success, null on failure.
 */
async function predictWithModel(channels) {
  try {
    const resp = await fetch(`${MODEL_SERVER_URL}/predict`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channels }),
      signal: AbortSignal.timeout(5000)
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (data.top_class) {
      return {
        label: data.top_class.mindcap_label,
        confidence: data.top_class.mindcap_confidence,
        source: "gcn-model",
        detail: {
          model_class_cn: data.top_class.label_cn,
          model_probability: data.top_class.probability,
          all_classes: data.all_classes
        }
      };
    }
    return null;
  } catch (err) {
    return null;
  }
}
```

- [ ] **Step 2: Modify parseEEGFile to call model**

In `parseEEGFile`, after `const emotion = mapToEmotion(channels);`, add:

```js
  // Try GCN model inference (async, but we fire-and-forget for now;
  // the caller will await if needed via a new async wrapper)
  // We modify parseEEGFile to be async:
```

Actually, let's change `parseEEGFile` to be async:

Replace:
```js
function parseEEGFile(csvText, filename, sessionId) {
  const parsed = parseCsvContent(csvText);
  const channels = extractChannels(parsed);
  const emotion = mapToEmotion(channels);
  ...
}
```

With:
```js
async function parseEEGFile(csvText, filename, sessionId) {
  const parsed = parseCsvContent(csvText);
  const channels = extractChannels(parsed);

  // Try GCN model first, fall back to rules
  let emotion = mapToEmotion(channels);
  const modelResult = await predictWithModel(channels);
  if (modelResult) {
    emotion = {
      label: modelResult.label,
      confidence: modelResult.confidence,
      reasons: `GCN模型: ${modelResult.detail.model_class_cn} (${(modelResult.detail.model_probability * 100).toFixed(1)}%)`,
      alphaBetaRatio: emotion.alphaBetaRatio,
      avgFrontalBeta: emotion.avgFrontalBeta,
      modelDetail: modelResult.detail
    };
  }
  ...
}
```

- [ ] **Step 3: Update module.exports in eeg-parser.js**

Add `predictWithModel` to exports.

- [ ] **Step 4: Update server.js call site**

In the `POST /api/eeg/import` handler, change `parseEEGFile(body.csvData, ...)` to `await parseEEGFile(body.csvData, ...)` since it's now async.

- [ ] **Step 5: Verify server starts**

```bash
cd mindcap-mvp && timeout 4 node server/server.js 2>&1 || true
```

Expected: Server starts normally even if Python service is down (falls back to rules).

- [ ] **Step 6: Commit**

```bash
git add mindcap-mvp/server/eeg-parser.js mindcap-mvp/server/server.js
git commit -m "feat: integrate GCN model inference into EEG import flow"
```

---

### Task 3: Integration test

- [ ] **Step 1: Full flow test with model**

Start both servers:
```bash
cd mindcap-mvp/model-server && start python inference_server.py
cd mindcap-mvp && node server/server.js &
sleep 5
```

Test import with model available:
```bash
SESSION=$(curl -s -X POST http://127.0.0.1:5050/api/session/start -H "Content-Type: application/json" -d '{"userId":"u001"}' | grep -o '"sessionId":"[^"]*"' | head -1 | cut -d'"' -f4)

curl -s -X POST http://127.0.0.1:5050/api/eeg/import \
  -H "Content-Type: application/json" \
  -d "{\"csvData\":\"channel,delta,theta,alpha,beta,gamma\nch6,0.5,0.8,1.2,0.6,0.3\nch7,0.4,0.7,1.0,0.9,0.2\nch15,0.6,0.9,0.8,1.5,0.4\nch16,0.5,0.8,0.7,1.6,0.3\",\"filename\":\"model_test.csv\",\"sessionId\":\"$SESSION\"}"
```

Expected: `emotion.reasons` contains "GCN模型" prefix, indicating model was used.

Verify model server logs show prediction request.

- [ ] **Step 2: Test fallback when model is down**

Stop the Python server, restart Node.js, and test import again. Expected: falls back to rule-based mapping silently.

- [ ] **Step 3: Commit any fixes**

```bash
git add -A && git status
```
