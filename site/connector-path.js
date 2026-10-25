// Interpolate the same lane samples used to position the event markers.
export function laneYAt(samples, x) {
  if (x <= samples[0].x) return samples[0].y;
  if (x >= samples.at(-1).x) return samples.at(-1).y;
  let lo = 0, hi = samples.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >>> 1;
    if (samples[mid].x < x) lo = mid; else hi = mid;
  }
  const a = samples[lo], b = samples[hi];
  return a.y + (b.y - a.y) * (x - a.x) / (b.x - a.x);
}

export function connectorPoints(samples, from, to, strength = 1) {
  const dx = to.x - from.x;
  if (dx <= 0) return [{...from}, {...to}];
  const startOffset = from.y - laneYAt(samples, from.x);
  const endOffset = to.y - laneYAt(samples, to.x);
  const power = 1 + 2 * Math.max(0, Math.min(3, strength));
  // Even subdivision includes the temporal midpoint exactly.
  const steps = Math.max(8, Math.min(96, 2 * Math.ceil(dx / 24)));
  return Array.from({length: steps + 1}, (_, i) => {
    if (i === 0) return {...from};
    if (i === steps) return {...to};
    const u = i / steps;
    const a = u ** power, b = (1 - u) ** power;
    const blend = a / (a + b);
    const x = from.x + dx * u;
    return {x, y: laneYAt(samples, x) + startOffset * (1 - blend) + endOffset * blend};
  });
}

export function followLanePath(samples, from, to, strength = 1) {
  const points = connectorPoints(samples, from, to, strength);
  if (to.x <= from.x) return `M${from.x},${from.y} L${to.x},${to.y}`;
  let path = `M${from.x},${from.y}`;
  // Cubic segments interpolate the sampled lane-relative S-curve. Their x
  // controls stay within each segment, preserving the horizontal time order.
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    const prev = points[Math.max(0, i - 1)], next = points[Math.min(points.length - 1, i + 2)];
    const dx = (b.x - a.x) / 3;
    const slopeA = (b.y - prev.y) / (b.x - prev.x);
    const slopeB = (next.y - a.y) / (next.x - a.x);
    path += ` C${a.x + dx},${a.y + slopeA * dx} ${b.x - dx},${b.y - slopeB * dx} ${b.x},${b.y}`;
  }
  return path;
}
