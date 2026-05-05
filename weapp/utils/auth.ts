import { getStoredUser } from "./session";

export const requireLogin = () => {
  if (getStoredUser()) return true;
  wx.showToast({ title: "请先登录", icon: "none" });
  setTimeout(() => {
    wx.switchTab({ url: "/pages/profile/index" });
  }, 120);
  return false;
};
