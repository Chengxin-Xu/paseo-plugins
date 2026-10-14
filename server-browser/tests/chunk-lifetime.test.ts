import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createChunkLifetime } from '../client/chunk-lifetime';
import { clearFrameCache, createFrameCache, frameCache, retainFrameHost } from '../client/frame-cache';

const picture = { dataUrl: 'a'.repeat(100), width: 390, height: 760, capturedAt: 1 };

test('entry teardown clears the loaded chunk cache once, including its host sweep', () => {
  const lifetime = createChunkLifetime();
  const otherCache = createFrameCache();
  otherCache.set('other', 'workspace', picture);
  retainFrameHost('host');
  frameCache.set('host', 'workspace', picture);
  let calls = 0;
  const clearLoaded = () => { calls++; clearFrameCache(); };
  assert.equal(lifetime.attach(clearLoaded), true);
  assert.equal(lifetime.attach(clearLoaded), true, 'screen and workspace panel share one evaluated cache');
  assert.equal(frameCache.stats().entries, 1, 'registering a second surface leaves its frame intact');
  lifetime.dispose();
  lifetime.dispose();
  assert.equal(calls, 1);
  assert.deepEqual(frameCache.stats(), { entries: 0, bytes: 0 });
  assert.equal(otherCache.stats().entries, 1, 'teardown only clears the cache attached by the loaded chunk');
});

test('a chunk finishing after teardown releases its cache and cannot mount a surface', () => {
  const lifetime = createChunkLifetime();
  lifetime.dispose();
  frameCache.set('host', 'workspace', picture);
  assert.equal(lifetime.attach(clearFrameCache), false);
  assert.deepEqual(frameCache.stats(), { entries: 0, bytes: 0 });
});
