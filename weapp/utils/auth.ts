import { hasStoredSession } from "./session";

const LOGIN_REDIRECT_KEY = "ai_photo_login_redirect";

export const saveLoginRedirect = (url: string) => {
  if (url) wx.setStorageSync(LOGIN_REDIRECT_KEY, url);
};

export const consumeLoginRedirect = () => {
  const url = String(wx.getStorageSync(LOGIN_REDIRECT_KEY) || "");
  if (url) wx.removeStorageSync(LOGIN_REDIRECT_KEY);
  return url;
};

export const requireLogin = (redirectUrl = "") => {
  if (hasStoredSession()) return true;
  saveLoginRedirect(redirectUrl);
  wx.showToast({ title: "请先登录", icon: "none" });
  setTimeout(() => {
    wx.switchTab({ url: "/pages/profile/index" });
  }, 120);
  return false;
};
