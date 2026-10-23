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
// - 输入框 `#名称` 触发下拉（client 端），发送时 Host 在 agent/pre-step 将
//   本轮新用户消息中的 `#名称` 引用替换为对应 Prompt 内容（发送时快照语义：
//   替换只作用于即将发出的请求 payload，持久轨迹保留 `#名称` 原文；
//   发送后编辑/删除 Prompt 不影响已发出消息）。
// - 替换采用单遍扫描：替换进去的正文不会被再次解析（防递归）。
// - 每次成功替换记录 refSnapshots[sessionId][名称]，供 UI 气泡装饰查询。
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
  return {
    presets: Array.isArray(parsed.presets) ? parsed.presets : [],
    prompts: Array.isArray(parsed.prompts) ? parsed.prompts : [],
    selections: parsed.selections && typeof parsed.selections === 'object' ? parsed.selections : {},
    refSnapshots: parsed.refSnapshots && typeof parsed.refSnapshots === 'object' ? parsed.refSnapshots : {},
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
  if (!legacy) return { presets: [], prompts: [], selections: {}, refSnapshots: {} };
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
import { REF_PATTERN, resolveRefs } from './refs.js';

export { REF_PATTERN, resolveRefs };

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
    req.on('data', (chunk) => { data += chunk; if (data.length > 4 * 1024 * 1024) req.destroy(); });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); } catch { resolve(null); }
    });
    req.on('error', () => resolve(null));
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
        // 名称是 `#引用` 的唯一键，全库必须唯一（重名校验在服务端兜底）。
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

    const unregisters = [
      ctx.webServer.register({ kind: 'exact', path: AGENTS_PRESETS_PATH, handler: presetsHandler }),
      ctx.webServer.register({ kind: 'exact', path: AGENTS_SELECTION_PATH, handler: selectionHandler }),
      ctx.webServer.register({ kind: 'exact', path: PROMPTS_PATH, handler: promptsHandler }),
      ctx.webServer.register({ kind: 'exact', path: REFS_PATH, handler: refsHandler }),
    ];
    return () => { for (const off of unregisters) { try { off?.(); } catch { /* already gone */ } } };
  }, 'dsh-inject-kit: REST bridge');

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

    // ---------- 第二层：`#名称` 引用替换（发送时快照） ----------
    const historyMessages = Array.isArray(payload?.messages) ? payload.messages : [];
    // 只处理本轮新发出的那条用户消息（不在历史里、非 agent-instructions 注入），
    // 持久轨迹与历史消息一律不动。
    let targetIndex = -1;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (m?.role === 'user' && !isAgentInstructionsSource(m) && !historyMessages.includes(m)) {
        targetIndex = i;
        break;
      }
    }
    if (targetIndex !== -1 && state.prompts.length) {
      const target = messages[targetIndex];
      const raw = textOf(target);
      if (raw.includes('#')) {
        const promptsByName = new Map(state.prompts.map((p) => [p.name, p]));
        const { text: resolved, hits } = resolveRefs(raw, promptsByName);
        if (hits.length) {
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
          messages = messages.toSpliced(targetIndex, 1, { ...target, content: parts });
          // 记录发送时快照：名称 → 当时内容，供 UI 气泡装饰与排查
          const bucket = state.refSnapshots[sessionId] || (state.refSnapshots[sessionId] = {});
          for (const title of hits) {
            const prompt = promptsByName.get(title);
            bucket[title] = { content: prompt.content, takenAt: Date.now() };
          }
          persist();
          log('resolved #refs for', sessionId, ':', hits.join(', '));
        }
      }
    }

    if (messages === decision.messages) return decision;
    return { ...decision, messages };
  }), 'dsh-inject-kit: agent/pre-step');
}
