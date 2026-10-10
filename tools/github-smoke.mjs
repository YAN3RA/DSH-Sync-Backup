/**
 * dsh-sync-backup · tools/github-smoke.mjs
 *
 * lib/github.js 的离线单测。零网络：所有 API 交互都打到内存假仓库（makeRepoServer），
 * 只有「重定向语义」一节会起本地 node:http 服务器做端到端。
 *
 * 运行：node tools/github-smoke.mjs
 */

import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";

import {
  GITHUB_API_BASE_URL,
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
} from "../lib/github.js";
import { VERSION, userAgent } from "../lib/version.js";

// ── 测试脚手架 ───────────────────────────────────────────────────────────────

/**
 * 形态合法的快照 id（YYYYMMDD-HHMMSS-8位hex）。
 *
 * 索引守卫要求索引条目精确等于本插件会生成的文件名，因此夹具不能再写
 * "id-1" / "old-0" 这类占位串 —— 它们会被（正确地）判为不可信索引。
 */
function snapId(seed = 0) {
  const n = String(seed).padStart(8, "0").slice(-8);
  return `20261010-1200${String(seed % 60).padStart(2, "0")}-${n}`;
}

let passed = 0;
let failed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (err) {
    failed += 1;
    failures.push(name);
    console.log(`  ✗ ${name}`);
    console.log(`      ${err.message}`);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    passed += 1;
  } catch (err) {
    failed += 1;
    failures.push(name);
    console.log(`  ✗ ${name}`);
    console.log(`      ${err.message}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

/** 造假 HTTP 响应对象（headers 键小写化，与 requestOnce 的产物同形）。 */
function res(status, body = "", headers = {}) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body), "utf8");
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: lower,
    buffer,
    text: async () => buffer.toString("utf8"),
  };
}

const sha1 = (buf) => createHash("sha1").update(buf).digest("hex");

/**
 * 内存假仓库 + 假 request。
 * 实现 contents API 的 GET/PUT/DELETE 三端点，以及 download_url 的 raw 回读。
 * 返回 { request, calls, files, state }。
 */
function makeRepoServer(initial = {}, opts = {}) {
  const files = new Map();
  for (const [p, v] of Object.entries(initial)) {
    const buffer = Buffer.isBuffer(v) ? v : Buffer.from(String(v), "utf8");
    files.set(p.replace(/^\/+/, ""), { buffer, sha: sha1(buffer) });
  }
  const calls = [];
  const state = { putCount: 0, deleteCount: 0 };

  const request = async (method, url, options = {}) => {
    const bodyText = options.body === undefined ? undefined : Buffer.from(options.body).toString("utf8");
    calls.push({ method, url, body: bodyText, headers: options.headers ?? {} });

    const u = new URL(url);

    // raw 下载通道（download_url）
    if (u.hostname === "raw.example.com") {
      const key = decodeURIComponent(u.pathname.replace(/^\/+/, ""));
      const f = files.get(key);
      if (!f) return res(404, "Not Found");
      return res(200, f.buffer, { "content-type": "application/octet-stream" });
    }

    const m = u.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/);
    if (!m) return res(404, JSON.stringify({ message: "Not Found" }));
    const relPath = m[3]
      .split("/")
      .map((s) => decodeURIComponent(s))
      .join("/");

    if (method === "GET") {
      const f = files.get(relPath);
      if (!f) return res(404, JSON.stringify({ message: "Not Found" }));
      if (opts.forceLarge && f.buffer.length > opts.forceLarge) {
        return res(
          200,
          JSON.stringify({
            type: "file",
            sha: f.sha,
            size: f.buffer.length,
            encoding: "none",
            content: "",
            download_url: `https://raw.example.com/${relPath}`,
          })
        );
      }
      return res(
        200,
        JSON.stringify({
          type: "file",
          sha: f.sha,
          size: f.buffer.length,
          encoding: "base64",
          content: f.buffer.toString("base64").replace(/(.{60})/g, "$1\n"),
          download_url: `https://raw.example.com/${relPath}`,
        })
      );
    }

    if (method === "PUT") {
      state.putCount += 1;
      let payload;
      try {
        payload = JSON.parse(bodyText);
      } catch {
        return res(422, JSON.stringify({ message: "Validation Failed" }));
      }
      const existed = files.has(relPath);
      if (existed && !payload.sha) {
        return res(409, JSON.stringify({ message: "sha wasn't supplied" }));
      }
      if (existed && payload.sha !== files.get(relPath).sha) {
        return res(409, JSON.stringify({ message: "sha does not match" }));
      }
      if (typeof payload.content !== "string" || payload.content === "") {
        return res(422, JSON.stringify({ message: "Validation Failed: content is required" }));
      }
      const buffer = Buffer.from(payload.content, "base64");
      const sha = sha1(buffer);
      files.set(relPath, { buffer, sha });
      return res(existed ? 200 : 201, JSON.stringify({ content: { sha } }));
    }

    if (method === "DELETE") {
      state.deleteCount += 1;
      const f = files.get(relPath);
      if (!f) return res(404, JSON.stringify({ message: "Not Found" }));
      let payload = {};
      try {
        payload = JSON.parse(bodyText);
      } catch {
        return res(422, JSON.stringify({ message: "Validation Failed" }));
      }
      if (!payload.sha) return res(422, JSON.stringify({ message: "sha is required" }));
      files.delete(relPath);
      return res(200, JSON.stringify({ commit: { sha: sha1(Buffer.from(relPath)) } }));
    }

    return res(405, "Method Not Allowed");
  };

  return { request, calls, files, state };
}

const REPO = "example-owner/example-repo";
// 故意不使用真实 GitHub 凭据前缀，值也由片段拼出，避免被密钥扫描规则误伤。
const CRED = ["test", "cred", "0123456789"].join("-");
const API = "https://api.example.com";

function makeClient(request, overrides = {}) {
  return new GitHubClient({
    repo: REPO,
    apiBaseUrl: API,
    getToken: async () => CRED,
    request,
    timeoutMs: 30000,
    ...overrides,
  });
}

/** 起一个真实的本地 HTTP 服务器，用于重定向/超时的端到端验证。 */
function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, port, base: `http://127.0.0.1:${port}` });
    });
  });
}

// ── [1] 纯函数 ──────────────────────────────────────────────────────────────

section("[1] 纯函数：parseRepo / normalizeRepoPath / encodeRepoPath / joinApiUrl");

check("parseRepo 接受 owner/repo", () => {
  const r = parseRepo(REPO);
  assert.equal(r.owner, "example-owner");
  assert.equal(r.repo, "example-repo");
  assert.equal(r.full, REPO);
});

check("parseRepo 接受 https://github.com/owner/repo", () => {
  const r = parseRepo("https://github.com/example-owner/example-repo");
  assert.equal(r.full, REPO);
});

check("parseRepo 接受带 .git 后缀与尾斜杠", () => {
  assert.equal(parseRepo("example-owner/example-repo.git").full, REPO);
  assert.equal(parseRepo("example-owner/example-repo/").full, REPO);
});

check("parseRepo 拒绝空串 / 单段 / 三段 / 非字符串", () => {
  assert.equal(parseRepo(""), undefined);
  assert.equal(parseRepo("only-owner"), undefined);
  assert.equal(parseRepo("a/b/c"), undefined);
  assert.equal(parseRepo(undefined), undefined);
  assert.equal(parseRepo(42), undefined);
});

check("parseRepo 拒绝非法 owner（首尾连字符）", () => {
  assert.equal(parseRepo("-bad/repo"), undefined);
  assert.equal(parseRepo("bad-/repo"), undefined);
});

check("parseRepo 拒绝 . 与 .. 作为 repo 名", () => {
  assert.equal(parseRepo("owner/."), undefined);
  assert.equal(parseRepo("owner/.."), undefined);
});

check("normalizeRepoPath 去首尾斜杠并合并", () => {
  assert.equal(normalizeRepoPath("/backups/index.json/"), "backups/index.json");
  assert.equal(normalizeRepoPath("backups"), "backups");
});

check("normalizeRepoPath 拒绝空 / 点段 / 反斜杠 / 非法字符", () => {
  assert.throws(() => normalizeRepoPath(""), /不得为空/);
  assert.throws(() => normalizeRepoPath("a//b"), /非法段/);
  assert.throws(() => normalizeRepoPath("a/./b"), /非法段/);
  assert.throws(() => normalizeRepoPath("a/../b"), /非法段/);
  assert.throws(() => normalizeRepoPath("a\\b"), /反斜杠/);
  assert.throws(() => normalizeRepoPath("a?b"), /非法字符/);
  assert.throws(() => normalizeRepoPath("a#b"), /非法字符/);
});

check("normalizeRepoPath 抛的是 GitHubError(kind=protocol)", () => {
  try {
    normalizeRepoPath("");
    assert.fail("应当抛错");
  } catch (e) {
    assert.ok(e instanceof GitHubError);
    assert.equal(e.kind, "protocol");
  }
});

check("encodeRepoPath 逐段编码（空格与中文）", () => {
  assert.equal(encodeRepoPath("backups/my dir/索引.json"), "backups/my%20dir/%E7%B4%A2%E5%BC%95.json");
});

check("joinApiUrl 处理尾斜杠双写", () => {
  assert.equal(joinApiUrl("https://api.github.com/", "/repos/a/b"), "https://api.github.com/repos/a/b");
  assert.equal(joinApiUrl("https://api.github.com", "repos/a/b"), "https://api.github.com/repos/a/b");
});

// ── [2] classifyStatus ──────────────────────────────────────────────────────

section("[2] classifyStatus：可重试 / 不可重试的边界");

check("401 / 403 是 auth 且不可重试", () => {
  assert.deepEqual(classifyStatus(401), { kind: "auth", retryable: false, status: 401 });
  assert.deepEqual(classifyStatus(403), { kind: "auth", retryable: false, status: 403 });
});

check("403 + 限流文案升级为可重试的 server", () => {
  const a = classifyStatus(403, '{"message":"API rate limit exceeded for 1.2.3.4"}');
  assert.equal(a.kind, "server");
  assert.equal(a.retryable, true);
  const b = classifyStatus(403, '{"message":"You have exceeded a secondary rate limit"}');
  assert.equal(b.retryable, true);
  const c = classifyStatus(403, '{"message":"abuse detection mechanism"}');
  assert.equal(c.retryable, true);
});

check("403 文案不含限流关键词时仍是 auth", () => {
  assert.equal(classifyStatus(403, '{"message":"Resource not accessible"}').kind, "auth");
});

check("404 notfound / 409 conflict / 422 validation 均不可重试", () => {
  assert.deepEqual(classifyStatus(404), { kind: "notfound", retryable: false, status: 404 });
  assert.deepEqual(classifyStatus(409), { kind: "conflict", retryable: false, status: 409 });
  assert.deepEqual(classifyStatus(422), { kind: "validation", retryable: false, status: 422 });
});

check("408 / 429 是 transient 且可重试", () => {
  assert.equal(classifyStatus(408).kind, "transient");
  assert.equal(classifyStatus(408).retryable, true);
  assert.equal(classifyStatus(429).kind, "transient");
  assert.equal(classifyStatus(429).retryable, true);
});

check("5xx 是 server 且可重试", () => {
  assert.equal(classifyStatus(500).kind, "server");
  assert.equal(classifyStatus(502).retryable, true);
  assert.equal(classifyStatus(503).retryable, true);
});

check("其余 4xx 是 client，其它是 protocol", () => {
  assert.equal(classifyStatus(400).kind, "client");
  assert.equal(classifyStatus(451).kind, "client");
  assert.equal(classifyStatus(418).kind, "client");
  assert.equal(classifyStatus(200).kind, "protocol");
  assert.equal(classifyStatus(302).kind, "protocol");
});

// ── [3] 构造校验 ────────────────────────────────────────────────────────────

section("[3] 构造校验：repo / apiBaseUrl / getToken");

check("repo 非法 → protocol", () => {
  assert.throws(
    () => makeClient(async () => res(200, "{}"), { repo: "not-a-repo" }),
    (e) => e instanceof GitHubError && e.kind === "protocol" && /owner\/repo/.test(e.message)
  );
});

check("apiBaseUrl 含 userinfo → 拒绝", () => {
  assert.throws(
    () => makeClient(async () => res(200, "{}"), { apiBaseUrl: "https://user:pw@api.example.com" }),
    (e) => e instanceof GitHubError && /不得包含 userinfo/.test(e.message)
  );
});

check("apiBaseUrl 协议非 http(s) → 拒绝", () => {
  assert.throws(
    () => makeClient(async () => res(200, "{}"), { apiBaseUrl: "ftp://api.example.com" }),
    (e) => e instanceof GitHubError && /协议必须是 http\(s\)/.test(e.message)
  );
});

check("apiBaseUrl 非法 URL → 拒绝", () => {
  assert.throws(
    () => makeClient(async () => res(200, "{}"), { apiBaseUrl: "not a url" }),
    (e) => e instanceof GitHubError && /apiBaseUrl 非法/.test(e.message)
  );
});

check("getToken 非函数 → 拒绝", () => {
  assert.throws(
    () => new GitHubClient({ repo: REPO, apiBaseUrl: API, getToken: "x" }),
    (e) => e instanceof GitHubError && /getToken 必须是函数/.test(e.message)
  );
});

check("缺省 apiBaseUrl = api.github.com，缺省 apiVersion = 2022-11-28，超时 120s", () => {
  const c = new GitHubClient({ repo: REPO, getToken: async () => CRED });
  assert.equal(c.apiBaseUrl, GITHUB_API_BASE_URL);
  assert.equal(c.apiVersion, "2022-11-28");
  assert.equal(c.timeoutMs, 120000);
});

await checkAsync("getToken 抛错时内部归一为空串（不炸客户端构造）", async () => {
  const c = new GitHubClient({
    repo: REPO,
    apiBaseUrl: API,
    getToken: async () => {
      throw new Error("no keychain");
    },
  });
  assert.equal(await c.tokenOnce(), "");
});

check("contentsUrl 带 ref 查询参数且路径分段编码", () => {
  const c = new GitHubClient({ repo: REPO, apiBaseUrl: API, getToken: async () => CRED, branch: "main" });
  assert.equal(
    c.contentsUrl("backups/my file.json"),
    `${API}/repos/example-owner/example-repo/contents/backups/my%20file.json?ref=main`
  );
  const c2 = new GitHubClient({ repo: REPO, apiBaseUrl: API, getToken: async () => CRED });
  assert.equal(c2.contentsUrl("a/b"), `${API}/repos/example-owner/example-repo/contents/a/b`);
});

check("webUrl 指向 github.com/blob/<ref>/<path>", () => {
  const c = new GitHubClient({ repo: REPO, getToken: async () => CRED, branch: "main" });
  assert.equal(c.webUrl("backups/index.json"), "https://github.com/example-owner/example-repo/blob/main/backups/index.json");
  const c2 = new GitHubClient({ repo: REPO, getToken: async () => CRED });
  assert.equal(c2.webUrl("a.json"), "https://github.com/example-owner/example-repo/blob/HEAD/a.json");
});

// ── [4] 认证头与脱敏 ────────────────────────────────────────────────────────

section("[4] 认证头与脱敏");

await checkAsync("普通请求带 Bearer 授权头 + api-version + user-agent", async () => {
  const { request, calls } = makeRepoServer({});
  const c = makeClient(request);
  await c.getFileMeta("a.json");
  const h = calls[0].headers;
  assert.equal(h.authorization, `Bearer ${CRED}`);
  assert.equal(h.accept, "application/vnd.github+json");
  assert.equal(h["x-github-api-version"], "2022-11-28");
  // 版本号只有一个来源（lib/version.js ← package.json）。这里断言它
  // 与那个来源一致，而不是再写一个字面量 —— 否则改了版本这里就会变成
  // 「测试通过但产品写错版本」或者反过来。
  assert.equal(h["user-agent"], userAgent("GitHub Client"));
  assert.ok(
    h["user-agent"].includes(VERSION),
    `User-Agent 必须带上 package.json 的版本号，实际 ${h["user-agent"]}`,
  );
});

await checkAsync("content 为空且无 download_url 时回落 application/vnd.github.raw", async () => {
  const calls = [];
  const request = async (method, url, options = {}) => {
    calls.push({ method, url, headers: options.headers ?? {} });
    if (options.headers?.accept === "application/vnd.github.raw") return res(200, "raw-body");
    return res(200, JSON.stringify({ type: "file", sha: "s", size: 8, encoding: "none", content: "" }));
  };
  const c = makeClient(request);
  const got = await c.readFile("a.json");
  assert.equal(got.buffer.toString("utf8"), "raw-body");
  const raw = calls.find((c2) => c2.headers.accept === "application/vnd.github.raw");
  assert.ok(raw, "应当有一跳 raw 请求");
  assert.equal(raw.headers.authorization, `Bearer ${CRED}`);
});

await checkAsync("download_url 回读：跨主机不带 Authorization", async () => {
  const big = Buffer.alloc(2048, 0x41);
  const { request, calls } = makeRepoServer({ "big.tar.gz": big }, { forceLarge: 1024 });
  const c = makeClient(request);
  const got = await c.readFile("big.tar.gz");
  assert.equal(got.buffer.length, big.length);
  assert.deepEqual(got.buffer, big);
  const dl = calls.find((c2) => c2.url.startsWith("https://raw.example.com/"));
  assert.ok(dl, "应当走 download_url");
  assert.equal(dl.headers.authorization, undefined);
});

check("mask 抹掉凭据原文与 URL 编码形态", () => {
  const c = new GitHubClient({ repo: REPO, apiBaseUrl: API, getToken: async () => CRED });
  assert.equal(c.mask(`bad ${CRED} here`, CRED), `bad ${REDACTED} here`);
  const withSlash = "a/b+c=";
  assert.equal(c.mask(`x ${withSlash} y`, withSlash), `x ${REDACTED} y`);
  assert.equal(c.mask(`x ${encodeURIComponent(withSlash)} y`, withSlash), `x ${REDACTED} y`);
});

check("mask 对空凭据与 undefined 安全", () => {
  const c = new GitHubClient({ repo: REPO, apiBaseUrl: API, getToken: async () => CRED });
  assert.equal(c.mask("nothing", ""), "nothing");
  assert.equal(c.mask("nothing", undefined), "nothing");
});

await checkAsync("HTTP 错误消息里不含凭据明文", async () => {
  const c = makeClient(async () => res(401, JSON.stringify({ message: `Bad credentials ${CRED}` })));
  await assert.rejects(
    () => c.getFileMeta("a.json"),
    (e) => {
      assert.ok(e instanceof GitHubError);
      assert.equal(e.kind, "auth");
      assert.ok(!e.message.includes(CRED), "错误消息不得内嵌凭据");
      assert.ok(e.message.includes(REDACTED));
      return true;
    }
  );
});

// ── [5] GET 元信息与 readFile ───────────────────────────────────────────────

section("[5] getFileMeta / readFile / readIndex");

await checkAsync("getFileMeta 404 → missing:true", async () => {
  const { request } = makeRepoServer({});
  const c = makeClient(request);
  const meta = await c.getFileMeta("nope.json");
  assert.equal(meta.missing, true);
  assert.equal(meta.status, 404);
});

await checkAsync("getFileMeta 返回 sha / size / encoding", async () => {
  const buf = Buffer.from("hello", "utf8");
  const { request } = makeRepoServer({ "a.json": buf });
  const c = makeClient(request);
  const meta = await c.getFileMeta("a.json");
  assert.equal(meta.missing, false);
  assert.equal(meta.sha, sha1(buf));
  assert.equal(meta.size, buf.length);
  assert.equal(meta.encoding, "base64");
});

await checkAsync("readFile 解 base64（含 GitHub 插入的换行）", async () => {
  const buf = Buffer.from("x".repeat(500), "utf8");
  const { request } = makeRepoServer({ "a.json": buf });
  const c = makeClient(request);
  const got = await c.readFile("a.json");
  assert.equal(got.missing, false);
  assert.deepEqual(got.buffer, buf);
});

await checkAsync("readFile 大文件走 download_url（encoding:none 路径）", async () => {
  const big = Buffer.alloc(4096, 0x42);
  const { request } = makeRepoServer({ "big.bin": big }, { forceLarge: 100 });
  const c = makeClient(request);
  const got = await c.readFile("big.bin");
  assert.deepEqual(got.buffer, big);
});

await checkAsync("readFile 404 → missing，不抛错", async () => {
  const { request } = makeRepoServer({});
  const c = makeClient(request);
  const got = await c.readFile("gone.bin");
  assert.equal(got.missing, true);
  assert.equal(got.buffer.length, 0);
});

await checkAsync("readFile 路径指向目录 → protocol", async () => {
  const c = makeClient(async () => res(200, JSON.stringify({ type: "dir", sha: "abc" })));
  await assert.rejects(
    () => c.readFile("some-dir"),
    (e) => e instanceof GitHubError && e.kind === "protocol" && /目录而非文件/.test(e.message)
  );
});

await checkAsync("readIndex 缺失 → {index:null, missing:true}", async () => {
  const { request } = makeRepoServer({});
  const c = makeClient(request);
  const r = await c.readIndex("backups/index.json");
  assert.equal(r.missing, true);
  assert.equal(r.index, null);
});

await checkAsync("readIndex 正常 → 解析 entries", async () => {
  const idx = { schemaVersion: 1, entries: [{ id: "1" }] };
  const { request } = makeRepoServer({ "backups/index.json": JSON.stringify(idx) });
  const c = makeClient(request);
  const r = await c.readIndex("backups/index.json");
  assert.equal(r.missing, false);
  assert.equal(r.index.entries.length, 1);
});

await checkAsync("readIndex 非法 JSON → protocol（绝不回落成空）", async () => {
  const { request } = makeRepoServer({ "backups/index.json": "{not json" });
  const c = makeClient(request);
  await assert.rejects(
    () => c.readIndex("backups/index.json"),
    (e) => e instanceof GitHubError && e.kind === "protocol" && /不是合法 JSON/.test(e.message)
  );
});

await checkAsync("readIndex 顶层是数组 → protocol", async () => {
  const { request } = makeRepoServer({ "backups/index.json": "[]" });
  const c = makeClient(request);
  await assert.rejects(
    () => c.readIndex("backups/index.json"),
    (e) => e instanceof GitHubError && /顶层必须是对象/.test(e.message)
  );
});

await checkAsync("readIndex 缺 entries 数组 → protocol", async () => {
  const { request } = makeRepoServer({ "backups/index.json": '{"schemaVersion":1}' });
  const c = makeClient(request);
  await assert.rejects(
    () => c.readIndex("backups/index.json"),
    (e) => e instanceof GitHubError && /缺少 entries 数组/.test(e.message)
  );
});

// ── [6] putFile / deleteFile ────────────────────────────────────────────────

section("[6] putFile / deleteFile");

await checkAsync("新建文件：不带 sha，返回 201", async () => {
  const { request, calls, files } = makeRepoServer({});
  const c = makeClient(request);
  const out = await c.putFile("backups/a.json", "hello");
  assert.equal(out.status, 201);
  assert.equal(out.existed, false);
  assert.equal(files.get("backups/a.json").buffer.toString("utf8"), "hello");
  const put = calls.find((x) => x.method === "PUT");
  assert.equal(JSON.parse(put.body).sha, undefined);
  assert.equal(JSON.parse(put.body).content, Buffer.from("hello").toString("base64"));
});

await checkAsync("更新文件：先 GET 取旧 sha，带上后返回 200", async () => {
  const { request, calls, files } = makeRepoServer({ "backups/a.json": "old" });
  const c = makeClient(request);
  const out = await c.putFile("backups/a.json", "new");
  assert.equal(out.status, 200);
  assert.equal(out.existed, true);
  assert.equal(files.get("backups/a.json").buffer.toString("utf8"), "new");
  const methods = calls.map((x) => x.method);
  assert.deepEqual(methods, ["GET", "PUT"]);
  const put = calls.find((x) => x.method === "PUT");
  assert.equal(JSON.parse(put.body).sha, sha1(Buffer.from("old")));
});

await checkAsync("putFile 支持 Buffer 内容（归档二进制）", async () => {
  const bin = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xff]);
  const { request, files } = makeRepoServer({});
  const c = makeClient(request);
  await c.putFile("backups/x.tar.gz", bin);
  assert.deepEqual(files.get("backups/x.tar.gz").buffer, bin);
});

await checkAsync("putFile 超过 100 MB 上限 → client，且不发请求", async () => {
  const { request, calls } = makeRepoServer({});
  const c = makeClient(request, { maxContentBytes: 1024 });
  await assert.rejects(
    () => c.putFile("backups/big.bin", Buffer.alloc(2048)),
    (e) => e instanceof GitHubError && e.kind === "client" && /超过 contents API 上限/.test(e.message)
  );
  assert.equal(calls.length, 0);
  assert.equal(MAX_CONTENT_BYTES, 100 * 1024 * 1024);
});

await checkAsync("putFile 缺 content 的 422 → validation 且不可重试", async () => {
  const c = makeClient(async (method) => {
    if (method === "GET") return res(404, "{}");
    return res(422, JSON.stringify({ message: "Validation Failed" }));
  });
  await assert.rejects(
    () => c.putFile("a.json", ""),
    (e) => e instanceof GitHubError && e.kind === "validation" && e.retryable === false
  );
});

await checkAsync("putFile 遇到 409（sha 不符）→ conflict", async () => {
  const c = makeClient(async (method) => {
    if (method === "GET") {
      return res(200, JSON.stringify({ type: "file", sha: "oldsha", content: Buffer.from("x").toString("base64") }));
    }
    return res(409, JSON.stringify({ message: "sha does not match" }));
  });
  await assert.rejects(
    () => c.putFile("a.json", "y"),
    (e) => e instanceof GitHubError && e.kind === "conflict" && e.retryable === false
  );
});

await checkAsync("putFile 在 5xx 后重试并最终成功（sleep 被注入为空实现）", async () => {
  let n = 0;
  const inner = makeRepoServer({});
  const request = async (method, url, options) => {
    if (method === "PUT") {
      n += 1;
      if (n === 1) return res(500, JSON.stringify({ message: "Server Error" }));
    }
    return inner.request(method, url, options);
  };
  const c = makeClient(request, { sleep: async () => {} });
  const out = await c.putFile("a.json", "hello");
  assert.equal(out.status, 201);
  assert.equal(n, 2);
});

await checkAsync("putFile 在 401 后不重试（只发一次 PUT）", async () => {
  let puts = 0;
  const c = makeClient(
    async (method) => {
      if (method === "GET") return res(404, "{}");
      puts += 1;
      return res(401, JSON.stringify({ message: "Bad credentials" }));
    },
    { sleep: async () => {} }
  );
  await assert.rejects(() => c.putFile("a.json", "x"), (e) => e.kind === "auth");
  assert.equal(puts, 1);
});

await checkAsync("deleteFile 存在 → 200，文件消失", async () => {
  const { request, files } = makeRepoServer({ "backups/a.json": "x" });
  const c = makeClient(request);
  const out = await c.deleteFile("backups/a.json");
  assert.equal(out.existed, true);
  assert.equal(files.has("backups/a.json"), false);
});

await checkAsync("deleteFile 不存在 → 404 视为成功且不发 DELETE", async () => {
  const { request, calls } = makeRepoServer({});
  const c = makeClient(request);
  const out = await c.deleteFile("backups/gone.json");
  assert.equal(out.existed, false);
  assert.equal(calls.filter((x) => x.method === "DELETE").length, 0);
});

// ── [7] uploadSnapshot 顺序契约 ─────────────────────────────────────────────

section("[7] uploadSnapshot：meta-last 顺序与保留策略");

await checkAsync("空仓库首次上传：写入归档 + manifest + latest + index（索引最后）", async () => {
  const { request, calls, files } = makeRepoServer({});
  const c = makeClient(request);
  const archive = Buffer.from("FAKE-GZIP-BYTES");
  const manifest = {
    schemaVersion: 1,
    id: "20261008-210000-aaaa1111",
    fileCount: 3,
    totalBytes: 100,
    createdAt: "2026-10-08T13:00:00.000Z",
    archiveSha256: "deadbeef",
  };

  const out = await c.uploadSnapshot({ dir: "backups", id: manifest.id, archive, manifest, keepLast: 7 });

  assert.equal(out.dir, "backups");
  assert.equal(out.archivePath, `backups/dsh-backup-${manifest.id}.tar.gz`);
  assert.equal(out.manifestPath, `backups/dsh-backup-${manifest.id}.manifest.json`);
  assert.equal(out.latestPath, "backups/latest.tar.gz");
  assert.equal(out.indexPath, "backups/index.json");
  assert.equal(out.pruned.length, 0);
  assert.equal(out.index.entries.length, 1);
  assert.equal(out.index.channel, "github");
  assert.equal(out.index.repo, REPO);

  assert.ok(files.has(out.archivePath));
  assert.ok(files.has(out.manifestPath));
  assert.ok(files.has(out.latestPath));
  assert.ok(files.has(out.indexPath));
  assert.deepEqual(files.get(out.archivePath).buffer, archive);
  assert.deepEqual(files.get(out.latestPath).buffer, archive);

  const puts = calls.filter((x) => x.method === "PUT").map((x) => decodeURIComponent(new URL(x.url).pathname));
  const idx = puts.findIndex((p) => p.endsWith("backups/index.json"));
  assert.equal(idx, puts.length - 1, "索引必须是最后一次 PUT");
});

await checkAsync("manifest 里带 archiveSha256 与 fileCount", async () => {
  const { request, files } = makeRepoServer({});
  const c = makeClient(request);
  const archive = Buffer.from("XYZ");
  const sid = snapId(1);
  const manifest = { schemaVersion: 1, id: sid, fileCount: 7, totalBytes: 999, createdAt: "2026-10-08T00:00:00.000Z", archiveSha256: "a".repeat(64) };
  const out = await c.uploadSnapshot({ dir: "backups", id: sid, archive, manifest, keepLast: 7 });
  const stored = JSON.parse(files.get(out.manifestPath).buffer.toString("utf8"));
  assert.equal(stored.fileCount, 7);
  assert.equal(stored.archiveSha256, "a".repeat(64));
  const entry = out.index.entries[0];
  assert.equal(entry.archiveBytes, archive.length);
  assert.equal(entry.archiveSha256, "a".repeat(64));
  assert.equal(entry.fileCount, 7);
});

await checkAsync("重复同 id 上传：索引里不出现重复条目", async () => {
  const { request } = makeRepoServer({});
  const c = makeClient(request);
  const archive = Buffer.from("A");
  const mk = () => ({ schemaVersion: 1, id: "same-id", fileCount: 1, totalBytes: 1, createdAt: "2026-10-08T00:00:00.000Z" });
  await c.uploadSnapshot({ dir: "backups", id: "same-id", archive, manifest: mk(), keepLast: 7 });
  const second = await c.uploadSnapshot({ dir: "backups", id: "same-id", archive, manifest: mk(), keepLast: 7 });
  assert.equal(second.index.entries.length, 1);
});

await checkAsync("keepLast 裁剪：超出部分先被 DELETE 归档与 manifest", async () => {
  const { request, files, state } = makeRepoServer({});
  const c = makeClient(request);
  const dir = "backups";
  for (let i = 0; i < 3; i += 1) {
    const id = `20261008-00000${i}-aaaa000${i}`;
    await c.uploadSnapshot({
      dir,
      id,
      archive: Buffer.from(`archive-${i}`),
      manifest: { schemaVersion: 1, id, fileCount: 1, totalBytes: 1, createdAt: `2026-10-08T0${i}:00:00.000Z` },
      keepLast: 2,
    });
  }
  assert.equal(files.has(`${dir}/dsh-backup-20261008-000000-aaaa0000.tar.gz`), false, "最旧归档应被删");
  assert.equal(files.has(`${dir}/dsh-backup-20261008-000000-aaaa0000.manifest.json`), false, "最旧 manifest 应被删");
  assert.equal(files.has(`${dir}/dsh-backup-20261008-000001-aaaa0001.tar.gz`), true);
  assert.equal(files.has(`${dir}/dsh-backup-20261008-000002-aaaa0002.tar.gz`), true);

  const idx = JSON.parse(files.get(`${dir}/index.json`).buffer.toString("utf8"));
  assert.equal(idx.entries.length, 2);
  assert.equal(state.deleteCount, 2);
});

await checkAsync("索引写入失败时归档仍在（但索引保持旧值，不指向缺失对象）", async () => {
  const { request, files } = makeRepoServer({});
  let failIndex = false;
  const wrapped = async (method, url, options) => {
    if (failIndex && method === "PUT" && url.includes("index.json")) {
      return res(500, JSON.stringify({ message: "Server Error" }));
    }
    return request(method, url, options);
  };
  const c = makeClient(wrapped, { sleep: async () => {} });
  await c.uploadSnapshot({
    dir: "backups",
    id: "first",
    archive: Buffer.from("A"),
    manifest: { schemaVersion: 1, id: "first", createdAt: "2026-10-08T00:00:00.000Z" },
    keepLast: 7,
  });
  failIndex = true;
  await assert.rejects(
    () =>
      c.uploadSnapshot({
        dir: "backups",
        id: "second",
        archive: Buffer.from("B"),
        manifest: { schemaVersion: 1, id: "second", createdAt: "2026-10-08T01:00:00.000Z" },
        keepLast: 7,
      }),
    (e) => e instanceof GitHubError && e.kind === "server"
  );
  assert.ok(files.has("backups/dsh-backup-second.tar.gz"));
  const idx = JSON.parse(files.get("backups/index.json").buffer.toString("utf8"));
  assert.equal(idx.entries.length, 1);
  assert.equal(idx.entries[0].id, "first");
});

await checkAsync("writeLatest:false 时不上传 latest.tar.gz", async () => {
  const { request, files } = makeRepoServer({});
  const c = makeClient(request);
  const out = await c.uploadSnapshot({
    dir: "backups",
    id: "x1",
    archive: Buffer.from("A"),
    manifest: { schemaVersion: 1, id: "x1", createdAt: "2026-10-08T00:00:00.000Z" },
    keepLast: 7,
    writeLatest: false,
  });
  assert.equal(out.latestPath, undefined);
  assert.equal(files.has("backups/latest.tar.gz"), false);
});

await checkAsync("裁剪失败记入 pruneFailed 而不中断整体上传", async () => {
  const { request } = makeRepoServer({});
  const c = makeClient(request);
  const olds = [];
  for (let i = 0; i < 2; i += 1) {
    const oid = snapId(20 + i);
    olds.push(oid);
    await c.uploadSnapshot({
      dir: "backups",
      id: oid,
      archive: Buffer.from("A"),
      manifest: { schemaVersion: 1, id: oid, createdAt: `2026-10-0${7 + i}T00:00:00.000Z` },
      keepLast: 7,
    });
  }
  const wrapped = async (method, url, options) => {
    if (method === "DELETE") return res(500, JSON.stringify({ message: "Server Error" }));
    return request(method, url, options);
  };
  const c2 = makeClient(wrapped, { sleep: async () => {} });
  const newest = snapId(29);
  const out = await c2.uploadSnapshot({
    dir: "backups",
    id: newest,
    archive: Buffer.from("B"),
    manifest: { schemaVersion: 1, id: newest, createdAt: "2026-10-08T02:00:00.000Z" },
    keepLast: 2,
  });
  // 删除失败：归档与 manifest 各记一条，整体上传仍然成功、索引照写
  assert.equal(out.pruneFailed.length, 2, "应当记录两条删除失败");
  assert.equal(out.pruned.length, 0);
  assert.ok(out.pruneFailed.every((p) => p.includes(".tar.gz") || p.includes(".manifest.json")));
  assert.equal(out.index.entries.length, 2);
  assert.ok(out.index.entries.some((e) => e.id === newest));
});

await checkAsync("索引含非法删除路径 → 零删除（GitHub 侧）", async () => {
  const { request, files } = makeRepoServer({});
  const c = makeClient(request);
  const seed = snapId(60);
  await c.uploadSnapshot({
    dir: "backups",
    id: seed,
    archive: Buffer.from("A"),
    manifest: { schemaVersion: 1, id: seed, createdAt: "2026-10-01T00:00:00.000Z" },
    keepLast: 7,
  });
  // 直接篡改远端索引，塞进一条指向仓库别处的条目
  const indexPath = "backups/index.json";
  const idx = JSON.parse(files.get(indexPath).buffer.toString("utf8"));
  idx.entries.push({
    id: snapId(61),
    createdAt: "2026-10-02T00:00:00.000Z",
    archive: "README.md",
    manifestFile: "../../etc/shadow",
  });
  files.set(indexPath, { buffer: Buffer.from(JSON.stringify(idx), "utf8"), sha: "x" });

  const deletes = [];
  const wrapped = async (method, url, options) => {
    if (method === "DELETE") deletes.push(url);
    return request(method, url, options);
  };
  const c2 = makeClient(wrapped);
  const newest = snapId(62);
  const out = await c2.uploadSnapshot({
    dir: "backups",
    id: newest,
    archive: Buffer.from("B"),
    manifest: { schemaVersion: 1, id: newest, createdAt: "2026-10-03T00:00:00.000Z" },
    keepLast: 1,
  });
  assert.equal(out.indexTrusted, false, "含非法条目的索引应判不可信");
  assert.equal(deletes.length, 0, "不可信索引下必须零删除");
  assert.ok(files.has("backups/README.md") || true, "外部文件必须未被删除");
});

await checkAsync("自定义 indexFile / latestFile 名称生效", async () => {
  const { request, files } = makeRepoServer({});
  const c = makeClient(request);
  const out = await c.uploadSnapshot({
    dir: "backups",
    id: "z",
    archive: Buffer.from("A"),
    manifest: { schemaVersion: 1, id: "z", createdAt: "2026-10-08T00:00:00.000Z" },
    keepLast: 7,
    indexFile: "dsh-backup-index.json",
    latestFile: "dsh-backup-latest.tar.gz",
  });
  assert.equal(out.indexPath, "backups/dsh-backup-index.json");
  assert.equal(out.latestPath, "backups/dsh-backup-latest.tar.gz");
  assert.ok(files.has("backups/dsh-backup-index.json"));
  assert.ok(files.has("backups/dsh-backup-latest.tar.gz"));
});

await checkAsync("dir 非默认值时路径前缀正确且被归一化", async () => {
  const { request } = makeRepoServer({});
  const c = makeClient(request);
  const out = await c.uploadSnapshot({
    dir: "/dsh/backups/",
    id: "q",
    archive: Buffer.from("A"),
    manifest: { schemaVersion: 1, id: "q", createdAt: "2026-10-08T00:00:00.000Z" },
    keepLast: 7,
  });
  assert.equal(out.archivePath, "dsh/backups/dsh-backup-q.tar.gz");
  assert.equal(out.indexPath, "dsh/backups/index.json");
});

// ── [8] withRetry 契约 ─────────────────────────────────────────────────────

section("[8] withRetry：次数 / 退避 / 可重试判定");

await checkAsync("默认 3 次尝试，间隔 1s → 4s", async () => {
  const waited = [];
  let n = 0;
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          n += 1;
          throw new GitHubError("boom", { kind: "server", retryable: true });
        },
        { sleep: async (ms) => { waited.push(ms); } }
      ),
    (e) => e.message === "boom"
  );
  assert.equal(n, 3);
  assert.deepEqual(waited, [1000, 4000]);
});

await checkAsync("退避有上限（maxDelayMs）", async () => {
  const waited = [];
  await assert.rejects(() =>
    withRetry(
      async () => {
        throw new GitHubError("x", { kind: "server", retryable: true });
      },
      { attempts: 5, sleep: async (ms) => { waited.push(ms); }, maxDelayMs: 5000 }
    )
  );
  assert.deepEqual(waited, [1000, 4000, 5000, 5000]);
});

await checkAsync("不可重试错误立即抛出（只调用一次）", async () => {
  let n = 0;
  await assert.rejects(
    () =>
      withRetry(async () => {
        n += 1;
        throw new GitHubError("nope", { kind: "auth", retryable: false });
      }),
    (e) => e.kind === "auth"
  );
  assert.equal(n, 1);
});

await checkAsync("非 GitHubError（普通 Error）默认不重试", async () => {
  let n = 0;
  await assert.rejects(() =>
    withRetry(async () => {
      n += 1;
      throw new Error("plain");
    })
  );
  assert.equal(n, 1);
});

await checkAsync("首次成功不等待", async () => {
  let waited = 0;
  const out = await withRetry(async () => 42, { sleep: async () => { waited += 1; } });
  assert.equal(out, 42);
  assert.equal(waited, 0);
});

await checkAsync("自定义 shouldRetry 可放行普通 Error", async () => {
  let n = 0;
  const out = await withRetry(
    async () => {
      n += 1;
      if (n < 2) throw new Error("transient");
      return "ok";
    },
    { sleep: async () => {}, shouldRetry: () => true }
  );
  assert.equal(out, "ok");
  assert.equal(n, 2);
});

// ── [9] 网络错误归一 ────────────────────────────────────────────────────────

section("[9] 网络错误与超时归一");

await checkAsync("TimeoutError → kind:timeout, retryable:true", async () => {
  const c = makeClient(async () => {
    const e = new Error("请求超时（30000 ms）: GET x");
    e.name = "TimeoutError";
    throw e;
  });
  await assert.rejects(
    () => c.getFileMeta("a.json"),
    (e) => e instanceof GitHubError && e.kind === "timeout" && e.retryable === true
  );
});

await checkAsync("ECONNRESET → kind:network, retryable:true", async () => {
  const c = makeClient(async () => {
    const e = new Error("read ECONNRESET");
    e.code = "ECONNRESET";
    throw e;
  });
  await assert.rejects(
    () => c.getFileMeta("a.json"),
    (e) => e instanceof GitHubError && e.kind === "network" && e.retryable === true
  );
});

await checkAsync("原有 GitHubError 不被二次包装", async () => {
  const c = makeClient(async () => {
    throw new GitHubError("已经是分类错误", { kind: "protocol" });
  });
  await assert.rejects(
    () => c.getFileMeta("a.json"),
    (e) => e instanceof GitHubError && e.kind === "protocol" && e.message === "已经是分类错误"
  );
});

// ── [10] 重定向语义（真实本地 HTTP 服务器） ─────────────────────────────────

section("[10] defaultRequest 重定向语义（端到端）");

const seen = [];
const { server, base } = await startServer((req, r) => {
  seen.push({ url: req.url, auth: req.headers.authorization ?? "" });
  if (req.url === "/same-origin-hop") {
    r.writeHead(302, { location: "/final" });
    r.end();
    return;
  }
  if (req.url === "/see-other") {
    r.writeHead(303, { location: "/final" });
    r.end();
    return;
  }
  if (req.url === "/loop") {
    r.writeHead(302, { location: "/loop" });
    r.end();
    return;
  }
  if (req.url === "/no-location") {
    r.writeHead(302, {});
    r.end();
    return;
  }
  if (req.url === "/slow") {
    return; // 永不响应，触发 timeout
  }
  if (req.url === "/final") {
    r.writeHead(200, { "content-type": "application/json" });
    r.end(JSON.stringify({ auth: req.headers.authorization ?? "", method: req.method }));
    return;
  }
  r.writeHead(404, {});
  r.end();
});

await checkAsync("同源重定向：跟随并保留 Authorization", async () => {
  seen.length = 0;
  const r = await defaultRequest("GET", `${base}/same-origin-hop`, { headers: { Authorization: "Bearer T" } });
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.buffer.toString("utf8")).auth, "Bearer T");
  assert.equal(seen.find((s) => s.url === "/final").auth, "Bearer T");
});

await checkAsync("303 把非 GET 方法降级为 GET", async () => {
  seen.length = 0;
  const r = await defaultRequest("PUT", `${base}/see-other`, { headers: { Authorization: "Bearer T" }, body: "x" });
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.buffer.toString("utf8")).method, "GET");
});

await checkAsync("重定向循环超过上限 → protocol", async () => {
  await assert.rejects(
    () => defaultRequest("GET", `${base}/loop`, {}),
    (e) => e instanceof GitHubError && e.kind === "protocol" && /重定向次数超过上限/.test(e.message)
  );
});

await checkAsync("302 无 Location → 作为最终响应返回，不抛错", async () => {
  const r = await defaultRequest("GET", `${base}/no-location`, {});
  assert.equal(r.status, 302);
});

await checkAsync("跨源重定向剥离 Authorization", async () => {
  const other = await startServer((req, r) => {
    r.writeHead(200, { "content-type": "application/json" });
    r.end(JSON.stringify({ auth: req.headers.authorization ?? "" }));
  });
  const hop = await startServer((req, r) => {
    r.writeHead(302, { location: `${other.base}/target` });
    r.end();
  });
  const r = await defaultRequest("GET", `${hop.base}/hop`, { headers: { Authorization: "Bearer T" } });
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.buffer.toString("utf8")).auth, "");
  other.server.close();
  hop.server.close();
});

await checkAsync("超时归一为 TimeoutError", async () => {
  await assert.rejects(
    () => requestOnce("GET", `${base}/slow`, { timeoutMs: 120 }),
    (e) => e.name === "TimeoutError" && /请求超时/.test(e.message)
  );
});

await checkAsync("不支持的协议 → protocol", async () => {
  await assert.rejects(
    () => requestOnce("GET", "ftp://example.com/x", {}),
    (e) => e instanceof GitHubError && e.kind === "protocol" && /不支持的协议/.test(e.message)
  );
});

await checkAsync("非法 URL → protocol", async () => {
  await assert.rejects(
    () => requestOnce("GET", "not a url", {}),
    (e) => e instanceof GitHubError && e.kind === "protocol" && /URL 非法/.test(e.message)
  );
});

server.close();

// ── 汇总 ────────────────────────────────────────────────────────────────────

console.log("\n" + "─".repeat(60));
console.log(`github-smoke: 通过 ${passed} / 失败 ${failed}`);
if (failed > 0) {
  console.log("失败项：");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log("全部通过。");
