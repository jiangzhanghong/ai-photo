import type { Task } from "../../types/api";
import { absoluteUrl } from "../../utils/config";
import { formatDate, formatLatency, statusText } from "../../utils/format";
import { request } from "../../utils/request";

interface ResultImage {
  url: string;
  previewUrl: string;
}

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
    taskCount: 0,
    creditCost: 0
  },

  pollTimer: 0 as number,

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
      const data = await request<{ tasks: Task[] }>("/api/ai-image-tasks");
      const task = data.tasks.find((item) => item.id === this.data.taskId) || null;
      if (!task) {
        this.setData({ message: "任务不存在。", loading: false });
        return;
      }
      this.applyTask(task);
      if (task.status === "queued" || task.status === "processing") this.startPolling();
      else this.stopPolling();
    } catch (error) {
      this.setData({ message: (error as Error).message });
    } finally {
      this.setData({ loading: false });
    }
  },

  applyTask(task: Task) {
    const resultUrls = (task.resultImageUrls || []).map((url) => ({ url, previewUrl: absoluteUrl(url) }));
    const referenceUrls = (task.inputImageUrls?.length ? task.inputImageUrls : (task.inputImageUrl ? [task.inputImageUrl] : []))
      .map((url) => ({ url, previewUrl: absoluteUrl(url) }));
    const currentIndex = Math.min(this.data.currentIndex, Math.max(0, resultUrls.length - 1));
    this.setData({
      task,
      images: resultUrls,
      references: referenceUrls,
      currentIndex,
      currentUrl: resultUrls[currentIndex]?.previewUrl || "",
      statusLabel: statusText(task.status),
      latencyLabel: formatLatency(task.providerLatencyMs),
      createdLabel: formatDate(task.createdAt),
      isPending: task.status === "queued" || task.status === "processing",
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
      current: this.data.currentUrl,
      urls: this.data.images.map((item) => item.previewUrl)
    });
  },

  previewReference(event: WechatMiniprogram.TouchEvent) {
    const url = String(event.currentTarget.dataset.url || "");
    if (!url) return;
    wx.previewImage({
      current: url,
      urls: this.data.references.map((item) => item.previewUrl)
    });
  },

  saveCurrent() {
    if (!this.data.currentUrl) return;
    wx.downloadFile({
      url: this.data.currentUrl,
      success: (download) => {
        if (download.statusCode !== 200) {
          wx.showToast({ title: "下载失败", icon: "none" });
          return;
        }
        wx.saveImageToPhotosAlbum({
          filePath: download.tempFilePath,
          success: () => wx.showToast({ title: "已保存" }),
          fail: () => wx.showToast({ title: "保存失败", icon: "none" })
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
  }
});
