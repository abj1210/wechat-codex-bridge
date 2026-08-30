import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCodexEventLine } from '../codex.mjs';

test('parse delta event', () => {
  const ev = parseCodexEventLine(
    JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: 'Hello' } })
  );
  assert.equal(ev.kind, 'delta');
  assert.equal(ev.text, 'Hello');
});

test('parse final agent message', () => {
  const ev = parseCodexEventLine(
    JSON.stringify({ method: 'item/completed', params: { item: { type: 'agentMessage', text: 'done' } } })
  );
  assert.equal(ev.kind, 'final');
  assert.equal(ev.text, 'done');
});

test('parse turn status', () => {
  const ev = parseCodexEventLine(
    JSON.stringify({ method: 'turn/completed', params: { turn: { status: 'completed' } } })
  );
  assert.equal(ev.kind, 'turnStatus');
  assert.equal(ev.status, 'completed');
});

test('parse new-format item.completed', () => {
  const ev = parseCodexEventLine(
    JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: '正常' } })
  );
  assert.equal(ev.kind, 'final');
  assert.equal(ev.text, '正常');
});

test('parse new-format error', () => {
  const ev = parseCodexEventLine(
    JSON.stringify({ type: 'error', message: 'Reconnecting...' })
  );
  assert.equal(ev.kind, 'error');
});

test('parse thread.started session id', () => {
  const ev = parseCodexEventLine(
    JSON.stringify({ type: 'thread.started', thread_id: '01a050be-8592-7e82-81ab-c51ae3be1369' })
  );
  assert.equal(ev.kind, 'session');
  assert.equal(ev.id, '01a050be-8592-7e82-81ab-c51ae3be1369');
});

test('ignore malformed lines', () => {
  assert.equal(parseCodexEventLine('not json'), null);
  assert.equal(parseCodexEventLine(''), null);
});
