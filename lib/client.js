// dsh-inject-kit — 注入工具箱（Client 端 Web UI）。
// - Settings 页两个区块（settings.section slot）：
//   · AGENTS 切换器：全局 AGENTS 预设库 CRUD（沿用原 dsh-agents-switcher 语义）；
//   · Prompt 管理：Prompt 库增删改查（名称/分组/内容，默认分组「默认」）。
// - Composer 工具栏（conversation.input.right slot）：按会话 AGENTS 选择器（沿用）。
// - 输入框 `#` 触发下拉：DOM 事件委托 + 镜像 div 计算光标坐标，
//   ↑↓ 键盘导航、Enter/Tab/点击选择、Esc/失焦关闭、按名称输入过滤、分组标题。
//   选中后输入框仅显示「#Prompt名称」（引用样式由气泡装饰渲染）。
// - 气泡 chip 装饰：走 DSH 原生 userText 管道——注册 uiConversation.userText
//   匹配规则（识别完整 Prompt 内容或 `#名称`）+ conversation.user.text.node
//   渲染器（显示 `#名称` chip，悬停提示内容）。渲染由 React 管道接管，
//   随消息重渲染天然稳定。注意：Host 端在 pre-step 完成替换且 DSH 会把
//   接纳的消息批次同步落库（所见即所发），chip 只是显示层的反查呈现，
//   消息数据不变。
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
      confirmDeletePrompt: (name) => `Delete prompt "${name}"? Sent messages already show the resolved content and are unaffected; future #${name} references will be sent as-is.`,
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
      confirmDeletePrompt: (name) => `删除 Prompt"${name}"？已发出的消息显示的是发送时替换后的内容，不受删除影响；此后再发送 #${name} 将不再替换，原样发出。`,
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

    // 行内代码区间判定：与 Host 端 lib/refs.js 的 inlineCodeSpans 保持同一规则
    // （反引号串两两配对，奇数段为代码区），`#` 落在代码区内不触发下拉/不渲染
    // chip。说明：与 Host 端是两份实现——client bundle 无法 require Host 模块；
    // 规则若调整需两边同步。
    function inlineCodeSpans(text) {
      const spans = [];
      const re = /`+/g;
      let m;
      let inCode = false;
      let start = 0;
      while ((m = re.exec(text))) {
        if (!inCode) { start = m.index; inCode = true; }
        else { spans.push([start, m.index + m[0].length]); inCode = false; }
      }
      if (inCode) spans.push([start, text.length]);
      return spans;
    }
    const insideInlineCode = (text, index) =>
      inlineCodeSpans(text).some(([s, e]) => index > s && index < e);

    function createDomKit() {
      let prompts = [];
      let refreshing = false;
      const refresh = async () => {
        if (refreshing) return;
        refreshing = true;
        try {
          const data = await api('/prompts');
          prompts = data.prompts || [];
        } catch { /* 刷新失败保留旧缓存，下拉仍可用 */ } finally { refreshing = false; }
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

      // 匹配输入框光标前的 `#过滤词`：# 前为行首/空白/标点（含反引号，与
      // Host 端 REF_PATTERN 同规则），词内无空白与闭合标点。
      const REF_HEAD = /(^|[\s`(\[{<"'\u201c\u300c\u3008,.;:!?\u3001\u3002\uff0c\uff1b\uff1a\uff01\uff1f\uff08])#([^\s#()\[\]{}<>"'\u201d\u300d\u3009,.;:!?\u3001\u3002\uff0c\uff1b\uff1a\uff01\uff1f]*)$/;

      function activeRef(el) {
        const t = textBeforeCaret(el);
        if (!t) return null;
        const m = REF_HEAD.exec(t.before);
        if (!m) return null;
        // `#` 处于行内代码（反引号包裹）中：不触发，避免 `#示例` 被当成引用
        if (insideInlineCode(t.before, t.caret - 1 - m[2].length)) return null;
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
      // 插入刻意延迟到宏任务：在 click/keydown 的同步分发栈里改 Selection，
      // Lexical 的 selectionchange 协调会在下一拍按内部旧模型重建 DOM，把插入
      // 内容原样抹掉（表现为名称闪现后立刻消失）。挪出分发栈后协调已 settled，
      // execCommand 触发的 beforeinput 更新能落在稳定状态上。
      function choose(prompt) {
        const st = menuState;
        if (!st) return;
        closeMenu(); // 先关菜单：插入会触发 input，避免求值路径与菜单状态纠缠
        setTimeout(() => insertReplacement(st.textarea, prompt, 0), 0);
      }

      // 把「#过滤词」原位替换为「#Prompt名称␠」，带一次回滚重试。
      function insertReplacement(el, prompt, attempt) {
        const replacement = `#${prompt.name} `;
        if (el instanceof HTMLTextAreaElement) {
          // textarea 分支是兜底（DSH 输入框为 Lexical）：textarea 无协调器，
          // 同步拼接即可。
          const ref = activeRef(el);
          if (!ref) return;
          const value = el.value;
          const next = value.slice(0, ref.hashStart) + replacement + value.slice(ref.caret);
          const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
          if (setter) setter.call(el, next); else el.value = next;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          const caret = ref.hashStart + replacement.length;
          el.setSelectionRange(caret, caret);
          el.focus();
          return;
        }
        // contenteditable（Lexical）：编辑器可能在菜单期被重建，逐层重新解析——
        // 节点失效则回落到当前持焦的编辑器；始终按当前 DOM 重定位 #过滤词。
        if (!el.isConnected) {
          const active = document.activeElement;
          if (active && active.isContentEditable) el = active;
        }
        el.focus?.();
        let ref = activeRef(el);
        if (!ref) {
          // 选区失效退化路径：Lexical 在空编辑器首字符输入后会重建文本节点，
          // window.getSelection 短暂仍指向旧节点，基于选区的 activeRef 拿不到
          // 上下文。此时不放弃，改按 textContent 定位行首的 `#过滤词`——
          // textContent 是当帧真实内容，不受选区迁移影响。
          const text = el.textContent || '';
          const m = /^#([^\s]*)/.exec(text);
          if (!m) return; // 行首没有 #：确实无上下文（已填充或已改写）
          ref = { hashStart: 0, caret: 1 + m[1].length, filter: m[1] };
        }
        const sel = window.getSelection();
        const pos = locateOffsets(el, ref.hashStart, ref.caret);
        if (!sel || !pos) return;
        const range = document.createRange();
        range.setStart(pos.startNode, pos.startOffset);
        range.setEnd(pos.endNode, pos.endOffset);
        // 两阶段插入。为什么不能 addRange 后同拍 execCommand：Lexical 处理
        // beforeinput 时读取的是它【内部模型】维护的选区，模型选区只在
        // selectionchange 事件里从 DOM 回读同步——而 selectionchange 是异步派发
        // 的。同拍执行时模型选区仍是旧值（首字符场景两者恰好不一致），Lexical
        // 会对着错误选区做插入 → 无声丢弃（execCommand 仍返回 true）。实测埋点
        // 证实：ok=true 但 textContent 不变。因此：先 addRange，等 selectionchange
        // 触发（Lexical 已完成模型同步）后再插入。
        let fired = false;
        const doInsert = () => {
          if (fired) return;
          fired = true;
          document.removeEventListener('selectionchange', onSelectionChange);
          if (!el.isConnected) return;
          // DOM 选区可能在等待期间被外部复位，插入前重新对准 # 过滤词
          const r2 = activeRef(el);
          const p2 = r2 ? locateOffsets(el, r2.hashStart, r2.caret) : locateOffsets(el, ref.hashStart, ref.caret);
          if (!p2) return;
          const rg = document.createRange();
          rg.setStart(p2.startNode, p2.startOffset);
          rg.setEnd(p2.endNode, p2.endOffset);
          sel.removeAllRanges();
          sel.addRange(rg);
          try { document.execCommand('insertText', false, replacement); } catch { /* 忽略 */ }
          // 校验：未生效且行首仍有未填充的 #（内部含 textContent 退化判定）时，
          // 等协调 settled 后重试一次；再失败则放弃（避免无限循环）。
          setTimeout(() => {
            const done = (el.textContent || '').includes(prompt.name);
            if (done) return;
            if (attempt < 1 && el.isConnected) {
              insertReplacement(el, prompt, attempt + 1);
            }
          }, 80);
        };
        const onSelectionChange = () => {
          // 下一拍执行：确保本次 selectionchange 已被 Lexical 的监听消化完毕
          setTimeout(doInsert, 0);
        };
        document.addEventListener('selectionchange', onSelectionChange);
        sel.removeAllRanges();
        sel.addRange(range);
        // 兜底：个别环境 selectionchange 不派发（如选区未变化）也要插入
        setTimeout(doInsert, 50);
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
      // 求值统一延迟到宏任务：Lexical 在空编辑器首次输入时会重建文本节点，
      // 同步 input 事件里 getSelection 仍指向旧节点（before 为空字符串），
      // 导致第一个字符是 `#` 时永远不触发下拉；延迟一拍后 DOM 与选区已稳定。
      // 单一定时器而非按元素分槽是刻意选择：回调里会校验 activeElement === el，
      // 焦点已切走的元素本来就不应弹菜单，被新元素的调度顶掉即等价于取消，
      // 分槽只会保留无意义的过期求值。
      let checkTimer = 0;
      const scheduleCheck = (el) => {
        clearTimeout(checkTimer);
        checkTimer = setTimeout(() => {
          // 元素已移除或焦点已离开：不做任何事，交给 focusout/其他事件收尾
          if (!el.isConnected) return;
          const active = document.activeElement;
          if (active !== el && !(el.contains(active) && el.isContentEditable)) return;
          if (activeRef(el)) openMenu(el); else closeMenu();
        }, 0);
      };

      const onInput = (event) => {
        const el = event.target;
        const isArea = el instanceof HTMLTextAreaElement && !el.readOnly && !el.disabled;
        const isCE = el.nodeType === 1 && el.isContentEditable;
        if (!isArea && !isCE) return;
        // 排除设置页等非输入框场景：只在可见的会话输入框（rect 有面积且非 ikw 管理元素）
        if (el.closest('.ikw-page') || el.classList?.contains('ikw-input')) return;
        scheduleCheck(el);
      };

      // keyup（捕获）兜底：个别编辑器路径不派发标准 input 事件（如首次字符被
      // Lexical 拦截重建），keyup 后选区已稳定，补一次求值。
      // 菜单激活时的导航/确认/关闭键不参与，避免覆盖 keydown 拦截或把 Esc 关闭又打开。
      const MENU_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape']);
      const onKeyUp = (event) => {
        if (MENU_KEYS.has(event.key)) return;
        const el = event.target;
        const isArea = el instanceof HTMLTextAreaElement && !el.readOnly && !el.disabled;
        const isCE = el.nodeType === 1 && el.isContentEditable;
        if (!isArea && !isCE) return;
        if (el.closest('.ikw-page') || el.classList?.contains('ikw-input')) return;
        scheduleCheck(el);
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


      // 低频刷新 Prompt 缓存（下拉数据源）；气泡 `#名称`/内容反查装饰已迁移到
      // DSH 原生 userText 管道（见 apply 中的注册），此处只保留下拉相关监听。
      const startObservers = () => {
        refresh();
        const timer = setInterval(refresh, 8000);
        document.addEventListener('input', onInput, true);
        document.addEventListener('keyup', onKeyUp, true);
        document.addEventListener('keydown', onKeyDown, true);
        document.addEventListener('mousedown', onDocDown, true);
        document.addEventListener('focusout', onFocusOut, true);
        return () => {
          clearInterval(timer);
          clearTimeout(checkTimer);
          document.removeEventListener('input', onInput, true);
          document.removeEventListener('keyup', onKeyUp, true);
          document.removeEventListener('keydown', onKeyDown, true);
          document.removeEventListener('mousedown', onDocDown, true);
          document.removeEventListener('focusout', onFocusOut, true);
          closeMenu();
          menu.remove();
        };
      };

      // domKit 持有 Prompt 缓存（下拉与 userText 规则共用同一份数据源）
      return { startObservers, menu, getPrompts: () => prompts };
    }

    // -------------------------------------------------------------------- apply
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-inject-kit: dictionaries');
      let domKit = null; // dom-kit 就绪后供 userText 规则读取 Prompt 缓存
      ctx.effect(() => {
        if (typeof document === 'undefined') return;
        const kit = createDomKit();
        domKit = kit;
        document.body.appendChild(kit.menu);
        const dispose = kit.startObservers();
        // 清理时同步置空 domKit：注销后 kit 的监听与菜单均已销毁，残留引用会让
        // userText 规则继续读失效缓存（且阻碍 kit 被回收）。
        return () => {
          dispose?.();
          if (domKit === kit) domKit = null;
        };
      }, 'dsh-inject-kit: dom-kit');
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

      // 气泡 `#名称` / Prompt 内容 → `#名称` chip：走 DSH 原生 userText 管道。
      // 注册一条匹配规则（候选由调度器按位置切分文本）+ 一个按 key 命中的
      // React 渲染器。渲染完全由 React 管道接管，随消息重渲染天然稳定，
      // 不存在 DOM 反查时代的闪烁问题。
      const PROMPT_REF_RULE_ID = 'inject-kit-prompt-ref';
      ctx.effect(() => {
        // userText 服务要求在 inject 中声明 'uiConversation'（见文件尾 exports）；
        // 整体 try/catch 兜底：装饰是增强功能，任何注册异常都不允许拖垮激活。
        try {
          const userText = ctx.uiConversation?.userText;
          if (!userText) { console.warn('[dsh-inject-kit] uiConversation.userText unavailable, chip decoration disabled'); return; }
          userText.register({
            id: PROMPT_REF_RULE_ID,
            order: 20,
            match(text, from) {
              // Prompt 库缓存由 dom-kit 维护（下拉与规则共用一份数据源）
              const list = domKit?.getPrompts?.() ?? [];
              // 行内代码内的 `#名称` 不渲染 chip（与 Host 端替换、下拉触发
              // 同一规则）：反引号包裹的引用是「禁用」语义
              const codeSpans = inlineCodeSpans(text);
              const inCode = (index) => codeSpans.some(([s, e]) => index > s && index < e);
              let best = null; // 调度器要求返回起点最早的候选
              for (const p of list) {
                // ① 内容反查：消息文本包含完整 Prompt 内容（≥12 字符防误命中）
                if (p.content && p.content.length >= 12) {
                  const idx = text.indexOf(p.content, from);
                  if (idx >= 0 && (!best || idx < best.start)) {
                    best = { id: PROMPT_REF_RULE_ID, start: idx, end: idx + p.content.length, data: { name: p.name, content: p.content } };
                  }
                }
                // ② 名称引用：`#名称` 且名称在库中；同位置时上面的长内容优先
                for (let idx = text.indexOf(`#${p.name}`, from); idx >= 0; idx = text.indexOf(`#${p.name}`, idx + 1)) {
                  if (best && idx >= best.start) break;
                  if (inCode(idx)) continue; // 反引号包裹：禁用语义，跳过
                  const end = idx + p.name.length + 1;
                  best = { id: PROMPT_REF_RULE_ID, start: idx, end, data: { name: p.name, content: p.content } };
                  break; // 该名称取最早一次出现即可
                }
              }
              return best ?? undefined;
            },
          });
        } catch (error) {
          console.error('[dsh-inject-kit] userText rule registration failed', error);
        }
      }, 'dsh-inject-kit: userText rule');

      ctx.effect(() => {
        if (!ctx.slots) return;
        try {
          ctx.slots.inject('conversation.user.text.node', () =>
            ctx.slots.register(
              { name: 'conversation.user.text.node', key: PROMPT_REF_RULE_ID, priority: 100 },
              // node.data 由上面的 match 提供；raw 是原始片段
              function PromptRefChip({ node }) {
                return h('span', { className: 'ikw-chip', title: String(node.data?.content ?? '').slice(0, 200) }, `#${node.data?.name ?? ''}`);
              },
            ));
        } catch (error) { console.error('[dsh-inject-kit] user-text node seat unavailable', error); }
      }, 'dsh-inject-kit: userText node renderer');

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

    module.exports = { apply, inject: ['slots', 'locale', 'uiConversation'] };
    return module.exports;
  },
});
