/**
 * dsh-sync-backup / lib/webdav.js
 *
 * 零依赖 WebDAV 客户端：Basic 认证 + 重定向跟随 + 幂等 MKCOL + PUT/GET + 保留策略。
 *
 * 语义全部照抄 dsh-config-manager 的既有先例（`lib/sync/webdav/webdav-transport.js`），
 * 因为它已经在一家 WebDAV 服务商上跑通了；照抄它比自己设计少踩坑：
 *
 *  - 认证：`Basic base64(username:password)`，口令经注入的 `getPassword()` 每次网络操作时解析，
 *    **永不进 URL、不进日志、不进状态文件**。
 *  - 重定向：自动跟随 301/302/303/307/308；303 且非 GET/HEAD 降级为 GET 并丢弃请求体；
 *    相对 Location 按当前 URL 解析；**跨源跳转剥离 Authorization**（网盘会 302 到 CDN 预签名
 *    直链，预签名 URL 不该收到 Basic 凭据）；上限 5 跳。
 *  - 幂等建集合：`MKCOL`；`200/201/204/301/302/303/405` 都算成功（405 = 已存在）。
 *  - 索引三态：200+合法数组 → 条目；**404 → `missing: true`（缺信息，不是"集合为空"）**；
 *    其它非 2xx / 非法 JSON → 抛错，**绝不回落成空**。
 *  - 顺序契约：**先 MKCOL → 再 PUT 快照 → 最后 PUT 索引**（meta-last）。
 *  - 错误脱敏：错误消息里 password 的原文与 URL 编码形态一律替换为 `[REDACTED]`。
 *
 * 不依赖任何 `@deepseek-ai/*` 服务包；凭据由调用方以 `getPassword` 回调注入。
 *
 * @module dsh-sync-backup/lib/webdav
 */

import http from "node:http";
import https from "node:https";

import { filterIndexEntries, NAMING } from "./index-guard.js";
import { userAgent } from "./version.js";

/** 自动跟随的重定向状态码（RFC 7231/9110）。 */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** 重定向最大跳数。 */
const MAX_REDIRECTS = 5;
/** 响应体在错误消息中的截断长度。 */
const ERR_BODY_MAX = 300;
/** 脱敏占位符。 */
export const REDACTED = "[REDACTED]";

/** WebDAV 通道错误（带 kind / retryable 分类，便于上层决定是否退避重试）。 */
export class WebDavError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = "WebDavError";
    this.kind = opts.kind ?? "unknown";
    this.retryable = opts.retryable ?? false;
    this.status = opts.status;
    if (opts.cause !== undefined) this.cause = opts.cause;
  }
}

/** HTTP 状态 → 错误分类。4xx 不重试，5xx/408/429 可重试。 */
export function classifyStatus(status) {
  if (status === 408 || status === 429) return { kind: "transient", retryable: true };
  if (status >= 500) return { kind: "server", retryable: true };
  if (status === 401 || status === 403) return { kind: "auth", retryable: false };
  if (status === 404) return { kind: "notfound", retryable: false };
  if (status >= 400) return { kind: "client", retryable: false };
  return { kind: "protocol", retryable: false };
}

/** 同源判断（协议 + host，host 含端口）。 */
function sameOrigin(a, b) {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.protocol === ub.protocol && ua.host === ub.host;
  } catch {
    return false;
  }
}

/**
 * 单次裸请求（**不跟随重定向**）。
 * 只在 node 内置 http/https 之上做一层薄封装，返回结构与 fetch 的 Response 同形。
 */
export function requestOnce(method, url, options = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      reject(new WebDavError(`URL 非法: ${url}`, { kind: "protocol" }));
      return;
    }
    const mod = u.protocol === "https:" ? https : u.protocol === "http:" ? http : null;
    if (!mod) {
      reject(new WebDavError(`不支持的协议: ${u.protocol}`, { kind: "protocol" }));
      return;
    }

    const body =
      options.body === undefined
        ? undefined
        : Buffer.isBuffer(options.body)
          ? options.body
          : Buffer.from(String(options.body), "utf8");

    const headers = { ...(options.headers ?? {}) };
    if (body !== undefined) headers["Content-Length"] = String(body.length);
    else {
      delete headers["Content-Length"];
      delete headers["content-length"];
    }

    const req = mod.request(
      {
        method,
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || undefined,
        path: u.pathname + u.search,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const buffer = Buffer.concat(chunks);
          const h = {};
          for (const [k, v] of Object.entries(res.headers)) h[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
          resolve({
            status: res.statusCode,
            ok: res.statusCode >= 200 && res.statusCode < 300,
            headers: h,
            buffer,
            text: async () => buffer.toString("utf8"),
          });
        });
        res.on("error", reject);
      },
    );

    req.on("error", reject);

    if (typeof options.timeoutMs === "number" && options.timeoutMs > 0) {
      req.setTimeout(options.timeoutMs, () => {
        const e = new Error(`请求超时（${options.timeoutMs} ms）: ${method} ${url}`);
        e.name = "TimeoutError";
        req.destroy(e);
      });
    }

    if (body !== undefined) req.write(body);
    req.end();
  });
}

/**
 * 跟随重定向的请求实现（缺省实现；可被 options.request 覆盖以便离线测试）。
 * 重定向语义与 dsh-config-manager 的 defaultRequest 一致。
 */
export async function defaultRequest(method, url, options = {}) {
  let currentMethod = method;
  let currentUrl = url;
  let currentHeaders = { ...(options.headers ?? {}) };
  let currentBody = options.body;

  for (let redirects = 0; ; ) {
    const res = await requestOnce(currentMethod, currentUrl, {
      ...options,
      headers: currentHeaders,
      body: currentBody,
    });

    if (!REDIRECT_STATUSES.has(res.status)) return res;

    // 3xx 但没有 Location（或 Location 非法）→ 无法跟随，作为最终响应返回
    const rawLocation = res.headers?.location;
    const location = Array.isArray(rawLocation) ? rawLocation[0] : rawLocation;
    if (!location) return res;

    let nextUrl;
    try {
      nextUrl = new URL(location, currentUrl).toString();
    } catch {
      return res;
    }

    if (redirects >= MAX_REDIRECTS) {
      throw new WebDavError(`重定向次数超过上限（${MAX_REDIRECTS}）: ${url}`, { kind: "protocol" });
    }
    redirects += 1;

    let nextMethod = currentMethod;
    let nextHeaders = currentHeaders;
    let nextBody = currentBody;

    // 303 See Other：非 GET/HEAD 降级为 GET 并丢弃请求体
    if (res.status === 303 && currentMethod !== "GET" && currentMethod !== "HEAD") {
      nextMethod = "GET";
      nextBody = undefined;
    }

    // 跨源：剥离 Authorization（预签名 URL 不应收到 Basic 凭据）
    if (!sameOrigin(currentUrl, nextUrl)) {
      nextHeaders = { ...currentHeaders };
      delete nextHeaders.Authorization;
      delete nextHeaders.authorization;
    }

    currentMethod = nextMethod;
    currentUrl = nextUrl;
    currentHeaders = nextHeaders;
    currentBody = nextBody;
  }
}

/**
 * 规范化 WebDAV 相对目录，**逐段校验**。
 *
 * 返回不带首尾斜杠的规范形态（空串 = 根目录）。任何可疑形态一律抛错而不是
 * 「尽力修正」—— 因为这里的输入最终决定「删哪些远端文件」，猜错的代价是删除
 * 备份目录之外的对象。校验项：
 *
 * - 空段（`a//b`）、`.`、`..`（目录穿越）；
 * - 反斜杠（在部分服务端会被当分隔符解释，造成两套路径语义）；
 * - `?` / `#`（会把后续路径变成 query / fragment，静默改变目标）；
 * - `%`（避免二次编码歧义与 %2e%2e 这类绕过）；
 * - 控制字符与首尾空白。
 *
 * @param {unknown} raw
 * @returns {string} 规范相对路径（可含中文/空格，交给 URL 编码处理）
 */
export function normalizeWebDavPath(raw) {
  const text = String(raw ?? "").trim();
  if (text === "") return "";
  const p = text.replace(/^\/+/, "").replace(/\/+$/, "");
  if (p === "") return "";
  if (p.includes("\\")) {
    throw new WebDavError("WebDAV 路径不得含反斜杠", { kind: "protocol" });
  }
  for (const ch of ["?", "#", "%"]) {
    if (p.includes(ch)) {
      throw new WebDavError(`WebDAV 路径不得含 "${ch}"（会改变请求目标或造成编码歧义）`, {
        kind: "protocol",
      });
    }
  }
  for (let i = 0; i < p.length; i++) {
    const c = p.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) {
      throw new WebDavError("WebDAV 路径不得含控制字符", { kind: "protocol" });
    }
  }
  for (const seg of p.split("/")) {
    if (seg === "") throw new WebDavError("WebDAV 路径不得含空路径段（如 a//b）", { kind: "protocol" });
    if (seg === "." || seg === "..") {
      throw new WebDavError("WebDAV 路径不得含 . 或 ..（目录穿越）", { kind: "protocol" });
    }
  }
  return p;
}

/** 逐段 URL 编码后再拼。**不把用户输入直接塞进 URL。** */
export function joinUrl(base, seg) {
  const b = String(base).replace(/\/+$/, "");
  const s = normalizeWebDavPath(seg);
  if (s === "") return `${b}/`;
  return `${b}/${s.split("/").map(encodeURIComponent).join("/")}`;
}

/**
 * WebDAV 客户端。
 *
 * @param {object} options
 * @param {string} options.baseUrl     DAV 根，如 `https://webdav.example.com/dav/`
 * @param {string} options.username
 * @param {() => Promise<string>} options.getPassword  每次网络操作时解析口令
 * @param {number} [options.timeoutMs=300000]
 * @param {(m:string,u:string,o:object)=>Promise<object>} [options.request]  注入点（测试用）
 */
export class WebDavClient {
  constructor(options) {
    this.validate(options);
    this.baseUrl = String(options.baseUrl).replace(/\/+$/, "");
    this.username = options.username;
    this.getPassword = options.getPassword;
    this.timeoutMs = options.timeoutMs ?? 300000;
    this.request = options.request ?? defaultRequest;
  }

  validate(options) {
    if (typeof options?.baseUrl !== "string" || options.baseUrl.trim() === "") {
      throw new WebDavError("baseUrl 必填", { kind: "protocol" });
    }
    let parsed;
    try {
      parsed = new URL(options.baseUrl);
    } catch {
      throw new WebDavError(`baseUrl 非法: ${options.baseUrl}`, { kind: "protocol" });
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new WebDavError(`baseUrl 非法: ${options.baseUrl}`, { kind: "protocol" });
    }
    // baseUrl 不得内嵌凭据（凭据只走 getPassword）
    if (parsed.username !== "" || parsed.password !== "") {
      throw new WebDavError("baseUrl 不得包含 userinfo（凭据只能经 getPassword 注入）", { kind: "protocol" });
    }
    if (typeof options.username !== "string" || options.username === "") {
      throw new WebDavError("username 必填", { kind: "protocol" });
    }
    if (typeof options.getPassword !== "function") {
      throw new WebDavError("getPassword 必须是函数", { kind: "protocol" });
    }
  }

  /** 错误消息脱敏：口令原文与 URL 编码形态一律替换。 */
  mask(text, pwd) {
    let out = String(text ?? "");
    if (!pwd) return out;
    out = out.split(pwd).join(REDACTED);
    try {
      out = out.split(encodeURIComponent(pwd)).join(REDACTED);
    } catch {
      /* encodeURIComponent 对孤立代理项会抛错；此时只用原文替换 */
    }
    return out;
  }

  /** 读一次口令（错误脱敏用，失败返回空串，绝不打断主流程）。 */
  async passwordOnce() {
    try {
      return await this.getPassword();
    } catch {
      return "";
    }
  }

  isTimeout(err) {
    const n = err?.name ?? "";
    return n === "TimeoutError" || n === "AbortError";
  }

  /** 发送请求：注入 Basic 认证头，并把底层异常归一成 WebDavError。 */
  async send(method, url, opts = {}) {
    const pwd = opts.pwd ?? (await this.getPassword());
    const headers = {
      Authorization: "Basic " + Buffer.from(`${this.username}:${pwd}`, "utf8").toString("base64"),
      "User-Agent": userAgent("WebDAV Client"),
      ...(opts.headers ?? {}),
    };
    try {
      return await this.request(method, url, {
        headers,
        body: opts.body,
        timeoutMs: this.timeoutMs,
      });
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      const masked = this.mask(raw, pwd);
      if (this.isTimeout(err)) {
        throw new WebDavError(`请求超时: ${method} ${url}（${this.timeoutMs} ms）`, {
          kind: "timeout",
          retryable: true,
          cause: err,
        });
      }
      throw new WebDavError(`${method} ${url} 请求失败: ${masked}`, {
        kind: "network",
        retryable: true,
        cause: err,
      });
    }
  }

  /** 构造非 2xx 失败消息：附上脱敏并截断的响应体片段。 */
  async failText(method, url, res, pwd) {
    let body = "";
    try {
      body = String(await res.text()).slice(0, ERR_BODY_MAX);
    } catch {
      body = "";
    }
    return `${method} ${url} → HTTP ${res.status}${body ? `: ${this.mask(body, pwd)}` : ""}`;
  }

  /** 幂等创建集合：`MKCOL`；405（已存在）与 2xx/3xx 均视为成功。 */
  async ensureCollection(colUrl, pwd) {
    const p = pwd ?? (await this.getPassword());
    const res = await this.send("MKCOL", colUrl, { pwd: p });
    const ok = new Set([200, 201, 204, 301, 302, 303, 405]);
    if (ok.has(res.status)) return { ok: true, status: res.status };
    throw new WebDavError(await this.failText("MKCOL", colUrl, res, p), {
      ...classifyStatus(res.status),
      status: res.status,
    });
  }

  /** GET 一个资源；404 返回 `{ status: 404, missing: true }` 而不抛错。 */
  async get(url, pwd) {
    const p = pwd ?? (await this.getPassword());
    const res = await this.send("GET", url, { pwd: p });
    if (res.status === 404) return { status: 404, missing: true, buffer: Buffer.alloc(0) };
    if (!res.ok) {
      throw new WebDavError(await this.failText("GET", url, res, p), {
        ...classifyStatus(res.status),
        status: res.status,
      });
    }
    return { status: res.status, missing: false, buffer: res.buffer };
  }

  /** PUT 一个资源（必须 2xx）。 */
  async put(url, body, opts = {}) {
    const p = opts.pwd ?? (await this.getPassword());
    const res = await this.send("PUT", url, { pwd: p, body, headers: opts.headers });
    if (!res.ok) {
      throw new WebDavError(await this.failText("PUT", url, res, p), {
        ...classifyStatus(res.status),
        status: res.status,
      });
    }
    return { status: res.status };
  }

  /** DELETE 一个资源；404 视为成功（幂等）。 */
  async delete(url, pwd) {
    const p = pwd ?? (await this.getPassword());
    const res = await this.send("DELETE", url, { pwd: p });
    if (res.status === 404 || res.ok) return { status: res.status };
    throw new WebDavError(await this.failText("DELETE", url, res, p), {
      ...classifyStatus(res.status),
      status: res.status,
    });
  }

  /**
   * 读索引。**三态语义**：200+合法 JSON 对象 → 索引；404 → `missing: true`；
   * 其它非 2xx / 非法 JSON → 抛错（**绝不回落成空**）。
   */
  async readIndex(indexUrl, pwd) {
    const p = pwd ?? (await this.getPassword());
    const res = await this.send("GET", indexUrl, { pwd: p });
    if (res.status === 404) return { index: null, missing: true };
    if (!res.ok) {
      throw new WebDavError(await this.failText("GET", indexUrl, res, p), {
        ...classifyStatus(res.status),
        status: res.status,
      });
    }
    let parsed;
    try {
      parsed = JSON.parse(res.buffer.toString("utf8"));
    } catch (err) {
      throw new WebDavError(`索引不是合法 JSON: ${indexUrl}（${this.mask(String(err?.message ?? err), p)}）`, {
        kind: "protocol",
        retryable: false,
      });
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new WebDavError(`索引顶层必须是对象: ${indexUrl}`, { kind: "protocol", retryable: false });
    }
    if (!Array.isArray(parsed.entries)) {
      throw new WebDavError(`索引缺少 entries 数组: ${indexUrl}`, { kind: "protocol", retryable: false });
    }
    return { index: parsed, missing: false };
  }

  /**
   * 上传一份归档 + 索引（**先写索引，再清理旧文件**）。
   *
   * 顺序：幂等 MKCOL → PUT 归档 → PUT manifest → 读旧索引 → **PUT 新索引** →
   * best-effort 删除超额旧文件。
   *
   * 为什么删除必须在索引之后：反过来（先删后写）一旦索引 PUT 失败，远端就留下
   * 一份仍然引用着刚被删掉对象的旧索引 —— 索引指向不存在的东西，恢复时会直接失败。
   * 而「先写索引」最坏的结果只是多留几个孤儿文件，下一轮清理会收掉，**可恢复性
   * 优先于磁盘整洁**。删除失败也不回滚索引：孤儿文件比悬空索引安全得多。
   *
   * @returns {Promise<{archiveUrl:string,indexUrl:string,pruned:string[],pruneFailed:string[],
   *                    indexTrusted:boolean,indexRejected:Array}>}
   */
  async uploadSnapshot({ dir, id, archive, manifest, indexFile = "dsh-backup-index.json", keepLast = 7 }) {
    const pwd = await this.getPassword();
    // 目录形态先规范化：它会参与拼接每个远端 URL，也是删除边界的依据。
    const normalized = normalizeWebDavPath(dir);
    const colUrl = joinUrl(this.baseUrl, normalized);
    const col = colUrl.endsWith("/") ? colUrl : `${colUrl}/`;

    await this.ensureCollection(col, pwd);

    const names = NAMING.webdav(id);
    const archiveUrl = `${col}${names.archive}`;
    const manifestUrl = `${col}${names.manifest}`;
    const indexUrl = `${col}${indexFile}`;

    await this.put(archiveUrl, archive, {
      pwd,
      headers: { "Content-Type": "application/gzip" },
    });

    const manifestBody = Buffer.from(JSON.stringify(manifest, null, 2), "utf8");
    await this.put(manifestUrl, manifestBody, {
      pwd,
      headers: { "Content-Type": "application/json" },
    });

    const { index } = await this.readIndex(indexUrl, pwd);

    // 索引是**数据**：先把不可信的旧条目筛出去，并记住信任判定。
    const { valid, rejected, trustIndex } = filterIndexEntries(index?.entries ?? [], {
      style: "webdav",
      dir: normalized,
    });
    const entries = valid.filter((e) => e.id !== id);

    const entry = {
      id,
      createdAt: new Date().toISOString(),
      archive: names.archive,
      manifestFile: names.manifest,
      fileCount: manifest?.fileCount ?? null,
      totalBytes: manifest?.totalBytes ?? null,
      archiveBytes: archive.length,
      archiveSha256: manifest?.archiveSha256 ?? null,
    };
    entries.push(entry);
    entries.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

    const keep = Math.max(1, Number(keepLast) || 1);
    const surplus = entries.length > keep ? entries.slice(0, entries.length - keep) : [];
    const kept = entries.slice(Math.max(0, entries.length - keep));

    // ① 先写索引：这一步之后的索引不再引用任何将被删除的对象。
    const nextIndex = {
      schemaVersion: 1,
      plugin: "dsh-sync-backup",
      updatedAt: new Date().toISOString(),
      entries: kept,
    };
    await this.put(indexUrl, Buffer.from(JSON.stringify(nextIndex, null, 2), "utf8"), {
      pwd,
      headers: { "Content-Type": "application/json" },
    });

    // ② 再删超额旧文件；失败只记录，留给下一轮当孤儿处理。
    // 索引不可信时**一个都不删** —— 对远端现状的认知不完整时不做破坏性动作。
    const pruned = [];
    const pruneFailed = [];
    if (trustIndex) {
      for (const old of surplus) {
        for (const name of [old.archive, old.manifestFile]) {
          if (typeof name !== "string" || name === "") continue;
          try {
            const r = await this.delete(`${col}${name}`, pwd);
            pruned.push(`${name}(${r.status})`);
          } catch (err) {
            pruneFailed.push(`${name}: ${this.mask(String(err?.message ?? err), pwd)}`);
          }
        }
      }
    }

    return {
      colUrl: col,
      archiveUrl,
      manifestUrl,
      indexUrl,
      pruned,
      pruneFailed,
      indexTrusted: trustIndex,
      indexRejected: rejected,
      index: nextIndex,
    };
  }
}

export default { WebDavClient, WebDavError, REDACTED, classifyStatus, defaultRequest, joinUrl, requestOnce };
