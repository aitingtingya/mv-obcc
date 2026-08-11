import type { VimCursorColorCustom, VimSettings } from "./settings";

export interface VimCursorColorTheme {
  id: string;
  // 中文标签，设置页经 t() 翻译
  label: string;
  rgb: VimCursorColorCustom;
}

/** 内置块光标配色主题；id 存进 settings.vim.cursorColorTheme。 */
export const VIM_CURSOR_COLOR_THEMES: readonly VimCursorColorTheme[] = [
  { id: "violet", label: "紫", rgb: { r: 148, g: 103, b: 189 } },
  { id: "blue", label: "蓝", rgb: { r: 66, g: 133, b: 244 } },
  { id: "green", label: "绿", rgb: { r: 52, g: 168, b: 83 } },
  { id: "orange", label: "橙", rgb: { r: 251, g: 140, b: 0 } },
  { id: "red", label: "红", rgb: { r: 234, g: 67, b: 53 } },
  { id: "cyan", label: "青", rgb: { r: 4, g: 180, b: 190 } },
];

/**
 * 解析当前设置应使用的块光标颜色。返回 null 表示默认（跟随文本色 62%），
 * 否则给出色相与默认一致透明度的 color-mix 表达式，供 CSS 变量
 * --mv-aide-vim-cursor-color 使用。
 */
export function resolveVimCursorColorCss(settings: VimSettings): string | null {
  if (settings.cursorColorTheme === "default") return null;
  const rgb = settings.cursorColorTheme === "custom"
    ? settings.cursorColorCustom
    : VIM_CURSOR_COLOR_THEMES.find(
      (theme) => theme.id === settings.cursorColorTheme,
    )?.rgb;
  if (!rgb) return null;
  return `color-mix(in srgb, rgb(${rgb.r} ${rgb.g} ${rgb.b}) 62%, transparent)`;
}
