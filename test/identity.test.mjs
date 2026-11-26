// 固定身份纯逻辑单测：存储规范化、PUT 校验、waterfall 段落替换。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  IDENTITY_SECTION_NAME,
  normalizeIdentityPresets,
  normalizeIdentityOverrides,
  validateIdentityPut,
  applyIdentityToSections,
} from '../lib/identity.js';

const baseSections = () => [
  { name: IDENTITY_SECTION_NAME, text: 'You are an AI agent powered by DeepSeek Harness.', order: -1000 },
  { name: 'deployment:persona-prefix', text: 'Persona intro', order: 0 },
];

// ------------------------------------------------------- normalizeIdentityPresets

test('normalizeIdentityPresets：空/非法输入回退空数组', () => {
  assert.deepEqual(normalizeIdentityPresets(undefined), []);
  assert.deepEqual(normalizeIdentityPresets(null), []);
  assert.deepEqual(normalizeIdentityPresets('x'), []);
  assert.deepEqual(normalizeIdentityPresets({}), []);
});

test('normalizeIdentityPresets：过滤损坏条目，保留合法条目（含空 text）', () => {
  const out = normalizeIdentityPresets([
    null,
    { id: 'a' }, // 缺 name
    { name: 'n' }, // 缺 id
    { id: 'b', name: '  ', text: 'x' }, // name 全空白
    { id: 'c', name: 'n', text: 1 }, // text 非字符串
    { id: 'd', name: 'ok', text: '', createdAt: 1, updatedAt: 2 },
    { id: 'e', name: 'ok2', text: 'body' },
  ]);
  assert.deepEqual(out, [
    { id: 'd', name: 'ok', text: '', createdAt: 1, updatedAt: 2 },
    { id: 'e', name: 'ok2', text: 'body' },
  ]);
});

// ------------------------------------------------------ normalizeIdentityOverrides

test('normalizeIdentityOverrides：空/非法输入回退空对象', () => {
  assert.deepEqual(normalizeIdentityOverrides(undefined), {});
  assert.deepEqual(normalizeIdentityOverrides(null), {});
  assert.deepEqual(normalizeIdentityOverrides([]), {});
  assert.deepEqual(normalizeIdentityOverrides('x'), {});
});

test('normalizeIdentityOverrides：非法条目丢弃（退化为无覆盖）', () => {
  const out = normalizeIdentityOverrides({
    s1: null,
    s2: 'x',
    s3: { mode: 'bogus', text: 't' }, // 非法 mode
    s4: { mode: 'replace' }, // 合法（text 缺省补空串）
    s5: { mode: 'remove', text: '', name: 'n', takenAt: 5 },
    s6: { mode: 'replace', text: 't', name: 1, takenAt: 'x' }, // 字段类型容错
  });
  assert.deepEqual(out, {
    s4: { mode: 'replace', text: '', name: '', takenAt: 0 },
    s5: { mode: 'remove', text: '', name: 'n', takenAt: 5 },
    s6: { mode: 'replace', text: 't', name: '', takenAt: 0 },
  });
});

test('normalizeIdentityOverrides：危险键（原型污染面）直接丢弃', () => {
  const out = normalizeIdentityOverrides({
    __proto__: { mode: 'replace', text: 'evil' },
    constructor: { mode: 'replace', text: 'evil' },
    prototype: { mode: 'replace', text: 'evil' },
    ok: { mode: 'replace', text: 't' },
  });
  assert.deepEqual(out, { ok: { mode: 'replace', text: 't', name: '', takenAt: 0 } });
  // 普通赋值污染被拦截后，对象原型必须保持 Object.prototype
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
  assert.equal(out.mode, undefined); // 未被继承污染
});

// ----------------------------------------------------------- validateIdentityPut

const presets = [
  { id: 'p1', name: 'Reviewer', text: 'You are a code reviewer.' },
  { id: 'p2', name: 'NoIdentity', text: '' },
];

test('validateIdentityPut：非对象请求体拒绝', () => {
  for (const body of [null, undefined, 'x', 42, []]) {
    const r = validateIdentityPut(body, presets);
    assert.ok(r.error, `body ${JSON.stringify(body)} should fail`);
  }
});

test('validateIdentityPut：缺 sessionId 拒绝', () => {
  assert.ok(validateIdentityPut({ presetId: 'p1' }, presets).error);
  assert.ok(validateIdentityPut({ sessionId: '', presetId: 'p1' }, presets).error);
  assert.ok(validateIdentityPut({ sessionId: 42 }, presets).error);
});

test('validateIdentityPut：清除覆盖（presetId 空值，幂等）', () => {
  for (const presetId of [null, undefined, '']) {
    const r = validateIdentityPut({ sessionId: 'session-abc', presetId }, presets);
    assert.deepEqual(r, { sessionId: 'abc', override: null }); // 去 session- 前缀
  }
});

test('validateIdentityPut：危险 sessionId 拒绝（防存储对象原型污染）', () => {
  for (const sid of ['__proto__', 'constructor', 'prototype', 'session-__proto__']) {
    assert.ok(validateIdentityPut({ sessionId: sid, presetId: 'p1' }, presets).error);
    // 清除路径同样要拦，避免 delete/赋值打到危险键
    assert.ok(validateIdentityPut({ sessionId: sid, presetId: null }, presets).error);
  }
});

test('validateIdentityPut：未知 presetId 返回 404 语义', () => {
  const r = validateIdentityPut({ sessionId: 'abc', presetId: 'nope' }, presets);
  assert.equal(r.error, 'identity preset not found');
  assert.equal(r.code, 404);
});

test('validateIdentityPut：replace 模式快照（携带 presetId）', () => {
  const r = validateIdentityPut({ sessionId: 'session-abc', presetId: 'p1' }, presets);
  assert.equal(r.sessionId, 'abc');
  assert.equal(r.override.mode, 'replace');
  assert.equal(r.override.text, 'You are a code reviewer.');
  assert.equal(r.override.name, 'Reviewer');
  assert.equal(r.override.presetId, 'p1');
  assert.equal(typeof r.override.takenAt, 'number');
});

test('validateIdentityPut：空文本预设推导为 remove 模式', () => {
  const r = validateIdentityPut({ sessionId: 'abc', presetId: 'p2' }, presets);
  assert.equal(r.override.mode, 'remove');
  assert.equal(r.override.text, '');
});

// ------------------------------------------------------- applyIdentityToSections

test('applyIdentityToSections：无覆盖/非数组原样返回', () => {
  const s = baseSections();
  assert.equal(applyIdentityToSections(s, null), s);
  assert.equal(applyIdentityToSections(s, { mode: 'bogus' }), s);
  assert.equal(applyIdentityToSections('x', { mode: 'replace', text: 't' }), 'x');
});

test('applyIdentityToSections：replace 替换文本且 interpolate:false，其他段透传', () => {
  const s = baseSections();
  const out = applyIdentityToSections(s, { mode: 'replace', text: 'You are a pirate.' });
  assert.notEqual(out, s);
  assert.equal(out[0].name, IDENTITY_SECTION_NAME);
  assert.equal(out[0].text, 'You are a pirate.');
  assert.equal(out[0].interpolate, false); // 硬性要求：防 {{...}} 插值异常
  assert.equal(out[0].order, -1000);
  assert.equal(out[1], s[1]); // 其他段同一引用，零改动
});

test('applyIdentityToSections：remove 置空（渲染时空段被丢弃 = 删除身份）', () => {
  const out = applyIdentityToSections(baseSections(), { mode: 'remove', text: '' });
  assert.equal(out[0].text, '');
  assert.equal(out[0].interpolate, false);
});

test('applyIdentityToSections：段落不存在时原样返回（includeHarnessIdentity:false）', () => {
  const s = [{ name: 'deployment:persona-prefix', text: 'P', order: 0 }];
  assert.equal(applyIdentityToSections(s, { mode: 'replace', text: 't' }), s);
});
