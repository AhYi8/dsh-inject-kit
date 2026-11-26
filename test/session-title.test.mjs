// 会话标题配置规范化与下发逻辑单元测试。
// 运行：node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSessionTitleConfig, applySessionTitleConfig, SESSION_TITLE_DEFAULTS } from '../lib/session-title.js';

// ---------------- normalizeSessionTitleConfig ----------------

test('默认值：空输入返回完整的五字段默认配置', () => {
  assert.deepEqual(normalizeSessionTitleConfig(undefined), {
    targetWords: 5,
    targetCjkCharacters: 10,
    maxInputBytes: 524288,
    maxOutputTokens: 4096,
    timeoutMs: 60000,
  });
  assert.deepEqual(normalizeSessionTitleConfig(null), { ...SESSION_TITLE_DEFAULTS });
});

test('部分字段缺省：缺失项取默认值，其余保留', () => {
  const result = normalizeSessionTitleConfig({ maxInputBytes: 1024 });
  assert.equal(result.maxInputBytes, 1024);
  assert.equal(result.timeoutMs, SESSION_TITLE_DEFAULTS.timeoutMs);
  assert.equal(Object.keys(result).length, 5);
});

test('非法输入：非正整数与浮点数被拒绝', () => {
  assert.throws(() => normalizeSessionTitleConfig({ maxInputBytes: 0 }), /maxInputBytes/);
  assert.throws(() => normalizeSessionTitleConfig({ timeoutMs: -1 }), /timeoutMs/);
  assert.throws(() => normalizeSessionTitleConfig({ targetWords: 2.5 }), /targetWords/);
  assert.throws(() => normalizeSessionTitleConfig({ maxOutputTokens: '4096' }), /maxOutputTokens/);
});

test('非法输入类型整体拒绝：数组、原始值', () => {
  assert.throws(() => normalizeSessionTitleConfig([1, 2]));
  assert.throws(() => normalizeSessionTitleConfig(42));
});

// ---------------- applySessionTitleConfig ----------------

// 构造一个最小 cordis registry 假件：values() 返回带 name 与 fibers 的运行时
function fakeRegistry(runtimes) {
  return { values: () => runtimes };
}

function fakeFiber() {
  const calls = [];
  return {
    calls,
    update(config) { calls.push(config); },
  };
}

const GOOD = { targetWords: 5, targetCjkCharacters: 10, maxInputBytes: 524288, maxOutputTokens: 4096, timeoutMs: 60000 };

test('命中目标插件：对每个 fiber 下发完整配置', () => {
  const fiberA = fakeFiber();
  const fiberB = fakeFiber();
  const ctx = { registry: fakeRegistry([
    { name: 'dsh-other-plugin', fibers: [fakeFiber()] },
    { name: 'session-title-first-prompt-llm', fibers: [fiberA, fiberB] },
  ]) };
  const result = applySessionTitleConfig(ctx, { maxInputBytes: 1024 });
  assert.equal(result.found, true);
  assert.equal(result.updated, 2);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.providers, ['session-title-first-prompt-llm']);
  // 整体替换语义：必须下发全部五个字段（缺省项补默认值），不能只发变更项
  assert.deepEqual(fiberA.calls, [{ ...GOOD, maxInputBytes: 1024 }]);
  assert.deepEqual(fiberB.calls, [{ ...GOOD, maxInputBytes: 1024 }]);
});

test('命中 all-prompts 提供方（标题 bundle 启用模式）：同样下发完整配置', () => {
  // 启用 dsh-experimental-session-titles-bundle 后，first-prompt 行被禁用、
  // registry 里只有 all-prompts 运行时——配置必须能跟过去
  const fiber = fakeFiber();
  const ctx = { registry: fakeRegistry([
    { name: 'session-title-all-prompts-llm', fibers: [fiber] },
  ]) };
  const result = applySessionTitleConfig(ctx, GOOD);
  assert.equal(result.found, true);
  assert.equal(result.updated, 1);
  assert.deepEqual(result.providers, ['session-title-all-prompts-llm']);
  assert.deepEqual(fiber.calls, [GOOD]);
});

test('未命中（标题 bundle 未启用）：静默返回 found=false', () => {
  const ctx = { registry: fakeRegistry([{ name: 'dsh-other-plugin', fibers: [fakeFiber()] }]) };
  const result = applySessionTitleConfig(ctx, GOOD);
  assert.deepEqual(result, { found: false, updated: 0, errors: [], providers: [] });
});

test('ctx 无 registry（异常宿主）：不抛错', () => {
  assert.deepEqual(applySessionTitleConfig({}, GOOD), { found: false, updated: 0, errors: [], providers: [] });
  assert.deepEqual(applySessionTitleConfig(undefined, GOOD), { found: false, updated: 0, errors: [], providers: [] });
});

test('fiber.update 抛错（原生 Schema 校验失败）：错误被收集，其余 fiber 继续下发', () => {
  const ok = fakeFiber();
  const bad = { update() { throw new Error('invalid config: timeoutMs'); } };
  const ctx = { registry: fakeRegistry([
    { name: 'session-title-first-prompt-llm', fibers: [bad, ok] },
  ]) };
  const result = applySessionTitleConfig(ctx, GOOD);
  assert.equal(result.found, true);
  assert.equal(result.updated, 1);
  assert.deepEqual(result.errors, ['invalid config: timeoutMs']);
  assert.deepEqual(ok.calls, [GOOD]);
});

test('传入非法设置：直接抛错（调用方 REST 层负责先校验）', () => {
  const ctx = { registry: fakeRegistry([]) };
  assert.throws(() => applySessionTitleConfig(ctx, { timeoutMs: 0 }), /timeoutMs/);
});
