import test from 'node:test';
import assert from 'node:assert/strict';

// Importing index.js must NOT start the stdio server (guarded by a main check).
import { formatClips, formatClipHeader, truncate } from '../index.js';

test('module exports the pure formatting helpers', () => {
  assert.equal(typeof formatClips, 'function');
  assert.equal(typeof formatClipHeader, 'function');
  assert.equal(typeof truncate, 'function');
});

test('formatClips: empty / non-array input', () => {
  assert.equal(formatClips([]), 'No clips found.');
  assert.equal(formatClips(null), 'No clips found.');
  assert.equal(formatClips(undefined), 'No clips found.');
});

test('formatClipHeader: prefers title when present', () => {
  const header = formatClipHeader({ id: 42, contentType: 'url', title: 'My Link' });
  assert.equal(header, '#42 [url] (My Link)');
});

test('formatClipHeader: falls back to device/time when no title', () => {
  const createdAt = 1700000000000;
  const header = formatClipHeader({ id: 7, contentType: 'text', deviceLabel: 'macbook', createdAt });
  assert.match(header, /^#7 \[text\] \(macbook @ /);
  assert.ok(header.includes(new Date(createdAt).toISOString()));
});

test('formatClipHeader: sensible defaults for missing fields', () => {
  const header = formatClipHeader({});
  assert.match(header, /^#\? \[text\] \(unknown @ unknown-time\)$/);
});

test('truncate: leaves short strings intact', () => {
  assert.equal(truncate('hello', 500), 'hello');
});

test('truncate: cuts long strings to the limit and marks them', () => {
  const long = 'x'.repeat(1200);
  const out = truncate(long, 500);
  // 500 chars of body, then a newline + truncation marker.
  assert.ok(out.startsWith('x'.repeat(500)));
  assert.ok(out.length < long.length);
  assert.match(out, /truncated, 1200 chars total/);
});

test('formatClips: renders header + truncated body per clip, joined by separator', () => {
  const clips = [
    { id: 1, contentType: 'text', title: 'A', content: 'short body' },
    { id: 2, contentType: 'code', deviceLabel: 'phone', createdAt: 1700000000000, content: 'y'.repeat(900) },
  ];
  const out = formatClips(clips);
  assert.ok(out.includes('#1 [text] (A)'));
  assert.ok(out.includes('short body'));
  assert.ok(out.includes('#2 [code] (phone @ '));
  assert.ok(out.includes('\n\n---\n\n')); // separator between two clips
  // Second clip body is truncated.
  assert.match(out, /truncated, 900 chars total/);
  assert.ok(!out.includes('y'.repeat(900)));
});
