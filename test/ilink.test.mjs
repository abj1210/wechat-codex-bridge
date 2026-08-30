import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildClientVersion,
  normalizeBaseUrl,
  extractText,
  isUserTextMessage,
  randomWechatUin,
  isApiError,
} from '../ilink.mjs';

test('buildClientVersion encodes major/minor/patch', () => {
  assert.equal(buildClientVersion('2.4.6'), (2 << 16) | (4 << 8) | 6);
  assert.equal(buildClientVersion('1.0.11'), (1 << 16) | 11);
});

test('normalizeBaseUrl adds https when missing', () => {
  assert.equal(normalizeBaseUrl(''), 'https://ilinkai.weixin.qq.com');
  assert.equal(normalizeBaseUrl('some.host'), 'https://some.host');
  assert.equal(normalizeBaseUrl('https://x.example'), 'https://x.example');
});

test('extractText reads text and transcribed voice items', () => {
  assert.equal(extractText({ item_list: [{ type: 1, text_item: { text: 'hello' } }] }), 'hello');
  assert.equal(extractText({ item_list: [{ type: 3, voice_item: { text: 'voice' } }] }), 'voice');
  assert.equal(extractText({ item_list: [{ type: 2 }] }), '');
});

test('isUserTextMessage rejects bot and empty messages', () => {
  assert.equal(isUserTextMessage({ message_type: 2, item_list: [{ type: 1, text_item: { text: 'x' } }] }), false);
  assert.equal(isUserTextMessage({ message_type: 1, item_list: [{ type: 1, text_item: { text: ' ' } }] }), false);
  assert.equal(isUserTextMessage({ message_type: 1, item_list: [{ type: 1, text_item: { text: 'x' } }] }), true);
});

test('randomWechatUin is base64 and changes', () => {
  const a = randomWechatUin();
  const b = randomWechatUin();
  assert.ok(Buffer.from(a, 'base64').toString('utf8'));
  assert.notEqual(a, b);
});

test('isApiError handles ret and errcode', () => {
  assert.equal(isApiError({ ret: 0 }), false);
  assert.equal(isApiError({ ret: 1 }), true);
  assert.equal(isApiError({ errcode: 0 }), false);
  assert.equal(isApiError({ errcode: -14 }), true);
  assert.equal(isApiError(null), false);
});
