// dsh-agents-switcher — Web UI (Client).
// - Settings page (settings.section slot): CRUD for the global AGENTS preset library.
// - Composer toolbar (conversation.input.right slot): per-session selector.
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
      selectorDefault: 'Default (AGENTS.md on disk)',
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
      selectorDefault: '默认（磁盘上的 AGENTS.md）',
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

    // ------------------------------------------------------- per-session selector
    function SessionSelector(props) {
      const t = makeT(props?.ctx);
      const sid = sessionIdOf(props);
      const [presets, setPresets] = React.useState(null);
      const [current, setCurrent] = React.useState('');
      const [busy, setBusy] = React.useState(false);

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

      const change = async (event) => {
        const presetId = event.target.value;
        if (!sid) {
          event.target.value = current; // snap back: nothing was persisted
          return;
        }
        setBusy(true);
        try {
          await api('/selection', {
            method: 'PUT',
            body: JSON.stringify({ sessionId: sid, presetId: presetId || null }),
          });
          setCurrent(presetId);
        } catch (error) {
          console.error('[dsh-agents-switcher] selection failed', error);
          event.target.value = current;
        } finally {
          setBusy(false);
        }
      };

      return h('label', {
        className: 'agsw-selector',
        style: { display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
        title: t('selectorLabel'),
      },
        h('span', null, t('selectorLabel')),
        h('select', {
          value: current,
          disabled: busy || !sid || !presets,
          onChange: change,
          style: {
            maxWidth: '220px', height: '26px', fontSize: '12px',
            background: 'var(--dsw-alias-bg-primary)', color: 'var(--dsw-alias-label-primary)',
            border: '1px solid var(--dsw-alias-border-secondary)', borderRadius: '6px', padding: '0 6px',
          },
        },
          h('option', { value: '' }, t('selectorDefault')),
          (presets || []).map((p) => h('option', { key: p.id, value: p.id }, p.name)),
        ),
      );
    }

    // ------------------------------------------------------- settings CRUD page
    function PresetForm({ initial, onSubmit, onCancel, t }) {
      const [name, setName] = React.useState(initial?.name || '');
      const [content, setContent] = React.useState(initial?.content || '');
      const submit = (event) => {
        event.preventDefault();
        if (!name.trim()) return;
        onSubmit({ id: initial?.id, name, content });
      };
      return h('form', { onSubmit: submit, style: { display: 'flex', flexDirection: 'column', gap: '8px', margin: '8px 0' } },
        h('input', {
          value: name, placeholder: t('namePlaceholder'), onChange: (e) => setName(e.target.value),
          style: { height: '32px', padding: '0 10px', background: 'var(--dsw-alias-bg-primary)', color: 'var(--dsw-alias-label-primary)', border: '1px solid var(--dsw-alias-border-secondary)', borderRadius: '8px' },
        }),
        h('textarea', {
          value: content, placeholder: t('contentPlaceholder'), rows: 10, onChange: (e) => setContent(e.target.value),
          style: { padding: '8px 10px', fontFamily: 'monospace', fontSize: '12px', lineHeight: 1.5, background: 'var(--dsw-alias-bg-primary)', color: 'var(--dsw-alias-label-primary)', border: '1px solid var(--dsw-alias-border-secondary)', borderRadius: '8px', resize: 'vertical' },
        }),
        h('div', { style: { display: 'flex', gap: '8px' } },
          h('button', { type: 'submit', className: 'agsw-btn' }, t('save')),
          h('button', { type: 'button', className: 'agsw-btn agsw-btn-ghost', onClick: onCancel }, t('cancel')),
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

      const btn = 'agsw-btn';
      return h('div', { className: 'agsw-page' },
        h('div', { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '12px' } },
          h('div', null,
            h('h2', { style: { margin: '0 0 4px', fontSize: '16px' } }, t('title')),
            h('p', { style: { margin: 0, fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' } }, t('subtitle')),
          ),
          editing === null ? h('button', { type: 'button', className: btn, onClick: () => setEditing('new') }, `+ ${t('addTitle')}`) : null,
        ),
        error ? h('div', { style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: '12px', margin: '8px 0' } }, `${t('failed')}: ${error}`) : null,
        presets === null ? h('div', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)', marginTop: '12px' } }, t('loading')) : null,
        presets !== null && !presets.length && editing === null
          ? h('div', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)', marginTop: '12px' } }, t('none'))
          : null,
        editing === 'new' ? h(PresetForm, { onSubmit: save, onCancel: () => setEditing(null), t }) : null,
        h('div', { className: 'agsw-list', style: { display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '8px' } },
          (presets || []).map((preset) => editing && editing !== 'new' && editing.id === preset.id
            ? h(PresetForm, { key: preset.id, initial: preset, onSubmit: save, onCancel: () => setEditing(null), t })
            : h('div', {
                key: preset.id,
                style: {
                  display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px',
                  background: 'var(--dsw-alias-bg-secondary)', border: '1px solid var(--dsw-alias-border-secondary)', borderRadius: '10px',
                },
              },
                h('div', { style: { flex: 1, minWidth: 0 } },
                  h('div', { style: { fontSize: '13px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, preset.name),
                  h('div', {
                    style: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)', fontFamily: 'monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
                    title: preset.content,
                  }, preset.content || '—'),
                ),
                h('button', { type: 'button', className: `${btn} agsw-btn-ghost`, onClick: () => setEditing(preset) }, t('edit')),
                h('button', { type: 'button', className: `${btn} agsw-btn-ghost agsw-btn-danger`, onClick: () => remove(preset) }, t('delete')),
              )),
        ),
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
              { name: 'settings.section', id: 'dsh-agents-switcher', order: 30, label: 'AGENTS Switcher', locale: NS, inject: () => ({ ctx }) },
              SettingsPage,
            ));
        } catch (error) { console.error('[dsh-agents-switcher] settings seat unavailable', error); }
      }, 'dsh-agents-switcher: slots');

      // Scoped styles, --dsw-alias tokens only.
      ctx.effect(() => {
        if (typeof document === 'undefined') return;
        const style = document.createElement('style');
        style.id = 'dsh-agents-switcher-styles';
        style.textContent = `
.agsw-btn {
  height: 28px; padding: 0 12px; font-size: 12px; cursor: pointer;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-secondary);
  border: 1px solid var(--dsw-alias-border-secondary); border-radius: 8px;
}
.agsw-btn:hover { background: var(--dsw-alias-bg-hover); }
.agsw-btn-ghost { background: transparent; }
.agsw-btn-danger { color: var(--dsw-alias-state-error-primary); }
.agsw-selector select:focus-visible { outline: 1px solid var(--dsw-alias-border-primary); }
`;
        document.head.appendChild(style);
        return () => style.remove();
      }, 'dsh-agents-switcher: styles');
    }

    module.exports = { apply, inject: ['slots', 'locale'] };
    return module.exports;
  },
});
