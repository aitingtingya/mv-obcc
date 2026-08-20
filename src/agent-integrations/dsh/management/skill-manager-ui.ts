import { Modal, Notice, Setting, setIcon, type App } from "obsidian";
import type MvAideIdePlugin from "../../../../main";
import { t } from "../../../i18n";

interface DshSkillEntry {
  id: string;
  name: string;
  description: string;
  scope: "project" | "user" | "runtime";
  enabled: boolean;
  userInvocable: boolean;
  modelInvocable: boolean;
  path: string;
}

class NewSkillModal extends Modal {
  private name = "";
  private description = "";
  private content = "";

  constructor(
    app: App,
    private readonly onSave: (name: string, description: string, content: string) => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle(t("新建 DSH 技能"));

    new Setting(this.contentEl)
      .setName(t("技能名称 (ID)"))
      .setDesc(t("使用小写字母、数字和连字符 (例如: code-reviewer)"))
      .addText((text) =>
        text
          .setPlaceholder("my-skill")
          .onChange((value) => {
            this.name = value;
          }),
      );

    new Setting(this.contentEl)
      .setName(t("技能描述"))
      .setDesc(t("用于告知模型与用户该技能的触发场景与功能"))
      .addText((text) =>
        text
          .setPlaceholder(t("对代码变更进行结构化审查..."))
          .onChange((value) => {
            this.description = value;
          }),
      );

    new Setting(this.contentEl)
      .setName(t("指令内容 (Prompt)"))
      .setDesc(t("Skill 的核心 Prompt 指令"))
      .addTextArea((ta) => {
        ta.inputEl.rows = 6;
        ta.inputEl.addClass("mv-aide-dsh-textarea");
        ta.setPlaceholder("# 技能指令\n在这里编写详细的操作规范与步骤...");
        ta.onChange((val) => {
          this.content = val;
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
          .setButtonText(t("创建技能"))
          .setCta()
          .onClick(async () => {
            if (!this.name.trim()) {
              new Notice(t("请输入技能名称"));
              return;
            }
            if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(this.name.trim())) {
              new Notice(t("技能名称不合法：DSH 只接受小写 kebab-case，例如 code-reviewer"));
              return;
            }
            this.close();
            await this.onSave(this.name.trim(), this.description.trim(), this.content.trim());
          }),
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export function renderDshSkillManager(
  containerEl: HTMLElement,
  plugin: MvAideIdePlugin,
  openSubsectionIds?: Set<string>,
  toggleSubsection?: (id: string, open: boolean) => void,
): { sectionEl: HTMLElement; expand: () => void } {
  const isOpen = openSubsectionIds?.has("skills") ?? false;

  const details = containerEl.createEl("details", {
    cls: "mv-aide-ide-subsection",
  });
  details.id = "mv-agent-dsh-skill-manager";
  details.dataset.subsectionId = "skills";
  details.open = isOpen;

  details.addEventListener("toggle", () => {
    toggleSubsection?.("skills", details.open);
  });

  details.createEl("summary", {
    text: t("DSH 技能管理"),
    cls: "mv-aide-settings-section-summary setting-item-name",
  });

  const content = details.createDiv({ cls: "mv-aide-settings-section-body" });

  let cachedSkills: DshSkillEntry[] = [];
  let currentSearchQuery = "";

  // 顶部工具栏
  const toolbarEl = content.createDiv({ cls: "mv-aide-dsh-pm-toolbar" });

  const topSetting = new Setting(toolbarEl)
    .setName(t("DSH 技能列表"))
    .setDesc(t("管理 DeepSeek Harness 中加载的技能（SKILL.md），支持毫秒级热重载与快速启停。"));

  topSetting.addButton((btn) =>
    btn
      .setButtonText(t("打开目录"))
      .setIcon("folder")
      .onClick(async () => {
        const port = plugin.settings.dsh?.port || 3080;
        try {
          await fetch(`http://127.0.0.1:${port}/api/mv-aide/skills/open-folder`, {
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
      .setButtonText(t("新建技能"))
      .setIcon("plus")
      .onClick(() => {
        new NewSkillModal(plugin.app, async (name, description, promptContent) => {
          const port = plugin.settings.dsh?.port || 3080;
          try {
            const res = await fetch(`http://127.0.0.1:${port}/api/mv-aide/skills/import`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ name, description, content: promptContent }),
            });
            const data = (await res.json()) as { ok: boolean; error?: string };
            if (data.ok) {
              new Notice(t("技能 {name} 创建成功", { name }));
              await loadSkills();
            } else {
              new Notice(t("创建失败：{error}", { error: data.error || t("未知错误") }));
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
        void loadSkills();
      }),
  );

  // 搜索栏
  const searchRow = content.createDiv({ cls: "mv-aide-dsh-pm-search-row" });
  const searchContainer = searchRow.createDiv({ cls: "search-input-container mv-aide-dsh-search-container" });
  const searchInput = searchContainer.createEl("input", {
    type: "search",
    placeholder: t("搜索技能 (名称 / 描述)..."),
    cls: "mv-aide-dsh-search-input",
  });

  const countBadge = searchRow.createSpan({ cls: "mv-aide-dsh-pm-count-badge" });

  const listContainer = content.createDiv({ cls: "mv-aide-dsh-pm-list" });

  function renderFilteredList(): void {
    listContainer.empty();

    const query = currentSearchQuery.trim().toLowerCase();
    const filtered = cachedSkills.filter(
      (s) =>
        s.id.toLowerCase().includes(query) ||
        s.name.toLowerCase().includes(query) ||
        s.description.toLowerCase().includes(query),
    );

    if (query.length > 0) {
      countBadge.setText(
        t("已筛选 {filtered} / {total} 个技能", {
          filtered: String(filtered.length),
          total: String(cachedSkills.length),
        }),
      );
    } else {
      countBadge.setText(
        t("共 {count} 个技能", { count: String(cachedSkills.length) }),
      );
    }

    if (filtered.length === 0) {
      listContainer.createEl("p", {
        cls: "setting-item-description",
        text: query.length > 0 ? t("未找到匹配技能") : t("暂无可用技能。"),
      });
      return;
    }

    const port = plugin.settings.dsh?.port || 3080;

    for (const skill of filtered) {
      const scopeLabel = skill.scope === "project" ? t("项目级") : t("全局");
      const itemSetting = new Setting(listContainer)
        .setName(`${skill.name} (/${skill.id})`)
        .setDesc(`${scopeLabel} · ${skill.description || t("无描述")} · ${skill.enabled ? t("● 已启用") : t("○ 已停用")}`);

      // 删除按钮
      itemSetting.addExtraButton((btn) =>
        btn
          .setIcon("trash")
          .setTooltip(t("删除技能"))
          .onClick(async () => {
            if (!confirm(t("确定要删除技能 {name} 吗？此操作无法撤销。", { name: skill.name }))) return;
            try {
              const res = await fetch(`http://127.0.0.1:${port}/api/mv-aide/skills/${encodeURIComponent(skill.id)}`, {
                method: "DELETE",
              });
              const data = (await res.json()) as { ok: boolean; error?: string };
              if (data.ok) {
                new Notice(t("已删除技能 {name}", { name: skill.name }));
                await loadSkills();
              } else {
                new Notice(t("删除失败：{error}", { error: data.error || t("未知错误") }));
              }
            } catch (err) {
              new Notice(t("删除失败：{message}", { message: String(err) }));
            }
          }),
      );

      // 启停切换 Switch
      itemSetting.addToggle((toggle) => {
        toggle.setValue(skill.enabled);
        toggle.onChange(async (newValue) => {
          const targetDisabled = !newValue;
          try {
            const res = await fetch(`http://127.0.0.1:${port}/api/mv-aide/skills/toggle`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ skillId: skill.id, disabled: targetDisabled }),
            });
            const data = (await res.json()) as { ok: boolean; error?: string };
            if (data.ok) {
              skill.enabled = !targetDisabled;
              new Notice(
                targetDisabled
                  ? t("已停用技能 {name}", { name: skill.name })
                  : t("已启用技能 {name}", { name: skill.name }),
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
    }
  }

  searchInput.addEventListener("input", () => {
    currentSearchQuery = searchInput.value;
    renderFilteredList();
  });

  async function loadSkills(): Promise<void> {
    listContainer.empty();
    const loadingEl = listContainer.createEl("p", {
      cls: "setting-item-description",
      text: t("正在获取 DSH 技能列表..."),
    });

    const port = plugin.settings.dsh?.port || 3080;
    const url = `http://127.0.0.1:${port}/api/mv-aide/skills`;

    try {
      const response = await fetch(url, { method: "GET" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = (await response.json()) as { ok: boolean; skills?: DshSkillEntry[]; error?: string };
      loadingEl.remove();

      if (!data.ok || !Array.isArray(data.skills)) {
        listContainer.createEl("p", {
          cls: "setting-item-description mv-aide-status-error",
          text: t("获取失败：{error}", { error: data.error || t("未知错误") }),
        });
        return;
      }

      cachedSkills = data.skills;
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
    if (details.open && cachedSkills.length === 0) {
      void loadSkills();
    }
  });

  return {
    sectionEl: details,
    expand: () => {
      details.open = true;
      if (cachedSkills.length === 0) {
        void loadSkills();
      }
    },
  };
}
