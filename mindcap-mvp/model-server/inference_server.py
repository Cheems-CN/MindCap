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
            x = x3.view(-1, NUM_CHANNELS, x3.size(-1))
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

def build_edge_index():
    edges = [[], []]
    conns = [(0, 1), (1, 2), (2, 3),  # chain
             (0, 0), (1, 1), (2, 2), (3, 3)]  # self-loops
    for src, tgt in conns:
        edges[0].append(src); edges[1].append(tgt)
        edges[0].append(tgt); edges[1].append(src)
    return torch.LongTensor(edges)

EDGE_INDEX = build_edge_index()


# ── Feature adapter: band values -> model input ────────────────────

BAND_ORDER = ["delta", "theta", "alpha", "beta", "gamma"]

def bands_to_model_input(channels_data):
    """Convert MindCap channel band data to model input tensor.
    Model expects 2400-dim features per node (checkpoint trained with num_features=2400).
    """
    if len(channels_data) < 4:
        return None

    channels = channels_data[:4]
    node_features = []

    for ch in channels:
        bands = []
        for band in BAND_ORDER:
            val = ch.get(band, 0) or 0
            bands.append(float(val))

        # Build 300-dim base: PSD(150) + DE(150) from 5 bands repeated
        band_30 = np.tile(bands, 30)  # (150,)
        base_feat = np.concatenate([band_30, band_30])  # (300,)

        # Checkpoint expects 2400 = 300 * 8. Repeat base to match.
        feat_2400 = np.tile(base_feat, 8)  # (2400,)
        node_features.append(feat_2400)

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

    predictions = []
    for i, (en, cn) in enumerate(zip(MODEL_EMOTIONS_EN, MODEL_EMOTIONS_CN)):
        predictions.append({
            "class_id": i,
            "label_en": en,
            "label_cn": cn,
            "probability": float(probs[i]),
            "mindcap_label": MODEL_TO_MINDCAP[i]["label"]
        })

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
    model = EEGGCN(num_features=2400, hidden_channels=256, num_classes=9).to(device)
    model.load_state_dict(torch.load(model_path, map_location=device))
    model.eval()
    print(f"Model loaded from {model_path}")

    port = int(os.environ.get("MODEL_PORT", 5051))
    print(f"Starting on http://127.0.0.1:{port}")
    app.run(host="127.0.0.1", port=port, debug=False)
