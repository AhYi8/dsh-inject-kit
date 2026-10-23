// resolveRefs 单元测试：覆盖命中、未命中、边界与防递归场景。
// 运行：node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRefs } from '../lib/refs.js';

const prompts = new Map([
  ['code-review', { content: '请逐文件评审代码。' }],
  ['tdd', { content: '先写失败测试再实现。' }],
]);

test('行首命中：替换为 Prompt 内容', () => {
  const { text, hits } = resolveRefs('#code-review 请开始', prompts);
  assert.equal(text, '请逐文件评审代码。 请开始');
  assert.deepEqual(hits, ['code-review']);
});

test('空白/标点前缀命中：保留前缀字符', () => {
  assert.equal(resolveRefs('用 #tdd 流程', prompts).text, '用 先写失败测试再实现。 流程');
  assert.equal(resolveRefs('（#tdd）', prompts).text, '（先写失败测试再实现。）');
  assert.equal(resolveRefs('"#tdd"', prompts).text, '"先写失败测试再实现。"');
});

test('未命中的名称原样保留', () => {
  const { text, hits } = resolveRefs('看看 #unknown-name', prompts);
  assert.equal(text, '看看 #unknown-name');
  assert.deepEqual(hits, []);
});

test('一条消息多个引用全部替换', () => {
  const { text, hits } = resolveRefs('#code-review 之后走 #tdd', prompts);
  assert.equal(text, '请逐文件评审代码。 之后走 先写失败测试再实现。');
  assert.deepEqual(hits, ['code-review', 'tdd']);
});

test('防递归：Prompt 内容中的 # 名称不再被扫描', () => {
  const recursive = new Map([['loop', { content: '内容里含 #loop 与 #tdd 原文' }]]);
  const { text, hits } = resolveRefs('x #loop', recursive);
  assert.equal(text, 'x 内容里含 #loop 与 #tdd 原文');
  assert.deepEqual(hits, ['loop']);
});

test('非法上下文不命中：字母紧邻 / 行中无前缀', () => {
  // abc#code-review 的 # 前是字母，不满足前缀白名单
  assert.equal(resolveRefs('abc#code-review', prompts).text, 'abc#code-review');
});

test('无引用文本原样返回且 hits 为空', () => {
  const { text, hits } = resolveRefs('普通消息，没有引用。', prompts);
  assert.equal(text, '普通消息，没有引用。');
  assert.deepEqual(hits, []);
});

test('空串与非字符串输入不抛错', () => {
  assert.deepEqual(resolveRefs('', prompts), { text: '', hits: [] });
  assert.equal(resolveRefs(undefined, prompts).text, 'undefined');
});

test('名称边界：空白终止扫描（# 后即空视为无名称）', () => {
  // "# tdd" 中 # 后是空格，名称段为空，不命中
  const { text, hits } = resolveRefs('# tdd', prompts);
  assert.equal(text, '# tdd');
  assert.deepEqual(hits, []);
});
