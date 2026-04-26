const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const net = require("net");
const path = require("path");
const mysql = require("mysql2/promise");
const { URL } = require("url");

const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.PORT || 8000);
const ACCESS_EXPIRES_SECONDS = 60 * 60 * 2;
const REFRESH_EXPIRES_SECONDS = 60 * 60 * 24 * 30;

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
const ADMIN_TOKEN = process.env.admin_token || "dev-admin-token";
const MODEL_SECRET = crypto.createHash("sha256").update(process.env.model_secret_key || JWT_SECRET).digest();

const nowIso = () => new Date().toISOString();
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
const normalizeImageSize = (size) => {
  const map = { "1:1": "2048x2048", "3:4": "1728x2304", "16:9": "2560x1440" };
  return map[size] || size || "2048x2048";
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

const json = (res, status, body) => {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Admin-Token",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS"
  });
  res.end(JSON.stringify(body));
};

const readBody = async (req) => new Promise((resolve, reject) => {
  let data = "";
  req.on("data", (chunk) => {
    data += chunk;
    if (data.length > 1024 * 1024 * 8) reject(new Error("Payload too large"));
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

const requireAdmin = (req) => req.headers["x-admin-token"] === ADMIN_TOKEN;
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
    phone: user.phone,
    nickname: user.nickname,
    avatarUrl: user.avatar_url || "",
    credits: Number(user.credits || 0),
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

const consumeCode = async (target, scene, code) => {
  const rows = await db.query("SELECT * FROM verification_codes WHERE target = ? AND scene = ? AND used_at IS NULL ORDER BY created_at DESC LIMIT 1", [target, scene]);
  const item = rows[0];
  if (!item) return "验证码不存在。";
  if (new Date(item.expires_at).getTime() < Date.now()) return "验证码已过期。";
  if (item.failed_attempts >= 5) return "验证码错误次数过多。";
  if (item.code_hash !== sha256(String(code))) {
    await db.exec("UPDATE verification_codes SET failed_attempts = failed_attempts + 1 WHERE id = ?", [item.id]);
    return "验证码错误。";
  }
  await db.exec("UPDATE verification_codes SET used_at = NOW() WHERE id = ?", [item.id]);
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
  isActive: Boolean(plan.is_active)
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
    timeoutSeconds: Number(model.timeout_seconds || 60),
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

const taskDto = (task) => ({
  id: task.id,
  taskNo: task.task_no,
  userId: task.user_id,
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
  inputImageUrl: task.input_image_url || "",
  userInstruction: task.user_instruction || "",
  resultImageUrls: jsonParse(task.result_image_urls_json, []),
  failureReason: task.failure_reason || "",
  providerRequestId: task.provider_request_id || "",
  providerLatencyMs: task.provider_latency_ms || null,
  providerErrorCode: task.provider_error_code || "",
  createdAt: toIso(task.created_at),
  updatedAt: toIso(task.updated_at)
});

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

const callImageModel = async ({ model, taskType, prompt, inputImageUrl, size, count, overrideParams = {} }) => {
  const baseUrl = String(model.base_url || "").replace(/\/+$/, "");
  if (!/^https:\/\//.test(baseUrl) && !/^http:\/\/127\.0\.0\.1/.test(baseUrl)) throw new Error("模型 baseUrl 必须是 https 地址。");
  const apiKey = decrypt(model.api_key_ciphertext);
  if (!apiKey) throw new Error("模型 apiKey 未配置。");
  const defaultParams = jsonParse(model.default_params_json, {});
  const body = {
    model: model.model_code,
    prompt: taskType === "edit" && inputImageUrl ? `${prompt}\n参考原图：${inputImageUrl}` : prompt,
    size: normalizeImageSize(size || model.default_size),
    n: Math.max(1, Math.min(4, Number(count || 1))),
    ...defaultParams,
    ...overrideParams
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(model.timeout_seconds || 60) * 1000);
  const started = Date.now();
  try {
    const response = await fetch(`${baseUrl}/images/generations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...modelAuthHeaders(model, apiKey)
      },
      body: JSON.stringify(body),
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
  const [prompt] = await db.query("SELECT * FROM prompt_templates WHERE id = ? LIMIT 1", [task.prompt_template_id]);
  try {
    const text = [prompt.prompt_content, task.user_instruction].filter(Boolean).join("\n");
    const result = await callImageModel({
      model,
      taskType: task.task_type,
      prompt: text,
      inputImageUrl: task.input_image_url,
      size: task.size,
      count: task.count
    });
    await db.exec(
      "UPDATE ai_image_tasks SET status = 'succeeded', result_image_urls_json = ?, provider_request_id = ?, provider_status_code = ?, provider_latency_ms = ?, updated_at = NOW() WHERE id = ?",
      [jsonText(result.resultImageUrls), result.providerRequestId, result.providerStatusCode, result.latencyMs, taskId]
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
      phone VARCHAR(32) UNIQUE,
      email VARCHAR(191) UNIQUE,
      nickname VARCHAR(120) NOT NULL,
      password_hash VARCHAR(255),
      phone_verified_at DATETIME,
      email_verified_at DATETIME,
      wechat_openid VARCHAR(191) UNIQUE,
      wechat_unionid VARCHAR(191),
      avatar_url VARCHAR(500),
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
    `CREATE TABLE IF NOT EXISTS prompt_templates (
      id VARCHAR(80) PRIMARY KEY,
      title VARCHAR(160) NOT NULL,
      task_type VARCHAR(40) NOT NULL,
      scene VARCHAR(80),
      prompt_content TEXT NOT NULL,
      negative_prompt TEXT,
      credit_cost INT NOT NULL DEFAULT 0,
      result_image_url VARCHAR(500),
      default_model_id VARCHAR(40),
      version VARCHAR(40) NOT NULL DEFAULT '2026.04',
      sort_order INT NOT NULL DEFAULT 0,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL,
      INDEX idx_task_active (task_type, is_active)
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
      timeout_seconds INT NOT NULL DEFAULT 60,
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
      user_instruction TEXT,
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

  const prompts = [
    ["portrait-soft", "柔光人像精修", "edit", "人像", "对上传的人像照片进行自然柔光精修，保留身份特征，优化肤色、光线和背景质感。", 8, "./assets/work-portrait.jpg", 1],
    ["product-clean", "商品白底优化", "edit", "商品", "将商品图优化为干净商业白底效果，增强主体清晰度和真实质感。", 10, "./assets/work-still.jpg", 2],
    ["cinematic", "电影感写真生成", "generate", "写真", "生成电影感人像写真，柔和布光，高级色彩，真实摄影质感。", 5, "./assets/style-cinematic.jpg", 1],
    ["travel-poster", "旅行海报生成", "generate", "旅行", "生成旅行海报风格图片，明亮自然光，具有目的地氛围和商业海报构图。", 6, "./assets/work-sunset.jpg", 2],
    ["vintage-magazine", "复古杂志封面", "generate", "品牌", "生成复古杂志封面风格图片，胶片色彩，精致排版感，商业摄影质感。", 7, "./assets/style-vintage.jpg", 3]
  ];
  for (const prompt of prompts) {
    await db.exec(`INSERT INTO prompt_templates
      (id, title, task_type, scene, prompt_content, credit_cost, result_image_url, sort_order, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, NOW(), NOW())
      ON DUPLICATE KEY UPDATE title = VALUES(title), task_type = VALUES(task_type), scene = VALUES(scene), prompt_content = VALUES(prompt_content), credit_cost = VALUES(credit_cost), result_image_url = VALUES(result_image_url), sort_order = VALUES(sort_order), updated_at = NOW()`,
      prompt
    );
  }

  const modelKey = process.env.default_model_api_key || "";
  await db.exec(`INSERT INTO ai_models
    (id, provider, name, model_code, base_url, api_key_ciphertext, api_key_masked, auth_type, supported_task_types_json, default_size, default_params_json, credit_cost_config_json, cost_config_json, test_payload_json, timeout_seconds, retry_limit, concurrency_limit, version, is_default, is_active, remark, created_at, updated_at)
    VALUES ('model_doubao', ?, ?, ?, ?, ?, ?, ?, ?, '2048x2048', ?, ?, ?, ?, 90, 0, 4, '2026.04', 1, 1, '默认生图模型', NOW(), NOW())
    ON DUPLICATE KEY UPDATE provider = VALUES(provider), name = VALUES(name), model_code = VALUES(model_code), base_url = VALUES(base_url), api_key_ciphertext = IF(VALUES(api_key_ciphertext) = '', api_key_ciphertext, VALUES(api_key_ciphertext)), api_key_masked = IF(VALUES(api_key_masked) = '', api_key_masked, VALUES(api_key_masked)), auth_type = VALUES(auth_type), supported_task_types_json = VALUES(supported_task_types_json), default_size = VALUES(default_size), default_params_json = VALUES(default_params_json), credit_cost_config_json = VALUES(credit_cost_config_json), cost_config_json = VALUES(cost_config_json), test_payload_json = VALUES(test_payload_json), updated_at = NOW()`,
    [
      process.env.default_model_provider || "doubao",
      process.env.default_model_name || "Doubao-Seedream-5.0-lite",
      process.env.default_model_code || "doubao-seedream-5-0-260128",
      process.env.default_model_base_url || "https://ark.cn-beijing.volces.com/api/v3",
      encrypt(modelKey),
      maskSecret(modelKey),
      process.env.default_model_auth_type || "bearer",
      jsonText(["generate", "edit"]),
      jsonText({ response_format: "url" }),
      jsonText({ generate: 5, edit: 8 }),
      jsonText({ currency: "CNY", unit: "image", amount: 0 }),
      jsonText({ taskType: "generate", prompt: "一张柔光人像测试图", size: "2048x2048", count: 1 })
    ]
  );
};

const routeApi = async (req, res, url) => {
  const body = ["POST", "PATCH", "DELETE"].includes(req.method) ? await readBody(req) : {};

  if (req.method === "POST" && url.pathname === "/api/auth/verification-codes") {
    const targetType = body.targetType === "phone" ? "phone" : "";
    const target = normalizePhone(body.target);
    const scene = String(body.scene || "");
    if (targetType !== "phone" || !validatePhone(target)) return json(res, 400, { message: "请输入有效手机号。" });
    if (!["login", "reset_password"].includes(scene)) return json(res, 400, { message: "验证码场景无效。" });
    const code = process.env.NODE_ENV === "production" ? String(crypto.randomInt(1000, 9999)) : "8888";
    await db.exec("INSERT INTO verification_codes (id, target_type, target, scene, code_hash, expires_at, ip, user_agent, created_at) VALUES (?, 'phone', ?, ?, ?, DATE_ADD(NOW(), INTERVAL 10 MINUTE), ?, ?, NOW())", [
      uid("code"), target, scene, sha256(code), req.socket.remoteAddress, req.headers["user-agent"] || ""
    ]);
    return json(res, 200, { message: "验证码已发送。", devCode: process.env.NODE_ENV === "production" ? undefined : code });
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

  if (req.method === "POST" && url.pathname === "/api/auth/login/password") {
    const phone = normalizePhone(body.phone);
    const rows = await db.query("SELECT * FROM users WHERE phone = ? LIMIT 1", [phone]);
    const user = rows[0];
    if (!user || !verifyPassword(body.password || "", user.password_hash)) return json(res, 401, { message: "手机号或密码错误。" });
    await db.exec("UPDATE users SET last_login_at = NOW(), updated_at = NOW() WHERE id = ?", [user.id]);
    return json(res, 200, { user: await publicUser(user), ...(await issueTokens(user, req)) });
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
    return json(res, 200, { sceneId: uid("wx"), status: "pending", qrUrl: "", message: "微信扫码登录接口已预留，待接入开放平台。" });
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
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.execute("UPDATE user_memberships SET status = 'cancelled', updated_at = NOW() WHERE user_id = ? AND status = 'active'", [user.id]);
      const membershipId = uid("membership");
      await conn.execute("INSERT INTO user_memberships (id, user_id, plan_id, plan_name, status, started_at, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', NOW(), DATE_ADD(NOW(), INTERVAL ? DAY), NOW(), NOW())", [
        membershipId, user.id, plan.id, plan.name, plan.duration_days
      ]);
      await conn.execute("UPDATE users SET credits = credits + ?, updated_at = NOW() WHERE id = ?", [plan.credits, user.id]);
      await conn.execute("INSERT INTO credit_transactions (id, user_id, amount, transaction_type, related_type, related_id, remark, created_at) VALUES (?, ?, ?, 'subscription_grant', 'membership', ?, ?, NOW())", [
        uid("credit"), user.id, plan.credits, membershipId, `${plan.name} 模拟支付开通`
      ]);
      await conn.commit();
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
    const fresh = (await db.query("SELECT * FROM users WHERE id = ?", [user.id]))[0];
    return json(res, 200, { user: await publicUser(fresh), paymentStatus: "simulated_paid" });
  }

  if (req.method === "GET" && url.pathname === "/api/prompts") {
    const taskType = url.searchParams.get("taskType");
    const rows = await db.query("SELECT id, title, task_type, scene, credit_cost FROM prompt_templates WHERE is_active = 1 AND (? = '' OR task_type = ?) ORDER BY sort_order ASC", [taskType || "", taskType || ""]);
    return json(res, 200, { prompts: rows.map((item) => ({ id: item.id, title: item.title, taskType: item.task_type, scene: item.scene, creditCost: Number(item.credit_cost) })) });
  }

  if (req.method === "GET" && url.pathname === "/api/ai-models") {
    const taskType = url.searchParams.get("taskType");
    const user = await requireUser(req);
    const models = await activeModels(taskType);
    const preferred = user ? await resolveModel(user, taskType, user.preferred_ai_model_id) : models.find((model) => model.is_default);
    return json(res, 200, { models: models.map((model) => modelDto(model)), preferredModelId: preferred?.id || "" });
  }

  if (req.method === "POST" && url.pathname === "/api/ai-image-tasks") {
    const user = await requireUser(req);
    if (!user) return json(res, 401, { message: "请先登录。" });
    const membership = (await db.query("SELECT * FROM user_memberships WHERE user_id = ? AND status = 'active' LIMIT 1", [user.id]))[0];
    if (!membership) return json(res, 403, { message: "请先开通会员方案。" });
    const taskType = body.taskType === "edit" ? "edit" : "generate";
    const prompt = (await db.query("SELECT * FROM prompt_templates WHERE id = ? AND task_type = ? AND is_active = 1 LIMIT 1", [body.promptTemplateId, taskType]))[0];
    if (!prompt) return json(res, 404, { message: "提示词不存在。" });
    if (taskType === "edit" && !body.inputImageUrl) return json(res, 400, { message: "修改图片需要上传原图。" });
    const model = await resolveModel(user, taskType, body.aiModelId);
    if (!model) return json(res, 400, { message: "没有可用模型。" });
    const count = Math.max(1, Math.min(4, Number(body.count || 1)));
    const creditCost = modelCost(model, taskType, count);
    if (Number(user.credits || 0) < creditCost) return json(res, 400, { message: "积分不足，请选择更少数量或开通更高方案。" });
    const task = {
      id: uid("task"),
      taskNo: `AI${Date.now()}`,
      creditCost,
      count
    };
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.execute("UPDATE users SET credits = credits - ?, preferred_ai_model_id = ?, updated_at = NOW() WHERE id = ? AND credits >= ?", [creditCost, model.id, user.id, creditCost]);
      await conn.execute(`INSERT INTO ai_image_tasks
        (id, task_no, user_id, prompt_template_id, prompt_title, ai_model_id, ai_model_name, ai_model_version, task_type, status, credit_cost, size, count, input_image_url, user_instruction, result_image_urls_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, '[]', NOW(), NOW())`,
        [task.id, task.taskNo, user.id, prompt.id, prompt.title, model.id, model.name, model.version, taskType, creditCost, body.size || model.default_size, count, body.inputImageUrl || "", body.userInstruction || ""]
      );
      await conn.execute("INSERT INTO credit_transactions (id, user_id, amount, transaction_type, related_type, related_id, remark, created_at) VALUES (?, ?, ?, 'task_spend', 'ai_task', ?, ?, NOW())", [
        uid("credit"), user.id, -creditCost, task.id, `${prompt.title} · ${model.name}`
      ]);
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

  if (url.pathname.startsWith("/api/admin/")) {
    if (!requireAdmin(req)) return json(res, 401, { message: "管理员令牌无效。" });

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
      await db.exec(`INSERT INTO ai_models
        (id, provider, name, model_code, base_url, api_key_ciphertext, api_key_masked, auth_type, supported_task_types_json, default_size, default_params_json, credit_cost_config_json, cost_config_json, test_payload_json, timeout_seconds, retry_limit, concurrency_limit, version, is_default, is_active, remark, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, NOW(), NOW())`,
        [
          id, body.provider || "custom", body.name || "未命名模型", body.modelCode || "custom-model", body.baseUrl || "",
          encrypt(apiKey), maskSecret(apiKey), body.authType || "bearer", jsonText(body.supportedTaskTypes || ["generate"]),
          body.defaultSize || "1024x1024", jsonText(body.defaultParams || { response_format: "url" }), jsonText(body.creditCostConfig || { generate: 5, edit: 8 }),
          jsonText(body.costConfig || {}), jsonText(body.testPayload || {}), Number(body.timeoutSeconds || 60), Number(body.retryLimit || 0), Number(body.concurrencyLimit || 4), body.version || "2026.04", body.remark || ""
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
        await db.exec(`UPDATE ai_models SET provider = ?, name = ?, model_code = ?, base_url = ?, api_key_ciphertext = IF(? = '', api_key_ciphertext, ?), api_key_masked = IF(? = '', api_key_masked, ?), auth_type = ?, supported_task_types_json = ?, default_size = ?, default_params_json = ?, credit_cost_config_json = ?, cost_config_json = ?, test_payload_json = ?, timeout_seconds = ?, retry_limit = ?, concurrency_limit = ?, version = ?, remark = ?, updated_at = NOW() WHERE id = ?`, [
          body.provider ?? model.provider, body.name ?? model.name, body.modelCode ?? model.model_code, body.baseUrl ?? model.base_url,
          apiKey, encrypt(apiKey), apiKey, maskSecret(apiKey), body.authType ?? model.auth_type,
          jsonText(body.supportedTaskTypes || jsonParse(model.supported_task_types_json, [])), body.defaultSize ?? model.default_size,
          jsonText(body.defaultParams || jsonParse(model.default_params_json, {})), jsonText(body.creditCostConfig || jsonParse(model.credit_cost_config_json, {})),
          jsonText(body.costConfig || jsonParse(model.cost_config_json, {})), jsonText(body.testPayload || jsonParse(model.test_payload_json, {})),
          Number(body.timeoutSeconds || model.timeout_seconds), Number(body.retryLimit || model.retry_limit), Number(body.concurrencyLimit || model.concurrency_limit),
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
    if (req.method === "GET" && url.pathname === "/api/admin/ai-image-tasks") {
      const rows = await db.query("SELECT * FROM ai_image_tasks ORDER BY created_at DESC LIMIT 100");
      return json(res, 200, { tasks: rows.map(taskDto) });
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
  ".svg": "image/svg+xml"
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
