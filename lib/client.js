// dsh-inject-kit — 注入工具箱（Client 端 Web UI）。
// - Settings 页两个区块（settings.section slot）：
//   · AGENTS 切换器：全局 AGENTS 预设库 CRUD（沿用原 dsh-agents-switcher 语义）；
//   · Prompt 管理：Prompt 库增删改查（名称/分组/内容，默认分组「默认」）。
// - Composer 工具栏（conversation.input.right slot）：按会话 AGENTS 选择器（沿用）。
// - 输入框 `#` 触发下拉：DOM 事件委托 + 镜像 div 计算光标坐标，
//   ↑↓ 键盘导航、Enter/Tab/点击选择、Esc/失焦关闭、按名称输入过滤、分组标题。
//   选中后输入框仅显示「#Prompt名称」（引用样式由气泡装饰渲染）。
// - 气泡 chip 装饰：MutationObserver 扫描用户消息气泡中的 `#名称` 文本，
//   以引用样式 chip 展示（悬停提示内容；Prompt 已删除时置灰）。
//   注意：`#名称` 替换只发生在 Host 发送时（快照语义），持久消息保留原文。
// 数据统一走 Host REST 桥接 /dsh-inject-kit/*。
window.__ModuleLoader__.load({
  id: 'dsh-inject-kit',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const React = require('react');
    const h = React.createElement;

    const NS = 'dsh-inject-kit';
    const PKG = 'dsh-inject-kit';
    const API = '/dsh-inject-kit';

    // ------------------------------------------------------------------ i18n
    const en = {
      title: 'Inject Kit',
      sectionLabel: 'Inject Kit',
      tabAgents: 'AGENTS',
      tabPrompts: 'Prompts',
      subtitle: 'Selectable AGENTS.md presets: manage a shared library here and pick one per session in the composer toolbar. Default keeps DSH\'s original AGENTS.md behavior.',
      promptsSubtitle: 'Reusable prompts referenced as #Name in the composer. The reference is replaced with the prompt content at send time; the chat transcript keeps #Name.',
      loading: 'Loading…',
      none: 'No AGENTS presets yet. Add one below.',
      promptsNone: 'No prompts yet. Add one below.',
      addTitle: 'Add preset',
      addPrompt: 'Add prompt',
      name: 'Name',
      namePlaceholder: 'e.g. Review persona / Strict TDD / Minimal',
      groupName: 'Group',
      groupPlaceholder: 'Default group: 默认',
      promptNamePlaceholder: 'e.g. code-review',
      content: 'AGENTS.md content',
      promptContent: 'Prompt content',
      promptContentPlaceholder: 'Full text injected in place of #Name when the message is sent…',
      save: 'Save',
      cancel: 'Cancel',
      edit: 'Edit',
      delete: 'Delete',
      confirmDelete: (name) => `Delete preset "${name}"? Sessions already using it keep their snapshot until they change selection.`,
      confirmDeletePrompt: (name) => `Delete prompt "${name}"? Sent messages keep their resolved content (send-time snapshot); the #Name text stays in the transcript.`,
      selectorLabel: 'AGENTS',
      selectorDefault: 'Default',
      saved: 'Saved',
      failed: 'Request failed',
      dupName: 'A prompt with this name already exists',
      missingChip: 'Prompt deleted — the sent message kept its send-time content',
    };
    const zh = {
      title: '注入工具箱',
      sectionLabel: '注入工具箱',
      tabAgents: 'AGENTS',
      tabPrompts: 'Prompt 管理',
      subtitle: '可选择的 AGENTS.md 预设：在这里维护共享库，在输入框工具栏按会话选择。默认不拦截，保持 DSH 原生 AGENTS.md 行为。',
      promptsSubtitle: '可复用 Prompt，在输入框用 #名称 引用。发送时引用会被替换为 Prompt 内容；会话记录里保留 #名称 原文。',
      loading: '加载中…',
      none: '还没有 AGENTS 预设，在下方新增一个。',
      promptsNone: '还没有 Prompt，在下方新增一个。',
      addTitle: '新增预设',
      addPrompt: '新增 Prompt',
      name: '名称',
      namePlaceholder: '例如：评审人格 / 严格 TDD / 极简',
      groupName: '分组',
      groupPlaceholder: '留空归入默认分组「默认」',
      promptNamePlaceholder: '例如：code-review（输入 #code-review 引用）',
      content: 'AGENTS.md 内容',
      promptContent: 'Prompt 内容',
      promptContentPlaceholder: '发送时替换 #名称 的完整正文…',
      save: '保存',
      cancel: '取消',
      edit: '编辑',
      delete: '删除',
      confirmDelete: (name) => `删除预设"${name}"？已选中的会话保留各自的快照副本，直到它们重新选择。`,
      confirmDeletePrompt: (name) => `删除 Prompt"${name}"？已发出的消息保留发送时的内容（快照）；会话记录中的 #名称 原文不受影响。`,
      selectorLabel: 'AGENTS',
      selectorDefault: '默认',
      saved: '已保存',
      failed: '请求失败',
      dupName: '已存在同名 Prompt',
      missingChip: 'Prompt 已删除——已发消息保留发送时的内容',
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
    // 视觉契约沿用原生权限选择器：28px 无底色文字触发器、13px/500、
    // label-secondary、箭头随开合旋转。
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
        api('/agents/presets')
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
        if (!sid) return; // 弹回：未持久化任何选择
        setBusy(true);
        try {
          await api('/agents/selection', {
            method: 'PUT',
            body: JSON.stringify({ sessionId: sid, presetId: presetId || null }),
          });
          setCurrent(presetId);
        } catch (error) {
          console.error('[dsh-inject-kit] selection failed', error);
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

      return h('div', { className: 'ikw-sel', ref: rootRef },
        h('button', {
          type: 'button',
          className: 'ikw-trig',
          'aria-label': `${t('selectorLabel')}: ${currentName}`,
          'aria-expanded': open ? 'true' : 'false',
          disabled: busy || !sid || !presets,
          onClick: () => setOpen(!open),
        },
          h('span', { className: 'ikw-trigIcon', 'aria-hidden': true }, h(DocIcon)),
          h('span', { className: 'ikw-trigLabel' }, currentName),
          h('span', { className: open ? 'ikw-chev ikw-chevOpen' : 'ikw-chev', 'aria-hidden': true }, h(ChevronDown)),
        ),
        open ? h('div', { className: 'ikw-menu', role: 'listbox' },
          items.map((item) => h('div', {
            key: item.id || '__default__',
            role: 'option',
            'aria-selected': item.id === current ? 'true' : 'false',
            className: item.id === current ? 'ikw-item ikw-itemActive' : 'ikw-item',
            onClick: () => select(item.id),
          },
            h('span', { className: 'ikw-itemName' }, item.name),
            item.id === current ? h('span', { className: 'ikw-itemCheck' }, h(CheckIcon)) : null,
          )),
        ) : null,
      );
    }

    // ------------------------------------------------------- settings CRUD pages
    // 行/卡片视觉契约沿用 DSH 设置行：16px 纵向内边距、.5px border-l2 分隔、
    // 标题 14/22、描述 12/18。
    function AgentForm({ initial, onSubmit, onCancel, t }) {
      const [name, setName] = React.useState(initial?.name || '');
      const [content, setContent] = React.useState(initial?.content || '');
      const submit = (event) => {
        event.preventDefault();
        if (!name.trim()) return;
        onSubmit({ id: initial?.id, name, content });
      };
      return h('form', { className: 'ikw-form', onSubmit: submit },
        h('label', { className: 'ikw-fieldLabel' }, t('name')),
        h('input', { className: 'ikw-input', value: name, placeholder: t('namePlaceholder'), onChange: (e) => setName(e.target.value) }),
        h('label', { className: 'ikw-fieldLabel' }, t('content')),
        h('textarea', { className: 'ikw-input ikw-textarea', value: content, placeholder: t('contentPlaceholder'), rows: 10, onChange: (e) => setContent(e.target.value) }),
        h('div', { className: 'ikw-formActions' },
          h('button', { type: 'submit', className: 'ikw-btn ikw-btnPrimary' }, t('save')),
          h('button', { type: 'button', className: 'ikw-btn ikw-btnGhost', onClick: onCancel }, t('cancel')),
        ),
      );
    }

    function AgentsSettingsPage(props) {
      const t = makeT(props?.ctx);
      const [presets, setPresets] = React.useState(null);
      const [editing, setEditing] = React.useState(null); // null | 'new' | preset
      const [error, setError] = React.useState('');

      const reload = React.useCallback(() => {
        api('/agents/presets').then((data) => setPresets(data.presets || [])).catch((e) => { setPresets([]); setError(String(e.message || e)); });
      }, []);
      React.useEffect(reload, [reload]);

      const save = async (draft) => {
        setError('');
        try {
          await api('/agents/presets', { method: 'PUT', body: JSON.stringify(draft) });
          setEditing(null);
          reload();
        } catch (e) { setError(String(e.message || e)); }
      };
      const remove = async (preset) => {
        setError('');
        if (!window.confirm(t('confirmDelete')(preset.name))) return;
        try {
          await api(`/agents/presets?id=${encodeURIComponent(preset.id)}`, { method: 'DELETE' });
          reload();
        } catch (e) { setError(String(e.message || e)); }
      };

      return h('div', { className: 'ikw-page' },
        h('div', { className: 'ikw-head' },
          h('div', null,
            h('h2', { className: 'ikw-title' }, `${t('title')} · AGENTS`),
            h('p', { className: 'ikw-desc' }, t('subtitle')),
          ),
          editing === null ? h('button', { type: 'button', className: 'ikw-btn ikw-btnPrimary', onClick: () => setEditing('new') }, `＋ ${t('addTitle')}`) : null,
        ),
        error ? h('div', { className: 'ikw-error' }, `${t('failed')}: ${error}`) : null,
        presets === null ? h('div', { className: 'ikw-hint' }, t('loading')) : null,
        presets !== null && !presets.length && editing === null
          ? h('div', { className: 'ikw-hint' }, t('none'))
          : null,
        editing === 'new' ? h(AgentForm, { onSubmit: save, onCancel: () => setEditing(null), t }) : null,
        (presets || []).length || (editing && editing !== 'new')
          ? h('div', { className: 'ikw-list' },
              (presets || []).map((preset) => editing && editing !== 'new' && editing.id === preset.id
                ? h(AgentForm, { key: preset.id, initial: preset, onSubmit: save, onCancel: () => setEditing(null), t })
                : h('div', { key: preset.id, className: 'ikw-row' },
                    h('div', { className: 'ikw-rowText' },
                      h('div', { className: 'ikw-rowTitle' }, preset.name),
                      h('div', { className: 'ikw-rowDesc', title: preset.content }, preset.content || '—'),
                    ),
                    h('div', { className: 'ikw-rowActions' },
                      h('button', { type: 'button', className: 'ikw-btn ikw-btnGhost', onClick: () => setEditing(preset) }, t('edit')),
                      h('button', { type: 'button', className: 'ikw-btn ikw-btnGhost ikw-btnDanger', onClick: () => remove(preset) }, t('delete')),
                    ),
                  )),
            )
          : null,
      );
    }

    function PromptForm({ initial, onSubmit, onCancel, t }) {
      const [name, setName] = React.useState(initial?.name || '');
      const [group, setGroup] = React.useState(initial?.group || '');
      const [content, setContent] = React.useState(initial?.content || '');
      const submit = (event) => {
        event.preventDefault();
        if (!name.trim()) return;
        onSubmit({ id: initial?.id, name, group, content });
      };
      return h('form', { className: 'ikw-form', onSubmit: submit },
        h('label', { className: 'ikw-fieldLabel' }, t('name')),
        h('input', { className: 'ikw-input', value: name, placeholder: t('promptNamePlaceholder'), onChange: (e) => setName(e.target.value) }),
        h('label', { className: 'ikw-fieldLabel' }, t('groupName')),
        h('input', { className: 'ikw-input', value: group, placeholder: t('groupPlaceholder'), onChange: (e) => setGroup(e.target.value) }),
        h('label', { className: 'ikw-fieldLabel' }, t('promptContent')),
        h('textarea', { className: 'ikw-input ikw-textarea', value: content, placeholder: t('promptContentPlaceholder'), rows: 8, onChange: (e) => setContent(e.target.value) }),
        h('div', { className: 'ikw-formActions' },
          h('button', { type: 'submit', className: 'ikw-btn ikw-btnPrimary' }, t('save')),
          h('button', { type: 'button', className: 'ikw-btn ikw-btnGhost', onClick: onCancel }, t('cancel')),
        ),
      );
    }

    // 按分组归并并保持稳定顺序：默认分组最先，其余按首次出现顺序。
    function groupPrompts(prompts) {
      const groups = [];
      const byGroup = new Map();
      for (const prompt of prompts) {
        const g = prompt.group || '默认';
        if (!byGroup.has(g)) { byGroup.set(g, []); groups.push(g); }
        byGroup.get(g).push(prompt);
      }
      groups.sort((a, b) => (a === '默认' ? -1 : b === '默认' ? 1 : a.localeCompare(b)));
      return groups.map((g) => ({ group: g, items: byGroup.get(g) }));
    }

    function PromptsSettingsPage(props) {
      const t = makeT(props?.ctx);
      const [prompts, setPrompts] = React.useState(null);
      const [editing, setEditing] = React.useState(null); // null | 'new' | prompt
      const [error, setError] = React.useState('');

      const reload = React.useCallback(() => {
        api('/prompts').then((data) => setPrompts(data.prompts || [])).catch((e) => { setPrompts([]); setError(String(e.message || e)); });
      }, []);
      React.useEffect(reload, [reload]);

      const save = async (draft) => {
        setError('');
        try {
          await api('/prompts', { method: 'PUT', body: JSON.stringify(draft) });
          setEditing(null);
          reload();
        } catch (e) {
          // 服务端重名校验返回 400 duplicate prompt name: xxx
          setError(String(e.message || '').includes('duplicate') ? t('dupName') : `${t('failed')}: ${e.message || e}`);
        }
      };
      const remove = async (prompt) => {
        setError('');
        if (!window.confirm(t('confirmDeletePrompt')(prompt.name))) return;
        try {
          await api(`/prompts?id=${encodeURIComponent(prompt.id)}`, { method: 'DELETE' });
          reload();
        } catch (e) { setError(String(e.message || e)); }
      };

      const grouped = groupPrompts(prompts || []);

      return h('div', { className: 'ikw-page' },
        h('div', { className: 'ikw-head' },
          h('div', null,
            h('h2', { className: 'ikw-title' }, `${t('title')} · Prompt`),
            h('p', { className: 'ikw-desc' }, t('promptsSubtitle')),
          ),
          editing === null ? h('button', { type: 'button', className: 'ikw-btn ikw-btnPrimary', onClick: () => setEditing('new') }, `＋ ${t('addPrompt')}`) : null,
        ),
        error ? h('div', { className: 'ikw-error' }, error) : null,
        prompts === null ? h('div', { className: 'ikw-hint' }, t('loading')) : null,
        prompts !== null && !prompts.length && editing === null
          ? h('div', { className: 'ikw-hint' }, t('promptsNone'))
          : null,
        editing === 'new' ? h(PromptForm, { onSubmit: save, onCancel: () => setEditing(null), t }) : null,
        (prompts || []).length || (editing && editing !== 'new')
          ? h('div', { className: 'ikw-list' },
              grouped.map(({ group, items }) => h('div', { key: group },
                h('div', { className: 'ikw-groupTitle' }, group),
                items.map((prompt) => editing && editing !== 'new' && editing.id === prompt.id
                  ? h(PromptForm, { key: prompt.id, initial: prompt, onSubmit: save, onCancel: () => setEditing(null), t })
                  : h('div', { key: prompt.id, className: 'ikw-row' },
                      h('div', { className: 'ikw-rowText' },
                        h('div', { className: 'ikw-rowTitle' }, `#${prompt.name}`),
                        h('div', { className: 'ikw-rowDesc', title: prompt.content }, prompt.content || '—'),
                      ),
                      h('div', { className: 'ikw-rowActions' },
                        h('button', { type: 'button', className: 'ikw-btn ikw-btnGhost', onClick: () => setEditing(prompt) }, t('edit')),
                        h('button', { type: 'button', className: 'ikw-btn ikw-btnGhost ikw-btnDanger', onClick: () => remove(prompt) }, t('delete')),
                      ),
                    )),
              )),
            )
          : null,
      );
    }

    // 设置页单一入口：侧栏只显示一个「注入工具箱」菜单项，页内用 Tab 切换
    // AGENTS 预设与 Prompt 管理两个子页面，避免侧栏菜单膨胀。
    function KitSettingsPage(props) {
      const t = makeT(props?.ctx);
      const [tab, setTab] = React.useState('agents');
      const tabs = [
        { key: 'agents', label: t('tabAgents') },
        { key: 'prompts', label: t('tabPrompts') },
      ];
      return h('div', { className: 'ikw-page' },
        h('div', { className: 'ikw-tabs' },
          tabs.map((item) =>
            h('button', {
              key: item.key,
              type: 'button',
              className: tab === item.key ? 'ikw-tab ikw-tabActive' : 'ikw-tab',
              onClick: () => setTab(item.key),
            }, item.label),
          ),
        ),
        tab === 'agents' ? h(AgentsSettingsPage, props) : h(PromptsSettingsPage, props),
      );
    }

    // ------------------------------------------------- 「#」输入下拉 + 气泡装饰
    // 输入框与气泡都不是本插件的 slot，必须走 DOM 事件委托。promptCache 是
    // PromptsSettingsPage 之外的第二份只读缓存，定期刷新保证下拉/装饰可见。
    function createDomKit() {
      let prompts = [];
      let refreshing = false;
      const refresh = async () => {
        if (refreshing) return;
        refreshing = true;
        try {
          const data = await api('/prompts');
          prompts = data.prompts || [];
        } catch { prompts = prompts; /* 保留旧缓存 */ } finally { refreshing = false; }
      };

      // ---- 下拉状态（单例：同一时刻只有一个输入框需要下拉）
      const menu = document.createElement('div');
      menu.className = 'ikw-refMenu';
      menu.style.display = 'none';
      let menuState = null; // {textarea, hashStart, caret, filter, items, active}
      let menuEls = [];

      const closeMenu = () => {
        menu.style.display = 'none';
        menuState = null;
        menuEls = [];
      };

      // 匹配输入框光标前的 `#过滤词`：# 前为行首/空白/标点，词内无空白与闭合标点。
      const REF_HEAD = /(^|[\s(\[{<"'\u201c\u300c\u3008,.;:!?\u3001\u3002\uff0c\uff1b\uff1a\uff01\uff1f\uff08])#([^\s#()\[\]{}<>"'\u201d\u300d\u3009,.;:!?\u3001\u3002\uff0c\uff1b\uff1a\uff01\uff1f]*)$/;

      function activeRef(el) {
        const t = textBeforeCaret(el);
        if (!t) return null;
        const m = REF_HEAD.exec(t.before);
        if (!m) return null;
        return { hashStart: t.caret - 1 - m[2].length, caret: t.caret, filter: m[2] };
      }

      // 取输入控件「光标前纯文本」：textarea 读 value；contenteditable（DSH 会话
      // 输入框是 Lexical contenteditable，不是 textarea）用 Selection 折叠拼接。
      function textBeforeCaret(el) {
        if (el instanceof HTMLTextAreaElement) {
          const caret = el.selectionStart ?? el.value.length;
          return { before: el.value.slice(0, caret), caret };
        }
        const sel = window.getSelection();
        if (!sel || !sel.rangeCount) return null;
        const range = sel.getRangeAt(0);
        const pre = range.cloneRange();
        pre.selectNodeContents(el);
        try { pre.setEnd(range.endContainer, range.endOffset); } catch { return null; }
        const before = pre.toString();
        return { before, caret: before.length };
      }

      // 测量光标【绝对页面坐标】：
      // textarea 用镜像 div 模拟换行取相对位置再加输入框 rect；
      // contenteditable 直接取 Selection 折叠 range 的 rect（空行/段首 rect 为零时
      // 退回 startContainer 所在元素 rect）。
      function caretCoords(el) {
        if (el instanceof HTMLTextAreaElement) {
          const mirror = document.createElement('div');
          const style = getComputedStyle(el);
          for (const prop of ['boxSizing', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight',
            'letterSpacing', 'textTransform', 'wordSpacing', 'textIndent', 'paddingTop',
            'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth',
            'borderBottomWidth', 'borderLeftWidth']) {
            mirror.style[prop] = style[prop];
          }
          mirror.style.position = 'absolute';
          mirror.style.visibility = 'hidden';
          mirror.style.whiteSpace = 'pre-wrap';
          mirror.style.wordWrap = 'break-word';
          mirror.style.width = `${el.clientWidth}px`;
          const before = el.value.slice(0, el.selectionStart ?? el.value.length);
          mirror.textContent = before;
          const marker = document.createElement('span');
          marker.textContent = '\u200b';
          mirror.appendChild(marker);
          document.body.appendChild(mirror);
          const top = marker.offsetTop + parseFloat(style.borderTopWidth || '0');
          const left = marker.offsetLeft + parseFloat(style.borderLeftWidth || '0');
          mirror.remove();
          const rect = el.getBoundingClientRect();
          return { top: rect.top + top, left: rect.left + left };
        }
        const sel = window.getSelection();
        if (sel && sel.rangeCount) {
          const rect = sel.getRangeAt(0).getBoundingClientRect();
          if (rect && (rect.top || rect.left)) return { top: rect.top, left: rect.left };
          const n = sel.getRangeAt(0).startContainer;
          const rn = n.nodeType === 1 ? n : n.parentElement;
          if (rn) {
            const r2 = rn.getBoundingClientRect();
            return { top: r2.top, left: r2.left };
          }
        }
        const rect = el.getBoundingClientRect();
        return { top: rect.top, left: rect.left };
      }

      function renderMenu() {
        if (!menuState) return;
        const { filter } = menuState;
        const kw = filter.toLowerCase();
        const all = prompts.filter((p) => !kw || p.name.toLowerCase().includes(kw));
        menu.innerHTML = '';
        menuEls = [];
        if (!all.length) {
          const empty = document.createElement('div');
          empty.className = 'ikw-refEmpty';
          empty.textContent = '—';
          menu.appendChild(empty);
          return;
        }
        let lastGroup = null;
        for (const prompt of all) {
          const g = prompt.group || '默认';
          if (g !== lastGroup) {
            const head = document.createElement('div');
            head.className = 'ikw-refGroup';
            head.textContent = g;
            menu.appendChild(head);
            lastGroup = g;
          }
          const item = document.createElement('div');
          item.className = 'ikw-refItem';
          const nameSpan = document.createElement('span');
          nameSpan.className = 'ikw-refName';
          nameSpan.textContent = `#${prompt.name}`;
          const preview = document.createElement('span');
          preview.className = 'ikw-refPreview';
          preview.textContent = String(prompt.content || '').split('\n')[0].slice(0, 40);
          item.appendChild(nameSpan);
          item.appendChild(preview);
          item.addEventListener('mousedown', (e) => e.preventDefault()); // 防止 textarea 失焦
          item.addEventListener('click', () => choose(prompt));
          menu.appendChild(item);
          menuEls.push({ el: item, prompt });
        }
        setActive(0);
      }

      function setActive(index) {
        if (!menuState) return;
        const count = menuEls.length;
        if (!count) return;
        menuState.active = ((index % count) + count) % count;
        menuEls.forEach((entry, i) => {
          entry.el.classList.toggle('ikw-refActive', i === menuState.active);
          if (i === menuState.active) entry.el.scrollIntoView({ block: 'nearest' });
        });
      }

      // 选中：把「#过滤词」原位替换为「#Prompt名称␠」，光标落在名称之后。
      function choose(prompt) {
        const st = menuState;
        if (!st) return;
        const { textarea } = st;
        const replacement = `#${prompt.name} `;
        if (textarea instanceof HTMLTextAreaElement) {
          const value = textarea.value;
          const next = value.slice(0, st.hashStart) + replacement + value.slice(st.caret);
          const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
          if (setter) setter.call(textarea, next); else textarea.value = next;
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
          const caret = st.hashStart + replacement.length;
          textarea.setSelectionRange(caret, caret);
          textarea.focus();
        } else {
          // contenteditable（Lexical）：定位 #过滤词 的 DOM 区间并用 Selection 选中，
          // 再走 execCommand('insertText')——它会派发 beforeinput，Lexical 能同步内部模型；
          // 直接改 DOM 会被 Lexical 的协调器覆盖。
          const pos = locateOffsets(textarea, st.hashStart, st.caret);
          const sel = window.getSelection();
          if (!pos || !sel) { closeMenu(); return; }
          const range = document.createRange();
          range.setStart(pos.startNode, pos.startOffset);
          range.setEnd(pos.endNode, pos.endOffset);
          sel.removeAllRanges();
          sel.addRange(range);
          document.execCommand('insertText', false, replacement);
        }
        closeMenu();
      }

      // 把「文本累计偏移区间」映射到 contenteditable 内的文本节点/偏移对。
      function locateOffsets(root, start, end) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let acc = 0;
        let s = null;
        let e = null;
        while (walker.nextNode()) {
          const n = walker.currentNode;
          const len = n.nodeValue.length;
          if (!s && acc + len >= start) s = { node: n, offset: start - acc };
          if (acc + len >= end) { e = { node: n, offset: end - acc }; break; }
          acc += len;
        }
        return s && e ? { startNode: s.node, startOffset: s.offset, endNode: e.node, endOffset: e.offset } : null;
      }

      function positionMenu(el) {
        // caretCoords 现在直接返回绝对页面坐标（textarea 与 contenteditable 统一）
        const { top: absTop, left: absLeft } = caretCoords(el);
        menu.style.visibility = 'hidden';
        menu.style.display = 'block';
        const mw = menu.offsetWidth;
        const mh = menu.offsetHeight;
        // 输入框在页面底部：优先向上展开，空间不足再向下
        let y = absTop - mh - 6;
        if (y < 8) y = absTop + 22;
        const x = Math.min(absLeft, window.innerWidth - mw - 8);
        menu.style.left = `${Math.max(8, x)}px`;
        menu.style.top = `${Math.max(8, y)}px`;
        menu.style.visibility = 'visible';
      }

      function openMenu(textarea) {
        const ref = activeRef(textarea);
        if (!ref) { closeMenu(); return; }
        menuState = { textarea, hashStart: ref.hashStart, caret: ref.caret, filter: ref.filter, active: 0 };
        renderMenu();
        if (!prompts.length) { closeMenu(); return; }
        positionMenu(textarea);
      }

      // 输入事件（捕获）：textarea 或 contenteditable（DSH 会话输入框为 Lexical
      // contenteditable）中出现 `#` 上下文即打开/刷新下拉。
      const onInput = (event) => {
        const el = event.target;
        const isArea = el instanceof HTMLTextAreaElement && !el.readOnly && !el.disabled;
        const isCE = el.nodeType === 1 && el.isContentEditable;
        if (!isArea && !isCE) return;
        // 排除设置页等非输入框场景：只在可见的会话输入框（rect 有面积且非 ikw 管理元素）
        if (el.closest('.ikw-page') || el.classList?.contains('ikw-input')) return;
        if (activeRef(el)) openMenu(el); else closeMenu();
      };

      // 键盘（捕获，keydown）：拦截下拉激活时的导航/确认键，阻止 DSH 把 Enter 当发送。
      const onKeyDown = (event) => {
        if (!menuState || menu.style.display === 'none') return;
        const el = event.target;
        if (el !== menuState.textarea) return;
        const hasItems = menuEls.length > 0;
        switch (event.key) {
          case 'ArrowDown':
            if (hasItems) { event.preventDefault(); event.stopPropagation(); setActive(menuState.active + 1); }
            break;
          case 'ArrowUp':
            if (hasItems) { event.preventDefault(); event.stopPropagation(); setActive(menuState.active - 1); }
            break;
          case 'Enter':
          case 'Tab':
            if (hasItems && menuEls[menuState.active]) {
              event.preventDefault(); event.stopPropagation();
              choose(menuEls[menuState.active].prompt);
            }
            break;
          case 'Escape':
            event.preventDefault(); event.stopPropagation();
            closeMenu();
            break;
          default:
            break;
        }
      };

      const onDocDown = (event) => {
        if (menu.style.display !== 'none' && !menu.contains(event.target)) closeMenu();
      };
      const onFocusOut = (event) => {
        if (!menuState) return;
        // 焦点离开输入框且新焦点不在菜单内时关闭（mousedown 已被 preventDefault）
        setTimeout(() => {
          if (!menuState) return;
          const active = document.activeElement;
          if (active !== menuState.textarea && !menu.contains(active)) closeMenu();
        }, 0);
      };

      // ---- 气泡 chip 装饰
      // 匹配消息文本中的 `#名称`（与 Host 端 REF_PATTERN 同规则）。
      const BUBBLE_REF = /#([^\s#()\[\]{}<>"'\u201d\u300d\u3009,.;:!?\u3001\u3002\uff0c\uff1b\uff1a\uff01\uff1f]{1,64})/g;
      // 名称→内容 映射（装饰时悬停提示取内容；Map 同时提供 has/get）
      const knownNames = () => new Map(prompts.map((p) => [p.name, p.content]));

      function decorateNode(node) {
        const parent = node.parentElement;
        if (!parent) return;
        if (parent.closest('.ikw-chip, textarea, [contenteditable="true"], script, style, .ikw-refMenu')) return;
        // 只装饰疑似消息气泡的容器，避免污染设置页等区域
        const bubble = parent.closest('[class*="message"], [class*="Message"], [class*="bubble"]');
        if (!bubble) return;
        if (bubble.closest('[class*="settings"], [class*="Settings"]')) return;
        const text = node.nodeValue;
        if (!text || !text.includes('#')) return;
        const names = knownNames();
        BUBBLE_REF.lastIndex = 0;
        let match = BUBBLE_REF.exec(text);
        if (!match) return;
        const frag = document.createDocumentFragment();
        let cursor = 0;
        while (match) {
          const start = match.index;
          const title = match[1];
          const end = start + match[0].length;
          if (start > cursor) frag.appendChild(document.createTextNode(text.slice(cursor, start)));
          const chip = document.createElement('span');
          chip.className = names.has(title) ? 'ikw-chip' : 'ikw-chip ikw-chipMissing';
          chip.textContent = `#${title}`;
          const snapshot = names.get(title); // Map 值即 Prompt 内容字符串
          if (snapshot !== undefined) chip.title = String(snapshot).slice(0, 200);
          else chip.title = t0('missingChip');
          frag.appendChild(chip);
          cursor = end;
          match = BUBBLE_REF.exec(text);
        }
        if (cursor < text.length) frag.appendChild(document.createTextNode(text.slice(cursor)));
        node.replaceWith(frag);
      }

      let t0 = () => ''; // 延迟绑定的 i18n，装饰循环里不可直接拿 ctx

      function walk(root) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
          acceptNode: (n) => (n.nodeValue && n.nodeValue.includes('#') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
        });
        const nodes = [];
        while (walker.nextNode()) nodes.push(walker.currentNode);
        for (const node of nodes) decorateNode(node);
      }

      let mutating = false;
      const observer = new MutationObserver((mutations) => {
        if (mutating) return;
        mutating = true;
        try {
          for (const m of mutations) {
            for (const node of m.addedNodes) {
              if (node.nodeType === 3) decorateNode(node);
              else if (node.nodeType === 1 && !(node.classList?.contains('ikw-chip') || node.classList?.contains('ikw-refMenu'))) walk(node);
            }
            if (m.type === 'characterData' && m.target.nodeType === 3) decorateNode(m.target);
          }
        } finally { mutating = false; }
      });

      const startObservers = () => {
        refresh();
        const timer = setInterval(refresh, 8000); // 低频刷新：下拉/装饰用缓存
        document.addEventListener('input', onInput, true);
        document.addEventListener('keydown', onKeyDown, true);
        document.addEventListener('mousedown', onDocDown, true);
        document.addEventListener('focusout', onFocusOut, true);
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
        return () => {
          clearInterval(timer);
          document.removeEventListener('input', onInput, true);
          document.removeEventListener('keydown', onKeyDown, true);
          document.removeEventListener('mousedown', onDocDown, true);
          document.removeEventListener('focusout', onFocusOut, true);
          observer.disconnect();
          closeMenu();
          menu.remove();
        };
      };

      return { startObservers, setT: (fn) => { t0 = fn; }, menu };
    }

    // -------------------------------------------------------------------- apply
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-inject-kit: dictionaries');
      ctx.effect(() => {
        if (!ctx.slots) return;
        try {
          ctx.slots.inject('conversation.input.right', () =>
            ctx.slots.register(
              { name: 'conversation.input.right', id: 'dsh-inject-kit-selector', order: 40, locale: NS, inject: () => ({ ctx }) },
              SessionSelector,
            ));
        } catch (error) { console.error('[dsh-inject-kit] selector seat unavailable', error); }
        try {
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              { name: 'settings.section', id: 'dsh-inject-kit', order: 30, label: zh.sectionLabel, locale: NS, inject: () => ({ ctx }) },
              KitSettingsPage,
            ));
        } catch (error) { console.error('[dsh-inject-kit] settings seat unavailable', error); }
      }, 'dsh-inject-kit: slots');

      // `#` 下拉与气泡 chip：命令式 DOM 层，与 React slot 互不干扰。
      ctx.effect(() => {
        if (typeof document === 'undefined') return;
        const domKit = createDomKit();
        domKit.setT(makeT(ctx));
        document.body.appendChild(domKit.menu);
        return domKit.startObservers();
      }, 'dsh-inject-kit: dom-kit');

      // 作用域样式，仅使用 --dsw-alias 令牌。触发器度量沿用原生权限选择器
      // （28px、13px/500、label-secondary、旋转箭头）。
      ctx.effect(() => {
        if (typeof document === 'undefined') return;
        const style = document.createElement('style');
        style.id = 'dsh-inject-kit-styles';
        style.textContent = `
.ikw-sel { position: relative; display: inline-flex; max-width: 260px; }

.ikw-trig {
  border-radius: var(--dsw-radius-sm); min-width: 0; max-width: 260px; height: 28px;
  color: var(--dsw-alias-label-secondary); cursor: pointer; background: 0 0; border: none;
  outline: none; align-items: center; gap: 4px; padding: 0 4px 0 8px;
  font-size: 13px; font-weight: 500; line-height: 20px; display: inline-flex; font-family: inherit;
}
.ikw-trig:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.ikw-trig:focus-visible { box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); }
.ikw-trig:disabled { color: var(--dsw-alias-label-dimmed); cursor: default; }
.ikw-trigIcon { flex: none; display: inline-flex; }
.ikw-trigIcon svg { width: 14px; height: 14px; }
.ikw-trigLabel { text-overflow: ellipsis; white-space: nowrap; min-width: 0; overflow: hidden; }
.ikw-chev { color: var(--dsw-alias-label-caption); flex: none; transition: transform .12s; display: inline-flex; }
.ikw-chev svg { width: 14px; height: 14px; }
.ikw-chevOpen { transform: rotate(180deg); }

.ikw-menu {
  position: absolute; bottom: calc(100% + 6px); right: 0; z-index: 1000;
  min-width: 180px; max-width: 300px; max-height: 320px; overflow-y: auto;
  background: var(--dsw-alias-bg-primary); color: var(--dsw-alias-label-primary);
  border: .5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md);
  box-shadow: 0 8px 24px rgba(0, 0, 0, .14); padding: 4px;
}
.ikw-item {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 6px 10px; border-radius: var(--dsw-radius-sm);
  font-size: 13px; line-height: 20px; cursor: pointer; min-width: 0;
}
.ikw-item:hover { background: var(--dsw-alias-interactive-bg-hover); }
.ikw-itemName { text-overflow: ellipsis; white-space: nowrap; min-width: 0; overflow: hidden; }
.ikw-itemActive { color: var(--dsw-alias-state-business-primary); font-weight: 500; }
.ikw-itemCheck { flex: none; display: inline-flex; }

.ikw-page { display: flex; flex-direction: column; gap: 12px; max-width: 760px; margin-top: 8px; }
.ikw-tabs { display: flex; gap: 20px; border-bottom: .5px solid var(--dsw-alias-border-l2); margin-bottom: 2px; }
.ikw-tab { position: relative; border: none; background: transparent; padding: 8px 2px 10px; font-size: 14px; font-weight: 500; color: var(--dsw-alias-label-secondary); cursor: pointer; transition: color 0.15s ease; }
.ikw-tab::after { content: ''; position: absolute; left: 0; right: 0; bottom: -1px; height: 2px; border-radius: 2px; background: transparent; transition: background 0.15s ease; }
.ikw-tab:hover { color: var(--dsw-alias-label-primary); }
.ikw-tabActive { color: var(--dsw-alias-label-primary); font-weight: 600; }
.ikw-tabActive::after { background: var(--dsw-alias-state-business-primary); }
.ikw-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.ikw-title { margin: 0 0 4px; font-size: 16px; font-weight: 600; line-height: 24px; color: var(--dsw-alias-label-primary); }
.ikw-desc { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.ikw-hint { font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.ikw-error { font-size: 12px; color: var(--dsw-alias-state-error-primary); }
.ikw-groupTitle {
  font-size: 12px; line-height: 20px; color: var(--dsw-alias-label-caption);
  padding: 10px 0 2px; font-weight: 500;
}

.ikw-list { display: flex; flex-direction: column; }
.ikw-row {
  display: flex; align-items: center; gap: 8px; padding: 16px 0;
  border-bottom: .5px solid var(--dsw-alias-border-l2);
}
.ikw-rowText { display: flex; flex-direction: column; flex: 1; gap: 4px; min-width: 0; padding-right: 24px; }
.ikw-rowTitle { font-size: 14px; font-weight: 400; line-height: 22px; color: var(--dsw-alias-label-primary); }
.ikw-rowDesc {
  font-size: 12px; font-weight: 400; line-height: 18px; color: var(--dsw-alias-label-tertiary);
  font-family: ui-monospace, monospace;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.ikw-rowActions { display: flex; gap: 8px; flex: none; }

.ikw-form { display: flex; flex-direction: column; gap: 8px; padding: 12px 14px; margin-top: 4px;
  background: var(--dsw-alias-bg-module-platform); border-radius: var(--dsw-radius-md); }
.ikw-fieldLabel { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.ikw-input {
  height: 36px; padding: 0 12px; font: inherit; font-size: 13px; color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-primary); border: .5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-sm); outline: none; min-width: 0; box-sizing: border-box;
}
.ikw-textarea { height: auto; min-height: 120px; padding: 10px 12px;
  font-family: ui-monospace, monospace; font-size: 12px; line-height: 1.6; resize: vertical; }
.ikw-input:focus-visible { box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); }
.ikw-formActions { display: flex; gap: 8px; margin-top: 4px; }

.ikw-btn {
  height: 32px; padding: 0 14px; font-size: 13px; line-height: 20px; font-family: inherit;
  white-space: nowrap; flex: none;
  cursor: pointer; display: inline-flex; align-items: center; gap: 6px;
  color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-module-platform);
  border: .5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm);
}
.ikw-btn:hover { background: var(--dsw-alias-interactive-bg-hover); }
.ikw-btn:focus-visible { box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline: none; }
.ikw-btnPrimary { color: var(--dsw-alias-label-brightest, #fff); background: var(--dsw-alias-state-business-primary); border-color: transparent; }
.ikw-btnPrimary:hover { filter: brightness(1.08); background: var(--dsw-alias-state-business-primary); }
.ikw-btnGhost { background: transparent; border-color: transparent; color: var(--dsw-alias-label-secondary); }
.ikw-btnGhost:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.ikw-btnDanger { color: var(--dsw-alias-state-error-primary); }

/* 「#」引用下拉（fixed 定位，挂在 body 下） */
.ikw-refMenu {
  position: fixed; z-index: 1200; display: none; min-width: 200px; max-width: 340px;
  max-height: 280px; overflow-y: auto; padding: 4px;
  background: var(--dsw-alias-bg-primary); color: var(--dsw-alias-label-primary);
  border: .5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md);
  box-shadow: 0 8px 24px rgba(0, 0, 0, .14);
}
.ikw-refGroup {
  font-size: 11px; line-height: 18px; color: var(--dsw-alias-label-caption);
  padding: 6px 10px 2px; font-weight: 500;
}
.ikw-refItem {
  display: flex; align-items: baseline; justify-content: space-between; gap: 12px;
  padding: 6px 10px; border-radius: var(--dsw-radius-sm);
  font-size: 13px; line-height: 20px; cursor: pointer;
}
.ikw-refItem:hover, .ikw-refActive { background: var(--dsw-alias-interactive-bg-hover); }
.ikw-refName { flex: none; font-weight: 500; }
.ikw-refPreview {
  font-size: 11px; line-height: 18px; color: var(--dsw-alias-label-tertiary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0;
}
.ikw-refEmpty { padding: 8px 10px; font-size: 12px; color: var(--dsw-alias-label-tertiary); }

/* 用户消息气泡中的 #引用 chip（引用样式；缺失置灰） */
.ikw-chip {
  display: inline-block; margin: 0 1px; padding: 0 6px; border-radius: 6px;
  font-size: .92em; line-height: 1.5; vertical-align: baseline;
  color: var(--dsw-alias-state-business-primary);
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent);
  border: .5px solid color-mix(in srgb, var(--dsw-alias-state-business-primary) 35%, transparent);
  cursor: default;
}
.ikw-chipMissing { color: var(--dsw-alias-label-dimmed); background: transparent;
  border-color: var(--dsw-alias-border-l2); text-decoration: line-through; }
`;
        document.head.appendChild(style);
        return () => style.remove();
      }, 'dsh-inject-kit: styles');
    }

    module.exports = { apply, inject: ['slots', 'locale'] };
    return module.exports;
  },
});
