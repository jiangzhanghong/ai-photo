import type { MediaImage, Prompt, User } from "../../types/api";
import { requireLogin } from "../../utils/auth";
import { getPageChrome } from "../../utils/layout";
import { normalizeMediaImage, resolveMediaImages } from "../../utils/media";
import { request } from "../../utils/request";
import { getStoredUser } from "../../utils/session";
import {
  getDisplayCredits,
  getFallbackTemplates,
  getSelectedTemplate,
  saveSelectedTemplate,
  selectedTemplatePayload,
  templateFilterTabs,
  toShowcaseTemplates,
  type ShowcaseTemplate
} from "../../utils/showcase";

Page({
  data: {
    safeTop: 32,
    capsuleGap: 0,
    user: null as User | null,
    creditBalance: 0,
    categories: [...templateFilterTabs],
    activeCategory: "推荐",
    searchValue: "",
    templates: getFallbackTemplates(),
    filteredTemplates: getFallbackTemplates(),
    selectedTemplateId: "",
    loadingPrompts: false,
    promptLoadFailed: false,
    skeletonItems: [1, 2, 3, 4]
  },

  onLoad() {
    this.setData(getPageChrome());
  },

  async onShow() {
    if (!requireLogin("/pages/create/index")) return;
    const user = getStoredUser();
    const selected = getSelectedTemplate();
    this.setData({
      user,
      creditBalance: getDisplayCredits(user),
      selectedTemplateId: selected?.id || selected?.promptId || ""
    });
    await this.loadPrompts();
    this.applyFilter();
  },

  async loadPrompts() {
    this.setData({ loadingPrompts: true, promptLoadFailed: false });
    try {
      const data = await request<{ prompts: Prompt[] }>("/api/prompts?taskType=image_to_image", { auth: false });
      const prompts = data.prompts || [];
      const promptImages = prompts.flatMap((prompt) => (
        (prompt.exampleImages || []).map((item) => normalizeMediaImage(item)).filter(Boolean) as MediaImage[]
      ));
      const resolved = await resolveMediaImages(promptImages, false);
      let cursor = 0;
      const hydrated = prompts.map((prompt) => {
        const count = prompt.exampleImages?.length || 0;
        const exampleImages = resolved.slice(cursor, cursor + count);
        cursor += count;
        return { ...prompt, exampleImages };
      });
      this.setData({ templates: toShowcaseTemplates(hydrated), loadingPrompts: false }, () => {
        this.applyFilter();
      });
    } catch {
      this.setData({ templates: [], loadingPrompts: false, promptLoadFailed: true }, () => {
        this.applyFilter();
      });
    }
  },

  applyFilter() {
    const searchValue = String(this.data.searchValue || "").trim().toLowerCase();
    const activeCategory = this.data.activeCategory;
    const filteredTemplates = this.data.templates.filter((item) => {
      const inCategory = activeCategory === "推荐" || item.category === activeCategory;
      const inSearch = !searchValue
        || item.title.toLowerCase().includes(searchValue)
        || item.subtitle.toLowerCase().includes(searchValue);
      return inCategory && inSearch;
    });
    this.setData({ filteredTemplates });
  },

  onSearchInput(event: WechatMiniprogram.Input) {
    this.setData({ searchValue: String(event.detail.value || "") });
    this.applyFilter();
  },

  selectCategory(event: WechatMiniprogram.TouchEvent) {
    this.setData({ activeCategory: String(event.currentTarget.dataset.value || "推荐") });
    this.applyFilter();
  },

  selectTemplate(event: WechatMiniprogram.TouchEvent) {
    if (!requireLogin("/pages/create/index")) return;
    const id = String(event.currentTarget.dataset.id || "");
    const template = this.data.templates.find((item) => item.id === id) as ShowcaseTemplate | undefined;
    if (!template) return;
    saveSelectedTemplate(selectedTemplatePayload(template));
    this.setData({ selectedTemplateId: template.id });
    wx.showToast({ title: "已设为当前模板", icon: "none" });
    setTimeout(() => {
      wx.switchTab({ url: "/pages/home/index" });
    }, 250);
  },

  retryLoadPrompts() {
    this.loadPrompts();
  }
});
