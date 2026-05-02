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

   这里只适合微信开发者工具本地联调。真机调试、体验版和正式版不能使用
   `http://127.0.0.1:8000`、`http://43.153.153.33:8000` 这类 `http + IP`
   地址。

4. 开发环境验证码默认是 `867530`。

## 真机调试

真机不能访问电脑上的 `127.0.0.1`。需要把 `API_BASE_URL` 改成手机可访问的
`https://` 域名，例如 `https://api.example.com`，并在微信公众平台的
“开发管理 -> 开发设置 -> 服务器域名” 中同时配置：

- `request` 合法域名
- `downloadFile` 合法域名

按微信开放文档当前要求：

- `wx.request`、`wx.uploadFile`、`wx.downloadFile` 只能使用 `HTTPS`
- 服务器域名必须是已备案域名
- 不支持直接配置 IP 地址，应该使用域名
- 如果配置了端口，请求时必须与已配置端口完全一致

## 页面

- `pages/home`：会员、登录、积分套餐。
- `pages/create`：上传或复用历史参考图，选择模板、模型、比例和张数后提交生成。
- `pages/records`：生成记录列表。
- `pages/result`：生成结果、耗时、参考图、预览和保存图片。
