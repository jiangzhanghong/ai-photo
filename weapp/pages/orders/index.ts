import type { User } from "../../types/api";
import { requireLogin } from "../../utils/auth";
import { getStoredUser } from "../../utils/session";
import { syncCurrentUser } from "../../utils/user";

interface OrderRecord {
  id: string;
  title: string;
  createdLabel: string;
  amountLabel: string;
  creditsLabel: string;
  statusLabel: string;
}

Page({
  data: {
    user: null as User | null,
    needsLogin: false,
    orders: [] as OrderRecord[],
    loading: false
  },

  async onShow() {
    if (!requireLogin("/pages/orders/index")) return;
    await this.refreshOrders();
  },

  async onPullDownRefresh() {
    await this.refreshOrders();
    wx.stopPullDownRefresh();
  },

  async refreshOrders() {
    const cachedUser = getStoredUser();
    this.setData({
      user: cachedUser,
      needsLogin: !cachedUser,
      loading: Boolean(cachedUser)
    });
    if (!cachedUser) return;

    const user = await syncCurrentUser();
    this.setData({
      user,
      needsLogin: !user,
      orders: [],
      loading: false
    });
  },

  goLogin() {
    wx.switchTab({ url: "/pages/profile/index" });
  }
});
