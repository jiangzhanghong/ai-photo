// Real-device debugging and release builds must use a domain configured in
// the Mini Program request/download legal domain list.
const REMOTE_API_BASE_URL = "http://114.132.185.231:8000";

export const API_BASE_URL = REMOTE_API_BASE_URL;

export const MAX_REFERENCE_IMAGES = 5;

export const absoluteUrl = (url = "") => {
  if (!url) return "";
  if (/^https?:\/\//.test(url) || url.startsWith("data:")) return url;
  return `${API_BASE_URL}${url.startsWith("/") ? url : `/${url}`}`;
};
