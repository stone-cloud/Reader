'use strict';

// lang-detect.js 单元测试：文件名语言判定（Node 内置 node:test，无依赖）
// 常规运行：node --test tests/lang-detect.test.js
// 若运行环境禁止派生子进程（报 spawn EPERM），可直接 node tests/lang-detect.test.js，
// 或改用 node --test --test-isolation=none tests/lang-detect.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const lang = require('../lang-detect.js');

test('导出与常量', () => {
  assert.equal(typeof lang.tokenize, 'function');
  assert.equal(typeof lang.detect, 'function');
  assert.deepEqual(lang.EN_TOKENS, ['en', 'eng']);
  assert.deepEqual(lang.ZH_TOKENS, ['zh', 'cn', 'chs', 'cht']);
});

test('英文标记命中：en / eng，扩展名大小写不敏感', () => {
  assert.deepEqual(lang.detect('book-en.pdf'), {
    lang: 'en',
    source: 'filename',
    matched: { en: ['en'], zh: [] },
    tokens: ['book', 'en'],
  });

  const upper = lang.detect('BOOK-EN-v2.PDF');
  assert.equal(upper.lang, 'en');
  assert.equal(upper.source, 'filename');
  assert.deepEqual(upper.tokens, ['book', 'en', 'v2']);
  assert.deepEqual(upper.matched, { en: ['en'], zh: [] });

  const eng = lang.detect('book-ENG.pdf');
  assert.equal(eng.lang, 'en');
  assert.equal(eng.source, 'filename');
  assert.deepEqual(eng.matched.en, ['eng']);
});

test('中文标记命中：zh / cn / chs / cht', () => {
  const zh = lang.detect('chinese-zh.pdf');
  assert.equal(zh.lang, 'zh');
  assert.equal(zh.source, 'filename');
  assert.deepEqual(zh.matched.zh, ['zh']);

  const cn = lang.detect('book-cn.pdf');
  assert.equal(cn.lang, 'zh');
  assert.equal(cn.source, 'filename');
  assert.deepEqual(cn.matched.zh, ['cn']);

  const chs = lang.detect('book-CHS.pdf');
  assert.equal(chs.lang, 'zh');
  assert.equal(chs.source, 'filename');

  const cht = lang.detect('book_cht.pdf');
  assert.equal(cht.lang, 'zh');
  assert.equal(cht.source, 'filename');
});

test('book-zh-CN.pdf：两个中文 token，不算冲突', () => {
  const result = lang.detect('book-zh-CN.pdf');
  assert.equal(result.lang, 'zh');
  assert.equal(result.source, 'filename');
  assert.notEqual(result.source, 'conflict');
  assert.deepEqual(result.tokens, ['book', 'zh', 'cn']);
  assert.deepEqual(result.matched.zh, ['zh', 'cn']);
  assert.deepEqual(result.matched.en, []);
});

test('英文与中文同时命中：中文优先并标记 conflict', () => {
  const result = lang.detect('book-en-zh.pdf');
  assert.equal(result.lang, 'zh');
  assert.equal(result.source, 'conflict');
  assert.deepEqual(result.matched.en, ['en']);
  assert.deepEqual(result.matched.zh, ['zh']);

  const engZh = lang.detect('novel-ENG-cht.pdf');
  assert.equal(engZh.source, 'conflict');
  assert.equal(engZh.lang, 'zh');
});

test('词边界精确匹配：包含 en/zh 子串但不等于 token 的判为默认中文', () => {
  for (const name of [
    'seven.pdf',
    'reader.pdf',
    'garden.pdf',
    'enjoy.pdf',
    'english-book.pdf',
    'chinese-book.pdf',
  ]) {
    const result = lang.detect(name);
    assert.equal(result.lang, 'zh', name + ' 应为默认中文');
    assert.equal(result.source, 'default', name + ' 应为默认来源');
    assert.deepEqual(result.matched, { en: [], zh: [] });
  }
});

test('空值与异常输入：不抛异常，回退默认中文', () => {
  for (const value of ['', null, undefined, 123, {}, [], true, NaN]) {
    let result;
    assert.doesNotThrow(() => {
      result = lang.detect(value);
    });
    assert.equal(result.lang, 'zh');
    assert.equal(result.source, 'default');
    assert.deepEqual(result.tokens, []);
    assert.deepEqual(result.matched, { en: [], zh: [] });
  }
});

test('tokenize：中文书名、无扩展名、只去最后一段扩展名', () => {
  const tokens = lang.tokenize('《书名》zh版.pdf');
  assert.deepEqual(tokens, ['zh']);

  assert.deepEqual(lang.tokenize('EN'), ['en']);
  assert.deepEqual(lang.tokenize('book.en.pdf'), ['book', 'en']);
  assert.deepEqual(lang.tokenize('a.b.c.PDF'), ['a', 'b', 'c']);
  assert.deepEqual(lang.tokenize('第1章.pdf'), ['1']);
  assert.deepEqual(lang.tokenize('.pdf'), ['pdf']);
  assert.deepEqual(lang.tokenize(''), []);
  assert.deepEqual(lang.tokenize(null), []);
});

test('无扩展名文件按 token 判定', () => {
  const result = lang.detect('EN');
  assert.equal(result.lang, 'en');
  assert.equal(result.source, 'filename');
  assert.deepEqual(result.tokens, ['en']);

  const zhOnly = lang.detect('资料-cht');
  assert.equal(zhOnly.lang, 'zh');
  assert.equal(zhOnly.source, 'filename');
});

test('返回结构完整，且每次调用返回全新数组', () => {
  const first = lang.detect('book-en.pdf');
  assert.deepEqual(Object.keys(first).sort(), ['lang', 'matched', 'source', 'tokens']);
  assert.ok(Array.isArray(first.tokens));
  assert.ok(Array.isArray(first.matched.en));
  assert.ok(Array.isArray(first.matched.zh));

  first.matched.en.push('污染');
  const second = lang.detect('book-en.pdf');
  assert.deepEqual(second.matched.en, ['en']);
});
