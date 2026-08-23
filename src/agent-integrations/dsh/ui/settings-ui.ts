import { Modal, Notice, Setting, type App, type ButtonComponent } from "obsidian";
import type MvAideIdePlugin from "../../../../main";
import { t } from "../../../i18n";
import type { DshAutoOpenRegion, DshInstallTarget } from "../settings";
import {
  DSH_ACTIVE_CHANNELS,
  DSH_PASSIVE_DIFF_CHANNELS,
  DSH_PASSIVE_STATE_CHANNELS,
  type DshScopeChannel,
} from "../ide/outside-policy";
import {
  combinedNodeStatus,
  combinedToolStatus,
  preferredNodeLocation,
  toolIsInstalled,
  type DshInstallLayer,
  type DshLayerStatus,
  type RuntimeUpdateStatus,
} from "../runtime/environment";
import { renderDshPluginManager } from "../management/plugin-manager-ui";
import { renderDshSkillManager } from "../management/skill-manager-ui";
import { renderDshPresetManager } from "../management/preset-manager-ui";

function heading(containerEl: HTMLElement, text: string): void {
  new Setting(containerEl).setName(text).setHeading();
}

class DshInstallLocationModal extends Modal {
  private settled = false;

  constructor(
    app: App,
    private readonly layer: Exclude<DshInstallLayer, "plugin">,
    private readonly resolveChoice: (target: DshInstallTarget | null) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle(t("选择安装位置"));
    this.contentEl.createEl("p", {
      cls: "setting-item-description",
      text: t("{layer} 尚未安装。请选择本次安装位置；以后升级会固定在原位置执行。", {
        layer: this.layer === "node" ? "Node.js" : this.layer === "dsh" ? "DSH" : "pnpm",
      }),
    });
    new Setting(this.contentEl)
      .setName(t("当前仓库"))
      .setDesc(t("安装到当前仓库的 mv-aide/dsh 目录，不修改电脑的全局环境。"))
      .addButton((button) => button.setButtonText(t("安装到仓库")).setCta().onClick(() => this.choose("vault")));
    new Setting(this.contentEl)
      .setName(this.layer === "node" ? t("系统全局") : t("npm 全局"))
      .setDesc(t("安装到电脑的全局环境；需要管理员权限时会弹出系统授权。"))
      .addButton((button) => button.setButtonText(t("全局安装")).onClick(() => this.choose("global")));
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.settled) this.resolveChoice(null);
  }

  private choose(target: DshInstallTarget): void {
    this.settled = true;
    this.resolveChoice(target);
    this.close();
  }
}

function chooseInstallTarget(
  app: App,
  layer: Exclude<DshInstallLayer, "plugin">,
): Promise<DshInstallTarget | null> {
  return new Promise((resolve) => new DshInstallLocationModal(app, layer, resolve).open());
}

function statusSpan(containerEl: HTMLElement, text: string, cls: string): void {
  const span = containerEl.createEl("span", {
    cls: "mv-aide-status-indicator",
  });
  span.setText(text);
  span.addClass(cls);
}

export type Rerender = () => void;

function layerStatusBaseText(status: DshLayerStatus): string {
  switch (status.state) {
    case "ready":
      return status.version ? t("● 已就绪（{version}）", { version: status.version }) : t("● 已就绪");
    case "missing":
      return t("● 未安装");
    case "broken-link":
      return t("● 需要修复");
    case "occupied":
      return t("● 路径被占用");
    case "incompatible":
      return t("● 版本不兼容");
    case "outdated":
      return status.version
        ? t("● 版本较旧（{version}）", { version: status.version })
        : t("● 版本较旧");
    case "newer":
      return status.version
        ? t("● 已安装更高版本（{version}）", { version: status.version })
        : t("● 已安装更高版本");
    case "conflict":
      return t("● 同版本内容冲突");
    case "blocked":
      return t("● 等待下层依赖");
    case "partial":
      return t("● 需要修复");
    case "error":
      return t("● 检测失败");
    default:
      return t("● 未检测");
  }
}

function layerStatusText(status: DshLayerStatus): string {
  const base = layerStatusBaseText(status);
  return status.restartRequired ? `${base} · ${t("待重启")}` : base;
}

function injectedLayerDetail(label: string, status: DshLayerStatus, currentVersion: string): string {
  let detail: string;
  switch (status.state) {
    case "ready":
      detail = t("{label} {version} 的文件、patch 与 DSH 实际加载均完整。", {
        label,
        version: status.version ?? currentVersion,
      });
      break;
    case "outdated":
      detail = t("{label} {version} 低于当前 mv-AIDE {current}；检测不会覆盖，请点击升级。", {
        label,
        version: status.version ?? t("未知版本"),
        current: currentVersion,
      });
      break;
    case "newer":
      detail = t("{label} {version} 高于当前 mv-AIDE {current}；已跳过当前版本的指纹比较与覆盖。", {
        label,
        version: status.version ?? t("未知版本"),
        current: currentVersion,
      });
      break;
    case "unknown":
      detail = t("{label} 的注入版本未知；检测不会覆盖，建议点击升级。", { label });
      break;
    case "conflict":
      detail = t("{label} 与当前 mv-AIDE 版本相同但内容指纹不同；仅可通过显式更新替换。", { label });
      break;
    case "missing":
      detail = t("{label} 尚未注入 DSH web profile。", { label });
      break;
    case "partial":
      detail = status.relation === "newer"
        ? t("{label} 的高版本存在但未被 DSH 完整加载；请使用对应高版本 mv-AIDE 处理。", { label })
        : t("{label} 注入不完整或未被 DSH 实际加载，需要修复。", { label });
      break;
    default:
      detail = status.detail ? t(status.detail) : layerStatusText(status);
  }
  if (status.restartRequired) {
    return status.runtimeVersion
      ? `${detail} ${t("磁盘版本 {disk}，当前 DSH 已加载 {running}；运行版本待重启。", {
          disk: status.version ?? t("未知版本"),
          running: status.runtimeVersion,
        })}`
      : `${detail} ${t("当前 DSH 运行版本待重启。")}`;
  }
  return status.runtimeVersion
    ? `${detail} ${t("当前 DSH 已加载同一 bundle。")}`
    : detail;
}

function injectedAggregateDetail(status: DshLayerStatus): string {
  if (status.restartRequired) return t("磁盘插件与当前 DSH 运行插件不同，运行版本待重启。");
  switch (status.state) {
    case "ready": return t("mv-agent 与 mv-dsh-manager 均已就绪。");
    case "outdated": return t("至少一个受管插件版本较旧；检测不会覆盖，请点击升级。");
    case "newer": return t("至少一个受管插件高于当前 mv-AIDE；当前版本不会降级覆盖。");
    case "unknown": return t("至少一个受管插件版本未知；建议点击升级。");
    case "conflict": return t("至少一个受管插件存在同版本内容冲突；仅可显式更新。");
    case "missing": return t("尚未向 DSH web profile 注入受管插件。");
    case "partial":
      return status.relation === "newer"
        ? t("高版本注入存在但不完整；请使用对应高版本 mv-AIDE 处理。")
        : t("检测到不完整注入，需要修复。");
    default: return status.detail ? t(status.detail) : layerStatusText(status);
  }
}

function runtimeStatusText(status: DshLayerStatus, update: RuntimeUpdateStatus): string {
  const base = layerStatusText(status);
  if (!update.checked) return base;
  if (update.error) return `${base} · ${t("更新检查失败")}`;
  if (!update.targetVersion) return base;
  if (update.relation === "older" || status.state === "missing") {
    return `${base} · ${t("最新 {version}", { version: update.targetVersion })}`;
  }
  if (update.relation === "newer") {
    return `${base} · ${t("发布通道目标 {version}", { version: update.targetVersion })}`;
  }
  return base;
}

function runtimeActionLabel(installed: boolean, update: RuntimeUpdateStatus): string {
  if (!installed) return t("安装");
  if (update.checked && (update.relation === "current" || update.relation === "newer")) {
    return t("重装");
  }
  return t("升级");
}

function layerStatusClass(status: DshLayerStatus): string {
  if (status.state === "ready" || status.state === "newer") return "mv-aide-status-success";
  if (
    status.state === "missing"
    || status.state === "broken-link"
    || status.state === "occupied"
    || status.state === "incompatible"
    || status.state === "outdated"
    || status.state === "conflict"
    || status.state === "error"
    || status.state === "partial"
  ) {
    return "mv-aide-status-error";
  }
  return "mv-aide-status-muted";
}

/**
 * Collapsible subsection that mirrors the IDE桥接 subsection styling
 * (`mv-aide-ide-subsection` + settings-section summary/body classes), so
 * the mv-agent section reads identically to the rest of the settings.
 */
function subsection(
  containerEl: HTMLElement,
  id: string,
  title: string,
  open: boolean,
  onToggle: (id: string, open: boolean) => void,
): HTMLElement {
  const details = containerEl.createEl("details", {
    cls: "mv-aide-ide-subsection",
  });
  details.dataset.subsectionId = id;
  details.open = open;
  details.addEventListener("toggle", () => onToggle(id, details.open));
  details.createEl("summary", {
    text: title,
    cls: "mv-aide-settings-section-summary setting-item-name",
  });
  return details.createDiv({ cls: "mv-aide-settings-section-body" });
}

/**
 * One grid row: name + description copied verbatim from the IDE桥接
 * settings, with the trailing control replaced by a scope dropdown
 * 「仅库内工作区 / 库内外均可用」.
 */
function outsideChannelRow(
  plugin: MvAideIdePlugin,
  containerEl: HTMLElement,
  channel: DshScopeChannel,
): void {
  const targetsReview = channel.scopeTarget === "reviewOutsideVault";
  const currentAllowed = targetsReview
    ? plugin.settings.dsh.reviewOutsideVault
    : plugin.settings.dsh.outsideToolPolicy[channel.key] === true;
  new Setting(containerEl)
    .setName(t(channel.name))
    .setDesc(t(channel.description))
    .addDropdown((dropdown) =>
      dropdown
        .addOption("vault", t("仅库内工作区"))
        .addOption("all", t("库内外均可用"))
        .setValue(currentAllowed ? "all" : "vault")
        .onChange(async (value) => {
          if (targetsReview) {
            plugin.settings.dsh.reviewOutsideVault = value === "all";
          } else if (value === "all") {
            plugin.settings.dsh.outsideToolPolicy[channel.key] = true;
          } else {
            delete plugin.settings.dsh.outsideToolPolicy[channel.key];
          }
          await plugin.saveAndApplySettings();
        }),
    );
}

/** The `dsh` entry at the top of the "已适配 agent" subsection. */
export function renderDshAgentEntry(
  plugin: MvAideIdePlugin,
  containerEl: HTMLElement,
  rerender: Rerender,
): void {
  const dshFeature = plugin.dshFeature;
  if (!dshFeature) return;
  heading(containerEl, t("dsh"));

  const enabledSetting = new Setting(containerEl)
    .setName(t("启用 dsh IDE 功能"))
    .setDesc(
      t("dsh 由 DeepSeek Harness 驱动。默认关闭。开启后启动 IDE 桥接并写 discovery lock 文件，使 dsh 中的 mv-AIDE 插件可连接本仓库。"),
    )
    .addToggle((toggle) =>
      toggle
        .setValue(plugin.settings.dsh.enabled)
        .onChange(async (value) => {
          await dshFeature.setIdeEnabled(value);
          rerender();
        }),
    );

  const ideState = dshFeature.ideIntegrationState();
  if (!plugin.settings.dsh.enabled) {
    statusSpan(enabledSetting.settingEl, t("状态：已禁用"), "mv-aide-status-muted");
  } else if (ideState.state === "blocked" || ideState.state === "error") {
    statusSpan(
      enabledSetting.settingEl,
      t("● 启动失败: {error}", { error: ideState.detail }),
      "mv-aide-status-error",
    );
  } else if (plugin.claudeIdeError) {
    statusSpan(
      enabledSetting.settingEl,
      t("● 启动失败: {error}", { error: plugin.claudeIdeError }),
      "mv-aide-status-error",
    );
  } else if (ideState.state === "ready" && plugin.port) {
    statusSpan(
      enabledSetting.settingEl,
      t("● 运行中（端口 {port}）", { port: plugin.port }),
      "mv-aide-status-success",
    );
  } else {
    statusSpan(enabledSetting.settingEl, t("● 等待启动"), "mv-aide-status-muted");
  }

}

/** The standalone "mv-agent" settings section (right below IDE桥接). */
export function renderDshSection(
  plugin: MvAideIdePlugin,
  containerEl: HTMLElement,
  rerender: Rerender,
  openSubsectionIds: Set<string>,
): void {
  const dshFeature = plugin.dshFeature;
  if (!dshFeature) return;

  const toggleSubsection = (id: string, open: boolean): void => {
    if (open) {
      openSubsectionIds.add(id);
    } else {
      openSubsectionIds.delete(id);
    }
  };

  containerEl.createEl("p", {
    cls: "setting-item-description",
    text: t("mv-agent 由 DeepSeek Harness（dsh）驱动：本分区负责一键安装 dsh、把 mv-AIDE 桥接插件注入 dsh、并配置 IDE 工具与被动感知对库外项目的开放策略。"),
  });

  // ── 安装与启动（规范七：默认折叠，仅会话内 toggle 记忆展开）────────────
  const installEl = subsection(
    containerEl,
    "install",
    t("安装与启动"),
    openSubsectionIds.has("install"),
    toggleSubsection,
  );

  const environmentButtons: ButtonComponent[] = [];
  const setEnvironmentBusy = (busy: boolean): void => {
    for (const button of environmentButtons) button.setDisabled(busy);
  };
  const environment = dshFeature.environmentStatus();
  new Setting(installEl)
    .setName(t("运行环境"))
    .setDesc(t("分别检测 Node.js、DSH、pnpm 与插件注入。点击任一项目的安装按钮时，会从最低缺失依赖开始补齐。"))
    .addButton((button) => {
      environmentButtons.push(button);
      button
        .setButtonText(t("检测"))
        .setDisabled(dshFeature.isEnvironmentBusy())
        .onClick(async () => {
          setEnvironmentBusy(true);
          try {
            const result = await dshFeature.checkEnvironment();
            new Notice(result.message, 8000);
            rerender();
          } catch (error) {
            new Notice(error instanceof Error ? error.message : String(error), 8000);
          } finally {
            setEnvironmentBusy(false);
          }
        });
    });

  const chooseTarget = (layer: Exclude<DshInstallLayer, "plugin">): Promise<DshInstallTarget | null> =>
    chooseInstallTarget(plugin.app, layer);
  const runLayer = async (layer: DshInstallLayer): Promise<void> => {
    setEnvironmentBusy(true);
    try {
      const result = await dshFeature.ensureLayer(layer, null, chooseTarget);
      new Notice(result.message, 10000);
      rerender();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error), 10000);
    } finally {
      setEnvironmentBusy(false);
    }
  };

  const nodeStatus = combinedNodeStatus(environment.node);
  const nodeInstalled = preferredNodeLocation(environment.node) !== null;
  const nodeSetting = new Setting(installEl)
    .setName("Node.js")
    .setDesc(environment.updates.node.error || nodeStatus.detail || t("点击“检测”刷新实际状态。"))
    .addButton((button) => {
      environmentButtons.push(button);
      button
        .setButtonText(runtimeActionLabel(nodeInstalled, environment.updates.node))
        .setDisabled(dshFeature.isEnvironmentBusy())
        .onClick(() => runLayer("node"));
    });
  statusSpan(
    nodeSetting.settingEl,
    runtimeStatusText(nodeStatus, environment.updates.node),
    layerStatusClass(nodeStatus),
  );

  for (const [layer, name, locations] of [
    ["dsh", "DSH", environment.dsh],
    ["pnpm", "pnpm", environment.pnpm],
  ] as const) {
    const status = combinedToolStatus(locations);
    const update = environment.updates[layer];
    const setting = new Setting(installEl)
      .setName(name)
      .setDesc(update.error || status.detail || t("点击“检测”刷新实际状态。"))
      .addButton((button) => {
        environmentButtons.push(button);
        const sourceDshReady = layer === "dsh" && locations.custom?.state === "ready";
        const actionLabel = status.state === "broken-link" && status.binaryIssue?.repairable
          ? t("修复")
          : sourceDshReady
            ? update.updateAvailable === true ? t("升级") : t("重装")
            : runtimeActionLabel(toolIsInstalled(locations), update);
        button
          .setButtonText(actionLabel)
          .setDisabled(dshFeature.isEnvironmentBusy())
          .onClick(() => runLayer(layer));
      });
    statusSpan(setting.settingEl, runtimeStatusText(status, update), layerStatusClass(status));
  }

  let customDirectoryDraft = plugin.settings.dsh.customDirectory;
  const customDirectorySetting = new Setting(installEl)
    .setName(t("自定义 DSH 目录"))
    .setDesc(
      environment.dsh.custom?.detail
        || t("自动检测失败时，可填写 DeepSeek Harness 仓库根目录或 apps/cli 目录。验证成功后始终优先使用。"),
    )
    .addText((text) =>
      text
        .setPlaceholder(t("自动检测"))
        .setValue(customDirectoryDraft)
        .onChange((value) => {
          customDirectoryDraft = value.trim();
        }),
    )
    .addButton((button) => {
      environmentButtons.push(button);
      button
        .setButtonText(t("验证并使用"))
        .setCta()
        .setDisabled(dshFeature.isEnvironmentBusy())
        .onClick(async () => {
          setEnvironmentBusy(true);
          try {
            const result = await dshFeature.configureCustomDshDirectory(customDirectoryDraft);
            new Notice(result.message, 10000);
            if (result.ok) rerender();
          } catch (error) {
            new Notice(error instanceof Error ? error.message : String(error), 10000);
          } finally {
            setEnvironmentBusy(false);
          }
        });
    })
    .addButton((button) => {
      environmentButtons.push(button);
      button
        .setButtonText(t("清除"))
        .setDisabled(dshFeature.isEnvironmentBusy() || !plugin.settings.dsh.customDirectory)
        .onClick(async () => {
          setEnvironmentBusy(true);
          try {
            const result = await dshFeature.clearCustomDshDirectory();
            new Notice(result.message, 8000);
            rerender();
          } catch (error) {
            new Notice(error instanceof Error ? error.message : String(error), 8000);
          } finally {
            setEnvironmentBusy(false);
          }
        });
    });
  customDirectorySetting.settingEl.addClass("mv-aide-dsh-custom-directory-setting");

  const pluginStatus = environment.plugins.full;
  const protectedHigherVersion = pluginStatus.state === "newer"
    || (pluginStatus.state === "partial" && pluginStatus.relation === "newer");
  const pluginAction = protectedHigherVersion
    ? t("高版本")
    : pluginStatus.state === "ready" || pluginStatus.state === "conflict"
      ? t("更新")
      : pluginStatus.state === "outdated" || pluginStatus.state === "unknown"
        ? t("升级")
        : pluginStatus.state === "partial" || pluginStatus.state === "error"
          ? t("修复")
          : t("注入");
  const pluginDetail = [
    injectedAggregateDetail(pluginStatus),
    injectedLayerDetail("mv-agent", environment.plugins.agent, plugin.manifest.version),
    injectedLayerDetail("mv-dsh-manager", environment.plugins.manager, plugin.manifest.version),
  ].join("\n");
  const pluginSetting = new Setting(installEl)
    .setName(t("插件注入"))
    .setDesc(pluginDetail)
    .addButton((button) => {
      environmentButtons.push(button);
      button
        .setButtonText(pluginAction)
        .setCta()
        .setDisabled(dshFeature.isEnvironmentBusy() || protectedHigherVersion)
        .onClick(() => runLayer("plugin"));
    });
  statusSpan(
    pluginSetting.settingEl,
    layerStatusText(pluginStatus),
    layerStatusClass(pluginStatus),
  );

  new Setting(installEl)
    .setName(t("端口"))
    .setDesc(
      t("dsh web 监听的本地端口，默认 3080。若该端口已有 dsh 在运行，将直接复用；被其他程序占用时会自动换空闲端口。"),
    )
    .addText((text) =>
      text
        .setPlaceholder("3080")
        .setValue(String(plugin.settings.dsh.port))
        .onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          if (Number.isInteger(parsed) && parsed > 0 && parsed < 65536) {
            plugin.settings.dsh.port = parsed;
            await plugin.saveData(plugin.settings);
          }
        }),
    );

  const regions: Record<DshAutoOpenRegion, string> = {
    left: t("左侧"),
    right: t("右侧"),
    bottom: t("中间下面"),
  };
  new Setting(installEl)
    .setName(t("打开分区"))
    .setDesc(t("Ctrl+P「打开 mv-agent」使用哪个分区显示 dsh 界面。"))
    .addDropdown((dropdown) =>
      dropdown
        .addOption("left", regions.left)
        .addOption("right", regions.right)
        .addOption("bottom", regions.bottom)
        .setValue(plugin.settings.dsh.autoOpenRegion)
        .onChange(async (value) => {
          plugin.settings.dsh.autoOpenRegion = value as DshAutoOpenRegion;
          await plugin.saveData(plugin.settings);
        }),
    );

  new Setting(installEl)
    .setName(t("终端感知增强"))
    .setDesc(
      t("开启时 mv-agent 使用 mv-AIDE 原生终端控制工具；关闭时恢复使用基础 IDE getTerminalOutput。该设置只影响 mv-agent / DSH。"),
    )
    .addToggle((toggle) =>
      toggle
        .setValue(plugin.settings.dsh.terminalAwarenessEnhanced)
        .onChange(async (value) => {
          plugin.settings.dsh.terminalAwarenessEnhanced = value;
          await plugin.saveAndApplySettings();
        }),
    );

  new Setting(installEl)
    .setName(t("自动适应图片大小"))
    .setDesc(
      t("发送并写入 DSH 历史前自动按比例缩小过大的图片，使最长边不超过 2000px；不会修改原文件或放大小图片。关闭后恢复 DSH 原生尺寸限制。"),
    )
    .addToggle((toggle) =>
      toggle
        .setValue(plugin.settings.dsh.autoFitImageSize)
        .onChange(async (value) => {
          plugin.settings.dsh.autoFitImageSize = value;
          await plugin.saveAndApplySettings();
        }),
    );

  new Setting(installEl)
    .setName(t("隐藏 Obsidian 原生状态栏"))
    .setDesc(
      t("仅隐藏 Obsidian 窗口底部原生 .status-bar 容器，不操作 mv-agent 自有状态栏。"),
    )
    .addToggle((toggle) =>
      toggle
        .setValue(plugin.settings.hideObsidianStatusBar)
        .onChange(async (value) => {
          plugin.settings.hideObsidianStatusBar = value;
          await plugin.saveData(plugin.settings);
          plugin.applyObsidianStatusBarVisibility();
        }),
    );

  // ── IDE 工具（100% 照抄 IDE桥接设置条目，仅开关换成作用域下拉；
  //    被动/主动是其中的两个嵌套子折叠区）──────────────────────────
  const toolsEl = subsection(
    containerEl,
    "tools",
    t("IDE 工具"),
    openSubsectionIds.has("tools"),
    toggleSubsection,
  );

  const passiveEl = subsection(
    toolsEl,
    "passive",
    t("被动"),
    openSubsectionIds.has("passive"),
    toggleSubsection,
  );
  for (const channel of DSH_PASSIVE_STATE_CHANNELS) {
    if (channel === DSH_PASSIVE_STATE_CHANNELS[0]) heading(passiveEl, t("状态感知"));
    outsideChannelRow(plugin, passiveEl, channel);
  }
  for (const channel of DSH_PASSIVE_DIFF_CHANNELS) {
    heading(passiveEl, t("diff"));
    outsideChannelRow(plugin, passiveEl, channel);
  }

  const activeEl = subsection(
    toolsEl,
    "active",
    t("主动"),
    openSubsectionIds.has("active"),
    toggleSubsection,
  );
  for (const channel of DSH_ACTIVE_CHANNELS) {
    outsideChannelRow(plugin, activeEl, channel);
  }

  // ── DSH 插件管理（独立子折叠区，默认折叠）───────────────────────────
  renderDshPluginManager(containerEl, plugin, openSubsectionIds, toggleSubsection);

  // ── DSH 技能管理（独立子折叠区，默认折叠）───────────────────────────
  renderDshSkillManager(containerEl, plugin, openSubsectionIds, toggleSubsection);

  // ── DSH 子智能体管理（独立子折叠区，默认折叠）─────────────────────────
  renderDshPresetManager(containerEl, plugin, openSubsectionIds, toggleSubsection);
}
