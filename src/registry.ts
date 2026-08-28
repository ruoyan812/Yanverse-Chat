/**
 * RoomRegistry —— 全局房间登记表
 *
 * 单例 Durable Object，负责：
 *  - 分配房间号（避免冲突）
 *  - 保存 房间号 -> 房间名 的映射
 *  - 查询房间信息
 *
 * 使用 SQLite 持久化，保证房间号在所有请求间一致、可恢复。
 */

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index";

export interface RoomInfo {
  code: string;
  name: string;
  createdAt: number;
  /** 房间是否已被管理员关闭（关闭后禁止新用户进入、禁止发消息） */
  closed: boolean;
}

export interface OnlineRoom extends RoomInfo {
  onlineCount: number;
  lastActiveAt: number;
}

// 默认房间号（保留，不可改名）
export const DEFAULT_ROOM_CODE = "YAN812";
export const DEFAULT_ROOM_NAME = "Yanverse";

// 判定"在线"的活跃时间窗口（毫秒）：5 分钟内有人发消息才算活跃
export const ONLINE_ACTIVE_WINDOW_MS = 5 * 60 * 1000;

const CODE_LENGTH = 6;

function randomCode(): string {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

export class RoomRegistry extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS rooms (
          code TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          online_count INTEGER NOT NULL DEFAULT 0,
          last_active_at INTEGER NOT NULL DEFAULT 0,
          closed_at INTEGER
        )
      `);
      // 兼容旧表：补充在线统计字段
      try {
        this.ctx.storage.sql.exec("ALTER TABLE rooms ADD COLUMN online_count INTEGER NOT NULL DEFAULT 0");
      } catch {
        // 已存在
      }
      try {
        this.ctx.storage.sql.exec("ALTER TABLE rooms ADD COLUMN last_active_at INTEGER NOT NULL DEFAULT 0");
      } catch {
        // 已存在
      }
      try {
        this.ctx.storage.sql.exec("ALTER TABLE rooms ADD COLUMN closed_at INTEGER");
      } catch {
        // 已存在
      }
    });
  }

  /** 创建一个房间，返回 { code, name, createdAt } */
  async createRoom(name: string): Promise<RoomInfo> {
    // 最多尝试 5 次生成不冲突的房间号
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = randomCode();
      const exists = this.ctx.storage.sql
        .exec<{ c: number }>("SELECT COUNT(*) as c FROM rooms WHERE code = ?", code)
        .one().c;
      if (exists === 0) {
        const createdAt = Date.now();
        this.ctx.storage.sql.exec(
          "INSERT INTO rooms (code, name, created_at) VALUES (?, ?, ?)",
          code,
          name,
          createdAt
        );
        return { code, name, createdAt, closed: false };
      }
    }
    throw new Error("无法生成唯一房间号，请重试");
  }

  /** 按房间号查询房间信息，不存在返回 null */
  async getRoomInfo(code: string): Promise<RoomInfo | null> {
    const rows = this.ctx.storage.sql
      .exec<{ code: string; name: string; created_at: number; closed_at: number | null }>(
        "SELECT code, name, created_at, closed_at FROM rooms WHERE code = ?",
        code
      )
      .toArray();
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      code: r.code,
      name: r.name,
      createdAt: r.created_at,
      closed: r.closed_at != null,
    };
  }

  /** 设置房间的关闭状态（closed=true 关闭，false 重新打开），房间不存在返回 false */
  async setRoomClosed(code: string, closed: boolean): Promise<boolean> {
    const exists = await this.getRoomInfo(code);
    if (!exists) return false;
    if (closed) {
      this.ctx.storage.sql.exec(
        "UPDATE rooms SET closed_at = ? WHERE code = ?",
        Date.now(),
        code
      );
    } else {
      this.ctx.storage.sql.exec("UPDATE rooms SET closed_at = NULL WHERE code = ?", code);
    }
    return true;
  }

  /** 修改房间名，返回更新后的房间信息；房间不存在返回 null；默认房间不可修改 */
  async renameRoom(code: string, newName: string): Promise<RoomInfo | null> {
    if (code === DEFAULT_ROOM_CODE) {
      throw new Error("默认房间不可修改名称");
    }
    const exists = await this.getRoomInfo(code);
    if (!exists) return null;
    this.ctx.storage.sql.exec(
      "UPDATE rooms SET name = ? WHERE code = ?",
      newName,
      code
    );
    return { code, name: newName, createdAt: exists.createdAt, closed: exists.closed };
  }

  /** 确保默认房间存在；不存在则创建。返回房间信息 */
  async ensureDefaultRoom(): Promise<RoomInfo> {
    const exists = await this.getRoomInfo(DEFAULT_ROOM_CODE);
    if (exists) return exists;
    const createdAt = Date.now();
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO rooms (code, name, created_at, online_count, last_active_at) VALUES (?, ?, ?, 0, ?)",
      DEFAULT_ROOM_CODE,
      DEFAULT_ROOM_NAME,
      createdAt,
      createdAt
    );
    const info = await this.getRoomInfo(DEFAULT_ROOM_CODE);
    if (!info) {
      throw new Error("无法初始化默认房间");
    }
    return info;
  }

  /** 由 Room DO 上报房间活动状态（在线人数 + 最后活跃时间） */
  async updateActivity(code: string, onlineCount: number, lastActiveAt: number): Promise<void> {
    this.ctx.storage.sql.exec(
      "UPDATE rooms SET online_count = ?, last_active_at = ? WHERE code = ?",
      Math.max(0, onlineCount),
      lastActiveAt,
      code
    );
  }

  /** 按房间名搜索在线房间（房间内有人 且 5 分钟内有人发消息），按活跃时间倒序 */
  async searchOnlineRooms(query: string): Promise<OnlineRoom[]> {
    const cutoff = Date.now() - ONLINE_ACTIVE_WINDOW_MS;
    const like = `%${query}%`;
    const rows = this.ctx.storage.sql
      .exec<{
        code: string;
        name: string;
        created_at: number;
        online_count: number;
        last_active_at: number;
      }>(
        `SELECT code, name, created_at, online_count, last_active_at
         FROM rooms
         WHERE online_count > 0 AND last_active_at > ? AND name LIKE ?
         ORDER BY last_active_at DESC
         LIMIT 20`,
        cutoff,
        like
      )
      .toArray();
    return rows.map((r) => ({
      code: r.code,
      name: r.name,
      createdAt: r.created_at,
      onlineCount: r.online_count,
      lastActiveAt: r.last_active_at,
    }));
  }

  /** 列出所有在线房间（房间内有人 且 5 分钟内有人发消息），按活跃时间倒序 */
  async listOnlineRooms(): Promise<OnlineRoom[]> {
    const cutoff = Date.now() - ONLINE_ACTIVE_WINDOW_MS;
    const rows = this.ctx.storage.sql
      .exec<{
        code: string;
        name: string;
        created_at: number;
        online_count: number;
        last_active_at: number;
      }>(
        `SELECT code, name, created_at, online_count, last_active_at
         FROM rooms
         WHERE online_count > 0 AND last_active_at > ?
         ORDER BY last_active_at DESC
         LIMIT 20`,
        cutoff
      )
      .toArray();
    return rows.map((r) => ({
      code: r.code,
      name: r.name,
      createdAt: r.created_at,
      onlineCount: r.online_count,
      lastActiveAt: r.last_active_at,
    }));
  }
}
