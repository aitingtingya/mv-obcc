import { Modal, Notice, Setting, type App } from "obsidian";
import type MvAideIdePlugin from "../../../../main";
import { t } from "../../../i18n";

interface DshPresetEntry {
  id: string;
  name: string;
  description: string;
  trust: "system" | "user";
  enabled?: boolean;
  path?: string;
  broken?: boolean;
}

class ClonePresetModal extends Modal {
  private targetId = "";
  private targetName = "";

  constructor(
    app: App,
    private readonly sourcePresetId: string,
    private readonly onClone: (targetId: string, targetName: string) => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle(t("克隆子智能体预设"));

    this.contentEl.createEl("p", {
      cls: "setting-item-description",
      text: t("基于当前预设 {source} 克隆出一个全新的独立子智能体配置。", { source: this.sourcePresetId }),
    });

    new Setting(this.contentEl)
      .setName(t("新预设 ID"))
      .setDesc(t("仅限小写字母、数字和连字符 (例如: my-agent-preset)"))
      .addText((text) =>
        text
          .setPlaceholder("my-custom-preset")
          .onChange((val) => {
            this.targetId = val;
          }),
      );

    new Setting(this.contentEl)
      .setName(t("显示名称"))
      .setDesc(t("用于在界面与会话中展示的名称"))
      .addText((text) =>
        text
          .setPlaceholder(t("我的专属子智能体"))
          .onChange((val) => {
            this.targetName = val;
          }),
      );

    new Setting(this.contentEl)
      .addButton((btn) =>
        btn.setButtonText(t("取消")).onClick(() => {
          this.close();
        }),
      )
      .addButton((btn) =>
        btn
          .setButtonText(t("确认克隆"))
          .setCta()
          .onClick(async () => {
            if (!this.targetId.trim()) {
              new Notice(t("请输入新预设 ID"));
              return;
            }
            if (!/^[a-z0-9][a-z0-9-]*$/u.test(this.targetId.trim())) {
              new Notice(t("新预设 ID 只能包含小写字母、数字和连字符，且不能以连字符开头"));
              return;
            }
            this.close();
            await this.onClone(this.targetId.trim(), this.targetName.trim());
          }),
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export function renderDshPresetManager(
  containerEl: HTMLElement,
  plugin: MvAideIdePlugin,
  openSubsectionIds?: Set<string>,
  toggleSubsection?: (id: string, open: boolean) => void,
): { sectionEl: HTMLElement; expand: () => void } {
  const isOpen = openSubsectionIds?.has("presets") ?? false;

  const details = containerEl.createEl("details", {
    cls: "mv-aide-ide-subsection",
  });
  details.id = "mv-agent-dsh-preset-manager";
  details.dataset.subsectionId = "presets";
  details.open = isOpen;

  details.addEventListener("toggle", () => {
    toggleSubsection?.("presets", details.open);
  });

  details.createEl("summary", {
    text: t("DSH 子智能体管理"),
    cls: "mv-aide-settings-section-summary setting-item-name",
  });

  const content = details.createDiv({ cls: "mv-aide-settings-section-body" });

  let cachedPresets: DshPresetEntry[] = [];
  let currentSearchQuery = "";

  // 顶部工具栏
  const toolbarEl = content.createDiv({ cls: "mv-aide-dsh-pm-toolbar" });

  const topSetting = new Setting(toolbarEl)
    .setName(t("DSH 子智能体列表"))
    .setDesc(t("查看与管理 DeepSeek Harness 的 Agent 预设模板，支持快速克隆生成新子智能体。"));

  topSetting.addButton((btn) =>
    btn
      .setButtonText(t("打开目录"))
      .setIcon("folder")
      .onClick(async () => {
        const port = plugin.settings.dsh?.port || 3080;
        try {
          await fetch(`http://127.0.0.1:${port}/api/mv-aide/presets/open-folder`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          });
        } catch {
          new Notice(t("打开目录失败，请确认 DSH 服务正在运行"));
        }
      }),
  );

  topSetting.addButton((btn) =>
    btn
      .setButtonText(t("克隆预设"))
      .setIcon("plus")
      .onClick(() => {
        new ClonePresetModal(plugin.app, "standard", async (targetId, targetName) => {
          const port = plugin.settings.dsh?.port || 3080;
          try {
            const res = await fetch(`http://127.0.0.1:${port}/api/mv-aide/presets/copy`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ sourceId: "standard", newId: targetId, name: targetName }),
            });
            const data = (await res.json()) as { ok: boolean; error?: string };
            if (data.ok) {
              new Notice(t("预设 {name} 克隆成功", { name: targetName || targetId }));
              await loadPresets();
            } else {
              new Notice(t("克隆失败：{error}", { error: data.error || t("未知错误") }));
            }
          } catch (err) {
            new Notice(t("请求失败：{message}", { message: String(err) }));
          }
        }).open();
      }),
  );

  topSetting.addButton((btn) =>
    btn
      .setButtonText(t("刷新"))
      .setIcon("refresh-cw")
      .onClick(() => {
        void loadPresets();
      }),
  );

  // 搜索栏
  const searchRow = content.createDiv({ cls: "mv-aide-dsh-pm-search-row" });
  const searchContainer = searchRow.createDiv({ cls: "search-input-container mv-aide-dsh-search-container" });
  const searchInput = searchContainer.createEl("input", {
    type: "search",
    placeholder: t("搜索子智能体预设..."),
    cls: "mv-aide-dsh-search-input",
  });

  const countBadge = searchRow.createSpan({ cls: "mv-aide-dsh-pm-count-badge" });

  const listContainer = content.createDiv({ cls: "mv-aide-dsh-pm-list" });

  function renderFilteredList(): void {
    listContainer.empty();

    const query = currentSearchQuery.trim().toLowerCase();
    const filtered = cachedPresets.filter(
      (p) =>
        p.id.toLowerCase().includes(query) ||
        p.name.toLowerCase().includes(query) ||
        p.description.toLowerCase().includes(query),
    );

    if (query.length > 0) {
      countBadge.setText(
        t("已筛选 {filtered} / {total} 个预设", {
          filtered: String(filtered.length),
          total: String(cachedPresets.length),
        }),
      );
    } else {
      countBadge.setText(
        t("共 {count} 个预设", { count: String(cachedPresets.length) }),
      );
    }

    if (filtered.length === 0) {
      listContainer.createEl("p", {
        cls: "setting-item-description",
        text: query.length > 0 ? t("未找到匹配预设") : t("暂无可用预设。"),
      });
      return;
    }

    const port = plugin.settings.dsh?.port || 3080;

    for (const preset of filtered) {
      const trustLabel = preset.trust === "system" ? t("系统内置") : t("用户自定义");
      const itemSetting = new Setting(listContainer)
        .setName(`${preset.name} (${preset.id})`)
        .setDesc(`${trustLabel} · ${preset.description || t("无描述")}`);

      // 启停开关（DSH 只支持隐藏/恢复用户预设目录；系统预设不可停用）
      itemSetting.addToggle((toggle) => {
        toggle.setValue(preset.enabled !== false);
        toggle.setDisabled(preset.trust === "system");
        toggle.onChange(async (newValue) => {
          const targetDisabled = !newValue;
          try {
            const res = await fetch(`http://127.0.0.1:${port}/api/mv-aide/presets/toggle`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ presetId: preset.id, disabled: targetDisabled }),
            });
            const data = (await res.json()) as { ok: boolean; error?: string };
            if (data.ok) {
              preset.enabled = !targetDisabled;
              new Notice(
                targetDisabled
                  ? t("已停用预设 {name}", { name: preset.name })
                  : t("已启用预设 {name}", { name: preset.name }),
              );
              renderFilteredList();
            } else {
              new Notice(t("操作失败：{error}", { error: data.error || t("未知错误") }));
              toggle.setValue(!newValue);
            }
          } catch (err) {
            new Notice(t("请求失败：{message}", { message: String(err) }));
            toggle.setValue(!newValue);
          }
        });
      });

      // 克隆此项
      itemSetting.addExtraButton((btn) =>
        btn
          .setIcon("copy")
          .setTooltip(t("以此为模板克隆"))
          .onClick(() => {
            new ClonePresetModal(plugin.app, preset.id, async (targetId, targetName) => {
              try {
                const res = await fetch(`http://127.0.0.1:${port}/api/mv-aide/presets/copy`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ sourceId: preset.id, newId: targetId, name: targetName }),
                });
                const data = (await res.json()) as { ok: boolean; error?: string };
                if (data.ok) {
                  new Notice(t("预设 {name} 克隆成功", { name: targetName || targetId }));
                  await loadPresets();
                } else {
                  new Notice(t("克隆失败：{error}", { error: data.error || t("未知错误") }));
                }
              } catch (err) {
                new Notice(t("请求失败：{message}", { message: String(err) }));
              }
            }).open();
          }),
      );

      // 删除按钮（支持系统预设与用户预设，系统预设带高危警告）
      itemSetting.addExtraButton((btn) =>
        btn
          .setIcon("trash")
          .setTooltip(t("删除预设"))
          .onClick(async () => {
            let force = false;
            if (preset.trust === "system") {
              if (!confirm(t("⚠️ 高危警告：预设 {name} 是 DeepSeek 官方系统内置预设，删除可能影响基础会话！确定要强制删除吗？", { name: preset.name }))) return;
              force = true;
            } else {
              if (!confirm(t("确定要删除自定义预设 {name} 吗？", { name: preset.name }))) return;
            }

            try {
              const res = await fetch(`http://127.0.0.1:${port}/api/mv-aide/presets/${encodeURIComponent(preset.id)}${force ? "?force=true" : ""}`, {
                method: "DELETE",
              });
              const data = (await res.json()) as { ok: boolean; error?: string };
              if (data.ok) {
                new Notice(t("已删除预设 {name}", { name: preset.name }));
                await loadPresets();
              } else {
                new Notice(t("删除失败：{error}", { error: data.error || t("未知错误") }));
              }
            } catch (err) {
              new Notice(t("删除失败：{message}", { message: String(err) }));
            }
          }),
      );
    }
  }

  searchInput.addEventListener("input", () => {
    currentSearchQuery = searchInput.value;
    renderFilteredList();
  });

  async function loadPresets(): Promise<void> {
    listContainer.empty();
    const loadingEl = listContainer.createEl("p", {
      cls: "setting-item-description",
      text: t("正在获取 DSH 子智能体预设..."),
    });

    const port = plugin.settings.dsh?.port || 3080;
    const url = `http://127.0.0.1:${port}/api/mv-aide/presets`;

    try {
      const response = await fetch(url, { method: "GET" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = (await response.json()) as { ok: boolean; presets?: DshPresetEntry[]; error?: string };
      loadingEl.remove();

      if (!data.ok || !Array.isArray(data.presets)) {
        listContainer.createEl("p", {
          cls: "setting-item-description mv-aide-status-error",
          text: t("获取失败：{error}", { error: data.error || t("未知错误") }),
        });
        return;
      }

      cachedPresets = data.presets;
      renderFilteredList();
    } catch {
      loadingEl.remove();
      listContainer.createEl("p", {
        cls: "setting-item-description mv-aide-status-error",
        text: t("无法连接到 DSH 服务（http://127.0.0.1:{port}）。请确认 DSH 已启动。", {
          port: String(port),
        }),
      });
    }
  }

  details.addEventListener("toggle", () => {
    if (details.open && cachedPresets.length === 0) {
      void loadPresets();
    }
  });

  return {
    sectionEl: details,
    expand: () => {
      details.open = true;
      if (cachedPresets.length === 0) {
        void loadPresets();
      }
    },
  };
}
