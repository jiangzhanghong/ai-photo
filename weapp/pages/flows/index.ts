import type { CreditTransaction, User } from "../../types/api";
import { requireLogin } from "../../utils/auth";
import { formatDate } from "../../utils/format";
import { request } from "../../utils/request";
import { getStoredUser } from "../../utils/session";
import { getDisplayCredits } from "../../utils/showcase";
import { syncCurrentUser } from "../../utils/user";

interface FlowRecord {
  id: string;
  title: string;
  createdLabel: string;
  amountLabel: string;
  creditsLabel: string;
  statusLabel: string;
  type: "income" | "expense";
}

const transactionTitle = (transaction: CreditTransaction) => {
  if (transaction.transactionType === "task_spend") return "AI 写真生成";
  if (transaction.transactionType === "task_refund") return "生成失败退回";
  if (transaction.transactionType === "admin_adjust") return "后台积分调整";
  return transaction.remark || "积分变动";
};

const transactionStatus = (transaction: CreditTransaction) => {
  if (transaction.transactionType === "task_refund") return "已退回";
  if (transaction.transactionType === "task_spend") return "已扣除";
  return "已入账";
};

const toFlowRecord = (transaction: CreditTransaction): FlowRecord => {
  const amount = Number(transaction.amount || 0);
  return {
    id: transaction.id,
    title: transactionTitle(transaction),
    createdLabel: formatDate(transaction.createdAt),
    amountLabel: transaction.remark || transaction.relatedType || "积分账户",
    creditsLabel: `${amount > 0 ? "+" : ""}${amount} 积分`,
    statusLabel: transactionStatus(transaction),
    type: amount >= 0 ? "income" : "expense"
  };
};

Page({
  data: {
    user: null as User | null,
    needsLogin: false,
    creditBalance: 0,
    records: [] as FlowRecord[],
    loading: false
  },

  async onShow() {
    if (!requireLogin("/pages/flows/index")) return;
    await this.refreshFlows();
  },

  async onPullDownRefresh() {
    await this.refreshFlows();
    wx.stopPullDownRefresh();
  },

  async refreshFlows() {
    const cachedUser = getStoredUser();
    this.setData({
      user: cachedUser,
      needsLogin: !cachedUser,
      creditBalance: getDisplayCredits(cachedUser),
      loading: Boolean(cachedUser)
    });
    if (!cachedUser) return;

    const user = await syncCurrentUser();
    if (!user) {
      this.setData({
        user: null,
        needsLogin: true,
        creditBalance: 0,
        records: [],
        loading: false
      });
      return;
    }

    try {
      const data = await request<{ transactions: CreditTransaction[] }>("/api/credit-transactions");
      this.setData({
        user,
        needsLogin: false,
        creditBalance: getDisplayCredits(user),
        records: (data.transactions || []).map(toFlowRecord),
        loading: false
      });
    } catch {
      this.setData({
        user,
        needsLogin: false,
        creditBalance: getDisplayCredits(user),
        records: [],
        loading: false
      });
    }
  },

  goLogin() {
    wx.switchTab({ url: "/pages/profile/index" });
  }
});
