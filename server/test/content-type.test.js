import test from 'node:test';
import assert from 'node:assert/strict';
import { detectContentType } from '../src/content-type.js';

test('类型识别规则（单元，按 api.md 顺序）', () => {
  // 1. JSON
  assert.equal(detectContentType('{"a":1}'), 'json');
  assert.equal(detectContentType('  [1, 2, 3]  '), 'json');
  assert.equal(detectContentType('{"nested":{"b":[true,null]}}'), 'json');
  // JSON 优先于 code（含 {} 与换行）
  assert.equal(detectContentType('{\n  "a": 1\n}'), 'json');

  // 2. URL：单行 + ^https?://\S+$
  assert.equal(detectContentType('https://example.com'), 'url');
  assert.equal(detectContentType('http://localhost:2547/api?x=1'), 'url');
  assert.equal(detectContentType('https://a.com\nhttps://b.com'), 'text'); // 多行不算
  assert.equal(detectContentType('ftp://example.com'), 'text');
  assert.equal(detectContentType('看这个 https://example.com'), 'text');

  // 3. code：含换行 + 特征
  assert.equal(detectContentType('def main():\n    pass'), 'code');
  assert.equal(detectContentType('const a = 1;\nconst b = 2;'), 'code');
  assert.equal(detectContentType('#include <stdio.h>\nint main() {}'), 'code');
  assert.equal(detectContentType('package main\nfunc main() {}'), 'code');
  assert.equal(detectContentType('const a = 1;'), 'text'); // 单行不算 code

  // 4. 其余 text
  assert.equal(detectContentType('hello world'), 'text');
  assert.equal(detectContentType('第一行\n第二行'), 'text');
  assert.equal(detectContentType('{broken json'), 'text');
});
