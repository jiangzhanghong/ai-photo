export const formatDate = (value?: string) => {
  if (!value) return "";
  const date = new Date(value);
  const pad = (num: number) => String(num).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

export const formatLatency = (ms?: number) => {
  const value = Number(ms || 0);
  if (!Number.isFinite(value) || value <= 0) return "";
  if (value < 1000) return `${value}ms`;
  if (value < 60000) return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1).replace(/\.0$/, "")}秒`;
  const minutes = Math.floor(value / 60000);
  const seconds = Math.round((value % 60000) / 1000);
  return `${minutes}分${seconds}秒`;
};

export const statusText = (status: string) => ({
  queued: "排队中",
  processing: "生成中",
  succeeded: "已完成",
  failed: "失败"
}[status] || status);
