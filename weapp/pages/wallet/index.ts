import type { User } from "../../types/api";
import { requireLogin } from "../../utils/auth";
import { getStoredUser } from "../../utils/session";
import { syncCurrentUser } from "../../utils/user";
import {
  getDisplayCredits,
  walletPackages,
  walletRecords
} from "../../utils/showcase";

Page({
  data: {
    user: null as User | null,
    creditBalance: 0,
    needsLogin: false,
    packages: walletPackages,
    selectedPackageId: walletPackages[1].id,
    records: walletRecords
  },

  async onShow() {
    if (!requireLogin("/pages/wallet/index")) return;
    const user = getStoredUser();
    this.setData({
      user,
      needsLogin: !user,
      creditBalance: getDisplayCredits(user)
    });
    const syncedUser = await syncCurrentUser();
    this.setData({
      user: syncedUser,
      needsLogin: !syncedUser,
      creditBalance: getDisplayCredits(syncedUser)
    });
  },

  selectPackage(event: WechatMiniprogram.TouchEvent) {
    this.setData({ selectedPackageId: String(event.currentTarget.dataset.id || walletPackages[1].id) });
  },

  rechargeNow() {
    if (!this.data.user) {
      wx.switchTab({ url: "/pages/profile/index" });
      return;
    }
    const selected = this.data.packages.find((item) => item.id === this.data.selectedPackageId);
    wx.showToast({
      title: selected ? `${selected.priceLabel} 充值待接支付` : "充值能力待接支付",
      icon: "none"
    });
  },

  handleQuickAction(event: WechatMiniprogram.TouchEvent) {
    if (!this.data.user) {
      wx.switchTab({ url: "/pages/profile/index" });
      return;
    }
    const key = String(event.currentTarget.dataset.key || "");
    wx.navigateTo({ url: key === "orders" ? "/pages/orders/index" : "/pages/flows/index" });
  },

  goLogin() {
    wx.switchTab({ url: "/pages/profile/index" });
  }
});
