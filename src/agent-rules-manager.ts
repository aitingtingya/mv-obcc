import fs from "node:fs";
import path from "node:path";

const TAG_BEGIN = "# BEGIN mv-SenceAI 规则";
const TAG_END = "# END mv-SenceAI 规则";

const RULE_CONTENT = `${TAG_BEGIN}
在该 Obsidian 仓库中编写非 Markdown 源代码（如 Python、Javascript、Matlab、HTML、Mathematica 等）时，请严格遵守以下规则：
1. 文件命名：所有代码文件必须使用 \`-<lang_suffix>.md\` 结尾（例如 \`test-py.md\`、\`helper-js.md\`、\`plot-m.md\`），严禁直接创建原始代码后缀（如 \`.py\`、\`.js\`、\`.m\`）的文件。
2. 内容格式：代码内容必须包裹在带有语言标识的 Markdown 代码块中，且在代码块的前后使用该语言的注释符号进行包裹。示例：
- Python (文件以 -py.md 结尾):
#
\`\`\`python
#
print("Hello World")
\`\`\`
- Matlab (文件以 -m.md 结尾):
%
\`\`\`matlab
%
disp('Hello World')
\`\`\`
- Mathematica (文件以 -nb.md 或 -wls.md 结尾):
(*
\`\`\`mathematica
*)
(*
Plot[Sin[x], {x, 0, 2 Pi}]
*)
- HTML (文件以 -html.md 结尾):
<!--
\`\`\`html
-->
<!--
<div>Hello World</div>
-->
${TAG_END}`;

export async function syncAgentRulesInWorkspace(
  vaultRoot: string,
  syncClaude: boolean,
  syncCodex: boolean,
): Promise<void> {
  await syncRuleFamily(
    [
      path.join(vaultRoot, "CLAUDE.md"),
      path.join(vaultRoot, ".claude", "CLAUDE.md"),
    ],
    syncClaude,
  );
  await syncRuleFamily(
    [
      path.join(vaultRoot, "AGENTS.md"),
      path.join(vaultRoot, ".codex", "AGENTS.md"),
    ],
    syncCodex,
  );
}

async function syncRuleFamily(
  paths: readonly [string, ...string[]],
  enabled: boolean,
): Promise<void> {
  if (!enabled) {
    await Promise.all(
      paths.filter((filePath) => fs.existsSync(filePath)).map((filePath) =>
        updateFileRule(filePath, false),
      ),
    );
    return;
  }

  const existing = paths.filter((filePath) => fs.existsSync(filePath));
  const target =
    existing.find((filePath) => fileHasManagedBlock(filePath)) ??
    existing[0] ??
    paths[0];
  await updateFileRule(target, true);
}

function fileHasManagedBlock(filePath: string): boolean {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    return content.includes(TAG_BEGIN) && content.includes(TAG_END);
  } catch {
    return false;
  }
}

async function updateFileRule(filePath: string, enabled: boolean): Promise<void> {
  try {
    let content = "";
    if (fs.existsSync(filePath)) {
      content = fs.readFileSync(filePath, "utf8");
    }

    // Strip existing rule block if present
    let hadManagedBlock = false;
    const start = content.indexOf(TAG_BEGIN);
    if (start >= 0) {
      const end = content.indexOf(TAG_END, start);
      if (end >= 0) {
        hadManagedBlock = true;
        content =
          content.slice(0, start).trimEnd() +
          "\n\n" +
          content.slice(end + TAG_END.length).trimStart();
      }
    }

    if (!enabled && !hadManagedBlock) return;

    if (enabled) {
      content = content.trimEnd() + "\n\n" + RULE_CONTENT + "\n";
    } else {
      content = content.trimEnd() + "\n";
    }

    // Clean up empty lines at the end
    content = content.trim() === "" ? "" : content;

    if (content === "") {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } else {
      if (content === readExisting(filePath)) return;
      const dir = path.dirname(filePath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, content, "utf8");
    }
  } catch (e) {
    console.error(`[mv-obcc] Failed to update rule file ${filePath}`, e);
  }
}

function readExisting(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
