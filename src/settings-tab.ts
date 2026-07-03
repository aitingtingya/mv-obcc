import { Menu, Notice, PluginSettingTab, Setting, type App } from "obsidian";
import type MvSenceAiIdePlugin from "../main";
import {
  DEFAULT_SETTINGS,
  DEFAULT_INLINE_SYSTEM_PROMPT_BODY,
  DEFAULT_INLINE_NO_COMPLETION_PROMPT,
  DEFAULT_INLINE_REJECT_PROMPT,
} from "./constants";
import {
  eventToCodeMirrorKey,
  formatInlineHotkeyLabel,
} from "./inline-completion/inline-hotkey-format";
import type {
  LlmModelEntry,
  LlmPromptTemplate,
  LlmProviderConfig,
  LlmProviderType,
  LlmThinkingMode,
  InlineCompletionKeymap,
  ToolToggles,
} from "./types";

const SOURCE_LABELS = {
  manual: "手动覆盖",
  "vault-local": "当前仓库 .claude/settings.local.json",
  "vault-project": "当前仓库 .claude/settings.json",
  user: "用户 ~/.claude/settings.json",
  environment: "Obsidian 进程环境变量",
  none: "未找到",
} as const;

function addHeading(containerEl: HTMLElement, text: string): void {
  new Setting(containerEl).setName(text).setHeading();
}

export class MvSenceAiIdeSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: MvSenceAiIdePlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    addHeading(containerEl, "mv-SenceAI IDE");

    containerEl.createEl("div", {
      text: "🔌 IDE 桥接",
      cls: "mv-senceai-section-title setting-item-name",
    });

    const claudeSetting = new Setting(containerEl)
      .setName("启用 Claude Code IDE 功能")
      .setDesc("默认开启。关闭后不写 Claude IDE lock、不注册 Claude MCP、不接管 Claude 设置。")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.ideIntegrations.claudeCode)
          .onChange(async (value) => {
            this.plugin.settings.ideIntegrations.claudeCode = value;
            await this.plugin.saveAndApplySettings();
            this.display();
          }),
      );

    const claudeStatusEl = claudeSetting.settingEl.createEl("span", {
      cls: "mv-senceai-status-indicator",
    });
    if (!this.plugin.settings.ideIntegrations.claudeCode) {
      claudeStatusEl.setText("状态：已禁用");
      claudeStatusEl.addClass("mv-senceai-status-muted");
    } else if (this.plugin.claudeIdeError) {
      claudeStatusEl.setText(`● 启动失败: ${this.plugin.claudeIdeError}`);
      claudeStatusEl.addClass("mv-senceai-status-error");
    } else {
      claudeStatusEl.setText("● 运行中");
      claudeStatusEl.addClass("mv-senceai-status-success");
    }

    const codexSetting = new Setting(containerEl)
      .setName("启用 Codex IDE 功能")
      .setDesc("默认关闭。开启后支持 Codex CLI /ide，并把本插件 MCP 工具写入 Codex 配置。")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.ideIntegrations.codex)
          .onChange(async (value) => {
            this.plugin.settings.ideIntegrations.codex = value;
            await this.plugin.saveAndApplySettings();
            this.display();
          }),
      );

    const codexStatusEl = codexSetting.settingEl.createEl("span", {
      cls: "mv-senceai-status-indicator",
    });
    if (!this.plugin.settings.ideIntegrations.codex) {
      codexStatusEl.setText("状态：已禁用");
      codexStatusEl.addClass("mv-senceai-status-muted");
    } else if (this.plugin.codexIdeError) {
      codexStatusEl.setText(`● 启动失败: ${this.plugin.codexIdeError}`);
      codexStatusEl.addClass("mv-senceai-status-error");
    } else {
      codexStatusEl.setText("● 运行中");
      codexStatusEl.addClass("mv-senceai-status-success");
    }

    addHeading(containerEl, "功能与工具");

    addHeading(containerEl, "被动");

    addHeading(containerEl, "状态感知");
    new Setting(containerEl)
      .setName("支持所有活动页面")
      .setDesc(
        "默认关闭。开启后追踪任意 Obsidian 标签，并通过 Claude 会话 PID 和终端标题标记精确忽略该会话自己的终端；改变后请重新启动 Claude Code。",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.activityTracking.supportAllActivePages)
          .onChange(async (value) => {
            this.plugin.settings.activityTracking.supportAllActivePages = value;
            await this.plugin.saveAndApplySettings();
            this.display();
          }),
      );

    const pageTypes: Array<{
      key: "trackMarkdown" | "trackPdf" | "trackWebview";
      name: string;
      description: string;
    }> = [
      {
        key: "trackMarkdown",
        name: "追踪 Markdown 页面",
        description: "追踪当前 Markdown 文件、光标和选区。",
      },
      {
        key: "trackPdf",
        name: "追踪 PDF 页面",
        description: "追踪当前 PDF 文件、页码和文本选区。",
      },
      {
        key: "trackWebview",
        name: "追踪 Web Viewer 页面",
        description: "追踪 Obsidian 内置浏览器的标题、URL 和文本选区。",
      },
    ];
    for (const pageType of pageTypes) {
      new Setting(containerEl)
        .setName(pageType.name)
        .setDesc(
          this.plugin.settings.activityTracking.supportAllActivePages
            ? "“支持所有活动页面”已开启，此选项不再单独生效。"
            : pageType.description,
        )
        .addToggle((toggle) =>
          toggle
            .setValue(this.plugin.settings.activityTracking[pageType.key])
            .setDisabled(
              this.plugin.settings.activityTracking.supportAllActivePages,
            )
            .onChange(async (value) => {
              this.plugin.settings.activityTracking[pageType.key] = value;
              await this.plugin.saveAndApplySettings();
            }),
        );
    }

    addHeading(containerEl, "非 MD 源码编写");

    new Setting(containerEl)
      .setName("同步 Claude Code (CLAUDE.md) 规则")
      .setDesc("启用后自动在 CLAUDE.md 中注入中文规约，指导 AI 使用 md 代码文件（文件名-后缀.md）保存非 Markdown 代码。注意：开启本项会直接创建或修改此规则文件。")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.ideIntegrations.syncClaudeRules)
          .onChange(async (value) => {
            this.plugin.settings.ideIntegrations.syncClaudeRules = value;
            await this.plugin.saveAndApplySettings();
            this.display();
          }),
      );

    new Setting(containerEl)
      .setName("同步 Codex (AGENTS.md) 规则")
      .setDesc("启用后自动在 AGENTS.md 中注入中文规约，指导 AI 使用 md 代码文件（文件名-后缀.md）保存非 Markdown 代码。注意：开启本项会直接创建或修改此规则文件。")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.ideIntegrations.syncCodexRules)
          .onChange(async (value) => {
            this.plugin.settings.ideIntegrations.syncCodexRules = value;
            await this.plugin.saveAndApplySettings();
            this.display();
          }),
      );

    addHeading(containerEl, "视觉辅助");
    new Setting(containerEl)
      .setName("切换标签时保留选区高亮")
      .setDesc(
        "默认开启。切换到终端等特殊标签后仍显示 Markdown、PDF 和网页中最后一次划词；回到原页面空点或重新划词时继续遵循 Obsidian 原有行为。此功能不影响发送给 Claude 的选区。",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.preserveSelectionHighlights)
          .onChange(async (value) => {
            await this.plugin.setSelectionHighlightsEnabled(value);
          }),
      );

    addHeading(containerEl, "主动：MCP 工具");
    new Setting(containerEl)
      .setName("启用 MCP 主动工具")
      .setDesc(
        "主动工具通过标准 MCP 提供给 Claude Code 和 Codex CLI。改变后请重启对应客户端或重新执行 /mcp。",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.mcpEnabled)
          .onChange(async (value) => {
            this.plugin.settings.mcpEnabled = value;
            await this.plugin.saveAndApplySettings();
            this.display();
          }),
      );

    if (this.plugin.settings.mcpEnabled) {
      const tools: Array<{
        key: keyof ToolToggles;
        name: string;
        description: string;
      }> = [
        {
          key: "getLatestSelection",
          name: "获取最近标签与选区",
          description: "焦点离开 Obsidian 后仍可读取最近一次状态。",
        },
        {
          key: "getOpenEditors",
          name: "获取全部打开标签",
          description: "包括 Markdown、PDF、图片、网页、终端和其他插件页面。",
        },
        {
          key: "openFile",
          name: "在 Obsidian 中打开文件",
          description: "允许 Claude 主动定位仓库内文件和文本范围。",
        },
        {
          key: "readCurrentWebPage",
          name: "读取最近网页为 Markdown",
          description:
            "把最近浏览且仍打开的 Web Viewer 页面转换为 Markdown，不刷新或跳转页面。用于让 Claude 查看网页全貌，而不是只读取选区。",
        },
      ];
      for (const tool of tools) {
        new Setting(containerEl)
          .setName(tool.name)
          .setDesc(tool.description)
          .addToggle((toggle) =>
            toggle
              .setValue(this.plugin.settings.toolToggles[tool.key])
              .onChange(async (value) => {
                this.plugin.settings.toolToggles[tool.key] = value;
                await this.plugin.saveAndApplySettings();
              }),
          );
        if (tool.key === "readCurrentWebPage") {
          new Setting(containerEl)
            .setName("网页工具最大返回字符数")
            .setDesc(
              "留空或填写 0 表示不限，插件会忠实返回当前已加载页面的完整可见内容；填写正整数时才截断。",
            )
            .addText((text) => {
              text.inputEl.type = "number";
              text.inputEl.min = "0";
              text.inputEl.step = "1";
              text
                .setPlaceholder("不限")
                .setValue(
                  this.plugin.settings.toolContextLimits.readCurrentWebPage?.toString() ??
                    "",
                )
                .onChange(async (value) => {
                  const trimmed = value.trim();
                  if (!trimmed) {
                    this.plugin.settings.toolContextLimits.readCurrentWebPage =
                      null;
                  } else {
                    const parsed = Number(trimmed);
                    if (!Number.isFinite(parsed) || parsed < 0) return;
                    this.plugin.settings.toolContextLimits.readCurrentWebPage =
                      parsed === 0 ? null : Math.floor(parsed);
                  }
                  await this.plugin.saveData(this.plugin.settings);
                });
            });
        }
      }

      new Setting(containerEl)
        .setName("MCP 注册状态")
        .setDesc(this.plugin.mcpStatus)
        .addButton((button) =>
          button.setButtonText("重新注册").onClick(async () => {
            await this.plugin.retryMcpRegistration();
            new Notice(this.plugin.mcpStatus);
            this.display();
          }),
        )
        .addButton((button) =>
          button.setButtonText("清理注册").onClick(async () => {
            await this.plugin.cleanMcpRegistration();
            new Notice(this.plugin.mcpStatus);
            this.display();
          }),
        );

      new Setting(containerEl)
        .setName("Claude 可执行文件")
        .setDesc("通常自动检测。Windows 或自定义安装位置可在此填写完整路径。")
        .addText((text) =>
          text
            .setPlaceholder("自动检测")
            .setValue(this.plugin.settings.claudeExecutable)
            .onChange(async (value) => {
              this.plugin.settings.claudeExecutable = value.trim();
              await this.plugin.saveData(this.plugin.settings);
            }),
        );

      new Setting(containerEl)
        .setName("Codex 可执行文件")
        .setDesc("通常自动检测为 codex。自定义安装位置可在此填写完整路径。")
        .addText((text) =>
          text
            .setPlaceholder("codex")
            .setValue(this.plugin.settings.codexExecutable)
            .onChange(async (value) => {
              this.plugin.settings.codexExecutable = value.trim();
              await this.plugin.saveData(this.plugin.settings);
            }),
        );
    }

    addHeading(containerEl, "上游兼容");
    new Setting(containerEl)
      .setName("上游模式")
      .setDesc(
        "原生模式不改请求；兼容模式会把 IDE system 上下文移动到对应 user 消息中，不会复制两份。",
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption("native", "原生")
          .addOption("compatibility", "兼容")
          .setValue(this.plugin.settings.upstreamMode)
          .onChange(async (value) => {
            this.plugin.settings.upstreamMode =
              value === "compatibility" ? "compatibility" : "native";
            await this.plugin.saveAndApplySettings();
            this.display();
          }),
      );

    if (this.plugin.settings.upstreamMode === "compatibility") {
      const resolved = this.plugin.resolvedUpstream();
      new Setting(containerEl)
        .setName("Anthropic 上游地址（可选）")
        .setDesc(
          "留空时自动读取 Claude 配置。只有需要覆盖自动结果时才填写。",
        )
        .addText((text) =>
          text
            .setPlaceholder("留空以自动读取")
            .setValue(this.plugin.settings.upstreamBaseUrl)
            .onChange(async (value) => {
              this.plugin.settings.upstreamBaseUrl = value.trim();
              await this.plugin.saveAndApplySettings();
            }),
        );

      new Setting(containerEl)
        .setName("当前识别的上游")
        .setDesc(`来源：${SOURCE_LABELS[resolved.source]}`)
        .addText((text) =>
          text.setValue(resolved.url || "未找到 ANTHROPIC_BASE_URL").setDisabled(true),
        );

      new Setting(containerEl)
        .setName("自动管理当前仓库的 Claude 设置")
        .setDesc(
          "仅把当前仓库的 ANTHROPIC_BASE_URL 指向本地兼容端点；关闭时恢复插件接管前的值。",
        )
        .addToggle((toggle) =>
          toggle
            .setValue(this.plugin.settings.autoManageClaudeSettings)
            .onChange(async (value) => {
              this.plugin.settings.autoManageClaudeSettings = value;
              await this.plugin.saveAndApplySettings();
              this.display();
            }),
        );
    }

    addHeading(containerEl, "Diff 与维护");
    new Setting(containerEl)
      .setName("Diff 审核行为")
      .setDesc(
        "完全跟随 Claude Code 权限模式：默认权限会显示审核；acceptEdits 会直接接受编辑，插件不会额外弹窗。",
      );

    new Setting(containerEl)
      .setName("重启桥接")
      .setDesc("重建本地服务和 Claude Code IDE lock 文件。")
      .addButton((button) =>
        button.setButtonText("重启").onClick(async () => {
          await this.plugin.restartBridge();
          new Notice("mv-SenceAI IDE 桥接已重启。");
          this.display();
        }),
      );

    new Setting(containerEl)
      .setName("恢复插件管理的 Claude 设置")
      .setDesc("只恢复本插件替换过的 ANTHROPIC_BASE_URL，不改其他配置。")
      .addButton((button) =>
        button.setButtonText("恢复").onClick(async () => {
          await this.plugin.restoreClaudeSettings();
          new Notice("已恢复 mv-SenceAI IDE 管理的 Claude 设置。");
          this.display();
        }),
      );



    containerEl.createEl("div", {
      text: "🤖 API 提供商（划词助手与行内补全共用）",
      cls: "mv-senceai-section-title setting-item-name",
    });
    addHeading(containerEl, "API 提供商");
    {
      const tip = containerEl.createEl("p", {
        text: "API Base URL 和模型必填；API Key 仅对需要鉴权的服务必填，本地无鉴权服务可留空。",
      });
      tip.addClass("mv-senceai-llm-hint");
    }
    this.renderProviders(containerEl);

    containerEl.createEl("div", {
      text: "⌨️ 行内补全（Markdown 续写）",
      cls: "mv-senceai-section-title setting-item-name",
    });
    this.renderInlineCompletion(containerEl);

    containerEl.createEl("div", {
      text: "✍️ 划词助手（选词调用 LLM）",
      cls: "mv-senceai-section-title setting-item-name",
    });
    addHeading(containerEl, "总开关");

    new Setting(containerEl)
      .setName("启用")
      .setDesc(
        "完全独立于 IDE 桥接。开启后，在 Markdown / PDF / Web Viewer 中划词，右键或快捷键即可用预设提示词调用 LLM。",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.llm.enabled)
          .onChange(async (value) => {
            this.plugin.settings.llm.enabled = value;
            await this.plugin.saveData(this.plugin.settings);
            this.plugin.refreshLlmFeature();
            this.display();
          }),
      );

    {
      const tip = containerEl.createEl("p", {
        text: "提示：PDF 视图的右键被 Obsidian / pdf++ 占用，无法注入 LLM 菜单，请用快捷键触发（在「快捷键设置」里给「LLM：xxx」命令绑键）。网页视图（Web Viewer）里，Obsidian 的快捷键因焦点隔离无法直接生效，插件会自动把你已绑定的「LLM：xxx」快捷键同步注入网页，所以网页里用同一个快捷键即可。",
      });
      tip.addClass("mv-senceai-llm-hint");
    }

    if (this.plugin.settings.llm.enabled) {
      new Setting(containerEl)
        .setName("网页视图注入右键菜单（实验性）")
        .setDesc(
          "因网页视图跨域隔离，Obsidian 读不到网页内的选区。开启后会向网页注入脚本，在网页内显示我们的右键菜单（会屏蔽网页原生右键，部分站点可能失效）。关闭时网页视图改用快捷键调用。",
        )
        .addToggle((toggle) =>
          toggle
            .setValue(this.plugin.settings.llm.webContextMenu)
            .onChange(async (value) => {
              this.plugin.settings.llm.webContextMenu = value;
              await this.plugin.saveData(this.plugin.settings);
              new Notice(
                value
                  ? "已开启网页右键菜单，将在网页内注入。"
                  : "已关闭，网页视图请用快捷键调用。",
                4000,
              );
            }),
        );

      // ---- 悬浮窗行为 + 划词自动触发 ----
      addHeading(containerEl, "悬浮窗与自动触发");

      // 自动触发模板：下拉列出所有「已启用」的模板 + 一个「（关闭）」选项。
      // 仅当存在至少一个已启用模板时才显示，否则给一条提示。
      const enabledTemplates = this.plugin.settings.llm.templates.filter(
        (t) => t.enabled,
      );
      if (enabledTemplates.length === 0) {
        new Setting(containerEl)
          .setName("划词自动触发模板")
          .setDesc("当前没有已启用的模板，无法设置自动触发。请先在下方启用至少一个模板。");
      } else {
        new Setting(containerEl)
          .setName("划词自动触发模板")
          .setDesc(
            "选择一个模板后，左侧功能区会出现「划词自动触发」按钮（点亮后才生效，每次启动默认关闭）。点亮后划词会自动用所选模板调用助手；所选模板若被关闭或删除，按钮会自动消失。",
          )
          .addDropdown((dropdown) => {
            dropdown.addOption("", "（关闭）");
            for (const tpl of enabledTemplates) {
              dropdown.addOption(tpl.id, tpl.label);
            }
            dropdown.setValue(
              this.plugin.settings.llm.autoTriggerTemplateId ?? "",
            );
            dropdown.onChange(async (value) => {
              this.plugin.settings.llm.autoTriggerTemplateId = value || null;
              await this.plugin.saveData(this.plugin.settings);
              this.plugin.refreshLlmFeature();
            });
          });
      }

      // ---- 提示词模板 ----
      addHeading(containerEl, "提示词模板");
      const hint = containerEl.createEl("div", {
        text: "提示词中可用 {selection} 占位符表示划词内容；不含占位符时，划词会自动追加到末尾。每个模板可单独开关，并选择用哪个提供商的哪个模型。",
      });
      hint.addClass("mv-senceai-llm-hint");
      this.renderTemplates(containerEl);

      new Setting(containerEl).addButton((btn) =>
        btn
          .setButtonText("新增提示词模板")
          .setCta()
          .onClick(async () => {
            const next: LlmPromptTemplate = {
              id: `tpl-${Date.now()}`,
              label: "新模板",
              prompt: "{selection}",
              enabled: true,
              providerId: null,
              modelId: null,
              thinkingMode: "default",
            };
            this.plugin.settings.llm.templates.push(next);
            await this.plugin.saveData(this.plugin.settings);
            this.display();
          }),
      );
    }
  }

  // ---- 行内补全：独立模块设置 ----

  private async saveInlineCompletionSettings(): Promise<void> {
    await this.plugin.saveData(this.plugin.settings);
    this.plugin.refreshInlineCompletion();
  }

  private renderInlineCompletion(containerEl: HTMLElement): void {
    const cfg = this.plugin.settings.inlineCompletion;

    addHeading(containerEl, "总开关");
    new Setting(containerEl)
      .setName("启用行内补全")
      .setDesc(
        "开启后左侧功能区会出现「行内补全」按钮；按钮点亮时自动补全，未点亮时只响应手动请求按键。",
      )
      .addToggle((toggle) =>
        toggle.setValue(cfg.enabled).onChange(async (value) => {
          cfg.enabled = value;
          if (!value) {
            cfg.armed = false;
          }
          await this.saveInlineCompletionSettings();
          this.display();
        }),
      );

    addHeading(containerEl, "模型与上下文");
    new Setting(containerEl)
      .setName("补全模型")
      .setDesc("选择行内补全使用的提供商和模型；这里复用上方 API 提供商配置。")
      .addDropdown((dropdown) => {
        dropdown.addOption("", "（未选择提供商）");
        for (const provider of this.plugin.settings.llm.providers) {
          dropdown.addOption(provider.id, provider.name || "（未命名提供商）");
        }
        dropdown.setValue(cfg.providerId ?? "");
        dropdown.onChange(async (value) => {
          cfg.providerId = value || null;
          const provider = this.plugin.settings.llm.providers.find(
            (p) => p.id === cfg.providerId,
          );
          if (!provider?.models.some((m) => m.id === cfg.modelId)) {
            cfg.modelId = null;
          }
          await this.saveInlineCompletionSettings();
          this.display();
        });
      })
      .addDropdown((dropdown) => {
        const provider = this.plugin.settings.llm.providers.find(
          (p) => p.id === cfg.providerId,
        );
        if (!provider) {
          dropdown.addOption("", "（先选择提供商）");
          dropdown.setDisabled(true);
        } else if (provider.models.length === 0) {
          dropdown.addOption("", "（该提供商暂无模型）");
          dropdown.setDisabled(true);
        } else {
          dropdown.addOption("", "（未选择模型）");
          for (const model of provider.models) {
            dropdown.addOption(model.id, model.name || "（未命名模型）");
          }
          dropdown.setValue(cfg.modelId ?? "");
          dropdown.onChange(async (value) => {
            cfg.modelId = value || null;
            await this.saveInlineCompletionSettings();
          });
        }
      });

    new Setting(containerEl)
      .setName("思考")
      .setDesc(
        "决定是否在行内补全请求中携带思考参数。默认 = 不发送任何思考参数；自定义 = 你填的 JSON。",
      )
      .addDropdown((dropdown) => {
        dropdown
          .addOption("default", "默认")
          .addOption("on", "开")
          .addOption("off", "关")
          .addOption("custom", "自定义")
          .setValue(cfg.thinkingMode ?? "default")
          .onChange(async (value) => {
            cfg.thinkingMode = value as LlmThinkingMode;
            await this.saveInlineCompletionSettings();
            this.display();
          });
      })
      .addText((text) => {
        const isCustom = (cfg.thinkingMode ?? "default") === "custom";
        text.inputEl.toggleClass("mv-senceai-is-hidden", !isCustom);
        text
          .setPlaceholder('自定义 JSON，如 {"thinking":{"type":"enabled"}}')
          .setValue(cfg.thinkingCustom ?? "")
          .onChange(async (value) => {
            cfg.thinkingCustom = value;
            await this.saveInlineCompletionSettings();
          });
      });

    // ---- 补全提示词 ----
    addHeading(containerEl, "补全提示词");

    new Setting(containerEl)
      .setName("补全提示词主体")
      .setDesc("发送给模型的系统消息主体部分（角色描述 + 补全规则）。留空或清空则使用内置默认值。")
      .addTextArea((text) => {
        text.inputEl.rows = 8;
        text.inputEl.addClass("mv-senceai-inline-prompt-textarea");
        text
          .setPlaceholder("（使用默认提示词主体）")
          .setValue(cfg.systemPromptBody)
          .onChange(async (value) => {
            cfg.systemPromptBody = value;
            await this.saveInlineCompletionSettings();
          });
      })
      .addButton((btn) =>
        btn.setButtonText("恢复默认").onClick(async () => {
          cfg.systemPromptBody = DEFAULT_INLINE_SYSTEM_PROMPT_BODY;
          await this.saveInlineCompletionSettings();
          this.display();
        }),
      );

    {
      const sentinelMatch = DEFAULT_INLINE_NO_COMPLETION_PROMPT.match(/<[^>]+NO_COMPLETION>/);
      const sentinelToken = sentinelMatch ? sentinelMatch[0] : "<MV_SENCEAI_NO_COMPLETION>";
      const hintEl = containerEl.createEl("div", {
        text:
          `下方「${sentinelToken}」是无需补全时的返回标记。` +
          `如果修改或删除该标记，模型将无法正确抑制无效补全。`,
      });
      hintEl.addClass("mv-senceai-llm-hint");
    }

    new Setting(containerEl)
      .setName("无需补全指令")
      .setDesc("控制模型在无需补全时返回的 sentinel 标记指令。修改时请特别注意。")
      .addTextArea((text) => {
        text.inputEl.rows = 3;
        text.inputEl.addClass("mv-senceai-inline-prompt-textarea");
        text
          .setPlaceholder("（使用默认无需补全指令）")
          .setValue(cfg.noCompletionPrompt)
          .onChange(async (value) => {
            const defaultSentinel =
              DEFAULT_INLINE_NO_COMPLETION_PROMPT.match(/<[^>]+NO_COMPLETION>/)?.[0] ?? "";
            const userHasSentinel = defaultSentinel && value.includes(defaultSentinel);
            if (value.trim() && defaultSentinel && !userHasSentinel) {
              new Notice(
                "⚠️ 无需补全标记已变更，如果模型不返回该标记，可能导致无法正确抑制无效补全。",
                6000,
              );
            }
            cfg.noCompletionPrompt = value;
            await this.saveInlineCompletionSettings();
          });
      })
      .addButton((btn) =>
        btn.setButtonText("恢复默认").onClick(async () => {
          cfg.noCompletionPrompt = DEFAULT_INLINE_NO_COMPLETION_PROMPT;
          await this.saveInlineCompletionSettings();
          this.display();
        }),
      );

    new Setting(containerEl)
      .setName("拒绝后重生成指令")
      .setDesc(
        "按拒绝键后发送给模型的用户消息。支持 {rejected} 占位符代表被拒绝的补全文本；留空则使用内置默认值。",
      )
      .addTextArea((text) => {
        text.inputEl.rows = 7;
        text.inputEl.addClass("mv-senceai-inline-prompt-textarea");
        text
          .setPlaceholder("（使用默认拒绝后重生成指令）")
          .setValue(cfg.rejectPrompt)
          .onChange(async (value) => {
            cfg.rejectPrompt = value;
            await this.saveInlineCompletionSettings();
          });
      })
      .addButton((btn) =>
        btn.setButtonText("恢复默认").onClick(async () => {
          cfg.rejectPrompt = DEFAULT_INLINE_REJECT_PROMPT;
          await this.saveInlineCompletionSettings();
          this.display();
        }),
      );

    const renderContextLimit = (
      key: "contextBeforeChars" | "contextAfterChars",
      name: string,
      desc: string,
    ) => {
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addText((text) => {
          text.inputEl.type = "number";
          text.inputEl.min = "100";
          text.inputEl.step = "100";
          text
            .setPlaceholder(String(DEFAULT_SETTINGS.inlineCompletion[key]))
            .setValue(String(cfg[key]))
            .onChange(async (value) => {
              const trimmed = value.trim();
              if (!trimmed) {
                cfg[key] = DEFAULT_SETTINGS.inlineCompletion[key];
              } else {
                const parsed = Number(trimmed);
                if (!Number.isFinite(parsed) || parsed < 100) return;
                cfg[key] = Math.floor(parsed);
              }
              await this.saveInlineCompletionSettings();
            });
        });
    };

    renderContextLimit(
      "contextBeforeChars",
      "光标前上下文长度",
      "发送给模型的光标前最多多少个 Markdown 源文本字符。留空则使用默认值。",
    );
    renderContextLimit(
      "contextAfterChars",
      "光标后上下文长度",
      "发送给模型的光标后最多多少个 Markdown 源文本字符。留空则使用默认值。",
    );

    new Setting(containerEl)
      .setName("触发延迟")
      .setDesc("停止输入后等待多少毫秒再请求补全。留空则使用默认值。")
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = "50";
        text.inputEl.step = "50";
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.inlineCompletion.debounceMs))
          .setValue(String(cfg.debounceMs))
          .onChange(async (value) => {
            const trimmed = value.trim();
            if (!trimmed) {
              cfg.debounceMs = DEFAULT_SETTINGS.inlineCompletion.debounceMs;
            } else {
              const parsed = Number(trimmed);
              if (!Number.isFinite(parsed) || parsed < 50) return;
              cfg.debounceMs = Math.floor(parsed);
            }
            await this.saveInlineCompletionSettings();
          });
      });

    new Setting(containerEl)
      .setName("最大补全字符数")
      .setDesc("限制 ghost text 的最大字符数。留空则使用默认值。")
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = "10";
        text.inputEl.step = "10";
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.inlineCompletion.maxChars))
          .setValue(String(cfg.maxChars))
          .onChange(async (value) => {
            const trimmed = value.trim();
            if (!trimmed) {
              cfg.maxChars = DEFAULT_SETTINGS.inlineCompletion.maxChars;
            } else {
              const parsed = Number(trimmed);
              if (!Number.isFinite(parsed) || parsed < 10) return;
              cfg.maxChars = Math.floor(parsed);
            }
            await this.saveInlineCompletionSettings();
          });
      });

    new Setting(containerEl)
      .setName("最大补全行数")
      .setDesc("限制 ghost text 的最大行数。留空则使用默认值。")
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = "1";
        text.inputEl.step = "1";
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.inlineCompletion.maxLines))
          .setValue(String(cfg.maxLines))
          .onChange(async (value) => {
            const trimmed = value.trim();
            if (!trimmed) {
              cfg.maxLines = DEFAULT_SETTINGS.inlineCompletion.maxLines;
            } else {
              const parsed = Number(trimmed);
              if (!Number.isFinite(parsed) || parsed < 1) return;
              cfg.maxLines = Math.floor(parsed);
            }
            await this.saveInlineCompletionSettings();
          });
      });

    addHeading(containerEl, "快捷键");
    this.renderInlineHotkeyRecorder(
      containerEl,
      "accept",
      "接受按键",
      "插入当前 ghost text。点击录制后按下想绑定的快捷键。",
      DEFAULT_SETTINGS.inlineCompletion.keymap.accept,
    );
    this.renderInlineHotkeyRecorder(
      containerEl,
      "reject",
      "拒绝按键",
      "可清空不绑定。绑定后会把被拒绝的补全发回模型并请求另一版。",
      "",
    );
    this.renderInlineHotkeyRecorder(
      containerEl,
      "cancel",
      "取消按键",
      "只清空当前 ghost text，不请求模型。点击录制后按下想绑定的快捷键。",
      DEFAULT_SETTINGS.inlineCompletion.keymap.cancel,
    );
    this.renderInlineHotkeyRecorder(
      containerEl,
      "request",
      "手动请求按键",
      "左侧按钮未点亮时也可用它请求一次补全。可清空不绑定。",
      "",
    );
  }

  private renderInlineHotkeyRecorder(
    containerEl: HTMLElement,
    key: keyof InlineCompletionKeymap,
    name: string,
    description: string,
    fallback: string,
  ): void {
    const setting = new Setting(containerEl)
      .setName(name)
      .setDesc(description)
      .setClass("mv-senceai-inline-hotkey-setting");
    const valueEl = setting.controlEl.createEl("span", {
      cls: "mv-senceai-inline-hotkey-value",
      text: formatInlineHotkeyLabel(
        this.plugin.settings.inlineCompletion.keymap[key],
      ),
    });

    let cleanupRecording: (() => void) | null = null;
    const stopRecording = () => {
      cleanupRecording?.();
      cleanupRecording = null;
      valueEl.removeClass("is-recording");
      valueEl.setText(
        formatInlineHotkeyLabel(
          this.plugin.settings.inlineCompletion.keymap[key],
        ),
      );
    };
    const save = async (value: string) => {
      this.plugin.settings.inlineCompletion.keymap[key] = value;
      await this.saveInlineCompletionSettings();
      stopRecording();
    };

    setting.addButton((button) =>
      button.setButtonText("录制").onClick(() => {
        cleanupRecording?.();
        valueEl.addClass("is-recording");
        valueEl.setText("请按下快捷键...");
        let timeoutId: number | null = null;
        const onKeyDown = (event: KeyboardEvent) => {
          event.preventDefault();
          event.stopPropagation();
          const next = eventToCodeMirrorKey(
            event,
            activeWindow.navigator.platform.toLowerCase().includes("mac"),
          );
          if (!next) return;
          void save(next);
        };
        cleanupRecording = () => {
          activeWindow.removeEventListener("keydown", onKeyDown, true);
          if (timeoutId !== null) {
            activeWindow.clearTimeout(timeoutId);
            timeoutId = null;
          }
        };
        activeWindow.addEventListener("keydown", onKeyDown, true);
        timeoutId = activeWindow.setTimeout(() => {
          stopRecording();
        }, 10_000);
      }),
    );

    if (fallback) {
      setting.addButton((button) =>
        button.setButtonText("恢复默认").onClick(() => {
          void save(fallback);
        }),
      );
    } else {
      setting.addButton((button) =>
        button.setButtonText("清空").onClick(() => {
          void save("");
        }),
      );
    }
  }

  // ---- 划词助手：API 提供商编辑 ----

  private renderProviders(containerEl: HTMLElement): void {
    const providers = this.plugin.settings.llm.providers;
    for (let i = 0; i < providers.length; i += 1) {
      const idx = i;
      const provider = providers[idx];
      if (!provider) continue;
      this.renderProvider(containerEl, idx, provider);
    }

    new Setting(containerEl).addButton((btn) =>
      btn
        .setButtonText("新增提供商")
        .onClick(async () => {
          const next: LlmProviderConfig = {
            id: `provider-${Date.now()}`,
            name: "新提供商",
            type: "openai",
            baseUrl: "",
            apiKey: "",
            models: [],
            useProxy: false,
          };
          this.plugin.settings.llm.providers.push(next);
          await this.plugin.saveData(this.plugin.settings);
          this.display();
        }),
    );
  }

  private renderProvider(
    containerEl: HTMLElement,
    idx: number,
    provider: LlmProviderConfig,
  ): void {
    const wrap = containerEl.createDiv({ cls: "mv-senceai-llm-provider" });
    const header = new Setting(wrap)
      .setClass("mv-senceai-llm-provider-header")
      .setHeading();

    // Provider name + type + delete, all in the header's control area.
    header.controlEl.empty();
    header.controlEl.addClass("mv-senceai-llm-provider-head");

    const nameInput = header.controlEl.createEl("input", {
      type: "text",
      attr: { placeholder: "提供商名称（如：白山）", value: provider.name },
    });
    nameInput.addClass("mv-senceai-llm-provider-name");
    nameInput.addEventListener("change", async () => {
      const target = this.plugin.settings.llm.providers[idx];
      if (!target) return;
      target.name = nameInput.value;
      await this.plugin.saveData(this.plugin.settings);
    });

    const typeSelect = header.controlEl.createEl("select");
    for (const opt of ["openai", "anthropic"] as LlmProviderType[]) {
      const o = typeSelect.createEl("option", {
        value: opt,
        text: opt === "anthropic" ? "Anthropic" : "OpenAI 兼容",
      });
      if (provider.type === opt) o.selected = true;
    }
    typeSelect.addEventListener("change", async () => {
      const target = this.plugin.settings.llm.providers[idx];
      if (!target) return;
      target.type = typeSelect.value as LlmProviderType;
      await this.plugin.saveData(this.plugin.settings);
    });

    header.addExtraButton((btn) =>
      btn
        .setIcon("trash")
        .setTooltip("删除该提供商")
        .onClick(async () => {
          // Clear templates that referenced this provider.
          for (const t of this.plugin.settings.llm.templates) {
            if (t.providerId === provider.id) {
              t.providerId = null;
              t.modelId = null;
            }
          }
          if (this.plugin.settings.inlineCompletion.providerId === provider.id) {
            this.plugin.settings.inlineCompletion.providerId = null;
            this.plugin.settings.inlineCompletion.modelId = null;
          }
          this.plugin.settings.llm.providers.splice(idx, 1);
          await this.plugin.saveData(this.plugin.settings);
          this.plugin.refreshInlineCompletion();
          this.display();
        }),
    );

    new Setting(wrap)
      .setName("API Base URL")
      .setDesc(
        provider.type === "anthropic"
          ? "如 https://api.anthropic.com，插件自动追加 /v1/messages。"
          : "如 https://api.openai.com/v1，插件自动追加 /chat/completions。",
      )
      .addText((text) =>
        text
          .setPlaceholder("https://...")
          .setValue(provider.baseUrl)
          .onChange(async (value) => {
            const target = this.plugin.settings.llm.providers[idx];
            if (!target) return;
            target.baseUrl = value.trim();
            await this.plugin.saveData(this.plugin.settings);
          }),
      );

    new Setting(wrap)
      .setName("API Key")
      .setDesc("明文保存在插件 data.json。本地无鉴权服务（如 Ollama）可留空。")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("sk-...")
          .setValue(provider.apiKey)
          .onChange(async (value) => {
            const target = this.plugin.settings.llm.providers[idx];
            if (!target) return;
            target.apiKey = value.trim();
            await this.plugin.saveData(this.plugin.settings);
          });
      });

    new Setting(wrap)
      .setName("绕过 CORS(代理模式)")
      .setDesc(
        "默认关闭(流式逐字输出)。开启后改用 Obsidian 内部网络通道,可绕过部分端点对 app:// Origin 的 CORS 拒绝(表现为『Failed to fetch』),但会失去流式、改为一次性返回。iphy 等报 CORS 错的端点请开启。",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(provider.useProxy)
          .onChange(async (value) => {
            const target = this.plugin.settings.llm.providers[idx];
            if (!target) return;
            target.useProxy = value;
            await this.plugin.saveData(this.plugin.settings);
            this.display();
          }),
      );

    // Models list.
    const modelsHeading = wrap.createEl("div", {
      text: "模型",
      cls: "mv-senceai-llm-models-label",
    });
    const modelsList = wrap.createDiv({ cls: "mv-senceai-llm-models" });
    const models = provider.models;
    for (let m = 0; m < models.length; m += 1) {
      const midx = m;
      const model = models[midx];
      if (!model) continue;
      const row = modelsList.createDiv({ cls: "mv-senceai-llm-model-row" });
      const input = row.createEl("input", {
        type: "text",
        attr: {
          placeholder: "模型名（如 GLM-5.1，即发往 API 的值）",
          value: model.name,
        },
      });
      input.addClass("mv-senceai-llm-model-name");
      input.addEventListener("change", async () => {
        const p = this.plugin.settings.llm.providers[idx];
        const target = p?.models[midx];
        if (!target) return;
        target.name = input.value;
        await this.plugin.saveData(this.plugin.settings);
      });

      const delBtn = row.createEl("button", { text: "删除", cls: "mv-senceai-llm-model-del" });
      delBtn.addEventListener("click", async () => {
        const p = this.plugin.settings.llm.providers[idx];
        if (!p) return;
        const removed = p.models[midx];
        p.models.splice(midx, 1);
        // Clear templates pointing at the removed model.
        if (removed) {
          for (const t of this.plugin.settings.llm.templates) {
            if (t.providerId === provider.id && t.modelId === removed.id) {
              t.modelId = null;
            }
          }
          if (
            this.plugin.settings.inlineCompletion.providerId === provider.id &&
            this.plugin.settings.inlineCompletion.modelId === removed.id
          ) {
            this.plugin.settings.inlineCompletion.modelId = null;
          }
        }
        await this.plugin.saveData(this.plugin.settings);
        this.plugin.refreshInlineCompletion();
        this.display();
      });
    }
    void modelsHeading; // label rendered above
    const addModelBtn = modelsList.createEl("button", {
      text: "+ 添加模型",
      cls: "mv-senceai-llm-model-add",
    });
    addModelBtn.addEventListener("click", async () => {
      const p = this.plugin.settings.llm.providers[idx];
      if (!p) return;
      const entry: LlmModelEntry = {
        id: `model-${Date.now()}`,
        name: "",
      };
      p.models.push(entry);
      await this.plugin.saveData(this.plugin.settings);
      this.display();
    });
  }

  // ---- 划词助手：提示词模板编辑 ----

  private renderTemplates(containerEl: HTMLElement): void {
    const templates = this.plugin.settings.llm.templates;
    for (let i = 0; i < templates.length; i += 1) {
      const idx = i;
      const tpl = templates[idx];
      if (!tpl) continue;
      this.renderTemplate(containerEl, idx, tpl);
    }
  }

  private renderTemplate(
    containerEl: HTMLElement,
    idx: number,
    tpl: LlmPromptTemplate,
  ): void {
    const setting = new Setting(containerEl).setClass("mv-senceai-llm-tpl");
    setting.infoEl.empty();
    setting.infoEl.addClass("mv-senceai-llm-tpl-info");
    setting.controlEl.empty();
    setting.controlEl.addClass("mv-senceai-llm-tpl-control");

    const labelInput = setting.infoEl.createEl("input", {
      type: "text",
      attr: { placeholder: "菜单显示名（如：翻译）", value: tpl.label },
    });
    labelInput.addClass("mv-senceai-llm-tpl-label");
    labelInput.addEventListener("change", async () => {
      const target = this.plugin.settings.llm.templates[idx];
      if (!target) return;
      target.label = labelInput.value;
      await this.plugin.saveData(this.plugin.settings);
    });

    const promptArea = setting.infoEl.createEl("textarea");
    promptArea.setAttr("rows", "3");
    promptArea.setAttr("placeholder", "提示词，可用 {selection} 占位符");
    promptArea.value = tpl.prompt;
    promptArea.addClass("mv-senceai-llm-tpl-prompt");
    promptArea.addEventListener("change", async () => {
      const target = this.plugin.settings.llm.templates[idx];
      if (!target) return;
      target.prompt = promptArea.value;
      await this.plugin.saveData(this.plugin.settings);
    });

    // Model selection button + current selection summary, plus enable toggle.
    const modelBtn = setting.controlEl.createEl("button", {
      cls: "mv-senceai-llm-tpl-model",
    });
    const refreshModelLabel = () => {
      const p = this.plugin.settings.llm.providers.find((x) => x.id === tpl.providerId);
      const mdl = p?.models.find((x) => x.id === tpl.modelId);
      modelBtn.textContent = mdl && p ? `模型：${p.name} / ${mdl.name}` : "选择模型";
    };
    refreshModelLabel();
    modelBtn.addEventListener("click", (evt) => {
      const menu = new Menu();
      menu.addItem((item) =>
        item.setTitle("（清除选择）").onClick(async () => {
          const target = this.plugin.settings.llm.templates[idx];
          if (!target) return;
          target.providerId = null;
          target.modelId = null;
          await this.plugin.saveData(this.plugin.settings);
          tpl.providerId = null;
          tpl.modelId = null;
          refreshModelLabel();
        }),
      );
      for (const p of this.plugin.settings.llm.providers) {
        if (p.models.length === 0) continue;
        menu.addItem((item) =>
          item.setTitle(`${p.name} ▸`).setDisabled(true),
        );
        for (const m of p.models) {
          menu.addItem((item) =>
            item.setTitle(`  ${m.name || "（未命名模型）"}`).onClick(async () => {
              const target = this.plugin.settings.llm.templates[idx];
              if (!target) return;
              target.providerId = p.id;
              target.modelId = m.id;
              await this.plugin.saveData(this.plugin.settings);
              tpl.providerId = p.id;
              tpl.modelId = m.id;
              refreshModelLabel();
            }),
          );
        }
      }
      menu.showAtMouseEvent(evt as MouseEvent);
    });

    // 思考下拉（默认/开/关/自定义），紧跟「选择模型」之后。选「自定义」展开 JSON 框。
    const thinkingRow = setting.controlEl.createDiv({
      cls: "mv-senceai-llm-tpl-thinking-row",
    });
    const thinkingLabel = thinkingRow.createEl("span", {
      text: "思考",
      cls: "mv-senceai-llm-tpl-thinking-label",
    });
    void thinkingLabel;
    const thinkingSelect = thinkingRow.createEl("select");
    for (const opt of [
      { value: "default", text: "默认" },
      { value: "on", text: "开" },
      { value: "off", text: "关" },
      { value: "custom", text: "自定义" },
    ]) {
      const o = thinkingSelect.createEl("option", { value: opt.value, text: opt.text });
      if ((tpl.thinkingMode ?? "default") === opt.value) o.selected = true;
    }
    const customBox = thinkingRow.createEl("input", { type: "text" });
    customBox.addClass("mv-senceai-llm-tpl-thinking-custom");
    customBox.placeholder = '自定义 JSON，如 {"thinking":{"type":"enabled"}}';
    customBox.value = tpl.thinkingCustom ?? "";
    const refreshCustomVisibility = () => {
      customBox.style.display = thinkingSelect.value === "custom" ? "" : "none";
    };
    refreshCustomVisibility();
    thinkingSelect.addEventListener("change", async () => {
      const target = this.plugin.settings.llm.templates[idx];
      if (!target) return;
      target.thinkingMode = thinkingSelect.value as LlmThinkingMode;
      await this.plugin.saveData(this.plugin.settings);
      refreshCustomVisibility();
    });
    customBox.addEventListener("change", async () => {
      const target = this.plugin.settings.llm.templates[idx];
      if (!target) return;
      target.thinkingCustom = customBox.value;
      await this.plugin.saveData(this.plugin.settings);
    });

    // 到位的小字提示（固定通用）。
    const thinkingHint = setting.infoEl.createEl("div", {
      text:
        "💡 思考下拉决定是否在请求中携带思考参数：" +
        "开 = {\"thinking\":{\"type\":\"enabled\"}}、关 = {\"thinking\":{\"type\":\"disabled\"}}、" +
        "自定义 = 你填的 JSON。默认 = 不发送任何思考参数（安全）。" +
        "是否被模型实际采纳取决于模型与端点，不支持的模型可能报错或忽略。",
      cls: "mv-senceai-llm-tpl-hint-thinking",
    });
    void thinkingHint;

    const enableRow = setting.controlEl.createDiv({
      cls: "mv-senceai-llm-tpl-enable-row",
    });
    const enableToggle = enableRow.createEl("input", { type: "checkbox" });
    enableToggle.checked = tpl.enabled;
    enableToggle.id = `mv-senceai-llm-tpl-enabled-${idx}`;
    const enableLabel = enableRow.createEl("label", { text: "启用" });
    enableLabel.setAttribute("for", enableToggle.id);
    enableToggle.addEventListener("change", async () => {
      const target = this.plugin.settings.llm.templates[idx];
      if (!target) return;
      target.enabled = enableToggle.checked;
      if (
        !target.enabled &&
        this.plugin.settings.llm.autoTriggerTemplateId === target.id
      ) {
        this.plugin.settings.llm.autoTriggerTemplateId = null;
      }
      await this.plugin.saveData(this.plugin.settings);
      this.plugin.refreshLlmFeature();
      new Notice(
        target.enabled ? `已启用：${target.label}` : `已关闭：${target.label}`,
        3000,
      );
    });

    setting.addExtraButton((btn) =>
      btn
        .setIcon("trash")
        .setTooltip("删除该模板")
        .onClick(async () => {
          const [removed] = this.plugin.settings.llm.templates.splice(idx, 1);
          if (
            removed &&
            this.plugin.settings.llm.autoTriggerTemplateId === removed.id
          ) {
            this.plugin.settings.llm.autoTriggerTemplateId = null;
          }
          await this.plugin.saveData(this.plugin.settings);
          this.plugin.refreshLlmFeature();
          this.display();
        }),
    );
  }
}
