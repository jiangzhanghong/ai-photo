import type { User } from "../types/api";

const ACCESS_TOKEN_KEY = "ai_photo_access_token";
const REFRESH_TOKEN_KEY = "ai_photo_refresh_token";
const USER_KEY = "ai_photo_user";

export const getAccessToken = () => wx.getStorageSync(ACCESS_TOKEN_KEY) as string || "";

export const getRefreshToken = () => wx.getStorageSync(REFRESH_TOKEN_KEY) as string || "";

export const getStoredUser = (): User | null => {
  return wx.getStorageSync(USER_KEY) as User || null;
};

export const hasStoredSession = () => Boolean(getStoredUser() || getAccessToken() || getRefreshToken());

export const saveSession = (payload: { accessToken?: string; refreshToken?: string; user?: User }) => {
  if (payload.accessToken) wx.setStorageSync(ACCESS_TOKEN_KEY, payload.accessToken);
  if (payload.refreshToken) wx.setStorageSync(REFRESH_TOKEN_KEY, payload.refreshToken);
  if (payload.user) wx.setStorageSync(USER_KEY, payload.user);
};

export const clearSession = () => {
  wx.removeStorageSync(ACCESS_TOKEN_KEY);
  wx.removeStorageSync(REFRESH_TOKEN_KEY);
  wx.removeStorageSync(USER_KEY);
};
