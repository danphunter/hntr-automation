/**
 * Breaks a script into scenes based on paragraph breaks and natural pauses.
 * Returns an array of scene objects with timing estimates.
 */
export function analyzeScript(script, totalDuration = null) {
  if (!script?.trim()) return [];

  // Split on double newlines (paragraph breaks) or sentence boundaries
  const rawBlocks = script
    .split(/\n{2,}/)
    .map(b => b.trim())
    .filter(b => b.length > 10);

  // If no paragraph breaks, split on sentences
  const blocks = rawBlocks.length > 1
    ? rawBlocks
    : splitIntoSentenceGroups(script, 3);

  // Estimate duration per scene proportionally (avg reading ~130 wpm, voiceover ~140 wpm)
  const wordCounts = blocks.map(b => b.split(/\s+/).length);
  const totalWords = wordCounts.reduce((a, b) => a + b, 0);

  // Default: estimate 140 words per minute voiceover
  const estimatedTotalSec = totalDuration || (totalWords / 140) * 60;

  let currentTime = 0;
  return blocks.map((text, i) => {
    const proportion = wordCounts[i] / totalWords;
    const duration = Math.max(3, Math.round(estimatedTotalSec * proportion * 10) / 10);
    const startTime = currentTime;
    const endTime = startTime + duration;
    currentTime = endTime;

    return {
      id: `scene-${Date.now()}-${i}`,
      scene_order: i,
      text: text.trim(),
      start_time: parseFloat(startTime.toFixed(1)),
      end_time: parseFloat(endTime.toFixed(1)),
      duration: parseFloat(duration.toFixed(1)),
      image_prompt: '',
      image_url: '',
      status: 'pending',
    };
  });
}

function splitIntoSentenceGroups(text, groupSize = 3) {
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
  const groups = [];
  for (let i = 0; i < sentences.length; i += groupSize) {
    groups.push(sentences.slice(i, i + groupSize).join(' ').trim());
  }
  return groups.filter(g => g.length > 10);
}

export function recalcTimings(scenes) {
  let current = 0;
  return scenes.map(s => {
    const start = parseFloat(current.toFixed(1));
    const end = parseFloat((current + s.duration).toFixed(1));
    current = end;
    return { ...s, start_time: start, end_time: end };
  });
}

export function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}
