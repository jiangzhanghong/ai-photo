import type { MediaImage, Task } from "../../types/api";
import { normalizeMediaImage, resolveMediaImages } from "../../utils/media";
import { request } from "../../utils/request";
import { getStoredUser } from "../../utils/session";
import {
  getFallbackWorks,
  toShowcaseWorks,
  workFilterTabs,
  type ShowcaseWork
} from "../../utils/showcase";

Page({
  data: {
    safeTop: 32,
    filters: [...workFilterTabs],
    activeFilter: "all",
    works: getFallbackWorks(),
    displayWorks: getFallbackWorks()
  },

  onLoad() {
    const { statusBarHeight = 24 } = wx.getSystemInfoSync();
    this.setData({ safeTop: statusBarHeight + 12 });
  },

  async onShow() {
    await this.loadWorks();
    this.applyFilter();
  },

  async onPullDownRefresh() {
    await this.loadWorks();
    this.applyFilter();
    wx.stopPullDownRefresh();
  },

  async loadWorks() {
    if (!getStoredUser()) {
      this.setData({ works: getFallbackWorks() });
      return;
    }
    try {
      const data = await request<{ tasks: Task[] }>("/api/ai-image-tasks");
      const tasks = await Promise.all((data.tasks || []).map(async (task) => {
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
      this.setData({ works: toShowcaseWorks(tasks) });
    } catch {
      this.setData({ works: getFallbackWorks() });
    }
  },

  applyFilter() {
    const activeFilter = this.data.activeFilter;
    const displayWorks = activeFilter === "all"
      ? this.data.works
      : this.data.works.filter((item) => item.filter === activeFilter);
    this.setData({ displayWorks });
  },

  selectFilter(event: WechatMiniprogram.TouchEvent) {
    this.setData({ activeFilter: String(event.currentTarget.dataset.value || "all") });
    this.applyFilter();
  },

  openWork(event: WechatMiniprogram.TouchEvent) {
    const id = String(event.currentTarget.dataset.id || "");
    const work = this.data.works.find((item) => item.id === id) as ShowcaseWork | undefined;
    if (!work) return;
    if (work.taskId) {
      wx.navigateTo({ url: `/pages/result/index?id=${work.taskId}` });
      return;
    }
    wx.previewImage({
      current: work.imageUrl,
      urls: this.data.works.map((item) => item.imageUrl)
    });
  }
});
