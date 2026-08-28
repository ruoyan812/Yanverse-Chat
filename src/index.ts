/**
 * cloud-chat-rooms
 * 基于 Cloudflare Workers + Durable Objects 的实时聊天网站
 *
 * Worker 入口：负责
 *  1. REST API —— 创建房间 / 查询房间信息 / 校验房间
 *  2. WebSocket 升级 —— 客户端连接到指定房间
 */

import { Room, isForbiddenName } from "./room";
import { RoomRegistry } from "./registry";
import { serveAsset } from "./asset-store";
import { notifyRoomCreated } from "./webhook";

// 重新导出 Durable Object 类（wrangler 要求从入口导出）
export { Room } from "./room";
export { RoomRegistry } from "./registry";

export interface Env {
  ROOM: DurableObjectNamespace<Room>;
  REGISTRY: DurableObjectNamespace<RoomRegistry>;
  /** 管理员密码（通过 wrangler secret 或环境变量设置），未设置则管理员功能不可用 */
  ADMIN_PASSWORD?: string;
  /** 企业微信机器人 Webhook 地址，用于推送房间创建/新消息通知 */
  WEBHOOK_URL?: string;
}

/** 校验管理员密码，返回是否通过 */
function isAdminRequest(env: Env, password?: string): boolean {
  if (!env.ADMIN_PASSWORD) return false;
  if (!password) return false;
  // 恒定时间比较，避免时序攻击
  const a = String(password);
  const b = String(env.ADMIN_PASSWORD);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const DEFAULT_MAX_NAME = 30;
const DEFAULT_MAX_MESSAGE = 2000;

function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** 生成一个可读的房间号（6 位大写字母+数字，去除易混淆字符） */
function randomRoomCode(length = 6): string {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < length; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

async function handleRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

    // 允许跨域（前后端分离部署时使用）
    const corsHeaders: Record<string, string> = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // ---------- REST API ----------

    // POST /api/rooms 创建房间 { name }
    if (path === "/api/rooms" && request.method === "POST") {
      let body: any = {};
      try {
        body = await request.json();
      } catch {
        return json({ error: "无效的请求体" }, 400, corsHeaders);
      }
      const name = (body.name || "").toString().trim().slice(0, DEFAULT_MAX_NAME);
      if (!name) {
        return json({ error: "房间名称不能为空" }, 400, corsHeaders);
      }
      const registry = env.REGISTRY.get(env.REGISTRY.idFromName("global"));
      const created = await registry.createRoom(name);
      // 推送房间创建通知到企业微信机器人
      notifyRoomCreated(ctx, env.WEBHOOK_URL, created.code, created.name);
      return json(created, 201, corsHeaders);
    }

    // GET /api/rooms 列出所有在线房间（有人的房间 且 5 分钟内有人发消息）
    if (path === "/api/rooms" && request.method === "GET") {
      const registry = env.REGISTRY.get(env.REGISTRY.idFromName("global"));
      const rooms = await registry.listOnlineRooms();
      return json({ rooms }, 200, corsHeaders);
    }

    // GET /api/rooms/search?q=关键词 按房间名搜索在线房间
    if (path === "/api/rooms/search" && request.method === "GET") {
      const q = (url.searchParams.get("q") || "").trim().slice(0, 30);
      const registry = env.REGISTRY.get(env.REGISTRY.idFromName("global"));
      const rooms = q ? await registry.searchOnlineRooms(q) : await registry.listOnlineRooms();
      return json({ rooms }, 200, corsHeaders);
    }

    // GET /api/rooms/:code 查询房间信息
    const roomMatch = path.match(/^\/api\/rooms\/([A-Za-z0-9]+)$/);
    if (roomMatch && request.method === "GET") {
      const code = roomMatch[1].toUpperCase();
      const registry = env.REGISTRY.get(env.REGISTRY.idFromName("global"));
      // 特殊：GET /api/rooms/default 返回（并确保）默认房间
      if (code === "DEFAULT") {
        const def = await registry.ensureDefaultRoom();
        return json(def, 200, corsHeaders);
      }
      const info = await registry.getRoomInfo(code);
      if (!info) {
        return json({ error: "房间不存在" }, 404, corsHeaders);
      }
      return json(info, 200, corsHeaders);
    }

    // PATCH /api/rooms/:code 修改房间名 { name }
    if (roomMatch && request.method === "PATCH") {
      const code = roomMatch[1].toUpperCase();
      let body: any = {};
      try {
        body = await request.json();
      } catch {
        return json({ error: "无效的请求体" }, 400, corsHeaders);
      }
      const name = (body.name || "").toString().trim().slice(0, DEFAULT_MAX_NAME);
      if (!name) {
        return json({ error: "房间名称不能为空" }, 400, corsHeaders);
      }
      const registry = env.REGISTRY.get(env.REGISTRY.idFromName("global"));
      try {
        const updated = await registry.renameRoom(code, name);
        if (!updated) {
          return json({ error: "房间不存在" }, 404, corsHeaders);
        }
        return json(updated, 200, corsHeaders);
      } catch (e) {
        return json({ error: (e as Error).message }, 400, corsHeaders);
      }
    }

    // ---------- 管理员 API ----------

    // POST /api/admin/login 校验管理员密码 { password }
    if (path === "/api/admin/login" && request.method === "POST") {
      let body: any = {};
      try {
        body = await request.json();
      } catch {
        return json({ error: "无效的请求体" }, 400, corsHeaders);
      }
      if (isAdminRequest(env, body.password)) {
        return json({ ok: true }, 200, corsHeaders);
      }
      return json({ error: "密码错误" }, 401, corsHeaders);
    }

    // POST /api/admin/rooms/:code/messages/delete 删除消息
    // body: { password, ids?: number[] } 或 { password, user?: string }
    const adminDeleteMatch = path.match(/^\/api\/admin\/rooms\/([A-Za-z0-9]+)\/messages\/delete$/);
    if (adminDeleteMatch && request.method === "POST") {
      const code = adminDeleteMatch[1].toUpperCase();
      let body: any = {};
      try {
        body = await request.json();
      } catch {
        return json({ error: "无效的请求体" }, 400, corsHeaders);
      }
      if (!isAdminRequest(env, body.password)) {
        return json({ error: "密码错误" }, 401, corsHeaders);
      }
      const registry = env.REGISTRY.get(env.REGISTRY.idFromName("global"));
      const info = await registry.getRoomInfo(code);
      if (!info) {
        return json({ error: "房间不存在" }, 404, corsHeaders);
      }
      const room = env.ROOM.get(env.ROOM.idFromName(code));
      if (Array.isArray(body.ids) && body.ids.length > 0) {
        const ids = body.ids.filter((i: unknown) => Number.isFinite(Number(i))).map(Number);
        const result = await room.adminDeleteMessages(ids);
        return json(result, 200, corsHeaders);
      }
      if (body.user) {
        const result = await room.adminDeleteUserMessages(String(body.user));
        return json(result, 200, corsHeaders);
      }
      return json({ error: "请提供要删除的 ids 或 user" }, 400, corsHeaders);
    }

    // POST /api/admin/rooms/:code/announce 发布系统公告 { password, text }
    const adminAnnounceMatch = path.match(/^\/api\/admin\/rooms\/([A-Za-z0-9]+)\/announce$/);
    if (adminAnnounceMatch && request.method === "POST") {
      const code = adminAnnounceMatch[1].toUpperCase();
      let body: any = {};
      try {
        body = await request.json();
      } catch {
        return json({ error: "无效的请求体" }, 400, corsHeaders);
      }
      if (!isAdminRequest(env, body.password)) {
        return json({ error: "密码错误" }, 401, corsHeaders);
      }
      const registry = env.REGISTRY.get(env.REGISTRY.idFromName("global"));
      const info = await registry.getRoomInfo(code);
      if (!info) {
        return json({ error: "房间不存在" }, 404, corsHeaders);
      }
      const room = env.ROOM.get(env.ROOM.idFromName(code));
      const msg = await room.adminAnnounce(String(body.text || ""));
      if (!msg) {
        return json({ error: "公告内容不能为空" }, 400, corsHeaders);
      }
      return json(msg, 200, corsHeaders);
    }

    // GET /api/rooms/:code 公开查询房间状态（无需管理员密码），
    // 用于前端在进入前判断房间是否已关闭/是否存在，避免无效重连
    const roomInfoMatch = path.match(/^\/api\/rooms\/([A-Za-z0-9]+)$/);
    if (roomInfoMatch && request.method === "GET") {
      const code = roomInfoMatch[1].toUpperCase();
      const registry = env.REGISTRY.get(env.REGISTRY.idFromName("global"));
      const info = await registry.getRoomInfo(code);
      if (!info) {
        return json({ error: "房间不存在" }, 404, corsHeaders);
      }
      return json({ code: info.code, name: info.name, closed: !!info.closed }, 200, corsHeaders);
    }

    // GET /api/admin/rooms/:code 查询房间状态（管理员）
    const adminRoomMatch = path.match(/^\/api\/admin\/rooms\/([A-Za-z0-9]+)$/);
    if (adminRoomMatch && request.method === "GET") {
      const code = adminRoomMatch[1].toUpperCase();
      if (!isAdminRequest(env, request.headers.get("x-admin-password") || "")) {
        return json({ error: "密码错误" }, 401, corsHeaders);
      }
      const registry = env.REGISTRY.get(env.REGISTRY.idFromName("global"));
      const info = await registry.getRoomInfo(code);
      if (!info) {
        return json({ error: "房间不存在" }, 404, corsHeaders);
      }
      return json({ code: info.code, name: info.name, closed: info.closed }, 200, corsHeaders);
    }

    // POST /api/admin/rooms/:code/close 关闭房间（管理员）
    // body: { password }
    const adminCloseMatch = path.match(/^\/api\/admin\/rooms\/([A-Za-z0-9]+)\/close$/);
    if (adminCloseMatch && request.method === "POST") {
      const code = adminCloseMatch[1].toUpperCase();
      let body: any = {};
      try {
        body = await request.json();
      } catch {
        return json({ error: "无效的请求体" }, 400, corsHeaders);
      }
      if (!isAdminRequest(env, body.password)) {
        return json({ error: "密码错误" }, 401, corsHeaders);
      }
      const registry = env.REGISTRY.get(env.REGISTRY.idFromName("global"));
      const info = await registry.getRoomInfo(code);
      if (!info) {
        return json({ error: "房间不存在" }, 404, corsHeaders);
      }
      const room = env.ROOM.get(env.ROOM.idFromName(code));
      const result = await room.adminClose(code);
      return json(result, 200, corsHeaders);
    }

    // POST /api/admin/rooms/:code/open 重新打开房间（管理员）
    // body: { password }
    const adminOpenMatch = path.match(/^\/api\/admin\/rooms\/([A-Za-z0-9]+)\/open$/);
    if (adminOpenMatch && request.method === "POST") {
      const code = adminOpenMatch[1].toUpperCase();
      let body: any = {};
      try {
        body = await request.json();
      } catch {
        return json({ error: "无效的请求体" }, 400, corsHeaders);
      }
      if (!isAdminRequest(env, body.password)) {
        return json({ error: "密码错误" }, 401, corsHeaders);
      }
      const registry = env.REGISTRY.get(env.REGISTRY.idFromName("global"));
      const info = await registry.getRoomInfo(code);
      if (!info) {
        return json({ error: "房间不存在" }, 404, corsHeaders);
      }
      const room = env.ROOM.get(env.ROOM.idFromName(code));
      const result = await room.adminOpen(code);
      return json(result, 200, corsHeaders);
    }

    // POST /api/admin/rooms/:code/reset 重置房间（踢出所有用户并清空聊天记录，管理员）
    // body: { password }
    const adminResetMatch = path.match(/^\/api\/admin\/rooms\/([A-Za-z0-9]+)\/reset$/);
    if (adminResetMatch && request.method === "POST") {
      const code = adminResetMatch[1].toUpperCase();
      let body: any = {};
      try {
        body = await request.json();
      } catch {
        return json({ error: "无效的请求体" }, 400, corsHeaders);
      }
      if (!isAdminRequest(env, body.password)) {
        return json({ error: "密码错误" }, 401, corsHeaders);
      }
      const registry = env.REGISTRY.get(env.REGISTRY.idFromName("global"));
      const info = await registry.getRoomInfo(code);
      if (!info) {
        return json({ error: "房间不存在" }, 404, corsHeaders);
      }
      const room = env.ROOM.get(env.ROOM.idFromName(code));
      const result = await room.adminReset(code);
      return json(result, 200, corsHeaders);
    }

    // GET /api/health
    if (path === "/api/health") {
      return json({ ok: true }, 200, corsHeaders);
    }

    // ---------- WebSocket 升级 ----------
    // GET /ws?room=CODE&name=用户名
    if (path === "/ws" && request.method === "GET") {
      const code = (url.searchParams.get("room") || "").toUpperCase();
      const name = (url.searchParams.get("name") || "").trim().slice(0, 36);

      if (!code || !/^[A-Z0-9]{4,12}$/.test(code)) {
        return json({ error: "无效的房间号" }, 400, corsHeaders);
      }
      if (!name) {
        return json({ error: "请输入你的昵称" }, 400, corsHeaders);
      }
      if (isForbiddenName(name)) {
        return json({ error: "该昵称不可使用" }, 400, corsHeaders);
      }

      // 校验房间是否存在
      const registry = env.REGISTRY.get(env.REGISTRY.idFromName("global"));
      const info = await registry.getRoomInfo(code);
      if (!info) {
        return json({ error: "房间不存在，请检查房间号" }, 404, corsHeaders);
      }

      // 通过房间号获取对应 Room DO 实例（确定性路由）
      const roomId = env.ROOM.idFromName(code);
      const room = env.ROOM.get(roomId);

      // 将请求转发给 Room DO 的 fetch() 处理器处理 WebSocket 升级
      // （DO 会从请求 URL 的查询参数中解析房间号与昵称）
      return room.fetch(request);
    }

    // ---------- 前端静态资源 ----------
    // 非 /api、/ws 的请求一律返回打包好的前端页面
    const asset = serveAsset(url.pathname);
    if (asset) {
      // 合并 CORS 头（静态资源一般不需要，但保留兼容）
      for (const [k, v] of Object.entries(corsHeaders)) {
        asset.headers.set(k, v);
      }
      return asset;
    }

    // SPA 回退：未匹配到资源时返回 index.html（支持前端路由，当前为单页无需）
    return serveAsset("/") || json({ error: "Not Found" }, 404, corsHeaders);
}

export default {
  fetch: handleRequest,
};
