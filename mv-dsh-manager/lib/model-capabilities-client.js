// Browser half of the llm-pi-ai model capability editor.
//
// DSH 0.1.1 has no nested client slot inside a model row. This isolated
// module therefore augments that one native surface through its stable
// accessibility contract (section/field aria labels and button text). It does
// not inspect hashed CSS module names and it owns every node/listener it adds.

window.__ModuleLoader__.load({
  id: '@mv-aide/mv-dsh-manager/model-capabilities-client',
  factory: () => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const INSTALL_KEY = '__MV_AIDE_MODEL_CAPABILITIES_CLIENT__';
    const API_PATH = '/api/mv-aide/model-capabilities';
    const SAVE_LABELS = new Set(['保存', 'Apply', '创建提供方', 'Create provider', '保存并继续', 'Save and continue']);
    const CANCEL_LABELS = new Set(['取消', 'Cancel', '稍后配置', 'Configure later']);
    const MODELS_LABELS = new Set(['模型目录', 'Models']);
    const MODEL_ID_PREFIXES = ['模型 ID ', 'Model ID '];
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
      },
      en: {
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

    function buttonText(target) {
      return target instanceof Element ? String(target.closest('button')?.textContent || '').trim() : '';
    }

    function modelSections() {
      return [...document.querySelectorAll('section[aria-label]')]
        .filter((node) => MODELS_LABELS.has(node.getAttribute('aria-label')));
    }

    function modelIdInputs(section) {
      return [...section.querySelectorAll('input[aria-label]')]
        .filter((input) => MODEL_ID_PREFIXES.some((prefix) => (input.getAttribute('aria-label') || '').startsWith(prefix)));
    }

    function modelIdInput(entry) {
      return [...entry.querySelectorAll('input[aria-label]')].find((input) => {
        const label = input.getAttribute('aria-label') || '';
        return MODEL_ID_PREFIXES.some((prefix) => label.startsWith(prefix));
      });
    }

    function editorRoot(section) {
      let node = section.parentElement;
      while (node && node !== document.body) {
        const hasKey = node.querySelector('input[aria-label="API key"], input[aria-label="API 密钥"]');
        const hasSave = [...node.querySelectorAll('button')].some((button) => SAVE_LABELS.has(button.textContent.trim()));
        if (hasKey && hasSave) return node;
        node = node.parentElement;
      }
      return null;
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
      panel.appendChild(field(t.input, checks));

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
      panel.appendChild(field(t.input, inputControls));

      const reasoning = element('div', {});
      reasoning.appendChild(select([
        { value: 'inherit', label: t.inherit },
        { value: 'off', label: t.reasoningOff },
        { value: 'custom', label: t.reasoningCustom },
      ], draft.reasoningMode, (value) => { draft.reasoningMode = value; dirty(draft); rerender(); }, disabled));
      if (draft.reasoningMode === 'custom') renderReasoningRows(reasoning, draft, disabled, rerender);
      panel.appendChild(field(t.reasoning, reasoning));

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

    function changeFor(draft, modelId) {
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
      const section = [...editor.querySelectorAll('section[aria-label]')]
        .find((node) => MODELS_LABELS.has(node.getAttribute('aria-label')));
      if (!section) return [];
      const ids = [...section.querySelectorAll('input[aria-label]')]
        .filter((input) => MODEL_ID_PREFIXES.some((prefix) => (input.getAttribute('aria-label') || '').startsWith(prefix)))
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
        // the binding must be re-derived instead of trusted.
        const pinnedEntry = await entryFor(state, pinned);
        if (pinnedEntry && sameIdSet(ids, entryModelIds(pinnedEntry))) {
          bindEditor(editor, pinned, pinnedEntry);
          return pinned;
        }
        editor.removeAttribute('data-mv-aide-model-provider');
        state.staleBinding = true;
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
      const buttons = [...section.querySelectorAll('button[aria-expanded]')].filter((button) => {
        const label = button.getAttribute('aria-label') || '';
        return /^(?:容量|Capacities)\s+\d+$/u.test(label);
      });
      return buttons.map((button) => {
        const row = button.parentElement;
        const entry = row?.parentElement;
        const input = entry ? modelIdInput(entry) : null;
        const advanced = button.getAttribute('aria-expanded') === 'true'
          ? [...(entry?.children || [])].find((child) => child !== row) : null;
        return { button, entry, input, advanced };
      }).filter((entry) => entry.entry && entry.input);
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
        if (!(row.advanced instanceof Element) || row.advanced.querySelector(':scope > [data-mv-aide-model-capabilities]')) continue;
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
     * Inject once per (section, bound provider). The panel itself is a DOM
     * write that re-enters the observer, so re-rendering an already-correct
     * panel would keep the scan loop alive forever. Dirtiness is not part of
     * the decision — a keystroke must never tear the panel out from under the
     * user — so a click that changes it asks for a rebuild explicitly.
     */
    function stateKey(family, provider) {
      return `${family}|${provider}`;
    }

    /** Section identity, so a card replaced by a re-render is never skipped. */
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

    async function injectSection(state, section, force = false) {
      const id = sectionId(section);
      const sectionState = state.sections.get(id) ?? { key: null, provider: null };
      state.sections.set(id, sectionState);
      const editor = editorRoot(section);
      if (!editor) return;
      state.staleBinding = false;
      const provider = await providerFor(state, editor);
      // A binding that had to be re-derived means the card's rows changed, so
      // the cached injection decision no longer describes this section.
      if (state.staleBinding) sectionState.key = null;
      if (!provider) {
        if (sectionState.key !== 'picker') {
          sectionState.key = 'picker';
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
      const key = stateKey(family, provider);
      if (!force && sectionState.key === key) return;
      sectionState.key = key;
      sectionState.provider = provider;
      bindEditor(editor, provider, providerData);
      section.querySelector('[data-mv-aide-provider-picker]')?.remove();
      section.querySelector('[data-mv-aide-capability-error]')?.remove();
      if (!response.support.supported && !section.querySelector('[data-mv-aide-capability-unsupported]')) {
        section.appendChild(element('p', {
          className: 'mv-aide-cap-warning', text: copy().unsupported, 'data-mv-aide-capability-unsupported': 'true',
        }));
      }
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
        for (const section of modelSections()) {
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
      const section = [...editor.querySelectorAll('section[aria-label]')]
        .find((node) => MODELS_LABELS.has(node.getAttribute('aria-label')));
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
      ));

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
        const settingsNs = providerData.settingsNs ?? fresh.namespace;
        if (staged.settingsNs && settingsNs && staged.settingsNs !== settingsNs) {
          throw new Error(`The write target moved from ${staged.settingsNs} to ${settingsNs}; reopen the provider and try again.`);
        }
        if (unresolved.length > 0) {
          throw new Error(`${copy().syncFailed}${unresolved.join(', ')}`);
        }
        const changes = changed();
        if (changes.length === 0) throw new Error(`${copy().syncFailed}${staged.provider}`);
        staged.posted = true;
        await managerJson(`${API_PATH}/apply`, {
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
      if (!pending.editor.isConnected) {
        state.pending = null;
        void applyStaged(state, pending);
        return;
      }
      const elapsed = Date.now() - pending.started;
      const idleSave = [...pending.editor.querySelectorAll('button')]
        .find((button) => SAVE_LABELS.has(button.textContent.trim()) && !button.disabled);
      // The native commit is done once its own save control is idle again (or
      // the wait ran out): either way the staged capability write must run.
      if ((elapsed > 800 && idleSave) || elapsed > 30000) {
        state.pending = null;
        void applyStaged(state, pending);
      }
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
      state.pending = {
        editor, provider, entries, started: Date.now(),
        settingsNs: editor.getAttribute('data-mv-aide-settings-ns') || undefined,
        changes: entries.map((entry) => changeFor(entry.draft, entry.modelId)),
      };
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
      const text = buttonText(button);
      const aria = button.getAttribute('aria-label') || '';
      const editor = [...modelSections()].map(editorRoot).find((root) => root?.contains(button));
      if (/^(?:编辑|Edit)\s/u.test(aria) && editor) {
        const hinted = staleProviderHint(state, aria);
        if (hinted) {
          const entry = state.directory?.providers?.find((candidate) => candidate.provider === hinted);
          bindEditor(editor, hinted, entry);
        }
      }
      if (!SAVE_LABELS.has(text) && !CANCEL_LABELS.has(text)) return;
      if (!editor) return;
      const draftRoute = editor.querySelector('input[aria-label="Provider ID"]')?.value.trim();
      const provider = draftRoute || editor.getAttribute('data-mv-aide-model-provider');
      if (CANCEL_LABELS.has(text)) {
        if (state.pending?.editor === editor) state.pending = null;
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
        expandedBuiltins: new Set(), pending: null, partial: null, partialTimer: null, scanStamp: 0,
        sections: new Map(), scanTimer: null,
        directoryFailure: null, providerFailures: new Map(),
      };
      const observer = new MutationObserver(() => {
        if (!enabled()) { removeUi(); return; }
        // Coalesce bursts: one keystroke in the native editor can emit many
        // records, and each scan must not re-render the panels it just wrote.
        if (state.scanTimer !== null) window.clearTimeout(state.scanTimer);
        state.scanTimer = window.setTimeout(() => { state.scanTimer = null; scheduleScan(state); }, 25);
      });
      const click = (event) => { if (enabled()) onClick(state, event); };
      const unsubscribe = options.subscribe?.(() => {
        if (enabled()) scheduleScan(state);
        else removeUi();
      });
      document.addEventListener('click', click, true);
      if (document.body) observer.observe(document.body, { childList: true, subtree: true });
      else document.addEventListener('DOMContentLoaded', () => {
        if (!state.disposed) observer.observe(document.body, { childList: true, subtree: true });
      }, { once: true });
      const dispose = () => {
        if (state.disposed) return;
        state.disposed = true;
        observer.disconnect();
        unsubscribe?.();
        document.removeEventListener('click', click, true);
        removeUi();
        state.partial?.remove();
        if (state.partialTimer !== null) { window.clearTimeout(state.partialTimer); state.partialTimer = null; }
        if (state.scanTimer !== null) { window.clearTimeout(state.scanTimer); state.scanTimer = null; }
        state.sections.clear();
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
