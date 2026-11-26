// `#` 引用解析：独立无依赖模块，供 Host 与单元测试共用同一份逻辑。

// `#` 引用候选位置匹配：# 前必须是行首 / 空白 / 常见成对或标点符号（含反引号，覆盖
// `x`#名称 这类紧跟闭合代码的情况）；名称段不允许空白与闭合标点。注意：名称段的
// 实际识别已改为「库内名称最长匹配」（见 resolveRefs），本正则只负责圈定合法的
// # 候选位置——名称段排空白/闭合标点是为了把相邻文本切开，保证后续 # 的前缀
// 上下文不被吞掉（混排场景 `#tdd` 是示例，实际用 #code-review 依赖这一点）。
export const REF_PATTERN = /(^|[\s`(\[{<"'\u201c\u300c\u3008,.;:!?\u3001\u3002\uff0c\uff1b\uff1a\uff01\uff1f\uff08])#([^\s#()\[\]{}<>"'\u201d\u300d\u3009\u300b\uff09,.;:!?\u3001\u3002\uff0c\uff1b\uff1a\uff01\uff1f]{1,64})/g;

// 名称长度上限：# 引用解析与设置页名称校验共用同一常量，超长名称永远无法被引用，
// 必须在写入入口就拒绝。
export const REF_NAME_MAX = 64;

// 名称后边界判定：最长匹配命中后，名称的下一字符必须是文本结尾 / 空白 / 换行 /
// 闭合标点（集合与 REF_PATTERN 的名称排除字符一致，另含 #）。
// 为什么必须有这道边界：startsWith 只保证「名称是前缀」，若无边界校验，
// #tdd流程 会命中名为 tdd 的 Prompt（旧版行为是整体查表失败、原样保留）——
// 这是对既有无空格名称场景的行为回归，必须守住。
const NAME_BOUNDARY_RE = /[\s#()[\]{}<>"'\u201d\u300d\u3009\u300b\uff09,.;:!?\u3001\u3002\uff0c\uff1b\uff1a\uff01\uff1f]/;

// 供 client 端气泡 chip 与 Host 端解析共用同一语义（client bundle 无法 require
// Host 模块，client.js 内有同款复制实现，两处需同步维护）。
export function isNameBoundary(text, index) {
  return index >= text.length || NAME_BOUNDARY_RE.test(text[index]);
}

// 行内代码区间：按成对反引号串切分文本，奇数段视为代码区（含未闭合的尾段）。
// 代码区内的 `#名称` 不参与引用解析——用户用反引号书写示例或禁用时不应被误替换。
// 说明：采用简单的反引号串配对而非完整 CommonMark 规则（不区分围栏长度、
// 不处理转义），对聊天输入场景足够；client 端下拉/气泡使用同一规则。
export function inlineCodeSpans(text) {
  const source = String(text);
  const spans = [];
  const re = /`+/g;
  let m;
  let inCode = false;
  let start = 0;
  while ((m = re.exec(source))) {
    if (!inCode) {
      start = m.index;
      inCode = true;
    } else {
      spans.push([start, m.index + m[0].length]);
      inCode = false;
    }
  }
  // 未闭合的反引号：从开引号起全部按代码处理，避免吞掉结尾的引用
  if (inCode) spans.push([start, source.length]);
  return spans;
}

const insideSpans = (spans, index) => spans.some(([s, e]) => index > s && index < e);

// 单遍替换：把文本中所有可命中的 `#名称` 替换为 Prompt 内容，
// 行内代码区间内的命中原样保留。
// 名称识别采用「库内名称最长匹配」：对每个合法 # 候选位置，把库名按长度降序
// 尝试前缀匹配，命中后还须通过名称后边界校验（isNameBoundary）——不满足则回退
// 更短名称，全部失败则原样保留。这样含空格的库名（如「会话交接 Prompt」）可以
// 命中，而 #tdd流程 这类紧贴非边界字符的写法保持旧版「不命中」语义。
// 返回 {text, hits:[名称]}；无命中时 hits 为空数组、text 原样返回。
export function resolveRefs(text, promptsByName) {
  // 每次调用基于导出正则新建实例：带 /g 的共享正则的 lastIndex 会跨调用残留，
  // 导致后续调用跳过文本开头的匹配（前置字符丢失被误判为不命中）。
  const pattern = new RegExp(REF_PATTERN.source, REF_PATTERN.flags);
  const source = String(text);
  if (!promptsByName || promptsByName.size === 0) return { text: source, hits: [] };
  // 名称按长度降序排一次：同一 # 位置优先匹配更长名称（前缀名称让位）；
  // 超过 REF_NAME_MAX 的名称不可能被引用语法表达，直接排除。
  const names = [...promptsByName.keys()]
    .filter((name) => typeof name === 'string' && name.length >= 1 && name.length <= REF_NAME_MAX)
    .sort((a, b) => b.length - a.length);
  const spans = inlineCodeSpans(source);
  const hits = [];
  let out = '';
  let cursor = 0;
  let m;
  while ((m = pattern.exec(source))) {
    // 防零宽死循环守卫：名称段允许为空（可选组）时 m[0] 最短为「前缀+#」仍会前进；
    // 此守卫是针对未来调整正则（如量词允许为空）时的兜底，一旦出现零宽匹配则手动前跳。
    if (m[0].length === 0) { pattern.lastIndex += 1; continue; }
    // 以 `#` 本身的绝对位置判断是否落在行内代码区间内（区间判定含开不含闭：
    // `x`#tdd 的 # 紧跟闭合反引号，属于代码区外，正常解析）
    const hashIndex = m.index + m[1].length;
    if (insideSpans(spans, hashIndex)) continue;
    // 库内名称最长匹配 + 名称后边界校验；全失败则该 # 保留原文并继续扫描
    let matched = null;
    for (const name of names) {
      if (!source.startsWith(name, hashIndex + 1)) continue;
      if (!isNameBoundary(source, hashIndex + 1 + name.length)) continue;
      matched = name;
      break;
    }
    if (!matched) continue;
    const prompt = promptsByName.get(matched);
    out += source.slice(cursor, m.index) + m[1];
    hits.push(matched);
    out += prompt.content;
    cursor = hashIndex + 1 + matched.length;
    // 替换进去的正文不再扫描（防递归）：matched 名称可能比正则 m[2] 消耗的更长
    // （如名称含正则排除字符），必须把 lastIndex 显式拉到替换结束处，
    // 否则下一轮 m.index 可能落在 cursor 之前造成切片错乱。
    pattern.lastIndex = cursor;
  }
  out += source.slice(cursor);
  return { text: out, hits };
}

// ---------------------------------------------------------- 有界快照保留策略
// refSnapshots 结构为 {会话id: {名称: {content, takenAt}}}，每次替换 #引用 都会
// 写入；不设上限会随会话数与消息数无限增长。以下两个纯函数实现有界保留，
// 独立成模块便于 Host 端与单元测试共用。

// 每个会话的 bucket 只保留最近 limit 条（按 takenAt 新→旧）。
// 兼容迁移：旧版本写入的条目没有 takenAt 字段，视为 0（最旧），在超限时优先
// 被淘汰——旧快照仅用于气泡悬停提示，丢失可接受，不值得为其补扫持久轨迹。
export function pruneRefSnapshots(bucket, limit = REF_SNAPSHOT_LIMIT) {
  // limit 异常值兜底：NaN 会让 keys.length <= NaN 恒为 false 且 slice(0, NaN)
  // 为空（完全不淘汰→无界增长），负数会反向扩删（误全删），统一回退默认上限。
  const max = Number.isFinite(limit) && limit >= 0 ? Math.floor(limit) : REF_SNAPSHOT_LIMIT;
  const keys = Object.keys(bucket);
  if (keys.length <= max) return bucket;
  // 可选链兜底：存储中若混入损坏条目（非对象），按缺失 takenAt 处理而非抛错
  const sorted = keys.sort((a, b) => (bucket[a]?.takenAt || 0) - (bucket[b]?.takenAt || 0));
  for (const key of sorted.slice(0, keys.length - max)) delete bucket[key];
  return bucket;
}

// 会话数同样有界：已结束/已删除的会话 bucket 永不再写入却永久占盘，这里按
// bucket 内最新的 takenAt 排序，只保留最近 limit 个会话。旧数据无 takenAt 视为 0。
export function pruneSnapshotSessions(refSnapshots, limit = REF_SNAPSHOT_SESSIONS) {
  // 同上：limit 异常值（NaN/负数）回退默认上限，避免淘汰逻辑失效或误全删。
  const max = Number.isFinite(limit) && limit >= 0 ? Math.floor(limit) : REF_SNAPSHOT_SESSIONS;
  const sessions = Object.keys(refSnapshots);
  if (sessions.length <= max) return refSnapshots;
  const latestOf = (sid) => Math.max(0, ...Object.values(refSnapshots[sid] || {}).map((s) => s?.takenAt || 0));
  const sorted = sessions.sort((a, b) => latestOf(a) - latestOf(b));
  for (const sid of sorted.slice(0, sessions.length - max)) delete refSnapshots[sid];
  return refSnapshots;
}

export const REF_SNAPSHOT_LIMIT = 20; // 每会话保留最近 N 条 #引用 快照
export const REF_SNAPSHOT_SESSIONS = 50; // 全局最多保留最近 N 个会话的快照
