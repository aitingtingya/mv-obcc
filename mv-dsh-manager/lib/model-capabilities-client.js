// Browser half of the llm-pi-ai model capability editor.
//
// DSH 0.1.1 has no nested client slot inside a model row. This isolated
// module therefore augments that one native surface through its stable
// structural contract: the per-row disclosure and the editor's action row,
// both read through mv-dsh-compat rather than through localized captions, so a
// reworded label in the host cannot break it. It does not inspect hashed CSS
// module names itself and it owns every node/listener it adds.

window.__ModuleLoader__.load({
  id: '@mv-aide/mv-dsh-manager/model-capabilities-client',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const compat = require('@mv-aide/mv-dsh-compat/client/manager');
    const { modelRowDisclosure, editorActionRow, editorActionButton, mutationAffectsModelSettings } = compat;

    const INSTALL_KEY = '__MV_AIDE_MODEL_CAPABILITIES_CLIENT__';
    const API_PATH = '/api/mv-aide/model-capabilities';
    const COMPAT_GROUPS = [
      {
        title: ['推理兼容', 'Reasoning compatibility'],
        fields: [
          'supportsReasoningEffort', 'thinkingFormat', 'requiresThinkingAsText',
          'requiresReasoningContentOnAssistantMessages', 'supportsThinkingTokenBudget',
        ],
      },
      {
        title: ['请求与流', 'Requests and streaming'],
        fields: ['supportsStore', 'supportsDeveloperRole', 'supportsUsageInStreaming', 'supportsFinishReason', 'maxTokensField'],
      },
      {
        title: ['工具与严格模式', 'Tools and strict mode'],
        fields: [
          'requiresToolResultName', 'requiresAssistantAfterToolResult', 'supportsStrictMode',
          'supportsStrictTools', 'supportsEagerToolInputStreaming',
        ],
      },
      {
        title: ['缓存与 Anthropic 兼容', 'Caching and Anthropic compatibility'],
        fields: [
          'cacheControlFormat', 'supportsLongCacheRetention', 'supportsCacheControlOnTools',
          'supportsTemperature', 'forceAdaptiveThinking', 'allowEmptySignature',
        ],
      },
    ];
    const COMPAT_LABELS = {
      supportsStore: ['支持 store 参数', 'Supports store'],
      supportsDeveloperRole: ['支持 developer 角色', 'Supports developer role'],
      supportsReasoningEffort: ['支持 reasoning_effort', 'Supports reasoning effort'],
      supportsUsageInStreaming: ['流式响应返回 usage', 'Usage in streaming'],
      maxTokensField: ['输出上限参数名', 'Max-tokens field'],
      requiresToolResultName: ['工具结果必须带名称', 'Tool results require names'],
      requiresAssistantAfterToolResult: ['工具结果后需要 assistant 消息', 'Assistant required after tool result'],
      requiresThinkingAsText: ['思考内容按文本发送', 'Send thinking as text'],
      requiresReasoningContentOnAssistantMessages: ['回放 assistant 时携带 reasoning_content', 'Reasoning content on assistant replay'],
      thinkingFormat: ['思考参数格式', 'Thinking format'],
      supportsStrictMode: ['支持严格模式', 'Supports strict mode'],
      cacheControlFormat: ['缓存控制格式', 'Cache-control format'],
      supportsLongCacheRetention: ['支持长缓存保留', 'Supports long cache retention'],
      supportsEagerToolInputStreaming: ['支持工具输入即时流式传输', 'Eager tool-input streaming'],
      supportsCacheControlOnTools: ['工具定义支持缓存控制', 'Cache control on tools'],
      supportsTemperature: ['支持 temperature', 'Supports temperature'],
      forceAdaptiveThinking: ['强制自适应思考', 'Force adaptive thinking'],
      allowEmptySignature: ['允许空思考签名', 'Allow empty thinking signature'],
      supportsStrictTools: ['支持 Anthropic 严格工具', 'Supports strict tools'],
      supportsFinishReason: ['支持 finish reason', 'Supports finish reason'],
      supportsThinkingTokenBudget: ['支持思考 token 预算', 'Supports thinking token budget'],
    };
    const COPY = {
      zh: {
        title: '模型能力',
        input: '输入模态', inherit: '继承', custom: '自定义', text: '文本', image: '图片',
        reasoning: '思考能力', reasoningOff: '非思考模型', reasoningCustom: '自定义思考等级',
        level: 'DSH 等级', wire: '供应商参数值', addLevel: '添加思考等级', remove: '删除', up: '上移', down: '下移',
        expert: '专家兼容参数', kwargs: 'chatTemplateKwargs', args: 'chatTemplateArgs', addKwarg: '添加模板参数',
        key: '参数名', type: '类型', value: '值', omitWhenOff: '关闭思考时省略',
        yes: '是', no: '否', string: '字符串', number: '数字', boolean: '布尔', null: 'null',
        builtinTitle: 'DSH 内置模型',
        builtinWarning: '这是 DSH 内置模型；保存会创建当前模型的 modelOverrides，不会修改或复制整个内置目录。',
        inheritNote: '「继承」表示不为该模型写入这项设置：保存时会移除对应覆盖，实际生效的是供应商级配置或 DSH 内置目录的默认值；只有明确选择或填写后才为该模型写一条覆盖。',
        context: '上下文窗口', maxTokens: '最大输出 token', name: '显示名称',
        retry: '重试能力保存', partial: '基础模型已保存、模型能力未保存：',
        close: '关闭', debugRetry: '查看重试请求',
        syncFailed: '模型行与服务端不一致，已停止保存；请重新打开该提供方后重试：',
        pickProvider: '无法确定写入目标：请选择该卡片对应的提供方',
        pickProviderHint: '这个卡片没有可精确识别的提供方身份，选择后本次保存才会写入。',
        deepseekFamily: 'DSH 内置 DeepSeek 模型目录', piAiFamily: '其它提供方（llm-pi-ai）',
        imageBudget: '图片像素预算', imageMaxBytes: '单图最大字节', imageBudgetLow: '低细节（512×512）',
        saved: '模型能力已保存。', unsupported: '当前 DSH 版本不支持完整的模型能力配置。',
        readOnly: '当前 DSH 设置为只读，模型能力不可编辑。',
        catalogUnavailable: '内置模型目录暂不可用；请先保存/启用该提供方后重试。',
        inputRequired: '自定义输入模态至少选择一项。',
        reasoningRequired: '思考模型至少需要一个非 off 等级。',
        duplicateLevel: '思考等级不能重复。', wireRequired: '非 off 等级必须填写供应商参数值。',
        duplicateKey: '模板参数名不能重复。', keyRequired: '模板参数名不能为空。',
        positiveCapacity: '容量必须是正整数，可使用 K/M 后缀。',
        loadFailed: '模型能力加载失败：',
        nativeExtras: '原生思考等级补充', resetField: '恢复继承',
        nativeSaveUnconfirmed: '尚未确认原生模型保存成功；模型能力未写入，请重试保存。',
      },
      en: {
        nativeExtras: 'Native reasoning extras', resetField: 'Restore inheritance',
        nativeSaveUnconfirmed: 'Native model save was not confirmed; capabilities were not written. Retry saving.',
        title: 'Model capabilities',
        input: 'Input modalities', inherit: 'Inherit', custom: 'Custom', text: 'Text', image: 'Image',
        reasoning: 'Reasoning', reasoningOff: 'Non-reasoning model', reasoningCustom: 'Custom reasoning levels',
        level: 'DSH level', wire: 'Provider wire value', addLevel: 'Add reasoning level', remove: 'Remove', up: 'Move up', down: 'Move down',
        expert: 'Expert compatibility', kwargs: 'chatTemplateKwargs', args: 'chatTemplateArgs', addKwarg: 'Add template argument',
        key: 'Key', type: 'Type', value: 'Value', omitWhenOff: 'Omit when reasoning is off',
        yes: 'Yes', no: 'No', string: 'String', number: 'Number', boolean: 'Boolean', null: 'null',
        builtinTitle: 'DSH built-in models',
        builtinWarning: 'This is a DSH built-in model. Saving creates modelOverrides for this model; it does not modify or copy the full catalog.',
        inheritNote: "'Inherit' keeps this setting unwritten for the model: saving removes the override, so the provider-level configuration or DSH built-in catalog default applies. Only an explicit choice writes a per-model override.",
        context: 'Context window', maxTokens: 'Max output tokens', name: 'Display name',
        retry: 'Retry capability save', partial: 'The base model was saved, but model capabilities were not: ',
        close: 'Close', debugRetry: 'Show retry request',
        syncFailed: 'The model rows no longer match the server; the save was stopped. Reopen this provider and try again: ',
        pickProvider: 'Cannot determine the write target: choose this card\'s provider',
        pickProviderHint: 'This card exposes no reliable provider identity, so pick one before capabilities can be saved.',
        deepseekFamily: "DSH's built-in DeepSeek catalog", piAiFamily: 'Other providers (llm-pi-ai)',
        imageBudget: 'Image pixel budget', imageMaxBytes: 'Max bytes per image', imageBudgetLow: 'Low detail (512×512)',
        saved: 'Model capabilities saved.', unsupported: 'This DSH version does not support the complete model capability schema.',
        readOnly: 'DSH settings are read-only; model capabilities cannot be edited.',
        catalogUnavailable: 'The built-in catalog is not available yet. Save/enable this provider and try again.',
        inputRequired: 'Choose at least one custom input modality.',
        reasoningRequired: 'A reasoning model needs at least one non-off level.',
        duplicateLevel: 'Reasoning levels must be unique.', wireRequired: 'Every non-off level needs a provider wire value.',
        duplicateKey: 'Template argument keys must be unique.', keyRequired: 'Template argument keys cannot be empty.',
        positiveCapacity: 'Capacities must be positive integers and may use K/M suffixes.',
        loadFailed: 'Model capabilities failed to load: ',
      },
    };

    function language() {
      const lang = String(document.documentElement?.lang || navigator.language || '').toLowerCase();
      if (lang.startsWith('zh')) return 'zh';
      if ([...document.querySelectorAll('section[aria-label]')]
        .some((node) => node.getAttribute('aria-label') === '模型目录')) return 'zh';
      return 'en';
    }

    function copy() {
      return COPY[language()];
    }

    function element(tag, attributes, ...children) {
      const node = document.createElement(tag);
      for (const [key, value] of Object.entries(attributes || {})) {
        if (key === 'className') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'checked') node.checked = Boolean(value);
        else if (key === 'disabled') node.disabled = Boolean(value);
        else if (key === 'value') node.value = value == null ? '' : String(value);
        else if (value !== undefined && value !== null) node.setAttribute(key, String(value));
      }
      node.append(...children.filter(Boolean));
      return node;
    }

    function clone(value) {
      return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
    }

    function hasOwn(source, key) {
      return source != null && Object.prototype.hasOwnProperty.call(source, key);
    }

    async function managerJson(path, options) {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 10000);
      try {
        const response = await window.fetch(path, { ...(options || {}), signal: controller.signal });
        let data;
        try {
          data = await response.json();
        } catch {
          throw new Error(`HTTP ${response.status}`);
        }
        if (!response.ok || data?.ok !== true) throw new Error(data?.error || `HTTP ${response.status}`);
        return data;
      } finally {
        window.clearTimeout(timer);
      }
    }

    function modelSections() {
      return compat.modelCatalogSections(document);
    }

    function modelIdInputs(section) {
      return compat.modelIdInputs(section);
    }

    function modelIdInput(entry) {
      return compat.modelIdInputs(entry)[0];
    }

    function editorRoot(section) {
      return compat.modelEditorRoot(section);
    }

    function installStyle() {
      if (document.getElementById('mv-aide-model-capabilities-style')) return;
      const style = element('style', { id: 'mv-aide-model-capabilities-style' });
      style.textContent = `
        .mv-aide-model-capabilities{margin-top:14px;padding-top:14px;border-top:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.13));font:inherit;color:inherit}
        .mv-aide-cap-title{font-size:13px;font-weight:650;margin:0 0 10px}.mv-aide-cap-note{margin:7px 0 10px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#a1a1aa)}
        .mv-aide-cap-warning{padding:8px 10px;margin:0 0 10px;border:1px solid rgba(245,158,11,.32);border-radius:8px;background:rgba(245,158,11,.09);font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary,#f4f4f5)}
        .mv-aide-cap-field{display:grid;grid-template-columns:minmax(130px,.7fr) minmax(180px,1.3fr);gap:8px 12px;align-items:center;margin:8px 0}.mv-aide-cap-label{font-size:12px;color:var(--dsw-alias-label-secondary,#a1a1aa)}
        .mv-aide-cap-input,.mv-aide-cap-select{width:100%;min-height:34px;padding:5px 9px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.15));background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.055));color:inherit;font:inherit;font-size:12px;box-sizing:border-box}
        .mv-aide-cap-checks{display:flex;flex-wrap:wrap;gap:10px 16px;align-items:center}.mv-aide-cap-check{display:inline-flex;gap:6px;align-items:center;font-size:12px}.mv-aide-cap-check input{margin:0}
        .mv-aide-cap-rows{display:flex;flex-direction:column;gap:7px;margin-top:7px}.mv-aide-cap-row{display:grid;grid-template-columns:minmax(90px,.8fr) minmax(130px,1.4fr) auto;gap:7px;align-items:center}
        .mv-aide-cap-row.mv-aide-cap-kwarg{grid-template-columns:minmax(90px,1fr) minmax(90px,.8fr) minmax(100px,1.2fr) auto}.mv-aide-cap-actions{display:flex;gap:4px}
        .mv-aide-cap-button{min-height:30px;padding:3px 9px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.15));background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer}.mv-aide-cap-button:disabled{opacity:.5;cursor:default}
        .mv-aide-cap-expert{margin-top:12px}.mv-aide-cap-expert>summary{cursor:pointer;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#a1a1aa)}.mv-aide-cap-expert-body{margin-top:10px}
        .mv-aide-cap-group{margin:12px 0}.mv-aide-cap-group-title{font-size:11px;font-weight:650;margin:0 0 5px;color:var(--dsw-alias-label-secondary,#a1a1aa)}
        .mv-aide-cap-error{margin:9px 0 0;padding:7px 9px;border-radius:7px;background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.3);color:#fca5a5;font-size:12px;line-height:18px}
        .mv-aide-builtin-catalog{margin:12px 0}.mv-aide-builtin-head{font-size:12px;font-weight:650;margin:0 0 8px}.mv-aide-builtin-entry{border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));border-radius:9px;margin:7px 0;overflow:hidden}
        .mv-aide-builtin-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:center;padding:8px 10px}.mv-aide-builtin-name{min-width:0;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mv-aide-builtin-body{padding:0 10px 10px}
        .mv-aide-cap-partial{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483600;width:min(720px,calc(100vw - 32px));padding:11px 13px;border-radius:10px;border:1px solid rgba(239,68,68,.45);background:var(--dsw-alias-bg-layer-2,#18181b);box-shadow:0 12px 34px rgba(0,0,0,.42);font:inherit;font-size:12px;line-height:18px;color:inherit}.mv-aide-cap-partial.mv-aide-cap-success{border-color:rgba(16,185,129,.5)}.mv-aide-cap-partial-actions{display:flex;justify-content:flex-end;margin-top:8px}
        @media(max-width:640px){.mv-aide-cap-field{grid-template-columns:1fr}.mv-aide-cap-row,.mv-aide-cap-row.mv-aide-cap-kwarg{grid-template-columns:1fr}.mv-aide-cap-actions{justify-content:flex-end}}
      `;
      (document.head || document.documentElement).appendChild(style);
    }

    function select(options, value, onChange, disabled) {
      const node = element('select', { className: 'mv-aide-cap-select', disabled });
      for (const option of options) {
        node.appendChild(element('option', { value: option.value, text: option.label }));
      }
      node.value = value;
      node.addEventListener('change', () => onChange(node.value));
      return node;
    }

    function field(label, control) {
      return element('label', { className: 'mv-aide-cap-field' },
        element('span', { className: 'mv-aide-cap-label', text: label }), control);
    }

    function triState(value, onChange, disabled) {
      const t = copy();
      return select([
        { value: 'inherit', label: t.inherit },
        { value: 'true', label: t.yes },
        { value: 'false', label: t.no },
      ], value === undefined ? 'inherit' : String(value), (next) => {
        onChange(next === 'inherit' ? undefined : next === 'true');
      }, disabled);
    }

    function capacity(text) {
      const match = String(text).trim().match(/^(\d+(?:\.\d+)?)\s*([kKmM]?)$/u);
      if (!match) return undefined;
      const multiplier = match[2].toLowerCase() === 'm' ? 1000000 : match[2].toLowerCase() === 'k' ? 1000 : 1;
      const value = Number(match[1]) * multiplier;
      return Number.isSafeInteger(value) && value > 0 ? value : undefined;
    }

    function spelling(value) {
      if (!Number.isSafeInteger(value) || value <= 0) return '';
      if (value % 1000000 === 0) return `${value / 1000000}M`;
      if (value % 1000 === 0) return `${value / 1000}K`;
      return String(value);
    }

    function kwargRows(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
      return Object.entries(value).map(([key, entry]) => {
        if (entry === null) return { key, type: 'null', value: '', omitWhenOff: false };
        if (typeof entry === 'boolean') return { key, type: 'boolean', value: String(entry), omitWhenOff: false };
        if (typeof entry === 'number') return { key, type: 'number', value: String(entry), omitWhenOff: false };
        if (entry && typeof entry === 'object' && typeof entry.$var === 'string') {
          return { key, type: entry.$var, value: '', omitWhenOff: entry.omitWhenOff === true };
        }
        return { key, type: 'string', value: typeof entry === 'string' ? entry : '', omitWhenOff: false };
      });
    }

    function makeDraft(family, kind, explicit, effective, options, support) {
      const compat = explicit?.compat && typeof explicit.compat === 'object' ? clone(explicit.compat) : {};
      const reasoning = explicit?.reasoningEfforts;
      const objectCompatFields = Array.isArray(options.objectCompatFields)
        ? options.objectCompatFields : ['chatTemplateKwargs'];
      if (family === 'deepseek') {
        const explicitModalities = explicit?.inputModalities;
        const effectiveModalities = effective?.inputModalities;
        const modes = Array.isArray(explicitModalities)
          ? [...explicitModalities]
          : Array.isArray(effectiveModalities) ? [...effectiveModalities] : ['text'];
        return {
          family,
          kind: 'catalog',
          explicit: clone(explicit || {}),
          effective: clone(effective || {}),
          dirty: false,
          error: '',
          panel: null,
          support: support || {},
          inputMode: 'custom',
          input: modes,
          budget: hasOwn(explicit, 'imagePixelBudget') ? String(explicit.imagePixelBudget) : '',
          maxImageBytes: hasOwn(explicit, 'imageMaxBytes') ? String(explicit.imageMaxBytes) : '',
          name: hasOwn(explicit, 'name') ? String(explicit.name) : '',
          contextWindow: hasOwn(explicit, 'contextWindow') ? spelling(explicit.contextWindow) : '',
          maxTokens: hasOwn(explicit, 'maxTokens') ? spelling(explicit.maxTokens) : '',
          options,
        };
      }
      return {
        family: 'pi-ai',
        kind,
        explicit: clone(explicit || {}),
        effective: clone(effective || {}),
        dirty: false,
        error: '',
        panel: null,
        support: support || {},
        inputMode: hasOwn(explicit, 'input') ? 'custom' : 'inherit',
        input: Array.isArray(explicit?.input) ? [...explicit.input] : [],
        reasoningMode: !hasOwn(explicit, 'reasoningEfforts') ? 'inherit' : reasoning === false ? 'off' : 'custom',
        reasoningRows: reasoning && typeof reasoning === 'object'
          ? Object.entries(reasoning).map(([level, value]) => ({ level, value: value == null ? '' : String(value) }))
          : [],
        compat,
        templateObjects: Object.fromEntries(objectCompatFields.map((field) => [field, kwargRows(compat[field])])),
        name: hasOwn(explicit, 'name') ? String(explicit.name) : '',
        contextWindow: hasOwn(explicit, 'contextWindow') ? spelling(explicit.contextWindow) : '',
        maxTokens: hasOwn(explicit, 'maxTokens') ? spelling(explicit.maxTokens) : '',
        options,
      };
    }

    function dirty(draft) {
      draft.dirty = true;
      draft.error = '';
    }

    function renderReasoningRows(container, draft, disabled, rerender) {
      const t = copy();
      const rows = element('div', { className: 'mv-aide-cap-rows' });
      draft.reasoningRows.forEach((row, index) => {
        const level = select(draft.options.thinkingLevels.map((item) => ({ value: item, label: item })), row.level,
          (value) => { row.level = value; dirty(draft); }, disabled);
        level.setAttribute('aria-label', t.level);
        const value = element('input', {
          className: 'mv-aide-cap-input', value: row.value, placeholder: row.level === 'off' ? t.inherit : t.wire,
          'aria-label': t.wire, disabled,
        });
        value.addEventListener('input', () => { row.value = value.value; dirty(draft); });
        const actions = element('span', { className: 'mv-aide-cap-actions' });
        [['↑', t.up, -1], ['↓', t.down, 1]].forEach(([glyph, title, offset]) => {
          const button = element('button', {
            type: 'button', className: 'mv-aide-cap-button', text: glyph, title,
            disabled: disabled || index + offset < 0 || index + offset >= draft.reasoningRows.length,
          });
          button.addEventListener('click', () => {
            const [moved] = draft.reasoningRows.splice(index, 1);
            draft.reasoningRows.splice(index + offset, 0, moved);
            dirty(draft); rerender();
          });
          actions.appendChild(button);
        });
        const remove = element('button', { type: 'button', className: 'mv-aide-cap-button', text: '×', title: t.remove, disabled });
        remove.addEventListener('click', () => { draft.reasoningRows.splice(index, 1); dirty(draft); rerender(); });
        actions.appendChild(remove);
        rows.appendChild(element('div', { className: 'mv-aide-cap-row' }, level, value, actions));
      });
      const add = element('button', { type: 'button', className: 'mv-aide-cap-button', text: `＋ ${t.addLevel}`, disabled });
      add.addEventListener('click', () => {
        const unused = draft.options.thinkingLevels.find((level) => !draft.reasoningRows.some((row) => row.level === level));
        draft.reasoningRows.push({ level: unused || 'medium', value: '' });
        dirty(draft); rerender();
      });
      container.append(rows, add);
    }

    function renderKwargs(container, draft, fieldName, disabled, rerender) {
      const t = copy();
      const rows = element('div', { className: 'mv-aide-cap-rows' });
      const entries = draft.templateObjects[fieldName];
      const types = [
        ['string', t.string], ['number', t.number], ['boolean', t.boolean], ['null', t.null],
        ...draft.options.chatTemplateVars.map((entry) => [entry, `$var: ${entry}`]),
      ];
      entries.forEach((row, index) => {
        const key = element('input', { className: 'mv-aide-cap-input', value: row.key, placeholder: t.key, disabled });
        key.addEventListener('input', () => { row.key = key.value; dirty(draft); });
        const type = select(types.map(([value, label]) => ({ value, label })), row.type, (value) => {
          row.type = value; dirty(draft); rerender();
        }, disabled);
        let value;
        if (draft.options.chatTemplateVars.includes(row.type)) {
          const check = element('input', { type: 'checkbox', checked: row.omitWhenOff, disabled });
          check.addEventListener('change', () => { row.omitWhenOff = check.checked; dirty(draft); });
          value = element('label', { className: 'mv-aide-cap-check' }, check, element('span', { text: t.omitWhenOff }));
        } else if (row.type === 'null') {
          value = element('span', { className: 'mv-aide-cap-label', text: 'null' });
        } else if (row.type === 'boolean') {
          value = select([{ value: 'true', label: t.yes }, { value: 'false', label: t.no }], row.value || 'false',
            (next) => { row.value = next; dirty(draft); }, disabled);
        } else {
          value = element('input', { className: 'mv-aide-cap-input', value: row.value, placeholder: t.value, disabled });
          value.addEventListener('input', () => { row.value = value.value; dirty(draft); });
        }
        const remove = element('button', { type: 'button', className: 'mv-aide-cap-button', text: '×', title: t.remove, disabled });
        remove.addEventListener('click', () => { entries.splice(index, 1); dirty(draft); rerender(); });
        rows.appendChild(element('div', { className: 'mv-aide-cap-row mv-aide-cap-kwarg' }, key, type, value, remove));
      });
      const add = element('button', { type: 'button', className: 'mv-aide-cap-button', text: `＋ ${t.addKwarg}`, disabled });
      add.addEventListener('click', () => { entries.push({ key: '', type: 'string', value: '', omitWhenOff: false }); dirty(draft); rerender(); });
      container.append(rows, add);
    }

    /** The built-in DeepSeek catalog: inputModalities + the adapter's image limits. */
    function renderDeepseekPanel(panel, draft, disabled, rerender) {
      const t = copy();
      const checks = element('span', { className: 'mv-aide-cap-checks' });
      for (const modality of draft.options.modalities) {
        const box = element('input', { type: 'checkbox', checked: draft.input.includes(modality), disabled });
        box.setAttribute('aria-label', `${t.input} ${t[modality] || modality}`);
        box.addEventListener('change', () => {
          draft.input = box.checked
            ? [...new Set([...draft.input, modality])]
            : draft.input.filter((entry) => entry !== modality);
          dirty(draft);
          rerender();
        });
        checks.appendChild(element('label', { className: 'mv-aide-cap-check' }, box, element('span', { text: t[modality] || modality })));
      }
      if (!draft.native?.input) panel.appendChild(field(t.input, checks));

      if (draft.input.includes('image')) {
        const budget = element('select', { className: 'mv-aide-cap-select', disabled });
        budget.appendChild(element('option', { value: '', text: `${t.inherit} (${String(draft.options.deepseekDefaults.imagePixelBudget)})` }));
        budget.appendChild(element('option', { value: 'low', text: t.imageBudgetLow }));
        budget.appendChild(element('option', { value: 'custom', text: t.custom }));
        const current = draft.budget === ''
          ? ''
          : draft.budget === 'low' ? 'low' : 'custom';
        budget.value = current;
        budget.setAttribute('aria-label', t.imageBudget);
        const custom = element('input', {
          className: 'mv-aide-cap-input', value: draft.budget === 'low' ? '' : draft.budget,
          disabled: disabled || current !== 'custom', inputMode: 'numeric', 'aria-label': `${t.imageBudget} value`,
        });
        budget.addEventListener('change', () => {
          draft.budget = budget.value === 'custom' ? '640000' : budget.value;
          dirty(draft);
          rerender();
        });
        custom.addEventListener('input', () => { draft.budget = custom.value; dirty(draft); });
        panel.appendChild(field(t.imageBudget, element('div', {}, budget, custom)));

        const maxBytes = element('input', {
          className: 'mv-aide-cap-input', value: draft.maxImageBytes, placeholder: t.inherit,
          disabled, inputMode: 'numeric', 'aria-label': t.imageMaxBytes,
        });
        maxBytes.addEventListener('input', () => { draft.maxImageBytes = maxBytes.value; dirty(draft); });
        panel.appendChild(field(t.imageMaxBytes, maxBytes));
      }

      [['name', t.name], ['contextWindow', t.context], ['maxTokens', t.maxTokens]].forEach(([key, label]) => {
        const effective = key === 'maxTokens' ? draft.effective.maxTokens : draft.effective[key];
        const inherited = effective === undefined
          ? t.inherit
          : `${t.inherit} (${key === 'name' ? String(effective) : spelling(effective)})`;
        const input = element('input', {
          className: 'mv-aide-cap-input', value: draft[key], placeholder: inherited, disabled,
          inputMode: key === 'name' ? 'text' : 'numeric',
        });
        input.addEventListener('input', () => { draft[key] = input.value; dirty(draft); });
        panel.appendChild(field(label, input));
      });
      if (draft.error) panel.appendChild(element('p', { className: 'mv-aide-cap-error', text: draft.error, role: 'alert' }));
    }

    function nativeReasoningOrder(draft, values) {
      const order = [...(draft.reasoningOrder || Object.keys(values)).filter(key => hasOwn(values, key)),
        ...Object.keys(values).filter(key => draft.reasoningOrder && !draft.reasoningOrder.includes(key))];
      if (draft.reasoningOrder) draft.reasoningOrder = order;
      return order;
    }

    // Reconcile only manager-owned rows. Native edits must not rebuild the
    // expert form, reset disclosures, or replace an input the user is editing.
    function renderNativeReasoningExtras(extra, draft, disabled) {
      const t = copy();
      const values = compat.nativeReasoningValues(draft.nativeRoot) || {};
      const order = nativeReasoningOrder(draft, values);
      const rows = new Map([...extra.querySelectorAll(':scope > [data-mv-aide-reasoning-level]')]
        .map(row => [row.getAttribute('data-mv-aide-reasoning-level'), row]));
      for (const [level, row] of rows) if (!hasOwn(values, level)) row.remove();
      order.forEach((level, index) => {
        let row = rows.get(level);
        if (!row) {
          row = element('span', { className: 'mv-aide-cap-actions', 'data-mv-aide-reasoning-level': level },
            element('span', { text: level }));
          for (const [glyph, title, offset] of [['↑', t.up, -1], ['↓', t.down, 1]]) {
            const button = element('button', { type: 'button', className: 'mv-aide-cap-button', text: glyph, title });
            button.addEventListener('click', () => {
              const next = nativeReasoningOrder(draft, compat.nativeReasoningValues(draft.nativeRoot) || {});
              const at = next.indexOf(level);
              if (at < 0 || at + offset < 0 || at + offset >= next.length) return;
              [next[at], next[at + offset]] = [next[at + offset], next[at]];
              draft.reasoningOrder = next;
              dirty(draft);
              renderNativeReasoningExtras(extra, draft, disabled);
            });
            row.appendChild(button);
          }
          if (level === 'off') {
            const input = element('input', { className: 'mv-aide-cap-input', 'aria-label': t.wire });
            input.addEventListener('input', () => { draft.offWire = input.value; dirty(draft); });
            row.appendChild(input);
          }
        }
        const buttons = row.querySelectorAll('button');
        buttons[0].disabled = disabled || index === 0;
        buttons[1].disabled = disabled || index === order.length - 1;
        const input = row.querySelector('input');
        if (input) {
          const value = draft.offWire ?? values.off ?? '';
          if (input.value !== value) input.value = value;
          input.disabled = disabled;
        }
        const position = extra.children[index + 1];
        if (position !== row) extra.insertBefore(row, position || null);
      });
    }

    function renderCapabilityPanel(panel, draft, disabled, builtin) {
      const t = copy();
      panel.replaceChildren();
      draft.panel = panel;
      const rerender = () => renderCapabilityPanel(panel, draft, disabled, builtin);
      panel.appendChild(element('div', { className: 'mv-aide-cap-title', text: t.title }));
      if (draft.family === 'deepseek') {
        panel.appendChild(element('p', { className: 'mv-aide-cap-note', text: t.inheritNote }));
        renderDeepseekPanel(panel, draft, disabled, rerender);
        return;
      }
      if (builtin) panel.appendChild(element('p', { className: 'mv-aide-cap-warning', text: t.builtinWarning }));
      panel.appendChild(element('p', { className: 'mv-aide-cap-note', text: t.inheritNote }));

      if (builtin) {
        [['name', t.name], ['contextWindow', t.context], ['maxTokens', t.maxTokens]].forEach(([key, label]) => {
          const effective = key === 'maxTokens' ? draft.effective.defaultMaxTokens : draft.effective[key];
          const inherited = effective === undefined
            ? t.inherit
            : `${t.inherit} (${key === 'name' ? String(effective) : spelling(effective)})`;
          const input = element('input', {
            className: 'mv-aide-cap-input', value: draft[key], placeholder: inherited, disabled,
            inputMode: key === 'name' ? 'text' : 'numeric',
          });
          input.addEventListener('input', () => { draft[key] = input.value; dirty(draft); });
          panel.appendChild(field(label, input));
        });
      }

      const inputControls = element('div', {});
      const inputMode = select([
        { value: 'inherit', label: t.inherit }, { value: 'custom', label: t.custom },
      ], draft.inputMode, (value) => { draft.inputMode = value; dirty(draft); rerender(); }, disabled);
      const checks = element('span', { className: 'mv-aide-cap-checks' });
      for (const modality of draft.options.modalities) {
        const box = element('input', { type: 'checkbox', checked: draft.input.includes(modality), disabled: disabled || draft.inputMode !== 'custom' });
        box.addEventListener('change', () => {
          draft.input = box.checked ? [...new Set([...draft.input, modality])] : draft.input.filter((entry) => entry !== modality);
          dirty(draft);
        });
        checks.appendChild(element('label', { className: 'mv-aide-cap-check' }, box, element('span', { text: t[modality] || modality })));
      }
      inputControls.append(inputMode, checks);
      if (!draft.native?.input) panel.appendChild(field(t.input, inputControls));
      else {
        const reset = element('button', { type: 'button', className: 'mv-aide-cap-button', text: `${t.input}: ${t.resetField}`, disabled });
        reset.addEventListener('click', () => { draft.inputMode = 'inherit'; draft.resetNativeInput = true; dirty(draft); });
        panel.appendChild(reset);
      }

      const reasoning = element('div', {});
      reasoning.appendChild(select([
        { value: 'inherit', label: t.inherit },
        { value: 'off', label: t.reasoningOff },
        { value: 'custom', label: t.reasoningCustom },
      ], draft.reasoningMode, (value) => { draft.reasoningMode = value; dirty(draft); rerender(); }, disabled));
      if (draft.reasoningMode === 'custom') renderReasoningRows(reasoning, draft, disabled, rerender);
      if (!draft.native?.reasoning) panel.appendChild(field(t.reasoning, reasoning));
      else {
        const extra = element('details', { className: 'mv-aide-cap-expert', 'data-mv-aide-native-reasoning': '' },
          element('summary', { text: t.nativeExtras }));
        const reset = element('button', { type: 'button', className: 'mv-aide-cap-button', text: t.resetField, disabled });
        reset.addEventListener('click', () => { draft.resetNativeReasoning = true; dirty(draft); });
        extra.appendChild(reset);
        renderNativeReasoningExtras(extra, draft, disabled);
        panel.appendChild(extra);
      }

      const expert = element('details', { className: 'mv-aide-cap-expert' });
      expert.appendChild(element('summary', { text: t.expert }));
      const expertBody = element('div', { className: 'mv-aide-cap-expert-body' });
      for (const group of COMPAT_GROUPS) {
        const section = element('section', { className: 'mv-aide-cap-group' },
          element('h5', { className: 'mv-aide-cap-group-title', text: group.title[language() === 'zh' ? 0 : 1] }));
        for (const key of group.fields) {
          const isBoolean = draft.options.booleanCompatFields.includes(key);
          const isEnum = Object.hasOwn(draft.options.enumCompatFields, key);
          if (!isBoolean && !isEnum) continue;
          let control;
          if (isBoolean) {
            control = triState(draft.compat[key], (value) => {
              if (value === undefined) delete draft.compat[key]; else draft.compat[key] = value;
              dirty(draft);
            }, disabled);
          } else {
            const choices = draft.options.enumCompatFields[key] || [];
            control = select([{ value: '', label: t.inherit }, ...choices.map((value) => ({ value, label: value }))],
              draft.compat[key] || '', (value) => {
                if (value === '') delete draft.compat[key]; else draft.compat[key] = value;
                dirty(draft);
              }, disabled);
          }
          const labels = COMPAT_LABELS[key];
          section.appendChild(field(labels ? labels[language() === 'zh' ? 0 : 1] : key, control));
        }
        expertBody.appendChild(section);
      }
      for (const fieldName of Object.keys(draft.templateObjects)) {
        const template = element('section', { className: 'mv-aide-cap-group' },
          element('h5', { className: 'mv-aide-cap-group-title', text: fieldName === 'chatTemplateArgs' ? t.args : t.kwargs }));
        renderKwargs(template, draft, fieldName, disabled, rerender);
        expertBody.appendChild(template);
      }
      expert.appendChild(expertBody);
      panel.appendChild(expert);
      if (draft.error) panel.appendChild(element('p', { className: 'mv-aide-cap-error', text: draft.error, role: 'alert' }));
    }

    function serializeKwargs(draft, rows) {
      const result = {};
      for (const row of rows) {
        if (row.type === 'null') result[row.key] = null;
        else if (row.type === 'number') result[row.key] = Number(row.value);
        else if (row.type === 'boolean') result[row.key] = row.value === 'true';
        else if (draft.options.chatTemplateVars.includes(row.type)) {
          result[row.key] = { $var: row.type, omitWhenOff: row.omitWhenOff === true };
        } else result[row.key] = row.value;
      }
      return result;
    }

    function validateDraft(draft) {
      const t = copy();
      if (draft.family === 'deepseek') {
        if (!Array.isArray(draft.input) || draft.input.length === 0) return t.inputRequired;
        if (draft.input.includes('image')) {
          if (draft.budget !== '' && draft.budget !== 'low' && capacity(draft.budget) === undefined) {
            return `${t.imageBudget}: ${t.positiveCapacity}`;
          }
          if (draft.maxImageBytes !== '' && capacity(draft.maxImageBytes) === undefined) {
            return `${t.imageMaxBytes}: ${t.positiveCapacity}`;
          }
        }
        if (draft.contextWindow !== '' && capacity(draft.contextWindow) === undefined) return `${t.context}: ${t.positiveCapacity}`;
        if (draft.maxTokens !== '' && capacity(draft.maxTokens) === undefined) return `${t.maxTokens}: ${t.positiveCapacity}`;
        return '';
      }
      if (draft.inputMode === 'custom' && draft.input.length === 0) return t.inputRequired;
      if (draft.reasoningMode === 'custom') {
        const levels = draft.reasoningRows.map((row) => row.level);
        if (new Set(levels).size !== levels.length) return t.duplicateLevel;
        if (!levels.some((level) => level !== 'off')) return t.reasoningRequired;
        if (draft.reasoningRows.some((row) => row.level !== 'off' && row.value.length === 0)) return t.wireRequired;
      }
      for (const [fieldName, rows] of Object.entries(draft.templateObjects)) {
        const keys = rows.map((row) => row.key);
        if (keys.some((key) => key.length === 0)) return `${fieldName}: ${t.keyRequired}`;
        if (new Set(keys).size !== keys.length) return `${fieldName}: ${t.duplicateKey}`;
        if (rows.some((row) => row.type === 'number' && !Number.isFinite(Number(row.value)))) return `${fieldName}: ${t.value}`;
      }
      if (draft.kind === 'builtin') {
        if (draft.contextWindow !== '' && capacity(draft.contextWindow) === undefined) return `${t.context}: ${t.positiveCapacity}`;
        if (draft.maxTokens !== '' && capacity(draft.maxTokens) === undefined) return `${t.maxTokens}: ${t.positiveCapacity}`;
      }
      return '';
    }

    /** One llm-deepseek catalog change, in that schema's own field names. */
    function deepseekChangeFor(draft, modelId) {
      const set = {};
      const unset = [];
      set.inputModalities = [...draft.input];
      // The adapter refuses image limits beside a text-only model, so dropping
      // image support unsets them in the same write.
      if (draft.input.includes('image')) {
        if (draft.budget === '') unset.push('imagePixelBudget');
        else if (draft.budget === 'low') set.imagePixelBudget = 'low';
        else set.imagePixelBudget = capacity(draft.budget);
        if (draft.maxImageBytes === '') unset.push('imageMaxBytes');
        else set.imageMaxBytes = capacity(draft.maxImageBytes);
      } else {
        unset.push('imagePixelBudget', 'imageMaxBytes');
      }
      if (draft.name === '') unset.push('name'); else set.name = draft.name;
      if (draft.contextWindow === '') unset.push('contextWindow'); else set.contextWindow = capacity(draft.contextWindow);
      if (draft.maxTokens === '') unset.push('maxTokens'); else set.maxTokens = capacity(draft.maxTokens);
      return { kind: 'catalog', modelId, set, unset };
    }

    function fullChangeFor(draft, modelId) {
      if (draft.family === 'deepseek') return deepseekChangeFor(draft, modelId);
      const set = {};
      const unset = [];
      if (draft.inputMode === 'inherit') unset.push('input'); else set.input = [...draft.input];
      if (draft.reasoningMode === 'inherit') unset.push('reasoningEfforts');
      else if (draft.reasoningMode === 'off') set.reasoningEfforts = false;
      else set.reasoningEfforts = Object.fromEntries(draft.reasoningRows.map((row) => [row.level, row.level === 'off' && row.value === '' ? null : row.value]));
      if (draft.kind === 'builtin') {
        if (draft.name === '') unset.push('name'); else set.name = draft.name;
        if (draft.contextWindow === '') unset.push('contextWindow'); else set.contextWindow = capacity(draft.contextWindow);
        if (draft.maxTokens === '') unset.push('maxTokens'); else set.maxTokens = capacity(draft.maxTokens);
      }
      const compat = {};
      const compatUnset = [];
      for (const field of draft.options.booleanCompatFields) {
        if (hasOwn(draft.compat, field)) compat[field] = draft.compat[field]; else compatUnset.push(field);
      }
      for (const field of Object.keys(draft.options.enumCompatFields)) {
        if (hasOwn(draft.compat, field)) compat[field] = draft.compat[field]; else compatUnset.push(field);
      }
      for (const [fieldName, rows] of Object.entries(draft.templateObjects)) {
        if (rows.length > 0) compat[fieldName] = serializeKwargs(draft, rows);
        else compatUnset.push(fieldName);
      }
      return { kind: draft.kind, modelId, set, unset, compat, compatUnset };
    }

    // Store changes to fields, not the complete capability form read at mount.
    // Native model controls may have committed a different field meanwhile.
    function changeFor(draft, modelId) {
      const change = fullChangeFor(draft, modelId);
      if (!draft.baseline) return change;
      const base = draft.baseline;
      const explicit = draft.explicit || {};
      for (const field of Object.keys(change.set)) {
        if (JSON.stringify(change.set[field]) === JSON.stringify(base.set[field])) delete change.set[field];
      }
      change.unset = change.unset.filter(field => !base.unset.includes(field));
      for (const field of Object.keys(change.compat || {})) {
        if (JSON.stringify(change.compat[field]) === JSON.stringify(base.compat[field])) delete change.compat[field];
      }
      if (change.compatUnset) change.compatUnset = change.compatUnset.filter(field => !base.compatUnset.includes(field));
      const inputField = draft.family === 'deepseek' ? 'inputModalities' : 'input';
      if (draft.native?.input && !draft.resetNativeInput) {
        delete change.set[inputField]; change.unset = change.unset.filter(field => field !== inputField);
        if (draft.family === 'deepseek' && !draft.input.includes('image')) {
          // Native text-only saves already remove these schema-incompatible
          // limits; do not replay their pre-save values as manager changes.
          for (const field of ['imagePixelBudget', 'imageMaxBytes']) delete change.set[field];
          change.unset = change.unset.filter(field => !['imagePixelBudget', 'imageMaxBytes'].includes(field));
        }
      } else if (draft.native?.input && draft.resetNativeInput) {
        delete change.set[inputField];
        if (!change.unset.includes(inputField)) change.unset.push(inputField);
      }
      if (draft.native?.reasoning) {
        delete change.set.reasoningEfforts; change.unset = change.unset.filter(field => field !== 'reasoningEfforts');
        if (draft.resetNativeReasoning) change.unset.push('reasoningEfforts');
        else if (draft.reasoningOrder || draft.offWire !== undefined) {
          const latest = draft.savedExplicit?.reasoningEfforts;
          if (latest && typeof latest === 'object') {
            const order = [...(draft.reasoningOrder || []).filter(key => hasOwn(latest, key)), ...Object.keys(latest).filter(key => !draft.reasoningOrder?.includes(key))];
            change.set.reasoningEfforts = Object.fromEntries(order.map(key => [key, key === 'off' && draft.offWire !== undefined ? draft.offWire || null : latest[key]]));
          }
        }
      }
      change.expected = Object.fromEntries([...Object.keys(change.set), ...change.unset].map(field => [field, explicit[field] ?? null]));
      if (draft.resetNativeInput) change.expected[inputField] = draft.savedExplicit?.[inputField] ?? null;
      if (draft.native?.reasoning && (hasOwn(change.set, 'reasoningEfforts') || draft.resetNativeReasoning)) change.expected.reasoningEfforts = draft.savedExplicit?.reasoningEfforts ?? null;
      change.compatExpected = Object.fromEntries([...Object.keys(change.compat || {}), ...(change.compatUnset || [])].map(field => [field, explicit.compat?.[field] ?? null]));
      return change;
    }

    const NOTICE_TIMEOUT_MS = 3000;

    function toast(message, error) {
      const node = element('div', { className: `mv-aide-cap-partial${error ? '' : ' mv-aide-cap-success'}`, text: message });
      document.body.appendChild(node);
      window.setTimeout(() => node.remove(), NOTICE_TIMEOUT_MS);
    }

    function showSectionError(section, error) {
      const message = `${copy().loadFailed}${error instanceof Error ? error.message : String(error)}`;
      const existing = section.querySelector('[data-mv-aide-capability-error]');
      if (existing) {
        existing.textContent = message;
        return;
      }
      section.appendChild(element('p', {
        className: 'mv-aide-cap-warning', text: message,
        'data-mv-aide-capability-error': 'true', role: 'status',
      }));
    }

    function showPartial(state, message, retry) {
      state.partial?.remove();
      if (state.partialTimer !== null) { window.clearTimeout(state.partialTimer); state.partialTimer = null; }
      const t = copy();
      const banner = element('div', { className: 'mv-aide-cap-partial', role: 'alert' },
        element('div', { text: `${t.partial}${message}` }));
      const actions = element('div', { className: 'mv-aide-cap-partial-actions' });
      const button = element('button', { type: 'button', className: 'mv-aide-cap-button', text: t.retry });
      const close = element('button', { type: 'button', className: 'mv-aide-cap-button', text: t.close, 'aria-label': t.close });
      const dismiss = () => {
        if (state.partialTimer !== null) { window.clearTimeout(state.partialTimer); state.partialTimer = null; }
        banner.remove();
        if (state.partial === banner) state.partial = null;
      };
      button.addEventListener('click', () => {
        button.disabled = true;
        if (state.partialTimer !== null) { window.clearTimeout(state.partialTimer); state.partialTimer = null; }
        // applyStaged already turns a failure into the next notice, so a
        // rejected retry must not surface as an unhandled rejection.
        void retry().catch(() => {}).finally(() => { button.disabled = false; });
      });
      close.addEventListener('click', dismiss);
      actions.appendChild(button); actions.appendChild(close);
      banner.appendChild(actions); document.body.appendChild(banner); state.partial = banner;
      // The same notice must never outlive its own timeout: a newer banner
      // clears the older timer, so it can only ever remove itself.
      state.partialTimer = window.setTimeout(dismiss, NOTICE_TIMEOUT_MS);
    }

    const FAILURE_RETRY_MS = 4000;

    function failedRecently(record) {
      return record && Date.now() - record.at < FAILURE_RETRY_MS ? record.error : null;
    }

    async function loadDirectory(state) {
      if (state.directory) return state.directory;
      const recent = failedRecently(state.directoryFailure);
      if (recent) throw recent;
      state.directory = managerJson(API_PATH).catch((error) => {
        state.directory = null;
        state.directoryFailure = { at: Date.now(), error };
        throw error;
      });
      state.directoryFailure = null;
      return state.directory;
    }

    async function loadProvider(state, provider, fresh) {
      if (!fresh && state.providers.has(provider)) return state.providers.get(provider);
      const recent = !fresh ? failedRecently(state.providerFailures.get(provider)) : null;
      if (recent) throw recent;
      const request = managerJson(`${API_PATH}?provider=${encodeURIComponent(provider)}`);
      state.providers.set(provider, request);
      try {
        const data = await request;
        state.providerFailures.delete(provider);
        return data;
      } catch (error) {
        state.providers.delete(provider);
        state.providerFailures.set(provider, { at: Date.now(), error });
        throw error;
      }
    }

    /** Every model id this card shows, in row order. */
    function editorModelIds(editor) {
      const section = compat.modelCatalogSections(editor)[0];
      if (!section) return [];
      const ids = modelIdInputs(section)
        .map((input) => input.value.trim())
        .filter(Boolean);
      return [...new Set(ids)];
    }

    /** A provider entry's model id set, from whichever list that family serves. */
    function entryModelIds(entry) {
      const direct = Array.isArray(entry.models) ? entry.models : [];
      const combined = [
        ...(Array.isArray(entry.customModels) ? entry.customModels : []),
        ...(Array.isArray(entry.catalogModels) ? entry.catalogModels : []),
        ...direct,
      ];
      return [...new Set(combined.map((model) => (model && typeof model.id === 'string' ? model.id : '')))].filter(Boolean);
    }

    function sameIdSet(left, right) {
      if (left.length === 0 || right.length === 0 || left.length !== right.length) return false;
      const rightSet = new Set(right);
      return left.every((id) => rightSet.has(id));
    }

    /**
     * Whether every model the server already knows is still on the card.
     *
     * The card legitimately holds a superset while a row the host just added is
     * still being typed: `添加模型` appends `{ id: '' }`, and the id only reaches
     * the settings wire once the user has committed it. Requiring the two lists
     * to be the same length therefore read a pending edit as a stale binding and
     * threw the provider away. Only a server id that has *left* the card means
     * the binding really went stale — that is what a native save re-registering
     * the rows produces, and it still drops the pin.
     */
    function cardCoversServerIds(domIds, serverIds) {
      if (serverIds.length === 0) return false;
      const dom = new Set(domIds);
      return serverIds.every((id) => dom.has(id));
    }

    /**
     * Drop the cached directory and provider views.
     *
     * The host's own model-list writes (add, rename, remove, and the native
     * commit) go through the settings wire and never touch these fetches, so a
     * cache filled before such a write describes the card as it was. Failures
     * are deliberately kept: they are the backoff that stops a broken server
     * from being re-asked on every scan.
     */
    function invalidateProviderView(state, provider) {
      if (typeof provider === 'string' && provider.length > 0) state.providers.delete(provider);
      state.directory = null;
    }

    /**
     * The card's provider, resolved without ever guessing from on-screen text.
     * Priority: an explicit binding recorded by a pick, the card's own Provider
     * ID field, then the one directory entry whose model id set is exactly the
     * card's. No unique match means no binding — and therefore no write.
     */
    async function providerFor(state, editor) {
      const pinned = editor.getAttribute('data-mv-aide-model-provider');
      const ids = editorModelIds(editor);
      if (pinned && ids.length > 0) {
        // A pinned binding is only reused while the server still describes this
        // card's model rows; otherwise the native save re-registered them and
        // the binding must be re-derived instead of trusted. A row whose id the
        // wire has not confirmed yet is a pending edit, not a stale binding.
        const pinnedEntry = await entryFor(state, pinned);
        if (pinnedEntry && cardCoversServerIds(ids, entryModelIds(pinnedEntry))) {
          bindEditor(editor, pinned, pinnedEntry);
          return pinned;
        }
        editor.removeAttribute('data-mv-aide-model-provider');
      }
      const draftRoute = editor.querySelector('input[aria-label="Provider ID"]')?.value.trim();
      if (draftRoute && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(draftRoute)) {
        const entry = await entryFor(state, draftRoute);
        bindEditor(editor, draftRoute, entry);
        return draftRoute;
      }
      if (ids.length === 0) return null;
      const directory = await loadDirectory(state);
      const matches = directory.providers.filter((entry) => sameIdSet(ids, entryModelIds(entry)));
      if (matches.length !== 1) return null;
      bindEditor(editor, matches[0].provider, matches[0]);
      return matches[0].provider;
    }

    /** The entry a bound provider names, from the directory the server already serves. */
    async function entryFor(state, provider) {
      const directory = await loadDirectory(state);
      return directory.providers.find((entry) => entry.provider === provider) ?? null;
    }

    function bindEditor(editor, provider, entry) {
      editor.setAttribute('data-mv-aide-model-provider', provider);
      if (entry?.settingsNs) editor.setAttribute('data-mv-aide-settings-ns', entry.settingsNs);
      if (entry?.kind) editor.setAttribute('data-mv-aide-kind', entry.kind);
    }

    function customEntries(section) {
      // The host rewrites the disclosure's caption between releases (it was
      // `容量 <n>`, now `模型选项 <n>`), so the control is recognized by what
      // it does — it is the row's single expansion toggle — not by its label.
      const buttons = [...section.querySelectorAll('button[aria-expanded]')];
      return buttons.map((button) => {
        const row = button.parentElement;
        const entry = row?.parentElement;
        if (!entry || modelRowDisclosure(entry) !== button) return null;
        const input = modelIdInput(entry);
        const advanced = button.getAttribute('aria-expanded') === 'true'
          ? [...(entry?.children || [])].find((child) => child !== row) : null;
        return { button, entry, input, advanced };
      }).filter((entry) => entry?.entry && entry.input);
    }

    function customDraftKey(provider, input) {
      return `${provider}:custom:${input.getAttribute('aria-label') || input.value}`;
    }

    function familyOf(providerData, response, editor) {
      const kind = providerData?.kind ?? editor?.getAttribute('data-mv-aide-kind') ?? response?.providers?.[0]?.kind;
      return kind === 'deepseek' ? 'deepseek' : 'pi-ai';
    }

    function familyOptions(providerData, response, family) {
      if (family !== 'deepseek') return response.options;
      const defaults = response.deepseek?.defaults ?? {};
      return {
        ...response.options,
        modalities: response.deepseek?.modalities ?? response.options.modalities,
        deepseekDefaults: defaults,
      };
    }

    function injectCustomPanels(state, section, editor, providerData, response) {
      const family = familyOf(providerData, response, editor);
      const options = familyOptions(providerData, response, family);
      const byId = new Map(providerData.customModels.map((model) => [model.id, model]));
      for (const row of customEntries(section)) {
        if (!(row.advanced instanceof Element)) continue;
        const key = customDraftKey(providerData.provider, row.input);
        const model = byId.get(row.input.value) || { explicit: {}, effective: {} };
        let draft = state.drafts.get(key);
        if (!draft) {
          draft = makeDraft(family, 'custom', model.explicit, model.effective, options, providerData.support ?? response.support);
          state.drafts.set(key, draft);
        }
        draft.family = family;
        draft.editor = editor;
        draft.modelIdInput = row.input;
        draft.provider = providerData.provider;
        draft.settingsNs = providerData.settingsNs ?? response.namespace ?? editor.getAttribute('data-mv-aide-settings-ns');
        draft.native = compat.nativeModelControls(row.advanced);
        draft.nativeRoot = row.advanced;
        if (family === 'deepseek' && draft.native.input) draft.input = compat.nativeModelInputValues(row.advanced) || draft.input;
        draft.baseline ??= fullChangeFor(draft, row.input.value);
        const existing = row.advanced.querySelector(':scope > [data-mv-aide-model-capabilities]');
        if (existing) {
          const extra = existing.querySelector('[data-mv-aide-native-reasoning]');
          if (extra) renderNativeReasoningExtras(extra, draft, !response.writable || !response.support.supported);
          continue;
        }
        const panel = element('div', { className: 'mv-aide-model-capabilities', 'data-mv-aide-model-capabilities': 'custom' });
        row.advanced.appendChild(panel);
        renderCapabilityPanel(panel, draft, !response.writable || !response.support.supported, false);
      }
    }

    function renderBuiltinCatalog(state, wrapper, editor, providerData, response) {
      const t = copy();
      wrapper.replaceChildren(element('h4', {
        className: 'mv-aide-builtin-head', text: `${t.builtinTitle} (${providerData.catalogModels.length})`,
      }));
      if (providerData.catalogError) {
        wrapper.appendChild(element('p', { className: 'mv-aide-cap-warning', text: `${t.catalogUnavailable} ${providerData.catalogError}` }));
      }
      for (const model of providerData.catalogModels) {
        const key = `${providerData.provider}:builtin:${model.id}`;
        const entry = element('div', { className: 'mv-aide-builtin-entry' });
        const expanded = state.expandedBuiltins.has(key);
        const toggle = element('button', {
          type: 'button', className: 'mv-aide-cap-button', text: expanded ? '⌄' : '›',
          'aria-label': `${t.title}: ${model.id}`, 'aria-expanded': String(expanded),
        });
        toggle.addEventListener('click', () => {
          if (expanded) state.expandedBuiltins.delete(key); else state.expandedBuiltins.add(key);
          renderBuiltinCatalog(state, wrapper, editor, providerData, response);
        });
        entry.appendChild(element('div', { className: 'mv-aide-builtin-row' },
          element('span', { className: 'mv-aide-builtin-name', text: `${model.name || model.id} · ${model.id}` }), toggle));
        if (expanded) {
          let draft = state.drafts.get(key);
          if (!draft) {
            draft = makeDraft('pi-ai', 'builtin', model.explicit, model, response.options, response.support);
            state.drafts.set(key, draft);
          }
          draft.editor = editor;
          draft.provider = providerData.provider;
          draft.settingsNs = providerData.settingsNs ?? response.namespace;
          draft.modelId = model.id;
          draft.baseline ??= fullChangeFor(draft, model.id);
          const body = element('div', { className: 'mv-aide-builtin-body' });
          const panel = element('div', { className: 'mv-aide-model-capabilities', 'data-mv-aide-model-capabilities': 'builtin' });
          body.appendChild(panel); entry.appendChild(body);
          renderCapabilityPanel(panel, draft, !response.writable || !response.support.supported, true);
        }
        wrapper.appendChild(entry);
      }
    }

    function injectBuiltinCatalog(state, section, editor, providerData, response) {
      section.querySelector(':scope > [data-mv-aide-builtin-catalog]')?.remove();
      if (!providerData.catalogMode) return;
      const wrapper = element('div', { className: 'mv-aide-builtin-catalog', 'data-mv-aide-builtin-catalog': providerData.provider });
      const addButton = [...section.querySelectorAll(':scope > button')]
        .find((button) => /^(?:添加模型|Add model)$/u.test(button.textContent.trim()));
      section.insertBefore(wrapper, addButton || null);
      renderBuiltinCatalog(state, wrapper, editor, providerData, response);
    }

    /**
     * Section identity. The per-row and per-block checks inside the injection
     * are what make a re-scan idempotent, so this only has to tell one live
     * section from another: a card replaced by a re-render is a new section,
     * and the chooser a section falls back to is remembered on it.
     */
    let sectionSeq = 0;
    function sectionId(section) {
      let id = section.getAttribute('data-mv-aide-section');
      if (!id) {
        sectionSeq += 1;
        id = `s${sectionSeq}`;
        section.setAttribute('data-mv-aide-section', id);
      }
      return id;
    }

    /**
     * Open a model row the host has just created.
     *
     * `添加模型` appends `{ id: '' }` and DSH renders a row's advanced pane only
     * while that row is expanded, so a brand-new row has nowhere for the panel
     * to mount — the user would have to find the row's own chevron before the
     * editor exists at all. A row with no model id yet is that new row and
     * nothing else: once the user has typed an id the row is theirs to fold.
     * Each element is opened at most once, so folding it afterwards is kept.
     */
    function openPendingRows(state, section) {
      for (const button of section.querySelectorAll('button[aria-expanded]')) {
        if (button.getAttribute('aria-expanded') === 'true') continue;
        const row = button.parentElement;
        const entry = row?.parentElement;
        if (!entry || modelRowDisclosure(entry) !== button) continue;
        const input = modelIdInput(entry);
        if (!input || input.value.trim() !== '') continue;
        if (state.openedRows.has(entry)) continue;
        state.openedRows.add(entry);
        button.click();
      }
    }

    async function injectSection(state, section) {
      const id = sectionId(section);
      const sectionState = state.sections.get(id) ?? { picker: false, provider: null };
      state.sections.set(id, sectionState);
      const editor = editorRoot(section);
      if (!editor) return;
      // The host's own model-list writes never reach our fetches, so a change in
      // what the card shows is the signal that the cached views are pre-change.
      const observedIds = editorModelIds(editor).join('\u0000');
      if (sectionState.observedIds !== undefined && sectionState.observedIds !== observedIds) {
        invalidateProviderView(state, sectionState.provider);
      }
      sectionState.observedIds = observedIds;
      const provider = await providerFor(state, editor);
      if (!provider) {
        if (!sectionState.picker) {
          sectionState.picker = true;
          renderProviderPicker(state, section, editor);
        }
        return;
      }
      let response;
      try {
        response = await loadProvider(state, provider, false);
      } catch (error) {
        const draftRoute = editor.querySelector('input[aria-label="Provider ID"]')?.value.trim();
        if (draftRoute !== provider) throw error;
        const directory = await loadDirectory(state);
        response = {
          ...directory,
          providers: [{
            provider, displayName: provider, declared: true, configured: false, catalogMode: false,
            customModels: [], catalogModels: [], catalogError: null,
          }],
        };
      }
      const providerData = response.providers[0];
      if (!providerData) return;
      const family = familyOf(providerData, response, editor);
      sectionState.provider = provider;
      bindEditor(editor, provider, providerData);
      section.querySelector('[data-mv-aide-provider-picker]')?.remove();
      section.querySelector('[data-mv-aide-capability-error]')?.remove();
      if (!response.support.supported && !section.querySelector('[data-mv-aide-capability-unsupported]')) {
        section.appendChild(element('p', {
          className: 'mv-aide-cap-warning', text: copy().unsupported, 'data-mv-aide-capability-unsupported': 'true',
        }));
      }
      // Every scan re-enters here, and that is what makes a row the user expands
      // *after* this card was first injected pick up its panel: the per-row
      // check inside is the idempotence, not a section-level one. The observer
      // watches childList only, and every write on this path is existence-
      // guarded, so a scan that finds nothing to do writes nothing and the loop
      // still settles. A section-level "inject once" guard would be stable and
      // still wrong — it would freeze the panel set at the rows that happened to
      // be expanded during the first read.
      // A row the host just created is opened first, so this same scan has a
      // pane to mount the new row's panel into. Opening it also reveals the
      // capacities and input types a brand-new model has to be given anyway.
      openPendingRows(state, section);
      injectCustomPanels(state, section, editor, providerData, response);
      if (family === 'pi-ai' && !section.querySelector(':scope > [data-mv-aide-builtin-catalog]')) {
        injectBuiltinCatalog(state, section, editor, providerData, response);
      }
    }

    /**
     * When no unique provider identity can be derived, the card gets an explicit
     * chooser instead of a guessed write target. Nothing is written until the
     * user picks, and the pick is what the editor then carries.
     */
    function renderProviderPicker(state, section, editor) {
      const t = copy();
      const existing = section.querySelector('[data-mv-aide-provider-picker]');
      if (existing) return;
      const wrapper = element('div', {
        className: 'mv-aide-cap-warning', 'data-mv-aide-provider-picker': 'true', role: 'status',
      });
      wrapper.appendChild(element('p', { text: t.pickProvider }));
      wrapper.appendChild(element('p', { text: t.pickProviderHint }));
      const select = element('select', { className: 'mv-aide-cap-select', 'aria-label': t.pickProvider });
      select.appendChild(element('option', { value: '', text: t.inherit }));
      loadDirectory(state).then((directory) => {
        for (const entry of directory.providers) {
          select.appendChild(element('option', {
            value: entry.provider,
            text: `${entry.displayName} · ${entry.settingsNs ?? ''}`,
          }));
        }
      }).catch(() => {});
      select.addEventListener('change', () => {
        if (!select.value) return;
        const entry = state.directory?.providers?.find((candidate) => candidate.provider === select.value);
        bindEditor(editor, select.value, entry);
        wrapper.remove();
        scheduleScan(state);
      });
      wrapper.appendChild(select);
      section.appendChild(wrapper);
    }

    function scheduleScan(state) {
      if (state.scanQueued || state.disposed) return;
      state.scanQueued = true;
      queueMicrotask(() => {
        state.scanQueued = false;
        state.scanStamp = (state.scanStamp ?? 0) + 1;
        state.modelSections = new Set(modelSections());
        for (const section of state.modelSections) {
          void injectSection(state, section).catch((error) => {
            console.warn('[mv-dsh-manager] model capability UI unavailable', error);
            showSectionError(section, error);
          });
        }
        checkPending(state);
      });
    }

    function dirtyDrafts(state, editor, provider) {
      return [...state.drafts.values()].filter((draft) => draft.dirty && draft.editor === editor && draft.provider !== false)
        .map((draft) => ({ draft, modelId: draft.kind === 'builtin' ? draft.modelId : draft.modelIdInput?.value || '' }))
        .filter((entry) => entry.modelId.length > 0 && provider.length > 0);
    }

    function clearProviderDrafts(state, editor) {
      for (const [key, draft] of state.drafts) if (draft.editor === editor) state.drafts.delete(key);
    }

    /**
     * Re-derive every staged model identity from the freshly-read provider view.
     * A native save may re-register a row's id, and the request must then carry
     * the id the server actually holds — never the pre-save one. Drafts whose
     * identity cannot be matched at all are reported instead of being sent.
     */
    function reconcileDrafts(state, staged, providerData) {
      const { editor } = staged;
      const drafts = staged.entries.map((entry) => entry.draft);
      const byId = new Map(providerData.customModels.map((model) => [model.id, model]));
      const section = compat.modelCatalogSections(editor)[0];
      const rows = section ? customEntries(section) : [];
      const rowIndexByInput = new Map(rows.map((row, index) => [row.input, index]));
      const unresolved = [];
      let rebound = 0;
      for (const draft of drafts) {
        if (draft.kind === 'builtin') {
          if (!byId.has(draft.modelId) && !providerData.catalogModels.some((model) => model.id === draft.modelId)) {
            unresolved.push(draft.modelId);
            for (const [draftKey, candidate] of state.drafts) if (candidate === draft) state.drafts.delete(draftKey);
          }
          continue;
        }
        const row = rows.find((candidate) => candidate.input === draft.modelIdInput)
          ?? rows[rowIndexByInput.get(draft.modelIdInput) ?? -1];
        const liveId = row?.input?.value?.trim() ?? '';
        let boundId = byId.has(liveId) ? liveId : '';
        if (!boundId && row) {
          // A native save may re-register the row's id, so a stale input value
          // cannot identify it on its own. The detached node still knows which
          // row it was, and the row and the server list share their order —
          // that pairing is the one identity left.
          const at = section === null ? -1 : modelIdInputs(section).indexOf(draft.modelIdInput);
          const model = at < 0 ? undefined : providerData.customModels[at];
          if (model && typeof model.id === 'string') boundId = model.id;
        }
        if (!boundId) {
          // The native save may have replaced the row's input node, so the
          // draft's own reference no longer carries an id the server knows.
          // Row order still stands, so claim the next unclaimed row.
          const claimed = new Set(drafts.slice(0, drafts.indexOf(draft)).map((other) => other.resolvedModelId));
          const model = providerData.customModels.find((candidate) => byId.has(candidate.id) && !claimed.has(candidate.id));
          const free = model ? rows[providerData.customModels.indexOf(model)] : undefined;
          if (free) {
            draft.modelIdInput = free.input;
            boundId = model.id;
          }
        }
        if (!boundId || !row || !byId.has(boundId)) {
          unresolved.push(liveId || draft.modelIdInput?.value || draft.modelId || 'unknown');
          continue;
        }
        if (liveId !== boundId) rebound += 1;
        draft.resolvedModelId = boundId;
        if (row.input !== draft.modelIdInput) draft.modelIdInput = row.input;
        for (const [key, candidate] of state.drafts) {
          if (candidate === draft) state.drafts.delete(key);
        }
        state.drafts.set(customDraftKey(providerData.provider, row.input), draft);
      }
      return { rebound, unresolved };
    }

    async function applyStaged(state, staged) {
      const changed = () => staged.entries.map((entry) => changeFor(
        entry.draft,
        entry.draft.resolvedModelId ?? entry.modelId,
      )).filter(change => Object.keys(change.set).length || change.unset.length
        || Object.keys(change.compat || {}).length || change.compatUnset?.length);

      /**
       * Read the provider and the card together until the staged rows have a
       * counterpart on the server. A native save commits the row's new identity
       * asynchronously, so the first read after the click can still describe the
       * pre-save card; waiting for one agreed view is what keeps a stale id from
       * ever reaching the server.
       */
      const settle = async () => {
        let last = null;
        for (let attempt = 0; attempt < 12 && !staged.posted; attempt += 1) {
          const fresh = await loadProvider(state, staged.provider, true);
          const providerData = fresh.providers[0];
          if (!providerData) throw new Error('The provider is no longer available.');
          last = { ...reconcileDrafts(state, staged, providerData), providerData, fresh };
          if (last.unresolved.length === 0) return last;
          await new Promise((resolve) => window.setTimeout(resolve, 150));
        }
        return last;
      };

      const run = async () => {
        // One staged save may only reach the server once, however many scans or
        // retries race it.
        if (staged.sent) return;
        staged.sent = true;
        const { unresolved, providerData, fresh } = await settle();
        if (unresolved.length > 0) staged.sent = false;
        const family = familyOf(providerData, fresh, staged.editor);
        for (const entry of staged.entries) {
          const modelId = entry.draft.resolvedModelId ?? entry.modelId;
          entry.draft.savedExplicit = [...providerData.customModels, ...providerData.catalogModels].find(model => model.id === modelId)?.explicit || {};
        }
        const settingsNs = providerData.settingsNs ?? fresh.namespace;
        if (staged.settingsNs && settingsNs && staged.settingsNs !== settingsNs) {
          throw new Error(`The write target moved from ${staged.settingsNs} to ${settingsNs}; reopen the provider and try again.`);
        }
        if (unresolved.length > 0) {
          throw new Error(`${copy().syncFailed}${unresolved.join(', ')}`);
        }
        const changes = changed();
        staged.posted = true;
        if (changes.length > 0) await managerJson(`${API_PATH}/apply`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            provider: staged.provider,
            settingsNs,
            family,
            expectedRevision: fresh.revision,
            changes,
          }),
        });
        for (const entry of staged.entries) {
          entry.draft.dirty = false;
          for (const [key, draft] of state.drafts) if (draft === entry.draft) state.drafts.delete(key);
        }
        state.providers.delete(staged.provider);
        state.directory = null;
        state.partial?.remove();
        if (state.partialTimer !== null) { window.clearTimeout(state.partialTimer); state.partialTimer = null; }
        state.partial = null;
        toast(copy().saved, false);
      };
      try {
        await run();
      } catch (error) {
        staged.sent = false;
        staged.posted = false;
        showPartial(state, error instanceof Error ? error.message : String(error), run);
      }
    }

    function checkPending(state) {
      const pending = state.pending;
      if (!pending) return;
      if (Date.now() - pending.started >= 30000 || pending.nativeFailed) {
        clearPending(state);
        if (!pending.nativeFailed && pending.editor.isConnected) showSectionError(pending.editor, new Error(copy().nativeSaveUnconfirmed));
        return;
      }
      if (!pending.editor.isConnected) {
        if (pending.nativePending > 0 && !pending.nativeFailed) return;
        clearPending(state);
        if (!pending.nativeFailed && pending.nativePending === 0 && pending.parent.isConnected
            && window.location.href === pending.href) void applyStaged(state, pending);
        return;
      }
    }

    function clearPending(state) {
      state.pending = null;
      if (state.pendingTimer !== null) window.clearTimeout(state.pendingTimer);
      state.pendingTimer = null;
    }

    function stageSave(state, editor, provider, event) {
      const entries = dirtyDrafts(state, editor, provider);
      if (entries.length === 0) return;
      for (const entry of entries) {
        const failure = validateDraft(entry.draft);
        entry.draft.error = failure;
        if (entry.draft.panel) renderCapabilityPanel(entry.draft.panel, entry.draft, false, entry.draft.kind === 'builtin');
        if (failure) {
          event.preventDefault(); event.stopImmediatePropagation();
          entry.draft.panel?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          return;
        }
      }
      clearPending(state);
      state.pending = {
        editor, provider, entries, started: Date.now(),
        parent: editor.parentElement, href: window.location.href,
        nativePending: 0, nativeFailed: false,
        settingsNs: editor.getAttribute('data-mv-aide-settings-ns') || undefined,
        changes: entries.map((entry) => changeFor(entry.draft, entry.modelId)),
      };
      state.pendingTimer = window.setTimeout(() => checkPending(state), 30000);
      // One explicit rebuild per native commit, never per keystroke, so the
      // panel reflects the committed row without the scan loop owning renders.
      window.setTimeout(() => checkPending(state), 900);
    }

    function staleProviderHint(state, label) {
      // The edit affordance names its provider in the accessible label. It is a
      // hint only: it may seed a pick, never a write target on its own.
      const directory = state.directory;
      if (!directory) return null;
      const ranked = directory.providers.filter((entry) => label.includes(entry.provider) || label.includes(entry.displayName));
      return ranked.length === 1 ? ranked[0].provider : null;
    }

    function onClick(state, event) {
      const button = event.target instanceof Element ? event.target.closest('button') : null;
      if (!button) return;
      const aria = button.getAttribute('aria-label') || '';
      const editor = [...modelSections()].map(editorRoot).find((root) => root?.contains(button));
      if (/^(?:编辑|Edit)\s/u.test(aria) && editor) {
        const hinted = staleProviderHint(state, aria);
        if (hinted) {
          const entry = state.directory?.providers?.find((candidate) => candidate.provider === hinted);
          bindEditor(editor, hinted, entry);
        }
      }
      if (!editor) return;
      // Save and cancel are identified by the editor's own action row rather
      // than by their captions: the commit caption is chosen by the host per
      // editor (save / create provider / save and continue) and was reworded
      // between releases, while the card's row-level `编辑` and `删除` controls
      // sit outside that row and must keep falling through untouched.
      const actionRow = editorActionRow(editor);
      if (!actionRow || !actionRow.contains(button)) return;
      const cancel = editorActionButton(actionRow, 'secondary');
      if (cancel !== button && editorActionButton(actionRow, 'primary') !== button) return;
      const draftRoute = editor.querySelector('input[aria-label="Provider ID"]')?.value.trim();
      const provider = draftRoute || editor.getAttribute('data-mv-aide-model-provider');
      if (cancel === button) {
        if (state.pending?.editor === editor) clearPending(state);
        clearProviderDrafts(state, editor);
        return;
      }
      if (provider) stageSave(state, editor, provider, event);
    }

    function install(ctx, options = {}) {
      if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return () => {};
      if (window[INSTALL_KEY]) return window[INSTALL_KEY].dispose;
      const enabled = () => options.get?.().modelCapabilitiesUiEnabled !== false;
      const removeUi = () => {
        document.querySelectorAll('[data-mv-aide-model-capabilities], [data-mv-aide-builtin-catalog], [data-mv-aide-capability-unsupported], [data-mv-aide-capability-error], [data-mv-aide-provider-picker]')
          .forEach((node) => node.remove());
      };
      installStyle();
      const state = {
        disposed: false, scanQueued: false, directory: null, providers: new Map(), drafts: new Map(),
        expandedBuiltins: new Set(), pending: null, pendingTimer: null, partial: null, partialTimer: null, scanStamp: 0,
        sections: new Map(), modelSections: new Set(), scanTimer: null, openedRows: new WeakSet(),
        directoryFailure: null, providerFailures: new Map(),
      };
      const stopObservingSaves = compat.observeModelSaves(ctx, (namespace, key) => {
        const pending = state.pending;
        if (!pending || (namespace === 'settings' && pending.settingsNs && key !== pending.settingsNs)) return null;
        pending.nativePending += 1;
        return success => {
          pending.nativePending -= 1;
          pending.nativeFailed ||= !success;
          window.setTimeout(() => checkPending(state), 0);
        };
      });
      const queueScan = () => {
        if (state.scanTimer !== null) window.clearTimeout(state.scanTimer);
        state.scanTimer = window.setTimeout(() => { state.scanTimer = null; scheduleScan(state); }, 25);
      };
      const observer = new MutationObserver((records) => {
        if (!enabled()) return;
        const relevant = (state.pending && !state.pending.editor.isConnected) || records.some((record) => {
          const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
          if (target?.closest('[data-mv-aide-model-capabilities], [data-mv-aide-builtin-catalog]')) return false;
          return mutationAffectsModelSettings(record, state.modelSections);
        });
        if (!relevant) return;
        // Coalesce bursts: one keystroke in the native editor can emit many
        // records, and each scan must not re-render the panels it just wrote.
        queueScan();
      });
      const click = (event) => { if (enabled()) onClick(state, event); };
      const nativeChange = event => {
        if (!enabled() || !(event.target instanceof Element) || event.target.closest('[data-mv-aide-model-capabilities]')) return;
        for (const draft of state.drafts.values()) {
          if (!draft.nativeRoot?.contains(event.target)) continue;
          if (draft.family === 'deepseek' && draft.native?.input && event.type === 'change' && event.target.matches('input[type="checkbox"]')) {
            draft.input = compat.nativeModelInputValues(draft.nativeRoot);
            renderCapabilityPanel(draft.panel, draft, event.target.disabled, false);
          } else if (draft.family === 'pi-ai' && draft.native?.reasoning) queueScan();
        }
      };
      const unsubscribe = options.subscribe?.(() => {
        if (enabled()) scheduleScan(state);
        else removeUi();
      });
      document.addEventListener('click', click, true);
      document.addEventListener('change', nativeChange);
      document.addEventListener('input', nativeChange);
      if (document.body) observer.observe(document.body, { childList: true, subtree: true });
      else document.addEventListener('DOMContentLoaded', () => {
        if (!state.disposed) observer.observe(document.body, { childList: true, subtree: true });
      }, { once: true });
      const dispose = () => {
        if (state.disposed) return;
        state.disposed = true;
        clearPending(state);
        observer.disconnect();
        stopObservingSaves();
        unsubscribe?.();
        document.removeEventListener('click', click, true);
        document.removeEventListener('change', nativeChange);
        document.removeEventListener('input', nativeChange);
        removeUi();
        state.partial?.remove();
        if (state.partialTimer !== null) { window.clearTimeout(state.partialTimer); state.partialTimer = null; }
        if (state.scanTimer !== null) { window.clearTimeout(state.scanTimer); state.scanTimer = null; }
        state.sections.clear();
        state.modelSections.clear();
        document.getElementById('mv-aide-model-capabilities-style')?.remove();
        delete window[INSTALL_KEY];
      };
      window[INSTALL_KEY] = { dispose };
      if (enabled()) scheduleScan(state);
      try {
        ctx?.effect?.(() => dispose, 'mv-dsh-manager: model capability editor');
      } catch {
        // Minimal/headless client shims do not own a lifecycle face.
      }
      return dispose;
    }

    exports.install = install;
    exports.apply = install;
    exports.validateDraft = validateDraft;
    exports.changeFor = changeFor;
    return module.exports;
  },
});
