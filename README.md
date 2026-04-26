# ai-photo

光影AI 当前包含静态官网、会员中心、管理后台和一个无外部依赖的 Node 后端原型。

## 运行

```bash
npm start
```

默认访问：

- 官网：`http://localhost:8000/`
- 会员中心：`http://localhost:8000/member.html`
- 管理后台：`http://localhost:8000/admin`

可选环境变量：

```bash
PORT=8000
redis_addr=127.0.0.1:6379
redis_password=your_password
jwt_secret=change_me
admin_token=dev-admin-token
```

如果没有配置 `redis_addr`，后端会使用内存 refresh token 存储，仅适合本地开发。

## 已实现范围

- 邮箱验证码注册，注册时设置密码。
- 邮箱验证码登录、邮箱密码登录。
- 忘记密码通过邮箱验证码重设，重设后清理 refresh token。
- JWT access token + refresh token 登录态。
- 会员方案开通和积分发放。
- 生图模型后台维护，默认模型为豆包。
- 前台用户选择模型，不同模型可配置不同积分消耗。
- AI 图片任务创建、积分扣减、任务记录和模拟完成。
