import type { MediaImage } from "../types/api";
import { absoluteUrl } from "./config";
import { request } from "./request";

const dedupe = (urls: string[]) => Array.from(new Set(urls.filter(Boolean)));

export const resolveImageUrls = async (urls: string[], auth = true) => {
  const unique = dedupe(urls);
  if (!unique.length) return new Map<string, string>();
  const map = new Map<string, string>();
  const batchSize = 9;
  for (let index = 0; index < unique.length; index += batchSize) {
    const batch = unique.slice(index, index + batchSize);
    try {
      const data = await request<{ urls: string[] }>("/api/downloads/direct-urls", {
        method: "POST",
        data: { imageUrls: batch },
        auth
      });
      batch.forEach((url, offset) => {
        map.set(url, data.urls[offset] || absoluteUrl(url));
      });
    } catch {
      batch.forEach((url) => {
        map.set(url, absoluteUrl(url));
      });
    }
  }
  return map;
};

export const resolveMediaImages = async (images: MediaImage[], auth = true) => {
  const urls = dedupe(images.flatMap((item) => [item.originalUrl, item.previewUrl, item.thumbUrl]));
  const resolved = await resolveImageUrls(urls, auth);
  return images.map((item) => ({
    ...item,
    originalUrl: resolved.get(item.originalUrl) || absoluteUrl(item.originalUrl),
    previewUrl: resolved.get(item.previewUrl) || absoluteUrl(item.previewUrl),
    thumbUrl: resolved.get(item.thumbUrl) || absoluteUrl(item.thumbUrl),
    compressedUrl: resolved.get(item.previewUrl || item.compressedUrl || "") || absoluteUrl(item.previewUrl || item.compressedUrl || item.thumbUrl)
  }));
};

export const normalizeMediaImage = (item?: Partial<MediaImage> | null, fallback = ""): MediaImage | null => {
  const originalUrl = String(item?.originalUrl || fallback || "").trim();
  const previewUrl = String(item?.previewUrl || item?.compressedUrl || originalUrl).trim();
  const thumbUrl = String(item?.thumbUrl || previewUrl || originalUrl).trim();
  if (!originalUrl && !previewUrl && !thumbUrl) return null;
  return {
    assetId: item?.assetId,
    originalUrl: originalUrl || previewUrl || thumbUrl,
    previewUrl: previewUrl || originalUrl || thumbUrl,
    thumbUrl: thumbUrl || previewUrl || originalUrl,
    compressedUrl: previewUrl || originalUrl || thumbUrl
  };
};
