import type { LoginResponse, Task, User } from "../../types/api";
import { request } from "../../utils/request";
import { clearSession, getStoredUser, saveSession } from "../../utils/session";
import {
  getCumulativeRecharge,
  getCumulativeSpend,
  getDisplayAvatar,
  getDisplayCredits,
  getDisplayName,
  getWechatBindingLabel,
  profileActions
} from "../../utils/showcase";

Page({
  data: {
    safeTop: 32,
    user: null as User | null,
    tasks: [] as Task[],
    avatarUrl: getDisplayAvatar(null),
    displayName: getDisplayName(null),
    creditBalance: 320,
    cumulativeRecharge: 520,
    cumulativeSpend: 200,
    actions: profileActions
  },

  onLoad() {
    const { statusBarHeight = 24 } = wx.getSystemInfoSync();
    this.setData({ safeTop: statusBarHeight + 12 });
  },

  async onShow() {
    await this.refreshProfile();
  },

  async refreshProfile() {
    const user = getStoredUser();
    let tasks: Task[] = [];
    if (user) {
      try {
        const data = await request<{ tasks: Task[] }>("/api/ai-image-tasks");
        tasks = data.tasks || [];
      } catch {
        tasks = [];
      }
    }
    const cumulativeSpend = user ? getCumulativeSpend(tasks) || 200 : 200;
    const cumulativeRecharge = user ? getCumulativeRecharge(user, tasks) : 520;
    this.setData({
      user,
      tasks,
      avatarUrl: getDisplayAvatar(user),
      displayName: getDisplayName(user),
      creditBalance: getDisplayCredits(user),
      cumulativeRecharge,
      cumulativeSpend,
      actions: profileActions.map((item) => (
        item.key === "bindWechat"
          ? { ...item, value: getWechatBindingLabel(user) }
          : item
      ))
    });
  },

  async loginWithWechat() {
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
    wx.showToast({ title: "微信已绑定", icon: "success" });
  },

  async handleAction(event: WechatMiniprogram.TouchEvent) {
    const key = String(event.currentTarget.dataset.key || "");
    if (key === "recharge") {
      wx.switchTab({ url: "/pages/wallet/index" });
      return;
    }
    if (key === "bindWechat") {
      if (this.data.user) {
        wx.showToast({ title: "当前账号已绑定微信", icon: "none" });
        return;
      }
      try {
        await this.loginWithWechat();
      } catch (error) {
        wx.showToast({ title: (error as Error).message, icon: "none" });
      }
      return;
    }
    if (key === "logout") {
      clearSession();
      getApp<{ globalData: { user: User | null } }>().globalData.user = null;
      await this.refreshProfile();
      wx.showToast({ title: "已退出登录", icon: "none" });
      return;
    }
    if (key === "orders" || key === "flows") {
      wx.switchTab({ url: "/pages/wallet/index" });
      return;
    }
    const tips: Record<string, string> = {
      protocol: "用户协议待补充正式内容",
      privacy: "隐私政策待补充正式内容",
      contact: "联系邮箱：support@ai-photo.local"
    };
    wx.showToast({ title: tips[key] || "功能整理中", icon: "none" });
  }
});
