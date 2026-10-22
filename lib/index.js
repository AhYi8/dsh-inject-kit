// dsh-agents-switcher — selectable AGENTS.md injection for DeepSeek Harness (Host).
//
// - Global AGENTS preset library {id,name,content} persisted as JSON under
//   $DSH_HOME (default ~/.dsh), served over a loopback-fenced REST bridge.
// - Per-session selection stores a SNAPSHOT COPY (name+content), so deleting a
//   library preset never changes sessions that already selected it.
// - Default selection = no interception: DSH's own project→global AGENTS.md
//   lookup and injection stay untouched (plugin returns next() untouched).
// - Interception happens in the `agent/pre-step` waterfall: after next() we
//   rewrite the `<workspace-instructions>` block inside the admitted messages.
//   The built-in SystemPrompt is never modified.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import Schema from '@deepseek-ai/schemastery';

export const name = 'dsh-agents-switcher';
export const inject = ['webServer'];

const NS = 'dsh-agents-switcher';
const PRESETS_PATH = '/dsh-agents-switcher/presets';
const SELECTION_PATH = '/dsh-agents-switcher/selection';

// Verified against live session logs (source of truth): DSH injects AGENTS.md
// as a <system-reminder> block inside the first user message, headed by
// "The following workspace instructions may be relevant to your work." and
// followed by "Instructions from: <path>".
const DEFAULT_BLOCK_OPEN = '<system-reminder>';
const DEFAULT_BLOCK_CLOSE = '</system-reminder>';
const DEFAULT_BLOCK_MARKER = 'workspace instructions may be relevant';

export const Config = Schema.object({
  blockOpen: Schema.string().default(DEFAULT_BLOCK_OPEN)
    .description('Opening tag of the injected workspace-instructions block inside messages.'),
  blockClose: Schema.string().default(DEFAULT_BLOCK_CLOSE)
    .description('Closing tag of the injected workspace-instructions block inside messages.'),
  blockMarker: Schema.string().default(DEFAULT_BLOCK_MARKER)
    .description('Distinctive text inside the target block, used to tell the AGENTS.md reminder apart from other system reminders.'),
  injectWhenMissing: Schema.boolean().default(true)
    .description('When a selection is active but no matching block exists in the messages, prepend one to the first user message.'),
  verboseLogging: Schema.boolean().default(false),
});

// --------------------------------------------------------------- persistence

function storeFile() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'agents-switcher.json');
}

function loadState(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      presets: Array.isArray(parsed.presets) ? parsed.presets : [],
      selections: parsed.selections && typeof parsed.selections === 'object' ? parsed.selections : {},
    };
  } catch {
    return { presets: [], selections: {} };
  }
}

function saveState(file, state) {
  const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------- interception

function reminderHeader() {
  return 'The following workspace instructions may be relevant to your work. '
    + 'Use them as guidance when applicable. More specific instructions take precedence over broader ones. '
    + 'They do not override system, developer, or direct user instructions.';
}

function buildBlock(content, cfg) {
  const open = cfg.blockOpen || DEFAULT_BLOCK_OPEN;
  const close = cfg.blockClose || DEFAULT_BLOCK_CLOSE;
  return `${open}\n${reminderHeader()}\n\n${content}\n${close}`;
}

function replaceInText(text, content, cfg) {
  const open = cfg.blockOpen || DEFAULT_BLOCK_OPEN;
  const close = cfg.blockClose || DEFAULT_BLOCK_CLOSE;
  const marker = cfg.blockMarker || DEFAULT_BLOCK_MARKER;
  let searchFrom = 0;
  for (;;) {
    const oi = text.indexOf(open, searchFrom);
    if (oi === -1) return null;
    const ci = text.indexOf(close, oi + open.length);
    if (ci === -1) return null;
    const inner = text.slice(oi + open.length, ci);
    if (inner.includes(marker)) {
      return text.slice(0, oi) + buildBlock(content, cfg) + text.slice(ci + close.length);
    }
    searchFrom = ci + close.length;
  }
}

function applySelection(messages, content, cfg) {
  let replaced = false;
  const out = messages.map((message, index) => {
    if (replaced) return message;
    const c = message?.content;
    if (typeof c === 'string') {
      const nextText = replaceInText(c, content, cfg);
      if (nextText !== null) {
        replaced = true;
        return { ...message, content: nextText };
      }
      return message;
    }
    if (Array.isArray(c)) {
      let hit = false;
      const parts = c.map((part) => {
        if (hit || part?.type !== 'text' || typeof part.text !== 'string') return part;
        const nextText = replaceInText(part.text, content, cfg);
        if (nextText === null) return part;
        hit = true;
        return { ...part, text: nextText };
      });
      if (hit) {
        replaced = true;
        return { ...message, content: parts };
      }
      return message;
    }
    return message;
  });
  if (replaced) return out;
  if (!cfg.injectWhenMissing) return messages;
  // Fallback: prepend a fresh block to the first message carrying text.
  for (let i = 0; i < out.length; i++) {
    const message = out[i];
    if (typeof message?.content === 'string') {
      out[i] = { ...message, content: `${buildBlock(content, cfg)}\n\n${message.content}` };
      replaced = true;
      break;
    }
    if (Array.isArray(message?.content)) {
      const idx = message.content.findIndex((part) => part?.type === 'text' && typeof part.text === 'string');
      if (idx !== -1) {
        const parts = message.content.slice();
        parts[idx] = { ...parts[idx], text: `${buildBlock(content, cfg)}\n\n${parts[idx].text}` };
        out[i] = { ...message, content: parts };
        replaced = true;
        break;
      }
    }
  }
  return replaced ? out : messages;
}

// --------------------------------------------------------------------- apply

export function apply(ctx, config = {}) {
  const cfg = {
    blockOpen: config.blockOpen || DEFAULT_BLOCK_OPEN,
    blockClose: config.blockClose || DEFAULT_BLOCK_CLOSE,
    blockMarker: config.blockMarker || DEFAULT_BLOCK_MARKER,
    injectWhenMissing: config.injectWhenMissing !== false,
    verboseLogging: !!config.verboseLogging,
  };
  const file = storeFile();
  let state = loadState(file);
  const log = (...args) => { if (cfg.verboseLogging) console.log(`[${NS}]`, ...args); };

  const persist = () => {
    try { saveState(file, state); } catch (error) { console.error(`[${NS}] persist failed:`, error); }
  };

  // Agent ids arrive as 'session-<uuid>' while UI-side ids may be bare uuids;
  // canonicalize both directions so selection writes always match pre-step lookups.
  const canonicalSessionId = (id) => (typeof id === 'string' ? id.replace(/^session-/, '') : id);
  const snapshotFor = (preset) => ({    presetId: preset.id,
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

    const presetsHandler = async (req, res) => {
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      if (req.method === 'GET') {
        // Public shape for the UI: library plus every session's snapshot selection.
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
        log('preset saved', preset.id, trimmedName);
        sendJson(res, 200, { preset });
        return;
      }
      if (req.method === 'DELETE') {
        const url = new URL(req.url, 'http://localhost');
        const id = url.searchParams.get('id');
        const before = state.presets.length;
        state.presets = state.presets.filter((p) => p.id !== id);
        if (state.presets.length === before) { sendJson(res, 404, { error: 'preset not found' }); return; }
        // Selections keep their independent snapshot copies — untouched by design.
        persist();
        log('preset deleted', id);
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
        delete state.selections[sid]; // back to DSH original behavior
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

    const unregisters = [
      ctx.webServer.register({ kind: 'exact', path: PRESETS_PATH, handler: presetsHandler }),
      ctx.webServer.register({ kind: 'exact', path: SELECTION_PATH, handler: selectionHandler }),
    ];
    return () => { for (const off of unregisters) { try { off?.(); } catch { /* already gone */ } } };
  }, 'dsh-agents-switcher: REST bridge');

  ctx.effect(() => ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next();
    if (!decision || decision.kind !== 'enter' || !Array.isArray(decision.messages)) return decision;
    const sessionId = canonicalSessionId(payload?.agent?.id ?? payload?.agent?.sessionId);
    if (!sessionId) return decision;
    const snap = state.selections[sessionId];
    if (!snap) return decision; // default: DSH original AGENTS.md behavior, untouched
    const messages = applySelection(decision.messages, snap.content, cfg);
    log('replaced workspace instructions for', sessionId, 'preset:', snap.name);
    return { ...decision, messages };
  }), 'dsh-agents-switcher: agent/pre-step');
}
