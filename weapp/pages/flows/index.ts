import type { Task, User } from "../../types/api";
import { requireLogin } from "../../utils/auth";
import { formatDate, statusText } from "../../utils/format";
import { request } from "../../utils/request";
import { getStoredUser } from "../../utils/session";
import { getDisplayCredits, walletRecords } from "../../utils/showcase";
import { syncCurrentUser } from "../../utils/user";

interface FlowRecord {
  id: string;
  title: string;
  createdLabel: string;
  amountLabel: string;
  creditsLabel: string;
  statusLabel: string;
  type: "income" | "expense";
}

const toTaskFlow = (task: Task): FlowRecord => ({
  id: `task-${task.id}`,
  title: task.promptTitle || "AI 写真生成",
  createdLabel: formatDate(task.createdAt),
  amountLabel: `${task.count || 1} 张`,
  creditsLabel: `-${Number(task.creditCost || 0)} 积分`,
  statusLabel: statusText(task.status),
  type: "expense"
});

const fallbackIncomeFlows = walletRecords.map((item) => ({
  ...item,
  type: "income" as const
}));

Page({
  data: {
    user: null as User | null,
    needsLogin: false,
    creditBalance: 0,
    records: [] as FlowRecord[],
    loading: false
  },

  async onShow() {
    if (!requireLogin("/pages/flows/index")) return;
    await this.refreshFlows();
  },

  async onPullDownRefresh() {
    await this.refreshFlows();
    wx.stopPullDownRefresh();
  },

  async refreshFlows() {
    const cachedUser = getStoredUser();
    this.setData({
      user: cachedUser,
      needsLogin: !cachedUser,
      creditBalance: getDisplayCredits(cachedUser),
      loading: Boolean(cachedUser)
    });
    if (!cachedUser) return;

    const user = await syncCurrentUser();
    if (!user) {
      this.setData({
        user: null,
        needsLogin: true,
        creditBalance: 0,
        records: [],
        loading: false
      });
      return;
    }

    try {
      const data = await request<{ tasks: Task[] }>("/api/ai-image-tasks");
      const taskFlows = (data.tasks || []).map(toTaskFlow);
      this.setData({
        user,
        needsLogin: false,
        creditBalance: getDisplayCredits(user),
        records: [...taskFlows, ...fallbackIncomeFlows],
        loading: false
      });
    } catch {
      this.setData({
        user,
        needsLogin: false,
        creditBalance: getDisplayCredits(user),
        records: fallbackIncomeFlows,
        loading: false
      });
    }
  },

  goLogin() {
    wx.switchTab({ url: "/pages/profile/index" });
  }
});
