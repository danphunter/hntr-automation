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
