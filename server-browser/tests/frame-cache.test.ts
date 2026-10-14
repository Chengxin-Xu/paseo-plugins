import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFrameCache } from '../client/frame-cache';
const picture = (length = 10) => ({ dataUrl: 'a'.repeat(length), width: 390, height: 760, capturedAt: 1 });
test('recent pictures evict by count using access order, then by total UTF-16 bytes', () => {
  const cache = createFrameCache(2, 60, 1000);
  cache.set('host', 'a', picture()); cache.set('host', 'b', picture()); cache.get('host', 'a'); cache.set('host', 'c', picture());
  assert.equal(cache.get('host', 'b'), undefined); assert(cache.get('host', 'a'));
  cache.set('host', 'd', picture(25)); assert.deepEqual(cache.stats(), { entries: 1, bytes: 50 });
  cache.set('host', 'oversized', picture(31)); assert.equal(cache.get('host', 'oversized'), undefined);
});
test('TTL, stopped workspaces and host teardown release cached pictures', () => {
  let now = 0; const cache = createFrameCache(12, 1000, 100, () => now);
  cache.set('host-a', 'one', picture()); cache.set('host-a', 'two', picture()); cache.set('host-b', 'one', picture());
  cache.retain('host-a', new Set(['two'])); assert.equal(cache.get('host-a', 'one'), undefined);
  cache.clearHost('host-a'); assert(cache.get('host-b', 'one')); assert.equal(cache.stats().entries, 1);
  now = 101; assert.equal(cache.get('host-b', 'one'), undefined); assert.equal(cache.stats().bytes, 0);
});
test('workspace and host keys cannot collide, replacing a frame releases its byte charge', () => {
  const cache = createFrameCache(12, 1000);
  cache.set('host:a', 'b', picture()); cache.set('host', 'a:b', picture(20));
  cache.set('host:a', 'b', picture(5)); assert.deepEqual(cache.stats(), { entries: 2, bytes: 50 });
  cache.clear(); assert.deepEqual(cache.stats(), { entries: 0, bytes: 0 });
});
