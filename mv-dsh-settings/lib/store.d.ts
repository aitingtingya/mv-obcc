/**
 * Types for the plugin-owned settings store shared by the mv-AIDE managed DSH
 * plugins. The implementation is plain JS (`lib/store.js`) because it runs both
 * inside the DSH process and inside this repository's tests; this file exists
 * for the Obsidian-side TypeScript consumers.
 */

export declare const SETTINGS_FILE_SCHEMA: 1;

/** Namespaces are partitioned by their owning plugin's package name. */
export type SettingsNamespace = string;

/** A whole user-value set of one namespace, plus whatever callers keep beside it. */
export type SettingsValues = Record<string, unknown>;

/** Diagnostic sink used across the store; never throws into the caller. */
export type SettingsLog = (message: string) => void;

/**
 * The canonical `~/.mv-aide/dsh/settings.json` location.
 *
 * Re-exported from `mv-dsh-compat/lib/paths.js`, which is the single path
 * authority (DEVELOPMENT-GUIDELINES 规范三:60).
 */
export declare function mvAideSettingsFile(homeDirectory?: string): string;

/** Read the document, quarantining an unreadable/corrupt file instead of failing. */
export declare function readSettingsDocument(
  filePath?: string,
  log?: SettingsLog,
): Promise<{ schema: number; namespaces: Record<SettingsNamespace, SettingsValues> }>;

/** Persist the document atomically, keeping one `.bak` of the previous bytes. */
export declare function writeSettingsDocument(
  filePath: string,
  document: unknown,
): Promise<void>;

/**
 * One serialized read-modify-write over the shared document. Every writer must
 * go through here: reading the document and then calling
 * {@link writeSettingsDocument} directly would sit outside the queue and could
 * lose a concurrent namespace's update.
 */
export declare function writeSettingsDocumentQueued(
  filePath: string,
  mutate: (document: { namespaces: Record<SettingsNamespace, SettingsValues> }) => void,
  log?: SettingsLog,
): Promise<unknown>;

/** Subscribe to one namespace's effective values; returns an unsubscribe. */
export declare function subscribeSettingsNamespace(
  namespace: SettingsNamespace,
  listener: (effective: SettingsValues) => void,
): () => void;

/** Every live mv-AIDE settings scope in this process, keyed by namespace name. */
export declare function registeredSettingsScopes(): SettingsScope[];

/** One live scope by namespace, or null when that plugin is not mounted. */
export declare function settingsScopeFor(namespace: SettingsNamespace): SettingsScope | null;

export interface SettingsScope {
  readonly namespace: SettingsNamespace;
  readonly filePath: string;
  readonly writable: boolean;
  /** Which surface owns editing: `'panel'` or `'dsh'`. */
  manage(): 'panel' | 'dsh';
  setManage(source: 'panel' | 'dsh'): void;
  /** Stop serving this scope to the settings route. */
  release(): void;
  get(): SettingsValues;
  /** Only the stored overrides, never the defaults. */
  user(): SettingsValues;
  isReady(): boolean;
  subscribe(listener: (next: SettingsValues, previous: SettingsValues) => void): () => void;
  watch(listener: (next: SettingsValues, previous: SettingsValues) => void): () => void;
  load(): Promise<SettingsValues>;
  set(key: string, value: unknown): Promise<SettingsValues>;
  unset(key: string): Promise<SettingsValues>;
  apply(patch: { set?: SettingsValues; unset?: string[] }): Promise<SettingsValues>;
  replace(values: SettingsValues): Promise<SettingsValues>;
}

export interface CreateSettingsScopeOptions {
  namespace: SettingsNamespace;
  defaults?: SettingsValues;
  validate?: (values: SettingsValues) => SettingsValues;
  filePath?: string;
  log?: SettingsLog;
  manage?: 'panel' | 'dsh';
}

/**
 * A settings scope with the shape the released DSH scope had, backed by the
 * mv-AIDE document.
 */
export declare function createSettingsScope(options: CreateSettingsScopeOptions): SettingsScope;
