import type { User } from "../types/api";
import { isUnauthorizedError, request } from "./request";
import { clearSession, getStoredUser, saveSession } from "./session";

export const syncCurrentUser = async (): Promise<User | null> => {
  const cached = getStoredUser();
  if (!cached) return null;
  try {
    const data = await request<{ user: User }>("/api/auth/me");
    saveSession({ user: data.user });
    getApp<{ globalData: { user: User | null } }>().globalData.user = data.user;
    return data.user;
  } catch (error) {
    if (isUnauthorizedError(error)) {
      clearSession();
      getApp<{ globalData: { user: User | null } }>().globalData.user = null;
      return null;
    }
    return cached;
  }
};
