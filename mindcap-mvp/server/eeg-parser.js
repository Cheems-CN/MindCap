const { parse } = require("csv-parse/sync");

/**
 * Detect CSV format type from headers:
 *  - "bands": first column is 'channel'/'electrode', remaining are band names
 *  - "raw": columns are channel names (AF3, TP9, etc.), rows are time samples
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
    const bandKeywords = ["delta", "theta", "alpha", "beta", "gamma"];
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
          channels.push({
            channelName: String(channelName).trim(),
            band: String(band).trim(),
            value: val,
          });
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
        channels.push({
          channelName: String(chName).trim(),
          band: "raw",
          value: values.reduce((a, b) => a + b, 0) / values.length,
        });
      }
    }
  }

  return channels;
}

/**
 * Simple threshold-based emotion mapping from channel/band data.
 *
 * Rules:
 *  - High alpha/beta ratio at frontal sites -> relaxed/calm
 *  - Low alpha/beta ratio at frontal sites -> stress/anxiety
 *  - Right-dominant frontal alpha -> sad (negative affect)
 *  - Globally elevated beta -> anxiety
 *  - Default -> neutral
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
    const alpha = bands["alpha"] || 0;
    const beta = bands["beta"] || 0;

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
      const beta = bandByChannel[chName]["beta"] || 0;
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
    } else if (alphaBetaRatio < 1.0) {
      label = "stress";
      confidence = Math.min(0.9, 0.5 + (1.0 - alphaBetaRatio) * 0.4);
      reasons.push(`低α/β比 (${alphaBetaRatio.toFixed(2)})`);
    } else {
      reasons.push(`中α/β比 (${alphaBetaRatio.toFixed(2)})`);
    }
  }

  // Rule 2: Frontal asymmetry
  if (leftCount > 0 && rightCount > 0) {
    const leftAvg = leftAlpha / leftCount;
    const rightAvg = rightAlpha / rightCount;
    if (rightAvg > leftAvg * 1.3) {
      if (label === "neutral" || label === "calm") {
        label = "sad";
        confidence = Math.min(0.85, 0.5 + (rightAvg / Math.max(leftAvg, 0.01) - 1) * 0.25);
      }
      reasons.push(`右额叶α优势 (L:${leftAvg.toFixed(2)}, R:${rightAvg.toFixed(2)})`);
    }
  }

  // Rule 3: Globally elevated beta -> anxiety
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

const MODEL_SERVER_URL = process.env.MODEL_SERVER_URL || "http://127.0.0.1:5051";

/**
 * Call Python inference server for model prediction.
 * @param {"gcn"|"mserm"} model
 * @param {Object} data - { channels } for GCN, { raw_signal } for MS-ERM
 */
async function predictWithModel(model, data) {
  try {
    const endpoint = model === "mserm" ? "/predict/mserm" : "/predict/gcn";
    const resp = await fetch(`${MODEL_SERVER_URL}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(5000)
    });
    if (!resp.ok) return null;
    const result = await resp.json();
    if (result.top_class) {
      return {
        label: result.top_class.mindcap_label,
        confidence: result.top_class.mindcap_confidence,
        source: result.model,
        detail: {
          model_class_cn: result.top_class.label_cn,
          model_probability: result.top_class.probability,
        }
      };
    }
    return null;
  } catch (err) {
    return null;
  }
}

/**
 * Parse raw signal CSV: rows = time samples, columns = channels.
 * Returns 2D array [channel][time_sample].
 */
function parseRawSignalCSV(csvText) {
  const lines = csvText.trim().split("\n").filter(Boolean);
  const headers = lines[0].split(/[,\t;]/).map(h => h.trim());

  const channels = [];
  for (let c = 0; c < headers.length; c++) {
    channels.push([]);
  }

  for (let r = 1; r < lines.length; r++) {
    const vals = lines[r].split(/[,\t;]/);
    for (let c = 0; c < headers.length; c++) {
      channels[c].push(parseFloat(vals[c]) || 0);
    }
  }

  return { channels, channelNames: headers, sampleCount: lines.length - 1 };
}

/**
 * Fetch available models from inference server.
 */
async function getAvailableModels() {
  try {
    const resp = await fetch(`${MODEL_SERVER_URL}/models`, { signal: AbortSignal.timeout(3000) });
    if (!resp.ok) return [];
    const data = await resp.json();
    return data.models || [];
  } catch (err) {
    return [];
  }
}

/**
 * Main parse function: takes CSV text, returns { imp, channels, emotion }.
 * @param {string} model - "gcn" or "mserm" or "auto"
 */
async function parseEEGFile(csvText, filename, sessionId, model = "auto") {
  // Handle raw signal format for MS-ERM
  if (model === "mserm") {
    const rawData = parseRawSignalCSV(csvText);
    const rawSignal = rawData.channels;
    const channelCount = rawSignal.length;

    const uniqueChannels = new Set(rawData.channelNames);
    const emotion = mapToEmotion(
      rawData.channelNames.map((name, i) => ({
        channelName: name, band: "raw", value: rawSignal[i].reduce((a,b)=>a+b,0)/rawSignal[i].length
      }))
    );

    // Try MS-ERM model
    let isModel = false;
    const modelResult = await predictWithModel("mserm", { raw_signal: rawSignal });
    if (modelResult) {
      isModel = true;
      emotion.label = modelResult.label;
      emotion.confidence = modelResult.confidence;
      emotion.reasons = `MS-ERM模型: ${modelResult.detail.model_class_cn} (${(modelResult.detail.model_probability * 100).toFixed(1)}%)`;
      emotion.modelDetail = modelResult.detail;
    }

    return {
      imp: {
        sessionId: sessionId || null, filename: filename || "unknown.csv",
        channelCount, sampleCount: rawData.sampleCount, durationSec: null,
        sampleRate: null, device: null, formatType: "raw_signal",
        detectedEmotionLabel: emotion.label, detectedEmotionConfidence: emotion.confidence,
        time: new Date().toISOString(), emotionSource: isModel ? "mserm" : "rules"
      },
      channels: rawData.channelNames.map((name, i) => ({
        channelName: name, band: "raw", value: rawSignal[i].reduce((a,b)=>a+b,0)/rawSignal[i].length
      })),
      emotion
    };
  }

  // GCN / auto: band format
  const parsed = parseCsvContent(csvText);
  const channels = extractChannels(parsed);
  let emotion = mapToEmotion(channels);
  let isModel = false;

  // Try GCN model if >=4 channels
  if (model === "gcn" || model === "auto") {
    if (channels.length >= 4) {
      const channelData = [];
      const bandMap = {};
      for (const ch of channels) {
        if (!bandMap[ch.channelName]) { bandMap[ch.channelName] = { channelName: ch.channelName }; }
        bandMap[ch.channelName][ch.band] = ch.value;
      }
      const modelChannels = Object.values(bandMap);

      const modelResult = await predictWithModel("gcn", { channels: modelChannels });
      if (modelResult) {
        isModel = true;
        emotion = {
          label: modelResult.label, confidence: modelResult.confidence,
          reasons: `GCN模型: ${modelResult.detail.model_class_cn} (${(modelResult.detail.model_probability * 100).toFixed(1)}%)`,
          alphaBetaRatio: emotion.alphaBetaRatio, avgFrontalBeta: emotion.avgFrontalBeta,
          modelDetail: modelResult.detail
        };
      }
    }
  }

  const uniqueChannels = new Set(channels.map((c) => c.channelName));

  return {
    imp: {
      sessionId: sessionId || null, filename: filename || "unknown.csv",
      channelCount: uniqueChannels.size, sampleCount: parsed.format === "raw" ? parsed.rowCount : 0,
      durationSec: null, sampleRate: null, device: null, formatType: parsed.format,
      detectedEmotionLabel: emotion.label, detectedEmotionConfidence: emotion.confidence,
      time: new Date().toISOString(), emotionSource: isModel ? "gcn" : "rules"
    },
    channels, emotion
  };
}

module.exports = { parseEEGFile, predictWithModel, getAvailableModels, detectFormat, parseCsvContent, extractChannels, mapToEmotion };
