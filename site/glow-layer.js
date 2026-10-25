const SVG_NS = 'http://www.w3.org/2000/svg';

// Rasterize each distinct SVG symbol once, then add its pixels on a single canvas.
// Keeping fill/stroke together in a sprite matches the SVG group's opacity.
function symbolSprite(document, symbol, ratio) {
  const shape = symbol.firstElementChild;
  const scale = symbol.transform.baseVal.getItem(0).matrix.a;
  const extent = 6 * scale + 2;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = Math.ceil(extent * 2 * ratio);
  const context = canvas.getContext('2d');
  context.setTransform(scale * ratio, 0, 0, scale * ratio, canvas.width / 2, canvas.height / 2);
  const value = name => Number(shape.getAttribute(name));
  const path = new Path2D(shape.getAttribute('d') ?? '');
  if (shape.localName === 'circle') path.arc(0, 0, value('r'), 0, Math.PI * 2);
  if (shape.localName === 'rect') path.roundRect(value('x'), value('y'), value('width'), value('height'), value('rx'));
  const fill = shape.getAttribute('fill'), stroke = shape.getAttribute('stroke');
  if (fill && fill !== 'none') { context.fillStyle = fill; context.fill(path); }
  if (stroke && stroke !== 'none') {
    context.strokeStyle = stroke;
    context.lineWidth = value('stroke-width');
    context.stroke(path);
  }
  return canvas;
}

// The SVG hit targets and labels stay in place. Only marker pixels are batched;
// no per-point blend surfaces, and no canvas work during hover or drag previews.
export function createGlowLayer(svg, layout) {
  const document = svg.ownerDocument;
  const canvas = document.createElementNS('http://www.w3.org/1999/xhtml', 'canvas');
  const context = canvas.getContext('2d');
  if (!context) return null;
  const element = document.createElementNS(SVG_NS, 'foreignObject');
  for (const [name, value] of Object.entries({ class: 'glow-canvas', x: 0, y: layout.top, width: layout.width, height: layout.height, 'aria-hidden': 'true' })) {
    element.setAttribute(name, value);
  }
  element.append(canvas);
  const sprites = new Map();
  let pending = 0, ratio = 0;

  function paint() {
    pending = 0;
    // Match the displayed resolution, with a bounded backing store for tall maps.
    const nextRatio = Math.min(2, Math.max(0.25, svg.clientWidth / layout.width * (window.devicePixelRatio || 1)));
    if (nextRatio !== ratio) {
      ratio = nextRatio;
      canvas.width = Math.ceil(layout.width * ratio);
      canvas.height = Math.ceil(layout.height * ratio);
      sprites.clear();
    }
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.setTransform(ratio, 0, 0, ratio, 0, -layout.top * ratio);
    context.globalCompositeOperation = 'lighter';
    for (const holder of svg.querySelectorAll('.glow')) {
      const symbol = holder.querySelector('.event-symbol');
      if (!symbol) continue;
      const key = symbol.getAttribute('transform') + symbol.firstElementChild.outerHTML;
      if (!sprites.has(key)) sprites.set(key, symbolSprite(document, symbol, ratio));
      const sprite = sprites.get(key);
      const position = holder.transform.baseVal.getItem(0).matrix;
      const laneOpacity = Number(holder.closest('[data-repo]')?.getAttribute('opacity') ?? 1);
      context.globalAlpha = Number(holder.style.getPropertyValue('--glow-opacity')) * laneOpacity;
      const width = sprite.width / ratio, height = sprite.height / ratio;
      context.drawImage(sprite, position.e - width / 2, position.f - height / 2, width, height);
    }
  }

  function invalidate() {
    if (!pending) pending = requestAnimationFrame(paint);
  }
  const observer = new ResizeObserver(invalidate);
  observer.observe(svg);
  return {
    element,
    invalidate,
    dispose() {
      cancelAnimationFrame(pending);
      observer.disconnect();
      sprites.clear();
      element.remove();
    },
  };
}
