import { hasStoredSession } from "./session";

export const requireLogin = () => {
  if (hasStoredSession()) return true;
  wx.showToast({ title: "请先登录", icon: "none" });
  setTimeout(() => {
    wx.switchTab({ url: "/pages/profile/index" });
  }, 120);
  return false;
};
