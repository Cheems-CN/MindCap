const db = require("./db");

const TRACK_LABELS = {
  breathing: "呼吸稳定",
  task: "任务减压",
  sleep: "睡眠修复",
  social: "社交安定",
  grounding: "情绪落地"
};

function recordFeedback(emotionLabel, trackKey, helpful, moodDelta) {
  if (!emotionLabel || !trackKey) return;
  db.upsertTrackStat(emotionLabel, trackKey, helpful, moodDelta || 0);
}

function getBestTrack(emotionLabel, minSamples = 3) {
  return db.getBestTrack(emotionLabel, minSamples);
}

function getTrackMatrix() {
  return db.getTrackMatrix();
}

module.exports = { recordFeedback, getBestTrack, getTrackMatrix, TRACK_LABELS };
