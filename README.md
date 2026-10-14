# Antigravity Gateway · 云端部署

## 部署步骤

1. 先把这个仓库 Fork 到自己的 GitHub 账号。
2. 打开 https://dashboard.render.com ，点 **New → Blueprint**，选择 Fork 出来的仓库，Render 会读取 `render.yaml` 自动创建服务。
   - 不想用 Blueprint 也可以：**New → Web Service**，选这个仓库，Runtime 选 **Docker**，Instance Type 选 **Free**，Health Check Path 填 `/health`。
3. 等部署完成，打开 `https://<你的服务名>.onrender.com`，用管理密钥登录控制台，再用 Google 登录添加账号。
4. 管理密钥：在 Render 服务的 **Environment** 页查看 `ADMIN_KEY`（Blueprint 会自动生成一个；手动创建的话自己加一个）。

## 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `ADMIN_KEY` | 建议填 | 管理密钥：登录控制台用，客户端调用接口时也用它当 API Key。不填则任何人都能访问 |
| `GH_TOKEN` | 否 | GitHub Token。填了以后账号会保存到 `GH_REPO` 的 `state` 分支，重启后不会丢 |
| `GH_REPO` | 填了 `GH_TOKEN` 就必填 | 用来存数据的**私有**仓库，例如 `你的用户名/antigravity-state` |

> Render 免费版重启后本地文件会清空。不配 `GH_TOKEN` 的话，每次重启都要重新登录 Google 账号。

## 防休眠

Render 免费版空闲 15 分钟会休眠。可以去 https://cron-job.org 建一个任务，每 5 分钟访问一次 `https://<你的服务名>.onrender.com/health`。
**不要直接访问首页**：首页内容太大，会报「输出太大」。

## 接口

- Anthropic 兼容：`https://<你的服务名>.onrender.com/v1/messages`，请求头 `x-api-key` 填 `ADMIN_KEY`
- 健康检查：`/health`

## 注意

不要把 `data/accounts/*.json` 提交到公开仓库，里面是 Google 登录令牌。
