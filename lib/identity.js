// dsh-inject-kit — 固定身份（会话级 system-identity 覆盖）纯逻辑模块。
//
// 职责：Host 与单测共用同一份实现（无 peer 依赖，与 lib/refs.js、
// lib/session-title.js 同模式）。包含三块：
// 1. 存储分片容错规范化（identityPresets / identityOverrides）；
// 2. REST PUT 入口校验（严格校验只在写入路径，读取路径一律宽松恢复）；
// 3. waterfall 段落替换（harness:identity 置换/置空）。
//
// 背景知识（依据 app.asar 内 dsh-system-prompt / dsh-agent 源码静态确认）：
// - assemble() 每个模型步骤重跑 system-prompt/assemble waterfall，覆盖下一轮
//   即生效；complete: true 的完整人设（minimal 预设）在瀑布后被强制还原，
//   覆盖对其无效（产品边界，文档注明，不做处理）。
// - 渲染时空文本段落被丢弃，所以「删除身份」= 段落文本置空。
// - 身份段默认参与 {{variable}} 插值：用户文本若含 {{...}} 会让整个
//   renderPrompt 抛异常炸掉请求。替换段落必须显式 interpolate: false，
//   按字面量送达——这是本功能正确性的硬性要求，不是可选项。

// 系统提示词第一段的段落名（dsh-system-prompt 构造函数中硬编码注册）。
export const IDENTITY_SECTION_NAME = 'harness:identity';

// 会话覆盖条目的合法模式：replace=替换为自定义文本；remove=删除身份段。
const OVERRIDE_MODES = new Set(['replace', 'remove']);

// 危险对象键：普通赋值 `out[key] = ...` 命中 `__proto__` 会改写对象原型
//（prototype pollution），`constructor`/`prototype` 同属污染面。存储文件可被
// 手工编辑、sessionId 来自 REST 原始输入，规范化与校验两端都要拦下。
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// ------------------------------------------------------------- 存储规范化

// 身份预设库：{id, name, text}，text 允许为空串——空 = 「移除身份」特选预设。
export function normalizeIdentityPresets(parsed) {
  if (!Array.isArray(parsed)) return [];
  const out = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    if (typeof item.id !== 'string' || !item.id) continue;
    if (typeof item.name !== 'string' || !item.name.trim()) continue;
    if (typeof item.text !== 'string') continue;
    out.push({
      id: item.id,
      name: item.name,
      text: item.text,
      ...(typeof item.createdAt === 'number' ? { createdAt: item.createdAt } : {}),
      ...(typeof item.updatedAt === 'number' ? { updatedAt: item.updatedAt } : {}),
    });
  }
  return out;
}

// 身份覆盖表：{ [sessionId]: { mode, text, name, takenAt } }。损坏条目直接
// 丢弃（等价于该会话无覆盖，行为退化为 DSH 原生身份），不做修复尝试。
export function normalizeIdentityOverrides(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!key || !value || typeof value !== 'object') continue;
    // 危险键直接丢弃：防止 `out[key] = ...` 普通赋值改写 out 的原型
    if (UNSAFE_KEYS.has(key)) continue;
    if (!OVERRIDE_MODES.has(value.mode)) continue;
    out[key] = {
      mode: value.mode,
      text: typeof value.text === 'string' ? value.text : '',
      name: typeof value.name === 'string' ? value.name : '',
      ...(typeof value.presetId === 'string' && value.presetId ? { presetId: value.presetId } : {}),
      takenAt: typeof value.takenAt === 'number' && Number.isFinite(value.takenAt) ? value.takenAt : 0,
    };
  }
  return out;
}

// ------------------------------------------------------------- PUT 校验

// 与 Host 端 canonicalSessionId 同规则：agent 侧 id 形如 'session-<uuid>'，
// UI 侧可能是裸 uuid；写入与查找双向归一保证总能对上。
const canonicalSessionId = (id) => (typeof id === 'string' ? id.replace(/^session-/, '') : id);

// PUT /identity 入口校验。返回：
// - { error, code? }：校验失败（400；code 404 用于预设不存在）
// - { sessionId, override: null }：清除该会话覆盖（幂等，恢复 DSH 原生身份）
// - { sessionId, override }：写入覆盖；mode 由预设文本推导（空文本 = remove）
export function validateIdentityPut(body, presets) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: '请求体必须是 JSON 对象' };
  }
  const sessionId = canonicalSessionId(body.sessionId);
  // 必须是非空字符串：canonicalSessionId 对非字符串原样透传（与 Host 端同源），
  // 这里收紧类型边界，防止数字等非法值漏过
  if (typeof body.sessionId !== 'string' || !sessionId) return { error: 'sessionId is required' };
  // 归一后的键会被用作 identityOverrides 的普通赋值键，危险键必须拒绝，
  // 否则 `state.identityOverrides[sessionId] = ...` 会污染对象原型
  if (UNSAFE_KEYS.has(sessionId)) return { error: 'sessionId is invalid' };
  if (body.presetId === null || body.presetId === undefined || body.presetId === '') {
    return { sessionId, override: null };
  }
  const preset = (Array.isArray(presets) ? presets : []).find((p) => p.id === body.presetId);
  if (!preset) return { error: 'identity preset not found', code: 404 };
  // 快照语义：写入 name+text 独立副本，删除库内预设不影响已应用会话
  //（与 AGENTS 选择的快照策略一致）。
  const text = typeof preset.text === 'string' ? preset.text : '';
  return {
    sessionId,
    override: {
      mode: text ? 'replace' : 'remove',
      text,
      name: preset.name,
      // 快照携带 presetId：客户端选择器按 id 回显选中态（name 可能重名/改名）
      presetId: preset.id,
      takenAt: Date.now(),
    },
  };
}

// ------------------------------------------------------------- 段落替换

// 对 waterfall 产出的 sections 应用身份覆盖。返回值约定：
// - 未命中（sections 非数组 / 无覆盖 / 段落不存在如 includeHarnessIdentity:false）
//   一律原样返回同一引用，调用方可据此跳过拷贝，故障时行为退化为「无覆盖」；
// - 命中时返回新数组，仅替换 harness:identity 段，其他段落（含 tools 之外
//   的所有段）原对象透传，不做任何额外改动。
// interpolate: false 是硬性要求：身份段默认参与 {{variable}} 插值，用户文本
// 含 {{...}} 时会让 renderPrompt 抛异常炸掉整个请求；置为字面量后按原文送达。
export function applyIdentityToSections(sections, override) {
  if (!Array.isArray(sections) || !override || !OVERRIDE_MODES.has(override.mode)) return sections;
  let changed = false;
  const next = sections.map((section) => {
    if (section?.name !== IDENTITY_SECTION_NAME) return section;
    changed = true;
    const text = override.mode === 'remove' ? '' : String(override.text ?? '');
    return { ...section, text, interpolate: false };
  });
  return changed ? next : sections;
}
