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
  getWechatBindingLabel,
  profileActions
} from "../../utils/showcase";

const actionIcons: Record<string, string> = {
  recharge: "coin",
  orders: "doc",
  flows: "list",
  bindWechat: "chat",
  protocol: "shield",
  privacy: "lock",
  contact: "mail",
  logout: "logout"
};

const tabPageUrls = ["/pages/home/index", "/pages/create/index", "/pages/records/index", "/pages/profile/index"];

Page({
  data: {
    safeTop: 32,
    capsuleGap: 0,
    user: null as User | null,
    tasks: [] as Task[],
    avatarUrl: getDisplayAvatar(null),
    displayName: getDisplayName(null),
    creditBalance: 0,
    cumulativeRecharge: 0,
    cumulativeSpend: 0,
    loginMode: "wechat",
    account: "",
    password: "",
    loggingIn: false,
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
      creditBalance: getDisplayCredits(user),
      cumulativeRecharge,
      cumulativeSpend,
      actions: profileActions.map((item) => ({
        ...item,
        iconText: actionIcons[item.key] || item.label.slice(0, 1),
        value: item.key === "bindWechat" ? getWechatBindingLabel(user) : item.value
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

  switchLoginMode(event: WechatMiniprogram.TouchEvent) {
    this.setData({ loginMode: String(event.currentTarget.dataset.mode || "wechat") });
  },

  onAccountInput(event: WechatMiniprogram.Input) {
    this.setData({ account: String(event.detail.value || "").trim() });
  },

  onPasswordInput(event: WechatMiniprogram.Input) {
    this.setData({ password: String(event.detail.value || "") });
  },

  async loginWithAccount() {
    const account = String(this.data.account || "").trim();
    const password = String(this.data.password || "");
    if (!account) {
      wx.showToast({ title: "请输入账号", icon: "none" });
      return;
    }
    if (!password) {
      wx.showToast({ title: "请输入密码", icon: "none" });
      return;
    }
    this.setData({ loggingIn: true });
    try {
      const data = await request<LoginResponse>("/api/auth/login/password", {
        method: "POST",
        auth: false,
        data: { account, password }
      });
      saveSession(data);
      getApp<{ globalData: { user: User | null } }>().globalData.user = data.user;
      this.setData({ password: "" });
      await this.refreshProfile();
      this.redirectAfterLogin();
      wx.showToast({ title: "登录成功", icon: "success" });
    } catch (error) {
      wx.showToast({ title: (error as Error).message, icon: "none" });
    } finally {
      this.setData({ loggingIn: false });
    }
  },

  async handleAction(event: WechatMiniprogram.TouchEvent) {
    const key = String(event.currentTarget.dataset.key || "");
    if (key === "recharge") {
      wx.navigateTo({ url: "/pages/wallet/index" });
      return;
    }
    if (key === "bindWechat") {
      if (this.data.user?.username) {
        wx.showToast({ title: "账号登录暂不支持绑定微信", icon: "none" });
        return;
      }
      wx.showToast({ title: "当前账号为微信登录", icon: "none" });
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
    const tips: Record<string, string> = {
      protocol: "用户协议待补充正式内容",
      privacy: "隐私政策待补充正式内容",
      contact: "联系邮箱：support@ai-photo.local"
    };
    wx.showToast({ title: tips[key] || "功能整理中", icon: "none" });
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
