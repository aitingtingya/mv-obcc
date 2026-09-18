import { getLanguage } from "../i18n";

const messages = {
  title: ["运行 mv-run 指令", "Run mv-run commands"],
  default: ["默认执行", "Default execution"],
  specified: ["指定执行", "Specified execution"],
  defaultHint: ["按文件顺序执行未受保护的命令", "Run unprotected commands in file order"],
  specifiedHint: ["通过名称和 @分组指定顺序", "Choose an order using names and @groups"],
  order: ["执行顺序", "Execution order"],
  help: ["例如 pdf,@refs -p,pdf。Tab 补全，Enter 执行，Esc 取消。", "Example: pdf,@refs -p,pdf. Tab completes, Enter runs, Esc cancels."],
  preview: ["实际执行顺序", "Expanded execution order"],
  filtered: ["因保护规则跳过", "Skipped by protection rules"],
  unnamed: ["未命名", "Unnamed"],
  empty: ["没有可执行命令；未创建终端。", "No commands to execute; no terminal was created."],
  changed: ["文件中的指令已变化，预览已刷新，请再次确认。", "Task definitions changed. Review the refreshed preview and confirm again."],
  fileChanged: ["发起运行的文件或视图已变化，请重新运行 mv-run。", "The initiating file or view changed. Open mv-run again."],
  saveFailed: ["保存当前文件失败，未执行 mv-run 指令。", "Could not save the current file; mv-run was not executed."],
  noPrefix: ["未配置该文件类型的指令注释前缀。", "No command comment prefix is configured for this file type."],
  noTasks: ["未在文件中找到 mv-run 指令。", "No mv-run commands were found in this file."],
  noView: ["当前没有打开的 Markdown 视图", "No Markdown view is open"],
  done: ["mv-run 执行完成", "mv-run finished"],
  failed: ["mv-run 已停止", "mv-run stopped"],
  running: ["mv-run 正在执行", "mv-run is running"],
  waiting: ["正在保存并确认…", "Saving and confirming…"],
} as const;

export function message(key: keyof typeof messages): string {
  return messages[key][getLanguage() === "en" ? 1 : 0];
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
