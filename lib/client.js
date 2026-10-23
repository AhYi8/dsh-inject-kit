// dsh-agents-switcher — Web UI (Client).
// - Settings page (settings.section slot): CRUD for the global AGENTS preset library.
// - Composer toolbar (conversation.input.right slot): per-session selector styled
//   after DSH's native permission selector (trigger + dropdown, --dsw-alias tokens).
//   Default = no interception (DSH original project→global AGENTS.md behavior);
//   a selection stores an independent per-session snapshot on the Host.
// Data flows through the Host REST bridge at /dsh-agents-switcher/*.
window.__ModuleLoader__.load({
  id: 'dsh-agents-switcher',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const React = require('react');
    const h = React.createElement;

    const NS = 'dsh-agents-switcher';
    const PKG = 'dsh-agents-switcher';
    const API = '/dsh-agents-switcher';

    // ------------------------------------------------------------------ i18n
    const en = {
      title: 'AGENTS Switcher',
      subtitle: 'Selectable AGENTS.md presets: manage a shared library here and pick one per session in the composer toolbar. Default keeps DSH\'s original AGENTS.md behavior.',
      loading: 'Loading…',
      none: 'No AGENTS presets yet. Add one below.',
      addTitle: 'Add preset',
      name: 'Name',
      namePlaceholder: 'e.g. Review persona / Strict TDD / Minimal',
      content: 'AGENTS.md content',
      contentPlaceholder: 'Full AGENTS.md body injected verbatim when this preset is selected…',
      save: 'Save',
      cancel: 'Cancel',
      edit: 'Edit',
      delete: 'Delete',
      confirmDelete: (name) => `Delete preset "${name}"? Sessions already using it keep their snapshot until they change selection.`,
      selectorLabel: 'AGENTS',
      selectorDefault: 'Default',
      saved: 'Saved',
      failed: 'Request failed',
    };
    const zh = {
      title: 'AGENTS 切换器',
      subtitle: '可选择的 AGENTS.md 预设：在这里维护共享库，在输入框工具栏按会话选择。默认不拦截，保持 DSH 原生 AGENTS.md 行为。',
      loading: '加载中…',
      none: '还没有 AGENTS 预设，在下方新增一个。',
      addTitle: '新增预设',
      name: '名称',
      namePlaceholder: '例如：评审人格 / 严格 TDD / 极简',
      content: 'AGENTS.md 内容',
      contentPlaceholder: '选中该预设时按原文注入的完整 AGENTS.md 正文…',
      save: '保存',
      cancel: '取消',
      edit: '编辑',
      delete: '删除',
      confirmDelete: (name) => `删除预设"${name}"？已选中的会话保留各自的快照副本，直到它们重新选择。`,
      selectorLabel: 'AGENTS',
      selectorDefault: '默认',
      saved: '已保存',
      failed: '请求失败',
    };

    function activeLocale(ctx) {
      try {
        const snap = ctx.locale?.getSnapshot?.();
        if (snap?.active) return snap.active;
      } catch { /* no locale service */ }
      try {
        const first = typeof navigator !== 'undefined' && navigator.languages?.[0];
        if (first) return first.slice(0, 2);
      } catch { /* non-browser */ }
      return 'en';
    }
    const lookup = (dict, key) => {
      const value = dict[key];
      return typeof value === 'function' ? value : () => value;
    };
    function makeT(ctx) {
      const loc = activeLocale(ctx);
      const dict = loc === 'zh' ? zh : en;
      return (key, ...args) => lookup(dict, key)(...args);
    }

    async function api(path, options) {
      const res = await fetch(`${API}${path}`, {
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        credentials: 'same-origin',
        ...options,
      });
      if (!res.ok) {
        let detail = '';
        try { detail = (await res.json())?.error || ''; } catch { /* no body */ }
        throw new Error(`${res.status} ${detail}`);
      }
      return res.json();
    }

    function sessionIdOf(props) {
      if (typeof props?.sessionId === 'string' && props.sessionId) return props.sessionId;
      const probes = [
        () => props?.useSession?.(),
        () => props?.session,
        () => props?.ctx?.session,
      ];
      for (const probe of probes) {
        try {
          const s = probe();
          const id = s?.sessionId ?? s?.id ?? s?.session?.id;
          if (typeof id === 'string' && id) return id;
        } catch { /* probe absent */ }
      }
      return null;
    }

    // ------------------------------------------------------------- shared icons
    const ChevronDown = () => h('svg', {
      viewBox: '0 0 16 16', width: 14, height: 14, fill: 'none',
      stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
      'aria-hidden': true,
    }, h('path', { d: 'M4 6l4 4 4-4' }));

    const DocIcon = () => h('svg', {
      viewBox: '0 0 16 16', width: 14, height: 14, fill: 'none',
      stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round',
      'aria-hidden': true,
    },
      h('path', { d: 'M9.5 1.75H4.5a1 1 0 0 0-1 1v10.5a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V4.75l-3-3z' }),
      h('path', { d: 'M9.5 1.75v3h3' }),
      h('path', { d: 'M6 8h4M6 10.5h4' }),
    );

    const CheckIcon = () => h('svg', {
      viewBox: '0 0 16 16', width: 14, height: 14, fill: 'none',
      stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
      'aria-hidden': true,
    }, h('path', { d: 'M3 8.5l3.5 3.5L13 4.5' }));

    // ------------------------------------------------------- per-session selector
    // Visual contract copied from the shipped permission selector trigger:
    // 28px pill-less text trigger, 13px/500, label-secondary, chevron rotates on open.
    function SessionSelector(props) {
      const t = makeT(props?.ctx);
      const sid = sessionIdOf(props);
      const [presets, setPresets] = React.useState(null);
      const [current, setCurrent] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [open, setOpen] = React.useState(false);
      const rootRef = React.useRef(null);

      React.useEffect(() => {
        let alive = true;
        api('/presets')
          .then((data) => {
            if (!alive) return;
            setPresets(data.presets || []);
            const snap = sid ? data.selections?.[sid] : null;
            setCurrent(snap?.presetId || '');
          })
          .catch(() => { if (alive) setPresets([]); });
        return () => { alive = false; };
      }, [sid]);

      React.useEffect(() => {
        if (!open) return;
        const onDocDown = (event) => {
          if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false);
        };
        const onKey = (event) => { if (event.key === 'Escape') setOpen(false); };
        document.addEventListener('mousedown', onDocDown, true);
        document.addEventListener('keydown', onKey);
        return () => {
          document.removeEventListener('mousedown', onDocDown, true);
          document.removeEventListener('keydown', onKey);
        };
      }, [open]);

      const select = async (presetId) => {
        setOpen(false);
        if (presetId === current) return;
        if (!sid) return; // snap back: nothing was persisted
        setBusy(true);
        try {
          await api('/selection', {
            method: 'PUT',
            body: JSON.stringify({ sessionId: sid, presetId: presetId || null }),
          });
          setCurrent(presetId);
        } catch (error) {
          console.error('[dsh-agents-switcher] selection failed', error);
        } finally {
          setBusy(false);
        }
      };

      const currentName = current
        ? ((presets || []).find((p) => p.id === current)?.name ?? '…')
        : t('selectorDefault');

      const items = [
        { id: '', name: t('selectorDefault') },
        ...(presets || []).map((p) => ({ id: p.id, name: p.name })),
      ];

      return h('div', { className: 'agsw-sel', ref: rootRef },
        h('button', {
          type: 'button',
          className: 'agsw-trig',
          'aria-label': `${t('selectorLabel')}: ${currentName}`,
          'aria-expanded': open ? 'true' : 'false',
          disabled: busy || !sid || !presets,
          onClick: () => setOpen(!open),
        },
          h('span', { className: 'agsw-trigIcon', 'aria-hidden': true }, h(DocIcon)),
          h('span', { className: 'agsw-trigLabel' }, currentName),
          h('span', { className: open ? 'agsw-chev agsw-chevOpen' : 'agsw-chev', 'aria-hidden': true }, h(ChevronDown)),
        ),
        open ? h('div', { className: 'agsw-menu', role: 'listbox' },
          items.map((item) => h('div', {
            key: item.id || '__default__',
            role: 'option',
            'aria-selected': item.id === current ? 'true' : 'false',
            className: item.id === current ? 'agsw-item agsw-itemActive' : 'agsw-item',
            onClick: () => select(item.id),
          },
            h('span', { className: 'agsw-itemName' }, item.name),
            item.id === current ? h('span', { className: 'agsw-itemCheck' }, h(CheckIcon)) : null,
          )),
        ) : null,
      );
    }

    // ------------------------------------------------------- settings CRUD page
    // Row/card visual contract follows DSH settings rows:
    // 16px vertical padding, .5px border-l2 separators, title 14/22, desc 12/18.
    function PresetForm({ initial, onSubmit, onCancel, t }) {
      const [name, setName] = React.useState(initial?.name || '');
      const [content, setContent] = React.useState(initial?.content || '');
      const submit = (event) => {
        event.preventDefault();
        if (!name.trim()) return;
        onSubmit({ id: initial?.id, name, content });
      };
      return h('form', { className: 'agsw-form', onSubmit: submit },
        h('label', { className: 'agsw-fieldLabel' }, t('name')),
        h('input', { className: 'agsw-input', value: name, placeholder: t('namePlaceholder'), onChange: (e) => setName(e.target.value) }),
        h('label', { className: 'agsw-fieldLabel' }, t('content')),
        h('textarea', { className: 'agsw-input agsw-textarea', value: content, placeholder: t('contentPlaceholder'), rows: 10, onChange: (e) => setContent(e.target.value) }),
        h('div', { className: 'agsw-formActions' },
          h('button', { type: 'submit', className: 'agsw-btn agsw-btnPrimary' }, t('save')),
          h('button', { type: 'button', className: 'agsw-btn agsw-btnGhost', onClick: onCancel }, t('cancel')),
        ),
      );
    }

    function SettingsPage(props) {
      const t = makeT(props?.ctx);
      const [presets, setPresets] = React.useState(null);
      const [editing, setEditing] = React.useState(null); // null | 'new' | preset
      const [error, setError] = React.useState('');

      const reload = React.useCallback(() => {
        api('/presets').then((data) => setPresets(data.presets || [])).catch((e) => { setPresets([]); setError(String(e.message || e)); });
      }, []);
      React.useEffect(reload, [reload]);

      const save = async (draft) => {
        setError('');
        try {
          await api('/presets', { method: 'PUT', body: JSON.stringify(draft) });
          setEditing(null);
          reload();
        } catch (e) { setError(String(e.message || e)); }
      };
      const remove = async (preset) => {
        setError('');
        if (!window.confirm(t('confirmDelete')(preset.name))) return;
        try {
          await api(`/presets?id=${encodeURIComponent(preset.id)}`, { method: 'DELETE' });
          reload();
        } catch (e) { setError(String(e.message || e)); }
      };

      return h('div', { className: 'agsw-page' },
        h('div', { className: 'agsw-head' },
          h('div', null,
            h('h2', { className: 'agsw-title' }, t('title')),
            h('p', { className: 'agsw-desc' }, t('subtitle')),
          ),
          editing === null ? h('button', { type: 'button', className: 'agsw-btn agsw-btnPrimary', onClick: () => setEditing('new') }, `＋ ${t('addTitle')}`) : null,
        ),
        error ? h('div', { className: 'agsw-error' }, `${t('failed')}: ${error}`) : null,
        presets === null ? h('div', { className: 'agsw-hint' }, t('loading')) : null,
        presets !== null && !presets.length && editing === null
          ? h('div', { className: 'agsw-hint' }, t('none'))
          : null,
        editing === 'new' ? h(PresetForm, { onSubmit: save, onCancel: () => setEditing(null), t }) : null,
        (presets || []).length || (editing && editing !== 'new')
          ? h('div', { className: 'agsw-list' },
              (presets || []).map((preset) => editing && editing !== 'new' && editing.id === preset.id
                ? h(PresetForm, { key: preset.id, initial: preset, onSubmit: save, onCancel: () => setEditing(null), t })
                : h('div', { key: preset.id, className: 'agsw-row' },
                    h('div', { className: 'agsw-rowText' },
                      h('div', { className: 'agsw-rowTitle' }, preset.name),
                      h('div', { className: 'agsw-rowDesc', title: preset.content }, preset.content || '—'),
                    ),
                    h('div', { className: 'agsw-rowActions' },
                      h('button', { type: 'button', className: 'agsw-btn agsw-btnGhost', onClick: () => setEditing(preset) }, t('edit')),
                      h('button', { type: 'button', className: 'agsw-btn agsw-btnGhost agsw-btnDanger', onClick: () => remove(preset) }, t('delete')),
                    ),
                  )),
            )
          : null,
      );
    }

    // -------------------------------------------------------------------- apply
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-agents-switcher: dictionaries');
      ctx.effect(() => {
        if (!ctx.slots) return;
        try {
          ctx.slots.inject('conversation.input.right', () =>
            ctx.slots.register(
              { name: 'conversation.input.right', id: 'dsh-agents-switcher-selector', order: 40, locale: NS, inject: () => ({ ctx }) },
              SessionSelector,
            ));
        } catch (error) { console.error('[dsh-agents-switcher] selector seat unavailable', error); }
        try {
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              { name: 'settings.section', id: 'dsh-agents-switcher', order: 30, label: 'AGENTS 切换器', locale: NS, inject: () => ({ ctx }) },
              SettingsPage,
            ));
        } catch (error) { console.error('[dsh-agents-switcher] settings seat unavailable', error); }
      }, 'dsh-agents-switcher: slots');

      // Scoped styles, --dsw-alias tokens only. Trigger metrics mirror the
      // shipped permission selector (28px, 13px/500, label-secondary, rotating chevron).
      ctx.effect(() => {
        if (typeof document === 'undefined') return;
        const style = document.createElement('style');
        style.id = 'dsh-agents-switcher-styles';
        style.textContent = `
.agsw-sel { position: relative; display: inline-flex; max-width: 260px; }

.agsw-trig {
  border-radius: var(--dsw-radius-sm); min-width: 0; max-width: 260px; height: 28px;
  color: var(--dsw-alias-label-secondary); cursor: pointer; background: 0 0; border: none;
  outline: none; align-items: center; gap: 4px; padding: 0 4px 0 8px;
  font-size: 13px; font-weight: 500; line-height: 20px; display: inline-flex; font-family: inherit;
}
.agsw-trig:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.agsw-trig:focus-visible { box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); }
.agsw-trig:disabled { color: var(--dsw-alias-label-dimmed); cursor: default; }
.agsw-trigIcon { flex: none; display: inline-flex; }
.agsw-trigIcon svg { width: 14px; height: 14px; }
.agsw-trigLabel { text-overflow: ellipsis; white-space: nowrap; min-width: 0; overflow: hidden; }
.agsw-chev { color: var(--dsw-alias-label-caption); flex: none; transition: transform .12s; display: inline-flex; }
.agsw-chev svg { width: 14px; height: 14px; }
.agsw-chevOpen { transform: rotate(180deg); }

.agsw-menu {
  position: absolute; bottom: calc(100% + 6px); right: 0; z-index: 1000;
  min-width: 180px; max-width: 300px; max-height: 320px; overflow-y: auto;
  background: var(--dsw-alias-bg-primary); color: var(--dsw-alias-label-primary);
  border: .5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md);
  box-shadow: 0 8px 24px rgba(0, 0, 0, .14); padding: 4px;
}
.agsw-item {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 6px 10px; border-radius: var(--dsw-radius-sm);
  font-size: 13px; line-height: 20px; cursor: pointer; min-width: 0;
}
.agsw-item:hover { background: var(--dsw-alias-interactive-bg-hover); }
.agsw-itemName { text-overflow: ellipsis; white-space: nowrap; min-width: 0; overflow: hidden; }
.agsw-itemActive { color: var(--dsw-alias-state-business-primary); font-weight: 500; }
.agsw-itemCheck { flex: none; display: inline-flex; }

.agsw-page { display: flex; flex-direction: column; gap: 12px; max-width: 760px; margin-top: 8px; }
.agsw-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.agsw-title { margin: 0 0 4px; font-size: 16px; font-weight: 600; line-height: 24px; color: var(--dsw-alias-label-primary); }
.agsw-desc { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.agsw-hint { font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.agsw-error { font-size: 12px; color: var(--dsw-alias-state-error-primary); }

.agsw-list { display: flex; flex-direction: column; }
.agsw-row {
  display: flex; align-items: center; gap: 8px; padding: 16px 0;
  border-bottom: .5px solid var(--dsw-alias-border-l2);
}
.agsw-rowText { display: flex; flex-direction: column; flex: 1; gap: 4px; min-width: 0; padding-right: 24px; }
.agsw-rowTitle { font-size: 14px; font-weight: 400; line-height: 22px; color: var(--dsw-alias-label-primary); }
.agsw-rowDesc {
  font-size: 12px; font-weight: 400; line-height: 18px; color: var(--dsw-alias-label-tertiary);
  font-family: ui-monospace, monospace;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.agsw-rowActions { display: flex; gap: 8px; flex: none; }

.agsw-form { display: flex; flex-direction: column; gap: 8px; padding: 12px 14px; margin-top: 4px;
  background: var(--dsw-alias-bg-module-platform); border-radius: var(--dsw-radius-md); }
.agsw-fieldLabel { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.agsw-input {
  height: 36px; padding: 0 12px; font: inherit; font-size: 13px; color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-primary); border: .5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-sm); outline: none; min-width: 0; box-sizing: border-box;
}
.agsw-textarea { height: auto; min-height: 120px; padding: 10px 12px;
  font-family: ui-monospace, monospace; font-size: 12px; line-height: 1.6; resize: vertical; }
.agsw-input:focus-visible { box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); }
.agsw-formActions { display: flex; gap: 8px; margin-top: 4px; }

.agsw-btn {
  height: 32px; padding: 0 14px; font-size: 13px; line-height: 20px; font-family: inherit;
  white-space: nowrap; flex: none;
  cursor: pointer; display: inline-flex; align-items: center; gap: 6px;
  color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-module-platform);
  border: .5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm);
}
.agsw-btn:hover { background: var(--dsw-alias-interactive-bg-hover); }
.agsw-btn:focus-visible { box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline: none; }
.agsw-btnPrimary { color: var(--dsw-alias-label-brightest, #fff); background: var(--dsw-alias-state-business-primary); border-color: transparent; }
.agsw-btnPrimary:hover { filter: brightness(1.08); background: var(--dsw-alias-state-business-primary); }
.agsw-btnGhost { background: transparent; border-color: transparent; color: var(--dsw-alias-label-secondary); }
.agsw-btnGhost:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.agsw-btnDanger { color: var(--dsw-alias-state-error-primary); }
`;
        document.head.appendChild(style);
        return () => style.remove();
      }, 'dsh-agents-switcher: styles');
    }

    module.exports = { apply, inject: ['slots', 'locale'] };
    return module.exports;
  },
});
