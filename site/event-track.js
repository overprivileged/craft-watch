// One map layer of one lane: time-sorted records, of which only the visible range has DOM nodes.
// A redraw then costs the points the display limits allow, not the whole history.
export function createTrack(key, records, make, group) {
  records.sort((a, b) => a.t - b.t);
  return { key, records, make, group, from: 0, to: 0 };
}

function node(track, index) {
  const record = track.records[index];
  record.el ??= track.make(record);
  return record.el;
}

function nodes(track, from, to) {
  const fragment = track.group.ownerDocument.createDocumentFragment();
  for (let index = from; index < to; index++) fragment.append(node(track, index));
  return fragment;
}

// Mounts records [from, to) and unmounts the rest, touching only what changed.
// Nodes stay in time order, so a later event draws above an earlier one.
export function showRange(track, from, to) {
  if (from === track.from && to === track.to) return false;
  if (from >= track.to || to <= track.from) {
    for (let index = track.from; index < track.to; index++) track.records[index].el.remove();
    if (from < to) track.group.append(nodes(track, from, to));
  } else {
    for (let index = track.from; index < from; index++) track.records[index].el.remove();
    for (let index = to; index < track.to; index++) track.records[index].el.remove();
    if (from < track.from) track.group.prepend(nodes(track, from, track.from));
    if (to > track.to) track.group.append(nodes(track, track.to, to));
  }
  track.from = from;
  track.to = to;
  return true;
}
