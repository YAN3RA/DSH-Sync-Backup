/**
 * dsh-sync-backup / tools/version-check-smoke.mjs
 *
 * 只读版本检查的离线回归。**零网络**：所有网络入口都用注入的假 request，
 * 因此 CI 上不依赖 GitHub 可达性，也不会因为对方限流而假红。
 *
 * 覆盖四组：
 *   [A] 纯函数：tag 解析与版本比较（含边界与不可解析）
 *   [B] 请求形状：URL、方法、**不带 Authorization**、超时、响应上限
 *   [C] 失败收敛：网络错 / 404 / 5xx / 重定向 / 非 JSON / 缺 tag_name
 *   [D] 契约：发布源与 package.json 的 repository 同源；index.js 里的接线存在
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  compareVersions,
  fetchLatestRelease,
  latestReleaseUrl,
  parseReleaseTag,
  RELEASE_REPO,
  MAX_RELEASE_JSON_BYTES,
} from "../lib/version-check.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

let passed = 0;
let failed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    failed++;
    failures.push(`${name}: ${err && err.message ? err.message : String(err)}`);
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    passed++;
  } catch (err) {
    failed++;
    failures.push(`${name}: ${err && err.message ? err.message : String(err)}`);
  }
}
function section(title) {
  process.stdout.write(`\n—— ${title} ——\n`);
}

/** 造一个假响应；`body` 为对象时自动序列化成 JSON。 */
function fakeResponse(status, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body ?? {}), "utf8");
  return {
    status,
    ok: status >= 200 && status < 300,
    headers,
    buffer: buf,
    text: async () => buf.toString("utf8"),
  };
}

/** 记录调用参数的假 request。 */
function recorder(response) {
  const calls = [];
  const request = async (method, url, opts) => {
    calls.push({ method, url, opts });
    if (typeof response === "function") return response(method, url, opts);
    return response;
  };
  return { calls, request };
}

/* ---------------- A. 纯函数 ---------------- */

section("[A] tag 解析与版本比较");

check("解析发布标识 V1.3-261011", () => {
  const p = parseReleaseTag("V1.3-261011");
  assert.equal(p.format, "release");
  assert.deepEqual([p.major, p.minor, p.patch], [1, 3, 0]);
  assert.equal(p.date, "261011");
  assert.equal(p.semver, "1.3.0");
});

check("解析 semver 1.3.0 与 v1.3.0（两种前缀都认）", () => {
  assert.equal(parseReleaseTag("1.3.0").semver, "1.3.0");
  assert.equal(parseReleaseTag("v1.3.0").semver, "1.3.0");
  assert.equal(parseReleaseTag("v1.3.0").date, null);
});

check("无法识别的标识返回 undefined（不猜）", () => {
  for (const bad of ["", "  ", "latest", "V1-261011", "V1.3", "1.3", "1.3.0-beta.1", "V1.3-26101", "nightly-2026"]) {
    assert.equal(parseReleaseTag(bad), undefined, `应拒绝: ${JSON.stringify(bad)}`);
  }
});

check("远端更新 → outdated", () => {
  const c = compareVersions("1.3.0", "V1.4-261011");
  assert.equal(c.status, "outdated");
  assert.equal(c.localSemver, "1.3.0");
  assert.equal(c.remoteSemver, "1.4.0");
});

check("同一版本（semver 与 release tag 交叉比较）→ same", () => {
  assert.equal(compareVersions("1.3.0", "V1.3-261011").status, "same");
  assert.equal(compareVersions("1.3.0", "1.3.0").status, "same");
  assert.equal(compareVersions("1.3.0", "v1.3.0").status, "same");
});

check("本机更新（本地开发版）→ ahead，不提示更新", () => {
  assert.equal(compareVersions("1.4.0", "V1.3-261011").status, "ahead");
});

check("次版本比较优先于日期（V1.10 比 V1.9 新）", () => {
  assert.equal(compareVersions("1.9.0", "V1.10-261101").status, "outdated");
});

check("主版本跃迁也算 outdated", () => {
  assert.equal(compareVersions("1.9.0", "V2.0-270110").status, "outdated");
});

check("patch 位参与比较（1.3.1 vs 远端 1.3.0 → ahead）", () => {
  assert.equal(compareVersions("1.3.1", "V1.3-261011").status, "ahead");
});

check("任一侧不可解析 → unknown，并回带原始值供 UI 说明", () => {
  const c = compareVersions("1.3.0", "nightly");
  assert.equal(c.status, "unknown");
  assert.equal(c.remote, "nightly");
  assert.equal(c.remoteSemver, null);
  const d = compareVersions("dev", "V1.3-261011");
  assert.equal(d.status, "unknown");
  assert.equal(d.localSemver, null);
});

check("latestReleaseUrl 拼接正确（无重复斜杠）", () => {
  assert.equal(
    latestReleaseUrl("https://api.github.com/", "YAN3RA/DSH-Sync-Backup"),
    "https://api.github.com/repos/YAN3RA/DSH-Sync-Backup/releases/latest",
  );
  assert.equal(
    latestReleaseUrl("https://api.github.com", "YAN3RA/DSH-Sync-Backup"),
    "https://api.github.com/repos/YAN3RA/DSH-Sync-Backup/releases/latest",
  );
});

/* ---------------- B. 请求形状 ---------------- */

section("[B] 请求形状（只读、无凭据、有上限）");

await checkAsync("成功路径：GET + 正确 URL + 返回结构化字段", async () => {
  const rec = recorder(fakeResponse(200, {
    tag_name: "V1.4-261011",
    name: "V1.4-261011 发布说明",
    html_url: "https://github.com/YAN3RA/DSH-Sync-Backup/releases/tag/V1.4-261011",
    published_at: "2026-10-11T12:00:00Z",
    prerelease: false,
  }));
  const r = await fetchLatestRelease({ request: rec.request });
  assert.equal(r.ok, true);
  assert.equal(r.tag, "V1.4-261011");
  assert.equal(r.name, "V1.4-261011 发布说明");
  assert.ok(r.htmlUrl.includes("releases/tag/"));
  assert.equal(r.prerelease, false);

  assert.equal(rec.calls.length, 1, "必须只发一次请求");
  assert.equal(rec.calls[0].method, "GET");
  assert.equal(rec.calls[0].url, `https://api.github.com/repos/${RELEASE_REPO}/releases/latest`);
});

await checkAsync("请求头**不带任何凭据**（Authorization 缺席）", async () => {
  const rec = recorder(fakeResponse(200, { tag_name: "V1.0-261008" }));
  await fetchLatestRelease({ request: rec.request });
  const headers = rec.calls[0].opts.headers;
  const keys = Object.keys(headers).map((k) => k.toLowerCase());
  assert.ok(!keys.includes("authorization"), `不得带 Authorization: ${keys.join(",")}`);
  assert.ok(!keys.some((k) => k.includes("token")), "不得带任何 token 头");
  assert.equal(headers.accept, "application/vnd.github+json");
  assert.ok(String(headers["user-agent"]).startsWith("DSH-Sync-Backup/"));
});

await checkAsync("带响应上限与超时（不允许无界读取）", async () => {
  const rec = recorder(fakeResponse(200, { tag_name: "V1.0-261008" }));
  await fetchLatestRelease({ request: rec.request });
  assert.equal(rec.calls[0].opts.maxResponseBytes, MAX_RELEASE_JSON_BYTES);
  assert.ok(rec.calls[0].opts.timeoutMs > 0, "必须有超时");
});

await checkAsync("默认超时是有限值（不给 0 / 不给 undefined）", async () => {
  const rec = recorder(fakeResponse(200, { tag_name: "V1.0-261008" }));
  await fetchLatestRelease({ request: rec.request });
  assert.ok(Number.isFinite(rec.calls[0].opts.timeoutMs));
  assert.ok(rec.calls[0].opts.timeoutMs <= 60000);
});

await checkAsync("非本机明文 HTTP 的 apiBaseUrl 被拒（凭据/链路安全）", async () => {
  const rec = recorder(fakeResponse(200, { tag_name: "V1.0-261008" }));
  const r = await fetchLatestRelease({ request: rec.request, apiBaseUrl: "http://example.com" });
  assert.equal(r.ok, false);
  assert.ok(/HTTP|http/.test(r.message), `应说明是明文 HTTP 问题: ${r.message}`);
  assert.equal(rec.calls.length, 0, "被拒时不得发出请求");
});

await checkAsync("本机 loopback 的 http 放行（本地假服务可测）", async () => {
  const rec = recorder(fakeResponse(200, { tag_name: "V1.0-261008" }));
  const r = await fetchLatestRelease({ request: rec.request, apiBaseUrl: "http://127.0.0.1:8080" });
  assert.equal(r.ok, true);
  assert.equal(rec.calls[0].url, `http://127.0.0.1:8080/repos/${RELEASE_REPO}/releases/latest`);
});

await checkAsync("非法仓库标识被拒，且不发请求", async () => {
  const rec = recorder(fakeResponse(200, { tag_name: "V1.0-261008" }));
  for (const bad of ["", "owner", "owner/repo/extra", "own er/repo", "/repo"]) {
    const r = await fetchLatestRelease({ request: rec.request, repo: bad });
    assert.equal(r.ok, false, `应拒绝仓库标识: ${JSON.stringify(bad)}`);
  }
  assert.equal(rec.calls.length, 0);
});

/* ---------------- C. 失败收敛（一律 ok:false + 可读 message，绝不抛） ---------------- */

section("[C] 失败收敛");

await checkAsync("网络错误 → ok:false，附原文", async () => {
  const r = await fetchLatestRelease({
    request: async () => { const e = new Error("getaddrinfo ENOTFOUND api.github.com"); throw e; },
  });
  assert.equal(r.ok, false);
  assert.ok(r.message.includes("ENOTFOUND"), `原文必须保留: ${r.message}`);
  assert.ok(r.message.startsWith("网络错误"), `应说明类别: ${r.message}`);
});

await checkAsync("超时错误 → 同样收敛，不抛", async () => {
  const r = await fetchLatestRelease({
    request: async () => { const e = new Error("请求超时（15000 ms）"); e.name = "TimeoutError"; throw e; },
  });
  assert.equal(r.ok, false);
  assert.ok(/超时/.test(r.message));
});

await checkAsync("404 → 说明仓库不存在或尚未发布", async () => {
  const r = await fetchLatestRelease({ request: async () => fakeResponse(404, { message: "Not Found" }) });
  assert.equal(r.ok, false);
  assert.ok(r.message.includes("404"));
  assert.ok(/Release/.test(r.message));
});

await checkAsync("5xx → 报 HTTP 状态码", async () => {
  const r = await fetchLatestRelease({ request: async () => fakeResponse(503, "unavailable") });
  assert.equal(r.ok, false);
  assert.ok(r.message.includes("503"), r.message);
});

await checkAsync("3xx 重定向 → 按安全策略拒绝跟随（不静默跟过去）", async () => {
  const r = await fetchLatestRelease({
    request: async () => fakeResponse(302, "", { location: "http://169.254.169.254/latest/meta-data/" }),
  });
  assert.equal(r.ok, false);
  assert.ok(/重定向/.test(r.message), r.message);
  assert.ok(r.message.includes("302"));
});

await checkAsync("响应体不是 JSON → 报协议错误", async () => {
  const r = await fetchLatestRelease({ request: async () => fakeResponse(200, "<html>not json</html>") });
  assert.equal(r.ok, false);
  assert.ok(/JSON/.test(r.message), r.message);
});

await checkAsync("顶层是数组 → 拒绝", async () => {
  const r = await fetchLatestRelease({ request: async () => fakeResponse(200, [1, 2, 3]) });
  assert.equal(r.ok, false);
  assert.ok(/对象/.test(r.message), r.message);
});

await checkAsync("缺 tag_name / tag_name 为空 → 拒绝（不拿空串去比较）", async () => {
  for (const body of [{ name: "x" }, { tag_name: "" }, { tag_name: "   " }, { tag_name: 123 }]) {
    const r = await fetchLatestRelease({ request: async () => fakeResponse(200, body) });
    assert.equal(r.ok, false, `应拒绝: ${JSON.stringify(body)}`);
    assert.ok(/tag_name/.test(r.message), r.message);
  }
});

await checkAsync("响应体超限（ResponseTooLargeError）也被收敛", async () => {
  const r = await fetchLatestRelease({
    request: async () => { const e = new Error("响应体超过上限（300000 > 262144 字节）"); e.name = "ResponseTooLargeError"; throw e; },
  });
  assert.equal(r.ok, false);
  assert.ok(/上限/.test(r.message), r.message);
});

await checkAsync("端到端：远端更新时 compare 得出 outdated（host 端点就是这样组合的）", async () => {
  const rec = recorder(fakeResponse(200, { tag_name: "V1.4-261011" }));
  const rel = await fetchLatestRelease({ request: rec.request });
  assert.equal(rel.ok, true);
  assert.equal(compareVersions("1.3.0", rel.tag).status, "outdated");
});

/* ---------------- D. 契约 ---------------- */

section("[D] 接线与一致性契约");

check("RELEASE_REPO 与 package.json 的 repository.url 同源（改一处忘另一处会被拦）", () => {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const url = String(pkg.repository?.url ?? "");
  assert.ok(url.includes(RELEASE_REPO), `repository.url 与 RELEASE_REPO 不一致：${url} vs ${RELEASE_REPO}`);
});

check("index.js 已接线：import + view 字段 + 只读端点", () => {
  const src = readFileSync(path.join(root, "index.js"), "utf8");
  assert.ok(/from "\.\/lib\/version-check\.js"/.test(src), "缺少 version-check 的 import");
  assert.ok(/pluginVersion:\s*VERSION/.test(src), "view 未下发 pluginVersion");
  assert.ok(/releaseRepo:\s*RELEASE_REPO/.test(src), "view 未下发 releaseRepo");
  assert.ok(src.includes('case "sync-backup.check-update"'), "缺少 check-update 端点");
  // 端点必须走 okv（失败也是一个可显示的结果），不得 failv。
  const block = src.slice(src.indexOf('case "sync-backup.check-update"'));
  const body = block.slice(0, block.indexOf("default:"));
  assert.ok(body.includes("return okv("), "check-update 必须返回 okv");
  assert.ok(!body.includes("failv("), "check-update 不应把检查失败当成 RPC 错误");
});

check("host 半的 status 路径不出网（远端版本只在用户点击时查）", () => {
  const src = readFileSync(path.join(root, "index.js"), "utf8");
  // statusSnapshot 的函数体里不得出现 fetchLatestRelease。
  const start = src.indexOf("async function statusSnapshot()");
  assert.ok(start > 0, "找不到 statusSnapshot");
  const body = src.slice(start, src.indexOf("/* ---------------- 工具注册", start));
  assert.ok(!body.includes("fetchLatestRelease"), "status 快照里不得发起网络请求");
});

check("client 只在 EnvTab 的按钮里调用该端点（不进自动轮询路径）", () => {
  const src = readFileSync(path.join(root, "lib", "client.js"), "utf8");
  const hits = src.match(/call\("sync-backup\.check-update"/g) ?? [];
  assert.equal(hits.length, 1, `check-update 应只被调用一次，实际 ${hits.length} 次`);
  // useEffect 的自动刷新只允许调 status。
  for (const m of src.matchAll(/useEffect\(\(\)\s*=>\s*\{\s*void\s+(\w+)\(\)/g)) {
    assert.equal(m[1], "refresh", `自动执行的 effect 只能是 refresh：${m[1]}`);
  }
});

process.stdout.write(
  failed === 0
    ? `\nversion-check smoke 全部通过（${passed} 项）\n`
    : `\nversion-check smoke 失败 ${failed} 项 / 通过 ${passed} 项\n${failures.map((f) => `  ✗ ${f}`).join("\n")}\n`,
);
process.exit(failed === 0 ? 0 : 1);
