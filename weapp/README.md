# 光影AI 小程序

原生微信小程序 + TypeScript 实现，复用现有 `backend` 接口。

## 本地运行

1. 启动后端：

   ```bash
   node backend/server.js
   ```

2. 使用微信开发者工具导入 `weapp` 目录。
3. 本地开发默认接口地址在 `utils/config.ts`：

   ```ts
   export const API_BASE_URL = "http://127.0.0.1:8000";
   ```

4. 开发环境验证码默认是 `867530`。

## 真机调试

真机不能访问电脑上的 `127.0.0.1`。需要把 `API_BASE_URL` 改成手机可访问的 HTTPS 域名，并在微信公众平台配置 request/download 合法域名。

## 页面

- `pages/home`：会员、登录、积分套餐。
- `pages/create`：上传或复用历史参考图，选择模板、模型、比例和张数后提交生成。
- `pages/records`：生成记录列表。
- `pages/result`：生成结果、耗时、参考图、预览和保存图片。
