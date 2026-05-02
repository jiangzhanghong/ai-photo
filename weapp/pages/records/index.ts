import type { Task } from "../../types/api";
import { absoluteUrl } from "../../utils/config";
import { formatDate, formatLatency, statusText } from "../../utils/format";
import { request } from "../../utils/request";

interface TaskCard extends Task {
  coverUrl: string;
  statusLabel: string;
  latencyLabel: string;
  createdLabel: string;
}

const toCard = (task: Task): TaskCard => {
  const cover = task.resultImageUrls?.[0] || task.inputImageUrls?.[0] || task.inputImageUrl || "";
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
      this.setData({ tasks: data.tasks.map(toCard) });
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
