import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bindInput, contextHolds, followBatch, frameMatchesSession, sameTarget } from '../client/input-target';
import { sessionSchema } from '../shared/browser';
const session = sessionSchema.parse({ workspaceId: 'test', status: 'running', title: '', url: '', mode: 'manual', width: 390, height: 760, tabs: [], agentId: null, agentBusy: false, error: null, activeTabId: 'tab-a', viewRevision: 'view-1' });
const frame = { id: 'frame-1', tabId: 'tab-a', viewRevision: 'view-1', dataUrl: '', width: 390, height: 760, capturedAt: 1 };
test('a frame is usable only for the same active tab, generation, viewport and running browser', () => {
  assert(frameMatchesSession(frame, session));
  for (const changed of [{ activeTabId: 'tab-b' }, { viewRevision: 'view-2' }, { width: 1440 }, { status: 'idle' as const }]) assert.equal(frameMatchesSession(frame, { ...session, ...changed }), false);
  assert.equal(frameMatchesSession(null, session), false);
});
test('queued input retains the displayed target when the screen changes later', () => {
  const displayed = { tabId: 'tab-a', viewRevision: 'view-1' };
  const request = bindInput({ kind: 'text', text: 'private draft' }, displayed);
  displayed.tabId = 'tab-b'; displayed.viewRevision = 'view-2';
  assert.deepEqual(request?.target, { tabId: 'tab-a', viewRevision: 'view-1' });
  assert.equal(sameTarget(request?.target, displayed), false);
  assert.equal(bindInput({ kind: 'navigate', url: 'https://example.com' }, null), null);
  assert.deepEqual(bindInput({ kind: 'stop' }, null), { action: { kind: 'stop' } });
});

test('a draft remains bound to its first edit across refocus, further edits and missing frames', async () => {
  const { editDraft, emptyDraft } = await import('../client/input-target');
  const first = { tabId: 'tab-a', viewRevision: 'view-1' }, later = { tabId: 'tab-b', viewRevision: 'view-2' };
  const original = editDraft(emptyDraft(), 'https://draft.example.com', first);
  assert.equal(editDraft(original, 'https://draft.example.com/new', later), original);
  assert.equal(editDraft(original, '中文草稿', null), original);
  assert.deepEqual(original.target, first);
  const cleared = editDraft(original, '', later);
  assert.deepEqual(editDraft(cleared, '重新输入', later).target, later);
  const unbound = editDraft(emptyDraft(), '尚未显示画面时的输入', null);
  assert.equal(editDraft(unbound, '继续输入', later).target, null, 'a missing starting frame cannot be silently rebound later');
});

test('a picture stays usable for typing while own input spends it for clicks; another page context retires it', async () => {
  const { frameInScope } = await import('../client/input-target');
  const scoped = { ...session, inputScope: 'page-1' }, picture = { ...frame, inputScope: 'page-1' };
  assert(frameInScope(picture, scoped) && frameMatchesSession(picture, scoped));
  // Typing changed viewRevision only: still this page, but a click needs the next picture.
  const typed = { ...scoped, viewRevision: 'view-2' };
  assert.equal(frameInScope(picture, typed), true);assert.equal(frameMatchesSession(picture, typed), false);
  for (const changed of [{ inputScope: 'page-2' }, { activeTabId: 'tab-b' }, { width: 1440 }, { status: 'idle' as const }, { inputScope: null }]) assert.equal(frameInScope(picture, { ...typed, ...changed }), false);
  // A server without input scopes: the exact picture, as before.
  assert.equal(frameInScope(frame, { ...session, viewRevision: 'view-2' }), false);
  assert.equal(sameTarget({ tabId: 'tab-a', viewRevision: 'view-1', inputScope: 'page-1' }, { tabId: 'tab-a', viewRevision: 'view-7', inputScope: 'page-1' }), true);
  assert.equal(sameTarget({ tabId: 'tab-a', viewRevision: 'view-1', inputScope: 'page-1' }, { tabId: 'tab-a', viewRevision: 'view-1', inputScope: 'page-2' }), false);
});

test('an input method composition stays with the page context it started on: never moved to another document, tab or controller (codex-sb-F1)', () => {
  const live = sessionSchema.parse({ ...session, inputScope: 'scope-1', documentScope: 'doc-1' });
  const started = { tabId: 'tab-a', viewRevision: 'view-1', inputScope: 'scope-1', documentScope: 'doc-1' };
  assert.equal(contextHolds(started, live), true);
  assert.equal(contextHolds({ ...started, viewRevision: 'older-picture' }, live), true, 'new pictures of the same context keep it');
  assert.equal(contextHolds(started, { ...live, inputScope: 'scope-2' }), false, 'another document (or frame, device, Agent step)');
  assert.equal(contextHolds(started, { ...live, activeTabId: 'tab-b' }), false, 'another tab');
  assert.equal(contextHolds(started, { ...live, mode: 'agent' }), false);
  assert.equal(contextHolds(started, { ...live, dialog: { id: 'd', tabId: 'tab-a', type: 'alert', message: '', defaultValue: '', openedAt: 1 } }), false);
  assert.equal(contextHolds(started, { ...live, status: 'recovering' }), false);
  assert.equal(contextHolds(null, live), false, 'started without a picture: it belongs nowhere');
  // Its own context carried on by this viewer's batch is followed; one that ended with the batch ends it.
  assert.deepEqual(followBatch(started, started, { status: 'applied', continuation: 'scope-3' }), { ...started, inputScope: 'scope-3' });
  assert.equal(followBatch(started, started, { status: 'applied', continuation: null }), null);
  assert.equal(followBatch(started, started, { status: 'stale', continuation: null }), null);
  assert.equal(followBatch(started, started, { status: 'blocked', continuation: null }), null);
  assert.equal(followBatch(started, started, { status: 'busy', continuation: null }), started, 'an Agent read finishing changes nothing');
  assert.equal(followBatch(started, { ...started, inputScope: 'other' }, { status: 'stale', continuation: null }), started, 'another context’s batch does not touch it');
});
