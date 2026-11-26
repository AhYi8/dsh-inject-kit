// dsh-inject-kit — 注入工具箱（Host 端）。
//
// 功能一：AGENTS.md 选择注入（沿用 dsh-agents-switcher 语义）
// - 全局 AGENTS 预设库 {id,name,content} 持久化为 JSON（$DSH_HOME，默认 ~/.dsh）。
// - 按会话选择保存独立快照副本（name+content），删除库内预设不影响已选会话。
// - 默认不拦截：DSH 原生 项目级→全局 AGENTS.md 查找注入保持原样。
// - 拦截发生在 `agent/pre-step` 瀑布中，完全模仿原生 dsh-agent-instructions：
//   组装独立 user 消息（source.kind='agent-instructions'）并原位替换原生注入，
//   不修改 DSH 内置 SystemPrompt，不改写用户消息。
//
// 功能二：Prompt 管理 + `#` 引用注入
// - Prompt 库 {id,name,group,content}，默认分组「默认」，设置页增删改查。
// - 输入框 `#名称` 触发下拉（client 端），Host 在 agent/pre-step 将本轮
//   用户消息中的 `#名称` 引用替换为对应 Prompt 内容。
//   语义说明（重要）：DSH 会把 pre-step 接纳的消息批次同时作为持久轨迹落库，
//   公开钩子没有「只改出站 payload、不影响落库」的通道——因此会话记录里
//   显示的就是替换后的内容（所见即所发）；发送后编辑/删除 Prompt 不影响
//   已落库消息，只影响后续发送。
// - 替换采用单遍扫描：替换进去的正文不会被再次解析（防递归）。
// - 每次成功替换记录 refSnapshots[sessionId][名称]（有界保留），供排查比对。
//
// 功能四：固定身份（会话级 system-identity 覆盖）
// - 身份预设库 {id,name,text}（text 空串 = 「移除身份」特选预设），设置页 CRUD。
// - 输入框工具栏按会话选择身份（apply 或清除），下一轮请求即生效。
// - 拦截发生在 `system-prompt/assemble` waterfall：替换/置空 harness:identity
//   段，不修改 DSH 内置文件、不影响其他段落与 tools。替换段 interpolate:false，
//   用户文本按字面量送达（含 {{...}} 也不会触发插值异常）。
// - 红线：complete: true 的完整人设（minimal 预设）在瀑布后被强制还原，
//   覆盖对其无效。
//
// 改名迁移：旧包名 dsh-agents-switcher → dsh-inject-kit；首次启动时若存在旧
// 存储文件则幂等迁移到新文件（保留旧文件不删除），旧预设补默认分组。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import Schema from '@deepseek-ai/schemastery';

export const name = 'dsh-inject-kit';
export const inject = ['webServer'];

const NS = 'dsh-inject-kit';
// REST 桥接路径统一挂在 /dsh-inject-kit 前缀下
const AGENTS_PRESETS_PATH = '/dsh-inject-kit/agents/presets';
const AGENTS_SELECTION_PATH = '/dsh-inject-kit/agents/selection';
const PROMPTS_PATH = '/dsh-inject-kit/prompts';
const REFS_PATH = '/dsh-inject-kit/refs';
const SESSION_TITLE_PATH = '/dsh-inject-kit/session-title';
const IDENTITY_PATH = '/dsh-inject-kit/identity';
const IDENTITY_PRESETS_PATH = '/dsh-inject-kit/identity/presets';

// 与原生 dsh-agent-instructions 一致：AGENTS.md 以 <system-reminder> user 消息
// 携带 source {kind:'agent-instructions', form:'instructions', changes:[...]}。
const SYSTEM_REMINDER_OPEN = '<system-reminder>';
const SYSTEM_REMINDER_CLOSE = '</system-reminder>';
const AGENT_INSTRUCTIONS_INTRO = 'The following workspace instructions may be relevant to your work. '
  + 'Use them as guidance when applicable. More specific instructions take precedence over broader ones. '
  + 'They do not override system, developer, or direct user instructions.';

export const Config = Schema.object({
  verboseLogging: Schema.boolean().default(false),
});

// --------------------------------------------------------------- persistence

function storeFile() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'inject-kit.json');
}

// 旧版存储文件（只读迁移源，永不删除）
function legacyStoreFile() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'agents-switcher.json');
}

function normalizeState(parsed) {
  // 会话标题配置：容错解析（历史文件损坏时回退默认值），与 AGENTS/Prompt 的
  // 宽松恢复策略一致；写入路径（REST PUT）才做严格校验。
  let sessionTitle;
  try {
    sessionTitle = normalizeSessionTitleConfig(parsed.sessionTitle);
  } catch {
    sessionTitle = { ...SESSION_TITLE_DEFAULTS };
  }
  return {
    presets: Array.isArray(parsed.presets) ? parsed.presets : [],
    prompts: Array.isArray(parsed.prompts) ? parsed.prompts : [],
    selections: parsed.selections && typeof parsed.selections === 'object' ? parsed.selections : {},
    refSnapshots: parsed.refSnapshots && typeof parsed.refSnapshots === 'object' ? parsed.refSnapshots : {},
    sessionTitle,
    // 固定身份：预设库 + 会话覆盖表，容错解析（损坏条目丢弃 = 无覆盖）
    identityPresets: normalizeIdentityPresets(parsed.identityPresets),
    identityOverrides: normalizeIdentityOverrides(parsed.identityOverrides),
  };
}

function loadState(file) {
  try {
    return normalizeState(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
}

// 一次性幂等迁移：新文件缺失且旧文件存在时整体搬迁，旧 AGENTS 预设补默认分组。
function migrateFromLegacy(file) {
  const legacy = loadState(legacyStoreFile());
  if (!legacy) {
    return {
      presets: [], prompts: [], selections: {}, refSnapshots: {},
      sessionTitle: { ...SESSION_TITLE_DEFAULTS },
      identityPresets: [], identityOverrides: {},
    };
  }
  for (const preset of legacy.presets) {
    if (!preset.group) preset.group = '默认';
  }
  return legacy;
}

function saveState(file, state) {
  const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------- interception

// 原生对齐：预设正文中的闭合标签需转义，与 dsh-agent-instructions 行为一致。
function buildBlock(content) {
  const body = String(content).replaceAll(SYSTEM_REMINDER_CLOSE, '<\\/system-reminder>');
  return `${SYSTEM_REMINDER_OPEN}\n${AGENT_INSTRUCTIONS_INTRO}\n\n${body}\n${SYSTEM_REMINDER_CLOSE}`;
}

const textOf = (message) => Array.isArray(message?.content)
  ? message.content.filter((part) => part?.type === 'text').map((part) => part.text ?? '').join('\n')
  : (typeof message?.content === 'string' ? message.content : '');

const isAgentInstructionsSource = (message) => message?.source?.kind === 'agent-instructions';

// `#` 引用解析逻辑抽到无依赖模块（lib/refs.js），Host 与单测共用同一份实现。
// pruneRefSnapshots / pruneSnapshotSessions 为快照有界保留策略（防 refSnapshots
// 跨会话、跨消息无限增长）。
import { REF_PATTERN, resolveRefs, pruneRefSnapshots, pruneSnapshotSessions, REF_NAME_MAX } from './refs.js';
import {
  normalizeSessionTitleConfig,
  applySessionTitleConfig,
  SESSION_TITLE_DEFAULTS,
} from './session-title.js';
import {
  normalizeIdentityPresets,
  normalizeIdentityOverrides,
  validateIdentityPut,
  applyIdentityToSections,
} from './identity.js';

export { REF_PATTERN, resolveRefs };

// ---------------------------------------------------------------- session title

// 会话标题配置规范化与下发逻辑在 lib/session-title.js（无 peer 依赖，Host 与
// 单测共用同一份实现）；本模块按需转发导出供外部/测试引用。
export { applySessionTitleConfig };

// --------------------------------------------------------------------- apply

export function apply(ctx, config = {}) {
  const cfg = { verboseLogging: !!config.verboseLogging };
  const file = storeFile();
  // 迁移读旧文件 → 内存态 → 立即落盘新文件（保留旧文件，不删除）
  let state = loadState(file) ?? migrateFromLegacy(file);
  saveState(file, state);
  const log = (...args) => { if (cfg.verboseLogging) console.log(`[${NS}]`, ...args); };

  const persist = () => {
    try { saveState(file, state); } catch (error) { console.error(`[${NS}] persist failed:`, error); }
  };

  // Agent 侧 id 形如 'session-<uuid>'，UI 侧可能是裸 uuid；双向规范化保证
  // 选择写入与 pre-step 查找总能对上。
  const canonicalSessionId = (id) => (typeof id === 'string' ? id.replace(/^session-/, '') : id);
  const snapshotFor = (preset) => ({
    presetId: preset.id,
    name: preset.name,
    content: preset.content,
    takenAt: Date.now(),
  });

  const readBody = (req) => new Promise((resolve) => {
    let data = '';
    // 超限 destroy() 后 'end' 不再触发：若无 close 兜底，Promise 永不 resolve，
    // handler 挂起并泄漏。settled 标记保证只取先到的事件结果。
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    req.on('data', (chunk) => { data += chunk; if (data.length > 4 * 1024 * 1024) req.destroy(); });
    req.on('end', () => {
      try { finish(JSON.parse(data || '{}')); } catch { finish(null); }
    });
    req.on('error', () => finish(null));
    req.on('close', () => finish(null));
  });

  const sendJson = (res, code, payload) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  };

  ctx.effect(() => {
    if (typeof ctx.webServer?.register !== 'function') return undefined;

    // ------------------------------------------------ AGENTS 预设库 CRUD（沿用）
    const presetsHandler = async (req, res) => {
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      if (req.method === 'GET') {
        sendJson(res, 200, { presets: state.presets, selections: state.selections });
        return;
      }
      if (req.method === 'PUT') {
        const body = await readBody(req);
        if (!body || typeof body.name !== 'string' || typeof body.content !== 'string') {
          sendJson(res, 400, { error: 'name and content are required strings' });
          return;
        }
        const trimmedName = body.name.trim();
        if (!trimmedName) { sendJson(res, 400, { error: 'name must not be empty' }); return; }
        let preset;
        if (body.id) {
          preset = state.presets.find((p) => p.id === body.id);
          if (!preset) { sendJson(res, 404, { error: 'preset not found' }); return; }
          preset.name = trimmedName;
          preset.content = body.content;
          preset.updatedAt = Date.now();
        } else {
          preset = { id: crypto.randomUUID(), name: trimmedName, content: body.content, createdAt: Date.now() };
          state.presets.push(preset);
        }
        persist();
        log('agents preset saved', preset.id, trimmedName);
        sendJson(res, 200, { preset });
        return;
      }
      if (req.method === 'DELETE') {
        const url = new URL(req.url, 'http://localhost');
        const id = url.searchParams.get('id');
        const before = state.presets.length;
        state.presets = state.presets.filter((p) => p.id !== id);
        if (state.presets.length === before) { sendJson(res, 404, { error: 'preset not found' }); return; }
        // 已选会话保留独立快照副本——按设计不受删除影响。
        persist();
        log('agents preset deleted', id);
        sendJson(res, 200, { ok: true });
        return;
      }
      sendJson(res, 405, { error: 'Method Not Allowed' });
    };

    const selectionHandler = async (req, res) => {
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      if (req.method !== 'PUT') { sendJson(res, 405, { error: 'Method Not Allowed' }); return; }
      const body = await readBody(req);
      if (!body || typeof body.sessionId !== 'string' || !body.sessionId) {
        sendJson(res, 400, { error: 'sessionId is required' });
        return;
      }
      const sid = canonicalSessionId(body.sessionId);
      if (body.presetId === null || body.presetId === undefined || body.presetId === '') {
        delete state.selections[sid]; // 恢复 DSH 原生行为
        persist();
        log('selection cleared for', sid);
        sendJson(res, 200, { selection: null });
        return;
      }
      const preset = state.presets.find((p) => p.id === body.presetId);
      if (!preset) { sendJson(res, 404, { error: 'preset not found' }); return; }
      state.selections[sid] = snapshotFor(preset);
      persist();
      log('selection set for', sid, '->', preset.name);
      sendJson(res, 200, { selection: state.selections[sid] });
    };

    // ------------------------------------------------------ Prompt 库 CRUD
    const promptsHandler = async (req, res) => {
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      if (req.method === 'GET') {
        sendJson(res, 200, { prompts: state.prompts });
        return;
      }
      if (req.method === 'PUT') {
        const body = await readBody(req);
        if (!body || typeof body.name !== 'string' || typeof body.content !== 'string') {
          sendJson(res, 400, { error: 'name and content are required strings' });
          return;
        }
        const name = body.name.trim();
        const group = typeof body.group === 'string' && body.group.trim() ? body.group.trim() : '默认';
        if (!name) { sendJson(res, 400, { error: 'name must not be empty' }); return; }
        // 名称是 `#引用` 的唯一键：拒绝换行/回车（破坏单行匹配）、`#`（名称本体
        // 含 # 会让引用切分歧义）与超长（超过 REF_NAME_MAX 的名称永远无法被引用
        // 语法表达，必须在写入入口拒绝，避免建了却用不了的哑 Prompt）。允许空格。
        if (/[\n\r#]/.test(name)) { sendJson(res, 400, { error: 'prompt name must not contain newline or #' }); return; }
        if (name.length > REF_NAME_MAX) { sendJson(res, 400, { error: `prompt name too long (max ${REF_NAME_MAX})` }); return; }
        // 全库必须唯一（重名校验在服务端兜底）。
        const dup = state.prompts.find((p) => p.name === name && p.id !== body.id);
        if (dup) { sendJson(res, 400, { error: `duplicate prompt name: ${name}` }); return; }
        let prompt;
        if (body.id) {
          prompt = state.prompts.find((p) => p.id === body.id);
          if (!prompt) { sendJson(res, 404, { error: 'prompt not found' }); return; }
          prompt.name = name;
          prompt.group = group;
          prompt.content = body.content;
          prompt.updatedAt = Date.now();
        } else {
          prompt = { id: crypto.randomUUID(), name, group, content: body.content, createdAt: Date.now() };
          state.prompts.push(prompt);
        }
        persist();
        log('prompt saved', prompt.id, group, name);
        sendJson(res, 200, { prompt });
        return;
      }
      if (req.method === 'DELETE') {
        const url = new URL(req.url, 'http://localhost');
        const id = url.searchParams.get('id');
        const before = state.prompts.length;
        state.prompts = state.prompts.filter((p) => p.id !== id);
        if (state.prompts.length === before) { sendJson(res, 404, { error: 'prompt not found' }); return; }
        // 快照语义：已发出消息的替换早已完成，删除不影响任何历史 payload。
        persist();
        log('prompt deleted', id);
        sendJson(res, 200, { ok: true });
        return;
      }
      sendJson(res, 405, { error: 'Method Not Allowed' });
    };

    // 发送时快照查询：按会话返回 `#名称` → 当时的 Prompt 内容，供气泡装饰提示。
    const refsHandler = async (req, res) => {
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      if (req.method !== 'GET') { sendJson(res, 405, { error: 'Method Not Allowed' }); return; }
      const url = new URL(req.url, 'http://localhost');
      const sid = canonicalSessionId(url.searchParams.get('sessionId') || '');
      sendJson(res, 200, { snapshots: (sid && state.refSnapshots[sid]) || {} });
    };

    // ------------------------------------------------------ 会话标题配置
    // GET 返回当前配置与最近一次下发结果；PUT 校验、落盘并即时下发。
    const sessionTitleHandler = async (req, res) => {
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      if (req.method === 'GET') {
        sendJson(res, 200, { config: state.sessionTitle });
        return;
      }
      if (req.method === 'PUT') {
        const body = await readBody(req);
        // readBody 对非法 JSON/空 body/中断请求统一返回 null；normalize 把 null
        // 视为「未配置」回退默认值，这里必须先拦下，避免坏请求被静默保存成默认配置
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
          sendJson(res, 400, { error: 'session-title: 请求体必须是 JSON 对象' });
          return;
        }
        let config;
        try {
          config = normalizeSessionTitleConfig(body);
        } catch (error) {
          sendJson(res, 400, { error: String(error?.message || error) });
          return;
        }
        state.sessionTitle = config;
        persist();
        const applied = applySessionTitleConfig(ctx, config, log);
        log('session-title config saved:', JSON.stringify(config), 'applied:', JSON.stringify(applied));
        sendJson(res, 200, { config, applied });
        return;
      }
      sendJson(res, 405, { error: 'Method Not Allowed' });
    };

    // ------------------------------------------------------ 固定身份
    // 预设库 CRUD（text 允许空串 = 「移除身份」特选预设）。
    const identityPresetsHandler = async (req, res) => {
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      if (req.method === 'GET') {
        sendJson(res, 200, { presets: state.identityPresets });
        return;
      }
      if (req.method === 'PUT') {
        const body = await readBody(req);
        if (!body || typeof body.name !== 'string' || typeof body.text !== 'string') {
          // text 允许空串但不允许缺失/非字符串：空串是「移除身份」特选语义
          sendJson(res, 400, { error: 'name and text are required strings' });
          return;
        }
        const trimmedName = body.name.trim();
        if (!trimmedName) { sendJson(res, 400, { error: 'name must not be empty' }); return; }
        let preset;
        if (body.id) {
          preset = state.identityPresets.find((p) => p.id === body.id);
          if (!preset) { sendJson(res, 404, { error: 'identity preset not found' }); return; }
          preset.name = trimmedName;
          preset.text = body.text;
          preset.updatedAt = Date.now();
        } else {
          preset = { id: crypto.randomUUID(), name: trimmedName, text: body.text, createdAt: Date.now() };
          state.identityPresets.push(preset);
        }
        persist();
        log('identity preset saved', preset.id, trimmedName);
        sendJson(res, 200, { preset });
        return;
      }
      if (req.method === 'DELETE') {
        const url = new URL(req.url, 'http://localhost');
        const id = url.searchParams.get('id');
        const before = state.identityPresets.length;
        state.identityPresets = state.identityPresets.filter((p) => p.id !== id);
        if (state.identityPresets.length === before) { sendJson(res, 404, { error: 'identity preset not found' }); return; }
        // 已应用会话保留独立快照副本——按设计不受删除影响（对齐 AGENTS 选择语义）。
        persist();
        log('identity preset deleted', id);
        sendJson(res, 200, { ok: true });
        return;
      }
      sendJson(res, 405, { error: 'Method Not Allowed' });
    };

    // 会话级身份覆盖：GET 查询（?sessionId= 单个；无参数返回全部供设置页展示），
    // PUT 应用/清除（presetId 空 = 清除，幂等恢复 DSH 原生身份）。
    const identitySelectionHandler = async (req, res) => {
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      if (req.method === 'GET') {
        const url = new URL(req.url, 'http://localhost');
        const sidParam = url.searchParams.get('sessionId');
        // 无参数：返回预设库 + 全部覆盖（选择器数据源一次拉全，与
        // /agents/presets 的 GET 合并返回风格一致）
        if (!sidParam) {
          sendJson(res, 200, { presets: state.identityPresets, overrides: state.identityOverrides });
          return;
        }
        const sid = canonicalSessionId(sidParam);
        sendJson(res, 200, { override: state.identityOverrides[sid] ?? null });
        return;
      }
      if (req.method === 'PUT') {
        const body = await readBody(req);
        const result = validateIdentityPut(body, state.identityPresets);
        if (result.error) { sendJson(res, result.code ?? 400, { error: result.error }); return; }
        const { sessionId, override } = result;
        if (!override) {
          delete state.identityOverrides[sessionId];
          persist();
          log('identity override cleared for', sessionId);
          sendJson(res, 200, { override: null });
          return;
        }
        state.identityOverrides[sessionId] = override;
        persist();
        log('identity override set for', sessionId, '->', override.mode, override.name);
        sendJson(res, 200, { override });
        return;
      }
      sendJson(res, 405, { error: 'Method Not Allowed' });
    };

    const unregisters = [
      ctx.webServer.register({ kind: 'exact', path: AGENTS_PRESETS_PATH, handler: presetsHandler }),
      ctx.webServer.register({ kind: 'exact', path: AGENTS_SELECTION_PATH, handler: selectionHandler }),
      ctx.webServer.register({ kind: 'exact', path: PROMPTS_PATH, handler: promptsHandler }),
      ctx.webServer.register({ kind: 'exact', path: REFS_PATH, handler: refsHandler }),
      ctx.webServer.register({ kind: 'exact', path: SESSION_TITLE_PATH, handler: sessionTitleHandler }),
      ctx.webServer.register({ kind: 'exact', path: IDENTITY_PRESETS_PATH, handler: identityPresetsHandler }),
      ctx.webServer.register({ kind: 'exact', path: IDENTITY_PATH, handler: identitySelectionHandler }),
    ];
    return () => { for (const off of unregisters) { try { off?.(); } catch { /* already gone */ } } };
  }, 'dsh-inject-kit: REST bridge');

  // 启动即按已保存配置对齐一次：patch 层兜底值与设置页可能不一致（用户改过
  // 设置后重启），这里保证启动后提供方运行的就是设置页里的值。bundle 加载
  // 顺序不确定，目标此刻可能尚未挂载——未找到时仅记日志，不影响启动。
  applySessionTitleConfig(ctx, state.sessionTitle, log);
  // 兜底重试：目标条目依赖 sessionTitle/llm/sessions 服务，挂载可能晚于本插件；
  // 延迟一拍再做一次对齐，仍未找到（标题 bundle 未启用）则不再重试。
  // 计时器注册进 effect：插件卸载（dispose）后必须 clearTimeout，否则回调会在
  // 上下文销毁后仍触发，对已销毁的 registry 调 fiber.update 可能抛未捕获异常
  ctx.effect(() => {
    const startupRetry = setTimeout(() => applySessionTitleConfig(ctx, state.sessionTitle, log), 3000);
    if (typeof startupRetry?.unref === 'function') startupRetry.unref();
    return () => clearTimeout(startupRetry);
  });

  // AGENTS 选择注入（沿用原拦截链路：替换原生 agent-instructions 消息）
  ctx.effect(() => ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next();
    if (!decision || decision.kind !== 'enter' || !Array.isArray(decision.messages)) return decision;
    const sessionId = canonicalSessionId(payload?.agent?.id ?? payload?.agent?.sessionId);
    if (!sessionId) return decision;

    let messages = decision.messages;

    // ---------- 第一层：AGENTS 预设替换 ----------
    const snap = state.selections[sessionId];
    if (snap) {
      const desired = buildBlock(snap.content);
      const stream = messages;
      const history = Array.isArray(payload?.messages) ? payload.messages : [];

      const instrIndex = stream.findLastIndex(isAgentInstructionsSource);
      if (instrIndex !== -1) {
        const current = stream[instrIndex];
        if (textOf(current) !== desired) {
          const parts = Array.isArray(current.content)
            ? current.content.map((part) => (part?.type === 'text' ? { ...part, text: desired } : part))
            : [{ type: 'text', text: desired }];
          messages = stream.toSpliced(instrIndex, 1, { ...current, role: 'user', content: parts });
          log('replaced agent-instructions message for', sessionId, 'preset:', snap.name);
        }
      } else {
        // 尚无 agent-instructions 消息被采纳：在最后一条已采纳消息之后注入一次，
        // 前提是历史里也确实没有同样的注入（防重复）。
        const alreadySupplied = [...history, ...stream]
          .some((message) => isAgentInstructionsSource(message) && textOf(message) === desired);
        if (!alreadySupplied) {
          const template = stream.findLast((message) => message?.role === 'user') || stream[stream.length - 1];
          const desiredMessage = {
            ...(template || {}),
            id: crypto.randomUUID(),
            role: 'user',
            content: [{ type: 'text', text: desired }],
            source: {
              kind: 'agent-instructions',
              form: 'instructions',
              changes: [{ action: 'set', scope: NS, path: `preset:${snap.name}` }],
            },
          };
          const lastClaimedIndex = stream.findLastIndex((message) => history.includes(message));
          messages = stream.toSpliced(lastClaimedIndex + 1, 0, desiredMessage);
          log('injected agent-instructions message for', sessionId, 'preset:', snap.name);
        }
      }
    }

    // ---------- 第二层：`#名称` 引用替换 ----------
    // 解析全部 user 消息（仅排除 agent-instructions 注入）。
    // 为什么不用 payload.messages 做「历史排除」：实测 DSH 的 payload.messages
    // 已包含本轮刚发的用户消息（按历史排除后真消息也被跳过），而且出站
    // payload 每轮都会重发全部历史，把历史里的 #名称 一并解析反而语义一致。
    // 注意：pre-step 接纳的批次会被 DSH 同步落库，因此替换结果会进入会话
    // 记录（所见即所发），不存在「轨迹保留原文」的通道——见文件头说明。
    const promptsByName = state.prompts.length
      ? new Map(state.prompts.map((p) => [p.name, p]))
      : null;
    if (promptsByName) {
      for (let i = 0; i < messages.length; i += 1) {
        const target = messages[i];
        if (target?.role !== 'user' || isAgentInstructionsSource(target)) continue;
        const raw = textOf(target);
        if (!raw.includes('#')) continue;
        // 多 text 段消息跳过：raw 是全段 join 后的文本，而下方只把解析结果写回
        // 第一段——若替换会保留第二段原文，造成内容重复/损坏，宁可不替换。
        if (Array.isArray(target.content)
          && target.content.filter((part) => part?.type === 'text').length !== 1) continue;
        const { text: resolved, hits } = resolveRefs(raw, promptsByName);
        // 无命中（含纯代码区命中）时不做任何替换与落盘：避免每轮对含 # 的
        // 普通消息反复 persist 全量 JSON
        if (!hits.length) continue;
        const parts = Array.isArray(target.content)
          ? (() => {
              // 多段 content 时只替换承载文本的那一段，保持结构不变
              let consumed = false;
              return target.content.map((part) => {
                if (!consumed && part?.type === 'text') {
                  consumed = true;
                  return { ...part, text: resolved };
                }
                return part;
              });
            })()
          : resolved;
        messages = messages.toSpliced(i, 1, { ...target, content: parts });
        // 记录替换时快照：名称 → 当时内容，供排查比对（有界保留）。
        // 写入后立即执行有界保留：每会话按 takenAt 只留最近 N 条，全局只留
        // 最近 N 个会话——旧条目（无 takenAt，迁移数据）视为 0 优先淘汰。
        const bucket = state.refSnapshots[sessionId] || (state.refSnapshots[sessionId] = {});
        for (const title of hits) {
          const prompt = promptsByName.get(title);
          bucket[title] = { content: prompt.content, takenAt: Date.now() };
        }
        pruneRefSnapshots(bucket);
        pruneSnapshotSessions(state.refSnapshots);
        persist();
        log('resolved #refs for', sessionId, ':', hits.join(', '));
      }
    }

    if (messages === decision.messages) return decision;
    return { ...decision, messages };
  }), 'dsh-inject-kit: agent/pre-step');

  // 固定身份覆盖（system-prompt/assemble waterfall）：
  // - 每个模型步骤都会重跑 assemble → waterfall，覆盖写入 state 后下一轮请求
  //   即生效，无需重启或新建会话。
  // - 作用域键即 agent 对象本身（dsh-agent dispatch.ts：assembleContextFor 返回
  //   { agent, scope: agent }，ScopeKey = object），会话 id 从 context.agent.id
  //   解析（fallback context.scope.id 防御），经 canonicalSessionId 归一后与
  //   覆盖表键对齐。未打标签的全局监听器可收到所有作用域分发（dsh-scope
  //   scopeTarget 对 tag undefined 直接放行）。
  // - 只改 harness:identity 段文本，interpolate:false 按字面量送达（用户文本含
  //   {{...}} 不得触发插值异常）；不碰其他段落、不碰 assembly.tools。
  // - complete: true 的完整人设（minimal 预设）在瀑布后被强制还原，覆盖无效。
  ctx.effect(() => ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const transformed = await next();
    if (!transformed || !Array.isArray(transformed.sections)) return transformed;
    const sessionId = canonicalSessionId(context?.agent?.id ?? context?.scope?.id);
    if (!sessionId) return transformed;
    const override = state.identityOverrides[sessionId];
    if (!override) return transformed;
    const sections = applyIdentityToSections(transformed.sections, override);
    if (sections === transformed.sections) return transformed; // 段落不存在（如 includeHarnessIdentity:false）：无覆盖
    log('identity override applied for', sessionId, '->', override.mode, override.name);
    return { ...transformed, sections };
  }), 'dsh-inject-kit: system-prompt/assemble');
}
