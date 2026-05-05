import { getPageChrome } from "../../utils/layout";

Page({
  data: {
    safeTop: 32,
    capsuleGap: 0,
    type: "protocol",
    pageTitle: "用户协议"
  },

  onLoad(query: { type?: string }) {
    const type = query.type === "privacy" ? "privacy" : "protocol";
    this.setData({
      ...getPageChrome(),
      type,
      pageTitle: type === "privacy" ? "隐私政策" : "用户协议"
    });
  },

  goBack() {
    const pages = getCurrentPages();
    if (pages.length > 1) {
      wx.navigateBack();
      return;
    }
    wx.switchTab({ url: "/pages/profile/index" });
  },

  copyEmail() {
    wx.setClipboardData({ data: "support@ai-photo.local" });
  }
});
