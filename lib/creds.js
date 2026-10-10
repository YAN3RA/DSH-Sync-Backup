/**
 * dsh-sync-backup / lib/creds.js
 *
 * 凭据解析：**优先走 DSH 官方 `ctx.credentials` 服务**，仅在服务不可用时回退为
 * 直接读 `$DSH_HOME/.credentials.yaml` 的 `refs:` 块。
 *
 * 为什么优先官方服务：口令的读写口径、加密、来源遮蔽（env 覆盖文件）都由它统一管理；
 * 自己解析 YAML 只是兼容旧版的兜底路径（dsh-config-manager 也是这个策略，
 * 见其 `lib/index.js:386-397` 的 `safeCredentialRef`）。
 *
 * 本模块**只读单向**：解析出的值只用于构造 Basic 认证头，永不写回、永不打印、
 * 永不进状态文件。
 *
 * @module dsh-sync-backup/lib/creds
 */

import { promises as fs } from "node:fs";
import path from "node:path";

/** 与 DSH 服务同形的 ref 名约束（POSIX 环境变量形态）。 */
export const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * 从 `.credentials.yaml` 文本里取某个 ref 的值。
 *
 * 只认两种布局（与 `dsh-config-manager/lib/security/credentials-yaml.js` 同口径）：
 *  1. 预发布扁平布局：顶层 `REF: value`
 *  2. v1 布局：`refs:` 块内的 `REF: value`
 *
 * **同名时 `refs:` 块为权威**；`records` / `payload` 等嵌套结构一律忽略；
 * 只接受非空字符串（值可带引号，会被剥掉）。
 *
 * @param {string} text YAML 文本
 * @param {string} ref  要取的 ref 名
 * @returns {string|undefined}
 */
export function readRefFromYaml(text, ref) {
  if (typeof text !== "string" || text === "") return undefined;
  if (!REF_PATTERN.test(ref)) return undefined;

  const lines = text.split(/\r?\n/);
  let flat; // 预发布扁平布局
  let inRefs; // v1 布局

  for (const line of lines) {
    if (/^\s*#/.test(line) || line.trim() === "") continue;

    // 顶层键（没有缩进）→ 切换所处区块
    const top = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:/.exec(line);
    if (top) {
      inRefs = top[1] === "refs";
      if (top[1] === ref) {
        const v = parseScalar(line.slice(top[0].length));
        if (v !== undefined) flat = v;
      }
      continue;
    }

    // 缩进行 → 只认 refs 块内的键
    if (!inRefs) continue;
    const m = /^\s+([A-Za-z_][A-Za-z0-9_]*)\s*:(.*)$/.exec(line);
    if (!m) continue;
    if (m[1] !== ref) continue;
    const v = parseScalar(m[2]);
    if (v !== undefined) return v; // refs 块即权威，命中即可返回
  }

  return flat;
}

/** 取标量值：去空白、剥成对引号，空串视为未设置。 */
function parseScalar(raw) {
  let s = String(raw ?? "").trim();
  if (s === "") return undefined;
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1);
  }
  return s === "" ? undefined : s;
}

/**
 * 解析一个凭据引用。
 *
 * 顺序：`ctx.credentials.resolve()`（官方，可能区分 env/file 来源）
 *      → 直接读 `.credentials.yaml`（兼容兜底）
 *
 * @param {object} ctx          Cordis 上下文
 * @param {string} home         $DSH_HOME
 * @param {string} ref          凭据引用名
 * @returns {Promise<{value:string, source:string}|undefined>}
 */
export async function resolveCredential(ctx, home, ref) {
  if (!REF_PATTERN.test(ref)) return undefined;

  // 1) 官方服务（可选服务：用 ctx.get 在调用时取，不做硬注入）
  const svc = typeof ctx?.get === "function" ? ctx.get("credentials") : ctx?.credentials;
  if (svc && typeof svc.resolve === "function") {
    try {
      // 服务要求品牌化 ref；包不可解析时退回原始字符串（服务只做字符串比较）
      let branded = ref;
      try {
        const mod = await import("@deepseek-ai/dsh-credentials");
        if (typeof mod.credentialRef === "function") branded = mod.credentialRef(ref);
      } catch {
        /* 包不可解析：用裸 ref，服务端 pattern 校验同样接受 */
      }
      const got = await svc.resolve(branded);
      if (got && typeof got.value === "string" && got.value !== "") {
        return { value: got.value, source: typeof got.source === "string" ? got.source : "credentials" };
      }
      return undefined; // 服务可用但未配置 → 不再回退读文件（口径以服务为准）
    } catch {
      /* 服务异常 → 落到文件兜底 */
    }
  }

  // 2) 文件兜底
  try {
    const p = path.join(home, ".credentials.yaml");
    const text = await fs.readFile(p, "utf8");
    const v = readRefFromYaml(text, ref);
    if (typeof v === "string" && v !== "") return { value: v, source: "file" };
  } catch {
    /* 文件不存在 / 不可读 */
  }
  return undefined;
}

/**
 * 解析 WebDAV 目标（url + username）。
 *
 * 优先级（2026-10-10 起调整，需求③）：
 * 1. `explicit` —— 本插件 patch 里手填的 `webdavUrl` / `webdavUsername`；
 * 2. config-manager 的既有配置 —— **仅作为迁移期的兜底**。
 *
 * 之所以保留第 2 条：已安装用户此前一直是靠它跑通的，直接砍掉会让通道当场断掉。
 * 但一旦照 v2 设计在 patch 里填了 url/username，就完全不看 config-manager 了。
 *
 * @param {string} home $DSH_HOME
 * @param {{url?:string, username?:string}} [explicit] 插件自带的显式配置
 * @returns {Promise<{url:string, username:string, source:string}|undefined>}
 */
export async function resolveWebdavTarget(home, explicit) {
  if (explicit && typeof explicit.url === "string" && explicit.url.trim() !== "" &&
      typeof explicit.username === "string" && explicit.username.trim() !== "") {
    return { url: explicit.url.trim(), username: explicit.username.trim(), source: "plugin-config" };
  }
  try {
    const p = path.join(home, "dsh-config-manager", "sync", "sync-config.json");
    const raw = await fs.readFile(p, "utf8");
    const cfg = JSON.parse(raw);
    const w = cfg?.webdav;
    if (w && typeof w.url === "string" && w.url.trim() !== "" && typeof w.username === "string" && w.username !== "") {
      return { url: w.url, username: w.username, source: "config-manager" };
    }
  } catch {
    /* 缺失 / 非法 JSON */
  }
  return undefined;
}
