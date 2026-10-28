/**
 * Obsidian Web Viewer 原生右键菜单集成。
 *
 * 已核实 Obsidian 1.9.12 与 1.14.4 的实现一致：webviewer 视图在
 * `displayContextMenu` 中运行时动态调用实例方法
 * `contextMenuItemsForSelection(selectionText, isEditable)` 组装 Electron
 * 菜单项数组（搜索/提取/复制），随后无条件弹出系统菜单。官方没有扩展钩子，
 * 因此包装该方法：先调原方法链拿到原生项，再追加分隔符与我们的模板项。
 * 原型补丁覆盖新视图，实例自有方法单独包装，不删除其他扩展的方法；
 * 老版本 Obsidian 没有该方法，特性检测返回 null，调用方回退到页内注入菜单。
 */

/** Obsidian 产出的菜单项与 Electron MenuItemConstructorOptions 同形。 */
export interface NativeMenuItemLike {
  label?: string;
  type?: string;
  click?(): void;
  accelerator?: string;
  role?: string;
  enabled?: boolean;
  [key: string]: unknown;
}

export interface WebSelectionMenuViewLike {
  contextMenuItemsForSelection?(
    selectionText: string,
    isEditable: boolean,
  ): NativeMenuItemLike[];
}

type MenuProvider = (selectionText: string) => NativeMenuItemLike[] | null;
const METHOD = "contextMenuItemsForSelection";
const activePatches = new WeakMap<WebSelectionMenuViewLike, () => void>();

function installPatch(
  target: WebSelectionMenuViewLike,
  getItems: MenuProvider,
  depth: WeakMap<WebSelectionMenuViewLike, number>,
): (() => void) | null {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Called below with the actual host receiver via original.call(this, ...).
  const original = target.contextMenuItemsForSelection;
  if (typeof original !== "function" || activePatches.has(target)) return null;
  const descriptor = Object.getOwnPropertyDescriptor(target, METHOD);
  if (descriptor && !descriptor.configurable && !descriptor.writable) return null;
  if (!descriptor && !Object.isExtensible(target)) return null;
  const state: { provider: MenuProvider | null } = { provider: getItems };
  const patched = function (
    this: WebSelectionMenuViewLike,
    selectionText: string,
    isEditable: boolean,
  ): NativeMenuItemLike[] {
    // An outer extension may retain this function after our removal. It then
    // remains a transparent link, with no plugin callback or menu contribution.
    if (!state.provider) return original.call(this, selectionText, isEditable);
    const nesting = depth.get(this) ?? 0;
    depth.set(this, nesting + 1);
    try {
      const base = original.call(this, selectionText, isEditable);
      if (nesting || !state.provider) return base;
      const items = state.provider(selectionText);
      return items?.length ? [...base, { type: "separator" }, ...items] : base;
    } finally {
      if (nesting) depth.set(this, nesting);
      else depth.delete(this);
    }
  };
  Object.defineProperty(target, METHOD, {
    value: patched,
    enumerable: descriptor?.enumerable ?? false,
    configurable: descriptor?.configurable ?? true,
    writable: descriptor && "value" in descriptor ? descriptor.writable : true,
  });
  const unpatch = () => {
    if (!state.provider) return;
    state.provider = null;
    // Restore only our own property. Never overwrite an extension installed
    // after us, including one that now calls our transparent retired wrapper.
    if (Object.getOwnPropertyDescriptor(target, METHOD)?.value === patched) {
      if (descriptor) Object.defineProperty(target, METHOD, descriptor);
      else delete target.contextMenuItemsForSelection;
    }
    activePatches.delete(target);
  };
  activePatches.set(target, unpatch);
  return unpatch;
}

/**
 * 包装 `view.contextMenuItemsForSelection`，让 Obsidian 原生 webviewer 右键
 * 菜单在原生项之后追加 `getItems(selectionText)` 返回的条目（前置分隔符）。
 *
 * 返回还原函数；以下情况返回 null：
 *  - view 上没有该方法（老版本 Obsidian）；
 *  - 该 view 已打过补丁（防止重复包装）。
 *
 * `getItems` 在每次弹菜单时调用，返回 null 或空数组则不追加任何内容。
 */
export function patchWebSelectionMenu(
  view: WebSelectionMenuViewLike,
  getItems: MenuProvider,
): (() => void) | null {
  return installPatch(view, getItems, new WeakMap());
}

/** Owns prototype and instance patches, sharing one invocation scope. */
export class WebSelectionMenuController {
  private readonly depth = new WeakMap<WebSelectionMenuViewLike, number>();
  private readonly prototypes = new Map<WebSelectionMenuViewLike, () => void>();
  private readonly instances = new Map<WebSelectionMenuViewLike, () => void>();
  private readonly views = new Set<WebSelectionMenuViewLike>();

  ensure(view: WebSelectionMenuViewLike, getItems: MenuProvider): boolean {
    if (typeof view.contextMenuItemsForSelection !== "function") return false;
    const prototype = Object.getPrototypeOf(view) as WebSelectionMenuViewLike | null;
    const inherited = !!prototype && this.install(prototype, getItems, this.prototypes);
    const ready = Object.prototype.hasOwnProperty.call(view, METHOD)
      ? this.install(view, getItems, this.instances)
      : inherited;
    if (ready) this.views.add(view);
    return ready;
  }

  has(view: WebSelectionMenuViewLike): boolean { return this.views.has(view); }

  retain(live: ReadonlySet<WebSelectionMenuViewLike>): void {
    for (const view of this.views) {
      if (live.has(view)) continue;
      this.instances.get(view)?.();
      this.instances.delete(view);
      this.views.delete(view);
    }
  }

  clear(): void {
    for (const unpatch of this.instances.values()) unpatch();
    for (const unpatch of this.prototypes.values()) unpatch();
    this.instances.clear();
    this.prototypes.clear();
    this.views.clear();
  }

  private install(
    target: WebSelectionMenuViewLike,
    getItems: MenuProvider,
    records: Map<WebSelectionMenuViewLike, () => void>,
  ): boolean {
    if (records.has(target)) return true;
    const unpatch = installPatch(target, getItems, this.depth);
    if (!unpatch) return false;
    records.set(target, unpatch);
    return true;
  }
}
