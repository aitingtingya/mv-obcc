// Web UI Client Injected Script for @mv-aide/mv-dsh-manager
// Aligned 1:1 with DSH Official rc.5 Source Code DOM & Component Contracts

export const UI_SCRIPT_BODY = `
(function() {
  if (window.__MV_DSH_MANAGER_INITIALIZED__) return;
  window.__MV_DSH_MANAGER_INITIALIZED__ = true;

  let activeCustomTab = null; // 'skills' | 'subagents' | 'settings' | null
  // The pane bodies (_options) this script hid and the host the live workbench
  // is mounted in. Restoring is symmetric through this ledger, and a host that
  // disappeared never leaves a foreign pane hidden (the gray screen).
  let hiddenOptions = [];
  let workbenchMount = null;
  // DSH's own selected-row class token (<hash>_active, read from the nav list
  // because the CSS-module hash is build-specific) and the navigation cells we
  // stripped it from. Highlight is expressed with DSH's classes only: writing an
  // inline background onto a DSH-owned cell beats .navCell.navCell_active (no
  // !important in either installed flavor) and survives React's class
  // reconciliation, which is how the native highlight used to disappear.
  let navActiveToken = '';
  let strippedNavCells = [];
  // Settings-page disclosure state, kept beside the DOM rather than in it: a
  // re-render (React dropping our root, a tab switch, the reload button) must
  // preserve the folds the user chose. Values are true only when opened.
  const settingsCardsOpen = {};
  const subworkspaceRowsOpen = {};
  // Summary refreshers registered by the mounted settings page, so an in-place
  // change (a directory added from the row manager) updates counts without
  // rebuilding the page.
  let settingsSummaryRefreshers = {};
  let subworkspaceBridgeListenerBound = false;

  const DEFAULT_FEATURE_POLICY = {
    pluginManagementUiEnabled: true,
    skillManagementUiEnabled: true,
    presetManagementUiEnabled: true
  };

  // ── mv-AIDE plugin settings (plugin-owned document) ──────────────────────
  // Values live in ~/.mv-aide/dsh/settings.json behind
  // /api/mv-aide/settings; this panel is the editing surface on DSH releases
  // that dropped the client settings plane (≥0.1.7). Ranges are mirrored from
  // the plugin field lists, while the host stays the validating authority: a
  // rejected save comes back as an error and the draft is kept.
  const SETTINGS_NAMESPACES = [
    {
      namespace: 'mv-agent',
      icon: '🔌',
      title: 'mv-agent（IDE 桥接）',
      detail: '控制桥接发现、鉴权重连、IDE 工具、Diff 审核与选区上下文注入。',
      fields: [
        ['bridgeEnabled', 'boolean', '启用 IDE 桥接', '控制桥接发现、鉴权和重连。'],
        ['ideToolsEnabled', 'boolean', '暴露 IDE 工具', '控制 mv_aide__* 工具注册。'],
        ['terminalToolsEnabled', 'boolean', '启用七项终端增强', '与 Obsidian 的终端增强开关取交集。'],
        ['diffReviewEnabled', 'boolean', '使用 Obsidian Diff 审核', '关闭后使用 DSH 原生权限流程。'],
        ['slashCommandEnabled', 'boolean', '启用 /mv-aide 命令', '控制桥接命令是否可用。'],
        ['autoEnterVaultWorkspaceEnabled', 'boolean', '自动进入 Vault 工作区', '仅影响新的桥接成功事件。'],
        ['selectionContextEnabled', 'boolean', '接收选区上下文', '关闭后不再向对话注入新选区。'],
        ['mentionSteeringEnabled', 'boolean', '接收 @ 提及指令', '关闭后忽略新的提及通知。'],
        ['selectionMaxChars', 'number', '选区最大字符数', '256–50000。', 256, 50000],
        ['selectionDebounceMs', 'number', '选区稳定等待（ms）', '50–3000 毫秒。', 50, 3000],
        ['hoverSidebarEnabled', 'boolean', '悬浮侧栏', '只影响 mv-agent 的悬浮侧栏样式。'],
        ['imageAutoFitEnabled', 'boolean', '图片自动适配', '不依赖 IDE 桥接是否连接。']
      ]
    },
    {
      namespace: 'mv-dsh-manager',
      icon: '🧰',
      title: 'mv-dsh-manager（管理工作台）',
      detail: '控制插件/技能/预设管理界面、模型目录、文件拖入、命令选择器、计划评审与历史召回。',
      fields: [
        ['pluginManagementUiEnabled', 'boolean', '插件管理界面', '关闭后不再注入插件列表按钮。'],
        ['skillManagementUiEnabled', 'boolean', '技能管理界面', '关闭后不再注入技能导航与工作台。'],
        ['presetManagementUiEnabled', 'boolean', '子智能体预设管理界面', '关闭后不再注入预设导航与工作台。'],
        ['modelCapabilitiesUiEnabled', 'boolean', '模型能力编辑器', '关闭后不再注入「模型」页能力列表。'],
        ['fileDropEnabled', 'boolean', 'Obsidian 文件拖入', '与 IDE 桥接完全独立。'],
        ['recursiveCommandPickerEnabled', 'boolean', '递归命令选择器', '关闭后恢复 DSH 原生斜杠命令行为。'],
        ['planReviewEnhancementEnabled', 'boolean', '计划审核增强', '为 plan-review 提供取消与快捷操作。'],
        ['historyRecallEnabled', 'boolean', '历史消息上键召回', '关闭后不接管输入框的向上键。'],
        ['commandPickerMaxLeaves', 'number', '选择器最大叶子数', '10–200。', 10, 200]
      ]
    }
  ];

  function currentSettingsSnapshot() {
    return window.__MV_AIDE_SETTINGS_SNAPSHOT__ || null;
  }

  function publishSettingsSnapshot(snapshot) {
    window.__MV_AIDE_SETTINGS_SNAPSHOT__ = snapshot || null;
    try {
      window.dispatchEvent(new CustomEvent('mv-aide:settings-changed', { detail: snapshot || null }));
    } catch (err) {
      // Older embedded browsers may lack CustomEvent; the panel still re-renders.
    }
  }

  async function loadSettingsSnapshot() {
    const response = await fetch('/api/mv-aide/settings', { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const snapshot = await response.json();
    publishSettingsSnapshot(snapshot);
    return snapshot;
  }

  async function saveSettingsNamespace(namespace, patch) {
    const response = await fetch('/api/mv-aide/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ namespace: namespace, set: patch.set || {}, unset: patch.unset || [] })
    });
    const payload = await response.json().catch(function() { return {}; });
    if (!response.ok || payload.ok === false) {
      throw new Error(payload.error || ('HTTP ' + response.status));
    }
    publishSettingsSnapshot(payload);
    return payload;
  }

  function featurePolicy() {
    return Object.assign({}, DEFAULT_FEATURE_POLICY, window.__MV_DSH_MANAGER_FEATURE_POLICY__ || {});
  }

  function closeCustomWorkbench(nativeTarget) {
    activeCustomTab = null;
    workbenchMount = null;
    const custom = document.getElementById('mv-aide-custom-workbench-root');
    if (custom) custom.remove();
    restoreHiddenOptions(null);
    clearCustomNavHighlight();
    // A native row is about to own the pane: give it DSH's highlight back. This
    // covers the row React cannot repaint (the one already selected in the
    // store, whose activeId does not change on click).
    restoreNativeNavHighlight(nativeTarget || null);
  }

  // ── Workbench host resolution (settings panel scope) ─────────────────────
  // The settings dialog is portalled to document.body *after* #root, and the
  // _content / _options class-name tokens are shared by a dozen DSH client
  // packages (chat, conversation, models, …). A document-wide first match binds
  // the workbench to whichever pane precedes the dialog in document order and
  // hides the dialog's real body — the reported gray pane. Every lookup below is
  // scoped to the panel that owns the clicked nav list, and none falls back to
  // the document.
  function resolveWorkbenchHost(navList) {
    if (!navList || typeof navList.closest !== 'function' || !navList.isConnected) return null;
    let scope = navList.closest('[role="dialog"]');
    let content = scope ? scope.querySelector('div[class*="_content"]') : null;
    if (!content) {
      // Shells without the dialog wrapper climb to the nearest ancestor that
      // owns a pane container, still stopping before body.
      let node = navList.parentElement;
      while (node && node !== document.body) {
        const candidate = node.querySelector('div[class*="_content"]');
        if (candidate) {
          scope = node;
          content = candidate;
          break;
        }
        node = node.parentElement;
      }
    }
    if (!content) return null;
    return {
      scope: scope || content.parentElement || navList.parentElement,
      content: content,
      options: content.querySelector('div[class*="_options"]')
    };
  }

  /** Nav list owning a workbench tab, or null once the dialog unmounted. */
  function navListForTab(type) {
    const button = document.getElementById('mv-aide-nav-' + type + '-btn');
    if (button && button.isConnected) {
      const own = button.closest('div[class*="_navList"]');
      if (own) return own;
    }
    const injected = document.querySelector('#mv-aide-nav-skills-btn, #mv-aide-nav-subagents-btn, #mv-aide-nav-settings-btn');
    if (injected && injected.closest) {
      const shared = injected.closest('div[class*="_navList"]');
      if (shared) return shared;
    }
    // _navList is provided by ui-settings-general alone, so a dialog-scoped
    // lookup cannot bind another modal.
    return type === 'settings' ? document.querySelector('[role="dialog"] div[class*="_navList"]') : null;
  }

  function hideOptions(options) {
    if (!options) return;
    if (options.style.display !== 'none') options.style.display = 'none';
    if (hiddenOptions.indexOf(options) === -1) hiddenOptions.push(options);
  }

  /** Restore every pane body this script hid, keeping only the live host's. */
  function restoreHiddenOptions(keep) {
    hiddenOptions = hiddenOptions.filter(function(element) {
      if (!element || element === keep) return element === keep;
      element.style.display = '';
      return false;
    });
  }

  function workbenchRoot() {
    return document.getElementById('mv-aide-custom-workbench-root');
  }

  function renderWorkbench(type, root) {
    if (type === 'skills') renderSkillsWorkbench(root);
    else if (type === 'settings') renderSettingsWorkbench(root);
    else renderSubagentsWorkbench(root);
  }

  function renderWorkbenchRoot() {
    const root = document.createElement('div');
    root.id = 'mv-aide-custom-workbench-root';
    root.style.cssText = 'flex:1; min-height:0; padding:0 24px 24px; overflow-y:auto; color:var(--dsw-alias-label-primary, #fff); font-family:inherit; box-sizing:border-box;';
    return root;
  }

  /** Mount (or re-mount) the workbench inside its own pane container. */
  function mountWorkbench(type, host, previousType) {
    let root = workbenchRoot();
    if (root && (root.parentElement !== host.content || !root.isConnected)) {
      root.remove();
      root = null;
    }
    const created = !root;
    if (!root) {
      root = renderWorkbenchRoot();
      host.content.appendChild(root);
    }
    if (root.style.display !== 'block') root.style.display = 'block';
    // React re-renders the pane and drops children it does not own, and
    // switching tabs reuses one node: render when the node is new, empty, or
    // still holds another tab's content.
    if (created || root.childElementCount === 0 || previousType !== type) renderWorkbench(type, root);
    return root;
  }

  const CUSTOM_NAV_IDS = ['skills', 'subagents', 'settings'];

  function customNavButton(id) {
    return document.getElementById('mv-aide-nav-' + id + '-btn');
  }

  /** DSH-owned nav cells: every button in the list that is not one of ours. */
  function nativeNavButtons(navList) {
    return navList
      ? Array.from(navList.querySelectorAll('button[class*="_navCell"], button')).filter(function(button) {
          return !button.id || !button.id.startsWith('mv-aide-nav-');
        })
      : [];
  }

  /**
   * DSH's selected-row class token, resolved without guessing:
   *   1. a token containing active on a native cell right now — authoritative,
   *      and still correct if DSH ever renames the pair;
   *   2. the cached token from an earlier scan — the case that matters, because
   *      our own strip removed the only highlighted row, so step 1 cannot see it;
   *   3. derived from DSH's CSS-module pairing <hash>_navCell -> <hash>_active
   *      (verified in the installed 0.1.7-rc.2 VOzbGW_ and 0.1.6-alpha.1
   *      kfhwBa_ builds);
   *   4. otherwise empty: we then neither strip nor paint. Removing a highlight
   *      we cannot put back would be worse than our own row staying plain.
   */
  function resolveNavActiveToken(buttons) {
    let observed = '';
    buttons.forEach(function(button) {
      if (observed) return;
      String(button.className || '').split(/\\s+/).forEach(function(candidate) {
        // The token has to *end* in "active", the same rule dropActiveToken
        // uses: a token that merely contains the word (a not-active-here
        // marker, or a future host class) would otherwise be adopted as DSH's
        // selected-row token and painted onto every row we own.
        if (!observed && candidate && candidate.endsWith('active')) observed = candidate;
      });
    });
    if (observed) {
      navActiveToken = observed;
      return observed;
    }
    if (navActiveToken) return navActiveToken;
    let derived = '';
    buttons.some(function(button) {
      const classes = String(button.className || '').split(/\\s+/);
      for (let index = 0; index < classes.length; index += 1) {
        if (classes[index].endsWith('navCell')) {
          derived = classes[index].replace(/navCell$/, 'active');
          return true;
        }
      }
      return false;
    });
    if (derived) navActiveToken = derived;
    return derived;
  }

  /** Drop DSH's selected-row token from one of our rows, difference-guarded. */
  function dropActiveToken(button) {
    Array.from(button.classList).forEach(function(token) {
      if (token.indexOf('active') === -1) return;
      if (token !== navActiveToken && !token.endsWith('active')) return;
      button.classList.remove(token);
    });
  }

  /** Our three rows carry DSH's active token, or nothing at all. */
  function clearCustomNavHighlight() {
    CUSTOM_NAV_IDS.forEach(function(id) {
      const button = customNavButton(id);
      if (!button) return;
      dropActiveToken(button);
      if (button.hasAttribute('aria-current')) button.removeAttribute('aria-current');
    });
  }

  /**
   * Give the highlight back to DSH. Restoring only ever touches cells we
   * actually stripped, so a row DSH is already painting is left exactly as React
   * rendered it (never add active to a row we did not take it from).
   *
   * Clicking a native row is the case React cannot cover: when that row is
   * already the store's selection, activeId does not change, no className is
   * rewritten, and a stripped row would stay unlit.
   */
  function restoreNativeNavHighlight(target) {
    if (strippedNavCells.length === 0) return;
    const token = navActiveToken;
    const cells = target && target.isConnected ? [target] : strippedNavCells;
    cells.forEach(function(cell) {
      if (!cell || !cell.isConnected || !token) return;
      if (!cell.classList.contains(token)) cell.classList.add(token);
      if (!cell.hasAttribute('aria-current')) cell.setAttribute('aria-current', 'true');
    });
    strippedNavCells = [];
  }

  /**
   * Put DSH's own highlight on the row whose pane is visible, using DSH's
   * classes only — never an inline style. An inline background outranks
   * .navCell.active (neither installed flavor uses !important) and outlives
   * React's class reconciliation, which is exactly how the native highlight used
   * to vanish and how our row kept its grey after the pane had switched away.
   *
   * Every write is guarded by a real difference: the scan observer counts a
   * class change inside the nav list as a reason to rescan, so a write that
   * changes nothing (a token that is not in the list, a row already marked)
   * would feed the very scan that produced it and spin the page.
   */
  function applyWorkbenchNavState(navList) {
    const buttons = nativeNavButtons(navList);
    const token = resolveNavActiveToken(buttons);
    buttons.forEach(function(button) {
      if (!token || !button.classList.contains(token)) return;
      button.classList.remove(token);
      if (button.hasAttribute('aria-current')) button.removeAttribute('aria-current');
      if (strippedNavCells.indexOf(button) === -1) strippedNavCells.push(button);
    });
    CUSTOM_NAV_IDS.forEach(function(id) {
      const button = customNavButton(id);
      if (!button) return;
      const selected = id === activeCustomTab;
      if (!selected) {
        dropActiveToken(button);
        if (button.hasAttribute('aria-current')) button.removeAttribute('aria-current');
        return;
      }
      if (token && !button.classList.contains(token)) button.classList.add(token);
      if (!button.hasAttribute('aria-current')) button.setAttribute('aria-current', 'true');
    });
  }

  /**
   * Self-healing workbench invariant, run on every scan and fallback tick:
   *   - no custom tab: nothing of ours stays hidden;
   *   - the settings dialog unmounted: hide nothing and keep the tab for the
   *     next dialog, so re-entry re-mounts instead of showing a gray pane;
   *   - the dialog is live but our root vanished (React re-render, tab switch):
   *     re-mount and re-render it.
   */
  function syncWorkbench() {
    if (!activeCustomTab) {
      workbenchMount = null;
      restoreHiddenOptions(null);
      return null;
    }
    const previous = workbenchMount;
    const navList = previous && previous.navList && previous.navList.isConnected
      ? previous.navList
      : navListForTab(activeCustomTab);
    const host = resolveWorkbenchHost(navList);
    if (!host) {
      workbenchMount = null;
      const orphan = workbenchRoot();
      if (orphan) orphan.remove();
      restoreHiddenOptions(null);
      return null;
    }
    applyWorkbenchNavState(navList);
    hideOptions(host.options);
    restoreHiddenOptions(host.options);
    const root = mountWorkbench(activeCustomTab, host, previous ? previous.type : null);
    workbenchMount = {
      type: activeCustomTab,
      navList: navList,
      scope: host.scope,
      content: host.content,
      options: host.options,
      root: root
    };
    return root;
  }

  // ─────────────────────────────────────────────────────────────
  // 1. Plugins List Toggle Buttons, Delete & Toolbar Injection
  // ─────────────────────────────────────────────────────────────

  function findEntryId(card) {
    const dataEntry = card.getAttribute('data-plugin-entry');
    if (dataEntry && dataEntry.trim()) {
      return dataEntry.trim();
    }
    const entryCode = card.querySelector('code[class*="_entryValue"], code[data-loader-entry]');
    if (entryCode && entryCode.textContent.trim()) {
      return entryCode.textContent.trim();
    }
    const titleStrong = card.querySelector('strong[class*="_cardTitle"]');
    if (titleStrong && titleStrong.textContent.trim()) {
      return titleStrong.textContent.trim();
    }
    return null;
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Static markup only (no user data ever passed through here). Dynamic
  // values are rendered with textContent / escapeHtml further below.
  function setStaticHtml(container, html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const nodes = [];
    for (let i = 0; i < doc.body.childNodes.length; i += 1) {
      nodes.push(doc.body.childNodes[i]);
    }
    container.replaceChildren.apply(container, nodes);
  }

  function clearChildren(container) {
    while (container.firstChild) container.removeChild(container.firstChild);
  }

  async function fetchManagerJson(url, options) {
    const controller = new AbortController();
    const timer = setTimeout(function() { controller.abort(); }, 8000);
    try {
      const request = Object.assign({}, options || {}, { signal: controller.signal });
      const response = await fetch(url, request);
      let data;
      try {
        data = await response.json();
      } catch {
        throw new Error('DSH manager 返回了无法解析的响应 (HTTP ' + response.status + ')');
      }
      if (!response.ok) {
        throw new Error((data && data.error) || ('HTTP ' + response.status));
      }
      if (!data || data.ok !== true) {
        throw new Error((data && data.error) || 'DSH manager 返回失败状态');
      }
      return data;
    } catch (error) {
      if (error && error.name === 'AbortError') throw new Error('请求超时，请确认 DSH 服务仍在运行');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  function renderLoadError(countSpan, listDiv, label, error, retry) {
    countSpan.textContent = '加载失败';
    clearChildren(listDiv);
    const wrap = document.createElement('div');
    wrap.style.cssText = 'padding:16px;border:1px solid rgba(239,68,68,0.3);border-radius:10px;background:rgba(239,68,68,0.08);color:#fca5a5;font-size:13px;line-height:20px;';
    const message = document.createElement('div');
    message.textContent = label + '加载失败：' + String(error instanceof Error ? error.message : error);
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = '重试';
    button.style.cssText = 'margin-top:10px;padding:4px 12px;border-radius:6px;border:1px solid rgba(255,255,255,0.18);background:rgba(255,255,255,0.08);color:inherit;cursor:pointer;font:inherit;';
    button.onclick = function() {
      countSpan.textContent = '正在加载...';
      clearChildren(listDiv);
      void retry();
    };
    wrap.append(message, button);
    listDiv.appendChild(wrap);
  }

  const DIALOG_CSS = {
    overlay: 'position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(0,0,0,0.52);font-family:inherit;color:var(--dsw-alias-label-primary,#e4e4e7);box-sizing:border-box;',
    card: 'width:min(540px,calc(100vw - 32px));max-height:calc(100vh - 32px);overflow:auto;border-radius:14px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,0.14));background:var(--dsw-alias-bg-layer-2,#18181b);box-shadow:0 24px 64px rgba(0,0,0,0.45);padding:18px 20px 20px;box-sizing:border-box;',
    title: 'margin:0 0 14px;font-size:16px;font-weight:600;line-height:24px;',
    field: 'margin:0 0 12px;',
    label: 'display:block;margin:0 0 6px;font-size:13px;font-weight:500;color:var(--dsw-alias-label-secondary,#a1a1aa);',
    input: 'width:100%;min-height:36px;padding:0 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,0.15));background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,0.06));color:var(--dsw-alias-label-primary,#f4f4f5);font:inherit;font-size:13px;line-height:20px;box-sizing:border-box;outline:none;',
    textarea: 'width:100%;min-height:110px;padding:9px 10px;resize:vertical;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,0.15));background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,0.06));color:var(--dsw-alias-label-primary,#f4f4f5);font:inherit;font-size:13px;line-height:20px;box-sizing:border-box;outline:none;',
    actions: 'display:flex;justify-content:flex-end;gap:8px;margin-top:16px;',
    button: 'padding:6px 14px;min-width:72px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,0.15));background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,0.08));color:var(--dsw-alias-label-primary,#f4f4f5);cursor:pointer;font:inherit;font-size:13px;font-weight:500;',
    primary: 'padding:6px 14px;min-width:72px;border-radius:8px;border:1px solid var(--dsw-alias-state-success-primary,#10b981);background:var(--dsw-alias-state-success-primary,#10b981);color:#ffffff;cursor:pointer;font:inherit;font-size:13px;font-weight:500;',
    danger: 'padding:6px 14px;min-width:72px;border-radius:8px;border:1px solid rgba(239,68,68,0.5);background:rgba(239,68,68,0.9);color:#ffffff;cursor:pointer;font:inherit;font-size:13px;font-weight:500;',
    error: 'margin:0 0 12px;padding:7px 10px;border-radius:8px;background:rgba(239,68,68,0.14);border:1px solid rgba(239,68,68,0.3);color:#fca5a5;font-size:12px;line-height:18px;',
    message: 'margin:0 0 16px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary,#a1a1aa);white-space:pre-wrap;'
  };

  function toast(message, type) {
    try {
      const host = document.body || document.documentElement;
      const node = document.createElement('div');
      node.className = 'mv-aide-dsh-toast';
      node.setAttribute('data-type', type || 'info');
      node.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483600;max-width:min(680px,calc(100vw - 40px));padding:9px 14px;border-radius:10px;background:var(--dsw-alias-bg-layer-2,rgba(24,24,27,0.96));border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,0.16));color:var(--dsw-alias-label-primary,#f4f4f5);font:inherit;font-size:13px;line-height:20px;box-shadow:0 10px 30px rgba(0,0,0,0.35);text-align:left;';
      if (type === 'success') node.style.borderColor = 'rgba(16,185,129,0.5)';
      if (type === 'error') node.style.borderColor = 'rgba(239,68,68,0.5)';
      node.textContent = String(message || '');
      host.appendChild(node);
      setTimeout(function() {
        if (node.parentNode) node.parentNode.removeChild(node);
      }, type === 'error' ? 7000 : 4000);
    } catch {
      /* never break the page for toast failures */
    }
  }

  function openForm(options) {
    return new Promise(function(resolve) {
      const previousActive = document.activeElement;
      const overlay = document.createElement('div');
      overlay.className = 'mv-aide-dsh-form-overlay';
      overlay.style.cssText = DIALOG_CSS.overlay;
      const card = document.createElement('div');
      card.className = 'mv-aide-dsh-form-card';
      card.style.cssText = DIALOG_CSS.card;
      overlay.appendChild(card);

      const title = document.createElement('h3');
      title.style.cssText = DIALOG_CSS.title;
      title.textContent = options.title || '';
      card.appendChild(title);

      const fields = [];
      const errorLine = document.createElement('div');
      errorLine.className = 'mv-aide-dsh-form-error';
      errorLine.style.cssText = DIALOG_CSS.error;
      errorLine.style.display = 'none';
      card.appendChild(errorLine);

      for (const field of options.fields || []) {
        const wrap = document.createElement('div');
        wrap.style.cssText = DIALOG_CSS.field;
        const label = document.createElement('label');
        label.style.cssText = DIALOG_CSS.label;
        label.textContent = field.label || field.key;
        wrap.appendChild(label);

        let input;
        if (field.type === 'textarea') {
          input = document.createElement('textarea');
          input.style.cssText = DIALOG_CSS.textarea;
          input.rows = field.rows || 5;
        } else if (field.type === 'select') {
          input = document.createElement('select');
          input.style.cssText = DIALOG_CSS.input;
          for (const option of field.options || []) {
            const optionEl = document.createElement('option');
            optionEl.value = option.value;
            optionEl.textContent = option.label || option.value;
            if (option.value === field.defaultValue) optionEl.selected = true;
            input.appendChild(optionEl);
          }
        } else {
          input = document.createElement('input');
          input.type = 'text';
          input.style.cssText = DIALOG_CSS.input;
        }
        input.dataset.mvAideField = field.key;
        if (field.placeholder) input.placeholder = field.placeholder;
        if (field.defaultValue && field.type !== 'select') input.value = field.defaultValue;
        input.addEventListener('keydown', function(event) {
          if (event.key === 'Enter' && field.type !== 'textarea') {
            event.preventDefault();
            submit();
          }
        });
        wrap.appendChild(input);
        card.appendChild(wrap);
        fields.push({ field: field, input: input });
      }

      const actions = document.createElement('div');
      actions.style.cssText = DIALOG_CSS.actions;
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.style.cssText = DIALOG_CSS.button;
      cancel.textContent = '取消';
      cancel.addEventListener('click', function(event) {
        event.preventDefault();
        close(null);
      });
      const submitBtn = document.createElement('button');
      submitBtn.type = 'button';
      submitBtn.style.cssText = DIALOG_CSS.primary;
      submitBtn.textContent = options.submitText || '确定';
      submitBtn.addEventListener('click', submit);
      actions.appendChild(cancel);
      actions.appendChild(submitBtn);
      card.appendChild(actions);
      (document.body || document.documentElement).appendChild(overlay);

      function showError(message) {
        errorLine.textContent = message;
        errorLine.style.display = 'block';
      }

      function submit() {
        const collected = {};
        for (const item of fields) {
          let value = item.input.value;
          if (typeof value === 'string') value = value.trim();
          collected[item.field.key] = value || '';
          if (item.field.required && !collected[item.field.key]) {
            showError(item.field.error || ('请填写 ' + (item.field.label || item.field.key)));
            item.input.focus();
            return;
          }
        }
        close(collected);
      }

      function close(result) {
        overlay.remove();
        document.removeEventListener('keydown', onKeyDown, true);
        if (previousActive && typeof previousActive.focus === 'function') previousActive.focus();
        resolve(result === undefined || result instanceof Event ? null : result);
      }

      function onKeyDown(event) {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          close(null);
        }
      }
      document.addEventListener('keydown', onKeyDown, true);
      overlay.addEventListener('mousedown', function(event) {
        if (event.target === overlay) close(null);
      });

      const first = fields[0];
      if (first) first.input.focus();
    });
  }

  function confirmDialog(options) {
    return new Promise(function(resolve) {
      const previousActive = document.activeElement;
      const overlay = document.createElement('div');
      overlay.className = 'mv-aide-dsh-form-overlay';
      overlay.style.cssText = DIALOG_CSS.overlay;
      const card = document.createElement('div');
      card.className = 'mv-aide-dsh-form-card';
      card.style.cssText = DIALOG_CSS.card;
      overlay.appendChild(card);

      const title = document.createElement('h3');
      title.style.cssText = DIALOG_CSS.title;
      title.textContent = (options && options.title) || '请确认';
      card.appendChild(title);
      const message = document.createElement('p');
      message.style.cssText = DIALOG_CSS.message;
      message.textContent = (options && options.message) || '';
      card.appendChild(message);

      const actions = document.createElement('div');
      actions.style.cssText = DIALOG_CSS.actions;
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.style.cssText = DIALOG_CSS.button;
      cancel.textContent = '取消';
      const confirm = document.createElement('button');
      confirm.type = 'button';
      confirm.style.cssText = (options && options.danger) ? DIALOG_CSS.danger : DIALOG_CSS.primary;
      confirm.textContent = (options && options.confirmText) || '确定';
      actions.appendChild(cancel);
      actions.appendChild(confirm);
      card.appendChild(actions);
      (document.body || document.documentElement).appendChild(overlay);

      function close(result) {
        overlay.remove();
        document.removeEventListener('keydown', onKeyDown, true);
        if (previousActive && typeof previousActive.focus === 'function') previousActive.focus();
        resolve(result);
      }
      function onKeyDown(event) {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          close(false);
        }
      }
      cancel.addEventListener('click', function(event) {
        event.preventDefault();
        close(false);
      });
      confirm.addEventListener('click', function(event) {
        event.preventDefault();
        close(true);
      });
      overlay.addEventListener('mousedown', function(event) {
        if (event.target === overlay) close(false);
      });
      document.addEventListener('keydown', onKeyDown, true);
      confirm.focus();
    });
  }

  function openFolder(apiPath) {
    fetch(apiPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    }).then(function(r) { return r.json(); }).then(function(res) {
      if (res && res.ok) {
        toast('已打开目录：' + (res.path || apiPath), 'success');
      } else {
        toast('打开目录失败: ' + ((res && res.error) || '未知错误'), 'error');
      }
    }).catch(function(err) {
      toast('请求失败: ' + String(err), 'error');
    });
  }

  function createOpenFolderButton(apiPath) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mv-aide-open-folder-btn';
    btn.textContent = '📂 打开目录';
    btn.style.cssText = [
      'padding: 3px 10px',
      'font-size: 12px',
      'font-weight: 500',
      'font-family: inherit',
      'border-radius: 6px',
      'border: 1px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.15))',
      'background: var(--dsw-alias-bg-layer-1, rgba(255, 255, 255, 0.08))',
      'color: var(--dsw-alias-label-primary, #f4f4f5)',
      'cursor: pointer',
      'transition: all 0.15s ease',
    ].join('; ');

    btn.onmouseenter = function() { btn.style.opacity = '0.88'; };
    btn.onmouseleave = function() { btn.style.opacity = '1'; };
    btn.onclick = function(e) {
      e.stopPropagation();
      openFolder(apiPath);
    };
    return btn;
  }

  function injectCardButtons(card) {
    if (card.querySelector('.mv-aide-pm-btn-group')) return;

    const trailing = card.querySelector('span[class*="_cardTrailing"], div[class*="_cardTrailing"]');
    if (!trailing) return;

    const configTag = trailing.querySelector('span[class*="_configTag"]');
    if (!configTag) return;

    const entryId = findEntryId(card);
    if (!entryId) return;

    const isEnabled = configTag.getAttribute('data-enabled') === 'true' || configTag.textContent.includes('已启用') || configTag.textContent.includes('Enabled');

    const group = document.createElement('span');
    group.className = 'mv-aide-pm-btn-group';
    group.style.cssText = 'display:inline-flex; align-items:center; gap:4px; margin-left:6px; z-index:10;';

    // 1. 启停按钮
    const toggleBtn = document.createElement('span');
    toggleBtn.className = 'mv-aide-pm-toggle-btn';
    toggleBtn.setAttribute('role', 'button');
    toggleBtn.setAttribute('tabindex', '0');
    toggleBtn.dataset.entryId = entryId;
    toggleBtn.dataset.enabled = isEnabled ? 'true' : 'false';
    toggleBtn.textContent = isEnabled ? '停用' : '启用';
    toggleBtn.style.cssText = [
      'display: inline-flex',
      'align-items: center',
      'justify-content: center',
      'padding: 1px 7px',
      'font-size: 11px',
      'line-height: 16px',
      'border-radius: 4px',
      'cursor: pointer',
      'font-family: inherit',
      'font-weight: 500',
      'border: 1px solid ' + (isEnabled ? 'var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.15))' : 'var(--dsw-alias-state-success-primary, #10b981)'),
      'background: ' + (isEnabled ? 'var(--dsw-alias-bg-layer-1, rgba(255, 255, 255, 0.08))' : 'var(--dsw-alias-state-success-primary, #10b981)'),
      'color: ' + (isEnabled ? 'var(--dsw-alias-label-secondary, #a1a1aa)' : '#ffffff'),
      'transition: all 0.15s ease',
      'user-select: none',
    ].join('; ');

    const onToggle = async function(e) {
      if (e) { e.stopPropagation(); e.preventDefault(); }
      const currentEnabled = toggleBtn.dataset.enabled === 'true';
      const targetDisabled = currentEnabled;

      if ((entryId === 'mv-dsh-manager' || entryId.includes('mv-dsh-manager')) && targetDisabled) {
        const confirmed = await confirmDialog({
          title: '停用插件管理器',
          message: '警告：停用 mv-dsh-manager 管理器将导致 Web UI 无法继续进行插件与技能管理。确定要停用吗？',
          danger: true
        });
        if (!confirmed) return;
      }

      const originalText = toggleBtn.textContent;
      toggleBtn.style.pointerEvents = 'none';
      toggleBtn.textContent = '...';

      try {
        const res = await fetch('/api/mv-aide/plugins/toggle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ entryId: entryId, disabled: targetDisabled })
        });
        const data = await res.json();
        if (data && data.ok) {
          const observedRes = await fetch('/api/mv-aide/plugins');
          const observedData = await observedRes.json();
          const observed = observedData && observedData.ok
            ? (observedData.entries || []).find(function(entry) {
                return entry.runtimeEntryId === entryId || entry.configRowId === entryId || entry.id === entryId;
              })
            : null;
          if (!observed) {
            toast('DSH 已接受请求，但重新读取 Loader 时未找到该插件；请刷新页面确认最终状态。', 'error');
            toggleBtn.textContent = originalText;
          } else {
            const nextEnabled = Boolean(observed.enabled);
            toggleBtn.dataset.enabled = nextEnabled ? 'true' : 'false';
            toggleBtn.textContent = nextEnabled ? '停用' : '启用';
            toggleBtn.style.background = nextEnabled
              ? 'var(--dsw-alias-bg-layer-1, rgba(255, 255, 255, 0.08))'
              : 'var(--dsw-alias-state-success-primary, #10b981)';
            toggleBtn.style.borderColor = nextEnabled
              ? 'var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.15))'
              : 'var(--dsw-alias-state-success-primary, #10b981)';
            toggleBtn.style.color = nextEnabled ? 'var(--dsw-alias-label-secondary, #a1a1aa)' : '#ffffff';
            configTag.setAttribute('data-enabled', nextEnabled ? 'true' : 'false');
            configTag.textContent = nextEnabled ? '已启用' : '已停用';
            const dot = trailing.querySelector('span[class*="_statusDot"]');
            if (dot) {
              dot.setAttribute('data-phase', nextEnabled ? 'active' : '');
              dot.style.display = nextEnabled ? 'inline-block' : 'none';
            }
            if (data.requiresFrontendReload) {
              toast('mv-agent 已切换，正在刷新 DSH 前端以重新挂载浏览器端连接模块。', 'success');
              setTimeout(function() { window.location.reload(); }, 250);
            }
          }
        } else {
          toast('操作失败：' + ((data && data.error) || '未知错误'), 'error');
          toggleBtn.textContent = originalText;
        }
      } catch (err) {
        toast('请求失败：' + String(err), 'error');
        toggleBtn.textContent = originalText;
      } finally {
        toggleBtn.style.pointerEvents = 'auto';
      }
    };

    toggleBtn.addEventListener('click', onToggle);

    // 2. 卸载/删除按钮
    const delBtn = document.createElement('span');
    delBtn.className = 'mv-aide-pm-del-btn';
    delBtn.setAttribute('role', 'button');
    delBtn.setAttribute('tabindex', '0');
    delBtn.textContent = '卸载';
    delBtn.style.cssText = [
      'display: inline-flex',
      'align-items: center',
      'justify-content: center',
      'padding: 1px 6px',
      'font-size: 11px',
      'line-height: 16px',
      'border-radius: 4px',
      'cursor: pointer',
      'font-family: inherit',
      'font-weight: 500',
      'border: 1px solid rgba(239, 68, 68, 0.3)',
      'background: transparent',
      'color: #f87171',
      'transition: all 0.15s ease',
      'user-select: none',
    ].join('; ');

    delBtn.onmouseenter = function() { delBtn.style.background = 'rgba(239, 68, 68, 0.15)'; };
    delBtn.onmouseleave = function() { delBtn.style.background = 'transparent'; };

    const isRisky = entryId.startsWith('@deepseek-ai/') || entryId.startsWith('cordis:') || entryId.includes('mv-dsh-manager') || entryId.includes('mv-agent') || entryId.includes('mv-dsh-subworkspace');

    delBtn.onclick = async function(e) {
      if (e) { e.stopPropagation(); e.preventDefault(); }
      const confirmed = await confirmDialog({
        title: isRisky ? '高危卸载确认' : '卸载插件',
        message: isRisky
          ? '⚠️ 插件 "' + entryId + '" 属于官方/核心或 mv-AIDE 管理组件。卸载可能导致会话、管理界面或桥接能力立即失效。确定继续吗？'
          : '确定要卸载插件 "' + entryId + '" 吗？',
        danger: isRisky
      });
      if (!confirmed) return;

      delBtn.textContent = '...';
      try {
        const suffix = isRisky ? '?force=true' : '';
        const d = await fetchManagerJson('/api/mv-aide/plugins/' + encodeURIComponent(entryId) + suffix, { method: 'DELETE' });
        if (d.active || d.disabledFallback) {
          toast(d.warning || d.message || '卸载请求已持久化，等待 DSH Loader 收敛。', 'success');
          delBtn.textContent = '卸载';
        } else {
          toast(d.message || '插件已卸载。', 'success');
          card.remove();
        }
        if (d.requiresFrontendReload) {
          setTimeout(function() { window.location.reload(); }, 250);
        }
      } catch (err) {
        toast('卸载失败: ' + String(err instanceof Error ? err.message : err), 'error');
        delBtn.textContent = '卸载';
      }
    };

    group.appendChild(toggleBtn);
    group.appendChild(delBtn);
    configTag.insertAdjacentElement('afterend', group);
  }

  function injectCatalogToolbar(heading) {
    if (
      !heading ||
      heading.querySelector('.mv-aide-import-plugin-btn') ||
      heading.querySelector('.mv-aide-open-folder-btn')
    ) return;

    const openBtn = createOpenFolderButton('/api/mv-aide/plugins/open-folder');
    const importBtn = document.createElement('button');
    importBtn.type = 'button';
    importBtn.className = 'mv-aide-import-plugin-btn';
    importBtn.textContent = '+ 导入插件';
    importBtn.style.cssText = [
      'margin-left: auto',
      'padding: 3px 10px',
      'font-size: 12px',
      'font-weight: 500',
      'font-family: inherit',
      'border-radius: 6px',
      'border: 1px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.15))',
      'background: var(--dsw-alias-state-success-primary, #10b981)',
      'color: #ffffff',
      'cursor: pointer',
      'transition: all 0.15s ease',
    ].join('; ');

    importBtn.onmouseenter = function() { importBtn.style.opacity = '0.88'; };
    importBtn.onmouseleave = function() { importBtn.style.opacity = '1'; };

    importBtn.onclick = async function(e) {
      e.stopPropagation();
      const values = await openForm({
        title: '导入插件',
        submitText: '导入',
        fields: [{
          key: 'spec',
          label: '插件包名或本地路径',
          placeholder: '@scope/pkg 或 file:/path/to/plugin',
          required: true,
          error: '请输入插件包名或本地路径'
        }]
      });
      if (!values) return;

      fetch('/api/mv-aide/plugins/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spec: values.spec })
      }).then(function(r) { return r.json(); }).then(function(res) {
        if (res.ok) {
          toast('插件已成功导入配置！请在 Obsidian 设置中点击“插件注入”自动完成依赖构建与激活。', 'success');
        } else {
          toast('导入失败: ' + (res.error || '未知错误'), 'error');
        }
      });
    };

    heading.appendChild(openBtn);
    heading.appendChild(importBtn);
  }

  function scanCards(cards, heading) {
    if (!featurePolicy().pluginManagementUiEnabled) {
      document.querySelectorAll('.mv-aide-pm-btn-group, .mv-aide-import-plugin-btn, .mv-aide-open-folder-btn')
        .forEach(function(node) { node.remove(); });
      return;
    }
    for (let i = 0; i < cards.length; i++) {
      injectCardButtons(cards[i]);
    }
    injectCatalogToolbar(heading);
  }

  // ─────────────────────────────────────────────────────────────
  // 2. Official rc.5 Aligned: Sidebar Nav Buttons ("✨ 技能" & "🤖 子智能体")
  // ─────────────────────────────────────────────────────────────

  function createNavButton(id, icon, text, baseClassName) {
    const btn = document.createElement('button');
    btn.id = 'mv-aide-nav-' + id + '-btn';
    btn.type = 'button';
    btn.className = baseClassName;
    btn.setAttribute('data-nav-id', id);
    btn.style.cssText = [
      'display: flex',
      'align-items: center',
      'gap: 8px',
      'height: 40px',
      'padding: 9px 16px 9px 12px',
      'box-sizing: border-box',
      'border: none',
      'border-radius: 12px',
      // No background here on purpose: an inline declaration would outrank
      // DSH's own .navCell:hover / .navCell.active rules on our row too.
      'cursor: pointer',
      'font-family: inherit',
      'font-size: 14px',
      'line-height: 22px',
      'font-weight: 400',
      'color: var(--dsw-alias-label-primary, #e4e4e7)',
      'text-align: left',
      'transition: background 0.15s ease',
      'width: 100%',
    ].join('; ');

    const iconSpan = document.createElement('span');
    iconSpan.className = 'mv-aide-nav-icon';
    iconSpan.style.cssText = 'font-size:15px; line-height:1; flex:none;';
    iconSpan.textContent = icon;
    const labelSpan = document.createElement('span');
    labelSpan.className = 'mv-aide-nav-label';
    labelSpan.style.cssText = 'flex:1; min-width:0; overflow:hidden; white-space:nowrap; text-overflow:ellipsis;';
    labelSpan.textContent = text;
    btn.append(iconSpan, labelSpan);
    return btn;
  }

  function injectSidebarNav(navList) {
    const policy = featurePolicy();
    if (!policy.skillManagementUiEnabled) {
      document.getElementById('mv-aide-nav-skills-btn')?.remove();
      if (activeCustomTab === 'skills') closeCustomWorkbench();
    }
    if (!policy.presetManagementUiEnabled) {
      document.getElementById('mv-aide-nav-subagents-btn')?.remove();
      if (activeCustomTab === 'subagents') closeCustomWorkbench();
    }
    // The three entries are independent: each switch above owns exactly its own
    // button, and ⚙️「mv-aide插件设置」 is unconditional — ≥0.1.7 dropped the host's
    // own settings slot, so this is the only remaining entry to that page.
    if (!navList) return;

    // 严密排除自定义按钮，仅获取官方原生导航按钮
    const allButtons = Array.from(navList.querySelectorAll('button[class*="_navCell"], button'));
    const nativeButtons = allButtons.filter(function(b) {
      return !b.id || !b.id.startsWith('mv-aide-nav-');
    });

    const pluginNavBtn = nativeButtons.find(function(b) {
      return b.textContent && (b.textContent.includes('插件') || b.textContent.includes('Plugins'));
    });

    const baseClassName = pluginNavBtn ? pluginNavBtn.className.replace(/\\b\\S*active\\S*\\b/gu, '').trim() : 'mv-aide-nav-cell';

    // 1. 挂载「✨ 技能」
    let skillBtn = document.getElementById('mv-aide-nav-skills-btn');
    if (policy.skillManagementUiEnabled && !skillBtn) {
      skillBtn = createNavButton('skills', '✨', '技能', baseClassName);

      // Hover and selection both come from DSH's own .navCell rules: our row
      // carries the same class token, so an inline paint here would only
      // outrank the host's stylesheet (and survive React's reconciliation).
      skillBtn.onclick = function(e) {
        e.preventDefault(); e.stopPropagation();
        openWorkbench('skills', navList);
      };

      if (pluginNavBtn && pluginNavBtn.nextSibling) {
        navList.insertBefore(skillBtn, pluginNavBtn.nextSibling);
      } else {
        navList.appendChild(skillBtn);
      }
    }

    // 2. 挂载「🤖 子智能体」
    let subagentBtn = document.getElementById('mv-aide-nav-subagents-btn');
    if (policy.presetManagementUiEnabled && !subagentBtn) {
      subagentBtn = createNavButton('subagents', '🤖', '子智能体', baseClassName);

      subagentBtn.onclick = function(e) {
        e.preventDefault(); e.stopPropagation();
        openWorkbench('subagents', navList);
      };

      if (skillBtn && skillBtn.nextSibling) {
        navList.insertBefore(subagentBtn, skillBtn.nextSibling);
      } else {
        navList.appendChild(subagentBtn);
      }
    }

    // 3. 挂载「⚙️ 设置」
    let settingsBtn = document.getElementById('mv-aide-nav-settings-btn');
    if (!settingsBtn) {
      settingsBtn = createNavButton('settings', '⚙️', 'mv-aide插件设置', baseClassName);

      settingsBtn.onclick = function(e) {
        e.preventDefault(); e.stopPropagation();
        openWorkbench('settings', navList);
      };

      if (subagentBtn && subagentBtn.nextSibling) {
        navList.insertBefore(settingsBtn, subagentBtn.nextSibling);
      } else {
        navList.appendChild(settingsBtn);
      }
    }

    // 监听仅限原生按钮的点击：把高亮交还给被点的原生行并卸下工作台
    nativeButtons.forEach(function(b) {
      if (!b.__mvAideBound__) {
        b.__mvAideBound__ = true;
        b.addEventListener('click', function() {
          closeCustomWorkbench(b);
        });
      }
    });
  }

  // ─────────────────────────────────────────────────────────────
  // 3. Custom Workbenches ("✨ 技能" & "🤖 子智能体")
  // ─────────────────────────────────────────────────────────────

  function openWorkbench(type, navList) {
    const policy = featurePolicy();
    if ((type === 'skills' && !policy.skillManagementUiEnabled)
        || (type === 'subagents' && !policy.presetManagementUiEnabled)) return;
    const list = navList || navListForTab(type);
    const host = resolveWorkbenchHost(list);
    // No settings panel on screen: leave the native pane alone instead of
    // hiding a body this script cannot replace.
    if (!host) return;
    activeCustomTab = type;
    applyWorkbenchNavState(list);
    hideOptions(host.options);
    restoreHiddenOptions(host.options);
    const root = mountWorkbench(type, host, workbenchMount ? workbenchMount.type : null);
    workbenchMount = {
      type: type,
      navList: list,
      scope: host.scope,
      content: host.content,
      options: host.options,
      root: root
    };
  }

  // ── 设置工作台（mv-AIDE 自持配置） ──
  /**
   * Page-scoped bridge exported by the subworkspace browser half, when loaded.
   *
   * 规范十.10 requires the bridge to carry a version field and the consumer to
   * check it: the two halves are separate injected modules that can be at
   * different versions for one page load, and rendering through a contract this
   * page does not know is worse than degrading to the read-only view below.
   */
  const SUBWORKSPACE_BRIDGE_VERSION = 1;
  function subworkspaceBridge() {
    const bridge = window.__MV_AIDE_SUBWORKSPACE__;
    if (!bridge || typeof bridge !== 'object') return null;
    if (bridge.version !== SUBWORKSPACE_BRIDGE_VERSION) return null;
    return typeof bridge.renderChildren === 'function' && typeof bridge.displayRows === 'function'
      ? bridge
      : null;
  }

  /** Same path comparison the store applies when it resolves a primary. */
  function pathKey(value) {
    return typeof value === 'string'
      ? value.replace(/[\\\\/]+/g, '\\\\').replace(/\\\\+$/, '').toLowerCase()
      : '';
  }

  function baseName(value) {
    const parts = String(value == null ? '' : value).split(/[\\\\/]/).filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] : String(value == null ? '' : value);
  }

  function settingsBadge(text) {
    const badge = document.createElement('span');
    badge.style.cssText = 'margin-left:6px; font-size:11px; padding:0 6px; border-radius:999px; background:var(--dsw-alias-bg-module-platform, rgba(255,255,255,0.12)); color:var(--dsw-alias-label-secondary, #d4d4d8);';
    badge.textContent = text;
    return badge;
  }

  /**
   * One collapsible settings card: a header button plus a body, closed unless
   * the user opened it (state survives re-renders through settingsCardsOpen).
   */
  function createSettingsCard(key, icon, title, summaryText) {
    const card = document.createElement('section');
    card.setAttribute('data-mv-aide-settings-card', key);
    card.style.cssText = 'border:1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.14)); border-radius:12px; background:var(--dsw-alias-bg-layer-1, rgba(255,255,255,0.04)); display:flex; flex-direction:column;';

    const header = document.createElement('button');
    header.type = 'button';
    header.setAttribute('data-mv-aide-settings-card-header', key);
    header.style.cssText = 'width:100%; display:flex; align-items:center; gap:10px; padding:12px 16px; border:0; border-radius:12px; background:none; color:inherit; font:inherit; text-align:left; cursor:pointer;';
    const iconEl = document.createElement('span');
    iconEl.textContent = icon;
    const titleEl = document.createElement('span');
    titleEl.style.cssText = 'flex:1; min-width:0; font-size:15px; font-weight:600;';
    titleEl.textContent = title;
    const summaryEl = document.createElement('span');
    summaryEl.setAttribute('data-mv-aide-settings-card-summary', key);
    summaryEl.style.cssText = 'flex:none; font-size:12px; color:var(--dsw-alias-label-tertiary, #a1a1aa); white-space:nowrap;';
    const badgeEl = document.createElement('span');
    badgeEl.setAttribute('data-mv-aide-settings-card-badge', key);
    badgeEl.style.cssText = 'flex:none; display:none; font-size:11px; padding:1px 6px; border-radius:999px; background:var(--dsw-alias-bg-module-platform, rgba(255,255,255,0.12)); color:var(--dsw-alias-label-secondary, #d4d4d8);';
    const chevronEl = document.createElement('span');
    chevronEl.style.cssText = 'flex:none; font-size:12px; color:var(--dsw-alias-label-tertiary, #a1a1aa); transition:transform 0.16s;';
    chevronEl.textContent = '▾';
    header.append(iconEl, titleEl, badgeEl, summaryEl, chevronEl);

    const body = document.createElement('div');
    body.setAttribute('data-mv-aide-settings-card-body', key);
    body.style.cssText = 'padding:0 16px 14px; flex-direction:column; gap:10px;';

    const apply = function() {
      const open = settingsCardsOpen[key] === true;
      body.style.display = open ? 'flex' : 'none';
      header.setAttribute('aria-expanded', String(open));
      chevronEl.style.transform = open ? 'rotate(0deg)' : 'rotate(-90deg)';
    };
    header.addEventListener('click', function(event) {
      event.preventDefault();
      settingsCardsOpen[key] = !(settingsCardsOpen[key] === true);
      apply();
      if (typeof body.dataset.mvAideOnOpen === 'string' && body.dataset.mvAideOnOpen === 'true') {
        // Sections that mount live content only while visible expose a hook here.
        if (typeof body.mvAideOnOpen === 'function') body.mvAideOnOpen();
      }
    });
    if (summaryText) summaryEl.textContent = summaryText;
    card.append(header, body);
    apply();
    return {
      card: card,
      body: body,
      setSummary: function(text) { summaryEl.textContent = text; },
      setBadge: function(text) {
        const value = typeof text === 'string' ? text : '';
        badgeEl.textContent = value;
        badgeEl.style.display = value ? '' : 'none';
      },
      isOpen: function() { return settingsCardsOpen[key] === true; },
    };
  }

  /** Persist one primary's enable flag through the subworkspace endpoint. */
  async function saveSubworkspaceEnabled(primary, enabled) {
    const response = await fetch('/api/mv-dsh-subworkspace/enabled', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ primary: primary, enabled: enabled === true }),
    });
    const payload = await response.json().catch(function() { return {}; });
    if (!response.ok || payload.ok === false) {
      throw new Error(payload.error || ('HTTP ' + response.status));
    }
    return payload;
  }

  /** Re-read the settings page (the tab the panel owns) when a bridge arrives late. */
  function ensureSubworkspaceBridgeListener() {
    if (subworkspaceBridgeListenerBound) return;
    subworkspaceBridgeListenerBound = true;
    window.addEventListener('mv-aide:subworkspace-available', function() {
      const root = workbenchRoot();
      if (root && activeCustomTab === 'settings') renderSettingsWorkbench(root);
    });
  }

  function renderSettingsWorkbench(container) {
    setStaticHtml(container,
      '<div style="width:100%; max-width:760px; display:flex; flex-direction:column; gap:14px;">' +
        '<div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:4px;">' +
          '<div>' +
            '<h2 style="margin:0; font-size:18px; font-weight:600; line-height:26px;">⚙️ mv-aide插件设置</h2>' +
            '<p style="margin:4px 0 0; font-size:13px; color:var(--dsw-alias-label-tertiary, #a1a1aa); line-height:20px;" id="mv-aide-settings-detail">读取中…</p>' +
          '</div>' +
          '<div style="display:flex; gap:8px;">' +
            '<button id="mv-aide-settings-reload" style="padding:6px 14px; border-radius:8px; border:1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.15)); background:var(--dsw-alias-bg-layer-1, rgba(255,255,255,0.08)); color:var(--dsw-alias-label-primary, #f4f4f5); cursor:pointer; font-size:13px; font-weight:500;">↻ 重新读取</button>' +
          '</div>' +
        '</div>' +
        '<div id="mv-aide-settings-body" style="display:flex; flex-direction:column; gap:14px;"></div>' +
      '</div>');

    const detailEl = container.querySelector('#mv-aide-settings-detail');
    const bodyEl = container.querySelector('#mv-aide-settings-body');
    const reloadBtn = container.querySelector('#mv-aide-settings-reload');

    // In-place summary refresh: a directory added or removed from a row's
    // manager updates counts without rebuilding the page (and without dropping
    // the expanded manager the user is working in).
    const refreshSummaries = function() {
      loadSettingsSnapshot().then(function(latest) {
        Object.keys(settingsSummaryRefreshers).forEach(function(key) {
          try {
            settingsSummaryRefreshers[key](latest);
          } catch (err) {
            // A section that no longer matches the document stays as it is.
          }
        });
      }).catch(function() {
        // The read failed; the rendered snapshot stays authoritative.
      });
    };

    const render = function(snapshot) {
      bodyEl.replaceChildren();
      settingsSummaryRefreshers = {};
      if (!snapshot) {
        detailEl.textContent = '无法读取设置（mv-dsh-manager 路由不可用）。';
        return;
      }
      detailEl.textContent = '配置文件：' + (snapshot.file || '（未知）');
      SETTINGS_NAMESPACES.forEach(function(spec) {
        bodyEl.appendChild(renderSettingsSection(snapshot, spec));
      });
      const sub = renderSubworkspaceSettingsSection(snapshot, refreshSummaries);
      if (sub) bodyEl.appendChild(sub);
    };

    const refresh = function() {
      detailEl.textContent = '读取中…';
      loadSettingsSnapshot().then(render).catch(function(err) {
        detailEl.textContent = '读取失败：' + (err && err.message ? err.message : String(err));
        render(currentSettingsSnapshot());
      });
    };

    ensureSubworkspaceBridgeListener();
    if (reloadBtn) reloadBtn.onclick = function(e) { e.preventDefault(); refresh(); };
    render(currentSettingsSnapshot());
    refresh();
  }

  /** One namespace card: boolean checkboxes plus bounded number inputs. */
  function renderSettingsSection(snapshot, spec) {
    const entry = snapshot && snapshot.namespaces ? snapshot.namespaces[spec.namespace] : null;
    const values = entry && entry.values ? entry.values : {};
    const user = entry && entry.user ? entry.user : {};
    const writable = Boolean(entry && entry.writable);
    const managedByDsh = Boolean(entry && entry.manage === 'dsh');

    const booleanFields = spec.fields.filter(function(field) { return field[1] === 'boolean'; });
    const enabledCount = booleanFields.filter(function(field) { return values[field[0]] === true; }).length;
    const cardApi = createSettingsCard(spec.namespace, spec.icon, spec.title, entry
      ? ('已开启 ' + enabledCount + ' / 共 ' + booleanFields.length + ' 项' + (managedByDsh ? ' · 由 DSH 面板管理' : ''))
      : '未在本实例中挂载');
    const card = cardApi.card;
    const body = cardApi.body;

    const detail = document.createElement('div');
    detail.style.cssText = 'font-size:12px; line-height:18px; color:var(--dsw-alias-label-tertiary, #a1a1aa);';
    detail.textContent = managedByDsh
      ? spec.detail + '（当前 DSH 版本由 DSH 设置面板管理，此处只读。）'
      : entry ? spec.detail : '该插件未在本实例中挂载。';
    body.appendChild(detail);

    const draft = {};
    const draftKeys = [];
    const fieldRows = [];
    // One failure line per field, so a rejected row reports in place instead of
    // only in the card footer (规范十.10).
    const rowFailures = {};

    spec.fields.forEach(function(field) {
      const key = field[0];
      const kind = field[1];
      const label = field[2];
      const hint = field[3];
      const min = field[4];
      const max = field[5];
      const row = document.createElement('label');
      row.style.cssText = 'display:flex; align-items:center; gap:10px; font-size:13px; padding:6px 0; border-top:1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.08));';

      const name = document.createElement('span');
      name.style.cssText = 'flex:1; min-width:0;';
      name.textContent = label;
      if (Object.prototype.hasOwnProperty.call(user, key)) {
        const badge = document.createElement('span');
        badge.style.cssText = 'margin-left:6px; font-size:11px; padding:0 6px; border-radius:999px; background:var(--dsw-alias-bg-module-platform, rgba(255,255,255,0.12)); color:var(--dsw-alias-label-secondary, #d4d4d8);';
        badge.textContent = '已覆盖';
        name.appendChild(badge);
      }

      let input;
      if (kind === 'boolean') {
        input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = values[key] === true;
        input.disabled = !writable;
      } else {
        input = document.createElement('input');
        input.type = 'text';
        input.inputMode = 'numeric';
        input.style.cssText = 'width:110px; height:30px; padding:0 8px; border-radius:8px; border:1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.18)); background:var(--dsw-alias-bg-layer-2, rgba(0,0,0,0.2)); color:inherit; font:inherit; font-size:13px;';
        input.value = String(values[key] == null ? '' : values[key]);
        input.disabled = !writable;
      }
      input.className = 'mv-aide-setting-input';
      input.addEventListener('change', function() {
        if (!draftKeys.includes(key)) draftKeys.push(key);
        if (kind === 'boolean') draft[key] = input.checked;
        else draft[key] = input.value;
        rowFailures[key].textContent = '';
        saveBtn.disabled = !writable;
        resetBtn.disabled = false;
        cardApi.setBadge('未保存');
        failed.textContent = '';
      });
      const failureLine = document.createElement('span');
      failureLine.style.cssText = 'flex:0 0 100%; font-size:12px; color:var(--dsw-alias-label-error, #f87171);';
      rowFailures[key] = failureLine;
      row.append(name, input, failureLine);
      fieldRows.push(row);
      body.appendChild(row);
    });

    const footer = document.createElement('div');
    footer.style.cssText = 'display:flex; align-items:center; justify-content:flex-end; gap:8px; padding-top:8px; border-top:1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.08));';
    const failed = document.createElement('span');
    failed.style.cssText = 'flex:1; min-width:0; font-size:12px; color:var(--dsw-alias-label-error, #f87171);';
    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.textContent = '放弃修改';
    resetBtn.disabled = true;
    resetBtn.style.cssText = 'padding:5px 12px; border-radius:8px; border:1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.18)); background:transparent; color:inherit; cursor:pointer; font-size:13px;';
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.textContent = '保存';
    saveBtn.disabled = true;
    saveBtn.style.cssText = 'padding:5px 14px; border-radius:8px; border:none; background:var(--dsw-alias-label-primary, #f4f4f5); color:var(--dsw-alias-bg-layer-2, #18181b); cursor:pointer; font-size:13px; font-weight:600;';

    const restoreDraftInputs = function() {
      draftKeys.length = 0;
      Object.keys(draft).forEach(function(k) { delete draft[k]; });
      spec.fields.forEach(function(field, index) {
        const input = fieldRows[index].querySelector('.mv-aide-setting-input');
        if (!input) return;
        if (field[1] === 'boolean') input.checked = values[field[0]] === true;
        else input.value = String(values[field[0]] == null ? '' : values[field[0]]);
      });
      saveBtn.disabled = true;
      resetBtn.disabled = true;
      failed.textContent = '';
    };

    const clearRowFailures = function() {
      Object.keys(rowFailures).forEach(function(key) { rowFailures[key].textContent = ''; });
    };

    resetBtn.onclick = function(e) {
      e.preventDefault();
      restoreDraftInputs();
      clearRowFailures();
      cardApi.setBadge('');
    };
    saveBtn.onclick = async function(e) {
      e.preventDefault();
      failed.textContent = '';
      clearRowFailures();
      const invalid = [];
      // What each pending row would write, resolved once so the commit loop
      // below only has to send it.
      const pending = [];
      draftKeys.forEach(function(key) {
        const field = spec.fields.find(function(f) { return f[0] === key; });
        if (!field) return;
        if (field[1] === 'boolean') {
          pending.push({ key: key, field: field, kind: 'set', value: draft[key] === true });
          return;
        }
        const text = String(draft[key]).trim();
        if (text === '') { pending.push({ key: key, field: field, kind: 'unset' }); return; }
        const numeric = Number(text);
        if (!Number.isInteger(numeric) || (field[4] !== undefined && (numeric < field[4] || numeric > field[5]))) {
          invalid.push(field[2]);
          rowFailures[key].textContent = '超出允许范围：' + field[2];
          return;
        }
        pending.push({ key: key, field: field, kind: 'set', value: numeric });
      });
      if (invalid.length > 0) {
        failed.textContent = '超出允许范围：' + invalid.join('、');
        return;
      }
      if (pending.length === 0) return;
      saveBtn.disabled = true;
      resetBtn.disabled = true;
      // Row by row, so a field the host refuses is reported on its own row and
      // the rows that did land stay landed (规范十.10). A single whole-namespace
      // write could only ever report one card-level failure.
      const rejected = [];
      let snapshotNext = null;
      for (const entry of pending) {
        const patch = entry.kind === 'unset'
          ? { set: {}, unset: [entry.key] }
          : { set: { [entry.key]: entry.value }, unset: [] };
        try {
          snapshotNext = await saveSettingsNamespace(spec.namespace, patch);
        } catch (err) {
          const message = err && err.message ? err.message : String(err);
          rejected.push(entry.field[2]);
          rowFailures[entry.key].textContent = message;
          continue;
        }
        // Only a row the host accepted leaves the draft.
        const at = draftKeys.indexOf(entry.key);
        if (at >= 0) draftKeys.splice(at, 1);
        delete draft[entry.key];
      }
      const next = snapshotNext && snapshotNext.namespaces ? snapshotNext.namespaces[spec.namespace] : null;
      if (next && next.values) {
        Object.assign(values, next.values);
        Object.keys(user).forEach(function(k) { delete user[k]; });
        Object.assign(user, next.user || {});
      }
      if (rejected.length > 0) {
        failed.textContent = '保存失败，草稿已保留：' + rejected.join('、');
        cardApi.setBadge('未保存');
        saveBtn.disabled = false;
        resetBtn.disabled = false;
        return;
      }
      saveBtn.disabled = true;
      resetBtn.disabled = true;
      cardApi.setBadge('');
      toast('设置已保存：' + spec.title, 'success');
      const bodyEl = document.getElementById('mv-aide-settings-body');
      if (bodyEl && snapshotNext) {
        const replacement = renderSettingsSection(snapshotNext, spec);
        card.replaceWith(replacement);
      }
    };

    if (!writable) {
      saveBtn.disabled = true;
      resetBtn.disabled = true;
    }
    footer.append(failed, resetBtn, saveBtn);
    body.appendChild(footer);
    return card;
  }

  /**
   * Associated-roots editor.
   *
   * Rows are every primary workspace DSH knows about plus configured-but-detached
   * ones, projected by the subworkspace browser half through the page bridge
   * (falling back to the stored rows when that half is absent). Expanding a row
   * hands the container to the same directory manager the workspace-row popover
   * uses, so adding, removing, the directory picker, validity markers and the
   * grey-out-when-disabled behaviour are identical on both surfaces.
   */
  function renderSubworkspaceSettingsSection(snapshot, requestSummaryRefresh) {
    const entry = snapshot && snapshot.namespaces ? snapshot.namespaces['mv-dsh-subworkspace'] : null;
    if (!entry) return null;
    const values = entry.values && typeof entry.values === 'object' ? entry.values : {};
    const user = entry.user && typeof entry.user === 'object' ? entry.user : {};
    const writable = Boolean(entry.writable);
    const managedByDsh = entry.manage === 'dsh';
    const bridge = subworkspaceBridge();

    const configuredOf = function(source) {
      const map = source && source.workspaces && typeof source.workspaces === 'object' ? source.workspaces : {};
      return map;
    };
    const overrideOf = function(source) {
      const map = source && source.workspaces && typeof source.workspaces === 'object' ? source.workspaces : {};
      return map;
    };
    const project = function(map) {
      const projected = bridge ? bridge.displayRows(map) : null;
      if (Array.isArray(projected)) return projected;
      return Object.keys(map).map(function(primary) {
        const record = map[primary] && typeof map[primary] === 'object' ? map[primary] : {};
        return {
          primary: primary,
          title: null,
          configured: true,
          detached: true,
          current: false,
          enabled: record.enabled === false ? false : true,
          childrenCount: Array.isArray(record.children) ? record.children.length : 0
        };
      });
    };

    const cardApi = createSettingsCard('mv-dsh-subworkspace', '🗂', 'mv-dsh-subworkspace（关联工作区）');
    const body = cardApi.body;

    const detail = document.createElement('div');
    detail.style.cssText = 'font-size:12px; line-height:18px; color:var(--dsw-alias-label-tertiary, #a1a1aa);';
    body.appendChild(detail);

    if (managedByDsh) {
      const managed = document.createElement('div');
      managed.style.cssText = detail.style.cssText;
      managed.textContent = '当前 DSH 版本由 DSH 设置面板管理该命名空间，此处只读。';
      body.appendChild(managed);
    } else if (!bridge) {
      const degraded = document.createElement('div');
      degraded.style.cssText = detail.style.cssText;
      degraded.textContent = '未加载子工作区客户端模块：这里只能看到已保存的关联目录；目录增删请用工作区行内的「关联工作区」按钮。';
      body.appendChild(degraded);
    }

    const errorEl = document.createElement('div');
    errorEl.style.cssText = 'font-size:12px; color:var(--dsw-alias-label-error, #f87171);';
    const rowsHost = document.createElement('div');
    rowsHost.style.cssText = 'display:flex; flex-direction:column;';
    body.append(rowsHost, errorEl);

    let rowRefs = [];

    // Pending enable flags keyed by primary workspace. A checkbox change stays
    // local until 「保存」, mirroring the native mv-dsh-subworkspace card: the
    // directory editor below each row still writes immediately.
    const draft = {};
    let saving = false;

    const footer = document.createElement('div');
    footer.style.cssText = 'display:flex; align-items:center; justify-content:flex-end; gap:8px; padding-top:8px; border-top:1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.08));';
    const failed = document.createElement('span');
    failed.setAttribute('data-mv-aide-subworkspace-failed', '');
    failed.style.cssText = 'flex:1; min-width:0; font-size:12px; line-height:17px; white-space:pre-line; color:var(--dsw-alias-label-error, #f87171);';
    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.textContent = '放弃修改';
    resetBtn.setAttribute('data-mv-aide-subworkspace-discard', '');
    resetBtn.style.cssText = 'padding:5px 12px; border-radius:8px; border:1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.18)); background:transparent; color:inherit; cursor:pointer; font-size:13px;';
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.textContent = '保存';
    saveBtn.setAttribute('data-mv-aide-subworkspace-save', '');
    saveBtn.style.cssText = 'padding:5px 14px; border-radius:8px; border:none; background:var(--dsw-alias-label-primary, #f4f4f5); color:var(--dsw-alias-bg-layer-2, #18181b); cursor:pointer; font-size:13px; font-weight:600;';
    footer.append(failed, resetBtn, saveBtn);
    body.appendChild(footer);

    const paintFooter = function() {
      const pending = Object.keys(draft).length;
      saveBtn.disabled = pending === 0 || saving || !writable || managedByDsh;
      resetBtn.disabled = pending === 0 || saving;
      saveBtn.textContent = saving ? '保存中…' : '保存';
      cardApi.setBadge(pending > 0 ? '未保存' : '');
      rowRefs.forEach(function(ref) {
        if (typeof ref.repaint === 'function') ref.repaint();
      });
    };

    const saveDrafts = async function() {
      const primaries = Object.keys(draft);
      if (primaries.length === 0 || saving) return;
      failed.textContent = '';
      saving = true;
      paintFooter();
      const failures = [];
      for (const primary of primaries) {
        const next = draft[primary] === true;
        const ref = rowRefs.find(function(item) { return item.primary === primary; });
        try {
          await saveSubworkspaceEnabled(primary, next);
          if (ref && typeof ref.settle === 'function') ref.settle(next);
          else delete draft[primary];
        } catch (err) {
          failures.push('· ' + primary + '：' + (err && err.message ? err.message : String(err)));
        }
      }
      saving = false;
      paintFooter();
      if (failures.length > 0) {
        failed.textContent = '保存失败，草稿已保留。\\n' + failures.join('\\n');
        return;
      }
      toast('关联工作区已更新', 'success');
      if (typeof requestSummaryRefresh === 'function') requestSummaryRefresh();
    };

    const discardDrafts = function() {
      Object.keys(draft).forEach(function(primary) { delete draft[primary]; });
      failed.textContent = '';
      errorEl.textContent = '';
      paintFooter();
    };

    saveBtn.addEventListener('click', function(event) { event.preventDefault(); void saveDrafts(); });
    resetBtn.addEventListener('click', function(event) { event.preventDefault(); discardDrafts(); });

    const setSummary = function(list) {
      const total = list.reduce(function(sum, row) { return sum + (Number(row.childrenCount) || 0); }, 0);
      cardApi.setSummary(list.length + ' 个主工作区 · ' + total + ' 个关联目录');
      detail.textContent = list.length === 0
        ? '当前没有关联工作区记录；展开某个主工作区后可以添加关联目录。'
        : '每个主工作区的开关决定其子工作区是否进入工具分发；展开可查看并增删关联目录。';
    };

    const buildRow = function(row) {
      let current = row;
      let overrides = overrideOf(user);
      let disposeChildren = null;

      const rowEl = document.createElement('div');
      rowEl.setAttribute('data-mv-aide-subworkspace-row', row.primary);
      rowEl.style.cssText = 'display:flex; flex-direction:column; gap:6px; padding:8px 0; border-top:1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.08));';
      const head = document.createElement('div');
      head.style.cssText = 'display:flex; align-items:center; gap:10px; font-size:13px;';
      const text = document.createElement('div');
      text.style.cssText = 'flex:1; min-width:0; display:flex; flex-direction:column; gap:2px;';
      const nameEl = document.createElement('span');
      nameEl.style.cssText = 'min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:500;';
      const pathEl = document.createElement('span');
      pathEl.style.cssText = 'min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:11px; color:var(--dsw-alias-label-tertiary, #a1a1aa);';
      text.append(nameEl, pathEl);

      const enableLabel = document.createElement('label');
      enableLabel.style.cssText = 'flex:none; display:flex; align-items:center; gap:6px; font-size:12px; color:var(--dsw-alias-label-secondary, #d4d4d8); cursor:pointer;';
      const enableText = document.createElement('span');
      enableText.textContent = '开启子工作区';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.style.cssText = 'margin:0; flex:none;';
      input.setAttribute('data-mv-aide-subworkspace-toggle', row.primary);
      input.setAttribute('aria-label', '开启子工作区: ' + row.primary);
      enableLabel.append(enableText, input);

      const disclose = document.createElement('button');
      disclose.type = 'button';
      disclose.setAttribute('data-mv-aide-subworkspace-disclose', row.primary);
      disclose.style.cssText = 'flex:none; display:flex; align-items:center; gap:4px; border:0; background:none; color:var(--dsw-alias-label-tertiary, #a1a1aa); font:inherit; font-size:12px; cursor:pointer;';
      const countEl = document.createElement('span');
      countEl.setAttribute('data-mv-aide-subworkspace-count', row.primary);
      const chevron = document.createElement('span');
      chevron.textContent = '▾';
      chevron.style.cssText = 'transition:transform 0.16s;';
      disclose.append(countEl, chevron);

      const manageHost = document.createElement('div');
      manageHost.setAttribute('data-mv-aide-subworkspace-manage', row.primary);
      manageHost.style.cssText = 'padding:2px 0 0;';

      const closeChildren = function() {
        if (!disposeChildren) return;
        const dispose = disposeChildren;
        disposeChildren = null;
        try {
          dispose();
        } catch (err) {
          // The container is already gone; nothing to release.
        }
      };
      const openChildren = function() {
        closeChildren();
        if (!bridge || managedByDsh) return;
        disposeChildren = bridge.renderChildren(manageHost, current.primary, {
          enabled: effectiveEnabled(),
          writable: writable,
          onChange: function() {
            if (typeof requestSummaryRefresh === 'function') requestSummaryRefresh();
          }
        });
      };
      const applyExpanded = function() {
        const expandable = Boolean(bridge) && !managedByDsh;
        const open = expandable && subworkspaceRowsOpen[current.primary] === true;
        disclose.style.display = expandable ? 'flex' : 'none';
        manageHost.style.display = open ? 'block' : 'none';
        disclose.setAttribute('aria-expanded', String(open));
        chevron.style.transform = open ? 'rotate(0deg)' : 'rotate(-90deg)';
        if (open) openChildren();
        else closeChildren();
      };
      const paintCount = function() {
        countEl.textContent = ((current.detached ? '已不在工作区列表 · 已配置 ' : '已配置 ')
          + (Number(current.childrenCount) || 0) + ' 个');
      };
      const paintName = function() {
        nameEl.replaceChildren(document.createTextNode(current.title || baseName(current.primary)));
        if (current.current) nameEl.appendChild(settingsBadge('当前'));
        if (Object.prototype.hasOwnProperty.call(overrides, current.primary)) nameEl.appendChild(settingsBadge('已覆盖'));
        pathEl.textContent = current.primary;
      };
      const effectiveEnabled = function() {
        return Object.prototype.hasOwnProperty.call(draft, row.primary) ? draft[row.primary] === true : current.enabled === true;
      };
      const paintSwitch = function() {
        input.checked = effectiveEnabled();
        input.disabled = !writable || managedByDsh;
      };

      disclose.addEventListener('click', function(event) {
        event.preventDefault();
        subworkspaceRowsOpen[current.primary] = !(subworkspaceRowsOpen[current.primary] === true);
        applyExpanded();
      });
      input.addEventListener('change', function() {
        errorEl.textContent = '';
        draft[row.primary] = input.checked;
        paintFooter();
      });

      head.append(text, enableLabel, disclose);
      rowEl.append(head, manageHost);
      paintName();
      paintCount();
      paintSwitch();
      applyExpanded();

      return {
        primary: row.primary,
        element: rowEl,
        update: function(next, nextUser) {
          current = next;
          overrides = overrideOf(nextUser);
          paintName();
          paintCount();
          paintSwitch();
          applyExpanded();
        },
        // A saved draft becomes the row's committed value.
        settle: function(enabled) {
          current = Object.assign({}, current, { enabled: enabled === true });
          delete draft[row.primary];
          paintSwitch();
          applyExpanded();
        },
        repaint: paintSwitch
      };
    };

    const renderRows = function(list) {
      rowsHost.replaceChildren();
      rowRefs = list.map(function(row) {
        const ref = buildRow(row);
        rowsHost.appendChild(ref.element);
        return ref;
      });
      setSummary(list);
    };

    const update = function(nextSnapshot) {
      const nextEntry = nextSnapshot && nextSnapshot.namespaces ? nextSnapshot.namespaces['mv-dsh-subworkspace'] : null;
      if (!nextEntry) return;
      const listed = project(configuredOf(nextEntry.values));
      const byPrimary = {};
      listed.forEach(function(row) { byPrimary[pathKey(row.primary)] = row; });
      rowRefs.forEach(function(ref) {
        const next = byPrimary[pathKey(ref.primary)];
        if (next) ref.update(next, overrideOf(nextEntry.user));
      });
      setSummary(listed);
    };

    renderRows(project(configuredOf(values)));
    paintFooter();
    settingsSummaryRefreshers['mv-dsh-subworkspace'] = update;
    return cardApi.card;
  }

  // ── 技能管理工作台 ──
  function renderSkillsWorkbench(container) {
    setStaticHtml(container,
      '<div style="width:100%; max-width:760px; display:flex; flex-direction:column; gap:14px;">' +
        '<div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:4px;">' +
          '<div>' +
            '<h2 style="margin:0; font-size:18px; font-weight:600; line-height:26px;">✨ 技能管理</h2>' +
            '<p style="margin:4px 0 0; font-size:13px; color:var(--dsw-alias-label-tertiary, #a1a1aa); line-height:20px;">展示 DSH 当前 winning skill catalog；只有官方可写 filesystem 来源支持调用策略修改、新建与删除。</p>' +
          '</div>' +
          '<div style="display:flex; gap:8px;">' +
            '<button id="mv-pm-open-skill-folder-btn" style="padding:6px 14px; border-radius:8px; border:1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.15)); background:var(--dsw-alias-bg-layer-1, rgba(255,255,255,0.08)); color:var(--dsw-alias-label-primary, #f4f4f5); cursor:pointer; font-size:13px; font-weight:500;">📂 打开目录</button>' +
            '<button id="mv-pm-new-skill-btn" style="padding:6px 14px; border-radius:8px; border:1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.15)); background:var(--dsw-alias-state-success-primary, #10b981); color:#fff; cursor:pointer; font-size:13px; font-weight:500;">+ 新建技能</button>' +
          '</div>' +
        '</div>' +
        '<div style="display:flex; gap:12px; align-items:center; width:100%;">' +
          '<input id="mv-pm-skill-search" type="search" placeholder="搜索技能 (名称 / 描述)..." style="flex:1; height:36px; padding:0 12px; border-radius:8px; border:1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.15)); background:var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.25)); color:var(--dsw-alias-label-primary, #fff); font-size:13px; outline:none;" />' +
          '<span id="mv-pm-skill-count" style="font-size:12px; color:var(--dsw-alias-label-tertiary, #888); white-space:nowrap;">正在加载...</span>' +
        '</div>' +
        '<div id="mv-pm-skills-list" style="display:flex; flex-direction:column; gap:10px; margin-top:6px;"></div>' +
      '</div>');

    const searchInput = document.getElementById('mv-pm-skill-search');
    const countSpan = document.getElementById('mv-pm-skill-count');
    const listDiv = document.getElementById('mv-pm-skills-list');
    const newBtn = document.getElementById('mv-pm-new-skill-btn');
    const openFolderBtn = document.getElementById('mv-pm-open-skill-folder-btn');

    openFolderBtn.onclick = function() {
      openFolder('/api/mv-aide/skills/open-folder');
    };

    newBtn.onclick = async function() {
      const values = await openForm({
        title: '新建技能',
        submitText: '创建',
        fields: [
          {
            key: 'name',
            label: '技能名称 (ID)',
            placeholder: 'code-reviewer',
            required: true,
            error: '请输入技能名称'
          },
          {
            key: 'description',
            label: '技能描述',
            type: 'textarea',
            placeholder: '用于告知模型与用户该技能的触发场景与功能'
          }
        ]
      });
      if (!values) return;
      const name = values.name;
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name)) {
        toast('技能名称不合法：DSH 只接受小写 kebab-case，例如 code-reviewer', 'error');
        return;
      }
      const desc = values.description;
      fetch('/api/mv-aide/skills/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name, description: desc || name, content: '# ' + name + '\\n\\n在这里编写技能的系统提示词与执行指南...' })
      }).then(function(r) { return r.json(); }).then(function(res) {
        if (res.ok) {
          toast('技能创建成功！', 'success');
          loadSkills();
        } else {
          toast('创建失败: ' + (res.error || '未知错误'), 'error');
        }
      });
    };

    let allSkills = [];

    function renderSkills() {
      const q = (searchInput.value || '').trim().toLowerCase();
      const filtered = allSkills.filter(function(s) {
        return s.name.toLowerCase().includes(q) || (s.description && s.description.toLowerCase().includes(q));
      });

      countSpan.textContent = '共 ' + allSkills.length + ' 个技能 (已筛选 ' + filtered.length + ' 个)';
      clearChildren(listDiv);

      if (filtered.length === 0) {
        setStaticHtml(listDiv, '<div style="padding:28px; text-align:center; color:var(--dsw-alias-label-tertiary, #888); font-size:13px; border:1px dashed var(--dsw-alias-border-l2, rgba(255,255,255,0.12)); border-radius:10px;">未找到匹配技能</div>');
        return;
      }

      filtered.forEach(function(skill) {
        const item = document.createElement('div');
        item.style.cssText = 'display:flex; justify-content:space-between; align-items:center; padding:12px 16px; border-radius:10px; background:var(--dsw-alias-bg-layer-3, rgba(255, 255, 255, 0.04)); border:1px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.08));';

        const left = document.createElement('div');
        left.style.cssText = 'flex: 1; min-width: 0; padding-right: 14px;';

        const nameRow = document.createElement('div');
        nameRow.style.cssText = 'display:flex; align-items:center; gap:8px;';
        const nameStrong = document.createElement('strong');
        nameStrong.style.cssText = 'font-size:14px; font-weight:600; color:var(--dsw-alias-label-primary, #fff);';
        nameStrong.textContent = skill.name;
        const idBadge = document.createElement('span');
        idBadge.style.cssText = 'font-size:11px; padding:1px 6px; border-radius:4px; background:var(--dsw-alias-bg-layer-1, rgba(255,255,255,0.08)); color:var(--dsw-alias-label-secondary, #aaa); font-family:var(--ds-font-family-code, monospace); font-weight:500;';
        idBadge.textContent = '/' + skill.id;
        const sourceBadge = document.createElement('span');
        sourceBadge.style.cssText = 'font-size:11px; padding:1px 6px; border-radius:4px; background:rgba(59,130,246,0.15); color:#60a5fa; font-weight:500;';
        sourceBadge.textContent = (skill.source || 'unknown') + ' · ' + (skill.provider || 'unknown');
        const policyBadge = document.createElement('span');
        policyBadge.style.cssText = 'font-size:11px; padding:1px 6px; border-radius:4px; background:rgba(16,185,129,0.15); color:#34d399; font-weight:500;';
        policyBadge.textContent = '模型:' + (skill.modelInvocable ? '开' : '关') + ' / 用户:' + (skill.userInvocable ? '开' : '关');
        nameRow.append(nameStrong, idBadge, sourceBadge, policyBadge);
        const descriptionLine = document.createElement('div');
        descriptionLine.style.cssText = 'font-size:12px; color:var(--dsw-alias-label-secondary, #888); margin-top:4px; line-height:18px;';
        descriptionLine.textContent = skill.description || '无描述';
        left.append(nameRow, descriptionLine);
        if (skill.whenToUse) {
          const whenLine = document.createElement('div');
          whenLine.style.cssText = 'font-size:11px; color:var(--dsw-alias-label-tertiary, #777); margin-top:2px; line-height:17px;';
          whenLine.textContent = 'whenToUse: ' + skill.whenToUse;
          left.appendChild(whenLine);
        }

        const right = document.createElement('div');
        right.style.cssText = 'display:flex; align-items:center; gap:8px; flex:none;';

        if (skill.writable) {
          const invocationEnabled = Boolean(skill.modelInvocable || skill.userInvocable);
          const toggleBtn = document.createElement('button');
          toggleBtn.type = 'button';
          toggleBtn.textContent = invocationEnabled ? '关闭调用' : '恢复调用';
          toggleBtn.style.cssText = [
            'padding: 4px 12px',
            'font-size: 12px',
            'font-weight: 500',
            'border-radius: 6px',
            'border: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.15))',
            'cursor: pointer',
            'background: var(--dsw-alias-bg-layer-1, rgba(255,255,255,0.08))',
            'color: var(--dsw-alias-label-secondary, #aaa)',
          ].join('; ');

          toggleBtn.onclick = async function() {
            toggleBtn.disabled = true;
            toggleBtn.textContent = '...';
            const res = await fetch('/api/mv-aide/skills/toggle', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ skillId: skill.id, disabled: invocationEnabled })
            });
            const d = await res.json();
            if (d && d.ok) {
              await loadSkills();
            } else {
              toast('操作失败: ' + (d.error || '未知错误'), 'error');
              await loadSkills();
            }
          };

          const delBtn = document.createElement('button');
          delBtn.type = 'button';
          delBtn.textContent = '删除';
          delBtn.style.cssText = 'padding:4px 10px; font-size:12px; font-weight:500; border-radius:6px; border:1px solid rgba(239, 68, 68, 0.3); background:transparent; color:#f87171; cursor:pointer;';
          delBtn.onclick = async function() {
            const confirmed = await confirmDialog({
              title: '删除技能',
              message: '确定要删除技能 "' + skill.name + '" 吗？此操作无法撤销。',
              danger: true
            });
            if (!confirmed) return;
            const res = await fetch('/api/mv-aide/skills/' + encodeURIComponent(skill.id), { method: 'DELETE' });
            const d = await res.json();
            if (d && d.ok) {
              await loadSkills();
            } else {
              toast('删除失败: ' + (d.error || '未知错误'), 'error');
              await loadSkills();
            }
          };

          right.appendChild(toggleBtn);
          right.appendChild(delBtn);
        } else {
          const readOnly = document.createElement('span');
          readOnly.style.cssText = 'font-size:11px; color:var(--dsw-alias-label-tertiary, #888);';
          readOnly.textContent = '只读来源';
          right.appendChild(readOnly);
        }

        item.appendChild(left);
        item.appendChild(right);
        listDiv.appendChild(item);
      });
    }

    async function loadSkills() {
      countSpan.textContent = '正在加载...';
      try {
        const data = await fetchManagerJson('/api/mv-aide/skills');
        allSkills = data.skills || [];
        renderSkills();
      } catch (err) {
        allSkills = [];
        renderLoadError(countSpan, listDiv, '技能', err, loadSkills);
      }
    }

    searchInput.oninput = renderSkills;
    loadSkills();
  }

  // ── 子智能体管理工作台 ──
  function renderSubagentsWorkbench(container) {
    setStaticHtml(container,
      '<div style="width:100%; max-width:760px; display:flex; flex-direction:column; gap:14px;">' +
        '<div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:4px;">' +
          '<div>' +
            '<h2 style="margin:0; font-size:18px; font-weight:600; line-height:26px;">🤖 子智能体管理</h2>' +
            '<p style="margin:4px 0 0; font-size:13px; color:var(--dsw-alias-label-tertiary, #a1a1aa); line-height:20px;">直接展示 DSH AgentPresets roster；克隆、删除与打开文档均通过官方 service。</p>' +
          '</div>' +
          '<div style="display:flex; gap:8px;">' +
            '<button id="mv-pm-new-preset-btn" style="padding:6px 14px; border-radius:8px; border:1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.15)); background:var(--dsw-alias-state-success-primary, #10b981); color:#fff; cursor:pointer; font-size:13px; font-weight:500;">+ 克隆预设</button>' +
          '</div>' +
        '</div>' +
        '<div style="display:flex; gap:12px; align-items:center; width:100%;">' +
          '<input id="mv-pm-preset-search" type="search" placeholder="搜索子智能体预设 (名称 / 描述)..." style="flex:1; height:36px; padding:0 12px; border-radius:8px; border:1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.15)); background:var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.25)); color:var(--dsw-alias-label-primary, #fff); font-size:13px; outline:none;" />' +
          '<span id="mv-pm-preset-count" style="font-size:12px; color:var(--dsw-alias-label-tertiary, #888); white-space:nowrap;">正在加载...</span>' +
        '</div>' +
        '<div id="mv-pm-presets-list" style="display:flex; flex-direction:column; gap:10px; margin-top:6px;"></div>' +
      '</div>');

    const searchInput = document.getElementById('mv-pm-preset-search');
    const countSpan = document.getElementById('mv-pm-preset-count');
    const listDiv = document.getElementById('mv-pm-presets-list');
    const newBtn = document.getElementById('mv-pm-new-preset-btn');

    let allPresets = [];

    newBtn.onclick = async function() {
      const values = await openForm({
        title: '新建子智能体预设',
        submitText: '创建',
        fields: [
          {
            key: 'sourceId',
            label: '源预设 ID',
            placeholder: 'standard 或 code',
            defaultValue: 'standard',
            required: true,
            error: '请输入作为模板的预设 ID'
          },
          {
            key: 'newId',
            label: '新预设 ID',
            placeholder: 'my-agent',
            required: true,
            error: '请输入新预设 ID'
          },
          {
            key: 'name',
            label: '显示名称',
            placeholder: '留空则使用新预设 ID'
          }
        ]
      });
      if (!values) return;
      if (!/^[a-z0-9][a-z0-9-]*$/u.test(values.newId)) {
        toast('新预设 ID 只能包含小写字母、数字和连字符，且不能以连字符开头', 'error');
        return;
      }
      fetch('/api/mv-aide/presets/copy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceId: values.sourceId, newId: values.newId, name: values.name || values.newId })
      }).then(function(r) { return r.json(); }).then(function(res) {
        if (res.ok) {
          toast('子智能体预设克隆创建成功！', 'success');
          loadPresets();
        } else {
          toast('克隆失败: ' + (res.error || '未知错误'), 'error');
        }
      });
    };

    function renderPresets() {
      const q = (searchInput.value || '').trim().toLowerCase();
      const filtered = allPresets.filter(function(p) {
        return p.id.toLowerCase().includes(q) || (p.name && p.name.toLowerCase().includes(q)) || (p.description && p.description.toLowerCase().includes(q));
      });

      countSpan.textContent = '共 ' + allPresets.length + ' 个预设 (已筛选 ' + filtered.length + ' 个)';
      clearChildren(listDiv);

      if (filtered.length === 0) {
        setStaticHtml(listDiv, '<div style="padding:28px; text-align:center; color:var(--dsw-alias-label-tertiary, #888); font-size:13px; border:1px dashed var(--dsw-alias-border-l2, rgba(255,255,255,0.12)); border-radius:10px;">未找到匹配预设</div>');
        return;
      }

      filtered.forEach(function(preset) {
        const item = document.createElement('div');
        item.style.cssText = 'display:flex; justify-content:space-between; align-items:center; padding:12px 16px; border-radius:10px; background:var(--dsw-alias-bg-layer-3, rgba(255, 255, 255, 0.04)); border:1px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.08));';

        // DSH's own layers (bundled presets, official-layer rows) are read-only
        // here: the service reports writable=false for them, and the older
        // trust==='system' marker stays as a fallback.
        const isSys = preset.writable === false || preset.trust === 'system';

        const left = document.createElement('div');
        left.style.cssText = 'flex: 1; min-width: 0; padding-right: 14px;';

        const nameRow = document.createElement('div');
        nameRow.style.cssText = 'display:flex; align-items:center; gap:8px;';
        const nameStrong = document.createElement('strong');
        nameStrong.style.cssText = 'font-size:14px; font-weight:600; color:var(--dsw-alias-label-primary, #fff);';
        nameStrong.textContent = preset.name;
        const idBadge = document.createElement('span');
        idBadge.style.cssText = 'font-size:11px; padding:1px 6px; border-radius:4px; background:var(--dsw-alias-bg-layer-1, rgba(255,255,255,0.08)); color:var(--dsw-alias-label-secondary, #aaa); font-family:var(--ds-font-family-code, monospace); font-weight:500;';
        idBadge.textContent = preset.id;
        const typeBadge = document.createElement('span');
        typeBadge.style.cssText = 'font-size:11px; padding:1px 6px; border-radius:4px; background:' + (isSys ? 'rgba(168,85,247,0.15)' : 'rgba(59,130,246,0.15)') + '; color:' + (isSys ? '#c084fc' : '#60a5fa') + '; font-weight:500;';
        typeBadge.textContent = isSys ? '系统内置' : '用户自定义';
        nameRow.append(nameStrong, idBadge, typeBadge);
        const descriptionLine = document.createElement('div');
        descriptionLine.style.cssText = 'font-size:12px; color:var(--dsw-alias-label-secondary, #888); margin-top:4px; line-height:18px;';
        descriptionLine.textContent = preset.description || '无描述';
        left.append(nameRow, descriptionLine);
        if (isSys) {
          const lockedHint = document.createElement('div');
          lockedHint.style.cssText = 'font-size:12px; color:var(--dsw-alias-label-tertiary, #888); margin-top:4px; line-height:18px;';
          lockedHint.textContent = '由 DSH 官方层提供，mv-AIDE 无法停用、克隆或删除。';
          left.append(lockedHint);
        }

        const right = document.createElement('div');
        right.style.cssText = 'display:flex; align-items:center; gap:8px; flex:none;';

        // 用户预设的启停 = 投影行 disabled 布尔（旧版 <id>.disabled 目录仍被识别）；
        // DSH 官方层预设没有可写行，因此这类行不渲染任何操作按钮。
        if (!isSys) {
          const toggleBtn = document.createElement('button');
          toggleBtn.type = 'button';
          toggleBtn.textContent = preset.enabled === false ? '启用' : '停用';
          toggleBtn.style.cssText = 'padding:4px 10px; font-size:12px; font-weight:500; border-radius:6px; border:1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.15)); background:var(--dsw-alias-bg-layer-1, rgba(255,255,255,0.08)); color:#fff; cursor:pointer;';
          toggleBtn.onclick = async function() {
            toggleBtn.disabled = true;
            toggleBtn.textContent = '...';
            try {
              await fetchManagerJson('/api/mv-aide/presets/toggle', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ presetId: preset.id, disabled: preset.enabled !== false })
              });
              await loadPresets();
            } catch (err) {
              toast('预设启停失败: ' + String(err instanceof Error ? err.message : err), 'error');
              await loadPresets();
            }
          };
          right.appendChild(toggleBtn);
        }

        // 克隆：需要源预设的作者目录，DSH 官方层预设没有作者目录。
        if (!isSys) {
          const cloneBtn = document.createElement('button');
          cloneBtn.type = 'button';
          cloneBtn.textContent = '以此克隆';
          cloneBtn.disabled = preset.enabled === false;
          cloneBtn.style.cssText = 'padding:4px 10px; font-size:12px; font-weight:500; border-radius:6px; border:1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.15)); background:var(--dsw-alias-bg-layer-1, rgba(255,255,255,0.08)); color:#fff; cursor:' + (preset.enabled === false ? 'not-allowed' : 'pointer') + '; opacity:' + (preset.enabled === false ? '0.55' : '1') + ';';
          cloneBtn.onclick = async function() {
            if (preset.enabled === false) return;
            const values = await openForm({
              title: '基于 ' + preset.id + ' 创建新预设',
              submitText: '克隆',
              fields: [
                {
                  key: 'newId',
                  label: '新预设 ID',
                  placeholder: 'my-agent-copy',
                  defaultValue: preset.id + '-copy',
                  required: true,
                  error: '请输入新预设 ID'
                },
                {
                  key: 'name',
                  label: '显示名称',
                  defaultValue: preset.name ? preset.name + ' (副本)' : preset.id + '-copy'
                }
              ]
            });
            if (!values) return;
            if (!/^[a-z0-9][a-z0-9-]*$/u.test(values.newId)) {
              toast('新预设 ID 只能包含小写字母、数字和连字符，且不能以连字符开头', 'error');
              return;
            }
            try {
              await fetchManagerJson('/api/mv-aide/presets/copy', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sourceId: preset.id, newId: values.newId, name: values.name || values.newId })
              });
              toast('克隆创建成功！', 'success');
              await loadPresets();
            } catch (err) {
              toast('克隆失败: ' + String(err instanceof Error ? err.message : err), 'error');
            }
          };
          right.appendChild(cloneBtn);
        }

        if (!isSys && preset.enabled !== false) {
          const openBtn = document.createElement('button');
          openBtn.type = 'button';
          openBtn.textContent = '打开';
          openBtn.style.cssText = 'padding:4px 10px; font-size:12px; font-weight:500; border-radius:6px; border:1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.15)); background:transparent; color:#fff; cursor:pointer;';
          openBtn.onclick = async function() {
            try {
              await fetchManagerJson('/api/mv-aide/presets/open-document', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ presetId: preset.id })
              });
            } catch (err) {
              toast('打开失败: ' + String(err instanceof Error ? err.message : err), 'error');
            }
          };
          right.appendChild(openBtn);
        }

        // 删除：DSH 官方层预设没有可删除的作者目录，故这一行不渲染删除。
        if (!isSys) {
          const delBtn = document.createElement('button');
          delBtn.type = 'button';
          delBtn.textContent = '删除';
          delBtn.style.cssText = 'padding:4px 10px; font-size:12px; font-weight:500; border-radius:6px; border:1px solid rgba(239, 68, 68, 0.3); background:transparent; color:#f87171; cursor:pointer;';
          delBtn.onclick = async function() {
            const confirmed = await confirmDialog({
              title: '删除子智能体预设',
              message: '确定要删除子智能体预设 "' + preset.name + '" 吗？此操作无法撤销。',
              danger: true
            });
            if (!confirmed) return;
            delBtn.disabled = true;
            delBtn.textContent = '...';
            try {
              await fetchManagerJson('/api/mv-aide/presets/' + encodeURIComponent(preset.id), { method: 'DELETE' });
              await loadPresets();
            } catch (err) {
              toast('删除失败: ' + String(err instanceof Error ? err.message : err), 'error');
              await loadPresets();
            }
          };
          right.appendChild(delBtn);
        }

        item.appendChild(left);
        item.appendChild(right);
        listDiv.appendChild(item);
      });
    }

    async function loadPresets() {
      countSpan.textContent = '正在加载...';
      try {
        const data = await fetchManagerJson('/api/mv-aide/presets');
        allPresets = data.presets || [];
        renderPresets();
      } catch (err) {
        allPresets = [];
        renderLoadError(countSpan, listDiv, '子智能体预设', err, loadPresets);
      }
    }

    searchInput.oninput = renderPresets;
    loadPresets();
  }

  // ─────────────────────────────────────────────────────────────
  // 4. Scan & Lifecycle Observer
  // ─────────────────────────────────────────────────────────────

  const CARD_SELECTOR = 'li[data-plugin-entry], li[class*="_card"], div[class*="_card"]';
  const NAV_SELECTOR = 'div[class*="_navList"], nav div:has(button[class*="_navCell"])';
  const HEADING_SELECTOR = 'div[class*="_catalogHeading"]';
  const ROOT_SELECTOR = CARD_SELECTOR + ', ' + NAV_SELECTOR + ', ' + HEADING_SELECTOR + ', div[class*="_options"]';
  let roots = [];
  let scanQueued = false;
  let policySignature = '';
  let scanningDisposed = false;
  let fallbackTimer = null;

  function currentPolicySignature() {
    const policy = featurePolicy();
    return [policy.pluginManagementUiEnabled, policy.skillManagementUiEnabled, policy.presetManagementUiEnabled].join(':');
  }

  function scanAll() {
    if (scanningDisposed || !document.body) return;
    roots = Array.from(document.querySelectorAll(ROOT_SELECTOR));
    policySignature = currentPolicySignature();
    scanCards(roots.filter(function(root) { return root.matches(CARD_SELECTOR); }), roots.find(function(root) { return root.matches(HEADING_SELECTOR); }));
    injectSidebarNav(roots.find(function(root) { return root.matches(NAV_SELECTOR); }));
    // Reactive panes re-render (and re-mount our host) without any tree
    // mutation this scan tracks, so the workbench re-asserts itself here.
    syncWorkbench();
  }

  function scheduleScan() {
    if (scanningDisposed || scanQueued) return;
    scanQueued = true;
    queueMicrotask(function() { scanQueued = false; scanAll(); });
  }

  function containsRoot(node) {
    if (node.nodeType !== 1) return false;
    // The workbench root is not a scan target, but its insertion or removal is
    // exactly the event the mount invariant must react to.
    if (node.id === 'mv-aide-custom-workbench-root' || node.querySelector('#mv-aide-custom-workbench-root')) return true;
    return node.matches(ROOT_SELECTOR) || node.querySelector(ROOT_SELECTOR);
  }

  window.addEventListener('mv-aide:manager-feature-policy', scheduleScan);
  const observer = new MutationObserver(function(records) {
    if (scanningDisposed) return;
    const relevant = records.some(function(record) {
      const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
      if (target && roots.some(function(root) { return root.contains(target); })) return true;
      if (record.type === 'attributes') return target && target.matches(ROOT_SELECTOR);
      return Array.from(record.addedNodes).some(containsRoot) || Array.from(record.removedNodes).some(containsRoot);
    });
    if (relevant) scheduleScan();
  });

  function startObserving() {
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'data-plugin-entry'] });
    scanAll();
  }

  if (document.body) {
    startObserving();
  } else {
    document.addEventListener('DOMContentLoaded', startObserving, { once: true });
  }

  // Keep late-mount recovery, but an unchanged settings tree needs no rescan.
  function checkRoots() {
    if (scanningDisposed) return;
    if (policySignature !== currentPolicySignature() || roots.some(function(root) { return !root.isConnected; }) ||
        (roots.length === 0 && document.querySelector(ROOT_SELECTOR))) scheduleScan();
    // The workbench's host pane and root belong to React: keep the mount
    // invariant without a full rescan.
    else if (activeCustomTab || hiddenOptions.length > 0) syncWorkbench();
  }
  fallbackTimer = setInterval(checkRoots, 600);
  window.addEventListener('pagehide', function() {
    scanningDisposed = true;
    observer.disconnect();
    if (fallbackTimer !== null) clearInterval(fallbackTimer);
    fallbackTimer = null;
    window.removeEventListener('mv-aide:manager-feature-policy', scheduleScan);
    document.removeEventListener('DOMContentLoaded', startObserving);
  });
  window.addEventListener('pageshow', function() {
    if (!scanningDisposed) return;
    scanningDisposed = false;
    window.addEventListener('mv-aide:manager-feature-policy', scheduleScan);
    startObserving();
    fallbackTimer = setInterval(checkRoots, 600);
  });
})();
`;

export const UI_SCRIPT_TAG = `<script id="mv-aide-dsh-manager-ui">${UI_SCRIPT_BODY}</script>`;
