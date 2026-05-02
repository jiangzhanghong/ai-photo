import type { Model, Prompt, Task, User } from "../../types/api";
import { absoluteUrl, MAX_REFERENCE_IMAGES } from "../../utils/config";
import { request } from "../../utils/request";
import { getStoredUser, saveSession } from "../../utils/session";

interface UploadItem {
  id: string;
  previewUrl: string;
  tempFilePath?: string;
  uploadedUrl?: string;
}

interface HistoryItem {
  url: string;
  previewUrl: string;
  title: string;
  selected: boolean;
}

const ratioOptions = [
  { label: "1:1", value: "1:1" },
  { label: "3:4", value: "3:4" },
  { label: "4:3", value: "4:3" },
  { label: "16:9", value: "16:9" },
  { label: "9:16", value: "9:16" }
];

Page({
  data: {
    user: null as User | null,
    prompts: [] as Prompt[],
    models: [] as Model[],
    tasks: [] as Task[],
    uploadedImages: [] as UploadItem[],
    historyImages: [] as HistoryItem[],
    historyVisible: false,
    selectedPromptId: "",
    selectedModelIndex: 0,
    selectedRatioIndex: 1,
    ratioLabels: ratioOptions.map((item) => item.label),
    modelNames: [] as string[],
    customPrompt: "",
    count: 1,
    creditCost: 0,
    submitting: false,
    message: ""
  },

  async onShow() {
    this.setData({ user: getStoredUser() });
    await Promise.all([this.loadPrompts(), this.loadModels(), this.loadTasks()]);
    this.syncCost();
  },

  async loadPrompts() {
    const data = await request<{ prompts: Prompt[] }>("/api/prompts?taskType=image_to_image", { auth: false });
    const selectedPromptId = this.data.selectedPromptId || data.prompts[0]?.id || "";
    this.setData({ prompts: data.prompts, selectedPromptId });
  },

  async loadModels() {
    const data = await request<{ models: Model[] }>("/api/ai-models?taskType=image_to_image", { auth: false });
    this.setData({ models: data.models, modelNames: data.models.map((item) => item.name), selectedModelIndex: 0 });
  },

  async loadTasks() {
    if (!this.data.user) {
      this.setData({ tasks: [], historyImages: [] });
      return;
    }
    const data = await request<{ tasks: Task[] }>("/api/ai-image-tasks");
    this.setData({ tasks: data.tasks });
    this.buildHistoryImages();
  },

  buildHistoryImages() {
    const seen = new Set<string>();
    const history: HistoryItem[] = [];
    this.data.tasks.forEach((task) => {
      const urls = task.inputImageUrls?.length ? task.inputImageUrls : (task.inputImageUrl ? [task.inputImageUrl] : []);
      urls.forEach((url) => {
        if (!url || seen.has(url)) return;
        seen.add(url);
        history.push({ url, previewUrl: absoluteUrl(url), title: task.promptTitle || "历史参考图", selected: false });
      });
    });
    this.setData({ historyImages: history });
  },

  selectPrompt(event: WechatMiniprogram.TouchEvent) {
    this.setData({ selectedPromptId: String(event.currentTarget.dataset.id || "") });
    this.syncCost();
  },

  selectModel(event: WechatMiniprogram.PickerChange) {
    this.setData({ selectedModelIndex: Number(event.detail.value || 0) });
    this.syncCost();
  },

  selectRatio(event: WechatMiniprogram.PickerChange) {
    this.setData({ selectedRatioIndex: Number(event.detail.value || 0) });
  },

  onPromptInput(event: WechatMiniprogram.Input) {
    this.setData({ customPrompt: String(event.detail.value || "") });
  },

  increaseCount() {
    this.setData({ count: Math.min(9, this.data.count + 1) });
    this.syncCost();
  },

  decreaseCount() {
    this.setData({ count: Math.max(1, this.data.count - 1) });
    this.syncCost();
  },

  syncCost() {
    const model = this.data.models[this.data.selectedModelIndex];
    const cost = Number(model?.creditCost?.image_to_image || 0) * this.data.count;
    this.setData({ creditCost: cost });
  },

  async chooseImages() {
    const remaining = MAX_REFERENCE_IMAGES - this.data.uploadedImages.length;
    if (remaining <= 0) return this.setData({ message: `最多选择 ${MAX_REFERENCE_IMAGES} 张参考图。` });
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
    this.setData({ uploadedImages: [...this.data.uploadedImages, ...items], message: "" });
  },

  removeImage(event: WechatMiniprogram.TouchEvent) {
    const id = String(event.currentTarget.dataset.id || "");
    this.setData({ uploadedImages: this.data.uploadedImages.filter((item) => item.id !== id) });
  },

  openHistory() {
    this.setData({ historyVisible: true });
  },

  closeHistory() {
    this.setData({ historyVisible: false });
  },

  toggleHistoryImage(event: WechatMiniprogram.TouchEvent) {
    const url = String(event.currentTarget.dataset.url || "");
    this.setData({
      historyImages: this.data.historyImages.map((item) => item.url === url ? { ...item, selected: !item.selected } : item)
    });
  },

  applyHistoryImages() {
    const selected = this.data.historyImages.filter((item) => item.selected);
    const existing = new Set(this.data.uploadedImages.map((item) => item.uploadedUrl || item.previewUrl));
    const remaining = MAX_REFERENCE_IMAGES - this.data.uploadedImages.length;
    const items = selected
      .filter((item) => !existing.has(item.url))
      .slice(0, remaining)
      .map((item) => ({
        id: `history-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        previewUrl: item.previewUrl,
        uploadedUrl: item.url
      }));
    this.setData({ uploadedImages: [...this.data.uploadedImages, ...items], historyVisible: false, message: items.length ? `已添加 ${items.length} 张历史参考图。` : "没有可添加的历史参考图。" });
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
    const urls: string[] = [];
    for (const item of this.data.uploadedImages) {
      if (item.uploadedUrl) {
        urls.push(item.uploadedUrl);
        continue;
      }
      if (!item.tempFilePath) continue;
      const imageData = await this.fileToDataUrl(item.tempFilePath);
      const data = await request<{ url: string }>("/api/uploads/images", { method: "POST", data: { imageData } });
      item.uploadedUrl = data.url;
      urls.push(data.url);
    }
    return urls;
  },

  async submitTask() {
    if (!this.data.user) return wx.switchTab({ url: "/pages/home/index" });
    if (!this.data.user.membership) return this.setData({ message: "请先开通会员套餐。" });
    if (!this.data.uploadedImages.length) return this.setData({ message: "请先选择参考图。" });
    this.setData({ submitting: true, message: "" });
    try {
      const inputImageUrls = await this.uploadReferences();
      const selectedPrompt = this.data.prompts.find((item) => item.id === this.data.selectedPromptId);
      const model = this.data.models[this.data.selectedModelIndex];
      const response = await request<{ task: Task; user: User }>("/api/ai-image-tasks", {
        method: "POST",
        data: {
          taskType: "image_to_image",
          promptTemplateId: this.data.selectedPromptId,
          customPrompt: this.data.customPrompt,
          aiModelId: model?.id || "",
          ratio: ratioOptions[this.data.selectedRatioIndex].value,
          size: selectedPrompt?.defaultParams?.size || ratioOptions[this.data.selectedRatioIndex].value,
          count: this.data.count,
          inputImageUrl: inputImageUrls[0] || "",
          inputImageUrls,
          userInstruction: ""
        }
      });
      saveSession({ user: response.user });
      getApp<{ globalData: { user: User | null } }>().globalData.user = response.user;
      wx.navigateTo({ url: `/pages/result/index?id=${response.task.id}` });
    } catch (error) {
      this.setData({ message: (error as Error).message });
    } finally {
      this.setData({ submitting: false });
    }
  },

  goHome() {
    wx.switchTab({ url: "/pages/home/index" });
  }
});
