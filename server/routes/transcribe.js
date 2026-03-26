const express = require('express');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { getDb } = require('../db/database');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

function getSetting(db, key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row?.value || null;
}

async function assemblyAiRequest(method, urlPath, apiKey, body, isBuffer = false) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.assemblyai.com',
      path: urlPath,
      method,
      headers: {
        'Authorization': apiKey,
        'Content-Type': isBuffer ? 'application/octet-stream' : 'application/json',
      },
    };

    if (isBuffer && body) options.headers['Content-Length'] = body.length;

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) reject(new Error(parsed.error || `AssemblyAI ${res.statusCode}`));
          else resolve(parsed);
        } catch {
          reject(new Error('Invalid AssemblyAI response'));
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Distribute transcript words across scenes proportionally by word count
function assignTimingsToScenes(scenes, words) {
  if (!words || words.length === 0) return scenes;

  // Count words in each scene text
  const sceneCounts = scenes.map(s => (s.text || '').trim().split(/\s+/).filter(Boolean).length);
  const totalSceneWords = sceneCounts.reduce((a, b) => a + b, 0);
  const totalTranscriptWords = words.length;

  let wordIndex = 0;
  return scenes.map((scene, i) => {
    const proportion = totalSceneWords > 0 ? sceneCounts[i] / totalSceneWords : 1 / scenes.length;
    const wordCount = Math.max(1, Math.round(proportion * totalTranscriptWords));
    const sceneWords = words.slice(wordIndex, wordIndex + wordCount);
    wordIndex = Math.min(wordIndex + wordCount, words.length);

    if (sceneWords.length === 0) return scene;

    const start_time = parseFloat((sceneWords[0].start / 1000).toFixed(3));
    const end_time = parseFloat((sceneWords[sceneWords.length - 1].end / 1000).toFixed(3));
    const duration = parseFloat((end_time - start_time).toFixed(3));

    return { ...scene, start_time, end_time, duration: Math.max(duration, 1) };
  });
}

// POST /api/projects/:id/transcribe
router.post('/:id/transcribe', authMiddleware, async (req, res) => {
  const db = getDb();
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (req.user.role !== 'admin' && project.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Access denied' });
  }

  if (!project.audio_path || !fs.existsSync(project.audio_path)) {
    return res.status(400).json({ error: 'No audio file uploaded for this project' });
  }

  const apiKey = getSetting(db, 'assemblyai_api_key');
  if (!apiKey) return res.status(400).json({ error: 'AssemblyAI API key not configured in Settings' });

  const scenes = db.prepare('SELECT * FROM scenes WHERE project_id = ? ORDER BY scene_order').all(req.params.id);
  if (!scenes.length) return res.status(400).json({ error: 'No scenes to sync' });

  // 1. Upload audio to AssemblyAI
  const audioBuffer = fs.readFileSync(project.audio_path);
  const uploadResult = await assemblyAiRequest('POST', '/v2/upload', apiKey, audioBuffer, true);

  // 2. Request transcription with word-level timestamps
  const transcriptResult = await assemblyAiRequest('POST', '/v2/transcript', apiKey,
    Buffer.from(JSON.stringify({ audio_url: uploadResult.upload_url, punctuate: true }))
  );

  const transcriptId = transcriptResult.id;

  // 3. Poll until complete (max ~5 minutes)
  let transcript = null;
  for (let attempt = 0; attempt < 60; attempt++) {
    await sleep(5000);
    transcript = await assemblyAiRequest('GET', `/v2/transcript/${transcriptId}`, apiKey);
    if (transcript.status === 'completed') break;
    if (transcript.status === 'error') {
      return res.status(500).json({ error: 'AssemblyAI transcription failed: ' + transcript.error });
    }
  }

  if (!transcript || transcript.status !== 'completed') {
    return res.status(504).json({ error: 'Transcription timed out. Try again.' });
  }

  const words = transcript.words || [];

  // 4. Assign timings to scenes proportionally
  const updatedScenes = assignTimingsToScenes(scenes, words);

  // 5. Persist updated timings to DB
  const updateStmt = db.prepare(`
    UPDATE scenes SET start_time = ?, end_time = ?, duration = ? WHERE id = ?
  `);
  const updateAll = db.transaction((rows) => {
    for (const s of rows) updateStmt.run(s.start_time, s.end_time, s.duration, s.id);
  });
  updateAll(updatedScenes);

  const saved = db.prepare('SELECT * FROM scenes WHERE project_id = ? ORDER BY scene_order').all(req.params.id);
  res.json({ success: true, scenes: saved });
});

module.exports = router;
