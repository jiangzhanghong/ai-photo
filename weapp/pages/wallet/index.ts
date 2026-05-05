import type { User } from "../../types/api";
import { getStoredUser } from "../../utils/session";
import {
  getDisplayCredits,
  walletPackages,
  walletRecords
} from "../../utils/showcase";

Page({
  data: {
    safeTop: 32,
    user: null as User | null,
    creditBalance: 0,
    needsLogin: false,
    packages: walletPackages,
    selectedPackageId: walletPackages[1].id,
    records: walletRecords
  },

  onLoad() {
    const { statusBarHeight = 24 } = wx.getSystemInfoSync();
    this.setData({ safeTop: statusBarHeight + 12 });
  },

  onShow() {
    const user = getStoredUser();
    this.setData({
      user,
      needsLogin: !user,
      creditBalance: getDisplayCredits(user)
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
    const label = key === "orders" ? "订单" : "充值记录";
    wx.showToast({ title: `${label}页待接真实数据`, icon: "none" });
  },

  goLogin() {
    wx.switchTab({ url: "/pages/profile/index" });
  }
});
