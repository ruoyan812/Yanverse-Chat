/**
 * Room —— 每个房间一个 Durable Object 实例
 *
 * 职责：
 *  - 管理该房间的所有 WebSocket 连接
 *  - 将消息持久化到 SQLite（保留最近 200 条，作为历史记录）
 *  - 广播消息 / 用户加入 / 用户离开 给房间内所有连接
 *
 * 所有消息格式（JSON）：
 *  { type: "message", user, text, time }
 *  { type: "system",  text, time }
 *  { type: "history", messages: [...] }
 *  { type: "users",   users: [...], count }
 */

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index";
import { notifyNewMessage } from "./webhook";

export interface ChatMessage {
  id?: number;
  type: "message" | "system";
  user: string;
  text: string;
  time: number;
}

interface WSUser {
  ws: WebSocket;
  name: string;
  joinedAt: number;
}

/**
 * 判断昵称是否被禁止使用。
 * 昵称不能为"游客"/"Guest"或包含这些字样。
 */
export function isForbiddenName(name: string): boolean {
  const lower = (name || "").toLowerCase();
  return lower.includes("游客") || lower.includes("guest");
}

export class Room extends DurableObject<Env> {
  private sessions = new Map<WebSocket, WSUser>();
  private nameCount = new Map<string, number>(); // 昵称 -> 在线数量（用于处理重名）
  private lastLeaveAt = new Map<string, number>(); // 昵称 -> 最近离开时间（用于识别刷新重连）
  private maxConnections = 200;
  // 房间号：在 fetch() 时从请求 URL 解析（DO 实例由 room.idFromName(code) 确定性创建）
  private roomCode = "";
  private resetting = false; // 重置进行中：踢人时跳过“X 退出了房间”系统消息

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT NOT NULL DEFAULT 'message',
          user TEXT NOT NULL,
          text TEXT NOT NULL,
          time INTEGER NOT NULL
        )
      `);
      // 兼容旧表：若缺少 type 列则补充（老库升级）
      try {
        this.ctx.storage.sql.exec("ALTER TABLE messages ADD COLUMN type TEXT NOT NULL DEFAULT 'message'");
      } catch {
        // 列已存在则忽略
      }
    });
    // 恢复已存在的 WebSocket 会话（DO 休眠后被唤醒时）
    this.ctx.getWebSockets().forEach((ws) => {
      const attachment = ws.deserializeAttachment();
      if (attachment && attachment.name) {
        this.sessions.set(ws, { ws, name: attachment.name, joinedAt: attachment.joinedAt || Date.now() });
        this.nameCount.set(attachment.name, (this.nameCount.get(attachment.name) || 0) + 1);
        // 恢复 roomCode（DO 休眠唤醒后实例变量会丢失）
        if (attachment.roomCode) {
          this.roomCode = attachment.roomCode;
        }
      }
    });
  }

  /** 处理 WebSocket 升级请求（通过 stub.fetch 转发到此） */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader !== "websocket") {
      return new Response("Expected websocket upgrade", { status: 426 });
    }
    if (request.method !== "GET") {
      return new Response("Expected GET", { status: 400 });
    }

    const name = (url.searchParams.get("name") || "").trim().slice(0, 36);
    if (!name) {
      return new Response("Missing name", { status: 400 });
    }
    if (isForbiddenName(name)) {
      return new Response("该昵称不可使用", { status: 400 });
    }

    // 记录房间号（用于修改房间名等场景）
    this.roomCode = (url.searchParams.get("room") || "").toUpperCase() || this.roomCode;
    // 新连接进入即视为重置流程结束（避免残留的 resetting 影响后续退出消息）
    this.resetting = false;

    // 检查房间是否已被管理员关闭
    if (this.roomCode) {
      const registry = this.env.REGISTRY.get(this.env.REGISTRY.idFromName("global"));
      const info = await registry.getRoomInfo(this.roomCode);
      if (info && info.closed) {
        return new Response("房间已关闭，暂时无法进入", { status: 403 });
      }
    }

    if (this.sessions.size >= this.maxConnections) {
      return new Response("房间人数已满", { status: 503 });
    }

    // 名字保持用户输入原样：刷新重连时名字不变；允许真实同名多人在线（显示名一致）
    const uniqueName = name;

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);
    // 序列化附件，DO 休眠唤醒后据此恢复会话
    server.serializeAttachment({ name: uniqueName, joinedAt: Date.now(), roomCode: this.roomCode });
    this.sessions.set(server, { ws: server, name: uniqueName, joinedAt: Date.now() });
    this.nameCount.set(uniqueName, (this.nameCount.get(uniqueName) || 0) + 1);

    // 所有消息一律通过服务端（server）WebSocket 发送
    // 发送历史消息
    const history = this.getHistory();
    server.send(JSON.stringify({ type: "history", messages: history }));

    // 广播加入（保持简洁文案）
    this.lastLeaveAt.delete(uniqueName);
    this.broadcastSystem(`${uniqueName} 加入了房间`);
    // 上报在线状态
    this.reportActivity();

    return new Response(null, { status: 101, webSocket: client });
  }

  /** WebSocket 收到消息 */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    const session = this.sessions.get(ws);
    if (!session) return;

    let payload: { text?: string; type?: string; name?: string };
    try {
      payload = JSON.parse(message);
    } catch {
      return;
    }

    // 修改昵称
    if (payload.type === "rename") {
      const newName = (payload.name || "").toString().trim().slice(0, 36);
      if (isForbiddenName(newName)) {
        this.sendTo(ws, { type: "renamed", name: newName, error: "该昵称不可使用" });
        return;
      }
      if (!newName || newName === session.name) return;
      const oldName = session.name;

      // 更新会话昵称与重名计数
      session.name = newName;
      this.sessions.set(ws, session);
      ws.serializeAttachment({ name: newName, joinedAt: session.joinedAt });
      const oldLeft = (this.nameCount.get(oldName) || 1) - 1;
      if (oldLeft <= 0) this.nameCount.delete(oldName);
      else this.nameCount.set(oldName, oldLeft);
      this.nameCount.set(newName, (this.nameCount.get(newName) || 0) + 1);

      // 确认给本人
      this.sendTo(ws, { type: "renamed", name: newName });
      this.broadcastSystem(`${oldName} 改名为 ${newName}`);
      return;
    }

    // 修改房间名
    if (payload.type === "renameRoom") {
      const newName = (payload.name || "").toString().trim().slice(0, 30);
      if (!newName) return;
      const code = this.roomCode;
      const registry = this.env.REGISTRY.get(this.env.REGISTRY.idFromName("global"));
      let updated;
      try {
        updated = await registry.renameRoom(code, newName);
      } catch (e) {
        // 默认房间不可改名
        this.sendTo(ws, { type: "roomRenameError", message: (e as Error).message });
        return;
      }
      if (!updated) return;
      // 通知房间内所有成员更新房名显示
      this.broadcast({ type: "roomRenamed", name: updated.name, code });
      this.broadcastSystem(`房间名已改为「${updated.name}」`);
      return;
    }

    const text = (payload.text || "").toString().trim();
    if (!text || text.length > 2000) return;

    // 房间被关闭后禁止发消息（同时获取房间名用于 Webhook 通知）
    let roomName = this.roomCode;
    if (this.roomCode) {
      const registry = this.env.REGISTRY.get(this.env.REGISTRY.idFromName("global"));
      const info = await registry.getRoomInfo(this.roomCode);
      if (info) {
        roomName = info.name;
        if (info.closed) {
          this.sendTo(ws, { type: "roomClosed" });
          return;
        }
      }
    }

    const chatMsg: ChatMessage = {
      type: "message",
      user: session.name,
      text,
      time: Date.now(),
    };

    this.persistMessage(chatMsg);
    this.broadcast(chatMsg);
    // 推送新消息通知到企业微信机器人
    notifyNewMessage(this.ctx, this.env.WEBHOOK_URL, this.roomCode, roomName, session.name, text);
    // 发消息即视为活跃，上报在线状态
    this.reportActivity();
  }

  /** 连接关闭/错误时清理 */
  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    this.cleanup(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.cleanup(ws);
  }

  // ---------- 管理方法（由管理 API 通过 RPC 调用） ----------

  /** 按消息 id 删除指定消息，并广播删除事件让所有客户端同步 */
  adminDeleteMessages(ids: number[]): { deleted: number } {
    const validIds = Array.isArray(ids) ? ids.filter((i) => Number.isFinite(i)).map(Number) : [];
    let deleted = 0;
    for (const id of validIds) {
      const res = this.ctx.storage.sql.exec("DELETE FROM messages WHERE id = ?", id);
      deleted += Number(res.rowsWritten || 0);
    }
    if (deleted > 0) {
      this.broadcast({ type: "adminDelete", ids: validIds });
    }
    return { deleted };
  }

  /** 删除某个用户的所有消息，并广播删除事件让所有客户端同步 */
  adminDeleteUserMessages(user: string): { deleted: number } {
    const u = (user || "").trim().slice(0, 36);
    if (!u) return { deleted: 0 };
    const res = this.ctx.storage.sql.exec("DELETE FROM messages WHERE user = ?", u);
    const deleted = Number(res.rowsWritten || 0);
    if (deleted > 0) {
      this.broadcast({ type: "adminDeleteUser", user: u, deleted });
      this.broadcastSystem(`管理员已删除用户「${u}」的 ${deleted} 条消息`);
    }
    return { deleted };
  }

  /** 发布系统公告（管理员） */
  adminAnnounce(text: string): ChatMessage | null {
    const t = (text || "").toString().trim().slice(0, 2000);
    if (!t) return null;
    const time = Date.now();
    const msg: ChatMessage = { type: "system", user: "系统", text: `【公告】${t}`, time };
    this.persistMessage(msg);
    this.broadcast(msg);
    return msg;
  }

  /**
   * 关闭房间（管理员）：禁止新用户进入、踢出所有在线用户、广播关闭事件。
   * 返回当前在线人数（被踢出的人数）。
   */
  async adminClose(code: string): Promise<{ closed: boolean; kicked: number }> {
    const roomCode = (code || this.roomCode).toUpperCase();
    const registry = this.env.REGISTRY.get(this.env.REGISTRY.idFromName("global"));
    await registry.setRoomClosed(roomCode, true);

    const kicked = this.sessions.size;
    // 广播关闭事件，客户端据此弹出提示并断开
    this.broadcast({ type: "roomClosed" });
    // 关闭所有连接
    for (const session of this.sessions.values()) {
      try {
        session.ws.close(1000, "room closed");
      } catch {
        // 忽略
      }
    }
    return { closed: true, kicked };
  }

  /** 重新打开房间（管理员） */
  async adminOpen(code: string): Promise<{ closed: boolean }> {
    const roomCode = (code || this.roomCode).toUpperCase();
    const registry = this.env.REGISTRY.get(this.env.REGISTRY.idFromName("global"));
    await registry.setRoomClosed(roomCode, false);
    this.broadcast({ type: "roomOpened" });
    this.broadcastSystem("房间已被管理员重新打开");
    return { closed: false };
  }

  // 重置房间：踢出所有在线用户并清空全部聊天记录（含系统消息）
  async adminReset(code: string): Promise<{ kicked: number; cleared: number }> {
    const roomCode = (code || this.roomCode).toUpperCase();
    // 标记重置中，避免踢人时 cleanup 写入“X 退出了房间”的系统消息
    this.resetting = true;
    const kicked = this.sessions.size;
    // 先通知所有在线客户端房间已重置（该消息不持久化）
    this.broadcast({ type: "roomReset" });
    // 踢出所有在线用户
    for (const session of this.sessions.values()) {
      try { session.ws.close(1000, "room reset"); } catch {}
    }
    // 清空所有聊天记录（含系统消息）
    const res = this.ctx.storage.sql.exec("DELETE FROM messages");
    const cleared = Number(res.rowsWritten || 0);
    await this.reportActivity();
    return { kicked, cleared };
  }

  // ---------- 内部方法 ----------

  private cleanup(ws: WebSocket): void {
    const session = this.sessions.get(ws);
    if (!session) return;

    this.sessions.delete(ws);
    const left = (this.nameCount.get(session.name) || 1) - 1;
    if (left <= 0) {
      this.nameCount.delete(session.name);
    } else {
      this.nameCount.set(session.name, left);
    }

    // 记录离开时间（供改名等场景使用），并立即广播简洁退出消息
    this.lastLeaveAt.set(session.name, Date.now());
    if (!this.resetting) {
      this.broadcastSystem(`${session.name} 退出了房间`);
    }
    // 上报在线状态
    this.reportActivity();
  }

  private broadcast(data: object): void {
    const payload = JSON.stringify(data);
    for (const session of this.sessions.values()) {
      try {
        session.ws.send(payload);
      } catch {
        // 发送失败，稍后由 close 清理
      }
    }
  }

  private sendTo(ws: WebSocket, data: object): void {
    try {
      ws.send(JSON.stringify(data));
    } catch {
      // 忽略
    }
  }

  /** 向全局登记表上报本房间的在线人数与最后活跃时间（用于"在线房间"判定） */
  private reportActivity(): void {
    const registry = this.env.REGISTRY.get(this.env.REGISTRY.idFromName("global"));
    // 异步上报，不阻塞当前请求
    void registry
      .updateActivity(this.roomCode, this.sessions.size, Date.now())
      .catch(() => {});
  }

  private broadcastSystem(text: string): void {
    const time = Date.now();
    const sysMsg: ChatMessage = { type: "system", user: "系统", text, time };
    // 系统消息也保存为聊天记录
    this.persistMessage(sysMsg);
    this.broadcast(sysMsg);
    // 也推送在线人数
    this.broadcast({
      type: "users",
      count: this.sessions.size,
      users: [...this.sessions.values()].map((s) => s.name),
    });
  }

  private persistMessage(msg: ChatMessage): number | null {
    this.ctx.storage.sql.exec(
      "INSERT INTO messages (type, user, text, time) VALUES (?, ?, ?, ?)",
      msg.type,
      msg.user,
      msg.text,
      msg.time
    );
    const row = this.ctx.storage.sql
      .exec<{ id: number }>("SELECT last_insert_rowid() AS id")
      .one();
    const id = row ? Number(row.id) : null;
    if (id != null) msg.id = id;
    // 只保留最近 300 条，防止无限增长
    this.ctx.storage.sql.exec(
      "DELETE FROM messages WHERE id NOT IN (SELECT id FROM messages ORDER BY id DESC LIMIT 300)"
    );
    return id;
  }

  private getHistory(): ChatMessage[] {
    const rows = this.ctx.storage.sql
      .exec<{ id: number; type: string; user: string; text: string; time: number }>(
        "SELECT id, type, user, text, time FROM messages ORDER BY id DESC LIMIT 100"
      )
      .toArray();
    return rows.reverse().map((r) => ({
      id: r.id,
      type: (r.type === "system" ? "system" : "message") as "message" | "system",
      user: r.user,
      text: r.text,
      time: r.time,
    }));
  }
}
