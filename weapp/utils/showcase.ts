import type { Prompt, Task, User } from "../types/api";
import { absoluteUrl } from "./config";
import { formatDate, statusText } from "./format";

export interface ShowcaseTemplate {
  id: string;
  promptId?: string;
  title: string;
  subtitle: string;
  imageUrl: string;
  creditCost: number;
  category: string;
  badge?: string;
  promptText: string;
}

export interface ShowcaseWork {
  id: string;
  taskId?: string;
  title: string;
  imageUrl: string;
  createdLabel: string;
  ratio: string;
  creditCost: number;
  filter: "all" | "saved" | "pending";
  buttonText?: string;
}

export interface WalletPackage {
  id: string;
  priceLabel: string;
  creditsLabel: string;
  bonusLabel: string;
}

export interface WalletRecord {
  id: string;
  title: string;
  createdLabel: string;
  amountLabel: string;
  creditsLabel: string;
  statusLabel: string;
}

export interface ProfileAction {
  key: string;
  label: string;
  value?: string;
  iconText?: string;
}

export interface SelectedTemplatePayload {
  id: string;
  promptId?: string;
  title: string;
  subtitle: string;
  imageUrl: string;
  creditCost: number;
  promptText: string;
}

export const TEMPLATE_STORAGE_KEY = "ai_photo_selected_template";

const localImages = {
  avatar: "/assets/demo/avatar.jpg",
  campus: "/assets/demo/recent-1.jpg",
  sea: "/assets/demo/recent-2.jpg",
  flower: "/assets/demo/recent-3.jpg",
  hat: "/assets/demo/recent-4.jpg",
  refA: "/assets/demo/ref-1.jpg",
  refB: "/assets/demo/ref-2.jpg",
  refC: "/assets/demo/ref-3.jpg"
};

const fallbackTemplates: ShowcaseTemplate[] = [
  {
    id: "local-campus-light",
    title: "校园光影",
    subtitle: "在校生的青春纪念册",
    imageUrl: localImages.campus,
    creditCost: 2,
    category: "校园",
    badge: "推荐",
    promptText: "校园写真，阳光感，清新自然，人物微笑，浅景深，真实皮肤质感，高级人像摄影"
  },
  {
    id: "local-sea-diary",
    title: "海边日记",
    subtitle: "与海风的浪漫邂逅",
    imageUrl: localImages.sea,
    creditCost: 3,
    category: "日常",
    badge: "NEW",
    promptText: "海边写真，通透光线，少女侧脸，柔和肤色，胶片氛围，高级写真"
  },
  {
    id: "local-vintage",
    title: "法式复古",
    subtitle: "浪漫胶片氛围感",
    imageUrl: localImages.flower,
    creditCost: 2,
    category: "复古",
    badge: "HOT",
    promptText: "法式复古写真，柔和阴影，奶油色调，花束道具，电影感人像，高级氛围"
  },
  {
    id: "local-daily",
    title: "纪实日常",
    subtitle: "生活中的温柔瞬间",
    imageUrl: localImages.hat,
    creditCost: 1,
    category: "日常",
    promptText: "日常纪实写真，自然抓拍，轻松姿态，暖色阳光，生活感，高级审美"
  },
  {
    id: "local-film",
    title: "胶片写真",
    subtitle: "颗粒感与情绪光线",
    imageUrl: localImages.refA,
    creditCost: 2,
    category: "胶片",
    promptText: "胶片写真，细腻颗粒，低饱和度，故事感构图，人像电影感"
  },
  {
    id: "local-korean",
    title: "韩系清新",
    subtitle: "轻透妆感与空气感",
    imageUrl: localImages.refB,
    creditCost: 2,
    category: "韩系",
    promptText: "韩系写真，清透肤感，空气刘海，柔焦背景，明亮人像，韩杂风格"
  },
  {
    id: "local-birthday",
    title: "生日写真",
    subtitle: "少女感庆生氛围照",
    imageUrl: localImages.refC,
    creditCost: 3,
    category: "清新",
    promptText: "生日写真，少女氛围，奶油色布景，柔光人像，精致妆容，庆生仪式感"
  }
];

const fallbackWorks: ShowcaseWork[] = [
  {
    id: "demo-work-1",
    title: "法式复古",
    imageUrl: localImages.flower,
    createdLabel: "2024-05-20 14:30",
    ratio: "3:4",
    creditCost: 2,
    filter: "all"
  },
  {
    id: "demo-work-2",
    title: "海边日记",
    imageUrl: localImages.sea,
    createdLabel: "2024-05-19 18:45",
    ratio: "9:16",
    creditCost: 3,
    filter: "saved"
  },
  {
    id: "demo-work-3",
    title: "校园光影",
    imageUrl: localImages.campus,
    createdLabel: "2024-05-18 10:22",
    ratio: "1:1",
    creditCost: 2,
    filter: "saved"
  },
  {
    id: "demo-work-4",
    title: "纪实日常",
    imageUrl: localImages.hat,
    createdLabel: "2024-05-17 16:30",
    ratio: "3:4",
    creditCost: 1,
    filter: "pending",
    buttonText: "查看详情"
  },
  {
    id: "demo-work-5",
    title: "韩系清新",
    imageUrl: localImages.refB,
    createdLabel: "2024-05-16 20:18",
    ratio: "3:4",
    creditCost: 2,
    filter: "saved"
  },
  {
    id: "demo-work-6",
    title: "胶片写真",
    imageUrl: localImages.refA,
    createdLabel: "2024-05-15 09:12",
    ratio: "2:3",
    creditCost: 2,
    filter: "all",
    buttonText: "再次生成"
  }
];

export const walletPackages: WalletPackage[] = [
  { id: "pkg-200", priceLabel: "9.9 元", creditsLabel: "200 积分", bonusLabel: "限时赠送 20 积分" },
  { id: "pkg-500", priceLabel: "19.9 元", creditsLabel: "500 积分", bonusLabel: "限时赠送 50 积分" },
  { id: "pkg-900", priceLabel: "29.9 元", creditsLabel: "900 积分", bonusLabel: "限时赠送 100 积分" }
];

export const walletRecords: WalletRecord[] = [
  {
    id: "record-500",
    title: "积分充值 500 积分",
    createdLabel: "2024-05-20 14:32",
    amountLabel: "19.9 元",
    creditsLabel: "+500 积分",
    statusLabel: "支付成功"
  },
  {
    id: "record-200",
    title: "积分充值 200 积分",
    createdLabel: "2024-05-18 11:20",
    amountLabel: "9.9 元",
    creditsLabel: "+200 积分",
    statusLabel: "支付成功"
  }
];

export const profileActions: ProfileAction[] = [
  { key: "recharge", label: "充值积分" },
  { key: "orders", label: "订单" },
  { key: "flows", label: "流水" },
  { key: "bindWechat", label: "绑定微信" },
  { key: "protocol", label: "用户协议" },
  { key: "privacy", label: "隐私政策" },
  { key: "contact", label: "联系我们" },
  { key: "logout", label: "退出登录" }
];

const normalizeCategory = (value = "") => {
  const text = value.toLowerCase();
  if (text.includes("校园")) return "校园";
  if (text.includes("复古") || text.includes("法式")) return "复古";
  if (text.includes("胶片")) return "胶片";
  if (text.includes("韩")) return "韩系";
  if (text.includes("清新")) return "清新";
  return "日常";
};

const promptImage = (prompt: Prompt) => {
  const image = prompt.exampleImages?.[0]?.previewUrl
    || prompt.exampleImages?.[0]?.compressedUrl
    || prompt.exampleImageUrl
    || prompt.resultImageUrl
    || "";
  return image ? absoluteUrl(image) : localImages.campus;
};

export const getFallbackTemplates = () => fallbackTemplates.slice();

export const getFallbackWorks = () => fallbackWorks.slice();

export const toShowcaseTemplates = (prompts: Prompt[]) => {
  if (!prompts.length) return getFallbackTemplates();
  return prompts.map((prompt, index) => ({
    id: prompt.id,
    promptId: prompt.id,
    title: prompt.title || `模板 ${index + 1}`,
    subtitle: prompt.scene || prompt.categoryTags?.[0] || "多风格写真模板",
    imageUrl: promptImage(prompt),
    creditCost: Number(prompt.creditCost || 0),
    category: normalizeCategory(`${prompt.scene} ${prompt.categoryTags?.join(" ")} ${prompt.title}`),
    badge: index === 0 ? "推荐" : (index === 1 ? "NEW" : ""),
    promptText: prompt.userDescription || prompt.promptPreview || prompt.title
  }));
};

const taskCover = (task: Task) => {
  const image = task.resultImages?.[0]?.previewUrl
    || task.resultImages?.[0]?.thumbUrl
    || task.resultImageUrls?.[0]
    || task.inputImages?.[0]?.previewUrl
    || task.inputImages?.[0]?.thumbUrl
    || task.inputImageUrls?.[0]
    || task.inputImageUrl
    || "";
  return image ? absoluteUrl(image) : localImages.campus;
};

const ratioFromSize = (size = "") => {
  if (/^\d+:\d+$/.test(size)) return size;
  const match = String(size).match(/^(\d+)x(\d+)$/);
  if (!match) return "3:4";
  const width = Number(match[1]);
  const height = Number(match[2]);
  const ratio = width / height;
  const known = [
    { label: "1:1", value: 1 },
    { label: "3:4", value: 3 / 4 },
    { label: "2:3", value: 2 / 3 },
    { label: "9:16", value: 9 / 16 },
    { label: "16:9", value: 16 / 9 }
  ];
  return known.reduce((best, item) => (
    Math.abs(item.value - ratio) < Math.abs(best.value - ratio) ? item : best
  )).label;
};

export const toShowcaseWorks = (tasks: Task[]) => {
  if (!tasks.length) return getFallbackWorks();
  return tasks.map((task, index) => ({
    id: task.id,
    taskId: task.id,
    title: task.promptTitle || `作品 ${index + 1}`,
    imageUrl: taskCover(task),
    createdLabel: formatDate(task.createdAt) || "刚刚生成",
    ratio: ratioFromSize(task.size),
    creditCost: Number(task.creditCost || 0),
    filter: task.status === "succeeded" ? (index % 2 === 0 ? "saved" : "all") : "pending",
    buttonText: task.status === "succeeded" && index === 0 ? "查看详情" : ""
  }));
};

export const getDisplayCredits = (user?: User | null) => Number(user?.credits || 0);

export const getDisplayName = (user?: User | null) => user?.nickname || "立即登录";

export const getDisplayAvatar = (user?: User | null) => {
  if (user?.avatarUrl) return absoluteUrl(user.avatarUrl);
  return localImages.avatar;
};

export const getWechatBindingLabel = (user?: User | null) => {
  if (!user) return "去登录";
  return user.username ? "账号登录" : "微信登录";
};

export const getCumulativeSpend = (tasks: Task[]) => tasks.reduce((sum, item) => sum + Number(item.creditCost || 0), 0);

export const getCumulativeRecharge = (user: User | null | undefined, tasks: Task[]) => {
  if (!user) return 0;
  const credits = getDisplayCredits(user);
  const spent = getCumulativeSpend(tasks);
  return credits + spent;
};

export const selectedTemplatePayload = (template: ShowcaseTemplate): SelectedTemplatePayload => ({
  id: template.id,
  promptId: template.promptId,
  title: template.title,
  subtitle: template.subtitle,
  imageUrl: template.imageUrl,
  creditCost: template.creditCost,
  promptText: template.promptText
});

export const saveSelectedTemplate = (template: SelectedTemplatePayload) => {
  wx.setStorageSync(TEMPLATE_STORAGE_KEY, template);
};

export const getSelectedTemplate = (): SelectedTemplatePayload | null => {
  return wx.getStorageSync(TEMPLATE_STORAGE_KEY) as SelectedTemplatePayload || null;
};

export const clearSelectedTemplate = () => {
  wx.removeStorageSync(TEMPLATE_STORAGE_KEY);
};

export const workFilterTabs = [
  { key: "all", label: "全部" },
  { key: "saved", label: "已保存" },
  { key: "pending", label: "待下载" }
] as const;

export const templateFilterTabs = ["推荐", "校园", "日常", "胶片", "复古", "清新", "韩系"] as const;

export const statusLabel = (status: string) => statusText(status);
