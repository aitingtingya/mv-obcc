// Cross-origin file-drop receiver for the DSH browser half.
//
// The Obsidian host owns native path resolution and image byte reads. This
// module owns only DSH session admission: structured @file references and
// native draft images. Keeping that boundary here prevents the manager's
// settings, plugin, skill, preset, and command-picker surfaces from learning
// about Electron or Obsidian drag data.

window.__ModuleLoader__.load({
  id: '@mv-aide/mv-dsh-manager/file-drop-client',
  factory: () => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const PROTOCOL = 'mv-aide/file-drop';
    const SCHEMA = 2;
    const MAX_FILES = 20;
    const TRANSACTION_TTL_MS = 30000;
    const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
    const IMAGE_SOURCE_POLICY = Symbol.for('@mv-aide/image-source-policy/v1');
    const COPY = {
      zh: {
        noSession: '当前没有可接收文件的 DSH 对话。',
        sessionChanged: '文件拖入期间当前对话已切换，请重新拖入。',
        inputUnavailable: '当前 DSH 版本没有提供可用的会话输入接口。',
        referenceUnavailable: '当前 DSH 版本没有提供结构化 @file 引用接口。',
        imageUnavailable: '当前 DSH 版本没有提供图片草稿接口。',
        blocked: '当前对话输入已锁定，暂时不能添加文件。',
        busy: '当前对话正在提交内容，暂时不能添加文件。',
        invalidBatch: '文件拖入请求格式无效。',
        tooMany: `一次最多拖入 ${MAX_FILES} 个文件。`,
        duplicate: '文件拖入请求包含重复项目。',
        invalidPath: '文件路径包含 DSH 无法安全表示的字符。',
        expired: '文件拖入请求已过期，请重新拖入。',
        stale: '文件拖入请求已经失效。',
        format: '仅支持 PNG、JPG、WebP、GIF 格式的图片。',
        count: '图片数量超过当前 DSH 限制。',
        oneSize: '图片大小超过当前 DSH 单图限制。',
        totalSize: '图片总大小超过当前 DSH 消息限制。',
        changed: '图片内容与准备阶段不一致，请重新拖入。',
        rejected: '当前 DSH 输入状态拒绝了文件。',
        disabled: '已在 mv-dsh-manager 插件配置中关闭 Obsidian 文件拖入。',
      },
      en: {
        noSession: 'There is no current DSH conversation to receive files.',
        sessionChanged: 'The current conversation changed during the drop. Drop the files again.',
        inputUnavailable: 'This DSH version does not expose a usable session input interface.',
        referenceUnavailable: 'This DSH version does not expose structured @file references.',
        imageUnavailable: 'This DSH version does not expose draft image support.',
        blocked: 'The current conversation input is locked and cannot accept files.',
        busy: 'The current conversation is submitting and cannot accept files.',
        invalidBatch: 'The file-drop request is invalid.',
        tooMany: `At most ${MAX_FILES} files can be dropped at once.`,
        duplicate: 'The file-drop request contains duplicate items.',
        invalidPath: 'A file path contains characters DSH cannot represent safely.',
        expired: 'The file-drop request expired. Drop the files again.',
        stale: 'The file-drop request is no longer current.',
        format: 'Only PNG, JPG, WebP, and GIF images are supported.',
        count: 'The image count exceeds the current DSH limit.',
        oneSize: 'An image exceeds the current DSH per-image size limit.',
        totalSize: 'The images exceed the current DSH per-message size limit.',
        changed: 'Image content no longer matches the prepared drop. Drop it again.',
        rejected: 'The current DSH input state rejected the files.',
        disabled: 'Obsidian file drop is disabled in mv-dsh-manager plugin settings.',
      },
    };

    function copy() {
      const language = String(document.documentElement?.lang || navigator.language || '').toLowerCase();
      return language.startsWith('zh') ? COPY.zh : COPY.en;
    }

    function normalizedPath(value) {
      const original = String(value || '');
      const slash = original.replaceAll('\\', '/');
      const drive = /^([A-Za-z]:)(?:\/|$)/u.exec(slash);
      const unc = /^\/\/([^/]+)\/([^/]+)(?:\/|$)/u.exec(slash);
      let root = '';
      let rest = slash;
      let windows = false;
      if (drive) {
        windows = true;
        root = drive[1].toLowerCase();
        rest = slash.slice(drive[0].length);
      } else if (unc) {
        windows = true;
        root = `//${unc[1].toLowerCase()}/${unc[2].toLowerCase()}`;
        rest = slash.slice(unc[0].length);
      } else if (slash.startsWith('/')) {
        root = '/';
        rest = slash.slice(1);
      }
      const parts = [];
      for (const segment of rest.split('/')) {
        if (!segment || segment === '.') continue;
        if (segment === '..') {
          if (parts.length > 0) parts.pop();
          else parts.push(segment);
          continue;
        }
        parts.push(windows ? segment.toLowerCase() : segment);
      }
      return { original, root, parts, absolute: root !== '', windows };
    }

    function referencePath(filePath, cwd) {
      const file = normalizedPath(filePath);
      const workspace = normalizedPath(cwd);
      if (!file.absolute) return filePath;
      if (workspace.absolute && file.root === workspace.root && file.windows === workspace.windows) {
        const contains = workspace.parts.every((segment, index) => file.parts[index] === segment);
        if (contains && file.parts.length > workspace.parts.length) {
          const originalParts = String(filePath).replaceAll('\\', '/').split('/').filter(Boolean);
          return originalParts.slice(originalParts.length - (file.parts.length - workspace.parts.length)).join('/');
        }
      }
      return filePath;
    }

    function formatMention(filePath) {
      for (const character of filePath) {
        const code = character.codePointAt(0) || 0;
        if (character === '"' || code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return undefined;
      }
      return /\s/u.test(filePath) ? `@"${filePath}"` : `@${filePath}`;
    }

    function basename(filePath) {
      const parts = String(filePath).split(/[\\/]/u).filter(Boolean);
      return parts.at(-1) || filePath;
    }

    function safeGet(ctx, name) {
      try {
        return typeof ctx?.get === 'function' ? ctx.get(name) : ctx?.[name];
      } catch {
        return undefined;
      }
    }

    function currentSession(ctx) {
      const sessions = safeGet(ctx, 'sessions');
      const state = sessions?.list?.getSnapshot?.();
      const sessionId = typeof state?.current === 'string' ? state.current : undefined;
      if (!sessionId) return undefined;
      const cwd = typeof state?.byId?.[sessionId]?.cwd === 'string'
        ? state.byId[sessionId].cwd
        : undefined;
      let actx;
      try {
        actx = sessions.scope?.(sessionId);
      } catch {
        return undefined;
      }
      const conversation = safeGet(actx, 'conversation');
      let input;
      try {
        input = conversation?.input?.for?.(actx);
      } catch {
        return undefined;
      }
      const inputTriggers = safeGet(actx, 'inputTriggers');
      const referenceController = inputTriggers?.sessionOf?.(actx);
      return { sessions, state, sessionId, cwd, actx, conversation, input, referenceController };
    }

    function inputState(target) {
      return target?.input?.state?.getSnapshot?.();
    }

    function composerBlocked(target) {
      const block = target?.conversation?.blocks?.storeFor?.(target.sessionId)?.getSnapshot?.();
      if (block !== undefined && block !== null) return true;
      const textarea = document.querySelector?.('textarea[data-phase]');
      return Boolean(textarea && (textarea.disabled || textarea.readOnly));
    }

    function imageLimits(target) {
      try {
        return target.sessions.sessionOf(target.actx)?.projections?.faceOf('imageLimits')?.getSnapshot?.();
      } catch {
        return undefined;
      }
    }

    function validateInput(target) {
      const text = copy();
      if (!target?.input || typeof target.input.setDraft !== 'function') throw new Error(text.inputUnavailable);
      const state = inputState(target);
      if (!state || typeof state.draft !== 'string' || typeof state.draftRev !== 'number') {
        throw new Error(text.inputUnavailable);
      }
      if (state.phase === 'adjudicating' || state.phase === 'submitting') throw new Error(text.busy);
      if (composerBlocked(target)) throw new Error(text.blocked);
      return state;
    }

    function validateMetadata(files, target) {
      const text = copy();
      if (!Array.isArray(files) || files.length === 0) throw new Error(text.invalidBatch);
      if (files.length > MAX_FILES) throw new Error(text.tooMany);
      const ids = new Set();
      const prepared = [];
      for (const item of files) {
        if (!item || typeof item.id !== 'string' || ids.has(item.id)) {
          throw new Error(ids.has(item?.id) ? text.duplicate : text.invalidBatch);
        }
        ids.add(item.id);
        if (typeof item.name !== 'string' || !Number.isSafeInteger(item.size) || item.size < 0) {
          throw new Error(text.invalidBatch);
        }
        if (item.kind === 'reference') {
          if (typeof item.path !== 'string') throw new Error(text.invalidBatch);
          const displayPath = target.cwd ? referencePath(item.path, target.cwd) : item.path;
          const mention = formatMention(displayPath);
          if (!mention) throw new Error(text.invalidPath);
          if (typeof target.input.insertReference !== 'function'
              || typeof target.referenceController?.serializeReference !== 'function') {
            throw new Error(text.referenceUnavailable);
          }
          prepared.push({
            id: item.id,
            kind: 'reference',
            path: item.path,
            mention,
            label: basename(displayPath),
          });
          continue;
        }
        if (item.kind !== 'image' || typeof item.mediaType !== 'string' || !IMAGE_TYPES.has(item.mediaType)) {
          throw new Error(text.format);
        }
        prepared.push({
          id: item.id,
          kind: 'image',
          name: item.name,
          size: item.size,
          lastModified: Number.isFinite(item.lastModified) ? item.lastModified : 0,
          mediaType: item.mediaType,
        });
      }
      validateImageLimits(prepared, target);
      return prepared;
    }

    function validateImageLimits(files, target) {
      const images = files.filter(file => file.kind === 'image');
      if (images.length === 0) return;
      const text = copy();
      if (typeof target.conversation?.createDraftImages !== 'function'
          || typeof target.conversation?.releaseDraftImages !== 'function'
          || typeof target.input?.addImages !== 'function'
          || typeof target.input?.removeImage !== 'function') {
        throw new Error(text.imageUnavailable);
      }
      const state = inputState(target);
      const existingIds = Array.isArray(state?.imageIds) ? state.imageIds : [];
      const existing = typeof target.conversation.draftImages === 'function'
        ? target.conversation.draftImages(existingIds)
        : [];
      if (existing.length !== existingIds.length) throw new Error(text.imageUnavailable);
      const limits = imageLimits(target);
      if (!limits) throw new Error(text.imageUnavailable);
      if (Array.isArray(limits.mediaTypes)
          && images.some(image => !limits.mediaTypes.includes(image.mediaType))) {
        throw new Error(text.format);
      }
      if (Number.isFinite(limits.maxImagesPerMessage)
          && existing.length + images.length > limits.maxImagesPerMessage) {
        throw new Error(text.count);
      }
      if (Number.isFinite(limits.maxImageBytes)
          && images.some(image => image.size > limits.maxImageBytes)) {
        throw new Error(text.oneSize);
      }
      const total = existing.reduce((sum, image) => sum + Number(image?.file?.size || 0), 0)
        + images.reduce((sum, image) => sum + image.size, 0);
      if (Number.isFinite(limits.maxMessageImageBytes) && total > limits.maxMessageImageBytes) {
        throw new Error(text.totalSize);
      }
    }

    function arrayBufferLike(value) {
      return value && Number.isSafeInteger(value.byteLength) && typeof value.slice === 'function';
    }

    function createFiles(payloads, prepared, autoFitImageSize) {
      const text = copy();
      if (!Array.isArray(payloads)) throw new Error(text.invalidBatch);
      const expected = prepared.filter(file => file.kind === 'image');
      if (payloads.length !== expected.length) throw new Error(text.changed);
      const byId = new Map(payloads.map(payload => [payload?.id, payload]));
      return expected.map((meta) => {
        const payload = byId.get(meta.id);
        if (!payload || payload.mediaType !== meta.mediaType || !arrayBufferLike(payload.bytes)) {
          throw new Error(text.changed);
        }
        if (payload.bytes.byteLength !== meta.size || !IMAGE_TYPES.has(payload.mediaType)) {
          throw new Error(text.changed);
        }
        const file = new File([payload.bytes], meta.name, {
          type: meta.mediaType,
          lastModified: meta.lastModified,
        });
        Object.defineProperty(file, IMAGE_SOURCE_POLICY, {
          configurable: false,
          enumerable: false,
          value: Object.freeze({ autoFitImageSize: autoFitImageSize === true }),
        });
        return file;
      });
    }

    // Read the composer textarea caret. The drag gesture starts outside the
    // iframe, so `document.activeElement` is never the textarea — query it
    // directly instead; its selection survives focus loss within this iframe.
    // Fallback to "append at end" whenever the DOM textarea disagrees with the
    // observable draft (stale render, future DSH layout changes, etc.).
    function composerCaret(state) {
      try {
        const textarea = document.querySelector?.('textarea[data-phase]');
        if (
          textarea &&
          typeof textarea.selectionStart === 'number' &&
          textarea.value === state.draft
        ) {
          const start = Math.max(0, Math.min(textarea.selectionStart, state.draft.length));
          const end = Math.max(
            start,
            Math.min(
              typeof textarea.selectionEnd === 'number' ? textarea.selectionEnd : start,
              state.draft.length,
            ),
          );
          return { start, end };
        }
      } catch {
        // DOM access is best-effort; fall through to the classic append mode.
      }
      return null;
    }

    function imagePlaceholderText(name) {
      return `[image: ${String(name ?? '')}]`;
    }

    function rewriteDraft(target, before, start, end, insert) {
      target.input.setDraft(`${before.slice(0, start)}${insert}${before.slice(end)}`);
      const state = inputState(target);
      if (!state) throw new Error(copy().inputUnavailable);
      return state;
    }

    // Insert every prepared item (reference mentions and image pseudo-links)
    // at the composer caret in drop order, replacing an active text selection.
    // All spacing guards and fallback rules reduce to the historical
    // "append at end" behaviour when no composer caret can be located.
    function applyPreparedInsertions(target, prepared) {
      if (prepared.length === 0) return;
      const input = target.input;
      let state = inputState(target);
      if (!state) throw new Error(copy().inputUnavailable);
      const caret = composerCaret(state);
      let anchor = caret ? caret.start : state.draft.length;
      let replaceEnd = caret ? caret.end : state.draft.length;

      // Left-side guard: never glue an insertion onto a non-space character.
      // (In append mode this reproduces the historical trailing-space pad.)
      // The right side is handled per insertion below.
      if (anchor > 0 && !/\s/u.test(state.draft.charAt(anchor - 1))) {
        state = rewriteDraft(target, state.draft, anchor, anchor, ' ');
        anchor += 1;
        replaceEnd += 1;
      }

      for (const item of prepared) {
        state = inputState(target);
        if (!state) throw new Error(copy().inputUnavailable);
        anchor = Math.max(0, Math.min(anchor, state.draft.length));
        replaceEnd = Math.max(anchor, Math.min(replaceEnd, state.draft.length));
        if (item.kind === 'image') {
          const snippet = `${imagePlaceholderText(item.name)} `;
          const before = state.draft;
          state = rewriteDraft(target, before, anchor, replaceEnd, snippet);
          anchor += snippet.length;
          replaceEnd = anchor;
          continue;
        }
        const beforeLength = state.draft.length;
        const selectionLength = replaceEnd - anchor;
        const accepted = input.insertReference({
          source: 'reference',
          ref: item.mention,
          label: item.label,
          appearance: 'file',
          clipboardText: item.mention,
        }, {
          start: anchor,
          end: replaceEnd,
          draftRev: state.draftRev,
        });
        if (!accepted) throw new Error(copy().rejected);
        const nextState = inputState(target);
        if (!nextState) throw new Error(copy().inputUnavailable);
        const delta = nextState.draft.length - beforeLength;
        // New draft length = before - selection + inserted, so the post-insert
        // caret sits at anchor + inserted = anchor + delta + selection.
        anchor = Math.max(0, anchor + delta + selectionLength);
        replaceEnd = anchor;
        if (
          anchor < nextState.draft.length &&
          !/\s/u.test(nextState.draft.charAt(anchor - 1)) &&
          !/\s/u.test(nextState.draft.charAt(anchor))
        ) {
          // Mention chips do not guarantee a trailing space; pad when the
          // inserted chip is glued to the character that follows it.
          state = rewriteDraft(target, nextState.draft, anchor, anchor, ' ');
          anchor += 1;
          replaceEnd = anchor;
        }
      }
    }

    function commitPrepared(target, prepared, imagePayloads, autoFitImageSize) {
      const original = inputState(target);
      if (!original) throw new Error(copy().inputUnavailable);
      const originalDraft = original.draft;
      const files = createFiles(imagePayloads, prepared, autoFitImageSize);
      validateImageLimits(prepared, target);
      let attachments = [];
      try {
        if (files.length > 0) {
          attachments = [...target.conversation.createDraftImages(files)];
          if (!target.input.addImages(attachments.map(attachment => attachment.id))) {
            throw new Error(copy().rejected);
          }
        }
        applyPreparedInsertions(target, prepared);
      } catch (error) {
        try {
          target.input.setDraft(originalDraft);
          for (const attachment of attachments) target.input.removeImage?.(attachment.id);
          target.conversation.releaseDraftImages?.(attachments);
        } catch {
          // Preserve the primary admission error; DSH owns any final teardown.
        }
        throw error;
      }
    }

    function apply(ctx, options = {}) {
      const enabled = () => options.get?.().fileDropEnabled !== false;
      ctx.effect(() => {
        let channel;
        let prepared;
        const seen = new Set();

        const reply = (type, payload = {}) => {
          if (!channel) return;
          window.parent.postMessage({
            protocol: PROTOCOL,
            schema: SCHEMA,
            token: channel.token,
            generation: channel.generation,
            type,
            ...payload,
          }, channel.origin);
        };

        const validChannelMessage = (event, data) => channel
          && event.source === window.parent
          && event.origin === channel.origin
          && data?.protocol === PROTOCOL
          && data.schema === SCHEMA
          && data.token === channel.token
          && data.generation === channel.generation;

        const fail = (type, requestId, error) => {
          const message = typeof error?.message === 'string' ? error.message : String(error);
          reply(type, { requestId, ok: false, error: message });
        };

        const onPrepare = async (data, requestChannel) => {
          try {
            if (!enabled()) throw new Error(copy().disabled);
            if (typeof data.requestId !== 'string' || seen.has(data.requestId)) {
              throw new Error(copy().stale);
            }
            seen.add(data.requestId);
            if (seen.size > 100) seen.delete(seen.values().next().value);
            const target = currentSession(ctx);
            if (!target) throw new Error(copy().noSession);
            validateInput(target);
            const files = validateMetadata(data.files, target);
            if (typeof data.autoFitImageSize !== 'boolean') throw new Error(copy().invalidBatch);
            const references = files.filter(file => file.kind === 'reference');
            await Promise.all(references.map(reference =>
              target.referenceController.serializeReference(
                'reference', reference.mention, new AbortController().signal,
              )));
            if (channel !== requestChannel) return;
            const transactionId = crypto.randomUUID();
            prepared = {
              requestId: data.requestId,
              transactionId,
              sessionId: target.sessionId,
              files,
              autoFitImageSize: data.autoFitImageSize,
              createdAt: Date.now(),
            };
            reply('prepared', { requestId: data.requestId, transactionId, ok: true });
          } catch (error) {
            if (channel !== requestChannel) return;
            prepared = undefined;
            fail('prepared', data?.requestId, error);
          }
        };

        const onCommit = (data) => {
          try {
            if (!enabled()) throw new Error(copy().disabled);
            if (!prepared
                || data.requestId !== prepared.requestId
                || data.transactionId !== prepared.transactionId) {
              throw new Error(copy().stale);
            }
            if (Date.now() - prepared.createdAt > TRANSACTION_TTL_MS) throw new Error(copy().expired);
            const transaction = prepared;
            prepared = undefined;
            const target = currentSession(ctx);
            if (!target || target.sessionId !== transaction.sessionId) throw new Error(copy().sessionChanged);
            validateInput(target);
            commitPrepared(target, transaction.files, data.images, transaction.autoFitImageSize);
            reply('result', {
              requestId: transaction.requestId,
              ok: true,
              count: transaction.files.length,
            });
          } catch (error) {
            prepared = undefined;
            fail('result', data?.requestId, error);
          }
        };

        const onMessage = (event) => {
          const data = event.data;
          if (event.source !== window.parent || data?.protocol !== PROTOCOL || data.schema !== SCHEMA) return;
          if (data.type === 'init') {
            if (data.targetOrigin !== window.location.origin || event.origin === 'null' || !event.origin) return;
            if (typeof data.token !== 'string' || typeof data.generation !== 'number') return;
            const changed = !channel
              || channel.origin !== event.origin
              || channel.token !== data.token
              || channel.generation !== data.generation;
            channel = { origin: event.origin, token: data.token, generation: data.generation };
            if (changed) {
              prepared = undefined;
              seen.clear();
            }
            reply('ready', {
              enabled: enabled(),
              capabilities: { references: true, images: true, sourceImagePolicy: true },
              ...enabled() ? {} : { error: copy().disabled },
            });
            return;
          }
          if (!validChannelMessage(event, data)) return;
          if (data.type === 'prepare') void onPrepare(data, channel);
          else if (data.type === 'commit') onCommit(data);
          else if (data.type === 'cancel' && prepared?.requestId === data.requestId) prepared = undefined;
        };

        window.addEventListener('message', onMessage);
        const unsubscribe = options.subscribe?.(() => {
          if (!enabled()) prepared = undefined;
          if (channel) reply('ready', {
            enabled: enabled(),
            capabilities: { references: true, images: true, sourceImagePolicy: true },
            ...enabled() ? {} : { error: copy().disabled },
          });
        });
        return () => {
          window.removeEventListener('message', onMessage);
          unsubscribe?.();
          channel = undefined;
          prepared = undefined;
          seen.clear();
        };
      }, 'mv-dsh-manager: file drop client');
    }

    exports.inject = ['sessions'];
    exports.normalizedPath = normalizedPath;
    exports.referencePath = referencePath;
    exports.formatMention = formatMention;
    exports.validateMetadata = validateMetadata;
    exports.applyPreparedInsertions = applyPreparedInsertions;
    exports.commitPrepared = commitPrepared;
    exports.apply = apply;
    return module.exports;
  },
});
