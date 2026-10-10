/**
 * dsh-sync-backup · lib/github.js
 *
 * GitHub REST 客户端（零依赖，只用 node:https / node:http）。
 * 职责：把「一份归档 + manifest + latest 副本 + 索引」写入私有仓库的指定目录，
 * 并在 keepLast 之外裁剪旧快照。
 *
 * 设计依据（2026-10-08 抓取的官方文档原文，落盘于 DSH定时备份插件/_p3tmp/）：
 *   - PUT /repos/{owner}/{repo}/contents/{path}
 *       body: { message(required), content(required, Base64),
 *               sha(更新时必填，原文 "Required if you are updating a file. The blob SHA of the file being replaced."),
 *               branch?, committer?, author? }
 *       状态码: 200 更新成功 / 201 创建成功 / 404 / 409 与 Delete 端点并发冲突 / 422 校验失败
 *       文件字节上限 100 MB
 *       （https://github.blog/changelog/2022-05-03-increased-file-size-limit-when-retrieving-file-contents-via-rest-api/）
 *   - GET /repos/{owner}/{repo}/contents/{path}
 *       状态码: 200 / 302 / 304 / 403 / 404；目录上限 1000 个文件
 *       ≤1 MB 返回 base64 的 content；1–100 MB 时 content 为空串且 encoding 为 "none"，
 *       必须改用 Accept: application/vnd.github.raw
 *   - DELETE /repos/{owner}/{repo}/contents/{path}
 *       body: { message(required), sha(required), branch? }
 *
 * 错误契约（与 lib/webdav.js 的 WebDavError 保持同形，便于上层统一处理）：
 *   GitHubError.kind ∈ auth | notfound | conflict | validation | client |
 *                      transient | server | timeout | network | protocol
 *   retryable 为 true 的只有 transient / server / timeout / network；
 *   GitHub 限流是「403 + 文案」，按可重试的 server 故障处理。
 */

import http from "node:http";
import https from "node:https";

import { filterIndexEntries, NAMING } from "./index-guard.js";
import { userAgent } from "./version.js";
import { checkTransportUrl } from "./transport-guard.js";

export const GITHUB_API_BASE_URL = "https://api.github.com";
export const GITHUB_WEB_BASE_URL = "https://github.com";
export const GITHUB_API_VERSION = "2022-11-28";
export const DEFAULT_USER_AGENT = userAgent("GitHub Client");
export const REDACTED = "[REDACTED]";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 3;
const ERR_BODY_MAX = 500;

/** contents API 的单文件字节上限（100 MB）。 */
export const MAX_CONTENT_BYTES = 100 * 1024 * 1024;
/** 仓库内单段路径长度上限（防御性，非官方数值）。 */
const MAX_PATH_CHARS = 900;

/** github.com 路径与仓库名的形状：owner/repo。 */
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

export class GitHubError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = "GitHubError";
    this.kind = opts.kind ?? "unknown";
    this.retryable = opts.retryable ?? false;
    this.status = opts.status;
    if (opts.cause !== undefined) this.cause = opts.cause;
  }
}

/**
 * HTTP 状态码 → 错误分类。GitHub 的限流（403）先于通用 4xx 判定。
 * @param {number} status
 * @param {string} [bodyText]
 * @returns {{kind: string, retryable: boolean, status: number}}
 */
export function classifyStatus(status, bodyText = "") {
  if (status === 403 && /rate limit|secondary rate|abuse detection/i.test(bodyText)) {
    return { kind: "server", retryable: true, status };
  }
  if (status === 408 || status === 429) return { kind: "transient", retryable: true, status };
  if (status >= 500) return { kind: "server", retryable: true, status };
  if (status === 401 || status === 403) return { kind: "auth", retryable: false, status };
  if (status === 404) return { kind: "notfound", retryable: false, status };
  if (status === 409) return { kind: "conflict", retryable: false, status };
  if (status === 422) return { kind: "validation", retryable: false, status };
  if (status >= 400) return { kind: "client", retryable: false, status };
  return { kind: "protocol", retryable: false, status };
}

/**
 * 解析仓库标识。接受 owner/repo、https://github.com/owner/repo、owner/repo.git 三种写法。
 * @param {string} spec
 * @returns {{owner: string, repo: string, full: string}|undefined}
 */
export function parseRepo(spec) {
  if (typeof spec !== "string") return undefined;
  let raw = spec.trim();
  if (raw === "") return undefined;
  raw = raw.replace(/^https?:\/\/[^/]*github\.com\//i, "").replace(/\.git$/i, "").replace(/\/+$/, "");
  const parts = raw.split("/");
  if (parts.length !== 2) return undefined;
  const [owner, repo] = parts;
  if (!OWNER_RE.test(owner)) return undefined;
  if (!REPO_RE.test(repo) || repo === "." || repo === "..") return undefined;
  return { owner, repo, full: `${owner}/${repo}` };
}

/**
 * 归一化仓库内相对路径：去首尾斜杠，拒绝空段 / `.` / `..` / 反斜杠 / `?` / `#` / 控制字符。
 * @param {string} input
 * @returns {string}
 */
export function normalizeRepoPath(input) {
  if (typeof input !== "string") throw new GitHubError("仓库路径必须是字符串", { kind: "protocol" });
  const raw = input.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  if (raw === "") throw new GitHubError("仓库路径不得为空", { kind: "protocol" });
  if (raw.includes("\\")) throw new GitHubError(`仓库路径不得含反斜杠: ${raw}`, { kind: "protocol" });
  const segs = raw.split("/");
  for (const seg of segs) {
    if (seg === "" || seg === "." || seg === "..") {
      throw new GitHubError(`仓库路径含非法段 "${seg}": ${raw}`, { kind: "protocol" });
    }
    if (/[\u0000-\u001f\u007f?#]/.test(seg)) {
      throw new GitHubError(`仓库路径含非法字符: ${raw}`, { kind: "protocol" });
    }
  }
  const out = segs.join("/");
  if (out.length > MAX_PATH_CHARS) throw new GitHubError(`仓库路径过长（>${MAX_PATH_CHARS}）`, { kind: "protocol" });
  return out;
}

/**
 * 逐段 URL 编码后的仓库路径（内容和路径段里的空格/中文都必须编码）。
 * @param {string} input
 * @returns {string}
 */
export function encodeRepoPath(input) {
  return normalizeRepoPath(input).split("/").map(encodeURIComponent).join("/");
}

/** 拼接 API 基址与相对路径。 */
export function joinApiUrl(base, path) {
  const b = String(base).replace(/\/+$/, "");
  const p = String(path).replace(/^\/+/, "");
  return `${b}/${p}`;
}

/**
 * 单次 HTTP 请求（不跟随重定向，不使用 fetch —— 本机 PowerShell/Node 的 fetch 对
 * 大体积 PUT 与自定义头支持不一致，沿用 webdav.js 的 node:https 路线）。
 * @param {string} method
 * @param {string} url
 * @param {{headers?: object, body?: string|Buffer, timeoutMs?: number}} [options]
 * @returns {Promise<{status: number, ok: boolean, headers: object, buffer: Buffer, text: () => Promise<string>}>}
 */
export function requestOnce(method, url, options = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      reject(new GitHubError(`URL 非法: ${url}`, { kind: "protocol" }));
      return;
    }
    const mod = u.protocol === "https:" ? https : u.protocol === "http:" ? http : null;
    if (!mod) {
      reject(new GitHubError(`不支持的协议: ${u.protocol}`, { kind: "protocol" }));
      return;
    }

    const headers = { ...(options.headers ?? {}) };
    let body;
    if (options.body !== undefined && options.body !== null) {
      body = Buffer.isBuffer(options.body) ? options.body : Buffer.from(String(options.body), "utf8");
      headers["Content-Length"] = String(body.length);
    } else {
      delete headers["Content-Length"];
      delete headers["content-length"];
    }

    const req = mod.request(
      { method, protocol: u.protocol, hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, headers },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const buffer = Buffer.concat(chunks);
          const lower = {};
          for (const [k, v] of Object.entries(res.headers)) lower[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
          resolve({
            status: res.statusCode,
            ok: res.statusCode >= 200 && res.statusCode < 300,
            headers: lower,
            buffer,
            text: async () => buffer.toString("utf8"),
          });
        });
        res.on("error", (err) => reject(err));
      }
    );

    req.on("error", (err) => reject(err));
    if (typeof options.timeoutMs === "number" && options.timeoutMs > 0) {
      req.setTimeout(options.timeoutMs, () => {
        const e = new Error(`请求超时（${options.timeoutMs} ms）: ${method} ${url}`);
        e.name = "TimeoutError";
        req.destroy(e);
      });
    }
    if (body) req.write(body);
    req.end();
  });
}

/**
 * 跟随重定向的默认请求实现。
 *  - 最多 MAX_REDIRECTS 跳，超出抛 kind:"protocol"；
 *  - 303 且原方法非 GET/HEAD 时降级为 GET 并丢弃 body；
 *  - 跨源跳转一律剥掉 Authorization（私有仓库的 raw 下载会 302 到签名 CDN）。
 */
export async function defaultRequest(method, url, options = {}) {
  let currentUrl = url;
  let currentMethod = method;
  let currentBody = options.body;
  let nextHeaders = { ...(options.headers ?? {}) };

  for (let redirects = 0; ; ) {
    const res = await requestOnce(currentMethod, currentUrl, {
      headers: nextHeaders,
      body: currentBody,
      timeoutMs: options.timeoutMs,
    });
    if (!REDIRECT_STATUSES.has(res.status)) return res;

    const location = res.headers.location;
    if (typeof location !== "string" || location === "") return res;

    let nextUrl;
    try {
      nextUrl = new URL(location, currentUrl);
    } catch {
      return res;
    }
    if (redirects >= MAX_REDIRECTS) {
      throw new GitHubError(`重定向次数超过上限（${MAX_REDIRECTS}）: ${url}`, { kind: "protocol" });
    }
    redirects += 1;

    const nextMethod = currentMethod;
    let bodyForNext = currentBody;
    if (res.status === 303 && currentMethod !== "GET" && currentMethod !== "HEAD") {
      currentMethod = "GET";
      bodyForNext = undefined;
    } else {
      currentMethod = nextMethod;
    }

    const sameOrigin = nextUrl.protocol === new URL(url).protocol && nextUrl.host === new URL(url).host;
    if (!sameOrigin) {
      delete nextHeaders.Authorization;
      delete nextHeaders.authorization;
    }
    if (res.status === 303) currentBody = undefined;
    else currentBody = bodyForNext;

    currentUrl = nextUrl.toString();
    nextHeaders = { ...nextHeaders };
  }
}

function defaultSleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 退避重试：默认 3 次尝试，间隔 1s / 4s / 16s。
 * 只有 shouldRetry(err) 为真才重试（缺省 = GitHubError.retryable === true）。
 * @param {(attempt: number) => Promise<any>} fn
 * @param {{attempts?: number, baseDelayMs?: number, factor?: number, maxDelayMs?: number, sleep?: Function, shouldRetry?: Function}} [opts]
 */
export async function withRetry(fn, opts = {}) {
  const attempts = Math.max(1, Number(opts.attempts) || 3);
  const base = Number(opts.baseDelayMs) || 1000;
  const factor = Number(opts.factor) || 4;
  const max = Number(opts.maxDelayMs) || 16000;
  const sleep = typeof opts.sleep === "function" ? opts.sleep : defaultSleep;

  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn(i);
    } catch (err) {
      lastErr = err;
      const fallback = err instanceof GitHubError && err.retryable === true;
      const allow = typeof opts.shouldRetry === "function" ? opts.shouldRetry(err) : fallback;
      if (!allow || i === attempts - 1) throw err;
      await sleep(Math.min(max, base * factor ** i), i + 1, err);
    }
  }
  throw lastErr;
}

export class GitHubClient {
  /**
   * @param {{repo: string, getToken: Function, apiBaseUrl?: string, branch?: string,
   *          timeoutMs?: number, request?: Function, sleep?: Function,
   *          userAgent?: string, apiVersion?: string, maxContentBytes?: number}} options
   */
  constructor(options = {}) {
    this.validate(options);
    const parsed = parseRepo(options.repo);
    this.repo = parsed.full;
    this.owner = parsed.owner;
    this.repoName = parsed.repo;
    this.apiBaseUrl = String(options.apiBaseUrl ?? GITHUB_API_BASE_URL).replace(/\/+$/, "");
    this.branch = typeof options.branch === "string" ? options.branch.trim() : "";
    this.getToken = options.getToken;
    this.timeoutMs = options.timeoutMs ?? 120000;
    this.request = options.request ?? defaultRequest;
    this.sleep = options.sleep;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.apiVersion = options.apiVersion ?? GITHUB_API_VERSION;
    this.maxContentBytes = options.maxContentBytes ?? MAX_CONTENT_BYTES;
  }

  /** 构造期校验：凭据与目标主机都不得出现在 URL 里。 */
  validate(options) {
    if (!parseRepo(options.repo)) {
      throw new GitHubError("repo 必须是 owner/repo 形式", { kind: "protocol" });
    }
    const base = options.apiBaseUrl ?? GITHUB_API_BASE_URL;
    if (typeof base !== "string" || base.trim() === "") {
      throw new GitHubError("apiBaseUrl 必填", { kind: "protocol" });
    }
    let parsed;
    try {
      parsed = new URL(base);
    } catch {
      throw new GitHubError(`apiBaseUrl 非法: ${base}`, { kind: "protocol" });
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new GitHubError(`apiBaseUrl 协议必须是 http(s): ${base}`, { kind: "protocol" });
    }
    // GitHub 用 Bearer PAT，http: 下同样是明文。外部目标一律要求 https:
    // （包括 GitHub Enterprise）；仅本机地址（假服务/本地代理）允许 http。
    const t = checkTransportUrl(base, {
      allowInsecure: options.allowInsecureHttp === true,
      what: "GitHub apiBaseUrl",
    });
    if (!t.ok) throw new GitHubError(t.problem, { kind: "protocol" });
    if (parsed.username !== "" || parsed.password !== "") {
      throw new GitHubError("apiBaseUrl 不得包含 userinfo（凭据只能经 getToken 注入）", { kind: "protocol" });
    }
    if (typeof options.getToken !== "function") {
      throw new GitHubError("getToken 必须是函数", { kind: "protocol" });
    }
  }

  /** 把 token 的原文与 URL 编码形态从文本里抹掉。 */
  mask(text, token) {
    let out = String(text);
    if (typeof token === "string" && token !== "") {
      out = out.split(token).join(REDACTED);
      try {
        out = out.split(encodeURIComponent(token)).join(REDACTED);
      } catch {
        /* 原样替换已做过，忽略 */
      }
    }
    return out;
  }

  async tokenOnce() {
    try {
      const t = await this.getToken();
      return typeof t === "string" ? t : "";
    } catch {
      return "";
    }
  }

  /** contents API 的 URL（GET 用 ref 查询参数定位分支）。 */
  contentsUrl(relPath, branch) {
    const p = encodeRepoPath(relPath);
    const url = joinApiUrl(this.apiBaseUrl, `repos/${this.owner}/${this.repoName}/contents/${p}`);
    const ref = typeof branch === "string" ? branch : this.branch;
    return ref ? `${url}?ref=${encodeURIComponent(ref)}` : url;
  }

  /** 供人查看的 github.com 页面地址。 */
  webUrl(relPath, branch) {
    const ref = (typeof branch === "string" ? branch : this.branch) || "HEAD";
    return `${GITHUB_WEB_BASE_URL}/${this.repo}/blob/${encodeURIComponent(ref)}/${encodeRepoPath(relPath)}`;
  }

  /**
   * 单次发送（不重试）。
   * @param {string} method
   * @param {string} url
   * @param {{body?: string|Buffer, headers?: object, raw?: boolean, token?: string}} [opts]
   */
  async send(method, url, opts = {}) {
    const token = opts.token ?? (await this.tokenOnce());
    const headers =
      opts.raw === true
        ? {
            accept: "application/vnd.github.raw",
            "user-agent": this.userAgent,
            ...(token ? { authorization: "Bearer " + token } : {}),
            ...(opts.headers ?? {}),
          }
        : {
            accept: "application/vnd.github+json",
            "content-type": "application/json",
            "x-github-api-version": this.apiVersion,
            "user-agent": this.userAgent,
            ...(token ? { authorization: "Bearer " + token } : {}),
            ...(opts.headers ?? {}),
          };

    try {
      return await this.request(method, url, { headers, body: opts.body, timeoutMs: this.timeoutMs });
    } catch (err) {
      if (err instanceof GitHubError) throw err;
      const isTimeout = err && (err.name === "TimeoutError" || err.name === "AbortError");
      const raw = err && err.message ? err.message : String(err);
      if (isTimeout) {
        throw new GitHubError(`请求超时（${this.timeoutMs} ms）: ${method} ${url}`, {
          kind: "timeout",
          retryable: true,
          cause: err,
        });
      }
      throw new GitHubError(`网络错误: ${this.mask(raw, token)}`, { kind: "network", retryable: true, cause: err });
    }
  }

  /** 非 2xx → 抛带分类的 GitHubError。 */
  fail(method, url, res, token) {
    const body =
      res.buffer && res.buffer.length > 0
        ? this.mask(res.buffer.subarray(0, ERR_BODY_MAX).toString("utf8").trim(), token)
        : "";
    const cls = classifyStatus(res.status, body);
    return new GitHubError(`${method} ${url} → HTTP ${res.status}${body ? `: ${body}` : ""}`, cls);
  }

  /**
   * 读文件元信息（不下载内容）。
   * @returns {Promise<{status: number, missing: boolean, dir?: boolean, sha?: string, size?: number, encoding?: string, content?: string}>}
   */
  async getFileMeta(relPath, opts = {}) {
    const url = this.contentsUrl(relPath, opts.branch);
    const token = await this.tokenOnce();
    const res = await this.send("GET", url, { token });
    if (res.status === 404) return { status: 404, missing: true, size: 0 };
    if (!res.ok) throw this.fail("GET", url, res, token);
    let json;
    try {
      json = JSON.parse(res.buffer.toString("utf8"));
    } catch {
      throw new GitHubError(`contents 响应不是合法 JSON: ${url}`, { kind: "protocol" });
    }
    if (!json || typeof json !== "object" || Array.isArray(json)) {
      throw new GitHubError(`contents 响应顶层必须是对象: ${url}`, { kind: "protocol" });
    }
    if (json.type === "dir" || Array.isArray(json)) {
      return { status: res.status, missing: false, dir: true, sha: json.sha, size: 0 };
    }
    return {
      status: res.status,
      missing: false,
      dir: false,
      sha: json.sha,
      size: Number(json.size) || 0,
      encoding: json.encoding,
      content: typeof json.content === "string" ? json.content : undefined,
      downloadUrl: typeof json.download_url === "string" ? json.download_url : undefined,
    };
  }

  /**
   * 读文件内容。小文件走 JSON 里的 base64 content；大文件（content 空 / encoding:"none"）回落 raw 媒体类型。
   * @returns {Promise<{status: number, missing: boolean, buffer: Buffer, sha?: string}>}
   */
  async readFile(relPath, opts = {}) {
    const meta = await this.getFileMeta(relPath, opts);
    if (meta.missing) return { status: 404, missing: true, buffer: Buffer.alloc(0) };
    if (meta.dir) throw new GitHubError(`路径指向目录而非文件: ${relPath}`, { kind: "protocol" });

    const inline = typeof meta.content === "string" && meta.content !== "" && meta.encoding !== "none";
    if (inline) {
      const buffer = Buffer.from(meta.content.replace(/[\r\n]/g, ""), "base64");
      return { status: meta.status, missing: false, buffer, sha: meta.sha };
    }
    if (typeof meta.downloadUrl === "string" && meta.downloadUrl !== "") {
      // download_url 指向 raw.githubusercontent.com 且自带签名，跨主机一律不带 Authorization。
      const dl = await this.send("GET", meta.downloadUrl, { raw: true, token: "" });
      if (dl.status === 404) return { status: 404, missing: true, buffer: Buffer.alloc(0) };
      if (!dl.ok) throw this.fail("GET", meta.downloadUrl, dl, "");
      return { status: dl.status, missing: false, buffer: dl.buffer, sha: meta.sha };
    }

    const url = this.contentsUrl(relPath, opts.branch);
    const res = await this.send("GET", url, { raw: true });
    if (res.status === 404) return { status: 404, missing: true, buffer: Buffer.alloc(0) };
    if (!res.ok) throw this.fail("GET", url, res, "");
    return { status: res.status, missing: false, buffer: res.buffer, sha: meta.sha };
  }

  /**
   * 读索引（三态，与 webdav.readIndex 同语义：缺失 / 正常 / 结构非法即抛错，绝不回落成空）。
   * @param {string} relPath
   * @returns {Promise<{index: object|null, missing: boolean, sha?: string}>}
   */
  async readIndex(relPath, opts = {}) {
    const got = await withRetry(() => this.readFile(relPath, opts), {
      sleep: this.sleep,
      shouldRetry: (e) => e instanceof GitHubError && e.retryable === true,
    });
    if (got.missing) return { index: null, missing: true };
    let parsed;
    try {
      parsed = JSON.parse(got.buffer.toString("utf8"));
    } catch {
      throw new GitHubError(`索引不是合法 JSON: ${relPath}`, { kind: "protocol" });
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new GitHubError(`索引顶层必须是对象: ${relPath}`, { kind: "protocol" });
    }
    if (!Array.isArray(parsed.entries)) {
      throw new GitHubError(`索引缺少 entries 数组: ${relPath}`, { kind: "protocol" });
    }
    return { index: parsed, missing: false, sha: got.sha };
  }

  /**
   * 写入文件（不存在则创建，存在则更新）。
   * 整体包在 withRetry 里：每次重试都重新 GET 当前 blob sha，
   * 因此「上一次 PUT 其实已落库但响应超时」的重试不会撞 409（会多一次同内容的提交，可接受）。
   * @param {string} relPath
   * @param {Buffer|string} body
   * @param {{message?: string, branch?: string, token?: string}} [opts]
   */
  async putFile(relPath, body, opts = {}) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), "utf8");
    if (buf.length > this.maxContentBytes) {
      throw new GitHubError(
        `文件超过 contents API 上限（${buf.length} > ${this.maxContentBytes} 字节）: ${relPath}`,
        { kind: "client" }
      );
    }
    const message = opts.message ?? `dsh-sync-backup: update ${normalizeRepoPath(relPath)}`;
    const branch = typeof opts.branch === "string" ? opts.branch : this.branch;

    return withRetry(
      async () => {
        const token = opts.token ?? (await this.tokenOnce());
        const head = await this.getFileMeta(relPath, { branch });
        const url = this.contentsUrl(relPath, branch);
        const payload = {
          message,
          content: buf.toString("base64"),
          ...(branch ? { branch } : {}),
          ...(head.missing ? {} : { sha: head.sha }),
        };
        const res = await this.send("PUT", url, { body: JSON.stringify(payload), token });
        if (!res.ok) throw this.fail("PUT", url, res, token);
        let json;
        try {
          json = JSON.parse(res.buffer.toString("utf8"));
        } catch {
          json = undefined;
        }
        return {
          status: res.status,
          existed: head.missing !== true,
          sha: json && json.content ? json.content.sha : undefined,
          commit: json && json.commit ? json.commit.sha : undefined,
        };
      },
      { sleep: this.sleep, shouldRetry: (e) => e instanceof GitHubError && e.retryable === true }
    );
  }

  /**
   * 删除文件；不存在（404）视为成功。
   * @returns {Promise<{status: number, existed: boolean}>}
   */
  async deleteFile(relPath, opts = {}) {
    const message = opts.message ?? `dsh-sync-backup: remove ${normalizeRepoPath(relPath)}`;
    const branch = typeof opts.branch === "string" ? opts.branch : this.branch;

    return withRetry(
      async () => {
        const token = opts.token ?? (await this.tokenOnce());
        const head = await this.getFileMeta(relPath, { branch });
        if (head.missing) return { status: 404, existed: false };
        const url = this.contentsUrl(relPath, branch);
        const payload = { message, sha: head.sha, ...(branch ? { branch } : {}) };
        const res = await this.send("DELETE", url, { body: JSON.stringify(payload), token });
        if (res.status === 404) return { status: 404, existed: false };
        if (!res.ok) throw this.fail("DELETE", url, res, token);
        return { status: res.status, existed: true };
      },
      { sleep: this.sleep, shouldRetry: (e) => e instanceof GitHubError && e.retryable === true }
    );
  }

  /**
   * 上传一份快照：归档 → manifest → latest 副本 → （裁剪 surplus）→ 索引（最后写）。
   * 顺序与 webdav.uploadSnapshot 一致：索引永远最后落，任何一步失败都不会留下「索引指向不存在对象」的状态。
   *
   * @param {{dir: string, id: string, archive: Buffer, manifest: object, keepLast?: number,
   *          indexFile?: string, latestFile?: string, writeLatest?: boolean, message?: string}} opts
   */
  async uploadSnapshot(opts) {
    const dir = normalizeRepoPath(opts.dir ?? "backups");
    const id = String(opts.id);
    const keepLast = Math.max(1, Number(opts.keepLast) || 1);
    const indexFile = normalizeRepoPath(opts.indexFile ?? "index.json");
    const latestFile = normalizeRepoPath(opts.latestFile ?? "latest.tar.gz");
    const writeLatest = opts.writeLatest !== false;
    const archive = Buffer.isBuffer(opts.archive) ? opts.archive : Buffer.from(opts.archive);
    const createdAt = opts.manifest?.createdAt ?? new Date().toISOString();
    const message = opts.message ?? `dsh-sync-backup: snapshot ${id}`;

    const names = NAMING.github(id);
    const archivePath = `${dir}/${names.archive}`;
    const manifestPath = `${dir}/${names.manifest}`;
    const latestPath = `${dir}/${latestFile}`;
    const indexPath = `${dir}/${indexFile}`;

    const putArchive = await this.putFile(archivePath, archive, { message: `${message} (archive)` });
    const manifestBuf = Buffer.from(JSON.stringify(opts.manifest ?? {}, null, 2), "utf8");
    const putManifest = await this.putFile(manifestPath, manifestBuf, { message: `${message} (manifest)` });

    let putLatest;
    if (writeLatest) {
      putLatest = await this.putFile(latestPath, archive, { message: `${message} (latest)` });
    }

    const read = await this.readIndex(indexPath);
    // 索引是数据：先验证旧条目确实是本插件生成的文件名，再决定要不要动它们。
    const { valid, rejected, trustIndex } = filterIndexEntries(read.index?.entries ?? [], {
      style: "github",
      dir,
    });
    const entries = valid.filter((e) => e.id !== id);
    entries.push({
      id,
      createdAt,
      archive: names.archive,
      manifestFile: names.manifest,
      fileCount: opts.manifest?.fileCount ?? 0,
      totalBytes: opts.manifest?.totalBytes ?? 0,
      archiveBytes: archive.length,
      archiveSha256: opts.manifest?.archiveSha256 ?? undefined,
      commit: putArchive.commit,
    });
    entries.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

    const surplus = entries.slice(0, Math.max(0, entries.length - keepLast));
    const kept = entries.slice(Math.max(0, entries.length - keepLast));

    // ① 先写索引。索引一旦落盘就不再引用任何待删对象；反过来做会留下悬空条目。
    const nextIndex = {
      schemaVersion: 1,
      plugin: "dsh-sync-backup",
      channel: "github",
      repo: this.repo,
      dir,
      updatedAt: new Date().toISOString(),
      entries: kept,
    };
    const putIndex = await this.putFile(indexPath, JSON.stringify(nextIndex, null, 2), { message: `${message} (index)` });

    // ② 再 best-effort 删除。索引不可信时一个都不删 —— 孤儿文件可以下轮再收，
    //    删错一个文件却不可逆。
    const pruned = [];
    const pruneFailed = [];
    if (trustIndex) {
      for (const old of surplus) {
        for (const victim of [old.archive, old.manifestFile]) {
          if (typeof victim !== "string" || victim === "") continue;
          try {
            await this.deleteFile(`${dir}/${victim}`, { message: `${message} (prune)` });
            pruned.push(victim);
          } catch (err) {
            const why = err instanceof Error ? err.message : String(err);
            pruneFailed.push(`${victim}: ${why}`);
          }
        }
      }
    }

    return {
      dir,
      repo: this.repo,
      branch: this.branch,
      archivePath,
      manifestPath,
      latestPath: writeLatest ? latestPath : undefined,
      indexPath,
      archiveUrl: this.webUrl(archivePath),
      manifestUrl: this.webUrl(manifestPath),
      latestUrl: writeLatest ? this.webUrl(latestPath) : undefined,
      indexUrl: this.webUrl(indexPath),
      pruned,
      pruneFailed,
      indexTrusted: trustIndex,
      indexRejected: rejected,
      persisted: { archiveStatus: putArchive.status, manifestStatus: putManifest.status, latestStatus: putLatest?.status, indexStatus: putIndex.status },
      index: nextIndex,
    };
  }
}

export default {
  GitHubClient,
  GitHubError,
  MAX_CONTENT_BYTES,
  REDACTED,
  classifyStatus,
  defaultRequest,
  encodeRepoPath,
  joinApiUrl,
  normalizeRepoPath,
  parseRepo,
  requestOnce,
  withRetry,
};
