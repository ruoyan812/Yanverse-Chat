/**
 * asset-store.ts —— 从打包的静态资源中提供前端文件
 */
import { assets } from "./assets";

export type AssetEntry = readonly [path: string, { contentType: string; data: string }];

const store = new Map<string, { contentType: string; data: string }>(
  assets.map((a) => [a[0], a[1]])
);

function decode(data: string): Uint8Array {
  const bin = atob(data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** 根据请求路径返回前端静态资源，找不到返回 null */
export function serveAsset(pathname: string): Response | null {
  let key = pathname;
  if (key === "/") key = "/index.html";
  if (!key.startsWith("/")) key = "/" + key;

  let entry = store.get(key);

  // 无扩展名的路径尝试当作目录 / 或 html 文件
  if (!entry && !key.includes(".")) {
    entry = store.get(key + "/index.html") || store.get(key + ".html");
  }

  if (!entry) return null;

  const bytes = decode(entry.data);
  return new Response(bytes, {
    headers: {
      "Content-Type": entry.contentType,
      "Cache-Control": key === "/index.html" ? "no-cache" : "public, max-age=86400",
    },
  });
}
