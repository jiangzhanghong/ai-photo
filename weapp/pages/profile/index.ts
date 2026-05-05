import { consumeLoginRedirect } from "../../utils/auth";
import type { LoginResponse, Task, User } from "../../types/api";
import { request } from "../../utils/request";
import { clearSession, getRefreshToken, getStoredUser, saveSession } from "../../utils/session";
import { getPageChrome } from "../../utils/layout";
import { syncCurrentUser } from "../../utils/user";
import {
  getCumulativeRecharge,
  getCumulativeSpend,
  getDisplayAvatar,
  getDisplayCredits,
  getDisplayName,
  profileActions
} from "../../utils/showcase";

const actionIcons: Record<string, string> = {
  recharge: "coin",
  orders: "doc",
  flows: "list",
  protocol: "shield",
  privacy: "lock",
  contact: "mail",
  logout: "logout"
};

const tabPageUrls = ["/pages/home/index", "/pages/create/index", "/pages/records/index", "/pages/profile/index"];

const avatarSourceLabel = (user?: User | null) => {
  if (!user?.avatarUrl) return "未获取微信头像，点头像可设置";
  if (user.avatarSource === "custom") return "当前使用自定义头像，点头像可更换";
  return "当前使用微信头像，点头像可自定义";
};

Page({
  data: {
    safeTop: 32,
    capsuleGap: 0,
    user: null as User | null,
    tasks: [] as Task[],
    avatarUrl: getDisplayAvatar(null),
    displayName: getDisplayName(null),
    avatarHint: avatarSourceLabel(null),
    creditBalance: 0,
    cumulativeRecharge: 0,
    cumulativeSpend: 0,
    loggingIn: false,
    updatingAvatar: false,
    actions: profileActions
  },

  onLoad() {
    this.setData(getPageChrome());
  },

  async onShow() {
    await this.refreshProfile();
  },

  async refreshProfile() {
    let user = getStoredUser();
    let tasks: Task[] = [];
    if (user) {
      user = await syncCurrentUser();
      if (user) {
        try {
          const data = await request<{ tasks: Task[] }>("/api/ai-image-tasks");
          tasks = data.tasks || [];
        } catch {
          tasks = [];
        }
      }
    }
    const cumulativeSpend = user ? getCumulativeSpend(tasks) : 0;
    const cumulativeRecharge = user ? getCumulativeRecharge(user, tasks) : 0;
    this.setData({
      user,
      tasks,
      avatarUrl: getDisplayAvatar(user),
      displayName: getDisplayName(user),
      avatarHint: avatarSourceLabel(user),
      creditBalance: getDisplayCredits(user),
      cumulativeRecharge,
      cumulativeSpend,
      actions: profileActions.map((item) => ({
        ...item,
        iconText: actionIcons[item.key] || item.label.slice(0, 1),
        value: item.value
      }))
    });
  },

  async loginWithWechat() {
    this.setData({ loggingIn: true });
    try {
      const loginResult = await new Promise<{ code?: string }>((resolve, reject) => {
        wx.login({
          success: (res: { code?: string }) => resolve(res || {}),
          fail: reject
        });
      });
      if (!loginResult.code) throw new Error("微信授权未返回登录凭证。");
      const profile = await new Promise<{ nickName?: string; avatarUrl?: string }>((resolve) => {
        if (typeof wx.getUserProfile !== "function") return resolve({});
        wx.getUserProfile({
          desc: "用于同步小程序用户资料",
          success: (res: { userInfo?: { nickName?: string; avatarUrl?: string } }) => resolve(res.userInfo || {}),
          fail: () => resolve({})
        });
      });
      const data = await request<LoginResponse>("/api/auth/wechat/miniapp-login", {
        method: "POST",
        auth: false,
        data: {
          code: loginResult.code,
          nickname: profile.nickName || "",
          avatarUrl: profile.avatarUrl || ""
        }
      });
      saveSession(data);
      getApp<{ globalData: { user: User | null } }>().globalData.user = data.user;
      await this.refreshProfile();
      this.redirectAfterLogin();
      wx.showToast({ title: "登录成功", icon: "success" });
    } catch (error) {
      wx.showToast({ title: (error as Error).message, icon: "none" });
    } finally {
      this.setData({ loggingIn: false });
    }
  },

  fileToDataUrl(filePath: string) {
    const lowerPath = filePath.toLowerCase();
    const mime = lowerPath.endsWith(".png") ? "image/png" : "image/jpeg";
    return new Promise<string>((resolve, reject) => {
      wx.getFileSystemManager().readFile({
        filePath,
        encoding: "base64",
        success: (res) => resolve(`data:${mime};base64,${res.data}`),
        fail: () => reject(new Error("头像读取失败。"))
      });
    });
  },

  async chooseAvatar(event: { detail: { avatarUrl?: string } }) {
    if (!this.data.user || this.data.updatingAvatar) return;
    const tempAvatarUrl = String(event.detail.avatarUrl || "");
    if (!tempAvatarUrl) return;
    const previousAvatarUrl = this.data.avatarUrl;
    this.setData({ avatarUrl: tempAvatarUrl, updatingAvatar: true });
    try {
      const imageData = await this.fileToDataUrl(tempAvatarUrl);
      const data = await request<{ user: User }>("/api/users/me/avatar", {
        method: "POST",
        data: { imageData }
      });
      saveSession({ user: data.user });
      getApp<{ globalData: { user: User | null } }>().globalData.user = data.user;
      this.setData({
        user: data.user,
        avatarUrl: getDisplayAvatar(data.user),
        avatarHint: avatarSourceLabel(data.user)
      });
      wx.showToast({ title: "头像已更新", icon: "success" });
    } catch (error) {
      this.setData({ avatarUrl: previousAvatarUrl });
      wx.showToast({ title: (error as Error).message, icon: "none" });
    } finally {
      this.setData({ updatingAvatar: false });
    }
  },

  async handleAction(event: WechatMiniprogram.TouchEvent) {
    const key = String(event.currentTarget.dataset.key || "");
    if (key === "recharge") {
      wx.navigateTo({ url: "/pages/wallet/index" });
      return;
    }
    if (key === "logout") {
      const refreshToken = getRefreshToken();
      try {
        if (refreshToken) {
          await request<{ message: string }>("/api/auth/logout", {
            method: "POST",
            auth: false,
            data: { refreshToken }
          });
        }
      } catch {
        // Ignore network failures and always clear the local session.
      }
      clearSession();
      getApp<{ globalData: { user: User | null } }>().globalData.user = null;
      await this.refreshProfile();
      wx.showToast({ title: "已退出登录", icon: "none" });
      return;
    }
    if (key === "orders") {
      wx.navigateTo({ url: "/pages/orders/index" });
      return;
    }
    if (key === "flows") {
      wx.navigateTo({ url: "/pages/flows/index" });
      return;
    }
    if (key === "protocol" || key === "privacy") {
      wx.navigateTo({ url: `/pages/legal/index?type=${key}` });
      return;
    }
    if (key === "contact") {
      wx.showActionSheet({
        itemList: ["复制客服邮箱", "查看隐私说明"],
        success: (res) => {
          if (res.tapIndex === 0) {
            wx.setClipboardData({ data: "support@ai-photo.local" });
            return;
          }
          wx.navigateTo({ url: "/pages/legal/index?type=privacy" });
        }
      });
      return;
    }
    wx.showToast({ title: "功能整理中", icon: "none" });
  },

  redirectAfterLogin() {
    const url = consumeLoginRedirect();
    if (!url || url === "/pages/profile/index") return;
    setTimeout(() => {
      if (tabPageUrls.includes(url)) {
        wx.switchTab({ url });
        return;
      }
      wx.navigateTo({ url });
    }, 250);
  }
});
