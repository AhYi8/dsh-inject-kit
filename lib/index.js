// dsh-agents-switcher — selectable AGENTS.md injection for DeepSeek Harness (Host).
//
// - Global AGENTS preset library {id,name,content} persisted as JSON under
//   $DSH_HOME (default ~/.dsh), served over a loopback-fenced REST bridge.
// - Per-session selection stores a SNAPSHOT COPY (name+content), so deleting a
//   library preset never changes sessions that already selected it.
// - Default selection = no interception: DSH's own project→global AGENTS.md
//   lookup and injection stay untouched (plugin returns next() untouched).
// - Interception happens in the `agent/pre-step` waterfall and mimics DSH's own
//   dsh-agent-instructions plugin exactly: it never edits the user's message.
//   It composes a SEPARATE user-role message whose `source.kind` is
//   'agent-instructions' (so the WebUI renders it as a collapsed context row,
//   not raw text) and replaces the native AGENTS.md instruction message in the
//   admitted stream. The built-in SystemPrompt is never modified.
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

// Verified against the shipped dsh-agent-instructions plugin (app.asar):
// AGENTS.md travels as a <system-reminder> user-role message carrying
// source {kind:'agent-instructions', form:'instructions', changes:[...]}.
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

// Native parity: escape a literal closing tag inside the preset body, exactly
// like dsh-agent-instructions does for its own reminder text.
function buildBlock(content) {
  const body = String(content).replaceAll(SYSTEM_REMINDER_CLOSE, '<\\/system-reminder>');
  return `${SYSTEM_REMINDER_OPEN}\n${AGENT_INSTRUCTIONS_INTRO}\n\n${body}\n${SYSTEM_REMINDER_CLOSE}`;
}

const textOf = (message) => Array.isArray(message?.content)
  ? message.content.filter((part) => part?.type === 'text').map((part) => part.text ?? '').join('\n')
  : (typeof message?.content === 'string' ? message.content : '');

const isAgentInstructionsSource = (message) => message?.source?.kind === 'agent-instructions';

// --------------------------------------------------------------------- apply

export function apply(ctx, config = {}) {
  const cfg = { verboseLogging: !!config.verboseLogging };
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

    const desired = buildBlock(snap.content);
    const stream = decision.messages;
    const history = Array.isArray(payload?.messages) ? payload.messages : [];

    // Native parity: DSH carries AGENTS.md in a dedicated user-role message with
    // source.kind 'agent-instructions' — never inside the user's own message.
    // The WebUI renders those as collapsed context-injection rows.
    const instrIndex = stream.findLastIndex(isAgentInstructionsSource);
    if (instrIndex !== -1) {
      const current = stream[instrIndex];
      if (textOf(current) === desired) return decision; // already injected, unchanged
      const parts = Array.isArray(current.content)
        ? current.content.map((part) => (part?.type === 'text' ? { ...part, text: desired } : part))
        : [{ type: 'text', text: desired }];
      const messages = stream.toSpliced(instrIndex, 1, { ...current, role: 'user', content: parts });
      log('replaced agent-instructions message for', sessionId, 'preset:', snap.name);
      return { ...decision, messages };
    }

    // No agent-instructions message admitted yet: inject ours once, after the
    // last claimed message, only when history does not already carry it.
    const alreadySupplied = [...history, ...stream]
      .some((message) => isAgentInstructionsSource(message) && textOf(message) === desired);
    if (alreadySupplied) return decision;
    const template = stream.findLast((message) => message?.role === 'user') || stream[stream.length - 1];
    const desiredMessage = {
      ...(template || {}),
      role: 'user',
      content: [{ type: 'text', text: desired }],
      source: {
        kind: 'agent-instructions',
        form: 'instructions',
        changes: [{ action: 'set', scope: NS, path: `preset:${snap.name}` }],
      },
    };
    const lastClaimedIndex = stream.findLastIndex((message) => history.includes(message));
    const messages = stream.toSpliced(lastClaimedIndex + 1, 0, desiredMessage);
    log('injected agent-instructions message for', sessionId, 'preset:', snap.name);
    return { ...decision, messages };
  }), 'dsh-agents-switcher: agent/pre-step');
}
