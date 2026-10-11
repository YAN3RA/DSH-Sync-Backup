/**
 * dsh-sync-backup · lib/version-check.js
 *
 * 只读版本检查：把「本机装的是哪一版」与「GitHub 上最新发布的是哪一版」摆到一起。
 *
 * 为什么单独成模块：这段逻辑要能在**不联网、不启动 DSH** 的前提下被测
 * （见 tools/version-check-smoke.mjs），所以网络入口是注入的 `request`，
 * 解析与比较全是纯函数。
 *
 * 安全边界（刻意收窄，改动时不要放宽）：
 *   - **只读**：一次 GET，不写任何文件、不改配置、不下载 asset、**不跟随重定向**。
 *   - **无凭据**：目标仓库是公开的，请求头里没有 Authorization —— 即便目标被
 *     篡改也偷不走 token（这正是不复用带 PAT 的 GitHubClient 的原因）。
 *   - **无用户输入**：请求 URL 由常量（apiBaseUrl + 仓库名）拼出，不接受调用方
 *     传入任意 URL，因此不存在「被引导去内网 / 云元数据」的输入面。
 *     apiBaseUrl 仍要过一遍 transport-guard：必须 https，或本机 http。
 *   - **小响应**：Release JSON 上限 256 KB（`requestOnce` 的 maxResponseBytes）。
 *
 * 零第三方依赖。
 *
 * @module dsh-sync-backup/lib/version-check
 */

import { GITHUB_API_VERSION, requestOnce } from "./github.js";
import { checkTransportUrl } from "./transport-guard.js";
import { userAgent } from "./version.js";

export const GITHUB_API_BASE_URL = "https://api.github.com";

/**
 * 发布源仓库。**必须与 package.json 的 repository.url 指向同一个仓库** ——
 * 这条一致性由 tools/version-check-smoke.mjs 断言，改一处忘另一处会被测试拦下。
 */
export const RELEASE_REPO = "YAN3RA/DSH-Sync-Backup";

/** Release JSON 的响应上限：正常只有几 KB。 */
export const MAX_RELEASE_JSON_BYTES = 256 * 1024;

/** 版本检查的网络超时。检查更新是交互动作，等太久不如早点报错。 */
export const DEFAULT_TIMEOUT_MS = 15000;

/** 发布标识：`V<主>.<次>-<日期>`（见 docs/VERSIONING.md）。 */
const RELEASE_TAG_RE = /^V(\d+)\.(\d+)-(\d{6})$/;
/** package.json 里的 semver 形态，允许可选的 v 前缀。 */
const SEMVER_TAG_RE = /^[vV]?(\d+)\.(\d+)\.(\d+)$/;
/** owner/repo 形态（与 lib/github.js 的 OWNER_RE / REPO_RE 同口径）。 */
const REPO_SPEC_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]{1,100}$/;

/**
 * 解析一个版本标识（发布 tag 或 package.json 的 semver），归一化成可比较的三元组。
 *
 * 两种形态都认：
 *   - `V1.3-261011` → { major:1, minor:3, patch:0, date:"261011", semver:"1.3.0" }
 *   - `1.3.0` / `v1.3.0` → { major:1, minor:3, patch:0, date:null, semver:"1.3.0" }
 *
 * 映射规则来自 docs/VERSIONING.md：`V<主>.<次>-<日期>` ↔ `<主>.<次>.0`，
 * 日期不进 semver。认不出来就返回 undefined（调用方据此报「无法比较」，
 * 而不是猜一个结果）。
 *
 * @param {string} tag
 * @returns {{raw:string, format:"release"|"semver", major:number, minor:number, patch:number, date:string|null, semver:string}|undefined}
 */
export function parseReleaseTag(tag) {
  const raw = String(tag ?? "").trim();
  if (raw === "") return undefined;

  const spec = RELEASE_TAG_RE.exec(raw);
  if (spec) {
    const major = Number(spec[1]);
    const minor = Number(spec[2]);
    return { raw, format: "release", major, minor, patch: 0, date: spec[3], semver: `${major}.${minor}.0` };
  }

  const sem = SEMVER_TAG_RE.exec(raw);
  if (sem) {
    const major = Number(sem[1]);
    const minor = Number(sem[2]);
    const patch = Number(sem[3]);
    return { raw, format: "semver", major, minor, patch, date: null, semver: `${major}.${minor}.${patch}` };
  }

  return undefined;
}

/**
 * 比较本机版本与远端发布标识。
 *
 * status 语义（**以远端为参照系**，与「我要不要更新」这个提问方向一致）：
 *   - `same`     远端与本机同一版本
 *   - `outdated` 远端更新 → 本机该更新了
 *   - `ahead`    本机更新 → 本地开发版，不必提示更新
 *   - `unknown`  任一侧解析不出来 → **不猜**，交给 UI 说明
 *
 * @param {string} localVersion  本机版本（package.json 的 semver）
 * @param {string} remoteTag     远端发布标识
 * @returns {{status:"same"|"outdated"|"ahead"|"unknown", local:string, remote:string, localSemver:string|null, remoteSemver:string|null}}
 */
export function compareVersions(localVersion, remoteTag) {
  const local = parseReleaseTag(localVersion);
  const remote = parseReleaseTag(remoteTag);
  const base = {
    local: local ? local.semver : String(localVersion ?? ""),
    remote: String(remoteTag ?? ""),
    localSemver: local ? local.semver : null,
    remoteSemver: remote ? remote.semver : null,
  };
  if (!local || !remote) return { status: "unknown", ...base };

  const l = [local.major, local.minor, local.patch];
  const r = [remote.major, remote.minor, remote.patch];
  let order = 0;
  for (let i = 0; i < 3; i += 1) {
    if (r[i] !== l[i]) {
      order = r[i] > l[i] ? 1 : -1;
      break;
    }
  }
  const status = order === 0 ? "same" : order > 0 ? "outdated" : "ahead";
  return { status, ...base };
}

/** `GET /repos/{owner}/{repo}/releases/latest` 的绝对 URL。 */
export function latestReleaseUrl(apiBaseUrl, repo) {
  const base = String(apiBaseUrl ?? GITHUB_API_BASE_URL).replace(/\/+$/, "");
  return `${base}/repos/${String(repo)}/releases/latest`;
}

/**
 * 读最新一个正式 Release。
 *
 * **不抛错**：一切失败都收敛成 `{ ok:false, message }`，因为「检查更新失败」
 * 对用户来说是一个要显示红字的结果，不是一次 RPC 崩溃。调用方（index.js）
 * 因此不需要区分异常类型。
 *
 * 刻意不使用 GitHubClient：那个客户端要 PAT、会跟随重定向、还会为了 PUT 做
 * 一堆与只读检查无关的事。这里只要一次不带凭据的 GET。
 *
 * @param {{repo?:string, apiBaseUrl?:string, request?:Function, timeoutMs?:number}} [opts]
 * @returns {Promise<{ok:true, tag:string, name:string, htmlUrl:string|null, publishedAt:string|null, prerelease:boolean}
 *                  |{ok:false, message:string}>}
 */
export async function fetchLatestRelease(opts = {}) {
  const repo = String(opts.repo ?? RELEASE_REPO);
  if (!REPO_SPEC_RE.test(repo) || repo.endsWith("/.") || repo.endsWith("/..")) {
    return { ok: false, message: `发布源仓库标识非法：${repo}` };
  }

  const apiBaseUrl = String(opts.apiBaseUrl ?? GITHUB_API_BASE_URL).replace(/\/+$/, "");
  const transport = checkTransportUrl(apiBaseUrl, { what: "GitHub API 地址" });
  if (!transport.ok) return { ok: false, message: transport.problem };

  const request = typeof opts.request === "function" ? opts.request : requestOnce;
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const url = latestReleaseUrl(apiBaseUrl, repo);

  let res;
  try {
    res = await request("GET", url, {
      // 没有 Authorization：公开仓库的只读检查不该带上任何凭据。
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": GITHUB_API_VERSION,
        "user-agent": userAgent("Version Check"),
      },
      timeoutMs,
      maxResponseBytes: MAX_RELEASE_JSON_BYTES,
    });
  } catch (err) {
    const why = err && err.message ? err.message : String(err);
    return { ok: false, message: `网络错误：${why}` };
  }

  // 不跟随重定向：api.github.com 的 /releases/latest 稳定直出结果，
  // 出现 3xx 说明链路被改道，报出来比默默跟过去更安全。
  if (res.status >= 300 && res.status < 400) {
    return { ok: false, message: `GitHub 返回重定向（HTTP ${res.status}），已按安全策略拒绝跟随` };
  }
  if (res.status === 404) {
    return { ok: false, message: "未找到最新 Release（HTTP 404）：仓库不存在，或尚未发布任何正式 Release" };
  }
  if (!res.ok) {
    return { ok: false, message: `GitHub 返回 HTTP ${res.status}` };
  }

  let json;
  try {
    json = JSON.parse(res.buffer.toString("utf8"));
  } catch {
    return { ok: false, message: "Release 响应不是合法 JSON" };
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return { ok: false, message: "Release 响应顶层必须是对象" };
  }

  const tag = typeof json.tag_name === "string" ? json.tag_name.trim() : "";
  if (tag === "") return { ok: false, message: "Release 响应缺少 tag_name" };

  return {
    ok: true,
    tag,
    name: typeof json.name === "string" && json.name !== "" ? json.name : tag,
    htmlUrl: typeof json.html_url === "string" && json.html_url !== "" ? json.html_url : null,
    publishedAt: typeof json.published_at === "string" && json.published_at !== "" ? json.published_at : null,
    prerelease: json.prerelease === true,
  };
}

export default {
  GITHUB_API_BASE_URL,
  RELEASE_REPO,
  MAX_RELEASE_JSON_BYTES,
  DEFAULT_TIMEOUT_MS,
  parseReleaseTag,
  compareVersions,
  latestReleaseUrl,
  fetchLatestRelease,
};
