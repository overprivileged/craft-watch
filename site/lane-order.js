// Custom lane order: names listed in `order` come first, in that order; the rest keep data order.
export function orderApps(apps, order) {
  if (!Array.isArray(order) || order.length === 0) return [...apps];
  const rank = new Map(order.map((name, index) => [name, index]));
  return apps
    .map((app, index) => ({ app, index, rank: rank.get(app.name) ?? Infinity }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.app);
}

// Index of the lane slot nearest to y.
export function dropIndex(y, slots) {
  let best = 0;
  for (let i = 1; i < slots.length; i++) if (Math.abs(slots[i] - y) < Math.abs(slots[best] - y)) best = i;
  return best;
}

export function moveItem(list, from, to) {
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

// Moves a visible lane while hidden apps keep their place relative to the others.
export function reorderNames(allNames, visibleNames, from, to) {
  if (from === to || visibleNames.length < 2) return [...allNames];
  const moved = visibleNames[from];
  const visible = moveItem(visibleNames, from, to);
  const rest = allNames.filter((name) => name !== moved);
  const after = visible[to + 1];
  const at = after === undefined ? rest.indexOf(visible[to - 1]) + 1 : rest.indexOf(after);
  rest.splice(at, 0, moved);
  return rest;
}

export function normalizeOrder(value) {
  return Array.isArray(value) && value.every((name) => typeof name === 'string') && value.length ? value : null;
}
