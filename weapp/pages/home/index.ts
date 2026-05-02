import type { LoginResponse, Model, Plan, Prompt, Task, User } from "../../types/api";
import { absoluteUrl, MAX_REFERENCE_IMAGES } from "../../utils/config";
import { formatDate, statusText } from "../../utils/format";
import { request } from "../../utils/request";
import { clearSession, getStoredUser, saveSession } from "../../utils/session";

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

interface PromptChip {
  id: string;
  title: string;
  sceneLabel: string;
}

interface ReferencePreviewItem {
  id: string;
  previewUrl: string;
  placeholder: boolean;
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

const ratioOptions = [
  { label: "1:1", value: "1:1" },
  { label: "3:4", value: "3:4" },
  { label: "4:3", value: "4:3" },
  { label: "9:16", value: "9:16" },
  { label: "16:9", value: "16:9" }
];

const fallbackPromptChips: PromptChip[] = [
  { id: "fallback-portrait", title: "写真摄影", sceneLabel: "写真摄影" },
  { id: "fallback-chinese", title: "国风古韵", sceneLabel: "国风古韵" },
  { id: "fallback-anime", title: "动漫游戏", sceneLabel: "动漫游戏" },
  { id: "fallback-interior", title: "室内设计", sceneLabel: "室内设计" }
];

const placeholderReferenceUrls = [
  "/assets/demo/ref-1.jpg",
  "/assets/demo/ref-2.jpg",
  "/assets/demo/ref-3.jpg"
];

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

const normalizeSceneLabel = (prompt: Prompt) => {
  return prompt.scene || prompt.categoryTags?.[0] || prompt.title;
};

const toPromptChips = (prompts: Prompt[]) => {
  if (!prompts.length) return fallbackPromptChips;
  return prompts.slice(0, 4).map((prompt) => ({
    id: prompt.id,
    title: prompt.title,
    sceneLabel: normalizeSceneLabel(prompt)
  }));
};

const toRecentCard = (task: Task): RecentTaskCard => {
  const cover = task.resultImageUrls?.[0] || task.inputImageUrls?.[0] || task.inputImageUrl || "/assets/demo/recent-1.jpg";
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
    ratioOptions,
    user: null as User | null,
    plans: [] as Plan[],
    prompts: [] as Prompt[],
    promptChips: fallbackPromptChips,
    models: [] as Model[],
    tasks: [] as Task[],
    uploadedImages: [] as UploadItem[],
    referencePreviewItems: placeholderReferenceUrls.map((url, index) => ({
      id: `placeholder-${index}`,
      previewUrl: url,
      placeholder: true
    })) as ReferencePreviewItem[],
    historyImages: [] as HistoryItem[],
    recentTasks: demoRecentTasks,
    historyVisible: false,
    memberVisible: false,
    templateVisible: false,
    selectedPromptId: "",
    selectedModelIndex: 0,
    selectedRatioIndex: 0,
    customPrompt: "",
    count: 2,
    creditCost: 4,
    submitting: false,
    sending: false,
    message: "",
    phone: "",
    code: "",
    displayName: "138****5678",
    membershipLine: "高级会员 · 有效期至 2025-06-18",
    avatarUrl: "/assets/demo/avatar.jpg",
    creditBalance: 286,
    latestTaskStatus: "已完成",
    latestTaskRelative: "2分钟前",
    memberButtonText: "会员中心",
    hasMorePrompts: false
  },

  async onLoad() {
    const windowInfo = typeof wx.getWindowInfo === "function" ? wx.getWindowInfo() : null;
    const menuRect = typeof wx.getMenuButtonBoundingClientRect === "function" ? wx.getMenuButtonBoundingClientRect() : null;
    const safeTop = (windowInfo?.statusBarHeight || 24) + 18;
    const navRightWidth = menuRect && windowInfo ? windowInfo.windowWidth - menuRect.left + 24 : 210;
    this.setData({ safeTop, navRightWidth });
    this.syncReferencePreview();
  },

  async onShow() {
    this.applyUser(getStoredUser());
    await Promise.allSettled([this.loadPlans(), this.loadPrompts(), this.loadModels(), this.loadTasks()]);
    this.syncCost();
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
      const selectedPromptId = this.data.selectedPromptId || data.prompts[0]?.id || "";
      this.setData({
        prompts: data.prompts,
        selectedPromptId,
        promptChips: toPromptChips(data.prompts),
        hasMorePrompts: data.prompts.length > 4
      });
    } catch (error) {
      this.setData({
        promptChips: fallbackPromptChips,
        hasMorePrompts: false,
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
      const recentTasks = data.tasks.length ? data.tasks.slice(0, 4).map(toRecentCard) : demoRecentTasks;
      this.setData({
        tasks: data.tasks,
        recentTasks,
        latestTaskStatus: data.tasks[0] ? statusText(data.tasks[0].status) : "暂无任务",
        latestTaskRelative: data.tasks[0] ? formatLatestRelative(data.tasks[0].updatedAt || data.tasks[0].createdAt) : "刚刚"
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
      const urls = task.inputImageUrls?.length ? task.inputImageUrls : (task.inputImageUrl ? [task.inputImageUrl] : []);
      urls.forEach((url) => {
        if (!url || seen.has(url)) return;
        seen.add(url);
        history.push({
          url,
          previewUrl: absoluteUrl(url),
          title: task.promptTitle || "历史参考图",
          selected: false
        });
      });
    });
    this.setData({ historyImages: history });
  },

  syncReferencePreview() {
    const actualItems: ReferencePreviewItem[] = this.data.uploadedImages.slice(0, 3).map((item) => ({
      id: item.id,
      previewUrl: item.previewUrl,
      placeholder: false
    }));
    const placeholders = placeholderReferenceUrls
      .slice(0, Math.max(0, 3 - actualItems.length))
      .map((url, index) => ({
        id: `placeholder-${index}`,
        previewUrl: url,
        placeholder: true
      }));
    this.setData({ referencePreviewItems: [...actualItems, ...placeholders] });
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
    this.setData({ creditCost: unitCost * this.data.count });
  },

  selectPrompt(event: WechatMiniprogram.TouchEvent) {
    const id = String(event.currentTarget.dataset.id || "");
    if (!this.data.prompts.find((item) => item.id === id)) return;
    this.setData({ selectedPromptId: id });
    this.syncCost();
  },

  selectPromptFromSheet(event: WechatMiniprogram.TouchEvent) {
    const id = String(event.currentTarget.dataset.id || "");
    if (!this.data.prompts.find((item) => item.id === id)) return;
    this.setData({ selectedPromptId: id, templateVisible: false });
    this.syncCost();
  },

  selectRatio(event: WechatMiniprogram.TouchEvent) {
    const index = Number(event.currentTarget.dataset.index || 0);
    this.setData({ selectedRatioIndex: index });
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
    this.syncReferencePreview();
  },

  removeImage(event: WechatMiniprogram.TouchEvent) {
    const id = String(event.currentTarget.dataset.id || "");
    this.setData({ uploadedImages: this.data.uploadedImages.filter((item) => item.id !== id) });
    this.syncReferencePreview();
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
        item.url === url ? { ...item, selected: !item.selected } : item
      ))
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
    this.setData({
      uploadedImages: [...this.data.uploadedImages, ...items],
      historyVisible: false,
      message: items.length ? `已添加 ${items.length} 张历史参考图。` : "没有可添加的历史参考图。"
    });
    this.syncReferencePreview();
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
      const data = await request<{ url: string }>("/api/uploads/images", {
        method: "POST",
        data: { imageData }
      });
      item.uploadedUrl = data.url;
      urls.push(data.url);
    }
    return urls;
  },

  async submitTask() {
    if (!this.data.user) {
      this.setData({ memberVisible: true, message: "请先登录后再生成。" });
      return;
    }
    if (!this.data.user.membership) {
      this.setData({ memberVisible: true, message: "请先开通会员套餐。" });
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

  onPhoneInput(event: WechatMiniprogram.Input) {
    this.setData({ phone: String(event.detail.value || "") });
  },

  onCodeInput(event: WechatMiniprogram.Input) {
    this.setData({ code: String(event.detail.value || "") });
  },

  async sendCode() {
    if (!this.data.phone) {
      this.setData({ message: "请输入手机号。" });
      return;
    }
    this.setData({ sending: true, message: "" });
    try {
      await request("/api/auth/verification-codes", {
        method: "POST",
        auth: false,
        data: { targetType: "phone", target: this.data.phone, scene: "login" }
      });
      this.setData({ message: "验证码已发送，开发环境默认 867530。" });
    } catch (error) {
      this.setData({ message: (error as Error).message });
    } finally {
      this.setData({ sending: false });
    }
  },

  async login() {
    try {
      const data = await request<LoginResponse>("/api/auth/login/phone-code", {
        method: "POST",
        auth: false,
        data: { phone: this.data.phone, code: this.data.code }
      });
      saveSession(data);
      getApp<{ globalData: { user: User | null } }>().globalData.user = data.user;
      this.applyUser(data.user);
      this.setData({
        memberVisible: false,
        phone: "",
        code: "",
        message: "登录成功。"
      });
      await this.loadTasks();
    } catch (error) {
      this.setData({ message: (error as Error).message });
    }
  },

  async subscribePlan(event: WechatMiniprogram.TouchEvent) {
    if (!this.data.user) {
      this.setData({ message: "请先登录。" });
      return;
    }
    try {
      const planCode = String(event.currentTarget.dataset.code || "");
      const data = await request<{ user: User }>("/api/memberships/subscribe", {
        method: "POST",
        data: { planCode }
      });
      saveSession({ user: data.user });
      getApp<{ globalData: { user: User | null } }>().globalData.user = data.user;
      this.applyUser(data.user);
      this.setData({ message: "套餐已开通。" });
    } catch (error) {
      this.setData({ message: (error as Error).message });
    }
  },

  logout() {
    clearSession();
    getApp<{ globalData: { user: User | null } }>().globalData.user = null;
    this.applyUser(null);
    this.setData({
      memberVisible: false,
      phone: "",
      code: "",
      tasks: [],
      uploadedImages: [],
      historyImages: [],
      recentTasks: demoRecentTasks,
      latestTaskStatus: "已完成",
      latestTaskRelative: "2分钟前",
      message: "已退出。"
    });
    this.syncReferencePreview();
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
