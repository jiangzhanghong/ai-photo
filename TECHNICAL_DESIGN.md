# 光影AI 技术方案

## 1. 文档范围

本文档覆盖两项新增能力：

1. 用户注册与登录：支持手机号验证码和邮箱验证码的整体设计，首期实现邮箱验证码注册和验证码登录；注册完成后设置密码，后续支持密码登录和忘记密码重设。
2. 生图模型维护：后台可维护图片生成和图片修改模型；前台用户可选择已上架模型，默认模型为豆包；不同模型可以配置不同积分消耗。

当前仓库仍以静态 Web 页面为主，`backend/`、`admin/`、`weapp/` 尚未建立运行时。本文档作为后续后端、后台和前端实现依据。

## 2. 关键假设

- 首期不接短信服务商，只预留手机号字段、验证码类型和接口扩展点。
- 注册和验证码登录都必须校验邮箱验证码。
- 注册完成后必须设置密码，密码满足复杂度规则。
- 后续支持邮箱密码登录；忘记密码通过邮箱验证码重设密码，重设成功后需要重新登录。
- 登录态固定采用 JWT access token + refresh token + Redis。
- Redis 连接信息从环境变量 `redis_addr`、`redis_password` 读取。
- 用户前台可选择生图模型；没有历史选择时默认豆包；选择成功后记住用户最近一次选择。
- 模型密钥、完整参数、供应商内部配置不返回给前台。

## 3. 总体架构

建议后续拆为四层：

- Web/小程序前台：注册登录、会员中心、AI 创作、模型选择、创作记录。
- Admin 后台：用户管理、会员方案、提示词、生图模型、AI 任务管理。
- Backend API：认证、验证码、会员积分、提示词选择、模型选择、AI 任务编排。
- Worker：异步消费 AI 任务，调用模型供应商，保存结果并回写任务状态。

AI 任务提交必须经过后端。前台提交提示词 ID、任务类型、模型 ID、尺寸、数量、输入图和用户补充说明；后端负责校验模型可用性、计算积分、组合核心 prompt 和模型参数。

## 4. 注册登录方案

### 4.1 用户流程

邮箱验证码注册：

1. 用户进入注册页，输入邮箱。
2. 前端调用发送验证码接口，场景为 `register`。
3. 用户输入验证码、密码和确认密码并提交注册。
4. 后端校验验证码、邮箱唯一性和密码复杂度。
5. 邮箱未注册则创建用户，写入密码哈希，标记 `email_verified_at`。
6. 后端签发 JWT access token 和 refresh token，并在 Redis 记录 refresh token 状态。
7. 邮箱已注册时提示去登录。

邮箱验证码登录：

1. 用户进入登录页，输入邮箱。
2. 前端调用发送验证码接口，场景为 `login`。
3. 用户输入验证码并提交登录。
4. 后端校验验证码。
5. 邮箱已注册则签发登录凭证，更新 `last_login_at`。
6. 邮箱未注册则提示先注册。

邮箱密码登录：

1. 用户输入邮箱和密码。
2. 后端校验用户状态和密码哈希。
3. 校验成功后签发 JWT access token 和 refresh token。
4. refresh token 状态写入 Redis，更新用户 `last_login_at`。

忘记密码：

1. 用户输入邮箱并获取验证码，场景为 `reset_password`。
2. 用户提交邮箱、验证码、新密码和确认密码。
3. 后端校验验证码和密码复杂度。
4. 后端更新密码哈希，清理该用户旧 refresh token。
5. 用户需要重新登录。

退出登录：

1. 前端调用退出接口。
2. 后端使当前 refresh token 在 Redis 中失效。
3. 前端清除本地登录态。

### 4.2 JWT 与 Redis

access token：

- 短有效期，建议 15 分钟到 2 小时。
- 不落库，不存 Redis。
- 只包含用户 ID、令牌版本、过期时间等必要字段。

refresh token：

- 长有效期，建议 30 天。
- Redis 保存 refresh token 哈希、用户 ID、设备信息、过期时间和状态。
- 每次刷新 access token 时可轮换 refresh token。
- 退出登录、忘记密码重设、用户禁用时使 refresh token 失效。

Redis 配置：

```text
redis_addr=127.0.0.1:6379
redis_password=your_password
```

### 4.3 接口设计

用户认证接口：

```text
POST /api/auth/verification-codes
POST /api/auth/register/email
POST /api/auth/login/email-code
POST /api/auth/login/password
POST /api/auth/password/reset
POST /api/auth/token/refresh
POST /api/auth/logout
GET  /api/auth/me
```

发送验证码请求：

```json
{
  "targetType": "email",
  "target": "user@example.com",
  "scene": "register"
}
```

邮箱注册请求：

```json
{
  "email": "user@example.com",
  "code": "123456",
  "password": "Aa123456!",
  "confirmPassword": "Aa123456!",
  "nickname": "可选昵称"
}
```

邮箱验证码登录请求：

```json
{
  "email": "user@example.com",
  "code": "123456"
}
```

邮箱密码登录请求：

```json
{
  "email": "user@example.com",
  "password": "Aa123456!"
}
```

忘记密码重设请求：

```json
{
  "email": "user@example.com",
  "code": "123456",
  "password": "NewAa123456!",
  "confirmPassword": "NewAa123456!"
}
```

登录成功响应：

```json
{
  "user": {
    "id": "user_id",
    "email": "user@example.com",
    "nickname": "用户昵称"
  },
  "accessToken": "access_token",
  "refreshToken": "refresh_token",
  "expiresIn": 7200
}
```

### 4.4 验证码与密码规则

验证码规则：

- 验证码长度：6 位数字。
- 有效期：10 分钟。
- 单邮箱发送间隔：60 秒。
- 单邮箱每日发送上限：10 次。
- 单 IP 每小时发送上限：30 次。
- 单验证码最多校验错误 5 次，超过后作废。
- 验证码只保存哈希值，禁止明文落库或输出日志。
- 校验成功后立即标记 `used_at`，不可重复使用。

密码复杂度默认规则：

- 长度 8-32 位。
- 至少包含大写字母、小写字母、数字、特殊字符中的 3 类。
- 不能包含邮箱前缀。
- 不能全为空白字符，不允许首尾空格。
- 使用安全哈希算法存储，禁止明文落库。

### 4.5 数据表

`users`：

- `id`
- `nickname`
- `email`
- `password_hash`
- `password_set_at`
- `phone`
- `wechat_openid`
- `avatar_url`
- `email_verified_at`
- `phone_verified_at`
- `preferred_ai_model_id`
- `status`
- `last_login_at`
- `created_at`
- `updated_at`

`verification_codes`：

- `id`
- `target_type`
- `target`
- `scene`
- `code_hash`
- `expires_at`
- `used_at`
- `failed_attempts`
- `ip`
- `user_agent`
- `created_at`

Redis refresh token 建议结构：

```text
auth:refresh:{token_hash} -> {
  user_id,
  device_id,
  user_agent,
  ip,
  expires_at,
  status
}
```

建议索引：

- `users.email` 唯一索引。
- `users.phone` 唯一索引，允许为空。
- `users.preferred_ai_model_id` 普通索引。
- `verification_codes.target_type + target + scene + created_at` 普通索引。
- `verification_codes.expires_at` 普通索引，用于清理过期记录。

## 5. 生图模型维护方案

### 5.1 后台能力

管理员可维护：

- 模型供应商。
- 模型名称。
- 供应商模型编码。
- 支持任务类型：图片生成、图片修改。
- 默认尺寸。
- 默认参数 JSON。
- 积分消耗配置 JSON。
- 成本配置 JSON。
- 模型版本。
- 上下架状态。
- 是否默认模型，默认模型为豆包。

### 5.2 前台能力

用户在 AI 创作页可以选择已上架且支持当前任务类型的模型：

- 首次进入时默认选中豆包。
- 用户提交任务成功后，后端将该模型写入 `users.preferred_ai_model_id`。
- 用户再次进入 AI 创作页时，默认选中最近一次选择的可用模型。
- 如果最近选择的模型已下架或不支持当前任务类型，则回退到豆包。

### 5.3 接口设计

后台模型接口：

```text
GET    /api/admin/ai-models
POST   /api/admin/ai-models
GET    /api/admin/ai-models/:id
PATCH  /api/admin/ai-models/:id
PATCH  /api/admin/ai-models/:id/status
POST   /api/admin/ai-models/:id/set-default
```

前台 AI 接口：

```text
GET  /api/ai-models
GET  /api/prompts
POST /api/ai-image-tasks
GET  /api/ai-image-tasks
GET  /api/ai-image-tasks/:id
```

前台创建 AI 任务请求：

```json
{
  "taskType": "generate",
  "promptTemplateId": "prompt_id",
  "aiModelId": "doubao_model_id",
  "size": "1:1",
  "count": 1,
  "inputImageUrl": null,
  "userInstruction": "可选补充说明"
}
```

前台模型列表响应不返回模型密钥或敏感参数：

```json
{
  "models": [
    {
      "id": "doubao_model_id",
      "name": "豆包",
      "supportedTaskTypes": ["generate", "edit"],
      "creditCost": {
        "generate": 5,
        "edit": 8
      },
      "isDefault": true
    }
  ],
  "preferredModelId": "doubao_model_id"
}
```

前台任务响应不返回核心 prompt、模型密钥或敏感参数：

```json
{
  "id": "task_id",
  "taskNo": "AI202604260001",
  "status": "queued",
  "creditCost": 5,
  "aiModelId": "doubao_model_id"
}
```

### 5.4 模型选择与积分规则

1. 后端读取用户提交的 `aiModelId`。
2. 后端校验模型上架且支持当前任务类型。
3. 如果未传 `aiModelId`，使用用户最近一次选择；没有可用偏好时使用豆包。
4. 如果豆包不可用，任务创建失败且不扣积分。
5. 后端按模型 `credit_cost_config`、任务类型、尺寸和数量计算积分消耗。
6. 任务创建成功后记录 `ai_model_id` 和 `ai_model_version`。
7. 任务提交成功后更新用户最近一次模型选择。

### 5.5 AI 任务处理流程

1. 前端提交任务。
2. 后端校验登录态、会员状态、积分余额、提示词状态、模型可用性。
3. 后端计算积分消耗。
4. 后端在事务内扣减积分、写积分流水、创建 `queued` 任务。
5. Worker 拉取任务并更新为 `processing`。
6. Worker 读取模型配置和核心 prompt，组装供应商请求。
7. 调用成功后保存结果图，更新任务为 `succeeded`。
8. 调用失败后更新任务为 `failed`，按规则退回积分并记录退款流水。

### 5.6 数据表

`ai_models`：

- `id`
- `provider`
- `name`
- `model_code`
- `supported_task_types`
- `default_size`
- `default_params`
- `credit_cost_config`
- `cost_config`
- `version`
- `is_default`
- `is_active`
- `remark`
- `created_by`
- `updated_by`
- `created_at`
- `updated_at`

`prompt_templates` 增加：

- `default_model_id`，可选，用于后台推荐模型，不覆盖用户主动选择。

`ai_image_tasks` 增加：

- `ai_model_id`
- `ai_model_version`

`users` 增加：

- `preferred_ai_model_id`

建议索引：

- `ai_models.provider + model_code + version` 唯一索引。
- `ai_models.is_active + is_default` 普通索引。
- `ai_image_tasks.user_id + created_at` 普通索引。
- `ai_image_tasks.status + created_at` 普通索引，用于 Worker 拉取任务。

## 6. 安全与风控

- 验证码、邮箱、手机号、IP、用户代理信息需要避免在日志中完整明文输出。
- 邮箱验证码接口需要频控，避免被刷邮件。
- 登录接口需要错误次数限制。
- 密码只保存哈希值，不保存明文。
- refresh token 只保存哈希值或不可逆标识。
- access token 短有效期；refresh token 失效状态保存在 Redis。
- 忘记密码重设成功后，需要清理用户旧 refresh token。
- 管理后台接口必须鉴权并做角色权限校验。
- 模型密钥不存放在 `ai_models` 表中，建议使用环境变量或密钥管理服务。
- 核心 prompt、反向 prompt、模型完整参数不得返回给前台。
- AI 任务扣积分和退积分必须幂等，避免重复扣费或重复退款。

## 7. 首期交付建议

第一阶段：

- Redis 连接配置，读取 `redis_addr`、`redis_password`。
- 邮箱验证码发送。
- 邮箱验证码注册并设置密码。
- 邮箱验证码登录。
- 邮箱密码登录。
- 忘记密码验证码重设。
- JWT access token、refresh token、刷新和退出登录。
- 用户表、验证码表。

第二阶段：

- AI 模型后台 CRUD。
- 豆包默认模型配置。
- 不同模型积分消耗配置。
- 前台模型列表和模型选择。
- AI 任务创建时按用户选择模型扣减积分。
- AI 任务记录模型 ID 和版本。
- 记住用户最近一次模型选择。

第三阶段：

- Worker 接入真实模型供应商。
- 失败退款、重试和成本统计。
- 手机号验证码服务商接入。

## 8. 待确认事项

- 邮箱服务商、发件域名和邮件模板是否已有指定。
- 邮箱已注册时，注册验证码校验通过后是提示登录，还是直接登录。
- 验证码有效期、发送上限和错误次数是否采用本文建议值。
- 密码复杂度是否采用本文默认规则。
- 手机号验证码后续接入哪家短信服务商。
- 是否需要按会员等级限制可选模型。
- 除豆包外，首批还要配置哪些模型。
- AI 任务失败是否全部自动退积分，还是按失败原因区分。
