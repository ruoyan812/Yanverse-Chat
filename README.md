# Yanverse Chat 💬 — 实时聊天房间网站

一个基于 **Cloudflare Workers + Durable Objects** 的实时聊天网站。用户可以创建房间，其他人通过**房间名 / 房间号**加入房间，进行多人实时对话。

## 功能特性

- ✨ **创建房间**：输入房间名，一键生成 6 位房间号
- 🔑 **加入房间**：输入房间号即可加入任意房间，实时对话
- 💬 **实时聊天**：基于 WebSocket，消息毫秒级广播给所有人
- 🧑‍🤝‍🧑 **在线人数**：实时显示房间在线用户数
- 📜 **历史消息**：新用户加入自动回放最近 100 条消息
- 🎨 **现代 UI**：深色渐变风格，响应式布局，适配手机

## 技术栈

| 组件 | 技术 |
|------|------|
| 后端 + 实时通信 | Cloudflare Workers + Durable Objects + SQLite |
| 前端 | 原生 HTML/CSS/JS |
| 代码托管 / CI/CD | GitHub + GitHub Actions |

## 快速开始

```bash
npm install        # 安装依赖
npm run build      # 打包前端静态资源
npm run dev        # 本地开发 (http://localhost:8787)
npx wrangler deploy   # 部署上线
```

> 完整部署教程（含 GitHub 自动部署、自定义域名）请查看 **[DEPLOY.md](./DEPLOY.md)**。

## 项目结构

```
public/   前端页面（HTML/CSS/JS）
src/      后端 Worker 与 Durable Objects
build.mjs 前端打包脚本
wrangler.jsonc  Cloudflare 配置
.github/workflows/deploy.yml  自动部署
```

## License

MIT
