// resolveRefs 单元测试：覆盖命中、未命中、边界与防递归场景。
// 运行：node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { inlineCodeSpans, resolveRefs, pruneRefSnapshots, pruneSnapshotSessions, REF_SNAPSHOT_LIMIT, REF_SNAPSHOT_SESSIONS, REF_NAME_MAX, isNameBoundary } from '../lib/refs.js';

const prompts = new Map([
  ['code-review', { content: '请逐文件评审代码。' }],
  ['tdd', { content: '先写失败测试再实现。' }],
]);

// 含空格名称（v0.4.0 起支持），与上方无空格库并存以覆盖最长匹配歧义场景。
const spacedPrompts = new Map([
  ['会话交接 Prompt', { content: '请将当前会话整理成一份会话交接。' }],
  ['tdd', { content: '先写失败测试再实现。' }],
  ['tdd flow', { content: '完整 TDD 流程。' }],
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
  // C# 的 # 前是字母：既不是候选位置，也不应命中任何名称
  assert.equal(resolveRefs('用 C# 写', prompts).text, '用 C# 写');
  assert.deepEqual(resolveRefs('用 C# 写', prompts).hits, []);
});

// ---------------- 含空格名称（v0.4.0 最长匹配 + 名称后边界） ----------------

test('含空格名称命中：替换为 Prompt 内容', () => {
  const { text, hits } = resolveRefs('用 #会话交接 Prompt 继续', spacedPrompts);
  assert.equal(text, '用 请将当前会话整理成一份会话交接。 继续');
  assert.deepEqual(hits, ['会话交接 Prompt']);
});

test('含空格名称：消息仅为引用本体时也命中', () => {
  const { text, hits } = resolveRefs('#会话交接 Prompt', spacedPrompts);
  assert.equal(text, '请将当前会话整理成一份会话交接。');
  assert.deepEqual(hits, ['会话交接 Prompt']);
});

test('含空格名称：后跟全角标点仍命中且标点保留', () => {
  const { text, hits } = resolveRefs('#会话交接 Prompt，请开始', spacedPrompts);
  assert.equal(text, '请将当前会话整理成一份会话交接。，请开始');
  assert.deepEqual(hits, ['会话交接 Prompt']);
});

test('名称后边界回归保护：#tdd流程 紧贴非边界字符不命中（旧版行为）', () => {
  const { text, hits } = resolveRefs('用 #tdd流程', spacedPrompts);
  assert.equal(text, '用 #tdd流程');
  assert.deepEqual(hits, []);
});

test('名称后边界：空白/换行/闭合标点是合法边界', () => {
  assert.deepEqual(resolveRefs('#tdd x', spacedPrompts).hits, ['tdd']);
  assert.deepEqual(resolveRefs('#tdd\nx', spacedPrompts).hits, ['tdd']);
  assert.deepEqual(resolveRefs('#tdd，', spacedPrompts).hits, ['tdd']);
  assert.deepEqual(resolveRefs('#tdd）', spacedPrompts).hits, ['tdd']);
});

test('最长匹配歧义：tdd 与 tdd flow 并存时按输入取最长命中', () => {
  // #tdd flow 命中长名
  assert.deepEqual(resolveRefs('#tdd flow 开始', spacedPrompts).hits, ['tdd flow']);
  // #tdd x 中 tdd 后是空格边界，命中短名
  assert.deepEqual(resolveRefs('#tdd x', spacedPrompts).hits, ['tdd']);
});

test('含空格名称截断（只写前半段）不命中', () => {
  const { text, hits } = resolveRefs('#会话交接', spacedPrompts);
  assert.equal(text, '#会话交接');
  assert.deepEqual(hits, []);
});

test('含空格名称 + 行内代码：禁用语义不替换', () => {
  assert.deepEqual(resolveRefs('`#会话交接 Prompt` 是示例', spacedPrompts).hits, []);
  // 未闭合反引号兜底为代码区，同样不替换
  assert.deepEqual(resolveRefs('代码 `x 然后 #会话交接 Prompt', spacedPrompts).hits, []);
});

test('同消息混合命中：hits 顺序与替换位置一致', () => {
  const { text, hits } = resolveRefs('#tdd 与 #会话交接 Prompt', spacedPrompts);
  assert.deepEqual(hits, ['tdd', '会话交接 Prompt']);
  assert.equal(text, '先写失败测试再实现。 与 请将当前会话整理成一份会话交接。');
});

test('markdown 标题形 # 标题 不命中', () => {
  assert.deepEqual(resolveRefs('# 标题内容', spacedPrompts).hits, []);
});

test('超过 REF_NAME_MAX 的库名不可被引用', () => {
  const longName = 'x'.repeat(REF_NAME_MAX + 1);
  const long = new Map([[longName, { content: '内容' }]]);
  assert.deepEqual(resolveRefs(`#${longName}`, long).hits, []);
});

test('防递归：含空格名称的 Prompt 内容中的 # 不再被扫描', () => {
  const recursive = new Map([['交接', { content: '内容里含 #交接 与 #tdd 原文' }]]);
  const { text, hits } = resolveRefs('x #交接', recursive);
  assert.deepEqual(hits, ['交接']);
  assert.equal(text, 'x 内容里含 #交接 与 #tdd 原文');
});

test('isNameBoundary：结尾/空白/闭合标点为边界，普通字符不是', () => {
  assert.equal(isNameBoundary('abc', 3), true);
  assert.equal(isNameBoundary('a c', 1), true);
  assert.equal(isNameBoundary('a，c', 1), true);
  assert.equal(isNameBoundary('abc', 1), false);
});

test('空库与非 Map 输入原样返回', () => {
  assert.deepEqual(resolveRefs('#tdd flow', new Map()), { text: '#tdd flow', hits: [] });
  assert.deepEqual(resolveRefs('#tdd flow', null), { text: '#tdd flow', hits: [] });
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

test('行内代码：反引号包裹的引用原样保留', () => {
  const { text, hits } = resolveRefs('用 `#code-review` 示例', prompts);
  assert.equal(text, '用 `#code-review` 示例');
  assert.deepEqual(hits, []);
});

test('行内代码与普通引用混排：只替换代码区外的引用', () => {
  const { text, hits } = resolveRefs('`#tdd` 是示例，实际用 #code-review', prompts);
  assert.equal(text, '`#tdd` 是示例，实际用 请逐文件评审代码。');
  assert.deepEqual(hits, ['code-review']);
});

test('行内代码：未闭合反引号后的引用视为代码内，不替换', () => {
  const { text, hits } = resolveRefs('代码 `x 然后 #tdd 忘了闭合', prompts);
  assert.equal(text, '代码 `x 然后 #tdd 忘了闭合');
  assert.deepEqual(hits, []);
});

test('行内代码闭合后：代码区外的引用正常替换', () => {
  const { text, hits } = resolveRefs('`code` 之后 #tdd 生效', prompts);
  assert.equal(text, '`code` 之后 先写失败测试再实现。 生效');
  assert.deepEqual(hits, ['tdd']);
});

test('行内代码：代码区紧邻的引用（边界外）正常替换', () => {
  const { text, hits } = resolveRefs('`x`#tdd', prompts);
  assert.equal(text, '`x`先写失败测试再实现。');
  assert.deepEqual(hits, ['tdd']);
});

test('inlineCodeSpans：无反引号与空串返回空区间', () => {
  assert.deepEqual(inlineCodeSpans('no code #here'), []);
  assert.deepEqual(inlineCodeSpans(''), []);
});

test('inlineCodeSpans：反引号串两两配对，奇数段为代码区', () => {
  // a0 `1 b2 `3 c4 `5 d6 `7 e8：区间 [1,4) 与 [5,8)，端点为闭合串末尾索引
  assert.deepEqual(inlineCodeSpans('a`b`c`d`e'), [[1, 4], [5, 8]]);
});

test('inlineCodeSpans：连续反引号串（```）整体视为一个开/闭引号', () => {
  // /`+/ 把连续反引号合并成一段，避免 ``` 被拆成多次翻转；闭合后引用正常替换
  assert.deepEqual(inlineCodeSpans('```code``` 后续 #tdd'), [[0, 10]]);
  assert.deepEqual(resolveRefs('```code``` 后续 #tdd', prompts).hits, ['tdd']);
});

test('inlineCodeSpans：未闭合反引号兜底到文本末尾', () => {
  assert.deepEqual(inlineCodeSpans('x `open #tdd'), [[2, 12]]);
});

test('连续调用不残留 /g 正则的 lastIndex（每次新建实例）', () => {
  // 第一次调用消费到文本末尾后，若共享 lastIndex 会让后续调用丢开头的匹配
  assert.equal(resolveRefs('#tdd', prompts).hits.length, 1);
  assert.equal(resolveRefs('#tdd', prompts).hits.length, 1);
  assert.equal(resolveRefs('#tdd', prompts).text, '先写失败测试再实现。');
});

// ---------------- refSnapshots 有界保留策略 ----------------

const bucketOf = (n) => Object.fromEntries(
  Array.from({ length: n }, (_, i) => [`name-${i}`, { content: `c-${i}`, takenAt: i + 1 }]),
);

test('pruneRefSnapshots：未超限不动 bucket', () => {
  const bucket = bucketOf(3);
  assert.equal(pruneRefSnapshots(bucket, 5), bucket);
  assert.equal(Object.keys(bucket).length, 3);
});

test('pruneRefSnapshots：超限按 takenAt 保留最近 N 条', () => {
  const bucket = bucketOf(REF_SNAPSHOT_LIMIT + 5);
  pruneRefSnapshots(bucket);
  assert.equal(Object.keys(bucket).length, REF_SNAPSHOT_LIMIT);
  // 最早的 name-0..4（takenAt 最小）应被淘汰
  assert.ok(!('name-0' in bucket));
  assert.ok(!('name-4' in bucket));
  assert.ok('name-5' in bucket);
  assert.ok(`name-${REF_SNAPSHOT_LIMIT + 4}` in bucket);
});

test('pruneRefSnapshots：旧数据无 takenAt 视为 0 优先淘汰', () => {
  const bucket = bucketOf(REF_SNAPSHOT_LIMIT);
  bucket['legacy'] = { content: 'old' }; // 无 takenAt 的迁移条目
  pruneRefSnapshots(bucket);
  assert.ok(!('legacy' in bucket));
  assert.equal(Object.keys(bucket).length, REF_SNAPSHOT_LIMIT);
});

test('pruneSnapshotSessions：超限按最新 takenAt 保留最近 N 个会话', () => {
  const sessions = {};
  for (let i = 0; i < REF_SNAPSHOT_SESSIONS + 3; i += 1) {
    sessions[`s-${i}`] = { [`name-${i}`]: { content: 'c', takenAt: i + 1 } };
  }
  pruneSnapshotSessions(sessions);
  assert.equal(Object.keys(sessions).length, REF_SNAPSHOT_SESSIONS);
  // 最新 takenAt 最小的 3 个会话（s-0..s-2）被淘汰
  assert.ok(!('s-0' in sessions));
  assert.ok(!('s-2' in sessions));
  assert.ok(`s-${REF_SNAPSHOT_SESSIONS + 2}` in sessions);
});

test('pruneRefSnapshots：limit 异常值（NaN/负数）回退默认上限而非失效', () => {
  // NaN 曾导致 slice(0, NaN) 为空 → 完全不淘汰（无界增长）
  const nanBucket = bucketOf(REF_SNAPSHOT_LIMIT + 5);
  pruneRefSnapshots(nanBucket, NaN);
  assert.equal(Object.keys(nanBucket).length, REF_SNAPSHOT_LIMIT);
  // 负数曾导致 slice(0, len+N) 误删全部
  const negBucket = bucketOf(REF_SNAPSHOT_LIMIT + 2);
  pruneRefSnapshots(negBucket, -1);
  assert.equal(Object.keys(negBucket).length, REF_SNAPSHOT_LIMIT);
  // 会话级同样回退
  const sessions = {};
  for (let i = 0; i < REF_SNAPSHOT_SESSIONS + 2; i += 1) {
    sessions[`s-${i}`] = { n: { content: 'c', takenAt: i + 1 } };
  }
  pruneSnapshotSessions(sessions, NaN);
  assert.equal(Object.keys(sessions).length, REF_SNAPSHOT_SESSIONS);
});

test('pruneRefSnapshots：损坏条目（非对象/空值）不抛错，按缺失 takenAt 处理', () => {
  const bucket = bucketOf(REF_SNAPSHOT_LIMIT);
  bucket['broken'] = null; // 存储层可能混入的损坏条目
  assert.doesNotThrow(() => pruneRefSnapshots(bucket));
  assert.ok(!('broken' in bucket)); // 视为最旧，优先淘汰
});
