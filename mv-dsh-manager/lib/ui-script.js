// Web UI Client Injected Script for @mv-aide/mv-dsh-manager
// Aligned 1:1 with DSH Official rc.5 Source Code DOM & Component Contracts

export const UI_SCRIPT_BODY = `
(function() {
  if (window.__MV_DSH_MANAGER_INITIALIZED__) return;
  window.__MV_DSH_MANAGER_INITIALIZED__ = true;

  let activeCustomTab = null; // 'skills' | 'subagents' | null

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

    const isRisky = entryId.startsWith('@deepseek-ai/') || entryId.startsWith('cordis:') || entryId.includes('mv-dsh-manager') || entryId.includes('mv-agent');

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

  function injectCatalogToolbar() {
    const heading = document.querySelector('div[class*="_catalogHeading"]');
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

  function scanCards() {
    const cards = document.querySelectorAll('li[data-plugin-entry], li[class*="_card"], div[class*="_card"]');
    for (let i = 0; i < cards.length; i++) {
      injectCardButtons(cards[i]);
    }
    injectCatalogToolbar();
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
      'background: transparent',
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

  function injectSidebarNav() {
    const navList = document.querySelector('div[class*="_navList"], nav div:has(button[class*="_navCell"])');
    if (!navList) return;

    // 严密排除自定义按钮，仅获取官方原生导航按钮
    const allButtons = Array.from(navList.querySelectorAll('button[class*="_navCell"], button'));
    const nativeNavButtons = allButtons.filter(function(b) {
      return !b.id || !b.id.startsWith('mv-aide-nav-');
    });

    const pluginNavBtn = nativeNavButtons.find(function(b) {
      return b.textContent && (b.textContent.includes('插件') || b.textContent.includes('Plugins'));
    });

    const baseClassName = pluginNavBtn ? pluginNavBtn.className.replace(/\\b\\S*active\\S*\\b/gu, '').trim() : 'mv-aide-nav-cell';

    let activeClass = '';
    nativeNavButtons.forEach(function(b) {
      const match = b.className.match(/\\b(\\S*active\\S*)\\b/u);
      if (match && !activeClass) activeClass = match[1];
    });

    // 1. 挂载「✨ 技能」
    let skillBtn = document.getElementById('mv-aide-nav-skills-btn');
    if (!skillBtn) {
      skillBtn = createNavButton('skills', '✨', '技能', baseClassName);

      skillBtn.onmouseenter = function() {
        if (activeCustomTab !== 'skills') skillBtn.style.background = 'var(--dsw-specific-sidebar-nav-item-hover, var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, 0.06)))';
      };
      skillBtn.onmouseleave = function() {
        if (activeCustomTab !== 'skills') skillBtn.style.background = 'transparent';
      };
      skillBtn.onclick = function(e) {
        e.preventDefault(); e.stopPropagation();
        openWorkbench('skills', activeClass);
      };

      if (pluginNavBtn && pluginNavBtn.nextSibling) {
        navList.insertBefore(skillBtn, pluginNavBtn.nextSibling);
      } else {
        navList.appendChild(skillBtn);
      }
    }

    // 2. 挂载「🤖 子智能体」
    let subagentBtn = document.getElementById('mv-aide-nav-subagents-btn');
    if (!subagentBtn) {
      subagentBtn = createNavButton('subagents', '🤖', '子智能体', baseClassName);

      subagentBtn.onmouseenter = function() {
        if (activeCustomTab !== 'subagents') subagentBtn.style.background = 'var(--dsw-specific-sidebar-nav-item-hover, var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, 0.06)))';
      };
      subagentBtn.onmouseleave = function() {
        if (activeCustomTab !== 'subagents') subagentBtn.style.background = 'transparent';
      };
      subagentBtn.onclick = function(e) {
        e.preventDefault(); e.stopPropagation();
        openWorkbench('subagents', activeClass);
      };

      if (skillBtn && skillBtn.nextSibling) {
        navList.insertBefore(subagentBtn, skillBtn.nextSibling);
      } else {
        navList.appendChild(subagentBtn);
      }
    }

    // 监听仅限原生按钮的点击：重置自定义高亮与工作台
    nativeNavButtons.forEach(function(b) {
      if (!b.__mvAideBound__) {
        b.__mvAideBound__ = true;
        b.addEventListener('click', function() {
          activeCustomTab = null;
          const s = document.getElementById('mv-aide-nav-skills-btn');
          const a = document.getElementById('mv-aide-nav-subagents-btn');
          if (s) { s.style.background = 'transparent'; s.removeAttribute('aria-current'); if (activeClass) s.classList.remove(activeClass); }
          if (a) { a.style.background = 'transparent'; a.removeAttribute('aria-current'); if (activeClass) a.classList.remove(activeClass); }

          const customWorkbench = document.getElementById('mv-aide-custom-workbench-root');
          if (customWorkbench) customWorkbench.remove();

          const origOptions = document.querySelector('div[class*="_options"]');
          if (origOptions) origOptions.style.display = '';
        });
      }
    });

    // 如果处于自定义激活态，确保原生选项卡保持隐藏
    if (activeCustomTab) {
      const origOptions = document.querySelector('div[class*="_options"]');
      if (origOptions && origOptions.style.display !== 'none') {
        origOptions.style.display = 'none';
      }
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 3. Custom Workbenches ("✨ 技能" & "🤖 子智能体")
  // ─────────────────────────────────────────────────────────────

  function openWorkbench(type, activeClass) {
    activeCustomTab = type;

    // 清理所有原生按钮高亮
    const navList = document.querySelector('div[class*="_navList"], nav div:has(button[class*="_navCell"])');
    if (navList) {
      const nativeNavButtons = Array.from(navList.querySelectorAll('button[class*="_navCell"], button')).filter(function(b) {
        return !b.id || !b.id.startsWith('mv-aide-nav-');
      });
      nativeNavButtons.forEach(function(b) {
        if (activeClass) b.classList.remove(activeClass);
        b.removeAttribute('aria-current');
        b.style.background = 'transparent';
      });
    }

    const sBtn = document.getElementById('mv-aide-nav-skills-btn');
    const aBtn = document.getElementById('mv-aide-nav-subagents-btn');
    const activeBg = 'var(--dsw-specific-sidebar-nav-item-active, var(--dsw-alias-bg-layer-1, rgba(255, 255, 255, 0.12)))';

    if (sBtn) {
      if (type === 'skills') {
        sBtn.style.background = activeBg;
        sBtn.setAttribute('aria-current', 'true');
        if (activeClass) sBtn.classList.add(activeClass);
      } else {
        sBtn.style.background = 'transparent';
        sBtn.removeAttribute('aria-current');
        if (activeClass) sBtn.classList.remove(activeClass);
      }
    }

    if (aBtn) {
      if (type === 'subagents') {
        aBtn.style.background = activeBg;
        aBtn.setAttribute('aria-current', 'true');
        if (activeClass) aBtn.classList.add(activeClass);
      } else {
        aBtn.style.background = 'transparent';
        aBtn.removeAttribute('aria-current');
        if (activeClass) aBtn.classList.remove(activeClass);
      }
    }

    const contentArea = document.querySelector('div[class*="_content"]');
    if (!contentArea) return;

    const origOptions = contentArea.querySelector('div[class*="_options"]');
    if (origOptions) origOptions.style.display = 'none';

    let customRoot = document.getElementById('mv-aide-custom-workbench-root');
    if (!customRoot) {
      customRoot = document.createElement('div');
      customRoot.id = 'mv-aide-custom-workbench-root';
      customRoot.style.cssText = 'flex:1; min-height:0; padding:0 24px 24px; overflow-y:auto; color:var(--dsw-alias-label-primary, #fff); font-family:inherit; box-sizing:border-box;';
      contentArea.appendChild(customRoot);
    }
    customRoot.style.display = 'block';

    if (type === 'skills') {
      renderSkillsWorkbench(customRoot);
    } else {
      renderSubagentsWorkbench(customRoot);
    }
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

        const isSys = preset.trust === 'system';

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

        const right = document.createElement('div');
        right.style.cssText = 'display:flex; align-items:center; gap:8px; flex:none;';

        // 用户预设通过 <id>.disabled 目录真实隐藏/恢复；系统预设保持不可停用。
        const toggleBtn = document.createElement('button');
        toggleBtn.type = 'button';
        toggleBtn.textContent = isSys ? '系统启用' : (preset.enabled === false ? '启用' : '停用');
        toggleBtn.disabled = isSys;
        toggleBtn.style.cssText = 'padding:4px 10px; font-size:12px; font-weight:500; border-radius:6px; border:1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.15)); background:var(--dsw-alias-bg-layer-1, rgba(255,255,255,0.08)); color:' + (isSys ? '#777' : '#fff') + '; cursor:' + (isSys ? 'not-allowed' : 'pointer') + ';';
        if (!isSys) {
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
        }
        right.appendChild(toggleBtn);

        // 克隆
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

        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.textContent = '删除';
        delBtn.style.cssText = 'padding:4px 10px; font-size:12px; font-weight:500; border-radius:6px; border:1px solid rgba(239, 68, 68, 0.3); background:transparent; color:#f87171; cursor:pointer;';
        delBtn.onclick = async function() {
          const confirmed = await confirmDialog({
            title: isSys ? '高危删除系统预设' : '删除子智能体预设',
            message: isSys
              ? '⚠️ 预设 "' + preset.name + '" 是 DeepSeek 官方系统内置预设。删除会直接移除其实际目录，并可能破坏默认会话能力。确定继续吗？'
              : '确定要删除子智能体预设 "' + preset.name + '" 吗？此操作无法撤销。',
            danger: true
          });
          if (!confirmed) return;
          delBtn.disabled = true;
          delBtn.textContent = '...';
          try {
            const suffix = isSys ? '?force=true' : '';
            await fetchManagerJson('/api/mv-aide/presets/' + encodeURIComponent(preset.id) + suffix, { method: 'DELETE' });
            await loadPresets();
          } catch (err) {
            toast('删除失败: ' + String(err instanceof Error ? err.message : err), 'error');
            await loadPresets();
          }
        };
        right.appendChild(delBtn);

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

  function scanAll() {
    scanCards();
    injectSidebarNav();
  }

  const observer = new MutationObserver(function() {
    scanAll();
  });

  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true });
    scanAll();
  } else {
    document.addEventListener('DOMContentLoaded', function() {
      observer.observe(document.body, { childList: true, subtree: true });
      scanAll();
    });
  }

  setInterval(scanAll, 600);
})();
`;

export const UI_SCRIPT_TAG = `<script id="mv-aide-dsh-manager-ui">${UI_SCRIPT_BODY}</script>`;
