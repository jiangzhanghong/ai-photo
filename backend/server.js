const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const net = require("net");
const path = require("path");
const COS = require("cos-nodejs-sdk-v5");
const mysql = require("mysql2/promise");
const sharp = require("sharp");
const { URL } = require("url");

const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.PORT || 8000);
const ACCESS_EXPIRES_SECONDS = 60 * 60 * 2;
const REFRESH_EXPIRES_SECONDS = 60 * 60 * 24 * 30;
const VERIFICATION_CODE_EXPIRES_MS = 10 * 60 * 1000;
const ADMIN_ACCESS_EXPIRES_SECONDS = 60 * 60 * 8;
const MEDIA_ACCESS_URL_EXPIRES_SECONDS = Number(process.env.MEDIA_SIGNED_URL_EXPIRES_SECONDS || 60 * 10);
const MEDIA_PREVIEW_MAX_SIDE = 1920;
const MEDIA_THUMB_MAX_SIDE = 384;

const loadEnvFile = (file) => {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const text = line.trim();
    if (!text || text.startsWith("#")) continue;
    const index = text.indexOf("=");
    if (index < 0) continue;
    const key = text.slice(0, index).trim();
    let value = text.slice(index + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!process.env[key]) process.env[key] = value;
  }
};

loadEnvFile("/etc/ai-photo.env");

const JWT_SECRET = process.env.jwt_secret || "dev-jwt-secret";
const ADMIN_ACCOUNT = process.env.admin_account || "13342860028";
const ADMIN_PASSWORD = process.env.admin_password || "Sk8er&boi";
const MODEL_SECRET = crypto.createHash("sha256").update(process.env.model_secret_key || JWT_SECRET).digest();
const OBJECT_STORAGE = {
  secretId: process.env.TENCENTCLOUD_SECRET_ID || process.env.COS_SECRET_ID || process.env.lhcos_secret_id || "",
  secretKey: process.env.TENCENTCLOUD_SECRET_KEY || process.env.COS_SECRET_KEY || process.env.lhcos_secret_key || "",
  securityToken: process.env.TENCENTCLOUD_TOKEN || process.env.COS_SECURITY_TOKEN || process.env.lhcos_security_token || "",
  bucket: process.env.LHCOS_BUCKET || process.env.COS_BUCKET || process.env.lhcos_bucket || "",
  region: process.env.LHCOS_REGION || process.env.COS_REGION || process.env.lhcos_region || "",
  publicBaseUrl: (process.env.LHCOS_PUBLIC_BASE_URL || process.env.COS_PUBLIC_BASE_URL || process.env.lhcos_public_base_url || "").replace(/\/+$/, ""),
  uploadPrefix: (process.env.LHCOS_UPLOAD_PREFIX || process.env.COS_UPLOAD_PREFIX || process.env.lhcos_upload_prefix || "member-images").replace(/^\/+|\/+$/g, ""),
  signedUrls: String(process.env.LHCOS_SIGNED_URLS || process.env.COS_SIGNED_URLS || process.env.lhcos_signed_urls || "true") !== "false",
  signedUrlExpiresSeconds: Number(process.env.LHCOS_SIGNED_URL_EXPIRES_SECONDS || process.env.COS_SIGNED_URL_EXPIRES_SECONDS || process.env.lhcos_signed_url_expires_seconds || 60 * 60 * 2)
};

const nowIso = () => new Date().toISOString();
const mysqlDateTime = (date = new Date()) => date.toISOString().slice(0, 19).replace("T", " ");
const mysqlDateTimeMs = (value) => value instanceof Date ? value.getTime() : new Date(`${String(value).replace(" ", "T")}Z`).getTime();
const uid = (prefix) => `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
const sha256 = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");
const jsonParse = (value, fallback) => {
  if (value == null || value === "") return fallback;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};
const jsonText = (value) => JSON.stringify(value ?? null);
const toIso = (value) => value instanceof Date ? value.toISOString() : value;
const maskSecret = (value) => {
  if (!value) return "";
  if (value.length <= 8) return "****";
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
};
const isGptImageModel = (model) => {
  const provider = String(model?.provider || "").trim().toLowerCase();
  const code = String(model?.model_code || model?.modelCode || "").trim().toLowerCase();
  const baseUrl = String(model?.base_url || model?.baseUrl || "").trim().toLowerCase();
  return provider === "openai"
    || baseUrl.includes("api.openai.com")
    || code.includes("gpt-image")
    || code.includes("chatgpt-image");
};
const isSeedreamModel = (model) => {
  const code = String(model?.model_code || model?.modelCode || "").trim().toLowerCase();
  return code.includes("seedream");
};
const parseImageSize = (size) => {
  const match = String(size || "").trim().match(/^(\d+)x(\d+)$/);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return { width, height, pixels: width * height, ratio: width / height };
};
const isValidExactImageSize = (size) => {
  const parsed = parseImageSize(size);
  return Boolean(parsed && parsed.pixels >= 3686400 && parsed.pixels <= 16777216 && parsed.ratio >= 1 / 16 && parsed.ratio <= 16);
};
const normalizeImageRatio = (ratio, size) => {
  const value = String(ratio || "").trim();
  if (value === "adaptive" || value === "auto") return "adaptive";
  if (/^\d+:\d+$/.test(value)) return value;
  const parsed = parseImageSize(size);
  if (!parsed) return String(size || "").trim() === "4K" ? "adaptive" : "1:1";
  const knownRatios = [
    ["1:1", 1],
    ["3:4", 3 / 4],
    ["4:3", 4 / 3],
    ["16:9", 16 / 9],
    ["9:16", 9 / 16],
    ["2:3", 2 / 3],
    ["3:2", 3 / 2],
    ["21:9", 21 / 9]
  ];
  return knownRatios.reduce((best, item) => {
    const diff = Math.abs(parsed.ratio - item[1]);
    return diff < best.diff ? { ratio: item[0], diff } : best;
  }, { ratio: "1:1", diff: Infinity }).ratio;
};
const recommended2kSizes = {
  "1:1": "2048x2048",
  "4:3": "2304x1728",
  "3:4": "1728x2304",
  "16:9": "2848x1600",
  "9:16": "1600x2848",
  "3:2": "2496x1664",
  "2:3": "1664x2496",
  "21:9": "3136x1344"
};
const recommended4kSizes = {
  "1:1": "4096x4096",
  "3:4": "3520x4704",
  "4:3": "4704x3520",
  "16:9": "5504x3040",
  "9:16": "3040x5504",
  "2:3": "3328x4992",
  "3:2": "4992x3328",
  "21:9": "6240x2656"
};
const imagePromptDefaultParams = {
  "img2img-campus-comic": { styleStrength: 0.65, ratio: "3:4", resolution: "2K", size: recommended2kSizes["3:4"] },
  "img2img-campus-romance": { styleStrength: 0.55, ratio: "3:4", resolution: "4K", size: recommended4kSizes["3:4"] },
  "img2img-campus-portrait": { styleStrength: 0.5, ratio: "3:4", resolution: "2K", size: recommended2kSizes["3:4"] },
  "img2img-campus-id": { styleStrength: 0.45, ratio: "1:1", resolution: "2K", size: recommended2kSizes["1:1"] },
  "img2img-campus-group": { styleStrength: 0.5, ratio: "16:9", resolution: "4K", size: recommended4kSizes["16:9"] },
  "img2img-campus-film": { styleStrength: 0.6, ratio: "2:3", resolution: "2K", size: recommended2kSizes["2:3"] },
  "img2img-campus-uniform": { styleStrength: 0.5, ratio: "3:4", resolution: "2K", size: recommended2kSizes["3:4"] },
  "img2img-campus-night": { styleStrength: 0.55, ratio: "16:9", resolution: "4K", size: recommended4kSizes["16:9"] },
  "img2img-campus-polaroid": { styleStrength: 0.6, ratio: "1:1", resolution: "2K", size: recommended2kSizes["1:1"] },
  "img2img-campus-future": { styleStrength: 0.5, ratio: "3:2", resolution: "4K", size: recommended4kSizes["3:2"] }
};
const normalizeImageSize = (size, model) => {
  const requestedSize = String(size || "").trim();
  if (isGptImageModel(model)) {
    const map = {
      "2K": "1024x1024",
      "4K": "1024x1024",
      "1:1": "1024x1024",
      "auto": "1024x1024",
      "3:4": "1024x1536",
      "4:3": "1536x1024",
      "16:9": "1536x1024",
      "9:16": "1024x1536",
      "2:3": "1024x1536",
      "3:2": "1536x1024",
      "21:9": "1536x1024",
      "2048x2048": "1024x1024",
      "1728x2304": "1024x1536",
      "2560x1440": "1536x1024"
    };
    if (map[requestedSize]) return map[requestedSize];
    const parsed = parseImageSize(requestedSize);
    if (!parsed) return "1024x1024";
    if (parsed.ratio > 1.2) return "1536x1024";
    if (parsed.ratio < 0.83) return "1024x1536";
    return "1024x1024";
  }
  if (requestedSize === "2K" || requestedSize === "4K") return requestedSize;
  if (recommended2kSizes[requestedSize]) return recommended2kSizes[requestedSize];
  if (requestedSize === "auto") return "2K";
  return isValidExactImageSize(requestedSize) ? requestedSize : "2048x2048";
};
const sanitizeImageParams = (model, params) => {
  const sanitized = { ...(params || {}) };
  if (isGptImageModel(model)) delete sanitized.response_format;
  return sanitized;
};
const syncImagePromptDefaults = async () => {
  for (const [id, params] of Object.entries(imagePromptDefaultParams)) {
    await db.exec(
      "UPDATE prompt_templates SET default_params_json = ?, updated_at = NOW() WHERE id = ? AND task_type = 'image_to_image'",
      [jsonText(params), id]
    );
  }
};

const encrypt = (value) => {
  if (!value) return "";
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", MODEL_SECRET, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}.${tag.toString("base64")}.${encrypted.toString("base64")}`;
};

const decrypt = (value) => {
  if (!value) return "";
  const [ivText, tagText, encryptedText] = String(value).split(".");
  const decipher = crypto.createDecipheriv("aes-256-gcm", MODEL_SECRET, Buffer.from(ivText, "base64"));
  decipher.setAuthTag(Buffer.from(tagText, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(encryptedText, "base64")), decipher.final()]).toString("utf8");
};

const pool = mysql.createPool({
  host: process.env.mysql_host || "127.0.0.1",
  port: Number(process.env.mysql_port || 3306),
  user: process.env.mysql_user || "root",
  password: process.env.mysql_password || "",
  database: process.env.mysql_database || "aiphoto",
  waitForConnections: true,
  connectionLimit: 10,
  namedPlaceholders: true,
  timezone: "Z"
});

const db = {
  query: async (sql, params = []) => {
    const [rows] = await pool.query(sql, params);
    return rows;
  },
  exec: async (sql, params = []) => {
    const [result] = await pool.execute(sql, params);
    return result;
  }
};

class RefreshStore {
  constructor() {
    this.memory = new Map();
    this.addr = process.env.redis_addr || "";
    this.password = process.env.redis_password || "";
    this.redisDisabled = !this.addr;
  }

  command(args) {
    const payload = args.map((arg) => {
      const text = String(arg);
      return `$${Buffer.byteLength(text)}\r\n${text}\r\n`;
    }).join("");
    return `*${args.length}\r\n${payload}`;
  }

  async redisCommand(args) {
    if (this.redisDisabled) throw new Error("Redis is not configured");
    const [host, portText] = this.addr.split(":");
    const port = Number(portText || 6379);
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host, port });
      let data = "";
      const fail = (error) => {
        socket.destroy();
        reject(error);
      };
      socket.setTimeout(3000, () => fail(new Error("Redis timeout")));
      socket.on("error", fail);
      socket.on("data", (chunk) => { data += chunk.toString("utf8"); });
      socket.on("end", () => resolve(data));
      socket.on("connect", () => {
        if (this.password) socket.write(this.command(["AUTH", this.password]));
        socket.write(this.command(args));
        socket.end();
      });
    });
  }

  parseBulk(response) {
    const chunks = response.split("\r\n");
    const index = chunks.findLastIndex((line) => line.startsWith("$"));
    if (index < 0 || chunks[index] === "$-1") return null;
    return chunks[index + 1] || null;
  }

  parseArray(response) {
    return response.split("\r\n").filter((line) => line.startsWith("auth:refresh:"));
  }

  async set(key, value, seconds) {
    if (!this.redisDisabled) {
      try {
        await this.redisCommand(["SET", key, JSON.stringify(value), "EX", seconds]);
        return;
      } catch (error) {
        this.redisDisabled = true;
        console.warn(`[backend] Redis unavailable, falling back to memory refresh store: ${error.message}`);
      }
    }
    this.memory.set(key, { value, expiresAt: Date.now() + seconds * 1000 });
  }

  async get(key) {
    if (!this.redisDisabled) {
      try {
        const response = await this.redisCommand(["GET", key]);
        const text = this.parseBulk(response);
        return text ? JSON.parse(text) : null;
      } catch (error) {
        this.redisDisabled = true;
        console.warn(`[backend] Redis unavailable, falling back to memory refresh store: ${error.message}`);
      }
    }
    const item = this.memory.get(key);
    if (!item) return null;
    if (item.expiresAt < Date.now()) {
      this.memory.delete(key);
      return null;
    }
    return item.value;
  }

  async del(key) {
    if (!this.redisDisabled) {
      try {
        await this.redisCommand(["DEL", key]);
        return;
      } catch (error) {
        this.redisDisabled = true;
        console.warn(`[backend] Redis unavailable, falling back to memory refresh store: ${error.message}`);
      }
    }
    this.memory.delete(key);
  }

  async revokeUser(userId) {
    if (!this.redisDisabled) {
      try {
        const response = await this.redisCommand(["KEYS", "auth:refresh:*"]);
        for (const key of this.parseArray(response)) {
          const value = await this.get(key);
          if (value?.userId === userId) await this.del(key);
        }
        return;
      } catch (error) {
        this.redisDisabled = true;
        console.warn(`[backend] Redis unavailable, falling back to memory refresh store: ${error.message}`);
      }
    }
    for (const [key, item] of this.memory.entries()) {
      if (item.value?.userId === userId) this.memory.delete(key);
    }
  }
}

const refreshStore = new RefreshStore();

const base64url = (input) => Buffer.from(input).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
const decodeBase64url = (input) => {
  const token = String(input || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = token.padEnd(token.length + ((4 - token.length % 4) % 4), "=");
  return Buffer.from(padded, "base64").toString("utf8");
};
const signJwt = (payload, seconds = ACCESS_EXPIRES_SECONDS) => {
  const header = { alg: "HS256", typ: "JWT" };
  const body = { ...payload, exp: Math.floor(Date.now() / 1000) + seconds };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(body))}`;
  const signature = crypto.createHmac("sha256", JWT_SECRET).update(unsigned).digest("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${unsigned}.${signature}`;
};

const verifyJwt = (token) => {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [header, body, signature] = parts;
    const expected = crypto.createHmac("sha256", JWT_SECRET).update(`${header}.${body}`).digest("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
    if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
    const payload = JSON.parse(Buffer.from(body.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
};

const hashPassword = (password, salt = crypto.randomBytes(16).toString("hex")) => {
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 32, "sha256").toString("hex");
  return `${salt}:${hash}`;
};

const verifyPassword = (password, stored) => {
  if (!stored || !stored.includes(":")) return false;
  const [salt] = stored.split(":");
  return hashPassword(password, salt) === stored;
};

const validatePassword = (phone, password) => {
  if (typeof password !== "string" || password.length < 8 || password.length > 32) return "密码长度需要为 8-32 位。";
  if (password.trim() !== password) return "密码不能包含首尾空格。";
  const groups = [/[a-z]/, /[A-Z]/, /\d/, /[^a-zA-Z0-9]/].filter((regex) => regex.test(password)).length;
  if (groups < 3) return "密码需至少包含大小写字母、数字、特殊字符中的 3 类。";
  if (phone && password.includes(String(phone).slice(-6))) return "密码不能包含手机号后 6 位。";
  return "";
};

const constantTimeEqual = (left, right) => {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
};

const json = (res, status, body) => {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS"
  });
  res.end(JSON.stringify(body));
};

const readBody = async (req) => new Promise((resolve, reject) => {
  let data = "";
  req.on("data", (chunk) => {
    data += chunk;
    if (data.length > 1024 * 1024 * 25) reject(new Error("Payload too large"));
  });
  req.on("end", () => {
    if (!data) return resolve({});
    try {
      resolve(JSON.parse(data));
    } catch {
      reject(new Error("Invalid JSON body"));
    }
  });
});

const publicUrl = (req, pathname) => {
  const proto = req.headers["x-forwarded-proto"] || "http";
  const host = req.headers.host || `localhost:${PORT}`;
  return `${proto}://${host}${pathname}`;
};

let objectStorageClient;

const isObjectStorageConfigured = () => Boolean(
  OBJECT_STORAGE.secretId
  && OBJECT_STORAGE.secretKey
  && OBJECT_STORAGE.bucket
  && OBJECT_STORAGE.region
);

const requireObjectStorageConfig = () => {
  if (!isObjectStorageConfigured()) {
    throw new Error("轻量对象存储未配置，请设置 TENCENTCLOUD_SECRET_ID、TENCENTCLOUD_SECRET_KEY、LHCOS_BUCKET 和 LHCOS_REGION。");
  }
  return OBJECT_STORAGE;
};

const objectStorageHost = (config = OBJECT_STORAGE) => `${config.bucket}.cos.${config.region}.myqcloud.com`;

const getObjectStorageClient = () => {
  const config = requireObjectStorageConfig();
  if (!objectStorageClient) {
    objectStorageClient = new COS({
      SecretId: config.secretId,
      SecretKey: config.secretKey,
      SecurityToken: config.securityToken || undefined,
      Protocol: "https:"
    });
  }
  return objectStorageClient;
};

const imageExtensionFromMime = (mime) => {
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  return "jpg";
};

const imageMimeFromSharpFormat = (format, fallback = "image/jpeg") => {
  const value = String(format || "").toLowerCase();
  if (value === "png") return "image/png";
  if (value === "webp") return "image/webp";
  if (value === "jpeg" || value === "jpg") return "image/jpeg";
  return fallback;
};

const imageExtensionFromSharpFormat = (format, fallback = "jpg") => {
  const mime = imageMimeFromSharpFormat(format, imageMimeFromSharpFormat(fallback));
  return imageExtensionFromMime(mime);
};

const mediaUrl = (assetId, variant = "original") => `/api/media/${encodeURIComponent(assetId)}/${variant}`;

const mediaUrlParts = (pathname) => {
  const match = String(pathname || "").match(/^\/api\/media\/([^/]+)\/(original|preview|thumb)$/);
  if (!match) return null;
  return {
    assetId: decodeURIComponent(match[1]),
    variant: match[2]
  };
};

const decodeImageDataUrl = (imageData) => {
  const match = String(imageData || "").match(/^data:(image\/(?:jpeg|jpg|png|webp));base64,([a-zA-Z0-9+/=]+)$/);
  if (!match) throw new Error("图片数据格式无效。");
  const mime = match[1] === "image/jpg" ? "image/jpeg" : match[1];
  return { mime, buffer: Buffer.from(match[2], "base64") };
};

const objectKey = (prefix, ext) => {
  const safePrefix = String(prefix || OBJECT_STORAGE.uploadPrefix).replace(/^\/+|\/+$/g, "") || "member-images";
  const date = new Date().toISOString().slice(0, 10);
  return `${safePrefix}/${date}/${Date.now()}-${crypto.randomBytes(8).toString("hex")}.${ext}`;
};

const objectStorageImagePath = (key) => `/api/storage-images/${base64url(key)}`;

const objectStorageKeyFromApiPath = (pathname) => {
  const match = String(pathname || "").match(/^\/api\/storage-images\/([^/]+)$/);
  if (!match) return "";
  try {
    return decodeBase64url(match[1]);
  } catch {
    return "";
  }
};

const getObjectStorageUrl = async (key, options = {}) => {
  const config = requireObjectStorageConfig();
  if (!config.signedUrls) {
    const baseUrl = config.publicBaseUrl || `https://${objectStorageHost(config)}`;
    return `${baseUrl}/${key.split("/").map(encodeURIComponent).join("/")}`;
  }
  const client = getObjectStorageClient();
  const data = await new Promise((resolve, reject) => {
    client.getObjectUrl({
      Bucket: config.bucket,
      Region: config.region,
      Key: key,
      Sign: true,
      Expires: Math.max(60, Number(options.expiresSeconds || config.signedUrlExpiresSeconds))
    }, (err, result) => err ? reject(err) : resolve(result));
  });
  return data.Url;
};

const objectStorageKeyFromUrl = (rawUrl) => {
  if (!isObjectStorageConfigured()) return "";
  let parsed;
  try {
    parsed = new URL(String(rawUrl || ""));
  } catch {
    return "";
  }
  const hosts = new Set([objectStorageHost()]);
  let basePath = "";
  if (OBJECT_STORAGE.publicBaseUrl) {
    try {
      const base = new URL(OBJECT_STORAGE.publicBaseUrl);
      hosts.add(base.host);
      basePath = base.pathname.replace(/\/+$/, "");
    } catch {
      basePath = "";
    }
  }
  if (!hosts.has(parsed.host)) return "";
  const pathname = decodeURIComponent(parsed.pathname);
  if (basePath && pathname.startsWith(`${basePath}/`)) return pathname.slice(basePath.length + 1);
  return pathname.replace(/^\/+/, "");
};

const stableImageUrl = (rawUrl) => {
  const value = String(rawUrl || "").trim();
  if (!value) return "";
  try {
    const pathname = new URL(value, "http://localhost").pathname;
    if (mediaUrlParts(pathname) || objectStorageKeyFromApiPath(pathname)) return value;
  } catch {
    return value;
  }
  const key = objectStorageKeyFromUrl(value);
  return key ? objectStorageImagePath(key) : value;
};

const getMediaAsset = async (assetId) => {
  const rows = await db.query("SELECT * FROM media_assets WHERE id = ? LIMIT 1", [assetId]);
  return rows[0] || null;
};

const canAccessMediaAsset = ({ asset, userId = "", isAdmin = false }) => {
  if (!asset) return false;
  if (asset.visibility === "public") return true;
  if (isAdmin) return true;
  return asset.owner_type === "user" && userId && asset.owner_id === userId;
};

const mediaVariantObjectKey = (asset, variant) => {
  if (variant === "thumb") return asset.thumb_object_key || asset.preview_object_key || asset.original_object_key || "";
  if (variant === "preview") return asset.preview_object_key || asset.original_object_key || "";
  return asset.original_object_key || asset.preview_object_key || asset.thumb_object_key || "";
};

const signedMediaVariantUrl = async (asset, variant, options = {}) => {
  const key = mediaVariantObjectKey(asset, variant);
  if (!key) throw new Error("图片文件不存在。");
  return getObjectStorageUrl(key, { expiresSeconds: options.expiresSeconds || MEDIA_ACCESS_URL_EXPIRES_SECONDS });
};

const directImageUrl = async (rawUrl, req = null, options = {}) => {
  const value = String(rawUrl || "").trim();
  if (!value || value.startsWith("data:")) return value;
  const imageUrl = new URL(value, req ? publicUrl(req, "/") : "http://localhost");
  const media = mediaUrlParts(imageUrl.pathname);
  if (media) {
    const asset = await getMediaAsset(media.assetId);
    if (!asset) throw new Error("图片不存在。");
    if (!options.bypassMediaAuth && !canAccessMediaAsset({
      asset,
      userId: options.viewerUserId || "",
      isAdmin: Boolean(options.viewerIsAdmin)
    })) {
      throw new Error("无权访问图片。");
    }
    return signedMediaVariantUrl(asset, media.variant, options);
  }
  const apiStorageKey = objectStorageKeyFromApiPath(imageUrl.pathname);
  if (apiStorageKey) return getObjectStorageUrl(apiStorageKey, { expiresSeconds: options.expiresSeconds || MEDIA_ACCESS_URL_EXPIRES_SECONDS });
  const storageKey = objectStorageKeyFromUrl(imageUrl.href);
  if (storageKey) return getObjectStorageUrl(storageKey, { expiresSeconds: options.expiresSeconds || MEDIA_ACCESS_URL_EXPIRES_SECONDS });
  return imageUrl.href;
};

const excerpt = (value, length = 100) => {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > length ? `${text.slice(0, length)}...` : text;
};

const quarterText = (value) => {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.slice(0, Math.max(1, Math.ceil(text.length / 4)));
};

const loadObjectStorageImage = async (key) => {
  const config = requireObjectStorageConfig();
  const data = await getObjectStorageClient().getObject({
    Bucket: config.bucket,
    Region: config.region,
    Key: key
  });
  return {
    data: data.Body,
    contentType: data.headers?.["content-type"] || ""
  };
};

const imageMetadataFromBuffer = async (buffer, fallbackMime = "image/jpeg") => {
  const metadata = await sharp(buffer, { failOn: "none" }).metadata();
  return {
    width: Number(metadata.width || 0),
    height: Number(metadata.height || 0),
    mime: imageMimeFromSharpFormat(metadata.format, fallbackMime),
    ext: imageExtensionFromSharpFormat(metadata.format, imageExtensionFromMime(fallbackMime)),
    format: metadata.format || ""
  };
};

const mediaPreviewBuffer = async (buffer, maxSide, quality) => sharp(buffer, { failOn: "none" })
  .rotate()
  .resize({
    width: maxSide,
    height: maxSide,
    fit: "inside",
    withoutEnlargement: true
  })
  .webp({ quality })
  .toBuffer();

const createMediaAssetFromBuffer = async ({
  buffer,
  fallbackMime = "image/jpeg",
  ownerType = "user",
  ownerId = "",
  visibility = "private",
  prefix = "media-assets",
  originalFilename = ""
}) => {
  const originalMeta = await imageMetadataFromBuffer(buffer, fallbackMime);
  const previewBuffer = await mediaPreviewBuffer(buffer, MEDIA_PREVIEW_MAX_SIDE, 82);
  const thumbBuffer = await mediaPreviewBuffer(buffer, MEDIA_THUMB_MAX_SIDE, 72);
  const id = uid("media");
  const assetPrefix = `${String(prefix || "media-assets").replace(/^\/+|\/+$/g, "")}/${id}`;
  const originalKey = objectKey(`${assetPrefix}/original`, originalMeta.ext);
  const previewKey = objectKey(`${assetPrefix}/preview`, "webp");
  const thumbKey = objectKey(`${assetPrefix}/thumb`, "webp");
  const sha = sha256(buffer);

  const client = getObjectStorageClient();
  const config = requireObjectStorageConfig();
  await client.putObject({
    Bucket: config.bucket,
    Region: config.region,
    Key: originalKey,
    Body: buffer,
    ContentLength: buffer.length,
    ContentType: originalMeta.mime,
    StorageClass: "DEFAULT"
  });
  await client.putObject({
    Bucket: config.bucket,
    Region: config.region,
    Key: previewKey,
    Body: previewBuffer,
    ContentLength: previewBuffer.length,
    ContentType: "image/webp",
    StorageClass: "DEFAULT"
  });
  await client.putObject({
    Bucket: config.bucket,
    Region: config.region,
    Key: thumbKey,
    Body: thumbBuffer,
    ContentLength: thumbBuffer.length,
    ContentType: "image/webp",
    StorageClass: "DEFAULT"
  });

  await db.exec(
    `INSERT INTO media_assets
      (id, owner_type, owner_id, visibility, original_filename, mime_type, width, height, file_size, sha256, original_object_key, preview_object_key, thumb_object_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
    [
      id,
      String(ownerType || "user").slice(0, 40),
      String(ownerId || "").slice(0, 80),
      visibility === "public" ? "public" : "private",
      String(originalFilename || "").slice(0, 255),
      originalMeta.mime,
      originalMeta.width || null,
      originalMeta.height || null,
      buffer.length,
      sha,
      originalKey,
      previewKey,
      thumbKey
    ]
  );

  return (await db.query("SELECT * FROM media_assets WHERE id = ? LIMIT 1", [id]))[0];
};

const mediaItemFromAsset = (asset) => {
  if (!asset?.id) return null;
  return {
    assetId: asset.id,
    originalUrl: mediaUrl(asset.id, "original"),
    previewUrl: mediaUrl(asset.id, "preview"),
    thumbUrl: mediaUrl(asset.id, "thumb"),
    compressedUrl: mediaUrl(asset.id, "preview")
  };
};

const createMediaAssetFromDataUrl = async (imageData, options = {}) => {
  const { mime, buffer } = decodeImageDataUrl(imageData);
  const maxSize = options.maxSize || 5 * 1024 * 1024;
  if (buffer.length > maxSize) throw new Error(`图片不能超过 ${Math.round(maxSize / 1024 / 1024)}MB。`);
  return createMediaAssetFromBuffer({
    buffer,
    fallbackMime: mime,
    ownerType: options.ownerType || "user",
    ownerId: options.ownerId || "",
    visibility: options.visibility || "private",
    prefix: options.prefix || OBJECT_STORAGE.uploadPrefix,
    originalFilename: options.originalFilename || ""
  });
};

const normalizeReferenceImageUrls = (body) => {
  const items = []
    .concat(Array.isArray(body.inputImages) ? body.inputImages : [])
    .concat(Array.isArray(body.inputImageUrls) ? body.inputImageUrls : [])
    .concat(body.inputImageUrl ? [body.inputImageUrl] : [])
    .map(normalizeMediaItem)
    .filter(Boolean);
  const seen = new Set();
  return items.filter((item) => {
    const key = item.assetId || item.originalUrl || item.previewUrl || item.thumbUrl;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 5);
};

const requireAdmin = (req) => {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const payload = token ? verifyJwt(token) : null;
  return payload?.type === "admin" && payload?.sub === ADMIN_ACCOUNT ? payload : null;
};
const requireUser = async (req) => {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const payload = token ? verifyJwt(token) : null;
  if (!payload?.sub) return null;
  const rows = await db.query("SELECT * FROM users WHERE id = ? AND status <> 'disabled' LIMIT 1", [payload.sub]);
  return rows[0] || null;
};

const publicUser = async (user) => {
  const memberships = await db.query("SELECT * FROM user_memberships WHERE user_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1", [user.id]);
  const membership = memberships[0];
  return {
    id: user.id,
    username: user.username || "",
    phone: user.phone,
    nickname: user.nickname,
    avatarUrl: user.avatar_url || "",
    avatarSource: user.avatar_source || "",
    credits: Number(user.credits || 0),
    status: user.status || "active",
    preferredAiModelId: user.preferred_ai_model_id || "",
    membership: membership ? {
      id: membership.id,
      planId: membership.plan_id,
      planName: membership.plan_name,
      status: membership.status,
      expiresAt: toIso(membership.expires_at)
    } : null
  };
};

const issueTokens = async (user, req) => {
  const accessToken = signJwt({ sub: user.id, type: "access" });
  const refreshToken = crypto.randomBytes(32).toString("hex");
  await refreshStore.set(`auth:refresh:${sha256(refreshToken)}`, {
    userId: user.id,
    ip: req.socket.remoteAddress,
    userAgent: req.headers["user-agent"] || "",
    status: "active",
    createdAt: nowIso()
  }, REFRESH_EXPIRES_SECONDS);
  return { accessToken, refreshToken, expiresIn: ACCESS_EXPIRES_SECONDS };
};

const normalizePhone = (value) => String(value || "").replace(/\D/g, "");
const validatePhone = (phone) => /^1[3-9]\d{9}$/.test(phone);
const normalizeUsername = (value) => String(value || "").trim().replace(/\s+/g, "");
const validateUsername = (username) => username.length >= 3 ? "" : "账号至少 3 位。";
const validateSimplePassword = (password) => String(password || "").trim().length >= 6 ? "" : "密码至少 6 位。";

const consumeCode = async (target, scene, code) => {
  const rows = await db.query("SELECT * FROM verification_codes WHERE target = ? AND scene = ? AND used_at IS NULL ORDER BY created_at DESC LIMIT 1", [target, scene]);
  const item = rows[0];
  if (!item) return "验证码不存在。";
  const expiresAt = mysqlDateTimeMs(item.expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return "验证码已过期。";
  if (item.failed_attempts >= 5) return "验证码错误次数过多。";
  if (item.code_hash !== sha256(String(code))) {
    await db.exec("UPDATE verification_codes SET failed_attempts = failed_attempts + 1 WHERE id = ?", [item.id]);
    return "验证码错误。";
  }
  await db.exec("UPDATE verification_codes SET used_at = ? WHERE id = ?", [mysqlDateTime(), item.id]);
  return "";
};

const getOrCreatePhoneUser = async (phone) => {
  const rows = await db.query("SELECT * FROM users WHERE phone = ? LIMIT 1", [phone]);
  if (rows[0]) return rows[0];
  const id = uid("user");
  await db.exec(
    "INSERT INTO users (id, phone, nickname, phone_verified_at, status, credits, created_at, updated_at) VALUES (?, ?, ?, NOW(), 'active', 0, NOW(), NOW())",
    [id, phone, `用户${phone.slice(-4)}`]
  );
  return (await db.query("SELECT * FROM users WHERE id = ?", [id]))[0];
};

const getUserByUsername = async (username) => {
  const rows = await db.query("SELECT * FROM users WHERE username = ? LIMIT 1", [username]);
  return rows[0] || null;
};

const getOrCreateWechatUser = async ({ openid, unionid = "", nickname = "", avatarUrl = "" }) => {
  const cleanOpenid = String(openid || "").trim();
  const cleanUnionid = String(unionid || "").trim();
  const cleanNickname = String(nickname || "").trim().slice(0, 120);
  const cleanAvatarUrl = String(avatarUrl || "").trim().slice(0, 500);
  if (!cleanOpenid) throw new Error("微信用户标识缺失。");

  const byOpenid = await db.query("SELECT * FROM users WHERE wechat_openid = ? LIMIT 1", [cleanOpenid]);
  let user = byOpenid[0];

  if (!user && cleanUnionid) {
    const byUnionid = await db.query("SELECT * FROM users WHERE wechat_unionid = ? LIMIT 1", [cleanUnionid]);
    user = byUnionid[0];
  }

  if (!user) {
    const id = uid("user");
    await db.exec(
      `INSERT INTO users (id, nickname, wechat_openid, wechat_unionid, avatar_url, avatar_source, status, credits, created_at, updated_at, last_login_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', 0, NOW(), NOW(), NOW())`,
      [id, cleanNickname || `微信用户${cleanOpenid.slice(-6)}`, cleanOpenid, cleanUnionid || null, cleanAvatarUrl || null, cleanAvatarUrl ? "wechat" : null]
    );
    return (await db.query("SELECT * FROM users WHERE id = ? LIMIT 1", [id]))[0];
  }

  await db.exec(
    `UPDATE users
     SET wechat_openid = ?,
         wechat_unionid = CASE WHEN ? <> '' THEN ? ELSE wechat_unionid END,
         nickname = CASE WHEN ? <> '' THEN ? ELSE nickname END,
         avatar_url = CASE WHEN ? <> '' AND COALESCE(avatar_source, '') <> 'custom' THEN ? ELSE avatar_url END,
         avatar_source = CASE WHEN ? <> '' AND COALESCE(avatar_source, '') <> 'custom' THEN 'wechat' ELSE avatar_source END,
         last_login_at = NOW(),
         updated_at = NOW()
     WHERE id = ?`,
    [cleanOpenid, cleanUnionid, cleanUnionid, cleanNickname, cleanNickname, cleanAvatarUrl, cleanAvatarUrl, cleanAvatarUrl, user.id]
  );
  return (await db.query("SELECT * FROM users WHERE id = ? LIMIT 1", [user.id]))[0];
};

const planDto = (plan) => ({
  id: plan.id,
  code: plan.code,
  name: plan.name,
  version: plan.version,
  price: Number(plan.price),
  suffix: plan.suffix,
  credits: Number(plan.credits),
  quota: Number(plan.quota),
  features: jsonParse(plan.features_json, []),
  durationDays: Number(plan.duration_days),
  isActive: Boolean(plan.is_active),
  sortOrder: Number(plan.sort_order || 0)
});

const modelDto = (model, includeSensitive = false) => {
  const dto = {
    id: model.id,
    provider: model.provider,
    name: model.name,
    modelCode: model.model_code,
    baseUrl: includeSensitive ? model.base_url : undefined,
    apiKeyMasked: includeSensitive ? model.api_key_masked : undefined,
    authType: includeSensitive ? model.auth_type : undefined,
    supportedTaskTypes: jsonParse(model.supported_task_types_json, []),
    defaultSize: model.default_size,
    defaultParams: includeSensitive ? jsonParse(model.default_params_json, {}) : undefined,
    creditCost: jsonParse(model.credit_cost_config_json, {}),
    creditCostConfig: jsonParse(model.credit_cost_config_json, {}),
    costConfig: includeSensitive ? jsonParse(model.cost_config_json, {}) : undefined,
    timeoutSeconds: Math.max(300, Number(model.timeout_seconds || 300)),
    retryLimit: Number(model.retry_limit || 0),
    lastTestStatus: model.last_test_status || "",
    lastTestMessage: model.last_test_message || "",
    lastTestAt: toIso(model.last_test_at),
    version: model.version,
    isDefault: Boolean(model.is_default),
    isActive: Boolean(model.is_active),
    remark: model.remark || ""
  };
  Object.keys(dto).forEach((key) => dto[key] === undefined && delete dto[key]);
  return dto;
};

const taskReferenceUrls = (task) => {
  const urls = jsonParse(task.input_image_urls_json, []);
  return Array.isArray(urls) && urls.length ? urls : (task.input_image_url ? [task.input_image_url] : []);
};

const normalizeMediaItem = (item) => {
  if (!item) return null;
  if (typeof item === "string") {
    const url = stableImageUrl(item);
    return url ? {
      originalUrl: url,
      previewUrl: url,
      thumbUrl: url,
      compressedUrl: url
    } : null;
  }
  const assetId = String(item.assetId || item.id || "").trim();
  const originalUrl = stableImageUrl(item.originalUrl || item.url || item.imageUrl || (assetId ? mediaUrl(assetId, "original") : ""));
  const previewUrl = stableImageUrl(item.previewUrl || item.compressedUrl || item.thumbnailUrl || originalUrl || (assetId ? mediaUrl(assetId, "preview") : ""));
  const thumbUrl = stableImageUrl(item.thumbUrl || item.thumbnailUrl || item.compressedUrl || previewUrl || originalUrl || (assetId ? mediaUrl(assetId, "thumb") : ""));
  if (!originalUrl && !previewUrl && !thumbUrl) return null;
  return {
    ...(assetId ? { assetId } : {}),
    originalUrl: originalUrl || previewUrl || thumbUrl,
    previewUrl: previewUrl || originalUrl || thumbUrl,
    thumbUrl: thumbUrl || previewUrl || originalUrl,
    compressedUrl: previewUrl || originalUrl || thumbUrl
  };
};

const mediaItemsFromValue = (value) => {
  const parsed = typeof value === "string" ? jsonParse(value, null) : value;
  const items = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === "object" ? [parsed] : (value ? [value] : []));
  return items.map(normalizeMediaItem).filter(Boolean);
};

const taskDto = (task) => {
  const inputImages = mediaItemsFromValue(taskReferenceUrls(task));
  const resultImages = mediaItemsFromValue(jsonParse(task.result_image_urls_json, []));
  return {
    id: task.id,
    taskNo: task.task_no,
    userId: task.user_id,
    userNickname: task.nickname || "",
    userPhone: task.phone || "",
    promptTemplateId: task.prompt_template_id,
    promptTitle: task.prompt_title,
    aiModelId: task.ai_model_id,
    aiModelName: task.ai_model_name,
    aiModelVersion: task.ai_model_version,
    taskType: task.task_type,
    status: task.status,
    creditCost: Number(task.credit_cost || 0),
    size: task.size,
    count: Number(task.count || 1),
    inputImageUrl: inputImages[0]?.previewUrl || stableImageUrl(task.input_image_url || ""),
    inputImageUrls: inputImages.map((item) => item.previewUrl).filter(Boolean),
    inputImages,
    userInstruction: task.user_instruction || "",
    resultImageUrls: resultImages.map((item) => item.previewUrl).filter(Boolean),
    resultImages,
    failureReason: task.failure_reason || "",
    providerRequestId: task.provider_request_id || "",
    providerLatencyMs: task.provider_latency_ms || null,
    providerErrorCode: task.provider_error_code || "",
    createdAt: toIso(task.created_at),
    updatedAt: toIso(task.updated_at)
  };
};

const creditTransactionDto = (transaction) => ({
  id: transaction.id,
  amount: Number(transaction.amount || 0),
  transactionType: transaction.transaction_type,
  relatedType: transaction.related_type || "",
  relatedId: transaction.related_id || "",
  remark: transaction.remark || "",
  createdAt: toIso(transaction.created_at)
});

const promptImageItems = (value) => {
  const text = String(value || "").trim();
  if (!text) return [];
  const parsed = jsonParse(text, null);
  const items = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === "object" ? [parsed] : [text]);
  return items.map(normalizeMediaItem).filter(Boolean);
};

const promptImagesText = (body) => {
  if (Array.isArray(body.exampleImages)) {
    return jsonText(body.exampleImages.map((item) => ({
      assetId: item.assetId || item.id || "",
      originalUrl: item.originalUrl || item.url || "",
      previewUrl: item.previewUrl || item.compressedUrl || item.originalUrl || item.url || "",
      thumbUrl: item.thumbUrl || item.thumbnailUrl || item.previewUrl || item.compressedUrl || item.originalUrl || item.url || "",
      compressedUrl: item.previewUrl || item.compressedUrl || item.originalUrl || item.url || ""
    })).filter((item) => item.originalUrl || item.compressedUrl));
  }
  const url = body.exampleImageUrl ?? body.resultImageUrl ?? "";
  return url ? String(url) : "";
};

const publicPromptDefaultParams = (raw) => {
  const params = jsonParse(raw, {});
  const defaults = {};
  if (params.ratio) defaults.ratio = String(params.ratio);
  if (params.size) defaults.size = String(params.size);
  if (params.resolution) defaults.resolution = String(params.resolution);
  return defaults;
};

const promptDto = (p, includeSensitive = false) => {
  const exampleImages = promptImageItems(p.result_image_url || "");
  const firstImage = exampleImages[0] || null;
  const dto = {
    id: p.id,
    title: p.title,
    taskType: p.task_type,
    scene: p.scene || "",
    userDescription: includeSensitive ? (p.user_description || "") : excerpt(p.prompt_content, 100),
    promptPreview: excerpt(p.prompt_content, 100),
    promptQuarter: quarterText(p.prompt_content),
    categoryTags: jsonParse(p.category_tags_json, []),
    variables: jsonParse(p.variables_json, []),
    creditCost: Number(p.credit_cost),
    exampleImageUrl: firstImage?.thumbUrl || firstImage?.previewUrl || "",
    resultImageUrl: firstImage?.originalUrl || "",
    exampleImages,
    defaultParams: includeSensitive ? jsonParse(p.default_params_json, {}) : publicPromptDefaultParams(p.default_params_json),
    sortOrder: Number(p.sort_order),
    isActive: Boolean(p.is_active),
    version: p.version,
    createdAt: toIso(p.created_at),
    updatedAt: toIso(p.updated_at)
  };
  if (includeSensitive) {
    dto.promptContent = p.prompt_content;
    dto.negativePrompt = p.negative_prompt || "";
  }
  return dto;
};

const normalizeVariables = (value) => {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return value.split(/[\n,，]/).map((item) => item.trim()).filter(Boolean).map((name) => ({ name }));
  return [];
};

const renderPromptText = ({ promptContent, variables = {}, userInstruction = "", negativePrompt = "" }) => {
  let text = String(promptContent || "");
  for (const [key, value] of Object.entries(variables || {})) {
    text = text.replaceAll(`{${key}}`, String(value ?? ""));
  }
  return [
    text,
    negativePrompt ? `反向提示词：${negativePrompt}` : "",
    userInstruction
  ].filter(Boolean).join("\n");
};

const insertPromptVersion = async (prompt) => {
  await db.exec(
    `INSERT INTO prompt_versions
    (id, prompt_template_id, version, title, task_type, scene, user_description, category_tags_json, variables_json, prompt_content, negative_prompt, default_params_json, credit_cost, result_image_url, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
    [
      uid("pver"),
      prompt.id,
      prompt.version,
      prompt.title,
      prompt.task_type,
      prompt.scene || "",
      prompt.user_description || "",
      prompt.category_tags_json || "[]",
      prompt.variables_json || "[]",
      prompt.prompt_content || "",
      prompt.negative_prompt || "",
      prompt.default_params_json || "{}",
      Number(prompt.credit_cost || 0),
      prompt.result_image_url || ""
    ]
  );
};

const nextPromptVersion = async (promptId) => {
  const [[row]] = await pool.query("SELECT COUNT(*) AS n FROM prompt_versions WHERE prompt_template_id = ?", [promptId]);
  const count = Number(row.n || 0);
  return `v${count ? count + 1 : 2}`;
};

const activeModels = async (taskType) => {
  const rows = await db.query("SELECT * FROM ai_models WHERE is_active = 1 ORDER BY is_default DESC, created_at ASC");
  return rows.filter((model) => !taskType || jsonParse(model.supported_task_types_json, []).includes(taskType));
};

const resolveModel = async (user, taskType, modelId) => {
  const models = await activeModels(taskType);
  return models.find((model) => model.id === modelId)
    || models.find((model) => model.id === user?.preferred_ai_model_id)
    || models.find((model) => model.is_default)
    || models.find((model) => model.provider === "doubao")
    || null;
};

const modelCost = (model, taskType, count) => {
  const config = jsonParse(model.credit_cost_config_json, {});
  return Number(config[taskType] || 0) * Math.max(1, Number(count || 1));
};

const modelAuthHeaders = (model, apiKey) => {
  if (model.auth_type === "header") return { "Authorization": `Bearer ${apiKey}`, "X-Api-Key": apiKey };
  return { "Authorization": `Bearer ${apiKey}` };
};

const promptWithImageCount = (prompt, count) => {
  const imageCount = Math.max(1, Math.min(9, Number(count || 1)));
  return imageCount > 1 ? `${prompt}\n请生成 ${imageCount} 张不同结果。` : prompt;
};

const buildImageModelRequest = ({ model, taskType, prompt, inputImageUrl, inputImageUrls = [], ratio, size, count, overrideParams = {} }) => {
  const baseUrl = String(model.base_url || "").replace(/\/+$/, "");
  if (!/^https:\/\//.test(baseUrl) && !/^http:\/\/127\.0\.0\.1/.test(baseUrl)) throw new Error("模型 baseUrl 必须是 https 地址。");
  const apiKey = decrypt(model.api_key_ciphertext);
  if (!apiKey) throw new Error("模型 apiKey 未配置。");
  const defaultParams = sanitizeImageParams(model, jsonParse(model.default_params_json, {}));
  const requestParams = sanitizeImageParams(model, overrideParams);
  delete defaultParams.size;
  delete defaultParams.ratio;
  delete defaultParams.resolution;
  delete requestParams.size;
  delete requestParams.ratio;
  delete requestParams.resolution;
  const body = {
    ...defaultParams,
    ...requestParams,
    model: model.model_code,
    prompt,
    ratio: normalizeImageRatio(ratio, size || model.default_size),
    size: normalizeImageSize(size || model.default_size, model),
    n: Math.max(1, Math.min(9, Number(count || 1)))
  };
  if (isGptImageModel(model)) {
    delete body.response_format;
    delete body.ratio;
  }
  if (isSeedreamModel(model)) {
    const imageCount = Math.max(1, Math.min(9, Number(count || 1)));
    delete body.n;
    body.sequential_image_generation = imageCount > 1 ? "auto" : "disabled";
    body.sequential_image_generation_options = { max_images: imageCount };
  }
  const referenceImages = (Array.isArray(inputImageUrls) ? inputImageUrls : [])
    .concat(inputImageUrl ? [inputImageUrl] : [])
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  const uniqueReferenceImages = Array.from(new Set(referenceImages)).slice(0, 5);
  if (["edit", "image_to_image"].includes(taskType) && uniqueReferenceImages.length) {
    body.image = uniqueReferenceImages.length === 1 ? uniqueReferenceImages[0] : uniqueReferenceImages;
  }
  return {
    url: `${baseUrl}/images/generations`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...modelAuthHeaders(model, apiKey)
    },
    body
  };
};

const shellQuote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;

const imageModelCurl = (request) => [
  `curl -X ${request.method} ${shellQuote(request.url)}`,
  ...Object.entries(request.headers).map(([key, value]) => `  -H ${shellQuote(`${key}: ${value}`)}`),
  `  --data-raw ${shellQuote(JSON.stringify(request.body, null, 2))}`
].join(" \\\n");

const callImageModel = async (payload) => {
  const request = buildImageModelRequest(payload);
  const { model } = payload;
  const controller = new AbortController();
  const timeoutSeconds = Math.max(300, Number(model.timeout_seconds || 300));
  const timeout = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
  const started = Date.now();
  try {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: controller.signal
    });
    const data = await response.json().catch(() => ({}));
    const latencyMs = Date.now() - started;
    if (!response.ok) {
      const error = new Error(data.error?.message || data.message || `模型调用失败：${response.status}`);
      error.statusCode = response.status;
      error.providerRequestId = response.headers.get("x-request-id") || data.id || "";
      error.providerErrorCode = data.error?.code || String(response.status);
      error.latencyMs = latencyMs;
      throw error;
    }
    const resultImageUrls = Array.isArray(data.data)
      ? data.data.map((item) => item.url || (item.b64_json ? `data:image/png;base64,${item.b64_json}` : "")).filter(Boolean)
      : [];
    return {
      success: true,
      latencyMs,
      providerStatusCode: response.status,
      providerRequestId: response.headers.get("x-request-id") || data.id || "",
      resultImageUrls,
      rawUsage: data.usage || null
    };
  } finally {
    clearTimeout(timeout);
  }
};

const processTask = async (taskId) => {
  const tasks = await db.query("SELECT * FROM ai_image_tasks WHERE id = ? LIMIT 1", [taskId]);
  const task = tasks[0];
  if (!task || task.status !== "queued") return;
  await db.exec("UPDATE ai_image_tasks SET status = 'processing', updated_at = NOW() WHERE id = ?", [taskId]);
  const [model] = await db.query("SELECT * FROM ai_models WHERE id = ? LIMIT 1", [task.ai_model_id]);
  try {
    const snapshot = jsonParse(task.prompt_snapshot_json, {});
    let text = snapshot.renderedPrompt || "";
    if (!text && task.prompt_template_id !== "custom") {
      const [prompt] = await db.query("SELECT * FROM prompt_templates WHERE id = ? LIMIT 1", [task.prompt_template_id]);
      text = [prompt?.prompt_content, task.user_instruction].filter(Boolean).join("\n");
    }
    if (!text) text = task.user_instruction || "";
    const expectedCount = Math.max(1, Math.min(9, Number(task.count || 1)));
    const inputImages = mediaItemsFromValue(taskReferenceUrls(task));
    const inputOriginalUrls = await Promise.all(inputImages.map((item) => directImageUrl(item.originalUrl || item.previewUrl || item.thumbUrl || "", null, { bypassMediaAuth: true })));
    const requestBase = {
      model,
      taskType: task.task_type,
      inputImageUrl: inputOriginalUrls[0] || "",
      inputImageUrls: inputOriginalUrls,
      ratio: snapshot.ratio,
      size: task.size,
      overrideParams: snapshot.defaultParams || {}
    };
    const result = await callImageModel({
      ...requestBase,
      prompt: promptWithImageCount(text, expectedCount),
      count: expectedCount
    });
    const requestIds = [result.providerRequestId].filter(Boolean);
    while (result.resultImageUrls.length < expectedCount) {
      const retry = await callImageModel({
        ...requestBase,
        prompt: promptWithImageCount(text, 1),
        count: 1
      });
      if (retry.providerRequestId) requestIds.push(retry.providerRequestId);
      result.latencyMs += retry.latencyMs || 0;
      result.resultImageUrls.push(...retry.resultImageUrls);
      if (!retry.resultImageUrls.length) break;
    }
    result.resultImageUrls = result.resultImageUrls.slice(0, expectedCount);
    result.resultImageUrls = await persistImageUrlsToMediaItems(result.resultImageUrls, {
      ownerType: "user",
      ownerId: task.user_id,
      visibility: "private",
      prefix: `ai-results/${taskId}`
    });
    await db.exec(
      "UPDATE ai_image_tasks SET status = 'succeeded', result_image_urls_json = ?, provider_request_id = ?, provider_status_code = ?, provider_latency_ms = ?, updated_at = NOW() WHERE id = ?",
      [jsonText(result.resultImageUrls), requestIds.join(","), result.providerStatusCode, result.latencyMs, taskId]
    );
  } catch (error) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.execute("UPDATE ai_image_tasks SET status = 'failed', failure_reason = ?, provider_request_id = ?, provider_status_code = ?, provider_latency_ms = ?, provider_error_code = ?, updated_at = NOW() WHERE id = ?", [
        error.message || "模型调用失败。",
        error.providerRequestId || "",
        error.statusCode || null,
        error.latencyMs || null,
        error.providerErrorCode || "",
        taskId
      ]);
      await conn.execute("UPDATE users SET credits = credits + ? WHERE id = ?", [task.credit_cost, task.user_id]);
      await conn.execute("INSERT INTO credit_transactions (id, user_id, amount, transaction_type, related_type, related_id, remark, created_at) VALUES (?, ?, ?, 'task_refund', 'ai_task', ?, ?, NOW())", [
        uid("credit"), task.user_id, task.credit_cost, task.id, "AI 任务失败自动退回积分"
      ]);
      await conn.commit();
    } catch (rollbackError) {
      await conn.rollback();
      console.error(rollbackError);
    } finally {
      conn.release();
    }
  }
};

const ensureSchema = async () => {
  const statements = [
    `CREATE TABLE IF NOT EXISTS users (
      id VARCHAR(40) PRIMARY KEY,
      username VARCHAR(64) UNIQUE,
      phone VARCHAR(32) UNIQUE,
      email VARCHAR(191) UNIQUE,
      nickname VARCHAR(120) NOT NULL,
      password_hash VARCHAR(255),
      phone_verified_at DATETIME,
      email_verified_at DATETIME,
      wechat_openid VARCHAR(191) UNIQUE,
      wechat_unionid VARCHAR(191),
      avatar_url VARCHAR(500),
      avatar_source VARCHAR(40),
      preferred_ai_model_id VARCHAR(40),
      credits INT NOT NULL DEFAULT 0,
      status VARCHAR(32) NOT NULL DEFAULT 'active',
      last_login_at DATETIME,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS verification_codes (
      id VARCHAR(40) PRIMARY KEY,
      target_type VARCHAR(20) NOT NULL,
      target VARCHAR(191) NOT NULL,
      scene VARCHAR(40) NOT NULL,
      code_hash VARCHAR(64) NOT NULL,
      expires_at DATETIME NOT NULL,
      used_at DATETIME,
      failed_attempts INT NOT NULL DEFAULT 0,
      ip VARCHAR(80),
      user_agent VARCHAR(500),
      created_at DATETIME NOT NULL,
      INDEX idx_target_scene_created (target_type, target, scene, created_at),
      INDEX idx_expires_at (expires_at)
    )`,
    `CREATE TABLE IF NOT EXISTS membership_plans (
      id VARCHAR(40) PRIMARY KEY,
      code VARCHAR(80) NOT NULL UNIQUE,
      name VARCHAR(120) NOT NULL,
      version VARCHAR(40) NOT NULL,
      price DECIMAL(10,2) NOT NULL DEFAULT 0,
      suffix VARCHAR(20) NOT NULL DEFAULT '元',
      credits INT NOT NULL DEFAULT 0,
      quota INT NOT NULL DEFAULT 0,
      duration_days INT NOT NULL DEFAULT 30,
      features_json TEXT NOT NULL,
      sort_order INT NOT NULL DEFAULT 0,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS user_memberships (
      id VARCHAR(40) PRIMARY KEY,
      user_id VARCHAR(40) NOT NULL,
      plan_id VARCHAR(40) NOT NULL,
      plan_name VARCHAR(120) NOT NULL,
      status VARCHAR(32) NOT NULL,
      started_at DATETIME NOT NULL,
      expires_at DATETIME NOT NULL,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL,
      INDEX idx_user_status (user_id, status)
    )`,
    `CREATE TABLE IF NOT EXISTS credit_transactions (
      id VARCHAR(40) PRIMARY KEY,
      user_id VARCHAR(40) NOT NULL,
      amount INT NOT NULL,
      transaction_type VARCHAR(40) NOT NULL,
      related_type VARCHAR(40),
      related_id VARCHAR(40),
      remark VARCHAR(500),
      created_at DATETIME NOT NULL,
      INDEX idx_user_created (user_id, created_at)
    )`,
    `CREATE TABLE IF NOT EXISTS media_assets (
      id VARCHAR(40) PRIMARY KEY,
      owner_type VARCHAR(40) NOT NULL,
      owner_id VARCHAR(80),
      visibility VARCHAR(20) NOT NULL DEFAULT 'private',
      original_filename VARCHAR(255),
      mime_type VARCHAR(120),
      width INT,
      height INT,
      file_size INT,
      sha256 CHAR(64),
      original_object_key VARCHAR(500) NOT NULL,
      preview_object_key VARCHAR(500),
      thumb_object_key VARCHAR(500),
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL,
      INDEX idx_owner_created (owner_type, owner_id, created_at),
      INDEX idx_visibility_created (visibility, created_at)
    )`,
    `CREATE TABLE IF NOT EXISTS prompt_templates (
      id VARCHAR(80) PRIMARY KEY,
      title VARCHAR(160) NOT NULL,
      task_type VARCHAR(40) NOT NULL,
      scene VARCHAR(80),
      user_description VARCHAR(500),
      category_tags_json TEXT,
      variables_json TEXT,
      prompt_content TEXT NOT NULL,
      negative_prompt TEXT,
      default_params_json TEXT,
      credit_cost INT NOT NULL DEFAULT 0,
      result_image_url TEXT,
      default_model_id VARCHAR(40),
      version VARCHAR(40) NOT NULL DEFAULT '2026.04',
      sort_order INT NOT NULL DEFAULT 0,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL,
      INDEX idx_task_active (task_type, is_active)
    )`,
    `CREATE TABLE IF NOT EXISTS prompt_versions (
      id VARCHAR(40) PRIMARY KEY,
      prompt_template_id VARCHAR(80) NOT NULL,
      version VARCHAR(40) NOT NULL,
      title VARCHAR(160) NOT NULL,
      task_type VARCHAR(40) NOT NULL,
      scene VARCHAR(80),
      user_description VARCHAR(500),
      category_tags_json TEXT,
      variables_json TEXT,
      prompt_content TEXT NOT NULL,
      negative_prompt TEXT,
      default_params_json TEXT,
      credit_cost INT NOT NULL DEFAULT 0,
      result_image_url TEXT,
      created_at DATETIME NOT NULL,
      INDEX idx_prompt_created (prompt_template_id, created_at)
    )`,
    `CREATE TABLE IF NOT EXISTS ai_models (
      id VARCHAR(40) PRIMARY KEY,
      provider VARCHAR(80) NOT NULL,
      name VARCHAR(160) NOT NULL,
      model_code VARCHAR(160) NOT NULL,
      base_url VARCHAR(500) NOT NULL,
      api_key_ciphertext TEXT,
      api_key_masked VARCHAR(80),
      auth_type VARCHAR(40) NOT NULL DEFAULT 'bearer',
      supported_task_types_json TEXT NOT NULL,
      default_size VARCHAR(40) NOT NULL DEFAULT '1024x1024',
      default_params_json TEXT NOT NULL,
      credit_cost_config_json TEXT NOT NULL,
      cost_config_json TEXT NOT NULL,
      test_payload_json TEXT,
      timeout_seconds INT NOT NULL DEFAULT 300,
      retry_limit INT NOT NULL DEFAULT 0,
      concurrency_limit INT NOT NULL DEFAULT 4,
      last_test_status VARCHAR(40),
      last_test_message VARCHAR(500),
      last_test_at DATETIME,
      version VARCHAR(80) NOT NULL,
      is_default TINYINT(1) NOT NULL DEFAULT 0,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      remark VARCHAR(500),
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL,
      UNIQUE KEY uniq_provider_model_version (provider, model_code, version),
      INDEX idx_active_default (is_active, is_default)
    )`,
    `CREATE TABLE IF NOT EXISTS ai_image_tasks (
      id VARCHAR(40) PRIMARY KEY,
      task_no VARCHAR(40) NOT NULL UNIQUE,
      user_id VARCHAR(40) NOT NULL,
      prompt_template_id VARCHAR(80) NOT NULL,
      prompt_title VARCHAR(160) NOT NULL,
      ai_model_id VARCHAR(40) NOT NULL,
      ai_model_name VARCHAR(160) NOT NULL,
      ai_model_version VARCHAR(80),
      task_type VARCHAR(40) NOT NULL,
      status VARCHAR(40) NOT NULL,
      credit_cost INT NOT NULL,
      size VARCHAR(40),
      count INT NOT NULL DEFAULT 1,
      input_image_url VARCHAR(500),
      input_image_urls_json TEXT,
      user_instruction TEXT,
      prompt_snapshot_json TEXT,
      result_image_urls_json TEXT,
      failure_reason VARCHAR(1000),
      provider_request_id VARCHAR(191),
      provider_status_code INT,
      provider_latency_ms INT,
      provider_error_code VARCHAR(120),
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL,
      INDEX idx_user_created (user_id, created_at),
      INDEX idx_status_created (status, created_at)
    )`,
    `CREATE TABLE IF NOT EXISTS prompt_test_results (
      id VARCHAR(40) PRIMARY KEY,
      prompt_template_id VARCHAR(80) NOT NULL,
      prompt_version VARCHAR(40),
      model_id VARCHAR(40) NOT NULL,
      model_name VARCHAR(160),
      task_type VARCHAR(40),
      variables_json TEXT,
      prompt_snapshot_json TEXT,
      input_image_url VARCHAR(500),
      size VARCHAR(40),
      count INT NOT NULL DEFAULT 1,
      success TINYINT(1) NOT NULL DEFAULT 0,
      latency_ms INT,
      provider_request_id VARCHAR(191),
      result_image_urls_json TEXT,
      error_message VARCHAR(1000),
      created_at DATETIME NOT NULL,
      INDEX idx_prompt_created (prompt_template_id, created_at)
    )`,
    `CREATE TABLE IF NOT EXISTS ai_model_test_logs (
      id VARCHAR(40) PRIMARY KEY,
      model_id VARCHAR(40) NOT NULL,
      admin_id VARCHAR(40),
      task_type VARCHAR(40),
      request_payload_snapshot TEXT,
      success TINYINT(1) NOT NULL DEFAULT 0,
      latency_ms INT,
      provider_request_id VARCHAR(191),
      result_image_urls_json TEXT,
      error_code VARCHAR(120),
      error_message VARCHAR(1000),
      created_at DATETIME NOT NULL,
      INDEX idx_model_created (model_id, created_at)
    )`
  ];
  for (const statement of statements) await db.exec(statement);

  const addColumnIfMissing = async (table, column, definition) => {
    const rows = await db.query(
      "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?",
      [table, column]
    );
    if (!rows.length) await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  };
  await addColumnIfMissing("prompt_templates", "user_description", "VARCHAR(500)");
  await addColumnIfMissing("prompt_templates", "category_tags_json", "TEXT");
  await addColumnIfMissing("prompt_templates", "variables_json", "TEXT");
  await addColumnIfMissing("prompt_templates", "default_params_json", "TEXT");
  await addColumnIfMissing("ai_image_tasks", "prompt_snapshot_json", "TEXT");
  await addColumnIfMissing("ai_image_tasks", "input_image_urls_json", "TEXT");
  await addColumnIfMissing("users", "username", "VARCHAR(64) UNIQUE");
  await addColumnIfMissing("users", "avatar_source", "VARCHAR(40)");
  await db.exec("UPDATE users SET avatar_source = 'wechat' WHERE (avatar_source IS NULL OR avatar_source = '') AND avatar_url IS NOT NULL AND avatar_url <> ''");
  const usersWithoutUsername = await db.query("SELECT id, phone FROM users WHERE username IS NULL OR username = ''");
  for (const user of usersWithoutUsername) {
    const fallback = user.phone ? `u${String(user.phone).slice(-6)}` : `user_${String(user.id).slice(-8)}`;
    let candidate = fallback;
    let suffix = 1;
    while (await getUserByUsername(candidate)) {
      candidate = `${fallback}_${suffix}`;
      suffix += 1;
    }
    await db.exec("UPDATE users SET username = ?, updated_at = NOW() WHERE id = ?", [candidate, user.id]);
  }
  await db.exec("UPDATE ai_models SET timeout_seconds = 300 WHERE timeout_seconds IS NULL OR timeout_seconds < 300");
  await db.exec("ALTER TABLE prompt_templates MODIFY COLUMN result_image_url TEXT");
  await db.exec("ALTER TABLE prompt_versions MODIFY COLUMN result_image_url TEXT");
};

const seedData = async () => {
  const plans = [
    ["plan_free", "free", "免费方案", "v2026.04", 0, "元", 20, 4, 30, ["赠送 20 积分", "可生成 4 张图片"], 1],
    ["plan_standard", "standard", "标准版", "v2026.04", 9.9, "元", 80, 16, 30, ["赠送 80 积分", "可生成 16 张图片"], 2],
    ["plan_premium", "premium", "高级版", "v2026.04", 19.9, "元", 180, 36, 30, ["赠送 180 积分", "可生成 36 张图片"], 3],
    ["plan_custom", "custom", "定制版", "v2026.04", 99, "元起", 500, 100, 30, ["定制积分额度", "商业项目支持"], 4]
  ];
  for (const plan of plans) {
    await db.exec(`INSERT INTO membership_plans
      (id, code, name, version, price, suffix, credits, quota, duration_days, features_json, sort_order, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NOW(), NOW())
      ON DUPLICATE KEY UPDATE name = VALUES(name), version = VALUES(version), price = VALUES(price), suffix = VALUES(suffix), credits = VALUES(credits), quota = VALUES(quota), duration_days = VALUES(duration_days), features_json = VALUES(features_json), sort_order = VALUES(sort_order), updated_at = NOW()`,
      [...plan.slice(0, 9), jsonText(plan[9]), plan[10]]
    );
  }

  if (String(process.env.SEED_DEFAULT_PROMPTS || "false") === "true") {
  const prompts = [
    ["generate-cinematic-portrait", "电影感写真生成", "generate", "写真", "适合个人头像、社媒写真和宣传照。", "生成电影感人像写真，柔和布光，高级色彩，真实摄影质感，主体清晰，背景有浅景深。", "", ["subject", "style", "background"], ["写真", "人像"], {}, 5, "./assets/style-cinematic.jpg", 1],
    ["generate-product-poster", "商品商业海报", "generate", "商品", "适合电商主图、详情页和品牌内容配图。", "生成高端商品商业海报，干净背景，柔和棚拍光，突出产品材质和品牌质感，适合电商主图。", "", ["subject", "background", "lighting"], ["商品", "商业"], {}, 6, "./assets/work-still.jpg", 2],
    ["generate-travel-poster", "旅行目的地海报", "generate", "旅行", "适合目的地推广、社媒封面和活动视觉。", "生成旅行目的地海报，明亮自然光，开阔构图，真实摄影质感，适合社媒宣传。", "", ["place", "season", "composition"], ["旅行", "海报"], {}, 6, "./assets/work-sunset.jpg", 3],
    ["generate-vintage-magazine", "复古杂志封面", "generate", "品牌", "适合品牌杂志感视觉和活动封面。", "生成复古杂志封面风格图片，胶片色彩，精致排版感，商业摄影质感，画面高级。", "", ["subject", "style", "color"], ["复古", "杂志"], {}, 7, "./assets/style-vintage.jpg", 4],
    ["generate-minimal-lifestyle", "极简生活方式图", "generate", "生活方式", "适合干净克制的品牌配图。", "生成极简生活方式摄影，留白充足，色彩克制，柔和自然光，适合品牌内容配图。", "", ["subject", "background", "ratio"], ["极简", "生活方式"], {}, 5, "./assets/style-minimal.jpg", 5],
    ["generate-chinese-new-year", "节日营销主视觉", "generate", "营销", "适合节日活动海报和社媒宣传。", "生成节日营销主视觉，氛围热烈但不过度堆砌，主体突出，适合活动海报和社媒封面。", "", ["festival", "subject", "color"], ["节日", "营销"], {}, 7, "./assets/cta-clean.jpg", 6],
    ["edit-portrait-retouch", "人像自然精修", "edit", "人像", "适合证件照、头像和写真原片精修。", "基于上传人像做自然精修，保留身份特征，优化肤色、光线、皮肤瑕疵和背景质感，不要过度磨皮。", "过度磨皮，五官变形，塑料肤质", ["retouch_level", "background"], ["修图", "人像"], {}, 8, "./assets/work-portrait.jpg", 1],
    ["edit-product-clean", "商品白底优化", "edit", "商品", "适合商品图清洁、白底化和商业质感增强。", "基于上传商品图优化为干净商业白底效果，增强主体清晰度、边缘质感和真实材质。", "产品外观改变，文字变形，错误商标", ["background", "lighting"], ["商品", "修图"], {}, 10, "./assets/work-still.jpg", 2],
    ["edit-background-replace", "背景替换优化", "edit", "通用", "适合保留主体并替换为更干净的背景。", "保持主体不变，将背景替换为干净、有层次的商业摄影背景，光影方向与主体一致。", "主体变形，边缘破损，光影不一致", ["background", "lighting"], ["换背景", "修图"], {}, 9, "./assets/work-girl.jpg", 3],
    ["edit-color-grade", "高级调色增强", "edit", "调色", "适合提升通透感、对比度和整体影调。", "保持原图内容和构图，进行高级调色，提升通透感、对比度和质感，避免过饱和。", "过饱和，肤色偏色，失真", ["color_style", "contrast"], ["调色", "修图"], {}, 7, "./assets/work-bw.jpg", 4],
    ["edit-remove-clutter", "杂物清理修图", "edit", "修图", "适合清理干扰物和画面污点。", "清理画面中影响观感的杂物、污点和多余元素，保持原始场景自然真实。", "场景结构改变，主体缺失，明显涂抹痕迹", ["cleanup_target"], ["清理", "修图"], {}, 8, "./assets/work-landscape.jpg", 5],
    ["edit-social-cover", "社媒封面优化", "edit", "社媒", "适合小红书、公众号和朋友圈封面。", "基于上传图片优化为适合小红书、公众号或朋友圈封面的视觉效果，主体突出，文字区域留白充足。", "文字乱码，主体被裁切，过度锐化", ["platform", "layout"], ["社媒", "封面"], {}, 8, "./assets/work-tram.jpg", 6],
    ["img2img-campus-comic", "校园漫画毕业季", "image_to_image", "校园漫画风", "把参考图转成清爽校园漫画感，适合毕业纪念头像和班级海报。", "参考上传图片的人物身份、姿态和主要构图，生成校园毕业季主题漫画插画：阳光教学楼、飘动学士服、干净线条、明亮色彩、青春感强，画面像高质量青春校园漫画封面，保留人物主要特征。", "低清晰度，五官崩坏，过度夸张，文字乱码，手指畸形", ["campus_scene", "style_strength", "ratio"], ["毕业季", "漫画", "校园"], imagePromptDefaultParams["img2img-campus-comic"], 8, "./assets/style-korean.jpg", 1],
    ["img2img-campus-romance", "校园恋爱毕业照", "image_to_image", "校园恋爱风", "适合双人毕业照、情侣头像和青春感社媒图。", "参考上传图片的人物关系、姿态和面部特征，生成校园毕业季恋爱写真：操场跑道或林荫道，傍晚金色逆光，轻微胶片颗粒，互动自然含蓄，氛围温柔但不夸张，真实摄影质感。", "脸部变形，过度亲密，低俗，过曝，背景杂乱", ["campus_scene", "lighting", "mood"], ["毕业季", "恋爱", "写真"], imagePromptDefaultParams["img2img-campus-romance"], 8, "./assets/work-sunset.jpg", 2],
    ["img2img-campus-portrait", "校园毕业写真", "image_to_image", "校园写真", "适合单人毕业季写真、头像和纪念相册。", "参考上传人像的五官、发型、姿态和服装轮廓，生成高级校园毕业写真：教学楼长廊、自然柔光、浅景深、皮肤真实通透、构图干净，加入毕业季氛围但不过度堆砌。", "过度磨皮，五官改变，服装异常，背景失真", ["campus_scene", "clothing", "camera"], ["毕业季", "写真", "人像"], imagePromptDefaultParams["img2img-campus-portrait"], 8, "./assets/work-portrait.jpg", 3],
    ["img2img-campus-id", "青春证件毕业风", "image_to_image", "证件照", "适合毕业证件风头像、简历头像和清爽形象照。", "参考上传人像生成清爽校园毕业证件风照片：正面自然微笑，干净浅色背景，可保留白衬衫或学士服元素，光线均匀，面部真实清晰，适合毕业资料和社交头像。", "证件不规范，脸部变形，浓妆，背景脏乱", ["background", "clothing", "ratio"], ["毕业季", "证件照", "头像"], imagePromptDefaultParams["img2img-campus-id"], 8, "./assets/style-minimal.jpg", 4],
    ["img2img-campus-group", "班级合照电影感", "image_to_image", "毕业合照", "适合多人合照增强、毕业纪念海报和班级宣传图。", "参考上传合照的人物数量和站位，生成电影感校园毕业合照：校门或主教学楼前，统一但自然的毕业季氛围，人物清晰，光线柔和，色彩高级，画面有纪念册封面感。", "人物缺失，脸部替换，站位混乱，文字乱码", ["campus_scene", "lighting", "composition"], ["毕业季", "合照", "电影感"], imagePromptDefaultParams["img2img-campus-group"], 9, "./assets/cta-bg.jpg", 5],
    ["img2img-campus-film", "胶片校园回忆", "image_to_image", "胶片风", "适合怀旧毕业纪念、相册封面和社媒长图。", "参考上传图片主体生成胶片校园回忆风：老教学楼、树影、操场、暖色胶片颗粒、轻微漏光、自然抓拍感，像毕业多年后翻出的珍贵照片，保留人物身份特征。", "噪点过重，脸部模糊，颜色脏，年代感过度", ["campus_scene", "film_tone", "mood"], ["毕业季", "胶片", "怀旧"], imagePromptDefaultParams["img2img-campus-film"], 8, "./assets/style-vintage.jpg", 6],
    ["img2img-campus-uniform", "校服青春大片", "image_to_image", "校服风", "适合校服主题写真、青春感头像和毕业纪念图。", "参考上传人像生成校服青春大片：干净校服或白衬衫造型，校园楼梯、走廊或操场背景，阳光自然，表情松弛，画面真实有青春电影剧照感。", "服装错乱，过度成熟，姿态僵硬，脸部失真", ["clothing", "campus_scene", "lighting"], ["毕业季", "校服", "青春"], imagePromptDefaultParams["img2img-campus-uniform"], 8, "./assets/work-girl.jpg", 7],
    ["img2img-campus-night", "毕业晚会氛围照", "image_to_image", "晚会氛围", "适合毕业晚会、社团活动和舞台纪念照。", "参考上传图片主体生成毕业晚会氛围照：校园礼堂或露天舞台，暖色灯串、轻微舞台光、真实摄影质感，人物突出，背景有庆祝毕业的氛围但不过度拥挤。", "灯光脏乱，脸部过暗，文字乱码，低清晰度", ["event_scene", "lighting", "mood"], ["毕业季", "晚会", "活动"], imagePromptDefaultParams["img2img-campus-night"], 8, "./assets/style-cinematic.jpg", 8],
    ["img2img-campus-polaroid", "拍立得毕业纪念", "image_to_image", "拍立得", "适合社媒九宫格、毕业纪念卡和头像合集。", "参考上传图片主体生成拍立得毕业纪念照：白色相纸边框感、校园背景、自然抓拍、色彩清新，保留人物主要特征，画面像毕业留言册里的精致照片。", "边框文字乱码，人脸模糊，过曝，低质滤镜", ["campus_scene", "color_tone", "ratio"], ["毕业季", "拍立得", "纪念"], imagePromptDefaultParams["img2img-campus-polaroid"], 8, "./assets/work-tram.jpg", 9],
    ["img2img-campus-future", "毕业启程商务风", "image_to_image", "商务毕业照", "适合求职头像、毕业形象照和个人主页封面。", "参考上传人像生成毕业启程商务风照片：校园与城市天际线自然融合，穿搭干净得体，光线明亮，姿态自信，表达从校园走向职场的感觉，真实摄影质感。", "过度商务，年龄失真，背景拼贴感，五官改变", ["background", "clothing", "mood"], ["毕业季", "商务", "头像"], imagePromptDefaultParams["img2img-campus-future"], 8, "./assets/creator-chen.jpg", 10]
  ];
  const campusImagePromptIds = prompts.filter((prompt) => prompt[2] === "image_to_image").map((prompt) => prompt[0]);
  if (campusImagePromptIds.length) {
    await db.exec(
      `UPDATE prompt_templates SET is_active = 0, updated_at = NOW() WHERE task_type = 'image_to_image' AND id NOT IN (${campusImagePromptIds.map(() => "?").join(",")})`,
      campusImagePromptIds
    );
  }
  for (const prompt of prompts) {
    await db.exec(`INSERT INTO prompt_templates
      (id, title, task_type, scene, user_description, prompt_content, negative_prompt, variables_json, category_tags_json, default_params_json, credit_cost, result_image_url, sort_order, is_active, version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'v1', NOW(), NOW())
      ON DUPLICATE KEY UPDATE title = VALUES(title), task_type = VALUES(task_type), scene = VALUES(scene), user_description = VALUES(user_description), prompt_content = VALUES(prompt_content), negative_prompt = VALUES(negative_prompt), variables_json = VALUES(variables_json), category_tags_json = VALUES(category_tags_json), default_params_json = VALUES(default_params_json), credit_cost = VALUES(credit_cost), result_image_url = VALUES(result_image_url), sort_order = VALUES(sort_order), is_active = 1, updated_at = NOW()`,
      [prompt[0], prompt[1], prompt[2], prompt[3], prompt[4], prompt[5], prompt[6], jsonText(normalizeVariables(prompt[7])), jsonText(prompt[8] || []), jsonText(prompt[9] || {}), prompt[10], prompt[11], prompt[12]]
    );
  }
  }
  await syncImagePromptDefaults();

  const modelKey = process.env.default_model_api_key || "";
  await db.exec(`INSERT INTO ai_models
    (id, provider, name, model_code, base_url, api_key_ciphertext, api_key_masked, auth_type, supported_task_types_json, default_size, default_params_json, credit_cost_config_json, cost_config_json, test_payload_json, timeout_seconds, retry_limit, concurrency_limit, version, is_default, is_active, remark, created_at, updated_at)
    VALUES ('model_doubao', ?, ?, ?, ?, ?, ?, ?, ?, '2048x2048', ?, ?, ?, ?, 300, 0, 4, '2026.04', 1, 1, '默认生图模型', NOW(), NOW())
    ON DUPLICATE KEY UPDATE provider = VALUES(provider), name = VALUES(name), model_code = VALUES(model_code), base_url = VALUES(base_url), api_key_ciphertext = IF(VALUES(api_key_ciphertext) = '', api_key_ciphertext, VALUES(api_key_ciphertext)), api_key_masked = IF(VALUES(api_key_masked) = '', api_key_masked, VALUES(api_key_masked)), auth_type = VALUES(auth_type), supported_task_types_json = VALUES(supported_task_types_json), default_size = VALUES(default_size), default_params_json = VALUES(default_params_json), credit_cost_config_json = VALUES(credit_cost_config_json), cost_config_json = VALUES(cost_config_json), test_payload_json = VALUES(test_payload_json), updated_at = NOW()`,
    [
      process.env.default_model_provider || "doubao",
      process.env.default_model_name || "Doubao-Seedream-5.0-lite",
      process.env.default_model_code || "doubao-seedream-5-0-260128",
      process.env.default_model_base_url || "https://ark.cn-beijing.volces.com/api/v3",
      encrypt(modelKey),
      maskSecret(modelKey),
      process.env.default_model_auth_type || "bearer",
      jsonText(["generate", "edit", "image_to_image"]),
      jsonText({ response_format: "url" }),
      jsonText({ generate: 5, edit: 8, image_to_image: 8 }),
      jsonText({ currency: "CNY", unit: "image", amount: 0 }),
      jsonText({ taskType: "generate", prompt: "一张柔光人像测试图", size: "2048x2048", count: 1 })
    ]
  );
};

const routeApi = async (req, res, url) => {
  const body = ["POST", "PATCH", "DELETE"].includes(req.method) ? await readBody(req) : {};

  const mediaMatch = req.method === "GET" ? mediaUrlParts(url.pathname) : null;
  if (mediaMatch) {
    const asset = await getMediaAsset(mediaMatch.assetId);
    if (!asset) return json(res, 404, { message: "图片不存在。" });
    const admin = requireAdmin(req);
    const user = asset.visibility === "public" || admin ? null : await requireUser(req);
    if (!canAccessMediaAsset({ asset, userId: user?.id || "", isAdmin: Boolean(admin) })) {
      return json(res, 403, { message: "无权访问图片。" });
    }
    const target = await signedMediaVariantUrl(asset, mediaMatch.variant);
    res.writeHead(302, {
      Location: target,
      "Cache-Control": "private, max-age=60",
      "Access-Control-Allow-Origin": "*"
    });
    return res.end();
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/storage-images/")) {
    const key = objectStorageKeyFromApiPath(url.pathname);
    if (!key) return json(res, 400, { message: "图片地址无效。" });
    const image = await loadObjectStorageImage(key);
    res.writeHead(200, {
      "Content-Type": image.contentType || contentTypes[path.extname(key).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "private, max-age=86400",
      "Access-Control-Allow-Origin": "*"
    });
    return res.end(image.data);
  }

  if (req.method === "POST" && url.pathname === "/api/auth/verification-codes") {
    const targetType = body.targetType === "phone" ? "phone" : "";
    const target = normalizePhone(body.target);
    const scene = String(body.scene || "");
    if (targetType !== "phone" || !validatePhone(target)) return json(res, 400, { message: "请输入有效手机号。" });
    if (!["register", "login", "reset_password"].includes(scene)) return json(res, 400, { message: "验证码场景无效。" });
    const code = process.env.NODE_ENV === "production" ? String(crypto.randomInt(100000, 1000000)) : "867530";
    const now = new Date();
    await db.exec("INSERT INTO verification_codes (id, target_type, target, scene, code_hash, expires_at, ip, user_agent, created_at) VALUES (?, 'phone', ?, ?, ?, ?, ?, ?, ?)", [
      uid("code"), target, scene, sha256(code), mysqlDateTime(new Date(now.getTime() + VERIFICATION_CODE_EXPIRES_MS)), req.socket.remoteAddress, req.headers["user-agent"] || "", mysqlDateTime(now)
    ]);
    return json(res, 200, { message: "验证码已发送。" });
  }

  if (req.method === "POST" && url.pathname === "/api/auth/login/phone-code") {
    const phone = normalizePhone(body.phone);
    if (!validatePhone(phone)) return json(res, 400, { message: "请输入有效手机号。" });
    const codeError = await consumeCode(phone, "login", body.code);
    if (codeError) return json(res, 400, { message: codeError });
    const user = await getOrCreatePhoneUser(phone);
    await db.exec("UPDATE users SET phone_verified_at = COALESCE(phone_verified_at, NOW()), last_login_at = NOW(), updated_at = NOW() WHERE id = ?", [user.id]);
    const fresh = (await db.query("SELECT * FROM users WHERE id = ?", [user.id]))[0];
    return json(res, 200, { user: await publicUser(fresh), ...(await issueTokens(fresh, req)) });
  }

  if (req.method === "POST" && url.pathname === "/api/auth/register/password") {
    const username = normalizeUsername(body.account || body.username);
    const usernameError = validateUsername(username);
    if (usernameError) return json(res, 400, { message: usernameError });
    const passwordError = validateSimplePassword(body.password);
    if (passwordError) return json(res, 400, { message: passwordError });
    if (await getUserByUsername(username)) return json(res, 409, { message: "账号已存在，请直接登录。" });

    const id = uid("user");
    await db.exec(
      `INSERT INTO users (id, username, nickname, password_hash, status, credits, created_at, updated_at, last_login_at)
       VALUES (?, ?, ?, ?, 'active', 0, NOW(), NOW(), NOW())`,
      [id, username, username, hashPassword(body.password)]
    );
    const fresh = (await db.query("SELECT * FROM users WHERE id = ? LIMIT 1", [id]))[0];
    return json(res, 200, { user: await publicUser(fresh), ...(await issueTokens(fresh, req)) });
  }

  if (req.method === "POST" && url.pathname === "/api/auth/login/password") {
    const username = normalizeUsername(body.account || body.username);
    const user = await getUserByUsername(username);
    if (!user || !verifyPassword(body.password || "", user.password_hash)) return json(res, 401, { message: "账号或密码错误。" });
    await db.exec("UPDATE users SET last_login_at = NOW(), updated_at = NOW() WHERE id = ?", [user.id]);
    const fresh = (await db.query("SELECT * FROM users WHERE id = ? LIMIT 1", [user.id]))[0];
    return json(res, 200, { user: await publicUser(fresh), ...(await issueTokens(fresh, req)) });
  }

  if (req.method === "POST" && url.pathname === "/api/auth/password/reset") {
    const phone = normalizePhone(body.phone);
    const rows = await db.query("SELECT * FROM users WHERE phone = ? LIMIT 1", [phone]);
    const user = rows[0];
    if (!user) return json(res, 404, { message: "手机号未注册。" });
    const passwordError = validatePassword(phone, body.password);
    if (passwordError) return json(res, 400, { message: passwordError });
    if (body.password !== body.confirmPassword) return json(res, 400, { message: "两次密码不一致。" });
    const codeError = await consumeCode(phone, "reset_password", body.code);
    if (codeError) return json(res, 400, { message: codeError });
    await db.exec("UPDATE users SET password_hash = ?, updated_at = NOW() WHERE id = ?", [hashPassword(body.password), user.id]);
    await refreshStore.revokeUser(user.id);
    return json(res, 200, { message: "密码已重设，请重新登录。" });
  }

  if (req.method === "POST" && url.pathname === "/api/auth/wechat/qr/create") {
    return json(res, 501, {
      message: "网站微信扫码登录尚未接入微信开放平台配置。"
    });
  }

  if (req.method === "POST" && url.pathname === "/api/auth/wechat/miniapp-login") {
    const code = String(body.code || "").trim();
    const nickname = String(body.nickname || "").trim();
    const avatarUrl = String(body.avatarUrl || "").trim();
    if (!code) return json(res, 400, { message: "缺少微信登录 code。" });

    let session = null;
    const appid = process.env.WECHAT_MINIAPP_APPID || process.env.wechat_miniapp_appid || "";
    const secret = process.env.WECHAT_MINIAPP_SECRET || process.env.wechat_miniapp_secret || "";

    if (appid && secret) {
      const endpoint = new URL("https://api.weixin.qq.com/sns/jscode2session");
      endpoint.searchParams.set("appid", appid);
      endpoint.searchParams.set("secret", secret);
      endpoint.searchParams.set("js_code", code);
      endpoint.searchParams.set("grant_type", "authorization_code");
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(10000) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) return json(res, 502, { message: "微信登录服务不可用。" });
      if (data.errcode) return json(res, 400, { message: data.errmsg || "微信授权失败。" });
      session = data;
    } else if (process.env.NODE_ENV !== "production") {
      session = {
        openid: `dev_${sha256(code).slice(0, 24)}`,
        unionid: `dev_union_${sha256(`union:${code}`).slice(0, 24)}`
      };
    } else {
      return json(res, 501, { message: "微信登录尚未配置小程序密钥。" });
    }

    if (!session?.openid) return json(res, 400, { message: "微信授权未返回用户标识。" });
    const user = await getOrCreateWechatUser({
      openid: session.openid,
      unionid: session.unionid || "",
      nickname,
      avatarUrl
    });
    await db.exec("UPDATE users SET last_login_at = NOW(), updated_at = NOW() WHERE id = ?", [user.id]);
    const fresh = (await db.query("SELECT * FROM users WHERE id = ? LIMIT 1", [user.id]))[0];
    return json(res, 200, { user: await publicUser(fresh), ...(await issueTokens(fresh, req)) });
  }

  if (req.method === "POST" && url.pathname === "/api/auth/token/refresh") {
    const stored = await refreshStore.get(`auth:refresh:${sha256(String(body.refreshToken || ""))}`);
    if (!stored || stored.status !== "active") return json(res, 401, { message: "refresh token 已失效。" });
    const rows = await db.query("SELECT * FROM users WHERE id = ? AND status <> 'disabled' LIMIT 1", [stored.userId]);
    const user = rows[0];
    if (!user) return json(res, 401, { message: "用户不可用。" });
    await refreshStore.del(`auth:refresh:${sha256(String(body.refreshToken || ""))}`);
    return json(res, 200, { user: await publicUser(user), ...(await issueTokens(user, req)) });
  }

  if (req.method === "POST" && url.pathname === "/api/auth/logout") {
    if (body.refreshToken) await refreshStore.del(`auth:refresh:${sha256(String(body.refreshToken))}`);
    return json(res, 200, { message: "已退出登录。" });
  }

  if (req.method === "GET" && url.pathname === "/api/auth/me") {
    const user = await requireUser(req);
    if (!user) return json(res, 401, { message: "未登录。" });
    return json(res, 200, { user: await publicUser(user) });
  }

  if (req.method === "POST" && url.pathname === "/api/users/me/avatar") {
    const user = await requireUser(req);
    if (!user) return json(res, 401, { message: "请先登录。" });
    const asset = await createMediaAssetFromDataUrl(body.imageData, {
      ownerType: "user",
      ownerId: user.id,
      visibility: "public",
      prefix: `${OBJECT_STORAGE.uploadPrefix}/avatars/${user.id}`,
      maxSize: 6 * 1024 * 1024
    });
    const avatarUrl = mediaUrl(asset.id, "preview");
    await db.exec("UPDATE users SET avatar_url = ?, avatar_source = 'custom', updated_at = NOW() WHERE id = ?", [avatarUrl, user.id]);
    const fresh = (await db.query("SELECT * FROM users WHERE id = ? LIMIT 1", [user.id]))[0];
    return json(res, 200, { user: await publicUser(fresh) });
  }

  if (req.method === "GET" && url.pathname === "/api/membership-plans") {
    const rows = await db.query("SELECT * FROM membership_plans WHERE is_active = 1 ORDER BY sort_order ASC");
    return json(res, 200, { plans: rows.map(planDto) });
  }

  if (req.method === "POST" && url.pathname === "/api/memberships/subscribe") {
    const user = await requireUser(req);
    if (!user) return json(res, 401, { message: "请先登录。" });
    const rows = await db.query("SELECT * FROM membership_plans WHERE code = ? AND is_active = 1 LIMIT 1", [body.planCode]);
    const plan = rows[0];
    if (!plan) return json(res, 404, { message: "会员方案不存在。" });
    return json(res, 202, {
      paymentStatus: "pending",
      message: "请先完成付款，支付回调成功后才会发放积分。",
      paymentQrUrl: "/assets/qr.jpg",
      plan: planDto(plan)
    });
  }

  if (req.method === "GET" && url.pathname === "/api/prompts") {
    const taskType = url.searchParams.get("taskType");
    const rows = await db.query("SELECT * FROM prompt_templates WHERE is_active = 1 AND (? = '' OR task_type = ?) ORDER BY sort_order ASC", [taskType || "", taskType || ""]);
    return json(res, 200, { prompts: rows.map((item) => promptDto(item, false)) });
  }

  if (req.method === "GET" && url.pathname === "/api/ai-models") {
    const taskType = url.searchParams.get("taskType");
    const user = await requireUser(req);
    const models = await activeModels(taskType);
    const preferred = user ? await resolveModel(user, taskType, user.preferred_ai_model_id) : models.find((model) => model.is_default);
    return json(res, 200, { models: models.map((model) => modelDto(model)), preferredModelId: preferred?.id || "" });
  }

  if (req.method === "POST" && url.pathname === "/api/uploads/images") {
    const user = await requireUser(req);
    if (!user) return json(res, 401, { message: "请先登录。" });
    const asset = await createMediaAssetFromDataUrl(body.imageData, {
      ownerType: "user",
      ownerId: user.id,
      visibility: "private",
      prefix: `${OBJECT_STORAGE.uploadPrefix}/user/${user.id}`
    });
    return json(res, 201, { url: mediaUrl(asset.id, "preview"), media: mediaItemFromAsset(asset) });
  }

  if ((req.method === "GET" || req.method === "POST") && url.pathname === "/api/downloads/images.zip") {
    const queryUrls = req.method === "GET" && url.searchParams.get("urls")
      ? jsonParse(decodeBase64url(url.searchParams.get("urls")), [])
      : [];
    const imageUrls = Array.isArray(req.method === "GET" ? queryUrls : body.imageUrls) ? (req.method === "GET" ? queryUrls : body.imageUrls).filter(Boolean).slice(0, 8) : [];
    if (!imageUrls.length) return json(res, 400, { message: "没有可下载的图片。" });
    const files = [];
    let totalSize = 0;
    try {
      for (let i = 0; i < imageUrls.length; i++) {
        const file = await loadDownloadImage(req, imageUrls[i], i);
        totalSize += file.data.length;
        if (totalSize > 80 * 1024 * 1024) return json(res, 400, { message: "图片总大小超过 80MB。" });
        files.push(file);
      }
    } catch (error) {
      if (error.message === "无权访问图片。") return json(res, 403, { message: error.message });
      throw error;
    }
    const zip = createZip(files);
    res.writeHead(200, {
      "Content-Type": "application/zip",
      "Content-Disposition": "attachment; filename=\"ai-photo-images.zip\"",
      "Content-Length": zip.length,
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS"
    });
    return res.end(zip);
  }

  if ((req.method === "GET" || req.method === "POST") && url.pathname === "/api/downloads/image") {
    const imageUrl = String(req.method === "GET" ? url.searchParams.get("url") : body.imageUrl || "").trim();
    if (!imageUrl) return json(res, 400, { message: "没有可下载的图片。" });
    const admin = requireAdmin(req);
    const user = admin ? null : await requireUser(req);
    let image;
    try {
      image = await loadImageBuffer(imageUrl, req, {
        viewerUserId: user?.id || "",
        viewerIsAdmin: Boolean(admin)
      });
    } catch (error) {
      if (error.message === "无权访问图片。") return json(res, 403, { message: error.message });
      throw error;
    }
    const ext = imageExtension(image.href, image.contentType);
    res.writeHead(200, {
      "Content-Type": image.contentType || contentTypes[ext] || "application/octet-stream",
      "Content-Disposition": `attachment; filename="ai-photo-current${ext}"`,
      "Content-Length": image.data.length,
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS"
    });
    return res.end(image.data);
  }

  if (req.method === "POST" && url.pathname === "/api/downloads/direct-urls") {
    const imageUrls = Array.isArray(body.imageUrls) ? body.imageUrls.filter(Boolean).slice(0, 9) : [];
    if (!imageUrls.length) return json(res, 400, { message: "没有可下载的图片。" });
    const admin = requireAdmin(req);
    const user = admin ? null : await requireUser(req);
    let urls;
    try {
      urls = await Promise.all(imageUrls.map((imageUrl) => directImageUrl(imageUrl, req, {
        viewerUserId: user?.id || "",
        viewerIsAdmin: Boolean(admin)
      })));
    } catch (error) {
      if (error.message === "无权访问图片。") return json(res, 403, { message: error.message });
      throw error;
    }
    return json(res, 200, { urls });
  }

  if (req.method === "POST" && url.pathname === "/api/ai-image-tasks") {
    const user = await requireUser(req);
    if (!user) return json(res, 401, { message: "请先登录。" });
    const taskType = ["generate", "edit", "image_to_image"].includes(body.taskType) ? body.taskType : "generate";
    const customPrompt = String(body.customPrompt || "").trim();
    const prompt = body.promptTemplateId
      ? (await db.query("SELECT * FROM prompt_templates WHERE id = ? AND task_type = ? AND is_active = 1 LIMIT 1", [body.promptTemplateId, taskType]))[0]
      : null;
    if (!prompt && !customPrompt) return json(res, 404, { message: "请选择提示词或输入完整自定义提示词。" });
    if (body.promptTemplateId && !prompt && !customPrompt) return json(res, 404, { message: "提示词不存在。" });
    const inputImages = normalizeReferenceImageUrls(body);
    if (["edit", "image_to_image"].includes(taskType) && !inputImages.length) return json(res, 400, { message: "该任务类型需要上传参考图。" });
    const model = await resolveModel(user, taskType, body.aiModelId);
    if (!model) return json(res, 400, { message: "没有可用模型。" });
    const count = Math.max(1, Math.min(9, Number(body.count || 1)));
    const defaultParams = customPrompt ? {} : jsonParse(prompt.default_params_json, {});
    const size = body.size || defaultParams.size || model.default_size;
    const ratio = normalizeImageRatio(body.ratio || defaultParams.ratio, size);
    const creditCost = modelCost(model, taskType, count);
    if (Number(user.credits || 0) < creditCost) return json(res, 400, { message: "积分不足，请先充值积分或减少生成数量。" });
    const promptVariables = body.promptVariables && typeof body.promptVariables === "object" ? body.promptVariables : {};
    const promptContent = customPrompt || prompt.prompt_content;
    const negativePrompt = customPrompt ? "" : (prompt.negative_prompt || "");
    const renderedPrompt = renderPromptText({
      promptContent,
      variables: promptVariables,
      userInstruction: body.userInstruction || "",
      negativePrompt
    });
    const promptSnapshot = {
      promptTemplateId: prompt?.id || "custom",
      promptTitle: prompt?.title || "自定义提示词",
      promptVersion: prompt?.version || "custom",
      taskType,
      promptContent,
      negativePrompt,
      variables: promptVariables,
      userInstruction: body.userInstruction || "",
      renderedPrompt,
      defaultParams,
      ratio,
      inputImages,
      isCustomPrompt: Boolean(customPrompt)
    };
    const task = {
      id: uid("task"),
      taskNo: `AI${Date.now()}`,
      creditCost,
      count
    };
    const conn = await pool.getConnection();
    try {
      await conn.execute("SET innodb_lock_wait_timeout = 5");
      await conn.beginTransaction();
      const [updateResult] = await conn.execute(
        "UPDATE users SET credits = credits - ?, preferred_ai_model_id = ?, updated_at = NOW() WHERE id = ? AND credits >= ?",
        [creditCost, model.id, user.id, creditCost]
      );
      if (updateResult.affectedRows === 0) {
        await conn.rollback();
        conn.release();
        return json(res, 400, { message: "积分不足，请购买积分后重试。" });
      }
      await conn.execute(
        `INSERT INTO ai_image_tasks
        (id, task_no, user_id, prompt_template_id, prompt_title, ai_model_id, ai_model_name, ai_model_version, task_type, status, credit_cost, size, count, input_image_url, input_image_urls_json, user_instruction, prompt_snapshot_json, result_image_urls_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, '[]', NOW(), NOW())`,
        [task.id, task.taskNo, user.id, promptSnapshot.promptTemplateId, promptSnapshot.promptTitle, model.id, model.name, model.version, taskType, creditCost, size, count, inputImages[0]?.originalUrl || inputImages[0]?.previewUrl || "", jsonText(inputImages), body.userInstruction || "", jsonText(promptSnapshot)]
      );
      await conn.execute(
        "INSERT INTO credit_transactions (id, user_id, amount, transaction_type, related_type, related_id, remark, created_at) VALUES (?, ?, ?, 'task_spend', 'ai_task', ?, ?, NOW())",
        [uid("credit"), user.id, -creditCost, task.id, `${promptSnapshot.promptTitle} · ${model.name}`]
      );
      await conn.commit();
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
    setTimeout(() => processTask(task.id).catch((error) => console.error(error)), 50);
    const freshTask = (await db.query("SELECT * FROM ai_image_tasks WHERE id = ?", [task.id]))[0];
    const freshUser = (await db.query("SELECT * FROM users WHERE id = ?", [user.id]))[0];
    return json(res, 201, { task: taskDto(freshTask), user: await publicUser(freshUser) });
  }

  if (req.method === "GET" && url.pathname === "/api/ai-image-tasks") {
    const user = await requireUser(req);
    if (!user) return json(res, 401, { message: "请先登录。" });
    const rows = await db.query("SELECT * FROM ai_image_tasks WHERE user_id = ? ORDER BY created_at DESC LIMIT 50", [user.id]);
    return json(res, 200, { tasks: rows.map(taskDto) });
  }

  const taskDetailMatch = url.pathname.match(/^\/api\/ai-image-tasks\/([^/]+)$/);
  if (req.method === "GET" && taskDetailMatch) {
    const user = await requireUser(req);
    if (!user) return json(res, 401, { message: "请先登录。" });
    const rows = await db.query("SELECT * FROM ai_image_tasks WHERE id = ? AND user_id = ? LIMIT 1", [decodeURIComponent(taskDetailMatch[1]), user.id]);
    if (!rows[0]) return json(res, 404, { message: "任务不存在。" });
    return json(res, 200, { task: taskDto(rows[0]) });
  }

  if (req.method === "GET" && url.pathname === "/api/credit-transactions") {
    const user = await requireUser(req);
    if (!user) return json(res, 401, { message: "请先登录。" });
    const rows = await db.query("SELECT * FROM credit_transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 100", [user.id]);
    return json(res, 200, { transactions: rows.map(creditTransactionDto) });
  }

  if (req.method === "POST" && url.pathname === "/api/admin/login") {
    const account = String(body.account || "").trim();
    const password = String(body.password || "");
    if (!constantTimeEqual(account, ADMIN_ACCOUNT) || !constantTimeEqual(password, ADMIN_PASSWORD)) {
      return json(res, 401, { message: "管理员账号或密码错误。" });
    }
    return json(res, 200, {
      admin: { account: ADMIN_ACCOUNT },
      accessToken: signJwt({ sub: ADMIN_ACCOUNT, type: "admin" }, ADMIN_ACCESS_EXPIRES_SECONDS),
      expiresIn: ADMIN_ACCESS_EXPIRES_SECONDS
    });
  }

  if (url.pathname.startsWith("/api/admin/")) {
    const admin = requireAdmin(req);
    if (!admin) return json(res, 401, { message: "请先登录管理后台。" });

    if (req.method === "GET" && url.pathname === "/api/admin/me") {
      return json(res, 200, { admin: { account: admin.sub } });
    }

    if (req.method === "POST" && url.pathname === "/api/admin/uploads/images") {
      const asset = await createMediaAssetFromDataUrl(body.imageData, {
        ownerType: "admin",
        ownerId: "admin",
        visibility: "public",
        prefix: body.prefix || "prompt-images",
        maxSize: 12 * 1024 * 1024
      });
      return json(res, 201, { url: mediaUrl(asset.id, "preview"), media: mediaItemFromAsset(asset) });
    }

    if (req.method === "GET" && url.pathname === "/api/admin/users") {
      const rows = await db.query("SELECT * FROM users ORDER BY created_at DESC LIMIT 100");
      return json(res, 200, { users: await Promise.all(rows.map(publicUser)) });
    }
    const userCreditMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/credits$/);
    if (req.method === "POST" && userCreditMatch) {
      const amount = Number(body.amount || 0);
      if (!amount) return json(res, 400, { message: "积分调整数量不能为 0。" });
      await db.exec("UPDATE users SET credits = credits + ?, updated_at = NOW() WHERE id = ?", [amount, userCreditMatch[1]]);
      await db.exec("INSERT INTO credit_transactions (id, user_id, amount, transaction_type, related_type, related_id, remark, created_at) VALUES (?, ?, ?, 'admin_adjust', 'admin', ?, ?, NOW())", [
        uid("credit"), userCreditMatch[1], amount, "manual", body.remark || "后台人工调整"
      ]);
      return json(res, 200, { message: "积分已调整。" });
    }

    if (req.method === "GET" && url.pathname === "/api/admin/membership-plans") {
      const rows = await db.query("SELECT * FROM membership_plans ORDER BY sort_order ASC");
      return json(res, 200, { plans: rows.map(planDto) });
    }

    if (req.method === "GET" && url.pathname === "/api/admin/ai-models") {
      const rows = await db.query("SELECT * FROM ai_models ORDER BY is_default DESC, created_at ASC");
      return json(res, 200, { models: rows.map((model) => modelDto(model, true)) });
    }
    if (req.method === "POST" && url.pathname === "/api/admin/ai-models") {
      const id = uid("model");
      const apiKey = String(body.apiKey || "");
      const inputModel = { provider: body.provider || "custom", model_code: body.modelCode || "custom-model" };
      const defaultParams = sanitizeImageParams(inputModel, { response_format: "url", ...(body.defaultParams || {}) });
      await db.exec(`INSERT INTO ai_models
        (id, provider, name, model_code, base_url, api_key_ciphertext, api_key_masked, auth_type, supported_task_types_json, default_size, default_params_json, credit_cost_config_json, cost_config_json, test_payload_json, timeout_seconds, retry_limit, concurrency_limit, version, is_default, is_active, remark, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, NOW(), NOW())`,
        [
          id, body.provider || "custom", body.name || "未命名模型", body.modelCode || "custom-model", body.baseUrl || "",
          encrypt(apiKey), maskSecret(apiKey), body.authType || "bearer", jsonText(body.supportedTaskTypes || ["generate"]),
          body.defaultSize || "1:1", jsonText(defaultParams), jsonText(body.creditCostConfig || { generate: 5, edit: 8 }),
          jsonText(body.costConfig || {}), jsonText(body.testPayload || {}), Math.max(300, Number(body.timeoutSeconds || 300)), Number(body.retryLimit || 0), Number(body.concurrencyLimit || 4), body.version || "2026.04", body.remark || ""
        ]
      );
      return json(res, 201, { model: modelDto((await db.query("SELECT * FROM ai_models WHERE id = ?", [id]))[0], true) });
    }
    const modelMatch = url.pathname.match(/^\/api\/admin\/ai-models\/([^/]+)(?:\/(status|set-default|test))?$/);
    if (modelMatch) {
      const model = (await db.query("SELECT * FROM ai_models WHERE id = ? LIMIT 1", [modelMatch[1]]))[0];
      if (!model) return json(res, 404, { message: "模型不存在。" });
      if (req.method === "PATCH" && !modelMatch[2]) {
        const apiKey = body.apiKey ? String(body.apiKey) : "";
        const nextModel = { provider: body.provider ?? model.provider, model_code: body.modelCode ?? model.model_code };
        await db.exec(`UPDATE ai_models SET provider = ?, name = ?, model_code = ?, base_url = ?, api_key_ciphertext = IF(? = '', api_key_ciphertext, ?), api_key_masked = IF(? = '', api_key_masked, ?), auth_type = ?, supported_task_types_json = ?, default_size = ?, default_params_json = ?, credit_cost_config_json = ?, cost_config_json = ?, test_payload_json = ?, timeout_seconds = ?, retry_limit = ?, concurrency_limit = ?, version = ?, remark = ?, updated_at = NOW() WHERE id = ?`, [
          body.provider ?? model.provider, body.name ?? model.name, body.modelCode ?? model.model_code, body.baseUrl ?? model.base_url,
          apiKey, encrypt(apiKey), apiKey, maskSecret(apiKey), body.authType ?? model.auth_type,
          jsonText(body.supportedTaskTypes || jsonParse(model.supported_task_types_json, [])), body.defaultSize ?? model.default_size,
          jsonText(sanitizeImageParams(nextModel, body.defaultParams || jsonParse(model.default_params_json, {}))), jsonText(body.creditCostConfig || jsonParse(model.credit_cost_config_json, {})),
          jsonText(body.costConfig || jsonParse(model.cost_config_json, {})), jsonText(body.testPayload || jsonParse(model.test_payload_json, {})),
          Math.max(300, Number(body.timeoutSeconds || model.timeout_seconds || 300)), Number(body.retryLimit || model.retry_limit), Number(body.concurrencyLimit || model.concurrency_limit),
          body.version ?? model.version, body.remark ?? model.remark, model.id
        ]);
        return json(res, 200, { model: modelDto((await db.query("SELECT * FROM ai_models WHERE id = ?", [model.id]))[0], true) });
      }
      if (req.method === "PATCH" && modelMatch[2] === "status") {
        await db.exec("UPDATE ai_models SET is_active = ?, updated_at = NOW() WHERE id = ?", [body.isActive === true ? 1 : 0, model.id]);
        return json(res, 200, { message: "模型状态已更新。" });
      }
      if (req.method === "POST" && modelMatch[2] === "set-default") {
        await db.exec("UPDATE ai_models SET is_default = 0");
        await db.exec("UPDATE ai_models SET is_default = 1, is_active = 1, updated_at = NOW() WHERE id = ?", [model.id]);
        return json(res, 200, { message: "默认模型已更新。" });
      }
      if (req.method === "POST" && modelMatch[2] === "test") {
        const payload = {
          taskType: body.taskType || "generate",
          prompt: body.prompt || "一张柔光人像测试图",
          ratio: normalizeImageRatio(body.ratio, body.size || model.default_size),
          size: body.size || model.default_size,
          count: Number(body.count || 1),
          inputImageUrl: body.inputImageUrl || "",
          overrideParams: body.overrideParams || {}
        };
        try {
          const result = await callImageModel({ model, ...payload });
          await db.exec("INSERT INTO ai_model_test_logs (id, model_id, admin_id, task_type, request_payload_snapshot, success, latency_ms, provider_request_id, result_image_urls_json, created_at) VALUES (?, ?, 'admin', ?, ?, 1, ?, ?, ?, NOW())", [
            uid("test"), model.id, payload.taskType, jsonText({ ...payload, prompt: payload.prompt.slice(0, 200) }), result.latencyMs, result.providerRequestId, jsonText(result.resultImageUrls)
          ]);
          await db.exec("UPDATE ai_models SET last_test_status = 'success', last_test_message = '模型连通性测试通过', last_test_at = NOW() WHERE id = ?", [model.id]);
          return json(res, 200, { success: true, latencyMs: result.latencyMs, requestId: result.providerRequestId, resultImageUrls: result.resultImageUrls, message: "模型连通性测试通过" });
        } catch (error) {
          await db.exec("INSERT INTO ai_model_test_logs (id, model_id, admin_id, task_type, request_payload_snapshot, success, latency_ms, provider_request_id, error_code, error_message, created_at) VALUES (?, ?, 'admin', ?, ?, 0, ?, ?, ?, ?, NOW())", [
            uid("test"), model.id, payload.taskType, jsonText({ ...payload, prompt: payload.prompt.slice(0, 200) }), error.latencyMs || null, error.providerRequestId || "", error.providerErrorCode || "", error.message
          ]);
          await db.exec("UPDATE ai_models SET last_test_status = 'failed', last_test_message = ?, last_test_at = NOW() WHERE id = ?", [error.message, model.id]);
          return json(res, 400, { success: false, message: error.message });
        }
      }
    }
    const taskCurlMatch = url.pathname.match(/^\/api\/admin\/ai-image-tasks\/([^/]+)\/curl$/);
    if (req.method === "GET" && taskCurlMatch) {
      const task = (await db.query("SELECT * FROM ai_image_tasks WHERE id = ? LIMIT 1", [taskCurlMatch[1]]))[0];
      if (!task) return json(res, 404, { message: "任务不存在。" });
      const model = (await db.query("SELECT * FROM ai_models WHERE id = ? LIMIT 1", [task.ai_model_id]))[0];
      if (!model) return json(res, 404, { message: "任务模型不存在。" });
      const snapshot = jsonParse(task.prompt_snapshot_json, {});
      let text = snapshot.renderedPrompt || "";
      if (!text && task.prompt_template_id !== "custom") {
        const prompt = (await db.query("SELECT * FROM prompt_templates WHERE id = ? LIMIT 1", [task.prompt_template_id]))[0];
        text = [prompt?.prompt_content, task.user_instruction].filter(Boolean).join("\n");
      }
      if (!text) text = task.user_instruction || "";
      const count = Math.max(1, Math.min(9, Number(task.count || 1)));
      const inputImageUrl = task.input_image_url ? await directImageUrl(task.input_image_url, req, { viewerIsAdmin: true }) : "";
      const storedInputImageUrls = mediaItemsFromValue(jsonParse(task.input_image_urls_json, []));
      const inputImageUrls = await Promise.all(storedInputImageUrls.map((item) => directImageUrl(item.originalUrl || item.previewUrl || item.thumbUrl || "", req, { viewerIsAdmin: true })));
      const request = buildImageModelRequest({
        model,
        taskType: task.task_type,
        prompt: promptWithImageCount(text, count),
        inputImageUrl,
        inputImageUrls,
        ratio: snapshot.ratio,
        size: task.size,
        count,
        overrideParams: snapshot.defaultParams || {}
      });
      return json(res, 200, { curl: imageModelCurl(request) });
    }
    if (req.method === "GET" && url.pathname === "/api/admin/ai-image-tasks") {
      const status = url.searchParams.get("status") || "";
      const taskType = url.searchParams.get("taskType") || "";
      const keyword = String(url.searchParams.get("keyword") || "").trim();
      const startedAt = url.searchParams.get("startedAt") || "";
      const endedAt = url.searchParams.get("endedAt") || "";
      const pageSize = Math.min(50, Math.max(1, Number(url.searchParams.get("pageSize") || 10)));
      const page = Math.max(1, Number(url.searchParams.get("page") || 1));
      const where = [];
      const params = [];
      if (status) {
        where.push("t.status = ?");
        params.push(status);
      }
      if (taskType) {
        where.push("t.task_type = ?");
        params.push(taskType);
      }
      if (keyword) {
        where.push("(t.task_no LIKE ? OR t.prompt_title LIKE ? OR t.user_instruction LIKE ? OR t.ai_model_name LIKE ? OR t.user_id LIKE ? OR u.nickname LIKE ? OR u.phone LIKE ?)");
        const like = `%${keyword}%`;
        params.push(like, like, like, like, like, like, like);
      }
      if (startedAt) {
        where.push("t.created_at >= ?");
        params.push(`${startedAt} 00:00:00`);
      }
      if (endedAt) {
        where.push("t.created_at <= ?");
        params.push(`${endedAt} 23:59:59`);
      }
      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const [{ total }] = await db.query(
        `SELECT COUNT(*) AS total FROM ai_image_tasks t LEFT JOIN users u ON u.id = t.user_id ${whereSql}`,
        params
      );
      const offset = (page - 1) * pageSize;
      const rows = await db.query(
        `SELECT t.*, u.nickname, u.phone
         FROM ai_image_tasks t
         LEFT JOIN users u ON u.id = t.user_id
         ${whereSql}
         ORDER BY t.created_at DESC
         LIMIT ? OFFSET ?`,
        [...params, pageSize, offset]
      );
      return json(res, 200, {
        tasks: rows.map(taskDto),
        pagination: {
          page,
          pageSize,
          total: Number(total || 0),
          totalPages: Math.max(1, Math.ceil(Number(total || 0) / pageSize))
        }
      });
    }

    if (req.method === "GET" && url.pathname === "/api/admin/stats") {
      const [[userCount]] = await pool.query("SELECT COUNT(*) AS n FROM users");
      const [[activeMembers]] = await pool.query("SELECT COUNT(*) AS n FROM user_memberships WHERE status = 'active'");
      const [[taskTotal]] = await pool.query("SELECT COUNT(*) AS n FROM ai_image_tasks");
      const [[taskSucceeded]] = await pool.query("SELECT COUNT(*) AS n FROM ai_image_tasks WHERE status = 'succeeded'");
      const [[taskFailed]] = await pool.query("SELECT COUNT(*) AS n FROM ai_image_tasks WHERE status = 'failed'");
      const [[creditSpent]] = await pool.query("SELECT COALESCE(SUM(ABS(amount)), 0) AS n FROM credit_transactions WHERE transaction_type = 'task_spend'");
      const recentTasks = await db.query("SELECT * FROM ai_image_tasks ORDER BY created_at DESC LIMIT 10");
      const trend = await db.query(`
        SELECT DATE(created_at) AS day, COUNT(*) AS tasks
        FROM ai_image_tasks
        WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)
        GROUP BY DATE(created_at)
        ORDER BY day ASC
      `);
      return json(res, 200, {
        userCount: Number(userCount.n),
        activeMembers: Number(activeMembers.n),
        taskTotal: Number(taskTotal.n),
        taskSucceeded: Number(taskSucceeded.n),
        taskFailed: Number(taskFailed.n),
        taskSuccessRate: taskTotal.n > 0 ? Math.round(taskSucceeded.n / taskTotal.n * 100) : 0,
        creditSpent: Number(creditSpent.n),
        recentTasks: recentTasks.map(taskDto),
        trend: trend.map((r) => ({ day: r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day), tasks: Number(r.tasks) }))
      });
    }

    if (req.method === "GET" && url.pathname === "/api/admin/credit-transactions") {
      const userId = url.searchParams.get("userId") || "";
      const rows = userId
        ? await db.query("SELECT ct.*, u.nickname, u.phone, u.email FROM credit_transactions ct LEFT JOIN users u ON u.id = ct.user_id WHERE ct.user_id = ? ORDER BY ct.created_at DESC LIMIT 200", [userId])
        : await db.query("SELECT ct.*, u.nickname, u.phone, u.email FROM credit_transactions ct LEFT JOIN users u ON u.id = ct.user_id ORDER BY ct.created_at DESC LIMIT 200");
      return json(res, 200, {
        transactions: rows.map((r) => ({
          id: r.id,
          userId: r.user_id,
          userNickname: r.nickname || "",
          userPhone: r.phone || "",
          userEmail: r.email || "",
          amount: Number(r.amount),
          transactionType: r.transaction_type,
          relatedType: r.related_type || "",
          relatedId: r.related_id || "",
          remark: r.remark || "",
          createdAt: toIso(r.created_at)
        }))
      });
    }

    const userStatusMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/status$/);
    if (req.method === "PATCH" && userStatusMatch) {
      const status = ["active", "disabled"].includes(body.status) ? body.status : null;
      if (!status) return json(res, 400, { message: "状态值无效。" });
      await db.exec("UPDATE users SET status = ?, updated_at = NOW() WHERE id = ?", [status, userStatusMatch[1]]);
      if (status === "disabled") await refreshStore.revokeUser(userStatusMatch[1]);
      return json(res, 200, { message: "用户状态已更新。" });
    }

    if (req.method === "POST" && url.pathname === "/api/admin/membership-plans") {
      const id = uid("plan");
      await db.exec(
        "INSERT INTO membership_plans (id, code, name, version, price, suffix, credits, quota, duration_days, features_json, sort_order, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NOW(), NOW())",
        [id, body.code || id, body.name || "新方案", body.version || "v2026.04", Number(body.price || 0), body.suffix || "元", Number(body.credits || 0), Number(body.quota || 0), Number(body.durationDays || 30), jsonText(body.features || []), Number(body.sortOrder || 0)]
      );
      return json(res, 201, { plan: planDto((await db.query("SELECT * FROM membership_plans WHERE id = ?", [id]))[0]) });
    }
    const planMatch = url.pathname.match(/^\/api\/admin\/membership-plans\/([^/]+)$/);
    if (planMatch) {
      const plan = (await db.query("SELECT * FROM membership_plans WHERE id = ? LIMIT 1", [planMatch[1]]))[0];
      if (!plan) return json(res, 404, { message: "方案不存在。" });
      if (req.method === "PATCH") {
        await db.exec(
          "UPDATE membership_plans SET name = ?, version = ?, price = ?, suffix = ?, credits = ?, quota = ?, duration_days = ?, features_json = ?, sort_order = ?, is_active = ?, updated_at = NOW() WHERE id = ?",
          [body.name ?? plan.name, body.version ?? plan.version, Number(body.price ?? plan.price), body.suffix ?? plan.suffix, Number(body.credits ?? plan.credits), Number(body.quota ?? plan.quota), Number(body.durationDays ?? plan.duration_days), jsonText(body.features || jsonParse(plan.features_json, [])), Number(body.sortOrder ?? plan.sort_order), body.isActive === false ? 0 : 1, plan.id]
        );
        return json(res, 200, { plan: planDto((await db.query("SELECT * FROM membership_plans WHERE id = ?", [plan.id]))[0]) });
      }
    }

    if (req.method === "GET" && url.pathname === "/api/admin/prompt-templates") {
      const rows = await db.query("SELECT * FROM prompt_templates ORDER BY task_type ASC, sort_order ASC");
      return json(res, 200, { prompts: rows.map((p) => promptDto(p, true)) });
    }
    if (req.method === "POST" && url.pathname === "/api/admin/prompt-templates") {
      const id = uid("prompt");
      const version = body.version || "v1";
      await db.exec(
        "INSERT INTO prompt_templates (id, title, task_type, scene, user_description, category_tags_json, variables_json, prompt_content, negative_prompt, default_params_json, credit_cost, result_image_url, sort_order, is_active, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, NOW(), NOW())",
        [
          id,
          body.title || "新提示词",
          body.taskType || "generate",
          body.scene || "",
          body.userDescription || "",
          jsonText(body.categoryTags || []),
          jsonText(normalizeVariables(body.variables || [])),
          body.promptContent || "",
          body.negativePrompt || "",
          jsonText(body.defaultParams || {}),
          Number(body.creditCost || 0),
          promptImagesText(body),
          Number(body.sortOrder || 0),
          version
        ]
      );
      await insertPromptVersion((await db.query("SELECT * FROM prompt_templates WHERE id = ?", [id]))[0]);
      return json(res, 201, { message: "提示词已创建。", id });
    }
    const promptMatch = url.pathname.match(/^\/api\/admin\/prompt-templates\/([^/]+)(?:\/(versions|test))?$/);
    if (promptMatch) {
      const prompt = (await db.query("SELECT * FROM prompt_templates WHERE id = ? LIMIT 1", [promptMatch[1]]))[0];
      if (!prompt) return json(res, 404, { message: "提示词不存在。" });
      if (req.method === "GET" && promptMatch[2] === "versions") {
        const rows = await db.query("SELECT * FROM prompt_versions WHERE prompt_template_id = ? ORDER BY created_at DESC LIMIT 50", [prompt.id]);
        return json(res, 200, { versions: rows.map((row) => ({ ...promptDto(row, true), promptTemplateId: row.prompt_template_id })) });
      }
      if (req.method === "POST" && promptMatch[2] === "test") {
        const model = body.aiModelId
          ? (await db.query("SELECT * FROM ai_models WHERE id = ? AND is_active = 1 LIMIT 1", [body.aiModelId]))[0]
          : (await activeModels(prompt.task_type))[0];
        if (!model) return json(res, 400, { message: "没有可用于该提示词类型的模型。" });
        const variables = body.variables && typeof body.variables === "object" ? body.variables : {};
        const renderedPrompt = renderPromptText({
          promptContent: prompt.prompt_content,
          variables,
          userInstruction: body.userInstruction || "",
          negativePrompt: prompt.negative_prompt || ""
        });
        const promptDefaultParams = jsonParse(prompt.default_params_json, {});
        const testSize = body.size || promptDefaultParams.size || model.default_size;
        const testRatio = normalizeImageRatio(body.ratio || promptDefaultParams.ratio, testSize);
        const snapshot = {
          promptTemplateId: prompt.id,
          promptTitle: prompt.title,
          promptVersion: prompt.version,
          variables,
          userInstruction: body.userInstruction || "",
          renderedPrompt,
          defaultParams: promptDefaultParams
        };
        const testId = uid("ptest");
        const inputImage = normalizeMediaItem(body.inputImageUrl || "");
        try {
          const result = await callImageModel({
            model,
            taskType: prompt.task_type,
            prompt: renderedPrompt,
            inputImageUrl: inputImage?.originalUrl ? await directImageUrl(inputImage.originalUrl, req, { viewerIsAdmin: true }) : "",
            ratio: testRatio,
            size: testSize,
            count: body.count || 1,
            overrideParams: snapshot.defaultParams
          });
          await db.exec(
            "INSERT INTO prompt_test_results (id, prompt_template_id, prompt_version, model_id, model_name, task_type, variables_json, prompt_snapshot_json, input_image_url, size, count, success, latency_ms, provider_request_id, result_image_urls_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, NOW())",
            [testId, prompt.id, prompt.version, model.id, model.name, prompt.task_type, jsonText(variables), jsonText(snapshot), inputImage?.originalUrl || "", testSize, Number(body.count || 1), result.latencyMs, result.providerRequestId, jsonText(result.resultImageUrls)]
          );
          return json(res, 200, { success: true, testId, latencyMs: result.latencyMs, requestId: result.providerRequestId, resultImageUrls: result.resultImageUrls, message: "提示词测试已保存。" });
        } catch (error) {
          await db.exec(
            "INSERT INTO prompt_test_results (id, prompt_template_id, prompt_version, model_id, model_name, task_type, variables_json, prompt_snapshot_json, input_image_url, size, count, success, error_message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NOW())",
            [testId, prompt.id, prompt.version, model.id, model.name, prompt.task_type, jsonText(variables), jsonText(snapshot), inputImage?.originalUrl || "", testSize, Number(body.count || 1), error.message]
          );
          return json(res, 400, { success: false, testId, message: error.message });
        }
      }
      if (req.method === "PATCH" && !promptMatch[2]) {
        const nextVersion = await nextPromptVersion(prompt.id);
        await db.exec(
          "UPDATE prompt_templates SET title = ?, task_type = ?, scene = ?, user_description = ?, category_tags_json = ?, variables_json = ?, prompt_content = ?, negative_prompt = ?, default_params_json = ?, credit_cost = ?, result_image_url = ?, sort_order = ?, is_active = ?, version = ?, updated_at = NOW() WHERE id = ?",
          [
            body.title ?? prompt.title,
            body.taskType ?? prompt.task_type,
            body.scene ?? prompt.scene,
            body.userDescription ?? prompt.user_description ?? "",
            jsonText(body.categoryTags || jsonParse(prompt.category_tags_json, [])),
            jsonText(normalizeVariables(body.variables || jsonParse(prompt.variables_json, []))),
            body.promptContent ?? prompt.prompt_content,
            body.negativePrompt ?? prompt.negative_prompt,
            jsonText(body.defaultParams || jsonParse(prompt.default_params_json, {})),
            Number(body.creditCost ?? prompt.credit_cost),
            (Array.isArray(body.exampleImages) || body.exampleImageUrl !== undefined || body.resultImageUrl !== undefined) ? promptImagesText(body) : prompt.result_image_url,
            Number(body.sortOrder ?? prompt.sort_order),
            body.isActive === false ? 0 : 1,
            nextVersion,
            prompt.id
          ]
        );
        await insertPromptVersion((await db.query("SELECT * FROM prompt_templates WHERE id = ?", [prompt.id]))[0]);
        return json(res, 200, { message: "提示词已更新。" });
      }
      if (req.method === "DELETE" && !promptMatch[2]) {
        await db.exec("DELETE FROM prompt_templates WHERE id = ?", [prompt.id]);
        return json(res, 200, { message: "提示词已删除。" });
      }
    }
    const promptTestMatch = url.pathname.match(/^\/api\/admin\/prompt-test-results\/([^/]+)\/set-example$/);
    if (req.method === "POST" && promptTestMatch) {
      const test = (await db.query("SELECT * FROM prompt_test_results WHERE id = ? LIMIT 1", [promptTestMatch[1]]))[0];
      if (!test) return json(res, 404, { message: "测试结果不存在。" });
      const imageUrl = jsonParse(test.result_image_urls_json, [])[0] || "";
      if (!imageUrl) return json(res, 400, { message: "测试结果没有图片。" });
      const image = await loadImageBuffer(imageUrl, req, { bypassMediaAuth: true });
      const asset = await createMediaAssetFromBuffer({
        buffer: image.data,
        fallbackMime: image.contentType || "image/jpeg",
        ownerType: "admin",
        ownerId: "admin",
        visibility: "public",
        prefix: `prompt-images/${test.prompt_template_id}`
      });
      const media = mediaItemFromAsset(asset);
      await db.exec("UPDATE prompt_templates SET result_image_url = ?, updated_at = NOW() WHERE id = ?", [promptImagesText({ exampleImages: [media] }), test.prompt_template_id]);
      return json(res, 200, { message: "已设为示例图。", exampleImageUrl: media.thumbUrl, exampleImages: [media] });
    }
  }

  return json(res, 404, { message: "接口不存在。" });
};

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp"
};

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

const crc32 = (buffer) => {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

const zipDateTime = () => ({ time: 0, date: 0 });

const createZip = (files) => {
  const chunks = [];
  const central = [];
  let offset = 0;
  const { time, date } = zipDateTime();
  files.forEach((file) => {
    const name = Buffer.from(file.name, "utf8");
    const data = file.data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, data);

    const item = Buffer.alloc(46);
    item.writeUInt32LE(0x02014b50, 0);
    item.writeUInt16LE(20, 4);
    item.writeUInt16LE(20, 6);
    item.writeUInt16LE(0, 8);
    item.writeUInt16LE(0, 10);
    item.writeUInt16LE(time, 12);
    item.writeUInt16LE(date, 14);
    item.writeUInt32LE(crc, 16);
    item.writeUInt32LE(data.length, 20);
    item.writeUInt32LE(data.length, 24);
    item.writeUInt16LE(name.length, 28);
    item.writeUInt16LE(0, 30);
    item.writeUInt16LE(0, 32);
    item.writeUInt16LE(0, 34);
    item.writeUInt16LE(0, 36);
    item.writeUInt32LE(0, 38);
    item.writeUInt32LE(offset, 42);
    central.push(item, name);
    offset += local.length + name.length + data.length;
  });
  const centralSize = central.reduce((sum, item) => sum + item.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, ...central, end]);
};

const imageExtension = (url, contentType = "") => {
  const ext = path.extname(new URL(url, "http://localhost").pathname).toLowerCase();
  if ([".jpg", ".jpeg", ".png", ".webp"].includes(ext)) return ext === ".jpeg" ? ".jpg" : ext;
  if (contentType.includes("png")) return ".png";
  if (contentType.includes("webp")) return ".webp";
  return ".jpg";
};

const loadImageBuffer = async (rawUrl, req = null, options = {}) => {
  const value = String(rawUrl || "");
  if (value.startsWith("data:")) {
    const { mime, buffer } = decodeImageDataUrl(value);
    return { data: buffer, contentType: mime, href: value };
  }
  const imageUrl = new URL(value, req ? publicUrl(req, "/") : "http://localhost");
  if (!["http:", "https:"].includes(imageUrl.protocol)) throw new Error("图片地址无效。");
  const media = mediaUrlParts(imageUrl.pathname);
  if (media) {
    const asset = await getMediaAsset(media.assetId);
    if (!asset) throw new Error("图片不存在。");
    if (!options.bypassMediaAuth && !canAccessMediaAsset({
      asset,
      userId: options.viewerUserId || "",
      isAdmin: Boolean(options.viewerIsAdmin)
    })) {
      throw new Error("无权访问图片。");
    }
    const image = await loadObjectStorageImage(mediaVariantObjectKey(asset, media.variant));
    return { ...image, href: imageUrl.href };
  }
  const apiStorageKey = objectStorageKeyFromApiPath(imageUrl.pathname);
  if (apiStorageKey) {
    const image = await loadObjectStorageImage(apiStorageKey);
    return { ...image, href: imageUrl.href };
  }
  const storageKey = objectStorageKeyFromUrl(imageUrl.href);
  if (storageKey) {
    const image = await loadObjectStorageImage(storageKey);
    return { ...image, href: imageUrl.href };
  }
  const sameHost = req && imageUrl.host === (req.headers.host || `localhost:${PORT}`);
  if (sameHost) {
    const pathname = decodeURIComponent(imageUrl.pathname);
    const filePath = path.join(ROOT, "web", pathname.replace(/^\/+/, ""));
    if (!filePath.startsWith(path.join(ROOT, "web")) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) throw new Error("图片文件不存在。");
    const data = await fs.promises.readFile(filePath);
    return { data, contentType: "", href: imageUrl.href };
  }
  const response = await fetch(imageUrl, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`图片下载失败：${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  return { data, contentType: response.headers.get("content-type") || "", href: imageUrl.href };
};

const persistImageUrlsToMediaItems = async (imageUrls, options = {}) => {
  const storedItems = [];
  for (const imageUrl of imageUrls) {
    const image = await loadImageBuffer(imageUrl, null, { bypassMediaAuth: true });
    const asset = await createMediaAssetFromBuffer({
      buffer: image.data,
      fallbackMime: image.contentType || "image/jpeg",
      ownerType: options.ownerType || "user",
      ownerId: options.ownerId || "",
      visibility: options.visibility || "private",
      prefix: options.prefix || "ai-results"
    });
    storedItems.push(mediaItemFromAsset(asset));
  }
  return storedItems.filter(Boolean);
};

const loadDownloadImage = async (req, rawUrl, index) => {
  const admin = requireAdmin(req);
  const user = admin ? null : await requireUser(req);
  const image = await loadImageBuffer(rawUrl, req, {
    viewerUserId: user?.id || "",
    viewerIsAdmin: Boolean(admin)
  });
  return {
    name: `ai-photo-${index + 1}${imageExtension(image.href, image.contentType)}`,
    data: image.data
  };
};

const serveStatic = (req, res, url) => {
  const pathname = decodeURIComponent(url.pathname);
  let filePath;
  if (pathname === "/" || pathname.startsWith("/web/")) {
    filePath = path.join(ROOT, pathname === "/" ? "web/index.html" : pathname.slice(1));
  } else if (pathname.startsWith("/admin")) {
    filePath = path.join(ROOT, pathname === "/admin" ? "admin/index.html" : pathname.slice(1));
  } else {
    filePath = path.join(ROOT, "web", pathname);
  }
  if (!filePath.startsWith(ROOT) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }
  res.writeHead(200, { "Content-Type": contentTypes[path.extname(filePath)] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === "OPTIONS") return json(res, 204, {});
  try {
    if (url.pathname.startsWith("/api/")) return await routeApi(req, res, url);
    return serveStatic(req, res, url);
  } catch (error) {
    console.error(error);
    return json(res, 500, { message: error.message || "服务异常。" });
  }
});

(async () => {
  await ensureSchema();
  await seedData();
  server.listen(PORT, () => {
    console.log(`[backend] listening on http://localhost:${PORT}`);
    console.log(`[backend] mysql database: ${process.env.mysql_database || "aiphoto"}`);
    console.log(refreshStore.redisDisabled ? "[backend] redis is not configured, using in-memory refresh token store." : "[backend] redis refresh token store configured.");
  });
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
