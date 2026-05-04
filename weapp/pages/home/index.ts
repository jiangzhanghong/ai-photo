import type { LoginResponse, MediaImage, Model, Plan, Prompt, Task, User } from "../../types/api";
import { absoluteUrl, MAX_REFERENCE_IMAGES } from "../../utils/config";
import { formatDate, statusText } from "../../utils/format";
import { normalizeMediaImage, resolveMediaImages } from "../../utils/media";
import { request } from "../../utils/request";
import { clearSession, getStoredUser, saveSession } from "../../utils/session";

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

interface PromptChip {
  id: string;
  title: string;
  sceneLabel: string;
  previewUrl: string;
  creditCost: number;
}

interface RecentTaskCard {
  id: string;
  coverUrl: string;
  statusLabel: string;
  statusClass: string;
  promptTitle: string;
  createdLabel: string;
  creditCost: number;
  disabled: boolean;
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
] as const;

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

const demoRecentTasks: RecentTaskCard[] = [
  {
    id: "demo-1",
    coverUrl: "/assets/demo/recent-1.jpg",
    statusLabel: "已完成",
    statusClass: "success",
    promptTitle: "海边写真",
    createdLabel: "今天 14:32",
    creditCost: 2,
    disabled: true
  },
  {
    id: "demo-2",
    coverUrl: "/assets/demo/recent-2.jpg",
    statusLabel: "已完成",
    statusClass: "success",
    promptTitle: "花园人像",
    createdLabel: "今天 10:15",
    creditCost: 2,
    disabled: true
  },
  {
    id: "demo-3",
    coverUrl: "/assets/demo/recent-3.jpg",
    statusLabel: "处理中",
    statusClass: "processing",
    promptTitle: "夜景街拍",
    createdLabel: "今天 09:48",
    creditCost: 4,
    disabled: true
  },
  {
    id: "demo-4",
    coverUrl: "/assets/demo/recent-4.jpg",
    statusLabel: "已失败",
    statusClass: "failed",
    promptTitle: "雨夜电影感",
    createdLabel: "昨天 22:11",
    creditCost: 2,
    disabled: true
  }
];

const maskPhone = (value?: string) => {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length < 7) return "138****5678";
  return `${digits.slice(0, 3)}****${digits.slice(-4)}`;
};

const formatExpireDate = (value?: string) => {
  if (!value) return "2025-06-18";
  const date = new Date(value);
  const pad = (num: number) => String(num).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

const formatTaskDate = (value?: string) => {
  if (!value) return "今天 14:32";
  const date = new Date(value);
  const now = new Date();
  const pad = (num: number) => String(num).padStart(2, "0");
  const sameYear = date.getFullYear() === now.getFullYear();
  const sameMonth = date.getMonth() === now.getMonth();
  const sameDate = date.getDate() === now.getDate();
  if (sameYear && sameMonth && sameDate) return `今天 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (
    date.getFullYear() === yesterday.getFullYear() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getDate() === yesterday.getDate()
  ) {
    return `昨天 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
  return formatDate(value);
};

const formatLatestRelative = (value?: string) => {
  if (!value) return "2分钟前";
  const diff = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(diff) || diff < 0) return formatTaskDate(value);
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  return formatTaskDate(value);
};

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
    const [width, height] = item.value.split(":").map(Number);
    const diff = Math.abs(value - (width / height));
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

const normalizeSceneLabel = (prompt: Prompt) => prompt.scene || prompt.categoryTags?.[0] || prompt.title;

const toPromptChips = (prompts: Prompt[]) => {
  return prompts.map((prompt) => ({
    id: prompt.id,
    title: prompt.title,
    sceneLabel: normalizeSceneLabel(prompt),
    previewUrl: promptPreviewUrl(prompt),
    creditCost: prompt.creditCost || 0
  }));
};

const toRecentCard = (task: Task): RecentTaskCard => {
  const cover = task.resultImages?.[0]?.thumbUrl || task.resultImages?.[0]?.previewUrl || task.resultImageUrls?.[0] || task.inputImages?.[0]?.thumbUrl || task.inputImages?.[0]?.previewUrl || task.inputImageUrls?.[0] || task.inputImageUrl || "/assets/demo/recent-1.jpg";
  const statusLabel = statusText(task.status);
  const statusClass = task.status === "failed" ? "failed" : (task.status === "processing" || task.status === "queued" ? "processing" : "success");
  return {
    id: task.id,
    coverUrl: /^\/assets\//.test(cover) ? cover : absoluteUrl(cover),
    statusLabel,
    statusClass,
    promptTitle: task.promptTitle,
    createdLabel: formatTaskDate(task.createdAt),
    creditCost: task.creditCost,
    disabled: false
  };
};

Page({
  data: {
    safeTop: 36,
    navRightWidth: 210,
    resolutionOptions: [...resolutionOptions],
    ratioOptions,
    user: null as User | null,
    plans: [] as Plan[],
    prompts: [] as Prompt[],
    promptChips: [] as PromptChip[],
    models: [] as Model[],
    tasks: [] as Task[],
    uploadedImages: [] as UploadItem[],
    historyImages: [] as HistoryItem[],
    recentTasks: demoRecentTasks,
    historyVisible: false,
    memberVisible: false,
    paymentVisible: false,
    templateVisible: false,
    selectedPaymentPlan: null as Plan | null,
    selectedPaymentPlanSummary: "支付成功后发放积分",
    selectedPromptId: "",
    selectedModelIndex: 0,
    selectedResolution: "2K",
    selectedRatioValue: "1:1",
    currentSizeLabel: "2048x2048",
    selectedPromptPreviewUrl: "",
    selectedPromptScene: "",
    selectedPromptTitle: "",
    customPrompt: "",
    count: 2,
    creditCost: 4,
    submitting: false,
    wechatLoading: false,
    message: "",
    displayName: "138****5678",
    membershipLine: "高级会员 · 有效期至 2025-06-18",
    avatarUrl: "/assets/demo/avatar.jpg",
    creditBalance: 286,
    latestTaskStatus: "已完成",
    latestTaskRelative: "2分钟前",
    memberButtonText: "会员中心"
  },

  async onLoad() {
    const windowInfo = typeof wx.getWindowInfo === "function" ? wx.getWindowInfo() : null;
    const menuRect = typeof wx.getMenuButtonBoundingClientRect === "function" ? wx.getMenuButtonBoundingClientRect() : null;
    const safeTop = (windowInfo?.statusBarHeight || 24) + 18;
    const navRightWidth = menuRect && windowInfo ? windowInfo.windowWidth - menuRect.left + 24 : 210;
    this.setData({ safeTop, navRightWidth });
  },

  async onShow() {
    this.applyUser(getStoredUser());
    await Promise.allSettled([this.loadPlans(), this.loadPrompts(), this.loadModels(), this.loadTasks()]);
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
      selectedPromptTitle: prompt?.title || ""
    });
    this.updateCurrentSizeLabel();
  },

  applyUser(user: User | null) {
    this.setData({
      user,
      displayName: user?.phone ? maskPhone(user.phone) : (user?.nickname || "138****5678"),
      membershipLine: user?.membership
        ? `${user.membership.planName} · 有效期至 ${formatExpireDate(user.membership.expiresAt)}`
        : "高级会员 · 有效期至 2025-06-18",
      avatarUrl: user?.avatarUrl ? absoluteUrl(user.avatarUrl) : "/assets/demo/avatar.jpg",
      creditBalance: user?.credits ?? 286,
      memberButtonText: user ? "会员中心" : "立即登录"
    });
  },

  async loadPlans() {
    try {
      const data = await request<{ plans: Plan[] }>("/api/membership-plans", { auth: false });
      this.setData({ plans: data.plans });
    } catch (error) {
      this.setData({ message: (error as Error).message });
    }
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
      const selectedPromptId = hydrated.some((item) => item.id === this.data.selectedPromptId)
        ? this.data.selectedPromptId
        : (hydrated[0]?.id || "");
      const selectedPrompt = hydrated.find((item) => item.id === selectedPromptId) || null;
      this.setData({
        prompts: hydrated,
        selectedPromptId,
        promptChips: toPromptChips(hydrated)
      });
      this.applyPromptDefaults(selectedPrompt);
    } catch (error) {
      this.setData({
        prompts: [],
        promptChips: [],
        selectedPromptId: "",
        selectedPromptPreviewUrl: "",
        selectedPromptScene: "",
        selectedPromptTitle: "",
        message: this.data.message || (error as Error).message
      });
    }
  },

  async loadModels() {
    try {
      const data = await request<{ models: Model[] }>("/api/ai-models?taskType=image_to_image", { auth: false });
      this.setData({ models: data.models, selectedModelIndex: 0 });
    } catch (error) {
      this.setData({ message: this.data.message || (error as Error).message });
    }
  },

  async loadTasks() {
    if (!this.data.user) {
      this.setData({
        tasks: [],
        historyImages: [],
        recentTasks: demoRecentTasks,
        latestTaskStatus: "已完成",
        latestTaskRelative: "2分钟前"
      });
      return;
    }
    try {
      const data = await request<{ tasks: Task[] }>("/api/ai-image-tasks");
      const tasks = await Promise.all(data.tasks.map(async (task) => {
        const inputImages = task.inputImages?.length
          ? task.inputImages
          : (task.inputImageUrls || []).map((url) => normalizeMediaImage({ originalUrl: url, previewUrl: url, thumbUrl: url })).filter(Boolean) as MediaImage[];
        const resultImages = task.resultImages?.length
          ? task.resultImages
          : (task.resultImageUrls || []).map((url) => normalizeMediaImage({ originalUrl: url, previewUrl: url, thumbUrl: url })).filter(Boolean) as MediaImage[];
        return {
          ...task,
          inputImages: await resolveMediaImages(inputImages),
          resultImages: await resolveMediaImages(resultImages)
        };
      }));
      const recentTasks = tasks.length ? tasks.slice(0, 4).map(toRecentCard) : demoRecentTasks;
      this.setData({
        tasks,
        recentTasks,
        latestTaskStatus: tasks[0] ? statusText(tasks[0].status) : "暂无任务",
        latestTaskRelative: tasks[0] ? formatLatestRelative(tasks[0].updatedAt || tasks[0].createdAt) : "刚刚"
      });
      this.buildHistoryImages();
    } catch (error) {
      this.setData({
        recentTasks: demoRecentTasks,
        latestTaskStatus: "暂无任务",
        latestTaskRelative: "刚刚",
        message: this.data.message || (error as Error).message
      });
    }
  },

  buildHistoryImages() {
    const seen = new Set<string>();
    const history: HistoryItem[] = [];
    this.data.tasks.forEach((task) => {
      (task.inputImages || []).forEach((image) => {
        const key = image.assetId || image.originalUrl;
        if (!key || seen.has(key)) return;
        seen.add(key);
        history.push({
          image,
          previewUrl: image.thumbUrl || image.previewUrl || image.originalUrl,
          title: task.promptTitle || "历史参考图",
          selected: false
        });
      });
    });
    this.setData({ historyImages: history });
  },

  syncCost() {
    const model = this.data.models[this.data.selectedModelIndex];
    const prompt = this.data.prompts.find((item) => item.id === this.data.selectedPromptId);
    const unitCost = Number(
      model?.creditCost?.image_to_image ||
      model?.creditCost?.edit ||
      prompt?.creditCost ||
      2
    );
    this.updateCurrentSizeLabel();
    this.setData({ creditCost: unitCost * this.data.count });
  },

  selectPrompt(event: WechatMiniprogram.TouchEvent) {
    const id = String(event.currentTarget.dataset.id || "");
    const prompt = this.data.prompts.find((item) => item.id === id);
    if (!prompt) return;
    this.setData({ selectedPromptId: id });
    this.applyPromptDefaults(prompt);
    this.syncCost();
  },

  selectPromptFromSheet(event: WechatMiniprogram.TouchEvent) {
    const id = String(event.currentTarget.dataset.id || "");
    const prompt = this.data.prompts.find((item) => item.id === id);
    if (!prompt) return;
    this.setData({ selectedPromptId: id, templateVisible: false });
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
    if (remaining <= 0) {
      this.setData({ message: `最多选择 ${MAX_REFERENCE_IMAGES} 张参考图。` });
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
    this.setData({ uploadedImages: [...this.data.uploadedImages, ...items], message: "" });
  },

  removeImage(event: WechatMiniprogram.TouchEvent) {
    const id = String(event.currentTarget.dataset.id || "");
    this.setData({ uploadedImages: this.data.uploadedImages.filter((item) => item.id !== id) });
  },

  openHistory() {
    if (!this.data.historyImages.length) {
      this.setData({ message: "暂无可用的历史参考图。" });
      return;
    }
    this.setData({ historyVisible: true });
  },

  closeHistory() {
    this.setData({ historyVisible: false });
  },

  openMemberCenter() {
    this.setData({ memberVisible: true, message: "" });
  },

  closeMemberCenter() {
    this.setData({ memberVisible: false });
  },

  openTemplateSheet() {
    if (!this.data.prompts.length) {
      this.setData({ message: "模板数据尚未加载完成。" });
      return;
    }
    this.setData({ templateVisible: true });
  },

  closeTemplateSheet() {
    this.setData({ templateVisible: false });
  },

  toggleHistoryImage(event: WechatMiniprogram.TouchEvent) {
    const url = String(event.currentTarget.dataset.url || "");
    this.setData({
      historyImages: this.data.historyImages.map((item) => (
        item.image.originalUrl === url ? { ...item, selected: !item.selected } : item
      ))
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
      this.setData({ memberVisible: true, message: "请先登录后再生成。" });
      return;
    }
    if (!this.data.user.membership) {
      this.setData({ memberVisible: true, message: "请先购买积分套餐。" });
      return;
    }
    if (!this.data.prompts.find((item) => item.id === this.data.selectedPromptId)) {
      this.setData({ message: "模板数据尚未加载完成。" });
      return;
    }
    if (!this.data.uploadedImages.length) {
      this.setData({ message: "请先上传至少 1 张参考图。" });
      return;
    }
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
      this.applyUser(response.user);
      await this.loadTasks();
      wx.navigateTo({ url: `/pages/result/index?id=${response.task.id}` });
    } catch (error) {
      this.setData({ message: (error as Error).message });
    } finally {
      this.setData({ submitting: false });
    }
  },

  async loginWithWechat() {
    this.setData({ wechatLoading: true, message: "" });
    try {
      const loginResult = await new Promise<{ code?: string }>((resolve, reject) => {
        wx.login({
          success: (res: { code?: string }) => resolve(res || {}),
          fail: reject
        });
      });
      if (!loginResult.code) throw new Error("微信授权未返回登录凭证。");
      const profile = await new Promise<{ nickName?: string; avatarUrl?: string }>((resolve) => {
        if (typeof wx.getUserProfile !== "function") return resolve({});
        wx.getUserProfile({
          desc: "用于完善会员资料",
          success: (res: { userInfo?: { nickName?: string; avatarUrl?: string } }) => resolve(res.userInfo || {}),
          fail: () => resolve({})
        });
      });
      const data = await request<LoginResponse>("/api/auth/wechat/miniapp-login", {
        method: "POST",
        auth: false,
        data: {
          code: loginResult.code,
          nickname: profile.nickName || "",
          avatarUrl: profile.avatarUrl || ""
        }
      });
      saveSession(data);
      getApp<{ globalData: { user: User | null } }>().globalData.user = data.user;
      this.applyUser(data.user);
      this.setData({ memberVisible: false, message: "微信授权登录成功。" });
      await this.loadTasks();
    } catch (error) {
      this.setData({ message: (error as Error).message || "微信授权登录失败。" });
    } finally {
      this.setData({ wechatLoading: false });
    }
  },

  async subscribePlan(event: WechatMiniprogram.TouchEvent) {
    if (!this.data.user) {
      this.setData({ message: "请先登录。" });
      return;
    }
    try {
      const planCode = String(event.currentTarget.dataset.code || "");
      const data = await request<{ paymentStatus: string; message: string; paymentQrUrl?: string; plan: Plan }>("/api/memberships/subscribe", {
        method: "POST",
        data: { planCode }
      });
      this.setData({
        paymentVisible: true,
        selectedPaymentPlan: data.plan,
        selectedPaymentPlanSummary: `${data.plan.credits} 积分 / ${data.plan.quota} 张`,
        message: data.message || "请先完成付款。"
      });
    } catch (error) {
      this.setData({ message: (error as Error).message });
    }
  },

  closePaymentSheet() {
    this.setData({
      paymentVisible: false,
      selectedPaymentPlan: null,
      selectedPaymentPlanSummary: "支付成功后发放积分"
    });
  },

  logout() {
    clearSession();
    getApp<{ globalData: { user: User | null } }>().globalData.user = null;
    this.applyUser(null);
    this.setData({
      memberVisible: false,
      tasks: [],
      uploadedImages: [],
      historyImages: [],
      recentTasks: demoRecentTasks,
      latestTaskStatus: "已完成",
      latestTaskRelative: "2分钟前",
      message: "已退出。"
    });
  },

  openTask(event: WechatMiniprogram.TouchEvent) {
    const id = String(event.currentTarget.dataset.id || "");
    const disabled = String(event.currentTarget.dataset.disabled || "") === "true";
    if (!id || disabled) return;
    wx.navigateTo({ url: `/pages/result/index?id=${id}` });
  },

  goRecords() {
    wx.switchTab({ url: "/pages/records/index" });
  },

  noop() {}
});
