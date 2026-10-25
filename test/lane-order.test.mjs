import test from 'node:test';
import assert from 'node:assert/strict';
import { orderApps, dropIndex, moveItem, reorderNames, normalizeOrder } from '../site/lane-order.js';

const apps = ['ArtCraft', 'PhotoCraft', 'FilmCraft', 'PdfCraft'].map((name) => ({ name }));
const names = (list) => list.map((app) => app.name);

test('custom order leads and unlisted apps keep data order', () => {
  assert.deepEqual(names(orderApps(apps, null)), ['ArtCraft', 'PhotoCraft', 'FilmCraft', 'PdfCraft']);
  assert.deepEqual(names(orderApps(apps, ['FilmCraft', 'ArtCraft'])), ['FilmCraft', 'ArtCraft', 'PhotoCraft', 'PdfCraft']);
  assert.deepEqual(names(orderApps(apps, ['Gone', 'PdfCraft'])), ['PdfCraft', 'ArtCraft', 'PhotoCraft', 'FilmCraft']);
});

test('a dragged label drops into the nearest lane slot', () => {
  const slots = [230, 330, 430, 530];
  assert.equal(dropIndex(100, slots), 0);
  assert.equal(dropIndex(370, slots), 1);
  assert.equal(dropIndex(390, slots), 2);
  assert.equal(dropIndex(900, slots), 3);
});

test('moving an item shifts the others', () => {
  assert.deepEqual(moveItem(['a', 'b', 'c', 'd'], 0, 2), ['b', 'c', 'a', 'd']);
  assert.deepEqual(moveItem(['a', 'b', 'c', 'd'], 3, 0), ['d', 'a', 'b', 'c']);
});

test('reordering visible lanes keeps hidden apps in place', () => {
  const all = ['A', 'B', 'C', 'D', 'E'];
  // C is hidden; moving A below D puts it just after D, C stays between B and D.
  assert.deepEqual(reorderNames(all, ['A', 'B', 'D', 'E'], 0, 2), ['B', 'C', 'D', 'A', 'E']);
  // Moving E to the top puts it before A.
  assert.deepEqual(reorderNames(all, ['A', 'B', 'D', 'E'], 3, 0), ['E', 'A', 'B', 'C', 'D']);
  // Moving to the last visible slot puts it after the previous last.
  assert.deepEqual(reorderNames(all, ['A', 'B', 'D'], 0, 2), ['B', 'C', 'D', 'A', 'E']);
  assert.deepEqual(reorderNames(all, ['A', 'B'], 1, 1), all);
});

test('stored order must be a list of names', () => {
  assert.deepEqual(normalizeOrder(['A', 'B']), ['A', 'B']);
  assert.equal(normalizeOrder([]), null);
  assert.equal(normalizeOrder('A,B'), null);
  assert.equal(normalizeOrder([1, 2]), null);
});
