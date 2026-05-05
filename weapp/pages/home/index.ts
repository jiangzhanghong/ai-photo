import type { MediaImage, Prompt, Task, User } from "../../types/api";
import { requireLogin } from "../../utils/auth";
import { MAX_REFERENCE_IMAGES } from "../../utils/config";
import { getPageChrome } from "../../utils/layout";
import { normalizeMediaImage, resolveMediaImages } from "../../utils/media";
import { request } from "../../utils/request";
import { getStoredUser, saveSession } from "../../utils/session";
import {
  getDisplayAvatar,
  getDisplayCredits,
  getFallbackTemplates,
  getSelectedTemplate,
  saveSelectedTemplate,
  selectedTemplatePayload,
  toShowcaseTemplates,
  type SelectedTemplatePayload,
  type ShowcaseTemplate
} from "../../utils/showcase";

interface UploadItem {
  id: string;
  previewUrl: string;
  tempFilePath?: string;
  uploadedMedia?: MediaImage;
}

const ratioOptions = [
  { label: "1:1", value: "1:1" },
  { label: "3:4", value: "3:4" },
  { label: "2:3", value: "2:3" },
  { label: "9:16", value: "9:16" }
];

const recommendedSizes = {
  "1:1": "2048x2048",
  "3:4": "1728x2304",
  "2:3": "1664x2496",
  "9:16": "1600x2848"
} as const;

Page({
  data: {
    safeTop: 32,
    capsuleGap: 0,
    user: null as User | null,
    avatarUrl: getDisplayAvatar(null),
    creditBalance: 0,
    templates: getFallbackTemplates(),
    ratioOptions,
    selectedTemplateId: "",
    selectedTemplatePromptId: "",
    selectedTemplateTitle: "",
    selectedTemplateImage: "/assets/demo/recent-1.jpg",
    selectedTemplatePromptText: "",
    selectedTemplateCost: 2,
    selectedRatio: "1:1",
    count: 4,
    estimatedCost: 8,
    uploadedImages: [] as UploadItem[],
    submitting: false,
    message: "",
    generateButtonText: "请先上传参考图",
    generateButtonDisabled: true,
    generateHint: "上传参考图后即可生成"
  },

  onLoad() {
    this.setData(getPageChrome());
  },

  async onShow() {
    if (!requireLogin("/pages/home/index")) return;
    this.applyUser(getStoredUser());
    await this.loadPrompts();
    this.applyStoredTemplateSelection();
    this.syncGenerationState();
  },

  applyUser(user: User | null) {
    this.setData({
      user,
      avatarUrl: getDisplayAvatar(user),
      creditBalance: getDisplayCredits(user)
    }, () => this.syncGenerationState());
  },

  applyTemplate(template?: SelectedTemplatePayload | ShowcaseTemplate | null) {
    if (!template) return;
    this.setData({
      selectedTemplateId: template.id,
      selectedTemplatePromptId: template.promptId || "",
      selectedTemplateTitle: template.title,
      selectedTemplateImage: template.imageUrl,
      selectedTemplatePromptText: template.promptText,
      selectedTemplateCost: Number(template.creditCost || 0)
    }, () => this.syncGenerationState());
  },

  applyStoredTemplateSelection() {
    const stored = getSelectedTemplate();
    if (stored) {
      const matched = this.data.templates.find((item) => item.id === stored.id || item.promptId === stored.promptId);
      this.applyTemplate(matched || stored);
      return;
    }
    this.applyTemplate(this.data.templates[0]);
  },

  syncCost() {
    this.syncGenerationState();
  },

  syncGenerationState() {
    const estimatedCost = Math.max(1, this.data.count * Math.max(1, Number(this.data.selectedTemplateCost || 0)));
    const hasUploadedImage = Boolean(this.data.uploadedImages.length);
    const hasTemplate = Boolean(this.data.selectedTemplateId);
    const hasEnoughCredits = Number(this.data.creditBalance || 0) >= estimatedCost;
    let generateButtonText = "立即生成";
    let generateButtonDisabled = false;
    let generateHint = `剩余积分：${this.data.creditBalance}`;

    if (this.data.submitting) {
      generateButtonText = "生成中...";
      generateButtonDisabled = true;
      generateHint = "正在提交生成任务";
    } else if (!hasUploadedImage) {
      generateButtonText = "请先上传参考图";
      generateButtonDisabled = true;
      generateHint = "上传一张清晰正脸照后即可生成";
    } else if (!hasTemplate) {
      generateButtonText = "请选择模板";
      generateButtonDisabled = true;
      generateHint = "先选择一个写真风格模板";
    } else if (!hasEnoughCredits) {
      generateButtonText = "积分不足，去充值";
      generateButtonDisabled = false;
      generateHint = `本次需 ${estimatedCost} 积分，当前剩余 ${this.data.creditBalance}`;
    } else {
      generateHint = `本次消耗 ${estimatedCost} 积分，剩余 ${this.data.creditBalance}`;
    }

    this.setData({
      estimatedCost,
      generateButtonText,
      generateButtonDisabled,
      generateHint
    });
  },

  async loadPrompts() {
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
      const templates = toShowcaseTemplates(hydrated);
      this.setData({ templates });
    } catch {
      this.setData({ templates: getFallbackTemplates() });
    }
  },

  selectTemplate(event: WechatMiniprogram.TouchEvent) {
    const id = String(event.currentTarget.dataset.id || "");
    const template = this.data.templates.find((item) => item.id === id);
    if (!template) return;
    this.applyTemplate(template);
    saveSelectedTemplate(selectedTemplatePayload(template));
    this.syncCost();
  },

  selectRatio(event: WechatMiniprogram.TouchEvent) {
    const selectedRatio = String(event.currentTarget.dataset.value || "1:1");
    if (!ratioOptions.find((item) => item.value === selectedRatio)) return;
    this.setData({ selectedRatio });
  },

  increaseCount() {
    this.setData({ count: Math.min(9, this.data.count + 1) });
    this.syncCost();
  },

  decreaseCount() {
    this.setData({ count: Math.max(1, this.data.count - 1) });
    this.syncCost();
  },

  async chooseImages() {
    const remaining = MAX_REFERENCE_IMAGES - this.data.uploadedImages.length;
    if (remaining <= 0) {
      this.setData({ message: `最多上传 ${MAX_REFERENCE_IMAGES} 张参考图。` });
      return;
    }
    const result = await wx.chooseMedia({
      count: remaining,
      mediaType: ["image"],
      sizeType: ["compressed"],
      sourceType: ["album", "camera"]
    });
    const items = result.tempFiles.map((file) => ({
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      previewUrl: file.tempFilePath,
      tempFilePath: file.tempFilePath
    }));
    this.setData({
      uploadedImages: [...this.data.uploadedImages, ...items],
      message: ""
    }, () => this.syncGenerationState());
  },

  removeImage(event: WechatMiniprogram.TouchEvent) {
    const id = String(event.currentTarget.dataset.id || "");
    this.setData({ uploadedImages: this.data.uploadedImages.filter((item) => item.id !== id) }, () => this.syncGenerationState());
  },

  currentRequestSize() {
    return recommendedSizes[this.data.selectedRatio as keyof typeof recommendedSizes] || recommendedSizes["1:1"];
  },

  fileToDataUrl(filePath: string) {
    return new Promise<string>((resolve, reject) => {
      wx.getFileSystemManager().readFile({
        filePath,
        encoding: "base64",
        success: (res) => resolve(`data:image/jpeg;base64,${res.data}`),
        fail: () => reject(new Error("图片读取失败。"))
      });
    });
  },

  async uploadReferences() {
    const images: MediaImage[] = [];
    for (const item of this.data.uploadedImages) {
      if (item.uploadedMedia) {
        images.push(item.uploadedMedia);
        continue;
      }
      if (!item.tempFilePath) continue;
      const imageData = await this.fileToDataUrl(item.tempFilePath);
      const data = await request<{ url: string; media: MediaImage }>("/api/uploads/images", {
        method: "POST",
        data: { imageData }
      });
      item.uploadedMedia = data.media;
      item.previewUrl = data.media.thumbUrl || data.media.previewUrl || data.url;
      images.push(data.media);
    }
    return images;
  },

  async submitTask() {
    if (!this.data.user) {
      wx.showToast({ title: "请先在我的页完成登录", icon: "none" });
      requireLogin("/pages/home/index");
      return;
    }
    if (this.data.generateButtonDisabled) {
      wx.showToast({ title: this.data.generateHint, icon: "none" });
      return;
    }
    if (this.data.estimatedCost > this.data.creditBalance) {
      wx.switchTab({ url: "/pages/wallet/index" });
      return;
    }
    if (!this.data.uploadedImages.length) {
      this.setData({ message: "请先上传参考图。" });
      return;
    }
    if (!this.data.selectedTemplateId) {
      this.setData({ message: "请先选择模板。" });
      return;
    }
    this.setData({ submitting: true, message: "" }, () => this.syncGenerationState());
    try {
      const inputImages = await this.uploadReferences();
      const response = await request<{ task: Task; user: User }>("/api/ai-image-tasks", {
        method: "POST",
        data: {
          taskType: "image_to_image",
          promptTemplateId: this.data.selectedTemplatePromptId || undefined,
          customPrompt: this.data.selectedTemplatePromptId ? "" : this.data.selectedTemplatePromptText,
          ratio: this.data.selectedRatio,
          size: this.currentRequestSize(),
          count: this.data.count,
          inputImageUrl: inputImages[0]?.originalUrl || "",
          inputImageUrls: inputImages,
          inputImages,
          userInstruction: this.data.selectedTemplateTitle
        }
      });
      saveSession({ user: response.user });
      getApp<{ globalData: { user: User | null } }>().globalData.user = response.user;
      this.applyUser(response.user);
      wx.navigateTo({ url: `/pages/result/index?id=${response.task.id}` });
    } catch (error) {
      this.setData({ message: (error as Error).message });
    } finally {
      this.setData({ submitting: false }, () => this.syncGenerationState());
    }
  },

  openTemplatePage() {
    if (!requireLogin("/pages/create/index")) return;
    wx.switchTab({ url: "/pages/create/index" });
  }
});
