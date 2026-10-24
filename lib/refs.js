// `#` 引用解析：独立无依赖模块，供 Host 与单元测试共用同一份逻辑。

// `#` 引用匹配：# 前必须是行首 / 空白 / 常见成对或标点符号（含反引号，覆盖
// `x`#名称 这类紧跟闭合代码的情况）；名称本体不允许空白与闭合标点（含全角 ）、
// 书名号收口 」》等），长度上限 64，避免误吞正文。
export const REF_PATTERN = /(^|[\s`(\[{<"'\u201c\u300c\u3008,.;:!?\u3001\u3002\uff0c\uff1b\uff1a\uff01\uff1f\uff08])#([^\s#()\[\]{}<>"'\u201d\u300d\u3009\u300b\uff09,.;:!?\u3001\u3002\uff0c\uff1b\uff1a\uff01\uff1f]{1,64})/g;

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
// 返回 {text, hits:[名称]}；无命中时 hits 为空数组、text 原样返回。
export function resolveRefs(text, promptsByName) {
  // 每次调用基于导出正则新建实例：带 /g 的共享正则的 lastIndex 会跨调用残留，
  // 导致后续调用跳过文本开头的匹配（前置字符丢失被误判为不命中）。
  const pattern = new RegExp(REF_PATTERN.source, REF_PATTERN.flags);
  const source = String(text);
  const spans = inlineCodeSpans(source);
  const hits = [];
  let out = '';
  let cursor = 0;
  let m;
  while ((m = pattern.exec(source))) {
    // 防零宽死循环守卫：理论上名称段 {1,64} 非空，exec 必然至少前进 2 个字符，
    // 不可能产生零宽匹配；此守卫是针对未来调整正则（如量词允许为空）时的兜底，
    // 一旦出现零宽匹配则手动前跳，避免 while 循环卡死。
    if (m[0].length === 0) { pattern.lastIndex += 1; continue; }
    // 以 `#` 本身的绝对位置判断是否落在行内代码区间内（区间判定含开不含闭：
    // `x`#tdd 的 # 紧跟闭合反引号，属于代码区外，正常解析）
    const hashIndex = m.index + m[1].length;
    if (insideSpans(spans, hashIndex)) continue;
    const title = m[2];
    const prompt = promptsByName.get(title);
    out += source.slice(cursor, m.index) + m[1];
    if (prompt) {
      hits.push(title);
      out += prompt.content;
    } else {
      out += `#${title}`; // 未命中：# 与名称原样保留
    }
    cursor = hashIndex + title.length + 1;
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
