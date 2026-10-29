'use strict';

// pdf-chapters.js 单元测试：目录展平、章节构建与兜底切分（Node 内置 node:test）
// 常规运行：node --test tests/pdf-chapters.test.js
// 若运行环境禁止派生子进程（报 spawn EPERM），可直接 node tests/pdf-chapters.test.js，
// 或改用 node --test --test-isolation=none tests/pdf-chapters.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const chaptersApi = require('../pdf-chapters.js');

const { clampLevel, flattenOutline, outlineToChapters, buildFallbackChapters } = chaptersApi;

// 通用章节不变量：id 连续、标题非空、页码合法、按 startPage 升序
function assertChapterInvariants(chapters, pageCount) {
  assert.ok(Array.isArray(chapters), 'chapters 应为数组');
  for (let i = 0; i < chapters.length; i++) {
    const ch = chapters[i];
    assert.equal(ch.id, 'ch-' + (i + 1));
    assert.equal(typeof ch.title, 'string');
    assert.ok(ch.title.trim().length > 0, '章节标题不能为空');
    assert.ok(Number.isInteger(ch.level));
    assert.ok(Number.isInteger(ch.startPage));
    assert.ok(Number.isInteger(ch.endPage));
    assert.ok(ch.startPage >= 1, 'startPage 不能小于 1');
    assert.ok(ch.startPage <= ch.endPage, 'startPage 不能大于 endPage');
    assert.ok(ch.endPage <= pageCount, 'endPage 不能超过总页数');
    if (i > 0) assert.ok(chapters[i - 1].startPage <= ch.startPage, '章节需按 startPage 升序');
  }
}

// 兜底章节额外不变量：连续覆盖 1..pageCount
function assertFallbackCoverage(chapters, pageCount) {
  assertChapterInvariants(chapters, pageCount);
  assert.ok(chapters.length > 0);
  assert.equal(chapters[0].startPage, 1);
  assert.equal(chapters[chapters.length - 1].endPage, pageCount);
  for (let i = 0; i < chapters.length; i++) {
    assert.equal(chapters[i].level, 1);
    if (i > 0) assert.equal(chapters[i].startPage, chapters[i - 1].endPage + 1);
  }
}

// 构造 fake resolver：dest → 页码映射，兼容 string 与 JSON 序列化 key
function makeResolver(map) {
  const calls = [];
  const resolver = (dest) => {
    const key = typeof dest === 'string' ? dest : JSON.stringify(dest);
    calls.push(key);
    return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null;
  };
  resolver.calls = calls;
  return resolver;
}

test('导出 API 齐全', () => {
  assert.equal(typeof clampLevel, 'function');
  assert.equal(typeof flattenOutline, 'function');
  assert.equal(typeof outlineToChapters, 'function');
  assert.equal(typeof buildFallbackChapters, 'function');
});

/* ================= clampLevel ================= */

test('clampLevel：取整与上下界', () => {
  assert.equal(clampLevel(1), 1);
  assert.equal(clampLevel(3), 3);
  assert.equal(clampLevel(2.6), 3);
  assert.equal(clampLevel(2.4), 2);
  assert.equal(clampLevel(99), 6);
  assert.equal(clampLevel(0), 1);
  assert.equal(clampLevel(-4), 1);
  assert.equal(clampLevel('x'), 1);
  assert.equal(clampLevel(null), 1);
  assert.equal(clampLevel(undefined), 1);
  assert.equal(clampLevel(NaN), 1);
  assert.equal(clampLevel(99, 3), 3);
  assert.equal(clampLevel(3, 2.8), 2);
  assert.equal(clampLevel(5, 'x'), 5);
  assert.equal(clampLevel(7, 0), 6);
});

/* ================= flattenOutline ================= */

test('flattenOutline：三级嵌套层级与顺序正确', () => {
  const arrayDest = [3, { name: 'Fit' }];
  const childDest = { kind: 'child' };
  const outline = [
    {
      title: '第一章',
      dest: arrayDest,
      items: [
        {
          title: '1.1',
          dest: 'p2',
          items: [{ title: '1.1.1', dest: [4] }],
        },
        {
          title: '   ',
          dest: 'skip-me',
          items: [{ title: '空白项的子项', dest: 'p5' }],
        },
      ],
    },
    {
      title: '第二章',
      children: [
        { title: '2.1', dest: childDest, children: [] },
        { title: undefined },
        { title: '2.2', dest: null },
      ],
    },
  ];

  const flat = flattenOutline(outline);
  assert.equal(flat.length, 7);
  assert.deepEqual(
    flat.map((item) => [item.title, item.level, item.index]),
    [
      ['第一章', 1, 0],
      ['1.1', 2, 1],
      ['1.1.1', 3, 2],
      ['空白项的子项', 3, 3],
      ['第二章', 1, 4],
      ['2.1', 2, 5],
      ['2.2', 2, 6],
    ],
  );

  // dest 原样保存（对象/数组保持引用，null/undefined 不丢失）
  assert.equal(flat[0].dest, arrayDest);
  assert.equal(flat[1].dest, 'p2');
  assert.deepEqual(flat[2].dest, [4]);
  assert.equal(flat[3].dest, 'p5');
  assert.equal(flat[4].dest, undefined);
  assert.equal(flat[5].dest, childDest);
  assert.equal(flat[6].dest, null);

  // 空白标题项本身不输出
  assert.ok(!flat.some((item) => item.dest === 'skip-me'));
});

test('flattenOutline：非数组输入返回空数组，且不修改入参', () => {
  assert.deepEqual(flattenOutline(null), []);
  assert.deepEqual(flattenOutline(undefined), []);
  assert.deepEqual(flattenOutline('abc'), []);
  assert.deepEqual(flattenOutline({}), []);
  assert.deepEqual(flattenOutline([]), []);

  const input = [{ title: 'A', dest: 'a', items: [{ title: 'B', dest: 'b' }] }];
  const snapshot = JSON.stringify(input);
  flattenOutline(input);
  assert.equal(JSON.stringify(input), snapshot);
});

/* ================= outlineToChapters ================= */

test('outlineToChapters：多级目录生成章节，页码与层级正确', async () => {
  const outline = [
    { title: '第一章', dest: 'p1', items: [{ title: '1.1', dest: 'p3' }] },
    { title: '第二章', dest: 'p5' },
    { title: '第三章', dest: 'p8' },
  ];
  const pageCount = 10;
  const resolver = makeResolver({ p1: 1, p3: 3, p5: 5, p8: 8 });

  const result = await outlineToChapters(outline, resolver, pageCount);
  assert.equal(result.tocSource, 'outline');
  assert.equal(result.resolvedCount, 4);
  assert.equal(result.totalCount, 4);
  assert.deepEqual(result.chapters, [
    { id: 'ch-1', title: '第一章', level: 1, startPage: 1, endPage: 2 },
    { id: 'ch-2', title: '1.1', level: 2, startPage: 3, endPage: 4 },
    { id: 'ch-3', title: '第二章', level: 1, startPage: 5, endPage: 7 },
    { id: 'ch-4', title: '第三章', level: 1, startPage: 8, endPage: 10 },
  ]);
  assertChapterInvariants(result.chapters, pageCount);
});

test('outlineToChapters：同一 dest 只解析一次（缓存）', async () => {
  const outline = [
    { title: '甲', dest: 'dup' },
    { title: '乙', dest: 'dup' },
  ];
  const resolver = makeResolver({ dup: 1 });

  const result = await outlineToChapters(outline, resolver, 20);
  assert.equal(result.tocSource, 'outline');
  assert.equal(resolver.calls.length, 1);
  assert.equal(result.resolvedCount, 2);
  assert.deepEqual(
    result.chapters.map((ch) => [ch.startPage, ch.endPage]),
    [
      [1, 1],
      [1, 20],
    ],
  );
});

test('outlineToChapters：支持 async resolver 与数组 dest', async () => {
  const pageByDest = {
    '[1,{"name":"Fit"}]': 2,
    '[5]': 6,
  };
  const outline = [
    { title: '数组目标一', dest: [1, { name: 'Fit' }] },
    { title: '数组目标二', dest: [5] },
  ];
  const resolver = async (dest) => pageByDest[JSON.stringify(dest)];

  const result = await outlineToChapters(outline, resolver, 12);
  assert.equal(result.tocSource, 'outline');
  assert.deepEqual(
    result.chapters.map((ch) => [ch.title, ch.startPage, ch.endPage]),
    [
      ['数组目标一', 2, 5],
      ['数组目标二', 6, 12],
    ],
  );
});

test('outlineToChapters：目标页乱序时排序并正确计算 endPage', async () => {
  const outline = [
    { title: 'C', dest: 'p8' },
    { title: 'A', dest: 'p1' },
    { title: 'B', dest: 'p5' },
  ];
  const resolver = makeResolver({ p8: 8, p1: 1, p5: 5 });

  const result = await outlineToChapters(outline, resolver, 30);
  assert.equal(result.tocSource, 'outline');
  assert.deepEqual(
    result.chapters.map((ch) => [ch.title, ch.startPage, ch.endPage]),
    [
      ['A', 1, 4],
      ['B', 5, 7],
      ['C', 8, 30],
    ],
  );
  assertChapterInvariants(result.chapters, 30);
});

test('outlineToChapters：dest 解析为 null 的项跳过，成功率达标仍用目录', async () => {
  const outline = [
    { title: 'E1', dest: 'p1' },
    { title: 'E2', dest: 'p2' },
    { title: 'E3', dest: 'gone' },
    { title: 'E4', dest: 'p9' },
    { title: 'E5', dest: 'p10' },
  ];
  const resolver = makeResolver({ p1: 1, p2: 2, p9: 9, p10: 10 });

  const result = await outlineToChapters(outline, resolver, 10);
  assert.equal(result.tocSource, 'outline');
  assert.equal(result.resolvedCount, 4);
  assert.equal(result.totalCount, 5);
  assert.deepEqual(
    result.chapters.map((ch) => [ch.title, ch.startPage, ch.endPage]),
    [
      ['E1', 1, 1],
      ['E2', 2, 8],
      ['E4', 9, 9],
      ['E5', 10, 10],
    ],
  );
});

test('outlineToChapters：非法页码（0、负数、小数、越界、字符串）被跳过', async () => {
  const outline = [
    { title: 'T0', dest: 'r0' },
    { title: 'Tneg', dest: 'rneg' },
    { title: 'Tfrac', dest: 'rfrac' },
    { title: 'Tok', dest: 'rok' },
    { title: 'Tstr', dest: 'rstr' },
    { title: 'Tbig', dest: 'rbig' },
  ];
  const resolver = makeResolver({
    r0: 0,
    rneg: -1,
    rfrac: 1.5,
    rok: 4,
    rstr: '3',
    rbig: 21,
  });

  const result = await outlineToChapters(outline, resolver, 20, { minResolvedRatio: 0 });
  assert.equal(result.tocSource, 'outline');
  assert.equal(result.resolvedCount, 1);
  assert.equal(result.totalCount, 6);
  assert.deepEqual(result.chapters, [
    { id: 'ch-1', title: 'Tok', level: 1, startPage: 4, endPage: 20 },
  ]);
});

test('outlineToChapters：解析成功率低于 0.7 时回退按页切分', async () => {
  const outline = [
    { title: 'G1', dest: 'g1' },
    { title: 'G2', dest: 'missing2' },
    { title: 'G3', dest: 'g30' },
    { title: 'G4', dest: 'missing4' },
    { title: 'G5', dest: 'missing5' },
  ];
  const resolver = makeResolver({ g1: 1, g30: 30 });

  const result = await outlineToChapters(outline, resolver, 50);
  assert.equal(result.tocSource, 'pages');
  assert.equal(result.resolvedCount, 2);
  assert.equal(result.totalCount, 5);
  assert.deepEqual(
    result.chapters.map((ch) => [ch.title, ch.startPage, ch.endPage]),
    [
      ['第 1–20 页', 1, 20],
      ['第 21–40 页', 21, 40],
      ['第 41–50 页', 41, 50],
    ],
  );
  assertFallbackCoverage(result.chapters, 50);
});

test('outlineToChapters：pageCount=1 与空 outline', async () => {
  const single = await outlineToChapters([{ title: '唯一', dest: 'one' }], makeResolver({ one: 1 }), 1);
  assert.equal(single.tocSource, 'outline');
  assert.deepEqual(single.chapters, [
    { id: 'ch-1', title: '唯一', level: 1, startPage: 1, endPage: 1 },
  ]);

  const none = await outlineToChapters([], makeResolver({}), 30);
  assert.equal(none.tocSource, 'pages');
  assert.equal(none.resolvedCount, 0);
  assert.equal(none.totalCount, 0);
  assert.deepEqual(
    none.chapters.map((ch) => [ch.startPage, ch.endPage]),
    [
      [1, 20],
      [21, 30],
    ],
  );
  assertFallbackCoverage(none.chapters, 30);
});

test('outlineToChapters：超过 maxItems 截断，且与成功率规则交互正确', async () => {
  const outline = [
    { title: 'P1', dest: 'pp1' },
    { title: 'P2', dest: 'pp2' },
    { title: 'P3', dest: 'pp3' },
    { title: 'P4', dest: 'pp4' },
    { title: 'P5', dest: 'pp5' },
  ];
  const resolver = makeResolver({ pp1: 1, pp2: 10, pp3: 20, pp4: 25, pp5: 30 });

  // 显式关闭成功率门限，观察截断本身
  const truncated = await outlineToChapters(outline, resolver, 30, {
    maxItems: 3,
    minResolvedRatio: 0,
  });
  assert.equal(truncated.tocSource, 'outline');
  assert.equal(truncated.totalCount, 5);
  assert.equal(truncated.resolvedCount, 3);
  assert.deepEqual(
    truncated.chapters.map((ch) => [ch.title, ch.startPage, ch.endPage]),
    [
      ['P1', 1, 9],
      ['P2', 10, 19],
      ['P3', 20, 30],
    ],
  );

  // 条目多而 maxItems 小：成功率按实际解析数 / 总数计算，触发兜底
  const many = [];
  for (let i = 1; i <= 10; i++) many.push({ title: 'Q' + i, dest: 'q' + i });
  const map = {};
  for (let i = 1; i <= 10; i++) map['q' + i] = i;
  const fallback = await outlineToChapters(many, makeResolver(map), 30, { maxItems: 2 });
  assert.equal(fallback.tocSource, 'pages');
  assert.equal(fallback.totalCount, 10);
  assert.equal(fallback.resolvedCount, 2);
  assertFallbackCoverage(fallback.chapters, 30);
});

test('outlineToChapters：解析异常与非法 pageCount 不抛异常', async () => {
  const outline = [{ title: '异常', dest: 'boom' }, { title: '正常', dest: 'ok' }];
  const resolver = (dest) => {
    if (dest === 'boom') throw new Error('解析失败');
    return 2;
  };

  const tolerated = await outlineToChapters(outline, resolver, 10, { minResolvedRatio: 0 });
  assert.equal(tolerated.tocSource, 'outline');
  assert.equal(tolerated.resolvedCount, 1);
  assert.equal(tolerated.chapters.length, 1);
  assert.equal(tolerated.chapters[0].title, '正常');

  const badPageCount = await outlineToChapters([{ title: 'X', dest: 'x' }], makeResolver({ x: 1 }), 0);
  assert.deepEqual(badPageCount.chapters, []);
  assert.equal(badPageCount.tocSource, 'pages');

  const noResolver = await outlineToChapters([{ title: 'Y', dest: 'y' }], null, 5);
  assert.equal(noResolver.tocSource, 'pages');
  assertFallbackCoverage(noResolver.chapters, 5);
});

test('outlineToChapters：相同 (title, startPage) 去重保留第一条', async () => {
  const outline = [
    { title: '重复', dest: 'a' },
    { title: '重复', dest: 'b' },
  ];
  const resolver = makeResolver({ a: 3, b: 3 });

  const result = await outlineToChapters(outline, resolver, 20);
  assert.equal(result.tocSource, 'outline');
  assert.equal(result.resolvedCount, 2);
  assert.equal(result.totalCount, 2);
  assert.deepEqual(result.chapters, [
    { id: 'ch-1', title: '重复', level: 1, startPage: 3, endPage: 20 },
  ]);
});

/* ================= buildFallbackChapters ================= */

test('buildFallbackChapters：pageCount 非正整数返回空数组', () => {
  assert.deepEqual(buildFallbackChapters(0), []);
  assert.deepEqual(buildFallbackChapters(-5), []);
  assert.deepEqual(buildFallbackChapters(1.5), []);
  assert.deepEqual(buildFallbackChapters(NaN), []);
  assert.deepEqual(buildFallbackChapters('10'), []);
  assert.deepEqual(buildFallbackChapters(undefined), []);
});

test('buildFallbackChapters：0/1/20/21/45/100 的切分与连续性', () => {
  assert.deepEqual(buildFallbackChapters(0), []);

  assert.deepEqual(
    buildFallbackChapters(1).map((ch) => [ch.title, ch.startPage, ch.endPage]),
    [['第 1–1 页', 1, 1]],
  );
  assertFallbackCoverage(buildFallbackChapters(1), 1);

  const twenty = buildFallbackChapters(20);
  assert.deepEqual(
    twenty.map((ch) => [ch.startPage, ch.endPage]),
    [[1, 20]],
  );
  assertFallbackCoverage(twenty, 20);

  const twentyOne = buildFallbackChapters(21);
  assert.deepEqual(
    twentyOne.map((ch) => [ch.title, ch.startPage, ch.endPage]),
    [
      ['第 1–20 页', 1, 20],
      ['第 21–21 页', 21, 21],
    ],
  );
  assertFallbackCoverage(twentyOne, 21);

  const fortyFive = buildFallbackChapters(45);
  assert.deepEqual(
    fortyFive.map((ch) => [ch.startPage, ch.endPage]),
    [
      [1, 20],
      [21, 40],
      [41, 45],
    ],
  );
  assertFallbackCoverage(fortyFive, 45);

  const hundred = buildFallbackChapters(100);
  assert.equal(hundred.length, 5);
  assert.deepEqual(
    hundred.map((ch) => [ch.startPage, ch.endPage]),
    [
      [1, 20],
      [21, 40],
      [41, 60],
      [61, 80],
      [81, 100],
    ],
  );
  assertFallbackCoverage(hundred, 100);
});

test('buildFallbackChapters：自定义 pagesPerChapter 与非法值回退', () => {
  const custom = buildFallbackChapters(10, { pagesPerChapter: 7 });
  assert.deepEqual(
    custom.map((ch) => [ch.startPage, ch.endPage]),
    [
      [1, 7],
      [8, 10],
    ],
  );

  // 非法值（0 / 负数 / NaN / 非数字）回退默认 20
  for (const bad of [0, -5, NaN, 'abc', null, undefined]) {
    const chapters = buildFallbackChapters(21, { pagesPerChapter: bad });
    assert.deepEqual(
      chapters.map((ch) => [ch.startPage, ch.endPage]),
      [
        [1, 20],
        [21, 21],
      ],
      'pagesPerChapter=' + String(bad),
    );
  }

  // 小数向下取整，且最小为 1 页
  assert.equal(buildFallbackChapters(3, { pagesPerChapter: 0.5 }).length, 3);
  assert.deepEqual(
    buildFallbackChapters(3, { pagesPerChapter: 0.5 }).map((ch) => [ch.startPage, ch.endPage]),
    [
      [1, 1],
      [2, 2],
      [3, 3],
    ],
  );
});

test('buildFallbackChapters：自定义标题函数与异常标题回退', () => {
  const custom = buildFallbackChapters(10, {
    pagesPerChapter: 4,
    pageTitle: (start, end) => 'P' + start + '-' + end,
  });
  assert.deepEqual(
    custom.map((ch) => ch.title),
    ['P1-4', 'P5-8', 'P9-10'],
  );

  const fallbackTitle = buildFallbackChapters(5, {
    pageTitle: () => {
      throw new Error('标题函数异常');
    },
  });
  assert.equal(fallbackTitle.length, 1);
  assert.equal(fallbackTitle[0].title, '第 1–5 页');

  const emptyTitle = buildFallbackChapters(5, { pageTitle: () => '   ' });
  assert.equal(emptyTitle[0].title, '第 1–5 页');
});

test('章节不变量汇总：目录章节与兜底章节均满足基本约束', async () => {
  const outline = [
    { title: '一级甲', dest: 'a', items: [{ title: '二级甲', dest: 'b' }] },
    { title: '一级乙', dest: 'c' },
  ];
  const result = await outlineToChapters(outline, makeResolver({ a: 2, b: 6, c: 30 }), 60);
  assert.equal(result.tocSource, 'outline');
  assertChapterInvariants(result.chapters, 60);

  for (const pageCount of [1, 20, 21, 45, 100]) {
    assertFallbackCoverage(buildFallbackChapters(pageCount), pageCount);
  }
});
