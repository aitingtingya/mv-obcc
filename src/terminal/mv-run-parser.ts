// 纯解析函数：不 import obsidian/终端，保持可独立单测。
//
// 文件底部指令是写在文件注释里的 `mv-run: <命令>` 行（vim modeline 风格）。
// 注释前缀由用户在设置中按文件类型自配（分号分隔多值），这里只负责用给定的
// 前缀列表剥离后匹配 `mv-run:` 指令行。

const MV_RUN_RE = /^mv-run\s*:\s*(.+)$/;

/** 块注释类前缀需要剥除的收尾符号。 */
const BLOCK_PREFIX_ENDINGS: Record<string, string> = {
  "<!--": "-->",
  "/*": "*/",
};

/**
 * 从文本中提取所有 `mv-run: <命令>` 注释指令行（按出现顺序）。
 * `prefixes` 为空数组时返回空数组（未配置的类型不解析）。
 */
export function extractMvRunCommands(
  text: string,
  prefixes: string[],
): string[] {
  if (prefixes.length === 0) return [];
  const commands: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const command = commandFromLine(line, prefixes);
    if (command !== null) commands.push(command);
  }
  return commands;
}

/**
 * 尝试用任一前缀剥离行首，返回能匹配 `mv-run:` 的命令。
 * 遍历所有前缀而非取第一个命中：避免 "#" 抢先剥走 "#:" 前缀的行。
 */
function commandFromLine(line: string, prefixes: string[]): string | null {
  for (const prefix of prefixes) {
    if (!line.startsWith(prefix)) continue;
    let body = line.slice(prefix.length).trim();
    const ending = BLOCK_PREFIX_ENDINGS[prefix];
    if (ending) {
      body = body.replace(new RegExp(`\\s*${escapeRegExp(ending)}$`), "").trim();
    }
    const match = MV_RUN_RE.exec(body);
    if (match) return match[1];
  }
  return null;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
