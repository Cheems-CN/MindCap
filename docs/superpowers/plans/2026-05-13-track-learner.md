# 反馈驱动策略优化 Implementation Plan

**Goal:** Build feedback-driven intervention track selection learning system.

**Architecture:** New `track_stats` SQLite table + `track-learner.js` module. `matchTrackByContext` gains history-first lookup. Strategy panel shows emotion-track matrix. Report page adds best-track card.

---

### Task 1: Add track_stats table + queries

**Files:** Modify `server/db.js`

- Add `track_stats` table after `feedback` table
- Add query functions: `upsertTrackStat`, `getBestTrack`, `getTrackMatrix`
- Add to exports

### Task 2: Create track-learner.js

**Files:** Create `server/track-learner.js`

- `recordFeedback(emotionLabel, trackKey, helpful, moodDelta)` calls db.upsertTrackStat
- `getBestTrack(emotionLabel, minSamples = 3)` calls db.getBestTrack
- `getTrackMatrix()` calls db.getTrackMatrix

### Task 3: Update server.js

**Files:** Modify `server/server.js`

- Import track-learner
- Modify `matchTrackByContext` to accept emotionLabel and try getBestTrack first
- Modify `buildMemoryAwareSuggestions` to pass emotionLabel
- Modify `POST /api/feedback` handler to call recordFeedback
- Modify `GET /api/strategy` to include trackMatrix

### Task 4: Update frontend strategy panel

**Files:** Modify `public/index.html`, `public/app.js`

- Add track matrix table in strategy panel
- Add `renderTrackMatrix()` function
- Show suggestion source label

### Task 5: Update report page

**Files:** Modify `public/report.html`

- Add 5th stat card "最有效轨道"
- API already returns bestTrack from Task 3

### Task 6: Integration test
