import { API_BASE_URL } from "./config";
import { clearSession, getAccessToken, getRefreshToken, saveSession } from "./session";

type Method = "GET" | "POST" | "PATCH" | "DELETE";

interface RequestOptions {
  method?: Method;
  data?: Record<string, unknown>;
  auth?: boolean;
}

const normalizeUrl = (path: string) => `${API_BASE_URL}${path}`;

const rawRequest = <T>(path: string, options: RequestOptions = {}): Promise<T> => new Promise((resolve, reject) => {
  const token = getAccessToken();
  wx.request({
    url: normalizeUrl(path),
    method: options.method || "GET",
    data: options.data || {},
    header: {
      "Content-Type": "application/json",
      ...(options.auth !== false && token ? { Authorization: `Bearer ${token}` } : {})
    },
    success: (response) => {
      const data = response.data as { message?: string };
      if (response.statusCode >= 200 && response.statusCode < 300) {
        resolve(response.data as T);
        return;
      }
      reject(new Error(data?.message || `请求失败：${response.statusCode}`));
    },
    fail: () => reject(new Error("网络请求失败。"))
  });
});

export const request = async <T>(path: string, options: RequestOptions = {}): Promise<T> => {
  try {
    return await rawRequest<T>(path, options);
  } catch (error) {
    const refreshToken = getRefreshToken();
    if (!refreshToken || options.auth === false) throw error;
    try {
      const refreshed = await rawRequest<{ accessToken: string; refreshToken: string; user: any }>("/api/auth/token/refresh", {
        method: "POST",
        auth: false,
        data: { refreshToken }
      });
      saveSession(refreshed);
      return await rawRequest<T>(path, options);
    } catch {
      clearSession();
      throw error;
    }
  }
};
