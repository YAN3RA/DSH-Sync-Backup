/**
 * dsh-sync-backup / tools/webdav-smoke.mjs
 *
 * lib/webdav.js 的**离线**单元测试：注入假 `request`，零网络、零凭据、零文件写入。
 *
 * 用法：node tools/webdav-smoke.mjs
 * 退出码 0 = 全部通过；1 = 有断言失败。
 *
 * 覆盖的关键语义（均来自 dsh-config-manager 的既有先例）：
 *  - MKCOL 幂等（405 = 已存在，算成功）
 *  - 302 跨源跳转剥离 Authorization；同源保留
 *  - 303 非 GET 降级为 GET 并丢弃请求体
 *  - 重定向上限 5 跳
 *  - readIndex 三态（404 missing / 200 合法 / 非法 JSON 抛错 / 缺 entries 抛错）
 *  - uploadSnapshot 的顺序契约（MKCOL → 归档 → manifest → 读索引 → 删最旧 → **最后写索引**）
 *  - keepLast 保留策略（只删最旧，保留最新 N 条）
 *  - 口令脱敏（原文与 URL 编码形态都不出现在错误消息里）
 */

import assert from "node:assert/strict";
import { WebDavClient, WebDavError, classifyStatus, joinUrl, REDACTED } from "../lib/webdav.js";

let passed = 0;
let failed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    failures.push({ name, err });
    console.log(`  ✗ ${name}\n      ${err?.message ?? err}`);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    failures.push({ name, err });
    console.log(`  ✗ ${name}\n      ${err?.message ?? err}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

/** 造一个假响应。 */
function res(status, body = "", headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), "utf8");
  const h = {};
  for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = v;
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: h,
    buffer: buf,
    text: async () => buf.toString("utf8"),
  };
}

/** 记录调用的假 request 工厂。 */
function recorder(handler) {
  const calls = [];
  const request = async (method, url, options = {}) => {
    const call = { method, url, options };
    calls.push(call);
    const out = await handler(method, url, options, calls.length);
    if (out === undefined) throw new Error(`假 request 未处理: ${method} ${url}`);
    return out;
  };
  request.calls = calls;
  return request;
}

const BASE = "https://dav.example.com/dav/";
const USER = "u@example.com";
const PASSWORD = "s3cr3t-p@ss";

function makeClient(request) {
  return new WebDavClient({
    baseUrl: BASE,
    username: USER,
    getPassword: async () => PASSWORD,
    timeoutMs: 1000,
    request,
  });
}

// ─────────────────────────────────────────────────────────────────────────────

section("1. 纯函数：classifyStatus / joinUrl");

check("classifyStatus 408/429 可重试", () => {
  assert.deepEqual(classifyStatus(408), { kind: "transient", retryable: true });
  assert.deepEqual(classifyStatus(429), { kind: "transient", retryable: true });
});
check("classifyStatus 5xx 可重试、4xx 不可重试", () => {
  assert.equal(classifyStatus(503).retryable, true);
  assert.equal(classifyStatus(401).retryable, false);
  assert.equal(classifyStatus(403).kind, "auth");
  assert.equal(classifyStatus(404).kind, "notfound");
  assert.equal(classifyStatus(400).kind, "client");
});
check("joinUrl 归一斜杠", () => {
  assert.equal(joinUrl("https://h/dav/", "dsh-backup"), "https://h/dav/dsh-backup");
  assert.equal(joinUrl("https://h/dav", "/dsh-backup/"), "https://h/dav/dsh-backup");
  assert.equal(joinUrl("https://h/dav/", ""), "https://h/dav/");
});

// ─────────────────────────────────────────────────────────────────────────────

section("2. 构造校验");

check("baseUrl 含 userinfo 被拒", () => {
  assert.throws(
    () =>
      new WebDavClient({
        baseUrl: "https://user:pw@dav.example.com/dav/",
        username: USER,
        getPassword: async () => "x",
      }),
    (e) => e instanceof WebDavError && /userinfo/.test(e.message),
  );
});
check("username 空被拒", () => {
  assert.throws(
    () => new WebDavClient({ baseUrl: BASE, username: "", getPassword: async () => "x" }),
    (e) => e instanceof WebDavError,
  );
});
check("getPassword 非函数被拒", () => {
  assert.throws(
    () => new WebDavClient({ baseUrl: BASE, username: USER, getPassword: "x" }),
    (e) => e instanceof WebDavError,
  );
});
check("非 http(s) 协议被拒", () => {
  assert.throws(
    () => new WebDavClient({ baseUrl: "ftp://h/dav/", username: USER, getPassword: async () => "x" }),
    (e) => e instanceof WebDavError,
  );
});

// ─────────────────────────────────────────────────────────────────────────────

section("3. 认证头与脱敏");

await checkAsync("send 注入 Basic 认证头", async () => {
  const request = recorder(() => res(200));
  const c = makeClient(request);
  await c.send("PROPFIND", "https://dav.example.com/dav/", { pwd: PASSWORD });
  const auth = request.calls[0].options.headers.Authorization;
  assert.equal(auth, "Basic " + Buffer.from(`${USER}:${PASSWORD}`, "utf8").toString("base64"));
});

await checkAsync("send 不把口令放进 URL", async () => {
  const request = recorder(() => res(200));
  const c = makeClient(request);
  await c.send("GET", "https://dav.example.com/dav/x", { pwd: PASSWORD });
  assert.ok(!request.calls[0].url.includes(PASSWORD));
  assert.ok(!request.calls[0].url.includes(encodeURIComponent(PASSWORD)));
});

check("mask 同时替换原文与 URL 编码形态", () => {
  const c = makeClient(recorder(() => res(200)));
  const enc = encodeURIComponent(PASSWORD);
  const masked = c.mask(`a ${PASSWORD} b ${enc} c`, PASSWORD);
  assert.ok(!masked.includes(PASSWORD));
  assert.ok(!masked.includes(enc));
  assert.ok(masked.includes(REDACTED));
});

await checkAsync("失败消息里的口令被脱敏", async () => {
  const request = recorder(() => res(401, `denied for ${PASSWORD}`));
  const c = makeClient(request);
  let msg = "";
  try {
    await c.get("https://dav.example.com/dav/x", PASSWORD);
  } catch (e) {
    msg = e.message;
  }
  assert.ok(msg.includes("401"));
  assert.ok(!msg.includes(PASSWORD), "错误消息泄露了口令");
  assert.ok(msg.includes(REDACTED));
});

// ─────────────────────────────────────────────────────────────────────────────

section("4. MKCOL 幂等");

for (const status of [200, 201, 204, 301, 302, 303, 405]) {
  await checkAsync(`MKCOL ${status} 视为成功`, async () => {
    const request = recorder(() => res(status));
    const c = makeClient(request);
    const r = await c.ensureCollection("https://dav.example.com/dav/dsh-backup/", PASSWORD);
    assert.equal(r.ok, true);
  });
}

await checkAsync("MKCOL 403 抛出（kind=auth，不可重试）", async () => {
  const request = recorder(() => res(403, "forbidden"));
  const c = makeClient(request);
  await assert.rejects(
    () => c.ensureCollection("https://dav.example.com/dav/dsh-backup/", PASSWORD),
    (e) => e instanceof WebDavError && e.kind === "auth" && e.retryable === false,
  );
});

// ─────────────────────────────────────────────────────────────────────────────

section("5. readIndex 三态");

await checkAsync("404 → { index: null, missing: true }", async () => {
  const request = recorder(() => res(404));
  const c = makeClient(request);
  const r = await c.readIndex("https://dav.example.com/dav/i.json", PASSWORD);
  assert.equal(r.missing, true);
  assert.equal(r.index, null);
});

await checkAsync("200 合法 → 解析出 entries", async () => {
  const body = JSON.stringify({ schemaVersion: 1, entries: [{ id: "a" }] });
  const request = recorder(() => res(200, body));
  const c = makeClient(request);
  const r = await c.readIndex("https://dav.example.com/dav/i.json", PASSWORD);
  assert.equal(r.missing, false);
  assert.equal(r.index.entries.length, 1);
});

await checkAsync("非法 JSON → 抛错（绝不回落成空）", async () => {
  const request = recorder(() => res(200, "{not json"));
  const c = makeClient(request);
  await assert.rejects(
    () => c.readIndex("https://dav.example.com/dav/i.json", PASSWORD),
    (e) => e instanceof WebDavError && /不是合法 JSON/.test(e.message),
  );
});

await checkAsync("缺 entries → 抛错", async () => {
  const request = recorder(() => res(200, JSON.stringify({ schemaVersion: 1 })));
  const c = makeClient(request);
  await assert.rejects(
    () => c.readIndex("https://dav.example.com/dav/i.json", PASSWORD),
    (e) => e instanceof WebDavError && /entries/.test(e.message),
  );
});

await checkAsync("顶层是数组 → 抛错", async () => {
  const request = recorder(() => res(200, "[]"));
  const c = makeClient(request);
  await assert.rejects(() => c.readIndex("https://dav.example.com/dav/i.json", PASSWORD), WebDavError);
});

await checkAsync("500 → 抛错（不回落成空）", async () => {
  const request = recorder(() => res(500, "boom"));
  const c = makeClient(request);
  await assert.rejects(
    () => c.readIndex("https://dav.example.com/dav/i.json", PASSWORD),
    (e) => e instanceof WebDavError && e.kind === "server" && e.retryable === true,
  );
});

// ─────────────────────────────────────────────────────────────────────────────

section("6. get / put / delete");

await checkAsync("get 404 → missing，不抛错", async () => {
  const request = recorder(() => res(404));
  const c = makeClient(request);
  const r = await c.get("https://dav.example.com/dav/x", PASSWORD);
  assert.equal(r.missing, true);
  assert.equal(r.buffer.length, 0);
});

await checkAsync("put 失败抛错，成功返回状态", async () => {
  const request = recorder(() => res(201));
  const c = makeClient(request);
  const r = await c.put("https://dav.example.com/dav/x", Buffer.from("hi"), { pwd: PASSWORD });
  assert.equal(r.status, 201);
});

await checkAsync("delete 404 视为成功（幂等）", async () => {
  const request = recorder(() => res(404));
  const c = makeClient(request);
  const r = await c.delete("https://dav.example.com/dav/x", PASSWORD);
  assert.equal(r.status, 404);
});

// ─────────────────────────────────────────────────────────────────────────────

section("7. uploadSnapshot 顺序契约（meta-last）");

await checkAsync("调用顺序 = MKCOL → PUT归档 → PUT manifest → GET索引 → PUT索引", async () => {
  const request = recorder((method, url) => {
    if (method === "MKCOL") return res(405);
    if (method === "PUT") return res(201);
    if (method === "GET") return res(404);
    return undefined;
  });
  const c = makeClient(request);
  await c.uploadSnapshot({
    dir: "dsh-backup/",
    id: "snap-1",
    archive: Buffer.from("ARCHIVE"),
    manifest: { fileCount: 1, totalBytes: 10, archiveSha256: "deadbeef" },
    keepLast: 7,
  });
  // 取最后一段路径（集合 URL 以 / 结尾时保留该斜杠，因为 MKCOL 的目标就是集合本身）
  const tail = (u) => {
    const p = u.split("/");
    return u.endsWith("/") ? `${p[p.length - 2]}/` : p[p.length - 1];
  };
  const seq = request.calls.map((x) => `${x.method} ${tail(x.url)}`);
  assert.deepEqual(seq, [
    "MKCOL dsh-backup/",
    "PUT snap-1.tar.gz",
    "PUT snap-1.manifest.json",
    "GET dsh-backup-index.json",
    "PUT dsh-backup-index.json",
  ]);
});

await checkAsync("索引在归档全部写完后才写（meta-last）", async () => {
  const request = recorder((method, url) => {
    if (method === "MKCOL") return res(405);
    if (method === "PUT") return res(201);
    if (method === "GET") return res(404);
    return undefined;
  });
  const c = makeClient(request);
  await c.uploadSnapshot({
    dir: "dsh-backup/",
    id: "snap-1",
    archive: Buffer.alloc(0),
    manifest: {},
  });
  const idx = request.calls.findIndex((x) => x.url.endsWith("dsh-backup-index.json") && x.method === "PUT");
  const archivePut = request.calls.findIndex((x) => x.url.endsWith(".tar.gz") && x.method === "PUT");
  assert.ok(idx > archivePut, "索引必须先于归档？不，索引必须晚于归档");
});

await checkAsync("Content-Type 正确", async () => {
  const request = recorder((method) => {
    if (method === "MKCOL") return res(405);
    if (method === "PUT") return res(201);
    if (method === "GET") return res(404);
    return undefined;
  });
  const c = makeClient(request);
  await c.uploadSnapshot({ dir: "dsh-backup/", id: "s", archive: Buffer.alloc(0), manifest: {} });
  const gz = request.calls.find((x) => x.method === "PUT" && x.url.endsWith(".tar.gz"));
  const mf = request.calls.find((x) => x.method === "PUT" && x.url.endsWith(".manifest.json"));
  assert.equal(gz.options.headers["Content-Type"], "application/gzip");
  assert.equal(mf.options.headers["Content-Type"], "application/json");
});

// ─────────────────────────────────────────────────────────────────────────────

section("8. keepLast 保留策略");

await checkAsync("超出 keepLast 时删除最旧，且 DELETE 早于最终 PUT 索引", async () => {
  const old = [];
  for (let i = 1; i <= 3; i += 1) {
    old.push({
      id: `old-${i}`,
      createdAt: `2026-10-0${i}T00:00:00.000Z`,
      archive: `old-${i}.tar.gz`,
      manifestFile: `old-${i}.manifest.json`,
    });
  }
  const existing = JSON.stringify({ schemaVersion: 1, entries: old });

  const request = recorder((method, url) => {
    if (method === "MKCOL") return res(405);
    if (method === "PUT") return res(201);
    if (method === "GET") return res(200, existing);
    if (method === "DELETE") return res(204);
    return undefined;
  });
  const c = makeClient(request);
  const out = await c.uploadSnapshot({
    dir: "dsh-backup/",
    id: "new",
    archive: Buffer.alloc(0),
    manifest: {},
    keepLast: 3,
  });

  // 3 旧 + 1 新 = 4，keepLast=3 → 裁掉 1 条最旧
  assert.equal(out.index.entries.length, 3);
  assert.ok(!out.index.entries.some((e) => e.id === "old-1"), "最旧的 old-1 应被裁掉");
  assert.ok(out.index.entries.some((e) => e.id === "new"));

  const dels = request.calls.filter((x) => x.method === "DELETE").map((x) => x.url.split("/").pop());
  assert.deepEqual(dels.sort(), ["old-1.manifest.json", "old-1.tar.gz"]);

  const lastPut = [...request.calls].reverse().find((x) => x.method === "PUT");
  assert.ok(lastPut.url.endsWith("dsh-backup-index.json"), "最后一次 PUT 必须是索引");
  const firstDelete = request.calls.findIndex((x) => x.method === "DELETE");
  const lastPutIdx = request.calls.length - 1 - [...request.calls].reverse().findIndex((x) => x.method === "PUT");
  assert.ok(firstDelete < lastPutIdx, "删除必须早于最后写索引");
});

await checkAsync("未超限时不删除任何东西", async () => {
  const request = recorder((method) => {
    if (method === "MKCOL") return res(405);
    if (method === "PUT") return res(201);
    if (method === "GET") return res(404);
    return undefined;
  });
  const c = makeClient(request);
  const out = await c.uploadSnapshot({ dir: "dsh-backup/", id: "only", archive: Buffer.alloc(0), manifest: {}, keepLast: 7 });
  assert.equal(out.pruned.length, 0);
  assert.equal(request.calls.filter((x) => x.method === "DELETE").length, 0);
});

await checkAsync("同 id 覆盖而非追加", async () => {
  const existing = JSON.stringify({
    schemaVersion: 1,
    entries: [{ id: "dup", createdAt: "2026-01-01T00:00:00.000Z", archive: "dup.tar.gz", manifestFile: "dup.manifest.json" }],
  });
  const request = recorder((method) => {
    if (method === "MKCOL") return res(405);
    if (method === "PUT") return res(201);
    if (method === "GET") return res(200, existing);
    if (method === "DELETE") return res(204);
    return undefined;
  });
  const c = makeClient(request);
  const out = await c.uploadSnapshot({ dir: "dsh-backup/", id: "dup", archive: Buffer.alloc(0), manifest: {} });
  assert.equal(out.index.entries.filter((e) => e.id === "dup").length, 1);
});

await checkAsync("删除失败不中断上传（记入 pruned）", async () => {
  const old = Array.from({ length: 2 }, (_, i) => ({
    id: `o${i}`,
    createdAt: `2026-10-0${i + 1}T00:00:00.000Z`,
    archive: `o${i}.tar.gz`,
    manifestFile: `o${i}.manifest.json`,
  }));
  const request = recorder((method) => {
    if (method === "MKCOL") return res(405);
    if (method === "PUT") return res(201);
    if (method === "GET") return res(200, JSON.stringify({ schemaVersion: 1, entries: old }));
    if (method === "DELETE") return res(500, "nope");
    return undefined;
  });
  const c = makeClient(request);
  const out = await c.uploadSnapshot({ dir: "dsh-backup/", id: "new", archive: Buffer.alloc(0), manifest: {}, keepLast: 1 });
  assert.equal(out.index.entries.length, 1);
  assert.equal(out.index.entries[0].id, "new");
  assert.ok(out.pruned.some((x) => x.includes("失败")), "删除失败应记入 pruned");
});

// ─────────────────────────────────────────────────────────────────────────────

section("9. 重定向语义（defaultRequest）");

// defaultRequest 用真实 node:http，这里用一个本地 http server 做端到端
const http = await import("node:http");
const { defaultRequest } = await import("../lib/webdav.js");

let port = 0;
let port2 = 0;

const server = http.createServer((req, res2) => {
  res2.setHeader("Connection", "close");
  if (req.url === "/same-origin-hop") {
    res2.statusCode = 302;
    res2.setHeader("Location", "/dest");
    return res2.end();
  }
  if (req.url === "/cross-origin-hop") {
    res2.statusCode = 302;
    res2.setHeader("Location", `http://127.0.0.1:${port + 1}/dest`);
    return res2.end();
  }
  if (req.url === "/see-other") {
    res2.statusCode = 303;
    res2.setHeader("Location", "/dest");
    return res2.end();
  }
  if (req.url === "/loop") {
    res2.statusCode = 302;
    res2.setHeader("Location", "/loop");
    return res2.end();
  }
  if (req.url === "/no-location") {
    res2.statusCode = 302;
    return res2.end();
  }
  if (req.url === "/dest") {
    res2.statusCode = 200;
    const auth = req.headers.authorization ?? "";
    const method = req.method;
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res2.setHeader("Content-Type", "application/json");
      res2.end(JSON.stringify({ method, auth, location: req.headers.location ?? null }));
    });
    return;
  }
  res2.statusCode = 404;
  res2.end("nf");
});

const server2 = http.createServer((req, res2) => {
  res2.setHeader("Connection", "close");
  if (req.url === "/dest") {
    res2.statusCode = 200;
    res2.end(JSON.stringify({ auth: req.headers.authorization ?? null, method: req.method }));
    return;
  }
  res2.statusCode = 404;
  res2.end("nf");
});

await new Promise((r) => server.listen(0, "127.0.0.1", () => {
  port = server.address().port;
  r();
}));
await new Promise((r) => server2.listen(0, "127.0.0.1", () => {
  port2 = server2.address().port;
  r();
}));

await checkAsync("同源 302 跟随并保留 Authorization", async () => {
  const r = await defaultRequest("PROPFIND", `http://127.0.0.1:${port}/same-origin-hop`, {
    headers: { Authorization: "Basic AAA" },
  });
  assert.equal(r.status, 200);
  const j = JSON.parse(r.buffer.toString("utf8"));
  assert.equal(j.auth, "Basic AAA", "同源跳转不应剥离 Authorization");
});

await checkAsync("跨源 302 跟随但剥离 Authorization", async () => {
  const r = await defaultRequest("PROPFIND", `http://127.0.0.1:${port}/cross-origin-hop`, {
    headers: { Authorization: "Basic AAA" },
  });
  assert.equal(r.status, 200);
  const j = JSON.parse(r.buffer.toString("utf8"));
  assert.equal(j.auth, null, "跨源跳转必须剥离 Authorization");
  assert.equal(j.method, "PROPFIND");
});

await checkAsync("303 非 GET 降级为 GET", async () => {
  const r = await defaultRequest("PUT", `http://127.0.0.1:${port}/see-other`, {
    headers: { Authorization: "Basic AAA" },
    body: Buffer.from("hello"),
  });
  assert.equal(r.status, 200);
  const j = JSON.parse(r.buffer.toString("utf8"));
  assert.equal(j.method, "GET");
});

await checkAsync("重定向循环超 5 跳 → 抛错", async () => {
  await assert.rejects(
    () => defaultRequest("GET", `http://127.0.0.1:${port}/loop`, {}),
    (e) => e instanceof WebDavError && /重定向次数超过上限/.test(e.message),
  );
});

await checkAsync("3xx 无 Location → 作为最终响应返回", async () => {
  const r = await defaultRequest("GET", `http://127.0.0.1:${port}/no-location`, {});
  assert.equal(r.status, 302);
});

await checkAsync("超时 → TimeoutError 归一为 WebDavError(kind=timeout)", async () => {
  const slow = http.createServer((req, r2) => {
    /* 故意不响应 */
  });
  const p3 = await new Promise((r) => slow.listen(0, "127.0.0.1", () => r(slow.address().port)));
  try {
    const c = new WebDavClient({
      baseUrl: `http://127.0.0.1:${p3}/dav/`,
      username: USER,
      getPassword: async () => PASSWORD,
      timeoutMs: 300,
    });
    await assert.rejects(
      () => c.get(`http://127.0.0.1:${p3}/x`, PASSWORD),
      (e) => e instanceof WebDavError && e.kind === "timeout" && e.retryable === true,
    );
  } finally {
    slow.close();
  }
});

server.close();
server2.close();

// ─────────────────────────────────────────────────────────────────────────────

console.log("");
console.log("─".repeat(72));
console.log(`webdav-smoke: 通过 ${passed} / 失败 ${failed}`);
if (failed > 0) {
  console.log("");
  for (const f of failures) console.log(`FAIL: ${f.name}\n  ${f.err?.stack ?? f.err}`);
  process.exit(1);
}
console.log("全部通过。");
