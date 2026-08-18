// @mv-aide/mv-dsh-manager — browser client half.
//
// This is the prebuilt DSH client bundle format (window.__ModuleLoader__).
// It implements a generic recursive slash-command field picker using the
// official commandUi extension point:
//   - decorating a host command's bare pick with a popupSelect;
//   - chaining further popups until a leaf is selected;
//   - completing the draft before each popup level so the user always sees
//     the command text land in the composer before the next picker opens;
//   - executing the completed line through ctx.remote.commands.execute;
//   - cancelling any popup level with Escape keeps that popup's already-
//     confirmed command line and returns the caret to the end of it. The
//     pre-selection slash query belongs to DSH's native slash menu and is
//     never restored by this plugin after a popup has opened.
//
// The engine is command-agnostic. In addition to the built-in /mv-aide tree,
// it scans the DSH command directory and automatically decorates every host
// command whose `input.hint` follows a small enumerable grammar (see
// `parseHintFields`). This keeps the picker a DSH-level feature instead of a
// per-command hardcoded special case.

window.__ModuleLoader__.load({
  id: '@mv-aide/mv-dsh-manager',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const planReviewClient = require('@mv-aide/mv-dsh-manager/plan-review-client');

    // `remote.commands` is a dotted service namespace: DSH's own runtime
    // injects both `remote` and `remote.commands` (see dsh-client-runtime),
    // so this module must declare both to call ctx.remote.commands.execute.
    const inject = ['commandUi', 'sessions', 'remote', 'remote.commands'];
    const DEFAULT_PICKER_COMMAND = 'mv-aide';
    const MAX_HINT_LEAVES = 50;

    // ── Generic recursive command tree registry ──────────────────────────
    const trees = new Map();
    const explicitTrees = new Set();
    const dynamicLoaders = {
      bridges: async (signal) => {
        const response = await fetch('/api/mv-aide/bridges', { signal });
        if (!response.ok) throw new Error(`桥接列表加载失败（HTTP ${response.status}）`);
        const data = await response.json();
        return data && Array.isArray(data.bridges) ? data.bridges : [];
      },
      tools: async (signal) => {
        const response = await fetch('/api/mv-aide/tools', { signal });
        if (!response.ok) throw new Error(`工具列表加载失败（HTTP ${response.status}）`);
        const data = await response.json();
        return data && Array.isArray(data.tools) ? data.tools : [];
      },
    };

    /**
     * Register a command tree for a host command.
     * Root shape: { fields: [{ key, label, detail?, line?, children? }] }
     * `line` marks a leaf (full slash command). `children` may be a dynamic
     * loader key ('bridges' | 'tools') for this built-in plugin.
     */
    function registerCommandTree(name, root) {
      const generated = hintDecorations.get(name);
      if (generated) {
        try {
          generated.dispose?.();
        } catch {
          // Explicit command trees take precedence even if disposal is already stale.
        }
        hintDecorations.delete(name);
      }
      trees.set(name, root);
      explicitTrees.add(name);
    }

    function registerGeneratedCommandTree(name, root) {
      trees.set(name, root);
    }

    function defaultMvAideTree() {
      return {
        fields: [
          { key: 'status', label: 'status', detail: '本会话桥接状态、端口与工具数', line: '/mv-aide status' },
          { key: 'tools', label: 'tools', detail: '列出 mv-AIDE IDE 工具', line: '/mv-aide tools' },
          { key: 'bridges', label: 'bridges', detail: '列出所有 IDE 桥', line: '/mv-aide bridges' },
          { key: 'selection', label: 'selection', detail: '读取当前 Obsidian 选区', line: '/mv-aide selection' },
          { key: 'connect', label: 'connect …', detail: '选择本会话要连接的 IDE 桥', children: 'bridges' },
          { key: 'call', label: 'call …', detail: '调用一个 mv-AIDE IDE 工具', children: 'tools' },
        ],
      };
    }

    /** Completed command line shown in the composer while a popup level is open. */
    function commandLine(command, parentPath) {
      return `/${command}${parentPath.length > 0 ? ` ${parentPath.join(' ')}` : ''} `;
    }

    // ── Option building ──────────────────────────────────────────────────
    function makeOption(field, parentPath, command) {
      const children = typeof field.children === 'string' || Array.isArray(field.children)
        ? field.children
        : null;
      const meta = {
        command,
        path: [...parentPath, field.key],
        line: typeof field.line === 'string' ? field.line : null,
        children,
      };
      return {
        id: JSON.stringify(meta),
        label: field.label,
        detail: field.detail,
      };
    }

    async function dynamicFields(kind, signal) {
      const loader = dynamicLoaders[kind];
      if (typeof loader !== 'function') return [];
      const items = await loader(signal);
      const rows = items.map((item) => ({
        key: `${kind}:${item.port ?? item.name ?? String(item.label ?? '')}`,
        label: item.port ? `connect ${item.port}` : `call ${item.name}`,
        detail: item.workspaceFolders ? item.workspaceFolders.join(' | ') : item.description,
        line: item.port ? `/mv-aide connect ${item.port}` : `/mv-aide call ${item.name}`,
      }));
      if (kind === 'bridges') {
        rows.unshift({
          key: 'connect-auto',
          label: 'connect auto',
          detail: '回到自动桥接选择',
          line: '/mv-aide connect auto',
        });
      }
      return rows;
    }

    async function optionsFor(command, parentPath, children, session, signal) {
      if (children == null) {
        const root = trees.get(command);
        if (!root) return [];
        return root.fields.map((field) => makeOption(field, parentPath, command));
      }
      if (Array.isArray(children)) {
        return children.map((field) => makeOption(field, parentPath, command));
      }
      const fields = await dynamicFields(children, signal);
      return fields.map((field) => makeOption(field, parentPath, command));
    }

    // Every popup owned by this recursive picker is deny-by-default. The first
    // popup is authorized only by an actual slash-menu pick; deeper popups are
    // authorized only by selecting their parent row.
    const pickerSpecDepth = new WeakMap();
    const authorizedChildOpens = new WeakMap();
    const menuDispatchPermits = new WeakMap();
    const patchedCommandUis = new WeakSet();

    function menuPermitSet(commandUi, sessionId, create) {
      let bySession = menuDispatchPermits.get(commandUi);
      if (!bySession && create) {
        bySession = new Map();
        menuDispatchPermits.set(commandUi, bySession);
      }
      if (!bySession) return undefined;
      let commands = bySession.get(sessionId);
      if (!commands && create) {
        commands = new Set();
        bySession.set(sessionId, commands);
      }
      return commands;
    }

    function hasMenuDispatchPermit(commandUi, sessionId, command) {
      if (!commandUi || typeof sessionId !== 'string') return false;
      return menuPermitSet(commandUi, sessionId, false)?.has(command) === true;
    }

    function consumeMenuDispatchPermit(commandUi, sessionId, command) {
      const commands = menuPermitSet(commandUi, sessionId, false);
      if (!commands?.has(command)) return false;
      commands.delete(command);
      return true;
    }

    function installMenuDispatchGate(ctx, commandUi) {
      if (!commandUi || patchedCommandUis.has(commandUi) || typeof commandUi.dispatch !== 'function') return;
      const originalDispatch = commandUi.dispatch;
      const wrappedDispatch = function (pick) {
        const command = pick && pick.candidate && typeof pick.candidate.name === 'string'
          ? pick.candidate.name
          : '';
        const sessionId = pick && pick.session && typeof pick.session.sessionId === 'string'
          ? pick.session.sessionId
          : '';
        if (!command || !sessionId || !trees.has(command)) return originalDispatch.call(this, pick);
        const commands = menuPermitSet(commandUi, sessionId, true);
        commands.add(command);
        try {
          return originalDispatch.call(this, pick);
        } finally {
          commands.delete(command);
        }
      };
      commandUi.dispatch = wrappedDispatch;
      patchedCommandUis.add(commandUi);
      try {
        ctx.effect(() => () => {
          if (commandUi.dispatch === wrappedDispatch) commandUi.dispatch = originalDispatch;
          menuDispatchPermits.delete(commandUi);
          patchedCommandUis.delete(commandUi);
        }, 'mv-dsh-manager: slash menu picker gate');
      } catch {
        // Optional lifecycle cleanup for minimal/headless client shims.
      }
    }

    function specForPath(command, parentPath, children, ctx) {
      const spec = {
        kind: 'popupSelect',
        draftLine: commandLine(command, parentPath),
        options: (session, signal) => optionsFor(command, parentPath, children, session, signal),
        onSelect: (option, session) => selectOption(option, session, ctx),
      };
      pickerSpecDepth.set(spec, { command, depth: parentPath.length });
      return spec;
    }

    // ── Session controller plumbing (token segment capture + draft write) ─
    const capturedSegments = new WeakMap();
    const patchedControllers = new WeakSet();
    // Per-controller picker flow state. `captured` keeps the composer target
    // needed for focus/caret restoration; `activeLine` is the complete command
    // text confirmed before the CURRENT popup opened. Escape always returns to
    // `activeLine`, regardless of popup depth.
    const pickerFlows = new WeakMap();

    function composerTextarea() {
      try {
        if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return null;
        const el = document.querySelector('textarea[data-phase]');
        return typeof HTMLTextAreaElement !== 'undefined' && el instanceof HTMLTextAreaElement ? el : null;
      } catch {
        return null;
      }
    }

    /**
     * Snapshot the composer right before the first popup level opens. The
     * caret is read from the focused textarea when available; otherwise it
     * falls back to the end of the open-time token span.
     */
    function captureComposerState(sessionId, ctx, segment) {
      const input = inputFor(sessionId, ctx);
      if (!input) return null;
      try {
        const state = input.state && typeof input.state.getSnapshot === 'function'
          ? input.state.getSnapshot()
          : undefined;
        const draft = state && typeof state.draft === 'string' ? state.draft : '';
        let caret = draft.length;
        let element = null;
        let prefix = '';
        let suffix = '';
        let commandStart = 0;
        let preserveSurrounding = false;
        const span = segment && segment.span;
        const spanIsUsable = span
          && typeof span.start === 'number'
          && typeof span.end === 'number'
          && span.start >= 0
          && span.start <= span.end
          && span.end <= draft.length
          && draft.slice(span.start, span.end).startsWith('/');
        if (spanIsUsable) {
          prefix = draft.slice(0, span.start);
          suffix = draft.slice(span.end);
          commandStart = span.start;
          preserveSurrounding = true;
        }
        const active = typeof document !== 'undefined' && typeof HTMLTextAreaElement !== 'undefined' && document.activeElement instanceof HTMLTextAreaElement
          ? document.activeElement
          : null;
        if (active) {
          element = active;
          if (typeof active.selectionStart === 'number') caret = active.selectionStart;
        } else if (spanIsUsable) {
          caret = span.end;
        }
        return { draft, caret, element, prefix, suffix, commandStart, preserveSurrounding };
      } catch {
        return null;
      }
    }

    function composePickerDraft(captured, commandLine) {
      if (!captured || captured.preserveSurrounding !== true) return commandLine;
      const suffix = commandLine.endsWith(' ') && captured.suffix.startsWith(' ')
        ? captured.suffix.slice(1) : captured.suffix;
      return `${captured.prefix}${commandLine}${suffix}`;
    }

    function pickerCommandCaret(captured, commandLine) {
      if (!captured || captured.preserveSurrounding !== true) return commandLine.length;
      return captured.commandStart + commandLine.length;
    }

    function surroundingDraft(captured) {
      if (!captured || captured.preserveSurrounding !== true) return '';
      return `${captured.prefix}${captured.suffix}`;
    }

    /**
     * Focus the composer after a dismiss and place the caret at `caret`.
     * When `caret` is null the caret goes to the end of the current value.
     */
    function focusComposerAt(sessionId, captured, caret, ctx) {
      const setCaret = () => {
        const el = captured && captured.element && captured.element.isConnected
          ? captured.element
          : composerTextarea();
        if (!el) return;
        try {
          el.focus({ preventScroll: true });
          const target = caret === null || caret === undefined
            ? (el.value ? el.value.length : 0)
            : Math.min(caret, el.value ? el.value.length : 0);
          el.setSelectionRange(target, target);
        } catch {
          // Caret restoration is best-effort.
        }
      };
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(setCaret);
      else setCaret();
    }

    /**
     * Keep the line confirmed for the popup being dismissed. rc.5 leaves the
     * draft untouched on dismiss, so avoid a redundant setDraft transaction
     * when the text is already correct; the conditional write remains as a
     * compatibility guard for hosts that do mutate it.
     */
    function ensureConfirmedDraft(sessionId, captured, draft, caret, ctx) {
      const input = inputFor(sessionId, ctx);
      if (input) {
        try {
          const state = input.state && typeof input.state.getSnapshot === 'function'
            ? input.state.getSnapshot()
            : undefined;
          const current = state && typeof state.draft === 'string' ? state.draft : undefined;
          if (current !== draft) input.setDraft(draft);
        } catch {
          // If the session input facade is read-only, at least restore focus.
        }
      }
      focusComposerAt(sessionId, captured, caret, ctx);
    }

    /**
     * Focus the composer after dismissing a deeper-level picker. Unlike the
     * first-level cancel, this keeps the already-confirmed draft line and only
     * returns focus with the caret at the end of the line.
     */
    function focusComposerAfterDismiss(sessionId, captured, ctx) {
      const setCaret = () => {
        const el = captured && captured.element && captured.element.isConnected
          ? captured.element
          : composerTextarea();
        if (!el) return;
        try {
          el.focus({ preventScroll: true });
          const caret = el.value ? el.value.length : 0;
          el.setSelectionRange(caret, caret);
        } catch {
          // Caret restoration is best-effort.
        }
      };
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(setCaret);
      else setCaret();
    }

    /**
     * Resolve the session's composer input facade. DSH exposes this through
     * the session-scoped `conversation` service; absence degrades gracefully.
     */
    function inputFor(sessionId, ctx) {
      try {
        const sessions = ctx.get('sessions');
        const actx = sessions && typeof sessions.scope === 'function' ? sessions.scope(sessionId) : undefined;
        if (!actx || typeof actx.get !== 'function') return undefined;
        const conversation = actx.get('conversation');
        const input = conversation && conversation.input && typeof conversation.input.for === 'function'
          ? conversation.input.for(actx)
          : undefined;
        if (!input || typeof input.setDraft !== 'function') return undefined;
        return input;
      } catch {
        return undefined;
      }
    }

    function restoreSurroundingDraft(sessionId, captured, ctx) {
      const input = inputFor(sessionId, ctx);
      const draft = surroundingDraft(captured);
      const caret = captured && captured.preserveSurrounding === true ? captured.commandStart : 0;
      if (!input) return { draft, caret };
      try {
        input.setDraft(draft);
      } catch {
        // Never let composer plumbing failures break command execution.
      }
      return { draft, caret };
    }

    /**
     * Write the completed command text into the composer before a popup
     * level opens. The first popup captures the original slash-token span;
     * every deeper level reuses that snapshot so surrounding user text stays.
     */
    function completeDraft(sessionId, spec, captured, ctx) {
      if (!spec || typeof spec.draftLine !== 'string' || spec.draftLine.length === 0) return;
      const input = inputFor(sessionId, ctx);
      if (!input) return;
      input.setDraft(composePickerDraft(captured, spec.draftLine));
    }

    function prepareSession(sessionId, ctx, commandUi) {
      const sessions = ctx.get('sessions');
      const actx = sessions && typeof sessions.scope === 'function' ? sessions.scope(sessionId) : undefined;
      if (!actx) return;
      const controller = commandUi.popupFor(actx);
      if (!controller || patchedControllers.has(controller)) return;
      const flow = { sessionId, captured: null, activeLine: '', activeCaret: 0 };
      pickerFlows.set(controller, flow);
      const originalOpen = controller.open.bind(controller);
      controller.open = (command, spec, context, segment) => {
        const sid = (context && context.sessionId) || flow.sessionId;
        const pickerMeta = pickerSpecDepth.get(spec);
        if (pickerMeta && pickerMeta.depth === 0) {
          if (!consumeMenuDispatchPermit(commandUi, sid, pickerMeta.command)) return;
        } else if (pickerMeta) {
          if (authorizedChildOpens.get(spec) !== controller) return;
          authorizedChildOpens.delete(spec);
        }
        if (!flow.sessionId && sid) flow.sessionId = sid;
        if (flow.captured === null) {
          flow.captured = captureComposerState(sid, ctx, segment);
        }
        capturedSegments.set(controller, segment);
        // The popup's completed line is its Escape return point.
        const commandLine = spec && typeof spec.draftLine === 'string' ? spec.draftLine : '';
        flow.activeLine = composePickerDraft(flow.captured, commandLine);
        flow.activeCaret = pickerCommandCaret(flow.captured, commandLine);
        // Land the completed command text first, then publish the next popup.
        completeDraft(sid, spec, flow.captured, ctx);
        return originalOpen(command, spec, context, segment);
      };
      if (typeof controller.dismiss === 'function') {
        const originalDismiss = controller.dismiss.bind(controller);
        controller.dismiss = (opts) => {
          const captured = flow.captured;
          const activeLine = flow.activeLine;
          const activeCaret = flow.activeCaret;
          flow.captured = null;
          flow.activeLine = '';
          flow.activeCaret = 0;
          originalDismiss(opts);
          if (opts != null && opts.focusComposer === true) {
            if (activeLine.length > 0) ensureConfirmedDraft(flow.sessionId, captured, activeLine, activeCaret, ctx);
          }
          // Outside-pointer dismissal stays a plain DSH dismiss: no restore,
          // no forced focus, only the flow state above is cleared.
        };
      }
      patchedControllers.add(controller);
    }

    function controllerFor(sessionId, ctx) {
      const sessions = ctx.get('sessions');
      const actx = sessions && typeof sessions.scope === 'function' ? sessions.scope(sessionId) : undefined;
      return actx ? ctx.commandUi.popupFor(actx) : undefined;
    }

    function clearPickerFlow(sessionId, ctx) {
      const controller = controllerFor(sessionId, ctx);
      if (!controller) return;
      const flow = pickerFlows.get(controller);
      if (flow) {
        flow.captured = null;
        flow.activeLine = '';
        flow.activeCaret = 0;
      }
    }

    // ── Selection handling ───────────────────────────────────────────────
    async function selectOption(option, session, ctx) {
      let meta;
      try {
        meta = JSON.parse(option.id);
      } catch {
        throw new Error(`无法识别的选项：${option.label}`);
      }
      const command = typeof meta.command === 'string' ? meta.command : DEFAULT_PICKER_COMMAND;
      if (typeof meta.line === 'string' && meta.line.length > 0) {
        await executeLine(session.sessionId, meta.line, ctx);
        const controller = controllerFor(session.sessionId, ctx);
        const flow = controller ? pickerFlows.get(controller) : undefined;
        const captured = flow && flow.captured ? flow.captured : null;
        const restored = restoreSurroundingDraft(session.sessionId, captured, ctx);
        clearPickerFlow(session.sessionId, ctx);
        // Consume only the executed slash-command span; surrounding user text
        // remains exactly where it was before the picker opened.
        focusComposerAt(session.sessionId, captured, restored.caret, ctx);
        return;
      }
      if ((typeof meta.children === 'string' && meta.children.length > 0) || Array.isArray(meta.children)) {
        const controller = controllerFor(session.sessionId, ctx);
        if (!controller) throw new Error('命令选择器不可用，请重新打开斜杠菜单');
        const segment = capturedSegments.get(controller);
        if (!segment) throw new Error(`无法获取输入位置，请重新从斜杠菜单选择 /${command}`);
        const nextSpec = specForPath(command, meta.path, meta.children, ctx);
        authorizedChildOpens.set(nextSpec, controller);
        try {
          controller.open(command, nextSpec, session, segment);
        } finally {
          authorizedChildOpens.delete(nextSpec);
        }
        return;
      }
      throw new Error(`无法识别的选项：${option.label}`);
    }

    async function executeLine(sessionId, line, ctx) {
      const result = await ctx.remote.commands.execute(sessionId, line);
      if (!result || result.ok === false) {
        const detail = result && result.error && result.error.message ? result.error.message : '未知错误';
        throw new Error(`命令执行失败：${detail}`);
      }
      if (result.value === undefined) {
        throw new Error(`未知或无法识别的命令：${line}`);
      }
    }

    // ── DSH-level hint grammar ───────────────────────────────────────────
    // A small parser for `input.hint` strings like:
    //   [status | on <pro|flash> [--text <s>] | off <pro|flash>] [--preset <id>]
    // It expands enumerable branches into a shared-prefix picker tree. Hints that
    // contain unresolved free-text placeholders are intentionally left to
    // DSH's default free-form input behavior.

    function splitTopLevel(text, delimiter) {
      const parts = [];
      let start = 0;
      let depth = 0;
      for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        if (ch === '[' || ch === '<') depth += 1;
        else if (ch === ']' || ch === '>') depth -= 1;
        else if (ch === delimiter && depth === 0) {
          parts.push(text.slice(start, i));
          start = i + 1;
        }
      }
      parts.push(text.slice(start));
      return parts;
    }

    function parseSeq(text) {
      const items = [];
      let i = 0;
      while (i < text.length) {
        while (i < text.length && /\s/u.test(text[i])) i += 1;
        if (i >= text.length) break;
        const ch = text[i];
        if (ch === '[') {
          let depth = 0;
          let end = -1;
          for (let j = i; j < text.length; j += 1) {
            if (text[j] === '[') depth += 1;
            else if (text[j] === ']') {
              depth -= 1;
              if (depth === 0) {
                end = j;
                break;
              }
            }
          }
          if (end === -1) return null;
          const inner = text.slice(i + 1, end);
          i = end + 1;
          const seqs = parseAlternatives(inner);
          if (!seqs) return null;
          items.push({ type: 'optional', seqs });
        } else if (ch === '<') {
          const end = text.indexOf('>', i + 1);
          if (end === -1) return null;
          const inner = text.slice(i + 1, end);
          i = end + 1;
          const hasAlternatives = inner.includes('|');
          const choices = hasAlternatives ? inner.split('|').map((s) => s.trim()).filter(Boolean) : null;
          items.push({ type: 'placeholder', choices });
        } else {
          let j = i;
          while (j < text.length && !/\s/u.test(text[j]) && text[j] !== '[' && text[j] !== '<') j += 1;
          if (j === i) {
            i += 1;
            continue;
          }
          items.push({ type: 'word', value: text.slice(i, j) });
          i = j;
        }
      }
      return items;
    }

    function parseAlternatives(text) {
      const branches = splitTopLevel(text, '|').map((branch) => parseSeq(branch));
      return branches.some((seq) => seq === null) ? null : branches;
    }

    // DSH writes some free-text slots as bare words inside hints. The only
    // verified current example is `/plan`'s `[off|message]`, where `message`
    // means "any message" rather than a fixed choice. Keep the filter to the
    // verified word; other slot names (text/objective/preset/...) appear in
    // `<...>` and are already left unexpanded by the parser.
    const FREE_TEXT_SLOT_WORDS = new Set(['message']);

    function expandItem(item) {
      if (item.type === 'word') {
        if (FREE_TEXT_SLOT_WORDS.has(item.value)) return [];
        return [item.value];
      }
      if (item.type === 'placeholder') {
        if (!item.choices) return [null];
        return item.choices;
      }
      if (item.type === 'optional') {
        const expansions = [];
        for (const seq of item.seqs) {
          for (const branch of expandSeq(seq)) {
            if (branch !== null && !expansions.includes(branch)) expansions.push(branch);
          }
        }
        return ['', ...expansions];
      }
      return [];
    }

    function expandSeq(seq) {
      let results = [''];
      for (const item of seq) {
        const itemExp = expandItem(item);
        const next = [];
        for (const partial of results) {
          for (const token of itemExp) {
            if (token === null) continue;
            const combined = partial === '' ? token : `${partial} ${token}`;
            next.push(combined);
          }
        }
        results = next;
        if (results.length === 0) break;
      }
      return results;
    }

    function expandAll(seqs) {
      const out = [];
      for (const seq of seqs) {
        for (const text of expandSeq(seq)) {
          if (text === null) continue;
          const trimmed = text.trim();
          if (trimmed !== '' && !out.includes(trimmed)) out.push(trimmed);
        }
      }
      return out.slice(0, MAX_HINT_LEAVES);
    }

    function flatHintFields(commandName, expansions, description) {
      return expansions.map((text) => ({
        key: text,
        label: text,
        detail: description,
        line: `/${commandName}${text ? ` ${text}` : ''}`,
      }));
    }

    function hasPrefixConflict(tokenRows) {
      const rows = new Set(tokenRows.map((tokens) => tokens.join('\u0000')));
      for (const tokens of tokenRows) {
        for (let length = 1; length < tokens.length; length += 1) {
          if (rows.has(tokens.slice(0, length).join('\u0000'))) return true;
        }
      }
      return false;
    }

    function nestedHintFields(commandName, expansions, description) {
      const tokenRows = expansions.map((text) => text.split(/\s+/u).filter(Boolean));
      if (hasPrefixConflict(tokenRows)) return flatHintFields(commandName, expansions, description);

      const root = new Map();
      for (const tokens of tokenRows) {
        let level = root;
        for (const token of tokens) {
          let node = level.get(token);
          if (!node) {
            node = { token, children: new Map() };
            level.set(token, node);
          }
          level = node.children;
        }
      }

      const render = (level, parentPath) => [...level.values()].map((node) => {
        const path = [...parentPath, node.token];
        const field = { key: node.token, label: node.token, detail: description };
        if (node.children.size > 0) field.children = render(node.children, path);
        else field.line = `/${commandName} ${path.join(' ')}`;
        return field;
      });
      return render(root, []);
    }

    /**
     * A hint with no grammar markers at all (no `[]`, `<>`, or `|`) is a
     * plain free-text hint (for example `text to echo`) and never yields
     * enumerable picker leaves.
     */
    function hasHintGrammar(hint) {
      return /[\[\]<>|]/u.test(hint);
    }

    /**
     * Parse a host command's `input.hint` into a hierarchical picker tree.
     * Returns null when the hint has no enumerable leaf set.
     */
    function parseHintFields(commandName, hint, description) {
      if (!commandName || typeof hint !== 'string' || hint.trim() === '') return null;
      const trimmed = hint.trim();
      if (!hasHintGrammar(trimmed)) return null;
      const seqs = parseAlternatives(trimmed);
      if (!seqs || seqs.length === 0) return null;
      const expansions = expandAll(seqs);
      if (expansions.length === 0) return null;
      return { fields: nestedHintFields(commandName, expansions, description) };
    }

    // ── Automatic hint-driven decoration ─────────────────────────────────
    const hintDecorations = new Map();

    function currentSessionId(ctx) {
      try {
        const sessions = ctx.get('sessions');
        const list = sessions && sessions.list;
        const state = list && typeof list.getSnapshot === 'function' ? list.getSnapshot() : undefined;
        if (state && typeof state.current === 'string') return state.current;
        if (state && Array.isArray(state.items) && state.items.length > 0) return state.items[0].sessionId;
      } catch {
        // Session list may not be ready yet; the sync retry will catch it.
      }
      return undefined;
    }

    /**
     * One pass over the current session's command directory. Explicit trees
     * always win; generated trees are refreshed when their hint changes.
     */
    async function syncHintDecorations(ctx) {
      const sessionId = currentSessionId(ctx);
      if (!sessionId) return;
      let result;
      try {
        result = await ctx.remote.commands.list(sessionId);
      } catch (error) {
        console.warn('[mv-dsh-manager] command directory sync failed', error);
        return;
      }
      if (!result || result.ok === false) return;
      const commands = Array.isArray(result.value) ? result.value : [];
      const seen = new Set();
      for (const desc of commands) {
        const name = desc && desc.name;
        const hint = desc && desc.input && desc.input.hint;
        if (!name || !hint || explicitTrees.has(name)) continue;
        seen.add(name);
        const signature = JSON.stringify([hint, desc.description || '']);
        const existing = hintDecorations.get(name);
        if (existing && existing.signature === signature) continue;
        if (existing) {
          try {
            existing.dispose?.();
          } catch {
            // Ignore already-disposed decorations; the new hint still wins.
          }
          hintDecorations.delete(name);
          trees.delete(name);
        }
        const tree = parseHintFields(name, hint, desc.description);
        if (!tree) continue;
        try {
          registerGeneratedCommandTree(name, tree);
          const dispose = decorateCommand(ctx, name);
          hintDecorations.set(name, {
            signature,
            dispose: typeof dispose === 'function' ? dispose : null,
          });
        } catch (error) {
          trees.delete(name);
          console.warn(`[mv-dsh-manager] could not decorate /${name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      for (const [name, entry] of [...hintDecorations.entries()]) {
        if (seen.has(name)) continue;
        try {
          entry.dispose?.();
        } catch {
          // Ignore already-disposed decorations during directory cleanup.
        }
        hintDecorations.delete(name);
        trees.delete(name);
      }
    }

    function startHintDirectoryPicker(ctx) {
      let inFlight = null;
      const sync = () => {
        if (inFlight) return inFlight;
        inFlight = Promise.resolve()
          .then(() => syncHintDecorations(ctx))
          .catch((error) => {
            console.warn('[mv-dsh-manager] hint picker sync failed', error);
          })
          .finally(() => {
            inFlight = null;
          });
        return inFlight;
      };
      try {
        ctx.effect(() => {
          const unsubs = [];
          try {
            const off = ctx.on('connection/reset', () => void sync());
            if (typeof off === 'function') unsubs.push(off);
          } catch {
            // Event may be unavailable in tests/headless contexts.
          }
          try {
            const off = ctx.remote.$on('commands/change', () => void sync());
            if (typeof off === 'function') unsubs.push(off);
          } catch {
            // Remote event wiring is optional.
          }
          try {
            const list = ctx.get('sessions') && ctx.get('sessions').list;
            if (list && typeof list.subscribe === 'function') unsubs.push(list.subscribe(() => void sync()));
          } catch {
            // Session list subscriptions are best-effort.
          }
          queueMicrotask(() => void sync());
          return () => {
            for (const unsub of unsubs) {
              try {
                unsub();
              } catch {
                // Ignore already-disposed subscriptions.
              }
            }
            for (const [name, entry] of hintDecorations) {
              try {
                entry.dispose?.();
              } catch {
                // Ignore already-disposed decorations.
              }
              trees.delete(name);
            }
            hintDecorations.clear();
          };
        }, 'mv-dsh-manager: hint directory picker');
      } catch (error) {
        console.warn('[mv-dsh-manager] hint directory picker unavailable', error);
      }
    }

    // ── Public decoration helper ─────────────────────────────────────────
    /**
     * Decorate one host command with the generic recursive picker.
     * Returns the commandUi disposer.
     */
    function decorateCommand(ctx, name) {
      const commandUi = ctx && typeof ctx.get === 'function'
        ? (ctx.get('commandUi') || ctx.commandUi)
        : (ctx && ctx.commandUi);
      if (!commandUi || typeof commandUi.decorate !== 'function') {
        throw new Error(`commandUi 服务不可用；无法装饰 /${name}`);
      }
      installMenuDispatchGate(ctx, commandUi);
      const rootSpec = specForPath(name, [], null, ctx);
      return commandUi.decorate({
        name,
        available(session) {
          try {
            prepareSession(session && session.sessionId, ctx, commandUi);
          } catch (error) {
            console.warn('[mv-dsh-manager] command picker prepare failed', error);
          }
          return hasMenuDispatchPermit(commandUi, session && session.sessionId, name);
        },
        ui: rootSpec,
      });
    }

    // ── Plugin body ──────────────────────────────────────────────────────
    function apply(ctx) {
      planReviewClient.apply(ctx);
      registerCommandTree(DEFAULT_PICKER_COMMAND, defaultMvAideTree());
      decorateCommand(ctx, DEFAULT_PICKER_COMMAND);
      startHintDirectoryPicker(ctx);
    }

    exports.inject = inject;
    exports.registerCommandTree = registerCommandTree;
    exports.decorateCommand = decorateCommand;
    exports.syncHintDecorations = syncHintDecorations;
    exports.parseHintFields = parseHintFields;
    exports.apply = apply;
    return module.exports;
  },
});
