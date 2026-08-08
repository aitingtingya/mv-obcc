// 纯函数：由有序 heading 列表 + 光标行号求 heading 面包屑链。不 import
// obsidian，保持可单测。md 的 HeadingCache 与 tex 的 TexSection 都先映射成
// BreadcrumbHeading 再传入。

export interface BreadcrumbHeading {
  /** 标题文本。 */
  heading: string;
  /** 层级（md 1-6；tex 用 latexLevel part=0 … subparagraph=6），越小越高。 */
  level: number;
  /** 0 起始行号。 */
  line: number;
}

/**
 * 求光标行的 heading 链（如 "第 3 章 > 3.2 路径积分"）。headings 必须按行号
 * 升序；光标正好压在 heading 行时该 heading 计入链尾。无任何匹配返回 null。
 */
export function breadcrumbAtLine(
  headings: BreadcrumbHeading[],
  cursorLine: number,
): string | null {
  const stack: BreadcrumbHeading[] = [];
  for (const heading of headings) {
    if (heading.line > cursorLine) break;
    while (stack.length > 0 && stack[stack.length - 1].level >= heading.level) {
      stack.pop();
    }
    stack.push(heading);
  }
  return stack.length > 0 ? stack.map((item) => item.heading).join(" > ") : null;
}
