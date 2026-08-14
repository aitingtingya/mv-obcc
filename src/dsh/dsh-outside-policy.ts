/**
 * The mv-agent "IDE 工具" grid: a 100% copy of the IDE桥接 settings'
 * tool items (names, descriptions, grouping, order), where the only
 * difference is the trailing control — a scope dropdown
 * ("仅库内工作区 / 库内外均可用") instead of a toggle.
 */
export interface DshScopeChannel {
  /** Persisted policy key (existing mv-AIDE settings keys / tool names). */
  key: string;
  /** Chinese name, copied verbatim from the IDE桥接 settings. */
  name: string;
  /** Chinese description, copied verbatim from the IDE桥接 settings. */
  description: string;
  group: "passive-state" | "passive-diff" | "active";
  /**
   * The diff row writes `reviewOutsideVault` instead of the per-channel
   * policy, because "Diff 审核行为" IS the out-of-vault diff review switch.
   */
  scopeTarget?: "reviewOutsideVault";
}

export const DSH_SCOPE_CHANNELS: readonly DshScopeChannel[] = [
  // ── 被动 / 状态感知（5）─────────────────────────────────────────────
  {
    key: "pushLintErrors",
    name: "推送 lint 错误计数",
    description:
      "lint 诊断更新时向 MCP 客户端推送各文件错误计数；只推错误，不推警告。",
    group: "passive-state",
  },
  {
    key: "includeHeadingBreadcrumb",
    name: "快照附 heading 面包屑",
    description:
      "在选区快照中附带光标所在 heading 层级路径；仅对 Markdown 和 LaTeX 文件生效。",
    group: "passive-state",
  },
  {
    key: "trackMarkdown",
    name: "追踪 Markdown 页面",
    description: "追踪当前 Markdown 文件、光标和选区。",
    group: "passive-state",
  },
  {
    key: "trackPdf",
    name: "追踪 PDF 页面",
    description: "追踪当前 PDF 文件、页码和文本选区。",
    group: "passive-state",
  },
  {
    key: "trackWebview",
    name: "追踪 Web Viewer 页面",
    description: "追踪 Obsidian 内置浏览器的标题、URL 和文本选区。",
    group: "passive-state",
  },
  // ── 被动 / diff（1）────────────────────────────────────────────────
  {
    key: "diffReview",
    name: "Diff 审核行为",
    description:
      "完全跟随 Claude Code 权限模式：默认权限会显示审核；acceptEdits 会直接接受编辑，插件不会额外弹窗。",
    group: "passive-diff",
    scopeTarget: "reviewOutsideVault",
  },
  // ── 主动（11）──────────────────────────────────────────────────────
  {
    key: "getLatestSelection",
    name: "获取最近标签与选区",
    description: "焦点离开 Obsidian 后仍可读取最近一次状态。",
    group: "active",
  },
  {
    key: "getOpenEditors",
    name: "获取全部打开标签",
    description: "包括 Markdown、PDF、图片、网页、终端和其他插件页面。",
    group: "active",
  },
  {
    key: "openFile",
    name: "在 Obsidian 中打开文件",
    description: "允许 Claude 主动定位仓库内文件和文本范围。",
    group: "active",
  },
  {
    key: "readCurrentWebPage",
    name: "读取最近网页为 Markdown",
    description:
      "把最近浏览且仍打开的 Web Viewer 页面转换为 Markdown，不刷新或跳转页面。用于让 Claude 查看网页全貌，而不是只读取选区。",
    group: "active",
  },
  {
    key: "getDiagnostics",
    name: "获取 lint 诊断",
    description: "按严重级别（错误/警告/全部）和文件路径过滤读取 lint 诊断。",
    group: "active",
  },
  {
    key: "getTerminalOutput",
    name: "读取终端输出",
    description: "读取插件集成终端标签的末尾输出行，可按标签名过滤。",
    group: "active",
  },
  {
    key: "searchVaultSymbols",
    name: "搜索库内符号",
    description: "按子串搜索全库 Markdown heading 等符号。",
    group: "active",
  },
  {
    key: "getBacklinks",
    name: "获取反向链接",
    description: "列出链接到指定文件的库内文件。",
    group: "active",
  },
  {
    key: "getOutgoingLinks",
    name: "获取出链",
    description: "列出指定文件链接出去的库内文件。",
    group: "active",
  },
  {
    key: "searchTags",
    name: "搜索标签",
    description: "按子串搜索库内使用中的标签（返回 #tag）。",
    group: "active",
  },
  {
    key: "listNotesByTag",
    name: "按标签列笔记",
    description: "列出携带指定标签的库内文件。",
    group: "active",
  },
];

export const DSH_PASSIVE_STATE_CHANNELS = DSH_SCOPE_CHANNELS.filter(
  (channel) => channel.group === "passive-state",
);
export const DSH_PASSIVE_DIFF_CHANNELS = DSH_SCOPE_CHANNELS.filter(
  (channel) => channel.group === "passive-diff",
);
export const DSH_ACTIVE_CHANNELS = DSH_SCOPE_CHANNELS.filter(
  (channel) => channel.group === "active",
);

/** Keys persisted into `outsideToolPolicy` (the diff row is excluded). */
export const DSH_POLICY_KEYS: ReadonlySet<string> = new Set(
  DSH_SCOPE_CHANNELS.filter((channel) => channel.scopeTarget !== "reviewOutsideVault").map(
    (channel) => channel.key,
  ),
);
