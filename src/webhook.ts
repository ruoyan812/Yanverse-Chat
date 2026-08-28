/**
 * 企业微信机器人 Webhook 推送
 *
 * 当有人创建新房间或发送新消息时，自动推送通知到企业微信群机器人。
 * 使用 waitUntil 异步发送，不阻塞主请求流程。
 */

/** 企业微信机器人 Webhook 地址（通过环境变量配置） */
const DEFAULT_WEBHOOK_URL =
  "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=1b3976d0-f3fe-4a82-a05b-7cab8a254611";

/** 发送纯文本消息到企业微信机器人 */
async function sendText(webhookUrl: string, content: string): Promise<void> {
  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        msgtype: "text",
        text: { content },
      }),
    });
  } catch {
    // 推送失败不影响主流程
  }
}

/** 房间创建通知 */
export function notifyRoomCreated(
  ctx: { waitUntil(promise: Promise<unknown>): void },
  webhookUrl: string | undefined,
  roomCode: string,
  roomName: string
): void {
  const url = webhookUrl || DEFAULT_WEBHOOK_URL;
  const now = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
  const content =
    `New Room\n` +
    `Room: ${roomName}\n` +
    `Code: ${roomCode}\n` +
    `Time: ${now}`;

  ctx.waitUntil(sendText(url, content));
}

/** 新消息通知 */
export function notifyNewMessage(
  ctx: { waitUntil(promise: Promise<unknown>): void },
  webhookUrl: string | undefined,
  roomCode: string,
  roomName: string,
  userName: string,
  text: string
): void {
  const url = webhookUrl || DEFAULT_WEBHOOK_URL;
  const now = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
  // 截断过长的消息内容
  const preview = text.length > 200 ? text.slice(0, 200) + "..." : text;
  const content =
    `New Message\n` +
    `Room: ${roomName} (${roomCode})\n` +
    `User: ${userName}\n` +
    `Time: ${now}\n` +
    `Content: ${preview}`;

  ctx.waitUntil(sendText(url, content));
}
