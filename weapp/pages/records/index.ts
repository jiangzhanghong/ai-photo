import type { MediaImage, Task } from "../../types/api";
import { absoluteUrl } from "../../utils/config";
import { formatDate, formatLatency, statusText } from "../../utils/format";
import { normalizeMediaImage, resolveMediaImages } from "../../utils/media";
import { request } from "../../utils/request";

interface TaskCard extends Task {
  coverUrl: string;
  statusLabel: string;
  latencyLabel: string;
  createdLabel: string;
}

const toCard = (task: Task): TaskCard => {
  const cover = task.resultImages?.[0]?.thumbUrl || task.resultImages?.[0]?.previewUrl || task.resultImageUrls?.[0] || task.inputImages?.[0]?.thumbUrl || task.inputImages?.[0]?.previewUrl || task.inputImageUrls?.[0] || task.inputImageUrl || "";
  return {
    ...task,
    coverUrl: absoluteUrl(cover),
    statusLabel: statusText(task.status),
    latencyLabel: formatLatency(task.providerLatencyMs),
    createdLabel: formatDate(task.createdAt)
  };
};

Page({
  data: {
    tasks: [] as TaskCard[],
    loading: false,
    message: ""
  },

  async onShow() {
    await this.loadTasks();
  },

  async onPullDownRefresh() {
    await this.loadTasks();
    wx.stopPullDownRefresh();
  },

  async loadTasks() {
    this.setData({ loading: true, message: "" });
    try {
      const data = await request<{ tasks: Task[] }>("/api/ai-image-tasks");
      const tasks = await Promise.all(data.tasks.map(async (task) => {
        const resultImages = task.resultImages?.length
          ? task.resultImages
          : (task.resultImageUrls || []).map((url) => normalizeMediaImage({ originalUrl: url, previewUrl: url, thumbUrl: url })).filter(Boolean) as MediaImage[];
        const inputImages = task.inputImages?.length
          ? task.inputImages
          : (task.inputImageUrls || []).map((url) => normalizeMediaImage({ originalUrl: url, previewUrl: url, thumbUrl: url })).filter(Boolean) as MediaImage[];
        return {
          ...task,
          resultImages: await resolveMediaImages(resultImages),
          inputImages: await resolveMediaImages(inputImages)
        };
      }));
      this.setData({ tasks: tasks.map(toCard) });
    } catch (error) {
      this.setData({ message: (error as Error).message });
    } finally {
      this.setData({ loading: false });
    }
  },

  openTask(event: WechatMiniprogram.TouchEvent) {
    const id = String(event.currentTarget.dataset.id || "");
    if (!id) return;
    wx.navigateTo({ url: `/pages/result/index?id=${id}` });
  },

  goCreate() {
    wx.switchTab({ url: "/pages/create/index" });
  }
});
