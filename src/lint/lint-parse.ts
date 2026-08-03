// 纯函数：lint 输出解析与命令构造。不 import obsidian，保持可单测。

export type LintSeverity = "error" | "warning" | "info" | "hint";

export interface ParsedLintDiagnostic {
  line: number;
  col: number;
  message: string;
  severity: LintSeverity;
}

/** 按平台给路径做 shell 引号包裹，避免空格/中文/特殊字符破坏命令。 */
export function shellQuotePath(p: string): string {
  if (process.platform === "win32") {
    // cmd 会把双引号内的反斜杠当作转义引号前缀而吞掉（child_process.exec 走 cmd），
    // 换成正斜杠让 Windows 路径在 shell 里安全、且被 cmd/ruff 原生接受。
    return `"${p.replace(/\\/g, "/").replace(/"/g, '\\"')}"`;
  }
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

/**
 * 把用户模板命令展开为完整 shell 命令：`{file}` 占位符替换为带引号的文件
 * 路径；模板中没有 `{file}` 时，把带引号的路径追加到命令末尾。
 */
export function buildLintCommand(template: string, filePath: string): string {
  const quoted = shellQuotePath(filePath);
  if (template.includes("{file}")) {
    return template.split("{file}").join(quoted);
  }
  return `${template.trim()} ${quoted}`;
}

// 约定格式：`(文件:)?行(:列)?: 消息`，文件名与列号可省。纯数字开头优先按
// 省略文件名的 `行(:列)?: 消息` 解析，避免把 "12:34: msg" 里的 "12" 误当
// 文件名。带文件名的正则用非贪婪文件名，兼容 Windows 盘符冒号（D:\...），
// 让 `:行(:列)?: 消息` 定位在最后一个冒号分隔处。
const LINT_NO_FILE_RE = /^(\d+)(?::(\d+))?:\s*(.+)$/;
const LINT_WITH_FILE_RE = /^(.+?):(\d+)(?::(\d+))?:\s*(.+)$/;

export function parseLintOutput(text: string): ParsedLintDiagnostic[] {
  const out: ParsedLintDiagnostic[] = [];
  const push = (line: number, col: number, message: string) =>
    out.push({ line, col, message, severity: inferSeverity(message) });

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const noFile = LINT_NO_FILE_RE.exec(line);
    if (noFile) {
      push(
        Number(noFile[1]),
        noFile[2] !== undefined ? Number(noFile[2]) : 1,
        noFile[3],
      );
      continue;
    }
    const withFile = LINT_WITH_FILE_RE.exec(line);
    if (withFile) {
      push(
        Number(withFile[2]),
        withFile[3] !== undefined ? Number(withFile[3]) : 1,
        withFile[4],
      );
    }
  }
  return out;
}

function inferSeverity(message: string): LintSeverity {
  const lower = message.toLowerCase();
  if (/\b(error|err|fatal)\b/.test(lower)) return "error";
  if (/\b(warning|warn)\b/.test(lower)) return "warning";
  if (/\b(info|note)\b/.test(lower)) return "info";
  return "warning";
}

/**
 * 把 1 起始的列号映射为行内诊断 range，钳制在行尾以内。
 * lint 工具常报超出行长的列（如 ruff 的 E501 报 EOL+1），不钳制会产生
 * from > to 的反向 range 甚至超出文档末尾——诊断不可见，且 lint 面板
 * 点击/跳转时会因选区越界抛 "Selection points outside of document"。
 */
export function diagnosticRangeFor(
  line: { from: number; to: number },
  col: number,
): { from: number; to: number } {
  const from = Math.min(line.from + Math.max(0, col - 1), line.to);
  return { from, to: Math.min(from + 1, line.to) };
}
