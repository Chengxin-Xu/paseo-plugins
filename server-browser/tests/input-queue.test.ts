import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dropAll, droppedMessage, enqueueInput, nextInputSeq, settleBatch, splitText, takeBatch, type QueuedInput } from '../client/input-queue';
import type { BrowserInputEvent } from '../shared/browser';

const seen = { tabId: 'tab-a', viewRevision: 'picture-1', inputScope: 'page-1' };
const other = { tabId: 'tab-b', viewRevision: 'picture-9', inputScope: 'page-9' };
const entry = (event: BrowserInputEvent, target = seen, done?: (delivered: boolean) => void): QueuedInput => ({ event, target: { ...target }, done });
const text = (value: string, target = seen) => entry({ kind: 'text', text: value }, target);

test('a burst of keys typed on one picture travels as one ordered batch; text and wheel steps fold together', () => {
  const queue: QueuedInput[] = [];
  for (const key of 'abc') enqueueInput(queue, text(key));
  enqueueInput(queue, entry({ kind: 'key', key: 'Enter' }));
  enqueueInput(queue, text('d'));
  enqueueInput(queue, entry({ kind: 'scroll', deltaX: 0, deltaY: 2000 }));
  enqueueInput(queue, entry({ kind: 'scroll', deltaX: 0, deltaY: 2000 }));
  assert.deepEqual(queue.map(item => item.event), [{ kind: 'text', text: 'abc' }, { kind: 'key', key: 'Enter' }, { kind: 'text', text: 'd' }, { kind: 'scroll', deltaX: 0, deltaY: 3000 }]);
  const batch = takeBatch(queue);
  assert.equal(batch.length, 4);assert.equal(queue.length, 0);
});

test('a click leads its own batch, input from another page context is never folded into this one', () => {
  const queue: QueuedInput[] = [];
  enqueueInput(queue, text('a'));
  enqueueInput(queue, entry({ kind: 'click', x: 1, y: 2 }));
  enqueueInput(queue, text('b'));
  enqueueInput(queue, text('c', other));
  // A tray send waits to hear whether it arrived, so it is never merged.
  const told: boolean[] = [];
  enqueueInput(queue, entry({ kind: 'text', text: 'tray' }, other, delivered => told.push(delivered)));
  assert.deepEqual(takeBatch(queue).map(item => item.event.kind), ['text']);
  assert.deepEqual(takeBatch(queue).map(item => item.event), [{ kind: 'click', x: 1, y: 2 }, { kind: 'text', text: 'b' }]);
  assert.deepEqual(takeBatch(queue).map(item => item.event), [{ kind: 'text', text: 'c' }, { kind: 'text', text: 'tray' }]);
  assert.equal(takeBatch(queue).length, 0);
  const many: QueuedInput[] = [];
  for (let index = 0; index < 70; index++) many.push(entry({ kind: 'key', key: 'ArrowDown' }));
  assert.equal(takeBatch(many).length, 64);assert.equal(many.length, 6);
});

test('a continuation carries the rest of the stream on; an ended page context drops it instead of moving it', () => {
  const told: string[] = [];
  const tracked = (value: string, target = seen) => entry({ kind: 'text', text: value }, target, delivered => told.push(`${value}:${delivered}`));
  // Another device typed in between: the server hands this device a new scope for its own queued keys.
  let queue = [tracked('next'), tracked('elsewhere', other)];
  let batch = [tracked('sent')];
  assert.deepEqual(settleBatch(queue, batch, { status: 'applied', applied: 1, continuation: 'page-2' }), { retry: false, dropped: [] });
  assert.deepEqual(queue.map(item => item.target.inputScope), ['page-2', 'page-9']);
  // Enter loaded a new document: keys typed for the old page are dropped and reported, not sent to the new one.
  queue = [tracked('after-enter'), tracked('elsewhere', other)];batch = [tracked('enter')];
  const ended = settleBatch(queue, batch, { status: 'applied', applied: 1, continuation: null });
  assert.deepEqual(ended.dropped.map(item => item.event), [{ kind: 'text', text: 'after-enter' }]);
  assert.deepEqual(queue.map(item => item.event), [{ kind: 'text', text: 'elsewhere' }]);
  // Refused after two of three: those two arrived, the third and everything for that page did not.
  queue = [tracked('queued')];batch = [tracked('one'), tracked('two'), tracked('three')];
  assert.deepEqual(settleBatch(queue, batch, { status: 'stale', applied: 2, continuation: null }).dropped.map(item => (item.event as { text: string }).text), ['three', 'queued']);
  // A dialog one of these events opened holds that event (pending: it finishes once answered); the rest is dropped.
  queue = [];batch = [tracked('submit'), tracked('after-dialog')];
  assert.deepEqual(settleBatch(queue, batch, { status: 'blocked', applied: 0, continuation: null, pending: true }).dropped.map(item => (item.event as { text: string }).text), ['after-dialog']);
  // A dialog that was already open ran nothing: nothing is claimed as delivered (codex-sb-F5).
  queue = [];batch = [tracked('typed-into-a-dialog')];
  assert.deepEqual(settleBatch(queue, batch, { status: 'blocked', applied: 0, continuation: null }).dropped.map(item => (item.event as { text: string }).text), ['typed-into-a-dialog']);
  // An Agent read finishing: nothing ran, the batch goes back in front, unchanged.
  queue = [tracked('later')];batch = [tracked('first')];
  assert.deepEqual(settleBatch(queue, batch, { status: 'busy', applied: 0, continuation: null }), { retry: true, dropped: [] });
  assert.deepEqual(queue.map(item => (item.event as { text: string }).text), ['first', 'later']);
  assert.deepEqual(told, ['sent:true', 'enter:true', 'after-enter:false', 'one:true', 'two:true', 'three:false', 'queued:false', 'submit:true', 'after-dialog:false', 'typed-into-a-dialog:false']);
  assert.deepEqual(dropAll(queue).length, 2);assert.equal(queue.length, 0);
});

test('dropped input is reported in words, a page dialog included; scrolling alone is dropped quietly', () => {
  assert.match(droppedMessage([text('你好'), entry({ kind: 'key', key: 'Enter' })])!, /3 个字或按键没有发送/);
  assert.match(droppedMessage([entry({ kind: 'click', x: 0, y: 0 }), text('a')])!, /点击没有执行/);
  assert.equal(droppedMessage([entry({ kind: 'scroll', deltaX: 0, deltaY: 10 })]), null);
  assert.equal(droppedMessage([]), null);
  assert.match(droppedMessage([text('lost')], 'dialog')!, /^网页弹出了对话框，刚才的 4 个字或按键没有发送/);
  assert.match(droppedMessage([entry({ kind: 'click', x: 0, y: 0 })], 'dialog')!, /网页弹出了对话框，这次点击没有执行/);
  assert.equal(droppedMessage([entry({ kind: 'scroll', deltaX: 0, deltaY: 10 })], 'dialog'), null);
});

test('long text goes in pieces of at most 10,000 UTF-16 units that never split a character (codex-sb-F6)', () => {
  const emoji = 'a'.repeat(9999) + '😀' + 'b';
  assert.deepEqual(splitText(emoji), ['a'.repeat(9999), '😀b']);
  assert.equal(splitText(emoji).join(''), emoji);
  const many = '😀'.repeat(12_000);
  const parts = splitText(many);
  assert.equal(parts.join(''), many);
  assert(parts.every(part => part.length <= 10_000 && !/^[\uDC00-\uDFFF]/.test(part) && !/[\uD800-\uDBFF]$/.test(part)));
  assert.deepEqual(splitText('x'.repeat(20_000)).map(part => part.length), [10_000, 10_000]);
  assert.deepEqual(splitText(''), []);
  assert.deepEqual(splitText('中文'), ['中文']);
});

test('a viewer numbers each batch above its own last one and above the floor of viewers the server forgot (grok-sb-F3)', () => {
  assert.equal(nextInputSeq(0, null), 1, 'a new viewer on a server without a floor starts at 1');
  assert.equal(nextInputSeq(5, { inputSeqFloor: 0 }), 6);
  assert.equal(nextInputSeq(0, { inputSeqFloor: 100 }), 101, 'a new viewer starts above the floor');
  assert.equal(nextInputSeq(7, { inputSeqFloor: 100 }), 101, 'a forgotten viewer jumps above it and keeps its order');
  assert.equal(nextInputSeq(250, { inputSeqFloor: 100 }), 251, 'a viewer already above the floor just counts on');
  assert.equal(nextInputSeq(3, {}), 4, 'an older server without the field');
});
