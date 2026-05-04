import type { MediaImage, Model, Prompt, Task, User } from "../../types/api";
import { absoluteUrl, MAX_REFERENCE_IMAGES } from "../../utils/config";
import { normalizeMediaImage, resolveMediaImages } from "../../utils/media";
import { request } from "../../utils/request";
import { getStoredUser, saveSession } from "../../utils/session";

interface UploadItem {
  id: string;
  previewUrl: string;
  tempFilePath?: string;
  uploadedMedia?: MediaImage;
}

interface HistoryItem {
  image: MediaImage;
  previewUrl: string;
  title: string;
  selected: boolean;
}

interface PromptCard {
  id: string;
  title: string;
  sceneLabel: string;
  previewUrl: string;
  creditCost: number;
}

const resolutionOptions = ["2K", "4K"] as const;

const ratioOptions = [
  { label: "智能", value: "adaptive" },
  { label: "1:1", value: "1:1" },
  { label: "3:4", value: "3:4" },
  { label: "4:3", value: "4:3" },
  { label: "9:16", value: "9:16" },
  { label: "16:9", value: "16:9" },
  { label: "2:3", value: "2:3" },
  { label: "3:2", value: "3:2" },
  { label: "21:9", value: "21:9" }
];

const recommendedImageSizes = {
  "2K": {
    "1:1": "2048x2048",
    "4:3": "2304x1728",
    "3:4": "1728x2304",
    "16:9": "2848x1600",
    "9:16": "1600x2848",
    "3:2": "2496x1664",
    "2:3": "1664x2496",
    "21:9": "3136x1344"
  },
  "4K": {
    "1:1": "4096x4096",
    "3:4": "3520x4704",
    "4:3": "4704x3520",
    "16:9": "5504x3040",
    "9:16": "3040x5504",
    "2:3": "3328x4992",
    "3:2": "4992x3328",
    "21:9": "6240x2656"
  }
} as const;

const knownRatios = ratioOptions.filter((item) => item.value !== "adaptive");

const splitImageSize = (size = "") => {
  const match = String(size).trim().match(/^(\d+)x(\d+)$/);
  return match ? { width: Number(match[1]), height: Number(match[2]) } : null;
};

const ratioFromSize = (size = "") => {
  if (size === "4K") return "adaptive";
  if (ratioOptions.some((item) => item.value === size)) return size;
  const parsed = splitImageSize(size);
  if (!parsed) return "";
  const value = parsed.width / parsed.height;
  return knownRatios.reduce((best, item) => {
    const [w, h] = item.value.split(":").map(Number);
    const diff = Math.abs(value - (w / h));
    return diff < best.diff ? { ratio: item.value, diff } : best;
  }, { ratio: "", diff: Infinity }).ratio;
};

const resolutionFromSize = (size = ""): "2K" | "4K" => {
  if (size === "4K") return "4K";
  const parsed = splitImageSize(size);
  if (!parsed) return "2K";
  return parsed.width * parsed.height > 9000000 ? "4K" : "2K";
};

const promptPreviewUrl = (prompt?: Prompt | null) => {
  const url = prompt?.exampleImages?.[0]?.previewUrl || prompt?.exampleImages?.[0]?.compressedUrl || prompt?.exampleImageUrl || prompt?.resultImageUrl || "";
  return url ? absoluteUrl(url) : "";
};

const toPromptCards = (prompts: Prompt[]): PromptCard[] => prompts.map((prompt) => ({
  id: prompt.id,
  title: prompt.title,
  sceneLabel: prompt.scene || prompt.categoryTags?.[0] || "通用",
  previewUrl: promptPreviewUrl(prompt),
  creditCost: prompt.creditCost || 0
}));

Page({
  data: {
    user: null as User | null,
    prompts: [] as Prompt[],
    promptCards: [] as PromptCard[],
    models: [] as Model[],
    tasks: [] as Task[],
    uploadedImages: [] as UploadItem[],
    historyImages: [] as HistoryItem[],
    historyVisible: false,
    selectedPromptId: "",
    selectedModelIndex: 0,
    selectedResolution: "2K",
    selectedRatioValue: "1:1",
    currentSizeLabel: "2048x2048",
    selectedPromptPreviewUrl: "",
    selectedPromptScene: "",
    selectedPromptTitle: "",
    selectedPromptCost: 0,
    promptCountLabel: "暂无模板",
    headerSubtitle: "登录后开始创作",
    resolutionOptions: [...resolutionOptions],
    ratioOptions,
    maxReferenceImages: MAX_REFERENCE_IMAGES,
    customPrompt: "",
    count: 1,
    creditCost: 0,
    submitting: false,
    message: ""
  },

  async onShow() {
    const user = getStoredUser();
    this.setData({
      user,
      headerSubtitle: user ? `剩余积分 ${user.credits}` : "登录后开始创作"
    });
    await Promise.allSettled([this.loadPrompts(), this.loadModels(), this.loadTasks()]);
    this.syncCost();
  },

  currentRequestSize() {
    if (this.data.selectedRatioValue === "adaptive") return "4K";
    const size = recommendedImageSizes[this.data.selectedResolution as "2K" | "4K"][this.data.selectedRatioValue as keyof typeof recommendedImageSizes["2K"]];
    return size || "2048x2048";
  },

  updateCurrentSizeLabel() {
    this.setData({
      currentSizeLabel: this.data.selectedRatioValue === "adaptive" ? "4K 智能比例" : this.currentRequestSize()
    });
  },

  applyPromptDefaults(prompt?: Prompt | null) {
    const params = prompt?.defaultParams || {};
    const ratioCandidate = String(params.ratio || ratioFromSize(String(params.size || "")) || "1:1");
    const selectedRatioValue = ratioOptions.some((item) => item.value === ratioCandidate) ? ratioCandidate : "1:1";
    const selectedResolution = params.resolution === "4K" || resolutionFromSize(String(params.size || "")) === "4K" ? "4K" : "2K";
    this.setData({
      selectedResolution,
      selectedRatioValue,
      selectedPromptPreviewUrl: promptPreviewUrl(prompt),
      selectedPromptScene: prompt?.scene || prompt?.categoryTags?.[0] || "通用",
      selectedPromptTitle: prompt?.title || "",
      selectedPromptCost: prompt?.creditCost || 0
    });
    this.updateCurrentSizeLabel();
  },

  syncCost() {
    const model = this.data.models[this.data.selectedModelIndex];
    const prompt = this.data.prompts.find((item) => item.id === this.data.selectedPromptId);
    const unitCost = Number(model?.creditCost?.image_to_image || model?.creditCost?.edit || prompt?.creditCost || 0);
    this.updateCurrentSizeLabel();
    this.setData({ creditCost: unitCost * this.data.count });
  },

  async loadPrompts() {
    try {
      const data = await request<{ prompts: Prompt[] }>("/api/prompts?taskType=image_to_image", { auth: false });
      const prompts = data.prompts || [];
      const promptImages = prompts.flatMap((prompt) => (prompt.exampleImages || []).map((item) => normalizeMediaImage(item)).filter(Boolean) as MediaImage[]);
      const resolved = await resolveMediaImages(promptImages, false);
      let cursor = 0;
      const hydrated = prompts.map((prompt) => {
        const count = prompt.exampleImages?.length || 0;
        const exampleImages = resolved.slice(cursor, cursor + count);
        cursor += count;
        return { ...prompt, exampleImages };
      });
      const selectedPromptId = hydrated.some((item) => item.id === this.data.selectedPromptId) ? this.data.selectedPromptId : (hydrated[0]?.id || "");
      const selectedPrompt = hydrated.find((item) => item.id === selectedPromptId) || null;
      this.setData({
        prompts: hydrated,
        promptCards: toPromptCards(hydrated),
        selectedPromptId,
        promptCountLabel: hydrated.length ? `${hydrated.length} 个模板` : "暂无模板"
      });
      this.applyPromptDefaults(selectedPrompt);
    } catch (error) {
      this.setData({
        prompts: [],
        promptCards: [],
        selectedPromptId: "",
        promptCountLabel: "暂无模板",
        message: (error as Error).message
      });
    }
  },

  async loadModels() {
    const data = await request<{ models: Model[] }>("/api/ai-models?taskType=image_to_image", { auth: false });
    this.setData({ models: data.models, selectedModelIndex: 0 });
  },

  async loadTasks() {
    if (!this.data.user) {
      this.setData({ tasks: [], historyImages: [] });
      return;
    }
    const data = await request<{ tasks: Task[] }>("/api/ai-image-tasks");
    const tasks = await Promise.all(data.tasks.map(async (task) => {
      const items = task.inputImages?.length
        ? task.inputImages
        : (task.inputImageUrls || []).map((url) => normalizeMediaImage({ originalUrl: url, previewUrl: url, thumbUrl: url })).filter(Boolean) as MediaImage[];
      return { ...task, inputImages: await resolveMediaImages(items) };
    }));
    this.setData({ tasks });
    this.buildHistoryImages();
  },

  buildHistoryImages() {
    const seen = new Set<string>();
    const history: HistoryItem[] = [];
    this.data.tasks.forEach((task) => {
      const images = task.inputImages || [];
      images.forEach((image) => {
        const key = image.assetId || image.originalUrl;
        if (!key || seen.has(key)) return;
        seen.add(key);
        history.push({ image, previewUrl: image.thumbUrl || image.previewUrl || image.originalUrl, title: task.promptTitle || "历史参考图", selected: false });
      });
    });
    this.setData({ historyImages: history });
  },

  selectPrompt(event: WechatMiniprogram.TouchEvent) {
    const id = String(event.currentTarget.dataset.id || "");
    const prompt = this.data.prompts.find((item) => item.id === id);
    if (!prompt) return;
    this.setData({ selectedPromptId: id });
    this.applyPromptDefaults(prompt);
    this.syncCost();
  },

  selectResolution(event: WechatMiniprogram.TouchEvent) {
    const value = String(event.currentTarget.dataset.value || "2K");
    this.setData({ selectedResolution: value === "4K" ? "4K" : "2K" });
    this.syncCost();
  },

  selectRatio(event: WechatMiniprogram.TouchEvent) {
    const value = String(event.currentTarget.dataset.value || "1:1");
    if (!ratioOptions.some((item) => item.value === value)) return;
    this.setData({
      selectedRatioValue: value,
      selectedResolution: value === "adaptive" ? "4K" : this.data.selectedResolution
    });
    this.syncCost();
  },

  onPromptInput(event: WechatMiniprogram.Input) {
    this.setData({ customPrompt: String(event.detail.value || "") });
  },

  clearPrompt() {
    this.setData({ customPrompt: "" });
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
    if (!this.data.historyImages.length) return this.setData({ message: "暂无可用的历史参考图。" });
    this.setData({ historyVisible: true });
  },

  closeHistory() {
    this.setData({ historyVisible: false });
  },

  toggleHistoryImage(event: WechatMiniprogram.TouchEvent) {
    const url = String(event.currentTarget.dataset.url || "");
    this.setData({
      historyImages: this.data.historyImages.map((item) => item.image.originalUrl === url ? { ...item, selected: !item.selected } : item)
    });
  },

  applyHistoryImages() {
    const selected = this.data.historyImages.filter((item) => item.selected);
    const existing = new Set(this.data.uploadedImages.map((item) => item.uploadedMedia?.assetId || item.uploadedMedia?.originalUrl || item.previewUrl));
    const remaining = MAX_REFERENCE_IMAGES - this.data.uploadedImages.length;
    const items = selected
      .filter((item) => !existing.has(item.image.assetId || item.image.originalUrl))
      .slice(0, remaining)
      .map((item) => ({
        id: `history-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        previewUrl: item.previewUrl,
        uploadedMedia: item.image
      }));
    this.setData({
      uploadedImages: [...this.data.uploadedImages, ...items],
      historyVisible: false,
      message: items.length ? `已添加 ${items.length} 张历史参考图。` : "没有可添加的历史参考图。"
    });
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
      const data = await request<{ url: string; media: MediaImage }>("/api/uploads/images", { method: "POST", data: { imageData } });
      item.uploadedMedia = data.media;
      item.previewUrl = data.media.thumbUrl || data.media.previewUrl || data.url;
      images.push(data.media);
    }
    return images;
  },

  async submitTask() {
    if (!this.data.user) {
      wx.showToast({ title: "请先登录", icon: "none" });
      return wx.switchTab({ url: "/pages/home/index" });
    }
    if (!this.data.user.membership) {
      wx.showToast({ title: "请先购买积分套餐", icon: "none" });
      return wx.switchTab({ url: "/pages/home/index" });
    }
    if (!this.data.selectedPromptId) return this.setData({ message: "请先选择模板。" });
    if (!this.data.uploadedImages.length) return this.setData({ message: "请先上传参考图。" });
    this.setData({ submitting: true, message: "" });
    try {
      const inputImages = await this.uploadReferences();
      const model = this.data.models[this.data.selectedModelIndex];
      const response = await request<{ task: Task; user: User }>("/api/ai-image-tasks", {
        method: "POST",
        data: {
          taskType: "image_to_image",
          promptTemplateId: this.data.selectedPromptId,
          customPrompt: this.data.customPrompt,
          aiModelId: model?.id || "",
          ratio: this.data.selectedRatioValue,
          size: this.currentRequestSize(),
          count: this.data.count,
          inputImageUrl: inputImages[0]?.originalUrl || "",
          inputImageUrls: inputImages,
          inputImages,
          userInstruction: this.data.customPrompt
        }
      });
      saveSession({ user: response.user });
      getApp<{ globalData: { user: User | null } }>().globalData.user = response.user;
      this.setData({ user: response.user, headerSubtitle: `剩余积分 ${response.user.credits}` });
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
