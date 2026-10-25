import test from 'node:test';
import assert from 'node:assert/strict';
import { createGlowLayer } from '../site/glow-layer.js';
import { createTrack, showRange } from '../site/event-track.js';

function scene(t) {
  const names = ['window', 'requestAnimationFrame', 'cancelAnimationFrame', 'ResizeObserver', 'Path2D'];
  const previous = names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  t.after(() => {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  const frames = new Map(), canvases = [], observers = [];
  let nextFrame = 0;
  globalThis.window = { devicePixelRatio: 2 };
  globalThis.requestAnimationFrame = fn => { frames.set(++nextFrame, fn); return nextFrame; };
  globalThis.cancelAnimationFrame = id => frames.delete(id);
  globalThis.ResizeObserver = class {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe() {}
    disconnect() { this.disconnected = true; }
  };
  globalThis.Path2D = class { arc() {} roundRect() {} };
  const document = {
    createElement(tag) {
      const context = {
        draws: [], clears: 0,
        setTransform() {}, fill() {}, stroke() {},
        clearRect() { this.clears++; },
        drawImage(sprite, ...bounds) { this.draws.push({ sprite, bounds, alpha: this.globalAlpha, blend: this.globalCompositeOperation }); },
      };
      const canvas = { tag, getContext: () => context, context };
      canvases.push(canvas);
      return canvas;
    },
    createElementNS(ns, tag) {
      return tag === 'canvas' ? this.createElement(tag) : {
        attrs: {}, setAttribute(name, value) { this.attrs[name] = value; },
        append(child) { this.child = child; }, remove() { this.removed = true; },
      };
    },
  };
  const svg = { ownerDocument: document, clientWidth: 960, markers: [], querySelectorAll() { return this.markers; } };
  const transform = matrix => ({ baseVal: { getItem: () => ({ matrix }) } });
  const marker = (x, y, opacity = 0.25, laneOpacity = 1) => ({
    transform: transform({ e: x, f: y }),
    style: { getPropertyValue: () => opacity },
    closest: () => ({ getAttribute: () => laneOpacity }),
    querySelector: () => ({
      transform: transform({ a: 1 }), getAttribute: () => 'scale(1)',
      firstElementChild: {
        localName: 'circle', outerHTML: '<circle r="5" fill="#a78bfa"/>',
        getAttribute: name => ({ r: '5', fill: '#a78bfa' }[name] ?? null),
      },
    }),
  });
  const flush = () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(fn => fn()); };
  const layer = createGlowLayer(svg, { width: 1920, height: 720, top: 110 });
  return { svg, marker, layer, frames, canvases, observers, flush };
}

test('overlapping markers add on one canvas, reuse sprites and preserve per-marker/stale opacity', t => {
  const s = scene(t);
  s.svg.markers = [s.marker(100, 200), s.marker(100, 200), s.marker(300, 400, 0.5, 0.4)];
  s.layer.invalidate(); s.layer.invalidate();
  assert.equal(s.frames.size, 1, 'point changes coalesce into one paint');
  s.flush();
  assert.equal(s.canvases.length, 2, 'one surface and one shared symbol sprite');
  const { draws } = s.canvases[0].context;
  assert.deepEqual(draws.map(draw => draw.blend), ['lighter', 'lighter', 'lighter']);
  assert.deepEqual(draws.map(draw => draw.alpha), [0.25, 0.25, 0.2]);
  assert.deepEqual(draws[0].bounds, draws[1].bounds, 'overlapping events remain separate additive draws');
  assert.equal(s.frames.size, 0, 'no recurring canvas animation');
  s.layer.invalidate(); s.flush();
  assert.equal(s.canvases.length, 2, 'unchanged geometry stays cached across replay updates');
  assert.equal(s.layer.element.attrs['aria-hidden'], 'true');
});

test('removed points clear, resize refreshes resolution, and disposing a zoomed-out scene cancels queued work', t => {
  const s = scene(t);
  s.svg.markers = [s.marker(100, 200)];
  s.layer.invalidate(); s.flush();
  const canvas = s.canvases[0];
  assert.equal(canvas.width, 1920);
  s.svg.markers = [];
  s.layer.invalidate(); s.flush();
  assert.equal(canvas.context.clears, 2);
  assert.equal(canvas.context.draws.length, 1, 'a removed marker is not drawn again');
  s.svg.markers = [s.marker(100, 200)];
  s.svg.clientWidth = 1920;
  s.observers[0].callback(); s.flush();
  assert.equal(canvas.width, 3840);
  assert.equal(s.canvases.length, 3, 'resize rerasterizes the sprite');
  s.layer.invalidate();
  s.layer.dispose();
  assert.equal(s.frames.size, 0);
  assert.equal(s.observers[0].disconnected, true);
  assert.equal(s.layer.element.removed, true);
});

test('replaying within the same event range does not invalidate glow', () => {
  const record = { t: 10, el: { remove() {} } };
  const track = createTrack('commits', [record], () => record.el, {});
  track.to = 1;
  assert.equal(showRange(track, 0, 1), false);
  assert.equal(showRange(track, 0, 0), true);
  assert.equal(showRange(track, 0, 0), false);
});
