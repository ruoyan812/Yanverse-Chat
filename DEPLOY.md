# 部署指南：云聊（实时聊天房间网站）

本项目是一个 **实时聊天网站**，用户可以在网上与他人对话、创建房间，其他人通过输入**房间名 / 房间号**加入房间。

**技术架构**

| 层 | 技术 | 说明 |
|----|------|------|
| 后端 + 实时通信 | Cloudflare Workers + Durable Objects | 每个房间一个 DO 实例，管理 WebSocket 连接、广播消息、SQLite 持久化历史记录 |
| 前端 | 纯 HTML/CSS/JS（打包进 Worker） | 单 Worker 同时托管静态页面 + API + WebSocket，部署最简单 |
| 代码托管 / CI/CD | GitHub + GitHub Actions | 推送到 main 分支自动部署 |

> 优势：**只需部署一个 Cloudflare Worker**，无需额外的 Pages 或域名。workers.dev 域名即可访问，也可绑定自定义域名。

---

## 一、本地开发

### 1. 安装 Node.js
需要 Node.js ≥ 18（推荐 20 LTS）。检查：

```bash
node -v
npm -v
```

### 2. 安装依赖

```bash
cd 20260828130453
npm install
```

### 3. 构建前端静态资源

前端文件在 `public/` 目录，需要打包进 Worker：

```bash
npm run build
```

这会生成 `src/assets.ts`（把 `public/` 里的静态文件以 base64 形式嵌入）。

> **注意**：修改了 `public/` 下的任何文件后，都要重新执行 `npm run build`。

### 4. 本地启动

```bash
npm run dev
```

启动后打开 `http://localhost:8787`：
- 输入昵称 → 创建房间或加入房间
- 房间号是 6 位大写字母+数字（如 `A1B2C3`）
- 用多个浏览器标签页打开同一个房间，即可测试多人实时对话

---

## 二、部署到 Cloudflare（核心步骤）

### 1. 注册 Cloudflare 账号
到 https://dash.cloudflare.com 注册（免费）。

### 2. 安装 Wrangler CLI 并登录

```bash
npm install -g wrangler
wrangler login
```

浏览器会弹出授权窗口，允许访问你的 Cloudflare 账号。

### 3. 确认账号信息
登录后执行，复制显示出来的 `Account ID`（后续 GitHub 配置需要）：

```bash
wrangler whoami
```

### 4. 部署 Worker

```bash
npm run build      # 打包前端
npx wrangler deploy
```

部署完成后会输出一个 URL，形如：
```
https://cloud-chat-rooms.<你的子域>.workers.dev
```

在浏览器打开即可使用！这是你的网站公网地址。

### 5. （可选）绑定自定义域名
在 Cloudflare Dashboard：
1. 进入 **Workers & Pages** → 找到 `cloud-chat-rooms`
2. 点击 **设置 → 域和路由 → 添加**，选择已接入 Cloudflare 的域名
3. 例如添加 `chat.example.com`，即可用 `https://chat.example.com` 访问

---

## 三、通过 GitHub 实现自动部署

这样每次 `git push` 到 `main` 分支，都会自动重新部署。

### 1. 上传代码到 GitHub

```bash
git init
git add .
git commit -m "初始化云聊项目"
git branch -M main
git remote add origin https://github.com/<你的用户名>/<仓库名>.git
git push -u origin main
```

### 2. 在 GitHub 仓库配置密钥（Secrets）

进入仓库 **Settings → Secrets and variables → Actions → New repository secret**，添加两个：

| Secret 名称 | 值 |
|-------------|-----|
| `CLOUDFLARE_API_TOKEN` | Cloudflare 的 API Token（见下方第 3 步） |
| `CLOUDFLARE_ACCOUNT_ID` | 你的 Account ID（`wrangler whoami` 显示） |

> 生产环境建议另外添加 Secret `ADMIN_PASSWORD` 覆盖默认的管理员密码（默认值为 `520812cc`，见 `wrangler.jsonc` 的 `vars`）。

---

## 三、管理员功能

管理员可在任意房间登录后**删除聊天记录**与**发布系统公告**。

### 使用方式
1. 进入任意房间后，点击聊天页右上角的 **「管理」** 按钮
2. 输入管理员密码（默认 `520812cc`，生产请改为自己的 Secret）登录
3. 登录后：
   - 将鼠标悬停在任意一条消息上，会显示 **「删除」**（删这条）与 **「删除TA全部」**（删该用户全部消息）按钮
   - 在管理面板中可输入文字并点击 **「发布公告」**，公告会以系统消息广播给房间所有人

### 相关 API
| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/admin/login` | 校验管理员密码，`{ password }` |
| `POST` | `/api/admin/rooms/:code/messages/delete` | 删除消息，`{ password, ids: [..] }` 或 `{ password, user }` |
| `POST` | `/api/admin/rooms/:code/announce` | 发布公告，`{ password, text }` |

> 密码通过环境变量 `ADMIN_PASSWORD` 读取，若未设置则管理功能不可用。前端密码仅保存在浏览器内存中，刷新后需重新登录。

### 3. 创建 Cloudflare API Token

1. 打开 https://dash.cloudflare.com/profile/api-tokens
2. 点击 **创建令牌（Create Token）**
3. 选择模板 **“编辑 Cloudflare Workers（Edit Cloudflare Workers）”**
4. 账户资源选择你的账号，区域资源选择 **所有区域（All zones）**（或仅你绑定域名的那个 zone）
5. 创建后**立即复制** Token 值（只显示一次），填入上面的 `CLOUDFLARE_API_TOKEN`

### 4. 之后每次推送自动部署

```bash
git add .
git commit -m "更新功能"
git push
```

GitHub Actions 会自动执行 `.github/workflows/deploy.yml`，构建并部署到 Cloudflare Workers。

---

## 四、项目结构

```
├── public/                    # 前端静态页面（需 build 打包）
│   ├── index.html             # 主页面（入口 + 聊天室）
│   ├── style.css              # 样式
│   └── app.js                 # 前端逻辑（WebSocket、房间交互）
├── src/
│   ├── index.ts               # Worker 入口（REST API + WS 升级 + 静态资源）
│   ├── room.ts                # Room Durable Object（房间聊天核心）
│   ├── registry.ts            # RoomRegistry Durable Object（房间号登记）
│   ├── asset-store.ts         # 静态资源服务
│   └── assets.ts              # 自动生成：打包后的静态资源
├── build.mjs                  # 前端打包脚本
├── wrangler.jsonc             # Cloudflare Worker 配置
├── package.json
└── .github/workflows/deploy.yml  # GitHub 自动部署
```

## 五、核心机制说明

- **创建房间**：前端调用 `POST /api/rooms`，`RoomRegistry`（全局单例 DO）生成不重复的 6 位房间号并存入 SQLite。
- **加入房间**：前端调用 `GET /api/rooms/:code` 校验，再通过 `GET /ws?room=CODE&name=昵称` 建立 WebSocket。
- **实时通信**：每个房间一个 `Room` DO 实例（按房间号 `idFromName` 确定性路由），管理所有 WebSocket 连接并广播消息。
- **历史记录**：消息写入 DO 的 SQLite，新用户加入时回放最近 100 条。
- **在线人数**：实时推送房间在线用户数量。

## 六、常见问题（FAQ）

**Q: 访问出现 404 / 页面空白？**
A: 确保执行了 `npm run build` 后再 `deploy`，否则 `src/assets.ts` 不存在，静态页面无法加载。

**Q: 如何重置 / 清除房间数据？**
A: 在 Cloudflare Dashboard → Workers & Pages → 你的 Worker → **Durable Objects** → 删除对应的 DO 实例即可。

**Q: 可以部署在别的地方吗？**
A: 可以。核心是 Cloudflare Workers。若你想用 Cloudflare Pages 托管前端 + Workers 做后端，只需把前端改用绝对后端地址（`app.js` 中的 `urlBase()` 指向 Worker 域名）即可，本文按“单 Worker”方案部署以简化流程。

**Q: 自定义域名如何启用 WebSocket？**
A: Cloudflare 默认开启 WebSocket。若不行，检查该域名所属 Zone 的 **Network → WebSockets** 是否为开启状态。

---

完成以上步骤后，你的聊天网站就可以上线，和任何人在网上实时对话了。祝你使用愉快！
