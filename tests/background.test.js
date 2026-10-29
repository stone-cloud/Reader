'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const bg = require('../background.js');

function makeFile(overrides) {
  return Object.assign({
    name: 'wallpaper.jpg',
    type: 'image/jpeg',
    size: 1024,
  }, overrides || {});
}

test('validateFile：合法的 jpg / png / webp 通过', () => {
  assert.deepEqual(bg.validateFile(makeFile()), { ok: true });
  assert.deepEqual(bg.validateFile(makeFile({ name: 'a.PNG', type: 'image/png' })), { ok: true });
  assert.deepEqual(bg.validateFile(makeFile({ name: 'b.webp', type: 'image/webp' })), { ok: true });
  assert.deepEqual(bg.validateFile(makeFile({ name: 'c.jpeg', type: 'image/jpeg' })), { ok: true });
});

test('validateFile：空文件 / 缺失文件', () => {
  assert.deepEqual(bg.validateFile(null), { ok: false, code: 'empty' });
  assert.deepEqual(bg.validateFile(undefined), { ok: false, code: 'empty' });
  assert.deepEqual(bg.validateFile(makeFile({ size: 0 })), { ok: false, code: 'empty' });
  assert.deepEqual(bg.validateFile(makeFile({ size: -1 })), { ok: false, code: 'empty' });
});

test('validateFile：超过 8MB 上限', () => {
  const tooLarge = bg.validateFile(makeFile({ size: 8 * 1024 * 1024 + 1 }));
  assert.equal(tooLarge.ok, false);
  assert.equal(tooLarge.code, 'too-large');
  assert.equal(bg.validateFile(makeFile({ size: 8 * 1024 * 1024 })).ok, true);
});

test('validateFile：扩展名与 MIME 校验', () => {
  const badExt = bg.validateFile(makeFile({ name: 'wallpaper.gif', type: 'image/gif' }));
  assert.equal(badExt.ok, false);
  assert.equal(badExt.code, 'bad-extension');

  const noExt = bg.validateFile(makeFile({ name: 'wallpaper', type: 'image/jpeg' }));
  assert.equal(noExt.code, 'bad-extension');

  const badMime = bg.validateFile(makeFile({ name: 'wallpaper.jpg', type: 'text/plain' }));
  assert.equal(badMime.ok, false);
  assert.equal(badMime.code, 'bad-mime');

  // MIME 缺失时允许，扩展名兜底
  assert.deepEqual(bg.validateFile(makeFile({ type: '' })), { ok: true });
});

test('validateFile：永不抛异常', () => {
  assert.doesNotThrow(() => bg.validateFile({ name: null, type: null, size: 'x' }));
  assert.equal(bg.validateFile({ name: null, type: null, size: 'x' }).code, 'empty');
});

test('normalizeOverlay：clamp 到 [0,1]，非法值回退 0.72', () => {
  assert.equal(bg.normalizeOverlay(0), 0);
  assert.equal(bg.normalizeOverlay(1), 1);
  assert.equal(bg.normalizeOverlay(0.72), 0.72);
  assert.equal(bg.normalizeOverlay(2), 1);
  assert.equal(bg.normalizeOverlay(-1), 0);
  assert.equal(bg.normalizeOverlay('0.5'), 0.5);
  assert.equal(bg.normalizeOverlay(''), 0.72);
  assert.equal(bg.normalizeOverlay('abc'), 0.72);
  assert.equal(bg.normalizeOverlay(null), 0.72);
  assert.equal(bg.normalizeOverlay(undefined), 0.72);
  assert.equal(bg.normalizeOverlay(NaN), 0.72);
});

test('overlayColor：三套主题的遮罩基色正确，未知主题按 light', () => {
  assert.equal(bg.overlayColor('light', 0.72), 'rgba(255,255,255,0.72)');
  assert.equal(bg.overlayColor('sepia', 0.5), 'rgba(245,239,224,0.5)');
  assert.equal(bg.overlayColor('dark', 1), 'rgba(18,18,20,1)');
  assert.equal(bg.overlayColor('unknown-theme', 0), 'rgba(255,255,255,0)');
  assert.equal(bg.overlayColor(undefined, 0.72), 'rgba(255,255,255,0.72)');
  // 越界值仍会被 normalize
  assert.equal(bg.overlayColor('dark', 5), 'rgba(18,18,20,1)');
});

test('LIMITS：与需求约定一致', () => {
  assert.equal(bg.LIMITS.maxBytes, 8 * 1024 * 1024);
  assert.equal(bg.LIMITS.maxLongEdge, 4096);
  assert.deepEqual(bg.LIMITS.extensions, ['.jpg', '.jpeg', '.png', '.webp']);
  assert.deepEqual(bg.LIMITS.mimeTypes, ['image/jpeg', 'image/png', 'image/webp']);
});

test('DOM 相关 API 在 Node 下安全 no-op', () => {
  assert.doesNotThrow(() => bg.apply({ url: 'blob:fake', overlay: 0.5, theme: 'dark' }));
  assert.doesNotThrow(() => bg.clear());
  assert.equal(bg.getActiveUrl(), null);
  // prepareImage 在 Node 下明确抛 unsupported（不是 ReferenceError）
  return bg.prepareImage(makeFile()).then(
    () => assert.fail('should reject in Node'),
    (err) => assert.equal(err.code, 'unsupported')
  );
});
