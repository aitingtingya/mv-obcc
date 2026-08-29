// Native DSH plugin-settings card and browser-side feature policy for mv-agent.

window.__ModuleLoader__.load({
  id: '@mv-aide/mv-agent/settings-client',
  factory: (require) => {
    const module = { exports: {} };
    const React = require('react');
    const NS = 'mv-agent';
    const DEFAULTS = Object.freeze({
      bridgeEnabled: true,
      ideToolsEnabled: true,
      terminalToolsEnabled: true,
      diffReviewEnabled: true,
      slashCommandEnabled: true,
      autoEnterVaultWorkspaceEnabled: true,
      selectionContextEnabled: true,
      mentionSteeringEnabled: true,
      selectionMaxChars: 6000,
      selectionDebounceMs: 400,
      hoverSidebarEnabled: true,
      imageAutoFitEnabled: true,
    });
    const FIELDS = [
      ['bridgeEnabled', 'boolean', '启用 IDE 桥接', 'Enable IDE bridge', '控制桥接发现、鉴权和重连。', 'Controls bridge discovery, authentication, and reconnect.'],
      ['ideToolsEnabled', 'boolean', '暴露 IDE 工具', 'Expose IDE tools', '控制 mv_aide__* 工具注册。', 'Controls mv_aide__* tool registration.'],
      ['terminalToolsEnabled', 'boolean', '启用七项终端增强', 'Enable seven terminal tools', '与 Obsidian 的终端增强开关取交集。', 'Combined with the Obsidian terminal-enhancement setting.'],
      ['diffReviewEnabled', 'boolean', '使用 Obsidian Diff 审核', 'Use Obsidian Diff review', '关闭后使用 DSH 原生权限流程。', 'Falls back to the native DSH permission flow when off.'],
      ['slashCommandEnabled', 'boolean', '启用 /mv-aide 命令', 'Enable /mv-aide command', '控制桥接命令是否可用。', 'Controls whether the bridge command is available.'],
      ['autoEnterVaultWorkspaceEnabled', 'boolean', '自动进入 Vault 工作区', 'Auto-enter Vault workspace', '仅影响新的桥接成功事件。', 'Only affects future successful bridge connections.'],
      ['selectionContextEnabled', 'boolean', '接收选区上下文', 'Receive selection context', '关闭后不再向对话注入新选区。', 'Stops new selection context from being injected.'],
      ['mentionSteeringEnabled', 'boolean', '接收 @ 提及指令', 'Receive @ mentions', '关闭后忽略新的提及通知。', 'Ignores new mention notifications when off.'],
      ['selectionMaxChars', 'number', '选区最大字符数', 'Selection character limit', '256–50000。', '256–50000.'],
      ['selectionDebounceMs', 'number', '选区稳定等待（ms）', 'Selection debounce (ms)', '50–3000 毫秒。', '50–3000 milliseconds.'],
      ['hoverSidebarEnabled', 'boolean', '悬浮侧栏', 'Hover sidebar', '只影响 mv-agent 的悬浮侧栏样式。', 'Only affects the mv-agent hover-sidebar style.'],
      ['imageAutoFitEnabled', 'boolean', '图片自动适配', 'Automatic image fitting', '不依赖 IDE 桥接是否连接。', 'Does not depend on an active IDE bridge.'],
    ];

    const languageIsZh = () => String(document.documentElement?.lang || navigator.language || '').toLowerCase().startsWith('zh');

    // Card chrome mirrored 1:1 from DSH's native PluginCard/fields CSS modules
    // (packages/client/ui-settings-plugins) so the injected card is visually
    // indistinguishable from the Host's own cards in both themes.
    const CARD_CSS = `
.mva-spc-card{list-style:none;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-3);transition:border-color .16s,background .16s}
.mva-spc-card:hover{border-color:var(--dsw-alias-label-dimmed)}
.mva-spc-cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}
.mva-spc-header{width:100%;appearance:none;border:0;background:none;font:inherit;color:inherit;text-align:left;cursor:pointer;display:flex;align-items:center;gap:12px;padding:14px 16px;border-radius:12px}
.mva-spc-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.mva-spc-headText{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}
.mva-spc-name{font-size:15px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-primary)}
.mva-spc-description{font-size:13px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.mva-spc-pending{flex:none;border-radius:999px;padding:1px 8px;font-size:11px;line-height:17px;font-weight:500;white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary)}
.mva-spc-chevron{flex:none;color:var(--dsw-alias-label-tertiary);transition:transform .16s}
.mva-spc-chevronOpen{transform:rotate(180deg)}
.mva-spc-body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}
.mva-spc-readonly{margin:12px 0 0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.mva-spc-field{display:flex;flex-direction:column;gap:6px;padding:12px 0}
.mva-spc-field+.mva-spc-field{border-top:1px solid var(--dsw-alias-border-l2)}
.mva-spc-fieldHead{display:flex;align-items:center;gap:8px}
.mva-spc-label{flex:1;min-width:0;font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary)}
.mva-spc-badges{display:inline-flex;align-items:center;gap:8px}
.mva-spc-badge{border-radius:999px;padding:1px 8px;font-size:11px;line-height:17px;white-space:nowrap;font-weight:500;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary)}
.mva-spc-reset{border:none;background:none;padding:0;font:inherit;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);cursor:pointer}
.mva-spc-reset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.mva-spc-reset:disabled{cursor:default}
.mva-spc-input{height:34px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-3);font:inherit;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary)}
.mva-spc-input:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary)}
.mva-spc-input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}
.mva-spc-inputInvalid{border-color:var(--dsw-alias-label-error)}
.mva-spc-check{accent-color:var(--dsw-alias-brand-primary)}
.mva-spc-invalid{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-error)}
.mva-spc-hint{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.mva-spc-hintWarn{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-tertiary))}
.mva-spc-footer{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:12px 0 4px;border-top:1px solid var(--dsw-alias-border-l2)}
.mva-spc-failed{flex:1;min-width:0;margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-error)}
.mva-spc-discard,.mva-spc-save{appearance:none;border:1px solid transparent;border-radius:8px;padding:5px 14px;font:inherit;font-size:13px;line-height:1.5;cursor:pointer}
.mva-spc-discard{border-color:var(--dsw-alias-border-l2);background:none;color:var(--dsw-alias-label-secondary)}
.mva-spc-discard:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}
.mva-spc-save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}
.mva-spc-discard:disabled,.mva-spc-save:disabled{opacity:.4;cursor:default}
.mva-spc-discard:focus-visible,.mva-spc-save:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
`;
    const ensureCardStyle = () => {
      // A DSH browser half: Obsidian's styles.css pipeline does not reach the
      // DSH web document, so the card carries its own stylesheet as a
      // constructable sheet (no <style> element). Every browser that runs the
      // DSH web UI supports constructable stylesheets.
      if (typeof document === 'undefined' || typeof CSSStyleSheet !== 'function' || !Array.isArray(document.adoptedStyleSheets)) return;
      const marker = window;
      const sheet = new CSSStyleSheet();
      // Per-plugin guard: sibling cards (mv-agent / mv-dsh-manager / mv-dsh-subworkspace)
      // share the page but own disjoint class sets, so each must inject its own sheet
      // regardless of the others. Self-heal when the window marker survives an HMR
      // reload that dropped the adopted sheet.
      if (marker.__MVA_AGENT_CARD_STYLE__ && document.adoptedStyleSheets.includes(marker.__MVA_AGENT_CARD_STYLE__)) return;
      sheet.replaceSync(CARD_CSS);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      marker.__MVA_AGENT_CARD_STYLE__ = sheet;
    };
    // Byte-for-byte copy of DSH's IconChevronDownOutline14 glyph, so the card
    // needs no extra module require to draw the native disclosure chevron.
    const CHEVRON_PATH = 'M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z';
    const chevron = (open) => React.createElement('svg', {
      width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none', 'aria-hidden': true,
      className: open ? 'mva-spc-chevron mva-spc-chevronOpen' : 'mva-spc-chevron',
    }, React.createElement('path', { d: CHEVRON_PATH, fill: 'currentColor' }));
    const safeObject = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const normalize = (value) => {
      const source = safeObject(value);
      const next = { ...DEFAULTS };
      for (const key of Object.keys(DEFAULTS)) {
        if (typeof DEFAULTS[key] === typeof source[key]) next[key] = source[key];
      }
      return Object.freeze(next);
    };

    function createPolicy() {
      let current = DEFAULTS;
      const listeners = new Set();
      return {
        get: () => current,
        publish(value) {
          const previous = current;
          current = normalize(value);
          for (const listener of listeners) listener(current, previous);
        },
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      };
    }

    function Card({ scope }) {
      const snapshot = React.useSyncExternalStore(
        (listener) => scope.subscribe(listener),
        () => scope.getSnapshot(),
      );
      const zh = languageIsZh();
      const effective = normalize(snapshot.value);
      const user = safeObject(snapshot.user);
      const [open, setOpen] = React.useState(false);
      const [draft, setDraft] = React.useState({});
      const [reset, setReset] = React.useState(() => new Set());
      const [saving, setSaving] = React.useState(false);
      const [failed, setFailed] = React.useState(false);
      const entries = Object.entries(draft);
      const dirty = entries.length > 0 || reset.size > 0;
      const numberInvalid = entries.some(([key, value]) => {
        if (key === 'selectionMaxChars') return !Number.isInteger(Number(value)) || Number(value) < 256 || Number(value) > 50000;
        if (key === 'selectionDebounceMs') return !Number.isInteger(Number(value)) || Number(value) < 50 || Number(value) > 3000;
        return false;
      });
      const h = React.createElement;
      const edit = (key, value) => {
        setFailed(false);
        setReset((current) => { const next = new Set(current); next.delete(key); return next; });
        setDraft((current) => ({ ...current, [key]: value }));
      };
      const resetField = (key) => {
        setFailed(false);
        setDraft((current) => { const next = { ...current }; delete next[key]; return next; });
        setReset((current) => new Set(current).add(key));
      };
      const save = async () => {
        if (!dirty || numberInvalid || saving || !snapshot.writable) return;
        setSaving(true);
        setFailed(false);
        try {
          for (const key of reset) {
            await scope.unset(key);
            if (Object.prototype.hasOwnProperty.call(safeObject(scope.getSnapshot().user), key)) {
              throw new Error('settings reset was not accepted');
            }
          }
          for (const [key, value] of Object.entries(draft)) {
            const expected = typeof DEFAULTS[key] === 'number' ? Number(value) : value;
            await scope.set(key, expected);
            const accepted = scope.getSnapshot();
            if (!Object.prototype.hasOwnProperty.call(safeObject(accepted.user), key)
                || accepted.value?.[key] !== expected) {
              throw new Error('settings write was not accepted');
            }
          }
          setDraft({});
          setReset(new Set());
        } catch {
          setFailed(true);
        } finally {
          setSaving(false);
        }
      };
      if (snapshot.status !== 'ready') return null;
      ensureCardStyle();
      const fieldNodes = FIELDS.map(([key, kind, zhLabel, enLabel, zhHint, enHint]) => {
        const value = Object.prototype.hasOwnProperty.call(draft, key) ? draft[key] : effective[key];
        const overridden = Object.prototype.hasOwnProperty.call(user, key) && !reset.has(key);
        const paused = !effective.bridgeEnabled && [
          'ideToolsEnabled', 'terminalToolsEnabled', 'diffReviewEnabled',
          'autoEnterVaultWorkspaceEnabled', 'selectionContextEnabled', 'mentionSteeringEnabled',
        ].includes(key);
        const invalidNumber = key === 'selectionMaxChars'
          ? !Number.isInteger(Number(value)) || Number(value) < 256 || Number(value) > 50000
          : key === 'selectionDebounceMs'
            ? !Number.isInteger(Number(value)) || Number(value) < 50 || Number(value) > 3000
            : false;
        return h('div', { key, className: 'mva-spc-field' },
          h('div', { className: 'mva-spc-fieldHead' },
            h('label', { htmlFor: `mv-agent-setting-${key}`, className: 'mva-spc-label' }, zh ? zhLabel : enLabel),
            overridden ? h('span', { className: 'mva-spc-badges' },
              h('span', { className: 'mva-spc-badge' }, zh ? '已覆盖' : 'Overridden'),
              h('button', { type: 'button', className: 'mva-spc-reset', disabled: !snapshot.writable, onClick: () => resetField(key) }, zh ? '恢复默认' : 'Reset to default')) : null,
            kind === 'boolean'
              ? h('input', { id: `mv-agent-setting-${key}`, type: 'checkbox', className: 'mva-spc-check', checked: Boolean(value), disabled: !snapshot.writable, onChange: (event) => edit(key, event.target.checked) })
              : null),
          kind === 'boolean' ? null : h('input', {
            id: `mv-agent-setting-${key}`,
            type: 'text',
            inputMode: 'numeric',
            className: invalidNumber ? 'mva-spc-input mva-spc-inputInvalid' : 'mva-spc-input',
            'aria-invalid': invalidNumber || undefined,
            value: String(value),
            disabled: !snapshot.writable,
            onChange: (event) => edit(key, event.target.value),
          }),
          h('p', { className: paused ? 'mva-spc-hintWarn' : invalidNumber ? 'mva-spc-invalid' : 'mva-spc-hint' }, paused ? (zh ? '已配置，但因 IDE 桥接关闭而暂停。' : 'Configured, but paused while the IDE bridge is off.') : invalidNumber ? (zh ? '数值超出允许范围。' : 'A number is outside its allowed range.') : (zh ? zhHint : enHint)));
      });
      return h('li', { className: open ? 'mva-spc-card mva-spc-cardOpen' : 'mva-spc-card' },
        h('button', {
          type: 'button', className: 'mva-spc-header', 'aria-expanded': open,
          'aria-label': `${zh ? (open ? '收起设置' : '展开设置') : (open ? 'Hide settings' : 'Show settings')}: mv-agent`,
          onClick: () => setOpen(!open),
        },
          h('span', { className: 'mva-spc-headText' },
            h('span', { className: 'mva-spc-name' }, 'mv-agent'),
            h('span', { className: 'mva-spc-description' }, zh ? '配置 mv-AIDE 桥接、上下文与页面增强。' : 'Configure mv-AIDE bridge, context, and page enhancements.')),
          dirty ? h('span', { className: 'mva-spc-pending' }, zh ? '未保存' : 'Unsaved') : null,
          chevron(open)),
        open ? h('div', { className: 'mva-spc-body' },
          !snapshot.writable ? h('p', { className: 'mva-spc-readonly', role: 'status' }, zh ? '当前设置文档只读。' : 'The settings document is read-only.') : null,
          ...fieldNodes,
          h('div', { className: 'mva-spc-footer' },
            failed ? h('p', { className: 'mva-spc-failed', role: 'status' }, zh ? '保存失败，草稿已保留。' : 'Save failed; the draft was kept.') : null,
            h('button', { type: 'button', className: 'mva-spc-discard', disabled: !dirty || saving, onClick: () => { setDraft({}); setReset(new Set()); setFailed(false); } }, zh ? '放弃修改' : 'Discard'),
            h('button', { type: 'button', className: 'mva-spc-save', disabled: !dirty || numberInvalid || saving || !snapshot.writable, onClick: save }, saving ? (zh ? '保存中…' : 'Saving…') : (zh ? '保存' : 'Save')))) : null,
      );
    }

    function install(ctx) {
      const policy = createPolicy();
      if (typeof ctx?.inject !== 'function') return policy;
      ctx.inject(['slots', 'settingsScope'], (settingsCtx) => {
        const slots = settingsCtx.get?.('slots') ?? settingsCtx.slots;
        const settingsScope = settingsCtx.get?.('settingsScope') ?? settingsCtx.settingsScope;
        if (!slots || !settingsScope) return;
        const scope = settingsScope.bind({ namespace: NS });
        const sync = () => {
          const snapshot = scope.getSnapshot();
          if (snapshot.status === 'ready') policy.publish(snapshot.value);
          const style = document.getElementById('mv-aide-dsh-hover-sidebar');
          if (style) style.disabled = policy.get().hoverSidebarEnabled === false;
        };
        sync();
        const unsubscribe = scope.subscribe(sync);
        settingsCtx.effect?.(() => unsubscribe, 'mv-agent: browser feature settings');
        slots.inject('settings.plugin.item', () => slots.register({
          name: 'settings.plugin.item', key: NS,
        }, () => React.createElement(Card, { scope })));
      });
      return policy;
    }

    module.exports = { DEFAULTS, normalize, createPolicy, install };
    return module.exports;
  },
});
