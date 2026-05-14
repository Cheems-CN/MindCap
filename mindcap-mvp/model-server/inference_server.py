"""MindCap Unified EEG Emotion Inference Server
Supports two models:
  - GCN (graph neural network, 9-class, band power input)
  - MS-ERM (MT_timenets, 2-class arousal, raw time-series input)
"""
import torch
import torch.nn.functional as F
import torch.nn as nn
import numpy as np
from flask import Flask, request, jsonify

# ── GCN Model Definition ──────────────────────────────────────────
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
        x1 = self.gat1(x1, edge_index); x1 = self.bn1(x1)
        x1 = F.relu(x1); x1 = F.dropout(x1, p=0.3, training=self.training)
        x2 = F.relu(self.conv2(x1, edge_index))
        x2 = self.gat2(x2, edge_index); x2 = self.bn2(x2)
        x2 = F.relu(x2); x2 = F.dropout(x2, p=0.3, training=self.training)
        x3 = F.relu(self.conv3(x2, edge_index)); x3 = self.bn3(x3)
        if batch is None:
            x = x3.view(-1, 4, x3.size(-1))
            x_mean = x.mean(dim=1); x_max, _ = x.max(dim=1)
            x = torch.cat([x_mean, x_max], dim=-1)
        else:
            x_mean = global_mean_pool(x3, batch)
            x_max = global_max_pool(x3, batch)
            x = torch.cat([x_mean, x_max], dim=-1)
        return F.log_softmax(self.classifier(x), dim=1)

# ── MS-ERM (TSception) Model Definition ─────────────────────────

class TSception(nn.Module):
    def conv_block(self, in_chan, out_chan, kernel, step, pool):
        return nn.Sequential(
            nn.Conv2d(in_chan, out_chan, kernel_size=kernel, stride=step),
            nn.LeakyReLU(),
            nn.AvgPool2d(kernel_size=(1, pool), stride=(1, pool)))

    def __init__(self, num_classes, input_size, sampling_rate, num_T, num_S, hidden, dropout_rate):
        super().__init__()
        self.inception_window = [0.5, 0.25, 0.125]
        self.pool = 8
        self.Tception1 = self.conv_block(1, num_T, (1, int(self.inception_window[0] * sampling_rate)), 1, self.pool)
        self.Tception2 = self.conv_block(1, num_T, (1, int(self.inception_window[1] * sampling_rate)), 1, self.pool)
        self.Tception3 = self.conv_block(1, num_T, (1, int(self.inception_window[2] * sampling_rate)), 1, self.pool)
        self.Sception1 = self.conv_block(num_T, num_S, (4, 1), 1, int(self.pool*0.25))
        self.Sception2 = self.conv_block(num_T, num_S, (2, 1), (int(input_size[1] * 0.5), 1), int(self.pool*0.25))
        self.fusion_layer = self.conv_block(num_S, num_S, (2, 1), 1, 4)
        self.BN_t = nn.BatchNorm2d(num_T)
        self.BN_s = nn.BatchNorm2d(num_S)
        self.BN_fusion = nn.BatchNorm2d(num_S)
        # Compute exact input size for fc layer
        with torch.no_grad():
            dummy = torch.zeros(1, 1, input_size[1], 512)
            y = self.Tception1(dummy); out = y
            y = self.Tception2(dummy); out = torch.cat((out, y), dim=-1)
            out = self.BN_t(out)
            z = self.Sception1(out); out_ = z
            z = self.Sception2(out); out_ = torch.cat((out_, z), dim=2)
            out = self.BN_s(out_)
            out = self.fusion_layer(out)
            out = self.BN_fusion(out)
            out = torch.squeeze(torch.mean(out, dim=-1), dim=-1)
            fc_in = out.reshape(1, -1).size(1)
        self.fc = nn.Sequential(
            nn.Linear(fc_in, 128), nn.ReLU(), nn.Dropout(dropout_rate),
            nn.Linear(128, num_classes))

    def forward(self, x):
        y = self.Tception1(x); out = y
        y = self.Tception2(x); out = torch.cat((out, y), dim=-1)
        y = self.Tception3(x); out = torch.cat((out, y), dim=-1)
        out = self.BN_t(out)
        z = self.Sception1(out); out_ = z
        z = self.Sception2(out); out_ = torch.cat((out_, z), dim=2)
        out = self.BN_s(out_)
        out = self.fusion_layer(out)
        out = self.BN_fusion(out)
        out = torch.squeeze(torch.mean(out, dim=-1), dim=-1)
        out = out.reshape(out.shape[0], -1)
        return self.fc(out)

# ── Label mappings ────────────────────────────────────────────────

GCN_EMOTIONS_CN = ['愤怒','厌恶','恐惧','悲伤','中性','娱乐','灵感','喜悦','温柔']
GCN_TO_MINDCAP = {
    0:{"label":"stress","boost":0.0}, 1:{"label":"stress","boost":0.0},
    2:{"label":"anxiety","boost":0.1}, 3:{"label":"sad","boost":0.1},
    4:{"label":"neutral","boost":0.0}, 5:{"label":"calm","boost":0.0},
    6:{"label":"calm","boost":0.05}, 7:{"label":"calm","boost":0.05},
    8:{"label":"calm","boost":0.0},
}

MSERM_LABELS = {0: "low_arousal", 1: "high_arousal"}
MSERM_LABELS_CN = {0: "低唤醒度", 1: "高唤醒度"}
MSERM_TO_MINDCAP = {
    0: {"label": "calm", "confidence_boost": 0.0},
    1: {"label": "anxiety", "confidence_boost": 0.15},
}

# ── GCN graph + adapter ───────────────────────────────────────────

GCN_NUM_CHANNELS = 4
GCN_BAND_ORDER = ["delta","theta","alpha","beta","gamma"]

def gcn_edge_index():
    e = [[],[]]
    for s,t in [(0,1),(1,2),(2,3),(0,0),(1,1),(2,2),(3,3)]:
        e[0].append(s); e[1].append(t); e[0].append(t); e[1].append(s)
    return torch.LongTensor(e)

GCN_EDGE = gcn_edge_index()

def gcn_bands_to_input(channels):
    if len(channels) < 4: return None
    feats = []
    for ch in channels[:4]:
        bands = [float(ch.get(b, 0) or 0) for b in GCN_BAND_ORDER]
        base = np.tile(bands, 30)
        feat_2400 = np.tile(np.concatenate([base, base]), 8)
        feats.append(feat_2400)
    return torch.FloatTensor(np.array(feats))

# ── MS-ERM adapter ────────────────────────────────────────────────

def mserm_signal_to_input(raw_signal):
    """Convert raw time-series to MS-ERM input (1, 1, 28, 512).
    raw_signal: list of lists, each inner list is one channel's time series.
    Returns tensor or None."""
    if not raw_signal or len(raw_signal) < 2:
        return None
    arr = np.array(raw_signal, dtype=np.float32)
    if arr.ndim == 1:
        arr = arr.reshape(1, -1)
    # Pad or truncate to (N, 512)
    n_chan, n_time = arr.shape
    target_time = 512
    if n_time < target_time:
        pad = np.zeros((n_chan, target_time - n_time), dtype=np.float32)
        arr = np.concatenate([arr, pad], axis=1)
    elif n_time > target_time:
        arr = arr[:, :target_time]
    # Pad or truncate to (28, 512)
    target_chan = 28
    if n_chan < target_chan:
        pad = np.zeros((target_chan - n_chan, target_time), dtype=np.float32)
        arr = np.concatenate([arr, pad], axis=0)
    elif n_chan > target_chan:
        arr = arr[:target_chan, :]
    x = torch.FloatTensor(arr).unsqueeze(0).unsqueeze(0)  # (1, 1, 28, 512)
    return x

# ── Flask app ─────────────────────────────────────────────────────

app = Flask(__name__)
gcn_model = None
mserm_model = None
device = None

def load_models():
    global gcn_model, mserm_model, device
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    import os
    base = os.path.dirname(__file__)

    # Load GCN
    gcn_path = os.path.join(base, "best_model.pth")
    if os.path.exists(gcn_path):
        gcn_model = EEGGCN(num_features=2400, hidden_channels=256, num_classes=9).to(device)
        gcn_model.load_state_dict(torch.load(gcn_path, map_location=device))
        gcn_model.eval()
        print(f"GCN model loaded from {gcn_path}")
    else:
        print(f"GCN model not found at {gcn_path}")

    # Load MS-ERM
    mserm_path = os.path.join(base, "mserm_max_acc.pth")
    if os.path.exists(mserm_path):
        mserm_model = TSception(
            num_classes=2, input_size=(1, 28, 512), sampling_rate=32,
            num_T=15, num_S=1, hidden=32, dropout_rate=0.2
        ).to(device)
        mserm_model.load_state_dict(torch.load(mserm_path, map_location=device), strict=False)
        mserm_model.eval()
        print(f"MS-ERM model loaded from {mserm_path}")
    else:
        print(f"MS-ERM model not found at {mserm_path}")

@app.route("/health")
def health():
    return jsonify({
        "ok": True,
        "gcn_loaded": gcn_model is not None,
        "mserm_loaded": mserm_model is not None
    })

@app.route("/models")
def list_models():
    models = []
    if gcn_model:
        models.append({
            "id": "gcn", "name": "GCN (9分类)",
            "input_type": "bands",
            "description": "输入频段功率值(delta/theta/alpha/beta/gamma)，4通道，9分类情绪识别"
        })
    if mserm_model:
        models.append({
            "id": "mserm", "name": "MS-ERM (唤醒度)",
            "input_type": "raw_signal",
            "description": "输入原始EEG时间序列，28通道×512采样点，2分类唤醒度识别(高/低)"
        })
    return jsonify({"models": models})

@app.route("/predict/gcn", methods=["POST"])
def predict_gcn():
    if gcn_model is None:
        return jsonify({"error": "GCN model not loaded"}), 503
    body = request.get_json()
    if not body or "channels" not in body:
        return jsonify({"error": "Missing 'channels' field"}), 400
    x = gcn_bands_to_input(body["channels"])
    if x is None:
        return jsonify({"error": "Need at least 4 channels"}), 400
    x = x.to(device); ei = GCN_EDGE.to(device)
    with torch.no_grad():
        probs = torch.exp(gcn_model(x, ei, batch=None)).cpu().numpy()[0]
    best = int(np.argmax(probs))
    mc = GCN_TO_MINDCAP[best]
    return jsonify({
        "model": "gcn",
        "top_class": {
            "label_cn": GCN_EMOTIONS_CN[best], "probability": float(probs[best]),
            "mindcap_label": mc["label"],
            "mindcap_confidence": min(0.95, float(probs[best]) + mc["boost"])
        },
        "all_classes": [{"class_id": i, "label_cn": GCN_EMOTIONS_CN[i], "probability": float(probs[i]), "mindcap_label": GCN_TO_MINDCAP[i]["label"]} for i in range(9)]
    })

@app.route("/predict/mserm", methods=["POST"])
def predict_mserm():
    if mserm_model is None:
        return jsonify({"error": "MS-ERM model not loaded"}), 503
    body = request.get_json()
    if not body or "raw_signal" not in body:
        return jsonify({"error": "Missing 'raw_signal' field"}), 400
    x = mserm_signal_to_input(body["raw_signal"])
    if x is None:
        return jsonify({"error": "Invalid raw_signal format"}), 400
    x = x.to(device)
    with torch.no_grad():
        out = mserm_model(x)
        probs = F.softmax(out, dim=1).cpu().numpy()[0]
    best = int(np.argmax(probs))
    mc = MSERM_TO_MINDCAP[best]
    return jsonify({
        "model": "mserm",
        "top_class": {
            "label_cn": MSERM_LABELS_CN[best], "probability": float(probs[best]),
            "mindcap_label": mc["label"],
            "mindcap_confidence": min(0.95, float(probs[best]) + mc["confidence_boost"])
        },
        "all_classes": [{"class_id": i, "label_cn": MSERM_LABELS_CN[i], "probability": float(probs[i]), "mindcap_label": MSERM_TO_MINDCAP[i]["label"]} for i in range(2)]
    })

if __name__ == "__main__":
    import os
    load_models()
    port = int(os.environ.get("MODEL_PORT", 5051))
    print(f"Unified inference server on http://127.0.0.1:{port}")
    app.run(host="127.0.0.1", port=port, debug=False)
