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
    creditBalance: 320,
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
      creditBalance: getDisplayCredits(user)
    });
  },

  selectPackage(event: WechatMiniprogram.TouchEvent) {
    this.setData({ selectedPackageId: String(event.currentTarget.dataset.id || walletPackages[1].id) });
  },

  rechargeNow() {
    const selected = this.data.packages.find((item) => item.id === this.data.selectedPackageId);
    wx.showToast({
      title: selected ? `${selected.priceLabel} 充值待接支付` : "充值能力待接支付",
      icon: "none"
    });
  },

  handleQuickAction(event: WechatMiniprogram.TouchEvent) {
    const key = String(event.currentTarget.dataset.key || "");
    const label = key === "orders" ? "订单" : "充值记录";
    wx.showToast({ title: `${label}页待接真实数据`, icon: "none" });
  }
});
