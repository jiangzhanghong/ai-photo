import type { LoginResponse, Plan, Task, User } from "../../types/api";
import { request } from "../../utils/request";
import { clearSession, saveSession } from "../../utils/session";
import { statusText } from "../../utils/format";

Page({
  data: {
    user: null as User | null,
    plans: [] as Plan[],
    phone: "",
    code: "",
    sending: false,
    message: "",
    latestTaskStatus: "暂无",
    avatarText: "光",
    displayName: "光影AI 会员",
    displayPhone: "登录后同步积分和生成记录",
    planName: "未开通",
    creditBalance: 0
  },

  async onShow() {
    await this.refresh();
  },

  async refresh() {
    const app = getApp<{ globalData: { user: User | null } }>();
    this.applyUser(app.globalData.user);
    await Promise.all([this.loadPlans(), this.loadLatestTask()]);
  },

  applyUser(user: User | null) {
    this.setData({
      user,
      avatarText: user?.nickname ? user.nickname.slice(0, 1) : "光",
      displayName: user?.nickname || "光影AI 会员",
      displayPhone: user?.phone || "登录后同步积分和生成记录",
      planName: user?.membership?.planName || "未开通",
      creditBalance: user?.credits || 0
    });
  },

  async loadPlans() {
    try {
      const data = await request<{ plans: Plan[] }>("/api/membership-plans", { auth: false });
      this.setData({ plans: data.plans });
    } catch (error) {
      this.setData({ message: (error as Error).message });
    }
  },

  async loadLatestTask() {
    if (!this.data.user) return;
    try {
      const data = await request<{ tasks: Task[] }>("/api/ai-image-tasks");
      this.setData({ latestTaskStatus: data.tasks[0] ? statusText(data.tasks[0].status) : "暂无" });
    } catch {
      this.setData({ latestTaskStatus: "暂无" });
    }
  },

  onPhoneInput(event: WechatMiniprogram.Input) {
    this.setData({ phone: String(event.detail.value || "") });
  },

  onCodeInput(event: WechatMiniprogram.Input) {
    this.setData({ code: String(event.detail.value || "") });
  },

  async sendCode() {
    if (!this.data.phone) return this.setData({ message: "请输入手机号。" });
    this.setData({ sending: true, message: "" });
    try {
      await request("/api/auth/verification-codes", {
        method: "POST",
        auth: false,
        data: { targetType: "phone", target: this.data.phone, scene: "login" }
      });
      this.setData({ message: "验证码已发送，开发环境默认 867530。" });
    } catch (error) {
      this.setData({ message: (error as Error).message });
    } finally {
      this.setData({ sending: false });
    }
  },

  async login() {
    try {
      const data = await request<LoginResponse>("/api/auth/login/phone-code", {
        method: "POST",
        auth: false,
        data: { phone: this.data.phone, code: this.data.code }
      });
      saveSession(data);
      getApp<{ globalData: { user: User | null } }>().globalData.user = data.user;
      this.applyUser(data.user);
      this.setData({ message: "登录成功。" });
      await this.loadLatestTask();
    } catch (error) {
      this.setData({ message: (error as Error).message });
    }
  },

  async subscribePlan(event: WechatMiniprogram.TouchEvent) {
    if (!this.data.user) return this.setData({ message: "请先登录。" });
    try {
      const planCode = event.currentTarget.dataset.code;
      const data = await request<{ user: User }>("/api/memberships/subscribe", {
        method: "POST",
        data: { planCode }
      });
      saveSession({ user: data.user });
      getApp<{ globalData: { user: User | null } }>().globalData.user = data.user;
      this.applyUser(data.user);
      this.setData({ message: "积分已到账。" });
    } catch (error) {
      this.setData({ message: (error as Error).message });
    }
  },

  goCreate() {
    wx.switchTab({ url: "/pages/create/index" });
  },

  logout() {
    clearSession();
    getApp<{ globalData: { user: User | null } }>().globalData.user = null;
    this.applyUser(null);
    this.setData({ latestTaskStatus: "暂无", message: "已退出。" });
  }
});
