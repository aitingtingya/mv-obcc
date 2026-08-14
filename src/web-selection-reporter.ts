/**
 * Web Viewer 页内选区推送通道：页面加载/导航期间宿主侧的
 * `executeJavaScript` 会挂起或拒绝，因此"加载中选中文字"永远只能等页面
 * 加载完才能被读到。这里改为页内脚本监听 `selectionchange`，选区一变就
 * `console.log` 打点；宿主侧（main.ts）监听 webview 元素的
 * `console-message` 事件即时收到，绕开 executeJavaScript 的加载期阻塞。
 *
 * 沿用插件既有"注入页内脚本"模式（llm-web-autotrigger-script.ts 等）：
 * 脚本幂等（window key + version），宿主在 webview `dom-ready` 时注入
 * （每次导航后新文档需重注）。
 */

export const WEB_SELECTION_PREFIX = "__MV_AIDE_WEB_SELECTION__";

export const WEB_SELECTION_STATE_KEY = "__mvAideWebSelectionReporter";

/** 解析 console-message 的 message 字段：命中前缀返回选区文本，否则 null。 */
export function parseWebSelectionMessage(message: string): string | null {
  if (typeof message !== "string") return null;
  if (!message.startsWith(WEB_SELECTION_PREFIX)) return null;
  return message.slice(WEB_SELECTION_PREFIX.length);
}

/**
 * 注入页内脚本：监听 selectionchange，选区文本变化即 console.log 打点
 * （空文本也打点 = 取消选中）。重复注入是 no-op；安装失败不影响页面。
 */
export function installWebSelectionReporterScript(): string {
  return `(() => {
    try {
      const key = ${JSON.stringify(WEB_SELECTION_STATE_KEY)};
      if (window[key]) return { success: true, installed: false };
      let last = null;
      const readSelection = () => {
        try {
          const sel = window.getSelection ? window.getSelection() : null;
          return sel ? sel.toString() : "";
        } catch {
          return "";
        }
      };
      const report = () => {
        try {
          const text = readSelection();
          if (text === last) return;
          last = text;
          console.log(${JSON.stringify(WEB_SELECTION_PREFIX)} + text);
        } catch {
          // Never break page selection handling.
        }
      };
      const onSelectionChange = () => report();
      const cleanup = () => {
        document.removeEventListener("selectionchange", onSelectionChange);
        delete window[key];
      };
      document.addEventListener("selectionchange", onSelectionChange);
      window[key] = { cleanup: cleanup };
      report();
      return { success: true, installed: true };
    } catch (error) {
      return {
        success: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  })()`;
}
