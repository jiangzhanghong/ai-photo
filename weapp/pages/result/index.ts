import type { MediaImage, Task } from "../../types/api";
import { formatDate, formatLatency, statusText } from "../../utils/format";
import { normalizeMediaImage, resolveMediaImages } from "../../utils/media";
import { request } from "../../utils/request";

interface ResultImage {
  url: string;
  previewUrl: string;
}

const imageKey = (images: MediaImage[]) => images
  .map((item) => `${item.assetId || ""}|${item.originalUrl || ""}|${item.previewUrl || ""}|${item.thumbUrl || ""}`)
  .join(";");

Page({
  data: {
    taskId: "",
    task: null as Task | null,
    statusLabel: "",
    latencyLabel: "",
    createdLabel: "",
    images: [] as ResultImage[],
    currentIndex: 0,
    currentUrl: "",
    references: [] as ResultImage[],
    message: "",
    loading: true,
    isPending: false,
    isFailed: false,
    resultStatusDesc: "",
    taskCount: 0,
    creditCost: 0
  },

  pollTimer: 0 as number,
  resultImageKey: "",
  referenceImageKey: "",

  async onLoad(query: { id?: string }) {
    const taskId = String(query.id || "");
    this.setData({ taskId });
    await this.loadTask();
  },

  onUnload() {
    this.stopPolling();
  },

  async loadTask() {
    if (!this.data.taskId) {
      this.setData({ message: "任务不存在。", loading: false });
      return;
    }
    this.setData({ loading: true, message: "" });
    try {
      const data = await request<{ task: Task }>(`/api/ai-image-tasks/${encodeURIComponent(this.data.taskId)}`);
      await this.applyTask(data.task);
      if (data.task.status === "queued" || data.task.status === "processing") this.startPolling();
      else this.stopPolling();
    } catch (error) {
      this.setData({ message: (error as Error).message });
    } finally {
      this.setData({ loading: false });
    }
  },

  async applyTask(task: Task) {
    const resultItems = task.resultImages?.length
      ? task.resultImages
      : (task.resultImageUrls || []).map((url) => normalizeMediaImage({ originalUrl: url, previewUrl: url, thumbUrl: url })).filter(Boolean) as MediaImage[];
    const referenceItems = task.inputImages?.length
      ? task.inputImages
      : (task.inputImageUrls?.length ? task.inputImageUrls.map((url) => normalizeMediaImage({ originalUrl: url, previewUrl: url, thumbUrl: url })).filter(Boolean) as MediaImage[] : []);
    const nextResultImageKey = imageKey(resultItems);
    const nextReferenceImageKey = imageKey(referenceItems);
    let resultUrls = this.data.images;
    let referenceUrls = this.data.references;

    if (nextResultImageKey !== this.resultImageKey) {
      const resolvedResults = await resolveMediaImages(resultItems);
      resultUrls = resolvedResults.map((item) => ({ url: item.originalUrl, previewUrl: item.previewUrl || item.originalUrl }));
      this.resultImageKey = nextResultImageKey;
    }

    if (nextReferenceImageKey !== this.referenceImageKey) {
      const resolvedReferences = await resolveMediaImages(referenceItems);
      referenceUrls = resolvedReferences.map((item) => ({ url: item.originalUrl, previewUrl: item.thumbUrl || item.previewUrl || item.originalUrl }));
      this.referenceImageKey = nextReferenceImageKey;
    }

    const currentIndex = Math.min(this.data.currentIndex, Math.max(0, resultUrls.length - 1));
    const isPending = task.status === "queued" || task.status === "processing";
    const isFailed = task.status === "failed";
    this.setData({
      task,
      images: resultUrls,
      references: referenceUrls,
      currentIndex,
      currentUrl: resultUrls[currentIndex]?.previewUrl || "",
      statusLabel: statusText(task.status),
      latencyLabel: formatLatency(task.providerLatencyMs),
      createdLabel: formatDate(task.createdAt),
      isPending,
      isFailed,
      resultStatusDesc: isFailed
        ? "本次未生成成功，失败任务会自动退回对应积分。"
        : (isPending ? "生成完成后会自动刷新，请不要重复提交。" : "已生成完成，可保存图片或继续创作。"),
      taskCount: task.count,
      creditCost: task.creditCost,
      message: task.failureReason || ""
    });
  },

  startPolling() {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      this.loadTask();
    }, 2000) as unknown as number;
  },

  stopPolling() {
    if (!this.pollTimer) return;
    clearInterval(this.pollTimer);
    this.pollTimer = 0;
  },

  selectImage(event: WechatMiniprogram.TouchEvent) {
    const index = Number(event.currentTarget.dataset.index || 0);
    this.setData({ currentIndex: index, currentUrl: this.data.images[index]?.previewUrl || "" });
  },

  previewCurrent() {
    if (!this.data.currentUrl) return;
    wx.previewImage({
      current: this.data.images[this.data.currentIndex]?.url || this.data.currentUrl,
      urls: this.data.images.map((item) => item.url)
    });
  },

  previewReference(event: WechatMiniprogram.TouchEvent) {
    const url = String(event.currentTarget.dataset.url || "");
    if (!url) return;
    wx.previewImage({
      current: this.data.references.find((item) => item.previewUrl === url)?.url || url,
      urls: this.data.references.map((item) => item.url)
    });
  },

  saveCurrent() {
    const downloadUrl = this.data.images[this.data.currentIndex]?.url || this.data.currentUrl;
    if (!downloadUrl) return;
    const handleSaveFail = (error?: { errMsg?: string }) => {
      const message = String(error?.errMsg || "");
      if (message.includes("auth deny") || message.includes("authorize")) {
        wx.showModal({
          title: "需要相册权限",
          content: "开启保存到相册权限后，才能把生成图片保存到手机。",
          confirmText: "去设置",
          success: (res) => {
            if (res.confirm) wx.openSetting({});
          }
        });
        return;
      }
      wx.showToast({ title: "保存失败", icon: "none" });
    };
    wx.downloadFile({
      url: downloadUrl,
      success: (download) => {
        if (download.statusCode !== 200) {
          wx.showToast({ title: "下载失败", icon: "none" });
          return;
        }
        wx.saveImageToPhotosAlbum({
          filePath: download.tempFilePath,
          success: () => wx.showToast({ title: "已保存" }),
          fail: handleSaveFail
        });
      },
      fail: () => wx.showToast({ title: "下载失败", icon: "none" })
    });
  },

  goRecords() {
    wx.switchTab({ url: "/pages/records/index" });
  },

  goCreate() {
    wx.switchTab({ url: "/pages/create/index" });
  },

  goHome() {
    wx.switchTab({ url: "/pages/home/index" });
  },

  copyTaskId() {
    if (!this.data.taskId) return;
    wx.setClipboardData({ data: this.data.taskId });
  }
});
