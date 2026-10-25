export const SYMBOLS = Object.freeze({ dot: '● Dot', circle: '○ Circle', square: '□ Square', diamond: '◆ Diamond', cross: '× Cross', star: '★ Star', triangle: '▲ Triangle' });
// Glow on line: percent opacity of translucent, additive markers; 0 is off.
export const GLOW_LEVELS = Object.freeze({ 0: 'Off', 6: '6%', 12: '12%', 25: '25%', 37: '37%', 50: '50%' });
export const DEFAULT_APPEARANCE = Object.freeze({
  commits: { shape: 'dot', position: 'on', size: 4.5, glow: 0 },
  releases: { shape: 'star', position: 'on', size: 18, labelHeight: 2, glow: 0 },
  opened: { shape: 'triangle', position: 'on', size: 8, glow: 0 },
  prs: { shape: 'circle', position: 'above', size: 8, glow: 0 },
  issues: { shape: 'square', position: 'below', size: 8, glow: 0 },
  merged: { shape: 'diamond', position: 'on', size: 10, glow: 0 },
  closed: { shape: 'cross', position: 'on', size: 10, glow: 0 },
  arcs: { position: 'above', size: 1.8, mode: 'lifetime', lineSize: 1.8, connectorShape: 'straight', bend: 1 },
});
export function normalizeAppearance(values = {}) {
  return Object.fromEntries(Object.entries(DEFAULT_APPEARANCE).map(([key, fallback]) => {
    const value = values?.[key] ?? {};
    const size = Number(value.size);
    const validSize = (typeof value.size === 'number' || typeof value.size === 'string') && Number.isFinite(size) && size >= (key === 'arcs' ? 0.5 : 2) && size <= (key === 'arcs' ? 8 : 48);
    return [key, {
      ...(key === 'arcs' ? {} : { shape: Object.hasOwn(SYMBOLS, value.shape) ? value.shape : fallback.shape }),
      position: ['above', 'on', 'below'].includes(value.position) ? value.position : fallback.position,
      size: validSize ? size : fallback.size,
      ...(key === 'arcs' ? { connectorShape: value.connectorShape === 'follow' ? 'follow' : 'straight', bend: (typeof value.bend === 'number' || (typeof value.bend === 'string' && value.bend.trim() !== '')) && Number.isFinite(Number(value.bend)) && Number(value.bend) >= 0 && Number(value.bend) <= 3 ? Number(value.bend) : fallback.bend, mode: value.mode === 'connect' ? 'connect' : 'lifetime', lineSize: (typeof value.lineSize === 'number' || typeof value.lineSize === 'string') && Number.isFinite(Number(value.lineSize)) && Number(value.lineSize) >= 0.5 && Number(value.lineSize) <= 8 ? Number(value.lineSize) : fallback.lineSize } : {}),
      ...(key === 'arcs' ? {} : { glow: Object.hasOwn(GLOW_LEVELS, String(value.glow)) ? Number(value.glow) : fallback.glow }),
      ...(key === 'releases' ? { labelHeight: (typeof value.labelHeight === 'number' || typeof value.labelHeight === 'string') && Number.isFinite(Number(value.labelHeight)) && Number(value.labelHeight) >= 0.5 && Number(value.labelHeight) <= 5 ? Number(value.labelHeight) : fallback.labelHeight } : {}),
    }];
  }));
}
export function symbolOffset(style) {
  return style.position === 'on' ? 0 : (style.position === 'above' ? -1 : 1) * (12 + style.size / 2);
}
export function arcDirection(style) {
  return style.position === 'above' ? 1 : style.position === 'below' ? -1 : 0;
}
export function resolutionEvent(pr) {
  const type = pr.merged_at ? 'merged' : pr.state !== 'OPEN' && pr.closed_at ? 'closed' : null;
  const t = Date.parse(type === 'merged' ? pr.merged_at : type === 'closed' ? pr.closed_at : '');
  return type && Number.isFinite(t) ? { type, t } : null;
}
