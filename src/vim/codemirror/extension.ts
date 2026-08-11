import {
  Compartment,
  EditorSelection,
  EditorState,
  Prec,
  StateEffect,
  StateField,
  findClusterBreak,
  type StateEffectType,
  type Extension,
} from "@codemirror/state";
import {
  EditorView,
  GutterMarker,
  RectangleMarker,
  ViewPlugin,
  gutter,
  keymap,
  layer,
  showPanel,
  type LayerMarker,
  type Panel,
  type PanelConstructor,
  type ViewUpdate,
} from "@codemirror/view";
import { isolateHistory } from "@codemirror/commands";
import { VimEngine } from "../core/engine";
import { VimSession } from "../core/session";
import type {
  VimEffectiveSelection,
  VimEngineHooks,
  VimOptions,
  VimRuntimeConfig,
  VimStatus,
  VimTextInputTarget,
} from "../core/types";
import {
  CodeMirrorVimBuffer,
  setVimVisualSnapshot,
  vimTransaction,
  vimVisualSnapshotField,
} from "./buffer";
import { isVimImeKeyboardEvent, vimKeyFromEvent } from "./keys";

export interface VimEditorExtensionContext {
  session: VimSession;
  documentForState: (state: EditorState) => VimDocumentContext;
  sourceEnabled: (extension: string) => boolean;
  runtimeForExtension: (extension: string) => VimRuntimeConfig;
  insertMappingsAllowed: (extension: string) => boolean;
  externalCommandsAllowed: () => boolean;
  shouldYieldKey?: (view: EditorView, event: KeyboardEvent) => boolean;
  onEnterVisual?: (view: EditorView) => void;
  onStatusChange?: (view: EditorView, status: VimStatus | null) => void;
  onViewFocused?: (view: EditorView) => void;
  hooksForView: (view: EditorView) => VimEngineHooks;
  // 块光标 CSS 颜色表达式；null 表示默认（跟随文本色），见 cursor-color.ts
  cursorColor?: () => string | null;
}

export interface VimDocumentContext {
  filePath: string;
  extension: string;
}

export interface VimEditorControllerSet {
  extension: Extension;
  refreshRuntimes(): void;
  prepareForRemoval(): void;
  effectiveSelection(view: EditorView): VimEffectiveSelection | null;
  destroy(): void;
  readonly size: number;
}

interface VimCompositionSession {
  target: VimTextInputTarget;
  latestText: string;
}

export function createVimEditorExtension(
  context: VimEditorExtensionContext,
): VimEditorControllerSet {
  const controllers = new Map<EditorView, VimEditorController>();
  const optionsCompartment = new Compartment();
  const viewStatusEffect = StateEffect.define<string | null>();
  const viewStatusField = StateField.define<string | null>({
    create(state) {
      return context.sourceEnabled(context.documentForState(state).extension)
        ? "mv-aide-vim-normal"
        : null;
    },
    update(value, transaction) {
      for (const effect of transaction.effects) {
        if (effect.is(viewStatusEffect)) return effect.value;
      }
      const enabled = context.sourceEnabled(
        context.documentForState(transaction.state).extension,
      );
      if (!enabled) return null;
      const fileChanged = context.documentForState(transaction.startState).filePath !==
        context.documentForState(transaction.state).filePath;
      return value === null || fileChanged ? "mv-aide-vim-normal" : value;
    },
    provide: (field) => EditorView.editorAttributes.from(field, (className) => {
      const attributes: Record<string, string> = {};
      if (className) attributes.class = `mv-aide-vim-active ${className}`;
      return attributes;
    }),
  });
  const vimCaretLayer = layer({
    above: true,
    class: "mv-aide-vim-caret-layer",
    markers(view): readonly LayerMarker[] {
      const status = view.state.field(viewStatusField, false);
      const markerClass = vimCaretMarkerClass(status);
      if (!markerClass) return [];
      return view.state.selection.ranges.flatMap((range) => {
        try {
          return RectangleMarker.forRange(
            view,
            `mv-aide-vim-caret ${markerClass}`,
            EditorSelection.cursor(range.head),
          );
        } catch {
          return [];
        }
      });
    },
    update(update) {
      return update.docChanged || update.selectionSet || update.viewportChanged ||
        update.geometryChanged ||
        update.startState.field(viewStatusField, false) !==
          update.state.field(viewStatusField, false);
    },
  });
  // 命令行文本（含 : / / ? 前缀）；非 null 时由底部面板回显，null 时面板消失。
  const commandLineTextEffect = StateEffect.define<string | null>();
  const commandLineTextField = StateField.define<string | null>({
    create: () => null,
    update(value, transaction) {
      for (const effect of transaction.effects) {
        if (effect.is(commandLineTextEffect)) return effect.value;
      }
      return value;
    },
    provide: (field) => {
      // 构造函数身份必须稳定：showPanel 按身份复用面板，若每次文本变化都
      // 返回新函数，面板会在每次按键时被销毁重建。
      const constructor: PanelConstructor = (view) =>
        createVimCommandLinePanel(view, field);
      return showPanel.from(field, (text) =>
        text === null ? null : constructor);
    },
  });
  // 块光标宽度自适应 + 光标颜色变量同步：宽度按光标处字形实测（全角字符
  // 自适应变宽），颜色读取设置（context.cursorColor），都写成 view.dom 上
  // 的 CSS 变量，vimEditorTheme 里按变量取值（缺省回退原行为）。
  // 布局读取不允许发生在 update 周期内，统一走 requestMeasure 延迟到测量相位。
  const cursorMetricsPlugin = ViewPlugin.fromClass(
    class {
      private queued = false;

      constructor(private readonly view: EditorView) {
        this.scheduleSync();
      }

      update(update: ViewUpdate): void {
        if (
          update.selectionSet || update.docChanged || update.viewportChanged ||
          update.geometryChanged ||
          update.transactions.some((transaction) => transaction.effects.length > 0)
        ) this.scheduleSync();
      }

      private scheduleSync(): void {
        if (this.queued) return;
        this.queued = true;
        this.view.requestMeasure({
          read: (view) => {
            this.queued = false;
            return {
              width: measureBlockCursorWidth(view),
              color: context.cursorColor?.() ?? null,
            };
          },
          write: ({ width, color }, view) => {
            const style = view.dom.style;
            if (width === null) style.removeProperty(VIM_CURSOR_WIDTH_VAR);
            else style.setProperty(VIM_CURSOR_WIDTH_VAR, `${width}px`);
            if (color) style.setProperty(VIM_CURSOR_COLOR_VAR, color);
            else style.removeProperty(VIM_CURSOR_COLOR_VAR);
          },
        });
      }
    },
  );

  const extension: Extension = [
    EditorState.transactionExtender.of((transaction) => {
      const previous = context.documentForState(transaction.startState).filePath;
      const next = context.documentForState(transaction.state).filePath;
      return previous === next ? null : { effects: setVimVisualSnapshot.of(null) };
    }),
    viewStatusField,
    vimCaretLayer,
    vimVisualSnapshotField,
    vimVisualLayer,
    commandLineTextField,
    cursorMetricsPlugin,
    optionsCompartment.of([]),
    vimEditorTheme,
    Prec.high(
      EditorView.inputHandler.of((view, _from, _to, text) => {
        const controller = controllers.get(view);
        if (!controller?.active) return false;
        if (!controller.acceptsNativeInput()) return true;
        if (
          controller.consumeNativeInputBypass() ||
          controller.consumeCompositionInputBypass() ||
          controller.isComposing() ||
          [...text].length !== 1
        ) return false;
        return controller.handleInput(text);
      }),
    ),
    Prec.lowest(keymap.of([{
      any(view, event) {
        const controller = controllers.get(view);
        if (!controller) return false;
        return new VimInputRouter(controller).fallback(event) === "consume";
      },
    }])),
    ViewPlugin.fromClass(
      class {
        private readonly controller: VimEditorController;

        constructor(view: EditorView) {
          // 不变量：一个 EditorView 只能有一个 vim controller。热重载/重复
          // 注册若让同一 view 出现第二个实例，两套引擎会互相撕扯 selection
          // 与文档。留 warn 证据并销毁旧实例。
          const existing = controllers.get(view);
          if (existing) {
            console.warn(
              "[mv-aide vim] duplicate controller on one EditorView; replacing the previous instance",
            );
            existing.disposeFromView();
          }
          this.controller = new VimEditorController(
            view,
            context,
            optionsCompartment,
            viewStatusField,
            viewStatusEffect,
            commandLineTextField,
            commandLineTextEffect,
          );
          controllers.set(view, this.controller);
        }

        update(update: ViewUpdate): void {
          this.controller.update(update);
        }

        destroy(): void {
          controllers.delete(this.controller.view);
          this.controller.disposeFromView();
        }
      },
    ),
  ];

  return {
    extension,
    refreshRuntimes() {
      for (const controller of controllers.values()) controller.refreshRuntime();
    },
    prepareForRemoval() {
      for (const controller of controllers.values()) controller.prepareForRemoval();
    },
    effectiveSelection(view) {
      return controllers.get(view)?.effectiveSelection() ?? null;
    },
    destroy() {
      for (const controller of [...controllers.values()]) controller.prepareForRemoval();
      for (const controller of [...controllers.values()]) controller.disposeFromView();
      controllers.clear();
    },
    get size() {
      return [...controllers.values()].filter((controller) => controller.active).length;
    },
  };
}

class VimEditorController {
  private engineValue: VimEngine | null = null;
  private readonly buffer: CodeMirrorVimBuffer;
  private documentContext: VimDocumentContext;
  private extension: string;
  private destroyed = false;
  private transitioning = false;
  private transitionScheduled = false;
  private pendingDocument: VimDocumentContext | null = null;
  private lifecycleGeneration = 0;
  private nativeInputBypass = false;
  private compositionInputBypass = false;
  private compositionTransactionPending = false;
  private composing = false;
  private pointerSelectionPending = false;
  private pointerSyncQueued = false;
  private externalCaretSyncQueued = false;
  private inputBoundary: VimDomInputBoundary | null = null;
  private mappingTimer: number | null = null;
  private composition: VimCompositionSession | null = null;
  private lastStatusMode: VimStatus["mode"] | null = null;

  constructor(
    readonly view: EditorView,
    private readonly context: VimEditorExtensionContext,
    private readonly optionsCompartment: Compartment,
    private readonly viewStatusField: StateField<string | null>,
    private readonly viewStatusEffect: StateEffectType<string | null>,
    private readonly commandLineTextField: StateField<string | null>,
    private readonly commandLineTextEffect: StateEffectType<string | null>,
  ) {
    this.documentContext = context.documentForState(view.state);
    this.extension = this.documentContext.extension;
    this.buffer = new CodeMirrorVimBuffer(view, () => this.documentContext.filePath);
    this.syncActivation();
  }

  get active(): boolean {
    return this.engineValue !== null && !this.transitioning;
  }

  get filePath(): string {
    return this.documentContext.filePath;
  }

  effectiveSelection(): VimEffectiveSelection | null {
    const snapshot = this.engineValue?.visualSnapshot();
    if (!snapshot) return null;
    const ranges = snapshot.ranges.map((range) => ({
      from: Math.min(range.anchor, range.head),
      to: Math.max(range.anchor, range.head),
    }));
    return {
      mode: snapshot.mode,
      ranges,
      activePosition: snapshot.activePosition,
      text: ranges.map((range) => this.buffer.text(range.from, range.to)).join(
        snapshot.mode === "visual-block" ? "\n" : "",
      ),
    };
  }

  handleClipboard(event: ClipboardEvent, cut: boolean): boolean {
    const engine = this.engineValue;
    if (!engine?.visualSnapshot()) return false;
    const text = cut
      ? engine.cutVisualToClipboard()
      : engine.copyVisualToClipboard();
    if (text === null) return false;
    event.clipboardData?.setData("text/plain", text);
    return true;
  }

  handleKey(key: string, event: KeyboardEvent): boolean {
    const engine = this.engineValue;
    if (!engine) return false;
    const mode = engine.mode;
    if (
      (mode === "insert" || mode === "replace") &&
      isPlainTextKey(event) &&
      !engine.awaitingInsertKey
    ) {
      return false;
    }
    const handled = engine.handleKey(key).handled;
    this.scheduleMappingFlush();
    if (handled) return true;
    return ownsUnmappedKey(mode, event);
  }

  handleInput(text: string): boolean {
    const handled = this.engineValue?.handleInsertInput(text) ?? false;
    this.scheduleMappingFlush();
    return handled;
  }

  acceptsNativeInput(): boolean {
    const mode = this.engineValue?.mode;
    return mode === "insert" || mode === "replace";
  }

  requiresInsertKey(): boolean {
    return this.engineValue?.awaitingInsertKey ?? false;
  }

  hasVisualSelection(): boolean {
    return this.engineValue?.visualSnapshot() !== null;
  }

  beginPointerSelection(): void {
    if (this.active) this.pointerSelectionPending = true;
  }

  finishPointerSelection(): void {
    if (!this.pointerSelectionPending) return;
    this.pointerSelectionPending = false;
    if (this.acceptsNativeInput()) return;
    this.schedulePointerSelectionSync();
  }

  bypassNextInput(): void {
    this.nativeInputBypass = true;
    queueMicrotask(() => {
      if (!this.destroyed) this.nativeInputBypass = false;
    });
  }

  consumeNativeInputBypass(): boolean {
    if (!this.nativeInputBypass) return false;
    this.nativeInputBypass = false;
    return true;
  }

  consumeCompositionInputBypass(): boolean {
    if (!this.compositionInputBypass) return false;
    this.compositionInputBypass = false;
    this.compositionTransactionPending = true;
    queueMicrotask(() => {
      if (!this.destroyed) this.compositionTransactionPending = false;
    });
    return true;
  }

  isComposing(): boolean {
    return this.composition !== null || this.composing;
  }

  beginComposition(text = ""): void {
    const engine = this.engineValue;
    if (!engine) return;
    this.clearMappingTimer();
    this.composing = true;
    this.composition = {
      target: engine.textInputTarget,
      latestText: text,
    };
  }

  updateComposition(text: string | null): void {
    if (text === null) return;
    if (!this.composition) this.beginComposition(text);
    else this.composition.latestText = text;
  }

  finishComposition(
    text: string | null,
    commit: boolean,
    expectNativeTransaction = false,
  ): void {
    const session = this.composition;
    this.composition = null;
    this.composing = false;
    if (session && commit) {
      const committed = text === null ? session.latestText : text;
      if (committed && session.target !== "discard") {
        this.engineValue?.commitComposedText(committed);
      }
      if (session.target === "insert" && expectNativeTransaction) {
        this.compositionInputBypass = true;
        queueMicrotask(() => {
          if (!this.destroyed) this.compositionInputBypass = false;
        });
      }
    }
    this.scheduleMappingFlush();
  }

  routeImeKey(event: KeyboardEvent): boolean {
    if (isImeKeyboardEvent(event)) {
      if (!this.composition) this.beginComposition();
      return true;
    }
    if (this.composition) {
      this.finishComposition(null, true, false);
      this.resetHostComposition();
    } else {
      this.compositionInputBypass = false;
      this.compositionTransactionPending = false;
    }
    return false;
  }

  acceptsNativeComposition(): boolean {
    return this.composition?.target === "insert";
  }

  private resetHostComposition(): void {
    this.view.contentDOM.dispatchEvent(new CompositionEvent("compositionend", {
      bubbles: true,
      data: "",
    }));
  }

  shouldYieldKey(event: KeyboardEvent): boolean {
    return this.context.shouldYieldKey?.(this.view, event) ?? false;
  }

  focusStatus(): void {
    if (!this.active) return;
    this.context.onViewFocused?.(this.view);
  }

  commitCommandLineText(text: string): void {
    const engine = this.engineValue;
    if (!engine || engine.textInputTarget !== "command-line" || !text) return;
    engine.commitComposedText(text);
  }

  update(update: ViewUpdate): void {
    if (this.destroyed) return;
    const nextDocument = this.context.documentForState(update.state);
    if (
      nextDocument.filePath !== this.documentContext.filePath ||
      nextDocument.extension !== this.documentContext.extension
    ) {
      this.scheduleDocumentTransition(nextDocument);
      return;
    }
    const engine = this.engineValue;
    if (!engine) return;
    const producedByVim = (transaction: (typeof update.transactions)[number]) =>
      transaction.annotation(vimTransaction) === true;
    const anyVimTransaction = update.transactions.some(producedByVim);
    // 逐事务拆分宿主文档变更：同一 update 里混入 vim 事务时（宿主 extender
    // 追加的事务与我们自己的 dispatch 同帧），仍须把引擎内部位置（marks /
    // jumps / visualAnchor / visualHead）映射过宿主变更，否则引擎位置腐化，
    // 后续操作会打在错误偏移上吃掉文本。
    const hostDocTransactions = update.transactions.filter(
      (transaction) => !producedByVim(transaction) && transaction.docChanged,
    );
    const producedByComposition = update.transactions.some((transaction) =>
      transaction.isUserEvent("input.type.compose"),
    );
    if (hostDocTransactions.length > 0) {
      engine.mapDocumentPositions((position) => {
        let mapped = position;
        for (const transaction of hostDocTransactions) {
          mapped = transaction.changes.mapPos(mapped, 1);
        }
        return mapped;
      });
    }
    if (hostDocTransactions.length > 0 && this.compositionTransactionPending) {
      this.compositionTransactionPending = false;
      return;
    }
    if (
      hostDocTransactions.length > 0 &&
      !producedByComposition &&
      !this.isComposing() &&
      engine.mode === "insert"
    ) {
      for (const transaction of hostDocTransactions) {
        transaction.changes.iterChanges((_fromA, _toA, _fromB, _toB, inserted) => {
          const text = inserted.toString();
          if (text) engine.noteNativeInsert(text);
        });
      }
    }
    if (
      update.selectionSet &&
      !anyVimTransaction &&
      !this.pointerSelectionPending &&
      !this.pointerSyncQueued &&
      !this.isComposing() &&
      engine.mode.startsWith("visual")
    ) {
      this.scheduleExternalCaretAdoption(update.state.selection.main.head);
    }
  }

  refreshRuntime(): void {
    if (!this.context.sourceEnabled(this.extension)) {
      this.deactivate(true);
      return;
    }
    // 设置变更（含光标颜色主题）经 refreshRuntimes 直达这里，即时重应用
    applyVimCursorColor(this.view, this.context.cursorColor?.() ?? null);
    if (!this.engineValue) {
      this.activate(true);
      return;
    }
    this.engineValue.setRuntime(this.context.runtimeForExtension(this.extension));
    this.syncPermissions();
    this.reconfigureOptions();
  }

  prepareForRemoval(): void {
    if (this.destroyed) return;
    this.lifecycleGeneration += 1;
    this.pendingDocument = null;
    this.transitioning = false;
    this.deactivate(true);
  }

  disposeFromView(): void {
    if (this.destroyed) return;
    this.lifecycleGeneration += 1;
    this.pendingDocument = null;
    this.destroyed = true;
    this.deactivate(false);
    this.view.dom.style.removeProperty(VIM_CURSOR_WIDTH_VAR);
    this.view.dom.style.removeProperty(VIM_CURSOR_COLOR_VAR);
  }

  private syncActivation(): void {
    if (this.context.sourceEnabled(this.extension)) this.activate(true);
    else if (this.engineValue) this.deactivate(true);
  }

  private activate(emitBufEnter: boolean): VimEngine | null {
    if (this.destroyed || this.engineValue) return this.engineValue;
    let initializing = true;
    const engine = new VimEngine(
      this.buffer,
      this.context.runtimeForExtension(this.extension),
      this.context.session,
      {
        ...this.context.hooksForView(this.view),
        onOptionsChanged: () => queueMicrotask(() => {
          if (!this.destroyed && this.engineValue) this.reconfigureOptions();
        }),
        onStatus: (status) => {
          if (!initializing) this.renderStatus(status);
        },
      },
    );
    initializing = false;
    this.engineValue = engine;
    this.inputBoundary = new VimDomInputBoundary(this.view, this);
    this.syncPermissions();
    const generation = this.lifecycleGeneration;
    queueMicrotask(() => {
      if (this.destroyed || generation !== this.lifecycleGeneration || this.engineValue !== engine) {
        return;
      }
      this.renderStatus(engine.status);
      this.reconfigureOptions();
      if (emitBufEnter) {
        void engine.runAutocmd("BufEnter", this.documentContext.filePath).catch(() => undefined);
      }
    });
    return engine;
  }

  private deactivate(clearPresentation: boolean): void {
    const engine = this.engineValue;
    this.inputBoundary?.destroy();
    this.inputBoundary = null;
    if (clearPresentation && !this.destroyed) this.clearOwnedPresentation();
    engine?.dispose();
    this.engineValue = null;
    this.pointerSelectionPending = false;
    this.pointerSyncQueued = false;
    this.externalCaretSyncQueued = false;
    this.nativeInputBypass = false;
    this.compositionInputBypass = false;
    this.compositionTransactionPending = false;
    this.composing = false;
    this.composition = null;
    this.clearMappingTimer();
    this.context.onStatusChange?.(this.view, null);
    this.lastStatusMode = null;
  }

  private clearOwnedPresentation(): void {
    if (this.view.state.field(this.viewStatusField, false) === undefined) return;
    this.view.dispatch({
      effects: [
        setVimVisualSnapshot.of(null),
        this.viewStatusEffect.of(null),
        this.commandLineTextEffect.of(null),
        this.optionsCompartment.reconfigure([]),
      ],
      annotations: [vimTransaction.of(true), isolateHistory.of("after")],
    });
  }

  private scheduleDocumentTransition(nextDocument: VimDocumentContext): void {
    this.pendingDocument = nextDocument;
    this.transitioning = true;
    if (this.transitionScheduled) return;
    this.transitionScheduled = true;
    const generation = this.lifecycleGeneration;
    queueMicrotask(() => {
      void this.drainDocumentTransitions(generation);
    });
  }

  private async drainDocumentTransitions(generation: number): Promise<void> {
    try {
      while (
        !this.destroyed &&
        generation === this.lifecycleGeneration &&
        this.pendingDocument
      ) {
        let target = this.pendingDocument;
        this.pendingDocument = null;
        const previous = this.documentContext;
        const pathChanged = previous.filePath !== target.filePath;
        const engine = this.engineValue;
        if (pathChanged && engine) {
          await engine.runAutocmd("BufLeave", previous.filePath).catch(() => undefined);
        }
        if (this.destroyed || generation !== this.lifecycleGeneration) return;
        if (this.pendingDocument) {
          target = this.pendingDocument;
          this.pendingDocument = null;
        }
        this.documentContext = target;
        this.extension = target.extension;
        this.deactivate(true);
        this.transitioning = false;
        if (this.context.sourceEnabled(this.extension)) {
          this.activate(pathChanged);
        }
      }
    } finally {
      this.transitionScheduled = false;
      if (!this.destroyed && generation === this.lifecycleGeneration) {
        this.transitioning = false;
        if (this.pendingDocument) this.scheduleDocumentTransition(this.pendingDocument);
      }
    }
  }

  private syncPermissions(): void {
    this.engineValue?.setExternalCommandsAllowed(this.context.externalCommandsAllowed());
    this.engineValue?.setInsertMappingsAllowed(this.context.insertMappingsAllowed(this.extension));
  }

  private schedulePointerSelectionSync(): void {
    if (this.pointerSyncQueued) return;
    this.pointerSyncQueued = true;
    const engine = this.engineValue;
    queueMicrotask(() => {
      this.pointerSyncQueued = false;
      if (!this.destroyed && engine && this.engineValue === engine) {
        engine.syncExternalSelection();
      }
    });
  }

  private scheduleExternalCaretAdoption(position: number): void {
    if (this.externalCaretSyncQueued) return;
    this.externalCaretSyncQueued = true;
    const engine = this.engineValue;
    queueMicrotask(() => {
      this.externalCaretSyncQueued = false;
      if (!this.destroyed && engine && this.engineValue === engine) {
        engine.adoptExternalCaret(position);
      }
    });
  }

  private reconfigureOptions(): void {
    if (this.destroyed) return;
    const options = this.engineValue?.options ?? null;
    this.view.dispatch({
      effects: this.optionsCompartment.reconfigure(
        options ? optionExtensions(options) : [],
      ),
      annotations: vimTransaction.of(true),
    });
  }

  private renderStatus(status: VimStatus): void {
    if (this.destroyed) return;
    const enteredVisual = status.mode.startsWith("visual") &&
      !this.lastStatusMode?.startsWith("visual");
    this.lastStatusMode = status.mode;
    if (enteredVisual) this.context.onEnterVisual?.(this.view);
    const className = statusClass(status);
    const commandText = status.mode === "command-line" ? status.command : null;
    const current = this.view.state.field(this.viewStatusField);
    const currentCommand = this.view.state.field(this.commandLineTextField);
    if (current !== className || currentCommand !== commandText) {
      const effects: StateEffect<unknown>[] = [];
      if (current !== className) {
        effects.push(this.viewStatusEffect.of(className));
      }
      if (currentCommand !== commandText) {
        effects.push(this.commandLineTextEffect.of(commandText));
      }
      this.view.dispatch({
        effects,
        annotations: vimTransaction.of(true),
      });
    }
    this.inputBoundary?.syncCommandLineInput(status.mode === "command-line");
    this.context.onStatusChange?.(this.view, status);
  }

  private scheduleMappingFlush(): void {
    this.clearMappingTimer();
    if (!this.engineValue?.hasPendingMapping) return;
    const hostWindow = this.view.dom.ownerDocument.defaultView;
    if (!hostWindow) return;
    this.mappingTimer = hostWindow.setTimeout(() => {
      this.mappingTimer = null;
      this.engineValue?.flushPendingMapping();
    }, this.engineValue.options.timeoutlen);
  }

  private clearMappingTimer(): void {
    if (this.mappingTimer === null) return;
    this.view.dom.ownerDocument.defaultView?.clearTimeout(this.mappingTimer);
    this.mappingTimer = null;
  }
}

/**
 * Own the actual editor DOM boundary instead of relying on dynamically added
 * CodeMirror DOM handlers, which older Obsidian runtimes do not refresh.
 */
class VimDomInputBoundary {
  private pointerTracking = false;
  private destroyed = false;
  private readonly router: VimInputRouter;
  private commandLineInput: HTMLTextAreaElement | null = null;
  private commandLineInputEndGuard = false;

  constructor(
    private readonly view: EditorView,
    private readonly controller: VimEditorController,
  ) {
    this.router = new VimInputRouter(controller);
    const content = view.contentDOM;
    content.addEventListener("keydown", this.onKeyDownCapture, true);
    content.addEventListener("beforeinput", this.onBeforeInput, true);
    content.addEventListener("paste", this.onPasteOrDrop, true);
    content.addEventListener("drop", this.onPasteOrDrop, true);
    content.addEventListener("copy", this.onCopy, true);
    content.addEventListener("cut", this.onCut, true);
    content.addEventListener("mousedown", this.onMouseDown, true);
    content.addEventListener("focusin", this.onFocusIn, true);
    content.addEventListener("compositionstart", this.onCompositionStart, true);
    content.addEventListener("compositionupdate", this.onCompositionUpdate, true);
    content.addEventListener("compositionend", this.onCompositionEnd, true);
    content.addEventListener("focusout", this.onFocusOut, true);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    const content = this.view.contentDOM;
    content.removeEventListener("keydown", this.onKeyDownCapture, true);
    content.removeEventListener("beforeinput", this.onBeforeInput, true);
    content.removeEventListener("paste", this.onPasteOrDrop, true);
    content.removeEventListener("drop", this.onPasteOrDrop, true);
    content.removeEventListener("copy", this.onCopy, true);
    content.removeEventListener("cut", this.onCut, true);
    content.removeEventListener("mousedown", this.onMouseDown, true);
    content.removeEventListener("focusin", this.onFocusIn, true);
    content.removeEventListener("compositionstart", this.onCompositionStart, true);
    content.removeEventListener("compositionupdate", this.onCompositionUpdate, true);
    content.removeEventListener("compositionend", this.onCompositionEnd, true);
    content.removeEventListener("focusout", this.onFocusOut, true);
    this.removeCommandLineInput(false);
    this.stopPointerTracking();
  }

  syncCommandLineInput(enabled: boolean): void {
    if (this.destroyed) return;
    if (!enabled) {
      this.removeCommandLineInput(true);
      return;
    }
    if (!this.commandLineInput) {
      const input = this.view.dom.ownerDocument.createElement("textarea");
      input.className = "mv-aide-vim-command-input";
      input.setAttribute("aria-label", "Vim command input");
      input.setAttribute("autocapitalize", "off");
      input.setAttribute("autocomplete", "off");
      input.setAttribute("spellcheck", "false");
      input.addEventListener("keydown", this.onCommandLineKeyDown, true);
      input.addEventListener("compositionstart", this.onCommandLineCompositionStart);
      input.addEventListener("compositionupdate", this.onCommandLineCompositionUpdate);
      input.addEventListener("compositionend", this.onCommandLineCompositionEnd);
      input.addEventListener("input", this.onCommandLineInput);
      input.addEventListener("focusout", this.onCommandLineFocusOut);
      this.view.dom.appendChild(input);
      this.commandLineInput = input;
    }
    this.positionCommandLineInput();
    if (this.view.dom.ownerDocument.activeElement !== this.commandLineInput) {
      this.commandLineInput.focus({ preventScroll: true });
    }
  }

  private readonly onKeyDownCapture = (event: KeyboardEvent): void => {
    const decision = this.router.route(event);
    if (decision === "consume") consumeDomEvent(event);
  };

  private readonly onBeforeInput = (event: InputEvent): void => {
    if (!this.controller.active) return;
    if (this.controller.isComposing()) {
      this.controller.updateComposition(event.data);
      if (this.controller.acceptsNativeComposition()) return;
      consumeDomEvent(event);
      return;
    }
    if (this.controller.acceptsNativeInput()) return;
    consumeDomEvent(event);
  };

  private readonly onPasteOrDrop = (event: ClipboardEvent | DragEvent): void => {
    if (!this.controller.active) return;
    if (!this.controller.acceptsNativeInput()) {
      consumeDomEvent(event);
      return;
    }
    this.controller.bypassNextInput();
  };

  private readonly onCopy = (event: ClipboardEvent): void => {
    if (this.controller.handleClipboard(event, false)) consumeDomEvent(event);
  };

  private readonly onCut = (event: ClipboardEvent): void => {
    if (this.controller.handleClipboard(event, true)) consumeDomEvent(event);
  };

  private readonly onMouseDown = (): void => {
    if (this.destroyed || this.pointerTracking) return;
    this.controller.focusStatus();
    this.pointerTracking = true;
    this.controller.beginPointerSelection();
    this.view.dom.ownerDocument.addEventListener("mouseup", this.onPointerUp, true);
  };

  private readonly onPointerUp = (): void => {
    this.stopPointerTracking();
    this.controller.finishPointerSelection();
  };

  private readonly onCompositionStart = (event: CompositionEvent): void => {
    this.controller.beginComposition(event.data);
  };

  private readonly onCompositionUpdate = (event: CompositionEvent): void => {
    this.controller.updateComposition(event.data);
  };

  private readonly onCompositionEnd = (event: CompositionEvent): void => {
    this.controller.finishComposition(event.data, true, true);
  };

  private readonly onFocusOut = (): void => this.controller.finishComposition("", false);

  private readonly onFocusIn = (): void => this.controller.focusStatus();

  private readonly onCommandLineKeyDown = (event: KeyboardEvent): void => {
    if (isImeKeyboardEvent(event)) {
      if (!this.controller.isComposing()) this.controller.beginComposition();
      return;
    }
    if (this.router.route(event) === "consume") consumeDomEvent(event);
  };

  private readonly onCommandLineCompositionStart = (event: CompositionEvent): void => {
    this.commandLineInputEndGuard = false;
    this.controller.beginComposition(event.data);
  };

  private readonly onCommandLineCompositionUpdate = (event: CompositionEvent): void => {
    this.controller.updateComposition(this.commandLineInput?.value || event.data);
  };

  private readonly onCommandLineCompositionEnd = (event: CompositionEvent): void => {
    const input = this.commandLineInput;
    const text = input?.value || event.data;
    this.controller.updateComposition(text);
    this.controller.finishComposition(text || null, true);
    if (input) input.value = "";
    this.commandLineInputEndGuard = true;
    queueMicrotask(() => {
      this.commandLineInputEndGuard = false;
    });
  };

  private readonly onCommandLineInput = (event: InputEvent): void => {
    const input = this.commandLineInput;
    if (!input) return;
    if (this.commandLineInputEndGuard) {
      input.value = "";
      return;
    }
    if (event.isComposing || this.controller.isComposing()) {
      this.controller.updateComposition(input.value || event.data);
      return;
    }
    this.controller.commitCommandLineText(input.value || event.data || "");
    input.value = "";
  };

  private readonly onCommandLineFocusOut = (): void => {
    this.controller.finishComposition("", false);
  };

  private positionCommandLineInput(): void {
    const input = this.commandLineInput;
    if (!input) return;
    let left = 0;
    let top = 0;
    try {
      // 命令行模式下隐形 textarea 跟到面板假光标处，让 IME 候选窗出现在
      // 命令行面板附近，而不是正文光标处。
      const caret = this.view.dom.querySelector(".mv-aide-vim-command-panel-caret");
      const rect = caret?.getBoundingClientRect();
      if (rect && (rect.left !== 0 || rect.top !== 0)) {
        left = Math.round(rect.left);
        top = Math.round(rect.top);
      } else {
        const coordinates = this.view.coordsAtPos(this.view.state.selection.main.head);
        left = Math.round(coordinates?.left ?? 0);
        top = Math.round(coordinates?.bottom ?? 0);
      }
    } catch {
      // Non-layout test hosts do not implement Range geometry.
    }
    input.style.setProperty("--mv-aide-vim-command-left", `${left}px`);
    input.style.setProperty("--mv-aide-vim-command-top", `${top}px`);
  }

  private removeCommandLineInput(restoreEditorFocus: boolean): void {
    const input = this.commandLineInput;
    if (!input) return;
    const ownedFocus = input.ownerDocument.activeElement === input;
    input.removeEventListener("keydown", this.onCommandLineKeyDown, true);
    input.removeEventListener("compositionstart", this.onCommandLineCompositionStart);
    input.removeEventListener("compositionupdate", this.onCommandLineCompositionUpdate);
    input.removeEventListener("compositionend", this.onCommandLineCompositionEnd);
    input.removeEventListener("input", this.onCommandLineInput);
    input.removeEventListener("focusout", this.onCommandLineFocusOut);
    input.remove();
    this.commandLineInput = null;
    this.commandLineInputEndGuard = false;
    if (restoreEditorFocus && ownedFocus) {
      queueMicrotask(() => {
        if (!this.destroyed) this.view.focus();
      });
    }
  }

  private stopPointerTracking(): void {
    if (!this.pointerTracking) return;
    this.pointerTracking = false;
    this.view.dom.ownerDocument.removeEventListener("mouseup", this.onPointerUp, true);
  }
}

export type VimInputDecision = "consume" | "native" | "host-first";

export interface VimInputController {
  readonly active: boolean;
  acceptsNativeInput(): boolean;
  requiresInsertKey(): boolean;
  hasVisualSelection(): boolean;
  handleKey(key: string, event: KeyboardEvent): boolean;
  isComposing(): boolean;
  routeImeKey(event: KeyboardEvent): boolean;
  shouldYieldKey(event: KeyboardEvent): boolean;
}

/** A single decision point for every editor key while Vim is active. */
export class VimInputRouter {
  constructor(private readonly controller: VimInputController) {}

  route(event: KeyboardEvent): VimInputDecision {
    if (!this.controller.active) return "native";
    if (this.controller.routeImeKey(event)) return "native";
    if (this.controller.shouldYieldKey(event)) {
      return "host-first";
    }
    if (this.controller.hasVisualSelection() && isSystemClipboardKey(event)) {
      return "host-first";
    }

    const key = vimKeyFromEvent(event);
    if (!key) return "native";
    if (event.metaKey) return "native";
    if (this.controller.acceptsNativeInput()) {
      if (isPlainTextKey(event)) {
        return this.controller.requiresInsertKey() &&
          this.controller.handleKey(key, event)
          ? "consume"
          : "native";
      }
      if (!IMMEDIATE_INSERT_KEYS.has(key)) return "host-first";
    }
    return this.controller.handleKey(key, event) ? "consume" : "host-first";
  }

  fallback(event: KeyboardEvent): VimInputDecision {
    if (
      !this.controller.active ||
      !this.controller.acceptsNativeInput() ||
      event.metaKey ||
      isImeKeyboardEvent(event) ||
      this.controller.isComposing() ||
      isPlainTextKey(event)
    ) return "native";
    const key = vimKeyFromEvent(event);
    if (!key || IMMEDIATE_INSERT_KEYS.has(key)) return "native";
    return this.controller.handleKey(key, event) ? "consume" : "native";
  }
}

const IMMEDIATE_INSERT_KEYS = new Set(["<Esc>", "<C-[>", "<C-w>", "<C-u>", "<C-r>"]);

function isSystemClipboardKey(event: KeyboardEvent): boolean {
  return (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    (event.key.toLowerCase() === "c" || event.key.toLowerCase() === "x");
}

function consumeDomEvent(event: Event): void {
  event.preventDefault();
  event.stopImmediatePropagation();
}

const vimEditorTheme = EditorView.baseTheme({
  "&.mv-aide-vim-active .cm-content": {
    caretColor: "transparent !important",
  },
  ".mv-aide-vim-command-panel": {
    padding: "2px 8px",
    fontFamily: "var(--font-monospace)",
    fontSize: "0.9em",
    backgroundColor: "var(--background-secondary)",
    borderTop: "1px solid var(--background-modifier-border)",
    whiteSpace: "pre",
    overflowX: "auto",
  },
  ".mv-aide-vim-command-panel-caret": {
    display: "inline-block",
    width: "1ch",
    minWidth: "1ch",
    height: "1.15em",
    verticalAlign: "text-bottom",
    backgroundColor: "color-mix(in srgb, var(--text-normal) 62%, transparent)",
  },
  "&.mv-aide-vim-active .cm-cursor": {
    opacity: "0 !important",
  },
  ".mv-aide-vim-caret-layer": {
    pointerEvents: "none",
  },
  ".mv-aide-vim-caret": {
    boxSizing: "border-box",
  },
  ".mv-aide-vim-caret-block": {
    minWidth: "var(--mv-aide-vim-cursor-w, 1ch) !important",
    width: "var(--mv-aide-vim-cursor-w, 1ch) !important",
    opacity: "1 !important",
    backgroundColor:
      "var(--mv-aide-vim-cursor-color, color-mix(in srgb, var(--text-normal) 62%, transparent)) !important",
  },
  ".mv-aide-vim-visual-layer": {
    pointerEvents: "none",
  },
  ".mv-aide-vim-visual-selection": {
    backgroundColor: "var(--text-selection)",
    minWidth: "var(--mv-aide-vim-cursor-w, 1ch)",
  },
  "&.mv-aide-vim-owned-line-numbers .cm-gutter.cm-lineNumbers": {
    display: "none",
  },
  ".mv-aide-vim-line-numbers": {
    color: "var(--text-faint)",
  },
  ".mv-aide-vim-command-input": {
    position: "fixed",
    left: "var(--mv-aide-vim-command-left, 0px)",
    top: "var(--mv-aide-vim-command-top, 0px)",
    width: "1px",
    height: "1px",
    padding: "0",
    border: "0",
    opacity: "0",
    pointerEvents: "none",
    zIndex: "-1",
  },
  ".mv-aide-vim-caret-bar": {
    minWidth: "2px !important",
    width: "2px !important",
    backgroundColor: "var(--text-normal) !important",
  },
  ".mv-aide-vim-caret-underline": {
    borderBottom:
      "2px solid var(--mv-aide-vim-cursor-color, var(--text-normal)) !important",
    minWidth: "var(--mv-aide-vim-cursor-w, 1ch) !important",
    width: "var(--mv-aide-vim-cursor-w, 1ch) !important",
    backgroundColor: "transparent !important",
  },
});

function vimCaretMarkerClass(status: string | null | undefined): string | null {
  if (!status) return null;
  if (status === "mv-aide-vim-insert" || status === "mv-aide-vim-command-line") {
    return "mv-aide-vim-caret-bar";
  }
  if (status === "mv-aide-vim-replace" || status === "mv-aide-vim-operator") {
    return "mv-aide-vim-caret-underline";
  }
  return "mv-aide-vim-caret-block";
}

/** 编辑器底部的 vim 命令行面板：回显 : / / ? 输入，退出命令行模式即移除。 */
function createVimCommandLinePanel(
  view: EditorView,
  field: StateField<string | null>,
): Panel {
  const dom = view.dom.ownerDocument.createElement("div");
  dom.className = "mv-aide-vim-command-panel";
  dom.setAttribute("aria-label", "Vim command line");
  const text = view.dom.ownerDocument.createElement("span");
  text.className = "mv-aide-vim-command-panel-text";
  const caret = view.dom.ownerDocument.createElement("span");
  caret.className = "mv-aide-vim-command-panel-caret";
  caret.setAttribute("aria-hidden", "true");
  dom.append(text, caret);
  const sync = (state: EditorState): void => {
    text.textContent = state.field(field) ?? "";
  };
  sync(view.state);
  return {
    dom,
    update(update) {
      sync(update.state);
    },
  };
}

const vimVisualLayer = layer({
  above: false,
  class: "mv-aide-vim-visual-layer",
  markers(view): readonly LayerMarker[] {
    const snapshot = view.state.field(vimVisualSnapshotField, false);
    if (!snapshot) return [];
    const markers: LayerMarker[] = [];
    for (const range of snapshot.ranges) {
      const from = Math.min(range.anchor, range.head);
      const to = Math.max(range.anchor, range.head);
      try {
        markers.push(...RectangleMarker.forRange(
          view,
          "mv-aide-vim-visual-selection",
          EditorSelection.range(from, to),
        ));
      } catch {
        // A range outside the current measured viewport produces no marker.
      }
    }
    return markers;
  },
  update(update) {
    return update.docChanged || update.viewportChanged || update.geometryChanged ||
      update.startState.field(vimVisualSnapshotField, false) !==
        update.state.field(vimVisualSnapshotField, false);
  },
});

const VIM_CURSOR_WIDTH_VAR = "--mv-aide-vim-cursor-w";
const VIM_CURSOR_COLOR_VAR = "--mv-aide-vim-cursor-color";

function applyVimCursorColor(view: EditorView, color: string | null): void {
  if (color) view.dom.style.setProperty(VIM_CURSOR_COLOR_VAR, color);
  else view.dom.style.removeProperty(VIM_CURSOR_COLOR_VAR);
}

/**
 * 量出主光标处字形的实际显示宽度（px）：中文等全角字符下块光标自适应变宽。
 * 行尾、暂时不可测量（未排版/折行边界）时返回 null，主题回退 1ch。
 */
function measureBlockCursorWidth(view: EditorView): number | null {
  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head);
  if (head >= line.to) return null;
  const from = head - line.from;
  const to = findClusterBreak(line.text, from);
  if (to <= from) return null;
  const start = view.coordsAtPos(head);
  const end = view.coordsAtPos(head + (to - from));
  if (!start || !end) return null;
  const width = end.left - start.left;
  // 折行边界会让下一字形落在下一视觉行（得到负宽），回退默认宽度
  return width > 0.5 ? Math.round(width * 100) / 100 : null;
}

function ownsUnmappedKey(mode: VimStatus["mode"], event: KeyboardEvent): boolean {
  if (mode === "insert" || mode === "replace") return false;
  if (event.metaKey) return false;
  return !event.isComposing;
}

function isImeKeyboardEvent(event: KeyboardEvent): boolean {
  return isVimImeKeyboardEvent(event);
}

function isPlainTextKey(event: KeyboardEvent): boolean {
  return event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey;
}

function statusClass(status: VimStatus): string {
  if (status.mode === "insert") return "mv-aide-vim-insert";
  if (status.mode === "replace") return "mv-aide-vim-replace";
  if (status.mode === "command-line") return "mv-aide-vim-command-line";
  if (status.mode === "operator-pending") return "mv-aide-vim-operator";
  if (status.mode.startsWith("visual")) return "mv-aide-vim-visual";
  return "mv-aide-vim-normal";
}

class VimLineNumberMarker extends GutterMarker {
  constructor(readonly label: string) {
    super();
  }

  eq(other: VimLineNumberMarker): boolean {
    return this.label === other.label;
  }

  toDOM(view: EditorView): Text {
    return view.dom.ownerDocument.createTextNode(this.label);
  }
}

function optionExtensions(options: VimOptions): Extension[] {
  const extensions: Extension[] = [
    EditorState.allowMultipleSelections.of(true),
    EditorState.tabSize.of(options.tabstop),
    EditorView.editorAttributes.of({ class: "mv-aide-vim-owned-line-numbers" }),
  ];
  if (options.wrap) extensions.push(EditorView.lineWrapping);
  if (options.number || options.relativenumber) {
    extensions.push(
      gutter({
        class: "mv-aide-vim-line-numbers",
        lineMarker(view, line) {
          const lineNumber = view.state.doc.lineAt(line.from).number;
          const activePosition = view.state.field(vimVisualSnapshotField, false)
            ?.activePosition ??
            view.state.selection.main.head;
          const activeLine = view.state.doc.lineAt(activePosition).number;
          const value = !options.relativenumber
            ? lineNumber
            : lineNumber === activeLine
              ? options.number ? lineNumber : 0
              : Math.abs(lineNumber - activeLine);
          return new VimLineNumberMarker(String(value));
        },
        lineMarkerChange(update) {
          return update.docChanged ||
            update.selectionSet ||
            update.startState.field(vimVisualSnapshotField, false) !==
              update.state.field(vimVisualSnapshotField, false);
        },
        initialSpacer(view) {
          return new VimLineNumberMarker("9".repeat(String(view.state.doc.lines).length));
        },
        updateSpacer(spacer, update) {
          const next = "9".repeat(String(update.state.doc.lines).length);
          return spacer instanceof VimLineNumberMarker && spacer.label === next
            ? spacer
            : new VimLineNumberMarker(next);
        },
      },
      ),
    );
  }
  return extensions;
}
