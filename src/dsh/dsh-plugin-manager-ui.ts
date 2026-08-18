import { Modal, Notice, Setting, setIcon, type App } from "obsidian";
import type MvAideIdePlugin from "../../main";
import { t } from "../i18n";

interface DshPluginEntry {
  id: string;
  name: string;
  enabled: boolean;
  fiberPhase: number | string | null;
}

class ImportPluginModal extends Modal {
  private spec = "";
  private submitted = false;

  constructor(
    app: App,
    private readonly onImport: (spec: string) => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle(t("导入插件"));

    new Setting(this.contentEl)
      .setName(t("插件包名或本地路径"))
      .setDesc(t("例如：@scope/pkg 或 file:/path/to/plugin"))
      .addText((text) => {
        text
          .setPlaceholder("@scope/pkg 或 file:/path/to/plugin")
          .onChange((value) => {
            this.spec = value;
          });
        text.inputEl.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            this.submit();
          }
        });
      });

    new Setting(this.contentEl)
      .addButton((btn) =>
        btn.setButtonText(t("取消")).onClick(() => {
          this.close();
        }),
      )
      .addButton((btn) =>
        btn
          .setButtonText(t("导入"))
          .setCta()
          .onClick(() => {
            this.submit();
          }),
      );
  }

  private submit(): void {
    if (this.submitted) return;
    const clean = this.spec.trim();
    if (!clean) {
      new Notice(t("请输入插件包名或本地路径"));
      return;
    }
    this.submitted = true;
    this.close();
    void this.onImport(clean);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class ConfirmDisablePmModal extends Modal {
  private settled = false;

  constructor(
    app: App,
    private readonly onConfirm: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle(t("停用插件管理器确认"));
    this.contentEl.createEl("p", {
      cls: "setting-item-description",
      text: t("警告：停用 mv-plugin-manager 插件管理器将导致无法在 Web UI 及此处继续进行插件启停管理。确定要停用吗？"),
    });

    new Setting(this.contentEl)
      .addButton((btn) =>
        btn.setButtonText(t("取消")).onClick(() => {
          this.close();
        }),
      )
      .addButton((btn) =>
        btn
          .setButtonText(t("确认停用"))
          .setWarning()
          .onClick(() => {
            this.settled = true;
            this.close();
            this.onConfirm();
          }),
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export function renderDshPluginManager(
  containerEl: HTMLElement,
  plugin: MvAideIdePlugin,
  openSubsectionIds?: Set<string>,
  toggleSubsection?: (id: string, open: boolean) => void,
): { sectionEl: HTMLElement; expand: () => void } {
  const isOpen = openSubsectionIds?.has("plugins") ?? false;

  const details = containerEl.createEl("details", {
    cls: "mv-aide-ide-subsection",
  });
  details.id = "mv-agent-dsh-plugin-manager";
  details.dataset.subsectionId = "plugins";
  // 规范七：子折叠区默认必须折叠 (details.open = false)
  details.open = isOpen;

  details.addEventListener("toggle", () => {
    toggleSubsection?.("plugins", details.open);
  });

  details.createEl("summary", {
    text: t("DSH 插件管理"),
    cls: "mv-aide-settings-section-summary setting-item-name",
  });

  const content = details.createDiv({ cls: "mv-aide-settings-section-body" });

  let cachedEntries: DshPluginEntry[] = [];
  let currentSearchQuery = "";

  // 顶部工具栏：描述、搜索框与刷新按钮
  const toolbarEl = content.createDiv({ cls: "mv-aide-dsh-pm-toolbar" });

  const topSetting = new Setting(toolbarEl)
    .setName(t("DSH 插件列表"))
    .setDesc(t("实时查看与管理 DeepSeek Harness 中加载的 Cordis 插件，支持毫秒级热启停与管理。"));

  topSetting.addButton((btn) =>
    btn
      .setButtonText(t("打开目录"))
      .setIcon("folder")
      .onClick(async () => {
        const port = plugin.settings.dsh?.port || 3080;
        try {
          await fetch(`http://127.0.0.1:${port}/api/mv-aide/plugins/open-folder`, {
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
      .setButtonText(t("导入插件"))
      .setIcon("plus")
      .onClick(() => {
        new ImportPluginModal(plugin.app, async (spec) => {
          const port = plugin.settings.dsh?.port || 3080;
          try {
            const res = await fetch(`http://127.0.0.1:${port}/api/mv-aide/plugins/import`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ spec }),
            });
            const data = (await res.json()) as { ok: boolean; error?: string; message?: string; warning?: string };
            if (data.ok) {
              new Notice(data.warning ? `${data.message} ${data.warning}` : (data.message || t("插件导入成功！")));
              await loadPlugins();
            } else {
              new Notice(t("导入失败：{error}", { error: data.error || t("未知错误") }));
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
        void loadPlugins();
      }),
  );

  // 搜索框区域
  const searchRow = content.createDiv({ cls: "mv-aide-dsh-pm-search-row" });
  const searchContainer = searchRow.createDiv({ cls: "search-input-container mv-aide-dsh-search-container" });
  const searchInput = searchContainer.createEl("input", {
    type: "search",
    placeholder: t("搜索插件 (ID / 名称)..."),
    cls: "mv-aide-dsh-search-input",
  });

  const countBadge = searchRow.createSpan({ cls: "mv-aide-dsh-pm-count-badge" });

  const listContainer = content.createDiv({ cls: "mv-aide-dsh-pm-list" });

  function renderFilteredList(): void {
    listContainer.empty();

    const query = currentSearchQuery.trim().toLowerCase();
    const filtered = cachedEntries.filter(
      (entry) =>
        entry.id.toLowerCase().includes(query) ||
        entry.name.toLowerCase().includes(query),
    );

    if (query.length > 0) {
      countBadge.setText(
        t("已筛选 {filtered} / {total} 个插件", {
          filtered: String(filtered.length),
          total: String(cachedEntries.length),
        }),
      );
    } else {
      countBadge.setText(
        t("共 {count} 个插件", { count: String(cachedEntries.length) }),
      );
    }

    if (filtered.length === 0) {
      listContainer.createEl("p", {
        cls: "setting-item-description",
        text: query.length > 0 ? t("未找到匹配的插件") : t("暂无已安装插件。"),
      });
      return;
    }

    const port = plugin.settings.dsh?.port || 3080;

    for (const entry of filtered) {
      const itemSetting = new Setting(listContainer)
        .setName(entry.id)
        .setDesc(`${entry.name} · ${entry.enabled ? t("● 已启用") : t("○ 已停用")}`);

      itemSetting.addToggle((toggle) => {
        toggle.setValue(entry.enabled);
        toggle.onChange(async (newValue) => {
          const targetDisabled = !newValue;

          const applyToggle = async (): Promise<void> => {
            try {
              const toggleRes = await fetch(`http://127.0.0.1:${port}/api/mv-aide/plugins/toggle`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ entryId: entry.id, disabled: targetDisabled }),
              });
              const toggleData = (await toggleRes.json()) as { ok: boolean; error?: string; requiresFrontendReload?: boolean };
              if (toggleData.ok) {
                entry.enabled = !targetDisabled;
                new Notice(
                  targetDisabled
                    ? t("已停用插件 {id}", { id: entry.id })
                    : t("已启用插件 {id}", { id: entry.id }),
                );
                renderFilteredList();
                if (toggleData.requiresFrontendReload) {
                  plugin.dshFeature?.reloadOpenViewsForPluginGraphChange();
                }
              } else {
                new Notice(t("操作失败：{error}", { error: toggleData.error || t("未知错误") }), 6000);
                toggle.setValue(!newValue);
              }
            } catch (err) {
              new Notice(
                t("请求失败：{message}", {
                  message: err instanceof Error ? err.message : String(err),
                }),
                6000,
              );
              toggle.setValue(!newValue);
            }
          };

          // 仅在停用 mv-dsh-manager 时拦截二次确认
          if ((entry.id === "mv-dsh-manager" || entry.id === "mv-plugin-manager" || entry.id.includes("mv-dsh-manager")) && targetDisabled) {
            new ConfirmDisablePmModal(plugin.app, () => {
              void applyToggle();
            }).open();
            toggle.setValue(!newValue); // 恢复原状态直到确认
            return;
          }

          await applyToggle();
        });
      });

      // 卸载/删除插件按钮（带官方/核心高危提醒）
      itemSetting.addExtraButton((btn) =>
        btn
          .setIcon("trash")
          .setTooltip(t("卸载插件"))
          .onClick(async () => {
            const isCore = entry.id.startsWith("@deepseek-ai/") || entry.id === "mv-dsh-manager" || entry.id === "mv-agent" || entry.id.includes("mv-dsh-manager");
            let force = false;
            if (isCore) {
              if (!confirm(t("⚠️ 高危警告：插件 {id} 属于系统核心/官方或管理器插件，删除可能导致会话或管理功能异常！确定要强制删除吗？", { id: entry.id }))) return;
              force = true;
            } else {
              if (!confirm(t("确定要卸载/删除插件 {id} 吗？", { id: entry.id }))) return;
            }

            try {
              const res = await fetch(`http://127.0.0.1:${port}/api/mv-aide/plugins/${encodeURIComponent(entry.id)}${force ? "?force=true" : ""}`, {
                method: "DELETE",
              });
              const data = (await res.json()) as { ok: boolean; error?: string; warning?: string; requiresFrontendReload?: boolean };
              if (data.ok) {
                new Notice(data.warning || `插件 ${entry.id} 已成功卸载。请点击“插件注入”可重新注入。`);
                await loadPlugins();
                if (data.requiresFrontendReload) {
                  plugin.dshFeature?.reloadOpenViewsForPluginGraphChange();
                }
              } else {
                new Notice(`卸载失败：${data.error || "未知错误"}`);
              }
            } catch (err) {
              new Notice(`卸载失败：${String(err)}`);
            }
          }),
      );
    }
  }

  searchInput.addEventListener("input", () => {
    currentSearchQuery = searchInput.value;
    renderFilteredList();
  });

  async function loadPlugins(): Promise<void> {
    listContainer.empty();
    const loadingEl = listContainer.createEl("p", {
      cls: "setting-item-description",
      text: t("正在获取 DSH 插件列表..."),
    });

    const port = plugin.settings.dsh?.port || 3080;
    const url = `http://127.0.0.1:${port}/api/mv-aide/plugins`;

    try {
      const response = await fetch(url, { method: "GET" });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const data = (await response.json()) as { ok: boolean; entries?: DshPluginEntry[]; error?: string };
      loadingEl.remove();

      if (!data.ok || !Array.isArray(data.entries)) {
        listContainer.createEl("p", {
          cls: "setting-item-description mv-aide-status-error",
          text: t("获取失败：{error}", { error: data.error || t("未知错误") }),
        });
        return;
      }

      cachedEntries = data.entries;
      renderFilteredList();
    } catch (error) {
      loadingEl.remove();
      listContainer.createEl("p", {
        cls: "setting-item-description mv-aide-status-error",
        text: t("无法连接到 DSH 服务（http://127.0.0.1:{port}）。请确认 DSH 已启动且启用了 Web 服务。", {
          port: String(port),
        }),
      });
    }
  }

  // 当用户展开时自动拉取一次
  details.addEventListener("toggle", () => {
    if (details.open && cachedEntries.length === 0) {
      void loadPlugins();
    }
  });

  return {
    sectionEl: details,
    expand: () => {
      details.open = true;
      if (cachedEntries.length === 0) {
        void loadPlugins();
      }
    },
  };
}
