export function selectedTimeRange(x1, x2, left, right, start, end) {
  if (![x1, x2, left, right, start, end].every(Number.isFinite) || right <= left || end <= start) return null;
  const time = x => Math.round(start + Math.max(0, Math.min(1, (x - left) / (right - left))) * (end - start));
  const from = Math.min(time(x1), time(x2)), to = Math.max(time(x1), time(x2));
  return to - from >= 1000 ? {from, to} : null;
}
export function validateZoom(from, to, availableStart, availableEnd) {
  if (from === null || to === null || from === '' || to === '') return null;
  const start = Math.max(availableStart, Number(from)), end = Math.min(availableEnd, Number(to));
  return Number.isFinite(start) && Number.isFinite(end) && end - start >= 1000 ? {from:start, to:end} : null;
}

export function installDragZoom(svg, {getRange, onStart, onCancel, onSelect, onPreview = () => {}}) {
  const ns = 'http://www.w3.org/2000/svg';
  const make = (tag, attrs) => {
    const node = document.createElementNS(ns, tag);
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
    return node;
  };
  const dateFmt = new Intl.DateTimeFormat(undefined, {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'});
  let drag = null, suppressClickUntil = 0;
  const point = event => {
    const matrix = svg.getScreenCTM();
    return matrix ? new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse()) : null;
  };
  function clear(resume = true) {
    if (!drag) return;
    const previous = drag;
    drag = null;
    if (previous.cursor?.hasPointerCapture(previous.id)) previous.cursor.releasePointerCapture(previous.id);
    previous.overlay.remove();
    onPreview(null, null);
    svg.classList.remove('selecting-time');
    if (resume) onCancel();
  }
  function draw(x) {
    const d = drag, current = Math.max(d.range.left, Math.min(d.range.right, x));
    d.x2 = current;
    const left = Math.min(d.x1, current), width = Math.abs(current - d.x1);
    d.band.setAttribute('x', left); d.band.setAttribute('width', width);
    d.line.setAttribute('x2', current);
    d.endDot.setAttribute('cx', current);
    const selected = selectedTimeRange(d.x1, current, d.range.left, d.range.right, d.range.from, d.range.to);
    onPreview(selected ? `${dateFmt.format(selected.from)} → ${dateFmt.format(selected.to)}` : 'Drag left or right to select time', selected);
  }
  svg.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !event.isPrimary || event.ctrlKey || event.metaKey || event.altKey) return;
    const range = getRange(), p = point(event);
    if (!range || !p || drag) return;
    suppressClickUntil = 0;
    const x = Math.max(range.left, Math.min(range.right, p.x)), y = Math.max(range.top, Math.min(range.bottom, p.y));
    const overlay = make('g', {'class':'time-selection', 'aria-hidden':'true'});
    const band = make('rect', {x, y:range.top, width:0, height:range.bottom - range.top, 'class':'time-selection-band'});
    const line = make('line', {x1:x,x2:x,y1:y,y2:y,'class':'time-selection-line'});
    const startDot = make('circle', {cx:x,cy:y,r:7,'class':'time-selection-dot'});
    const endDot = make('circle', {cx:x,cy:y,r:7,'class':'time-selection-dot'});
    const ripple = make('circle', {cx:x,cy:y,r:10,'class':'time-selection-ripple'});
    overlay.append(band,line,ripple,startDot,endDot);
    svg.append(overlay);
    drag = {id:event.pointerId,clientX:event.clientX,x1:x,x2:x,y,range,overlay,band,line,endDot,moved:false};
    onStart(); draw(x);
  });
  svg.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.id) return;
    const p = point(event);
    if (!p) return;
    if (!drag.moved && Math.abs(event.clientX - drag.clientX) >= 6) {
      drag.moved = true;
      // The cursor lives on one top layer: a cursor style on the svg would restyle every map element.
      drag.cursor = make('rect', {x:-1e5, y:-1e5, width:2e5, height:2e5, 'class':'time-selection-cursor'});
      drag.overlay.append(drag.cursor);
      drag.cursor.setPointerCapture(event.pointerId);
      svg.classList.add('selecting-time');
    }
    if (drag.moved) { event.preventDefault(); draw(p.x); }
  });
  // Listen on window so a short press released outside the map also cleans up.
  window.addEventListener('pointerup', event => {
    if (!drag || event.pointerId !== drag.id) return;
    const p = point(event);
    if (p && drag.moved) draw(p.x);
    const d = drag;
    const selected = d.moved ? selectedTimeRange(d.x1,d.x2,d.range.left,d.range.right,d.range.from,d.range.to) : null;
    if (d.moved) { suppressClickUntil = performance.now() + 600; event.preventDefault(); }
    clear(!selected);
    if (selected) onSelect(selected);
  });
  svg.addEventListener('pointercancel', () => clear());
  svg.addEventListener('lostpointercapture', () => clear());
  window.addEventListener('blur', () => clear());
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && drag) { suppressClickUntil = performance.now()+600; clear(); event.preventDefault(); }
  });
  svg.addEventListener('dragstart', event => event.preventDefault());
  svg.addEventListener('click', event => {
    if (performance.now() < suppressClickUntil) { event.preventDefault(); event.stopImmediatePropagation(); }
  },true);
  return {cancel:clear};
}
