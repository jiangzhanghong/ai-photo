// DevTools can use localhost when domain checks are disabled.
// Real-device debugging and release builds must use an HTTPS domain
// configured in the Mini Program request/download legal domain list.
export const API_BASE_URL = "http://127.0.0.1:8000";

export const MAX_REFERENCE_IMAGES = 5;

export const absoluteUrl = (url = "") => {
  if (!url) return "";
  if (/^https?:\/\//.test(url) || url.startsWith("data:")) return url;
  return `${API_BASE_URL}${url.startsWith("/") ? url : `/${url}`}`;
};
