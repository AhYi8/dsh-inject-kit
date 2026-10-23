// `#` 引用解析：独立无依赖模块，供 Host 与单元测试共用同一份逻辑。

// `#` 引用匹配：# 前必须是行首 / 空白 / 常见成对或标点符号；
// 名称本体不允许空白与闭合标点（含全角 ）、书名号收口 」》等），长度上限 64，避免误吞正文。
export const REF_PATTERN = /(^|[\s(\[{<"'\u201c\u300c\u3008,.;:!?\u3001\u3002\uff0c\uff1b\uff1a\uff01\uff1f\uff08])#([^\s#()\[\]{}<>"'\u201d\u300d\u3009\u300b\uff09,.;:!?\u3001\u3002\uff0c\uff1b\uff1a\uff01\uff1f]{1,64})/g;

// 单遍替换：把文本中所有可命中的 `#名称` 替换为 Prompt 内容。
// 使用 replace 回调天然单遍执行，替换进去的正文不会被再次扫描（防递归）。
// 返回 {text, hits:[名称]}；无命中时 hits 为空数组、text 原样返回。
export function resolveRefs(text, promptsByName) {
  // 每次调用基于导出正则新建实例：带 /g 的共享正则的 lastIndex 会跨调用残留，
  // 导致后续调用跳过文本开头的匹配（前置字符丢失被误判为不命中）。
  const pattern = new RegExp(REF_PATTERN.source, REF_PATTERN.flags);
  const hits = [];
  const replaced = String(text).replace(pattern, (whole, prefix, title) => {
    const prompt = promptsByName.get(title);
    if (!prompt) return whole; // 未命中：原样保留
    hits.push(title);
    return `${prefix}${prompt.content}`;
  });
  return { text: replaced, hits };
}
