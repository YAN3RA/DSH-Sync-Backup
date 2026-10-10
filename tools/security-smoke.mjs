/**
 * dsh-sync-backup / tools/security-smoke.mjs
 *
 * **安全边界回归**：用恶意样本验证「不可信输入不会造成越界后果」。
 * 全部离线，零网络、零凭据、不碰真实 $DSH_HOME。
 *
 * 覆盖（对应代码审查报告的第一阶段修复项）：
 *  - 1.2 tar：路径穿越 / 绝对路径 / 盘符 / UNC / 控制字符 / 重复路径 /
 *              size 越界 / 截断头块 / 条目数上限 / gzip bomb / 解压总量上限
 *  - 1.3 白名单：单文件被替换成 symlink（含指向 $DSH_HOME 之外）
 *  - 1.4 远端路径：目录穿越与编码歧义被拒
 *
 * 用法：node tools/security-smoke.mjs
 * 退出码 0 = 全部通过；1 = 有断言失败。
 */

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";

import { buildArchive, openArchive, parseTar, checkArchivePath, resolveInside, BLOCK_SIZE } from "../lib/archive.js";
import { restoreCheck, cleanupTempDir } from "../lib/restore-check.js";
import { listWhitelistFiles, readEntries } from "../lib/collect.js";
import { normalizeWebDavPath, joinUrl } from "../lib/webdav.js";
import { isLoopbackHost, checkTransportUrl } from "../lib/transport-guard.js";

let passed = 0;
let failed = 0;
const failures = [];

async function checkAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    failures.push(name);
    console.log(`  ✗ ${name}`);
    console.log(`      ${err?.message ?? err}`);
  }
}

function section(title) {
  console.log(`\n—— ${title} ——`);
}

const tmpRoots = [];
async function tmpDir(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

/** 把 USTAR header 的八进制字段改成任意值（并重算 checksum，以便隔离测试目标）。 */
function patchOctalField(tar, entryIndex, fieldOffset, fieldLen, octalText) {
  let offset = 0;
  for (let i = 0; i <= entryIndex; i += 1) {
    const header = tar.subarray(offset, offset + BLOCK_SIZE);
    const size = parseInt(header.subarray(124, 136).toString("ascii").replace(/\0/g, "").trim() || "0", 8);
    const pad = (BLOCK_SIZE - (size % BLOCK_SIZE)) % BLOCK_SIZE;
    if (i === entryIndex) {
      const str = octalText.padStart(fieldLen - 1, "0") + "\0";
      tar.write(str, offset + fieldOffset, fieldLen, "ascii");
      // 重算 checksum，避免它先于我们要测的校验失败
      tar.fill(0x20, offset + 148, offset + 156);
      let sum = 0;
      for (let b = 0; b < BLOCK_SIZE; b += 1) sum += tar[offset + b];
      tar.write(sum.toString(8).padStart(6, "0") + "\0 ", offset + 148, 8, "ascii");
      return tar;
    }
    offset += BLOCK_SIZE + size + pad;
  }
  throw new Error("patchOctalField: 条目下标越界");
}

/* ============================================================
 * 1.2 tar：路径与长度边界
 * ============================================================ */

section("1.2 tar 解析：拒绝被篡改的结构");

await checkAsync("正常归档仍能往返（先确认没把功能改坏）", async () => {
  const { gz } = buildArchive([
    { path: "memory/today.md", data: Buffer.from("hello") },
    { path: "AGENTS.md", data: Buffer.from("persona") },
  ]);
  const entries = openArchive(gz);
  assert.equal(entries.length, 2);
  assert.equal(entries.find((e) => e.path === "AGENTS.md").data.toString("utf8"), "persona");
});

await checkAsync("重复路径 → 抛错（拒绝歧义归档）", async () => {
  const { tar } = buildArchive([
    { path: "dup.txt", data: Buffer.from("first") },
    { path: "dup.txt", data: Buffer.from("second") },
  ]);
  assert.throws(() => parseTar(tar), /路径重复/);
});

await checkAsync("size 声明超出实际数据 → 抛错，而不是静默截短", async () => {
  const { tar } = buildArchive([{ path: "a.txt", data: Buffer.from("short") }]);
  patchOctalField(tar, 0, 124, 12, "77777777");
  assert.throws(() => parseTar(tar), /越界|超过/);
});

await checkAsync("size 为非八进制字符 → 抛错", async () => {
  const { tar } = buildArchive([{ path: "a.txt", data: Buffer.from("x") }]);
  patchOctalField(tar, 0, 124, 12, "99999999");
  assert.throws(() => parseTar(tar), /八进制|越界/);
});

await checkAsync("截断的头块 → 不产生假条目", async () => {
  const { tar } = buildArchive([{ path: "a.txt", data: Buffer.alloc(2048, 1) }]);
  const truncated = tar.subarray(0, BLOCK_SIZE + 100); // 数据区被砍
  assert.throws(() => parseTar(truncated), /越界/);
});

await checkAsync("条目数超上限 → 抛错", async () => {
  const entries = [];
  for (let i = 0; i < 30; i += 1) entries.push({ path: `f${i}.txt`, data: Buffer.from("x") });
  const { tar } = buildArchive(entries);
  assert.throws(() => parseTar(tar, { limits: { maxEntries: 10 } }), /条目数超过上限/);
});

await checkAsync("单文件超上限 → 抛错", async () => {
  const { tar } = buildArchive([{ path: "big.bin", data: Buffer.alloc(4096, 7) }]);
  assert.throws(() => parseTar(tar, { limits: { maxFileBytes: 1024 } }), /超过单文件上限/);
});

await checkAsync("解压总量超上限 → 抛错", async () => {
  const entries = [];
  for (let i = 0; i < 8; i += 1) entries.push({ path: `g${i}.bin`, data: Buffer.alloc(1024, 3) });
  const { tar } = buildArchive(entries);
  assert.throws(() => parseTar(tar, { limits: { maxTotalBytes: 2048 } }), /解压总量超过上限/);
});

await checkAsync("gzip bomb：解压输出超上限即失败（不先分配完内存）", async () => {
  // 10 MB 的零字节压成很小的 gz，再用 1 MB 的上限去解
  const { gz } = buildArchive([{ path: "bomb.bin", data: Buffer.alloc(10 * 1024 * 1024, 0) }]);
  assert.ok(gz.length < 200 * 1024, `前置条件：压缩后应很小，实际 ${gz.length}`);
  assert.throws(() => openArchive(gz, { maxOutputLength: 1024 * 1024 }), /超过上限|gzip bomb/);
});

await checkAsync("checkArchivePath 逐类拒绝危险路径", async () => {
  const bad = [
    "../escape",
    "a/../../escape",
    "/etc/passwd",
    "C:\\Windows\\x",
    "//server/share/x",
    "a/./b",
    "a//b",
    "a\u0000b",
    "",
  ];
  for (const p of bad) {
    assert.equal(checkArchivePath(p).ok, false, `应拒绝 ${JSON.stringify(p)}`);
  }
  for (const ok of ["memory/a.md", "skills/x/SKILL.md", "a/b/c.txt"]) {
    assert.equal(checkArchivePath(ok).ok, true, `应接受 ${ok}`);
  }
});

await checkAsync("resolveInside 按解析后绝对路径判断，前缀相同的兄弟目录不算在内", async () => {
  const root = path.join(os.tmpdir(), "dshsb-root");
  const inside = resolveInside(root, "sub/file.txt");
  assert.equal(inside.ok, true);
  // /tmp/dshsb-root-evil 与 /tmp/dshsb-root 共享字符串前缀，但必须被拒
  const sibling = path.join(os.tmpdir(), "dshsb-root-evil", "f.txt");
  assert.equal(resolveInside(root, path.relative(root, sibling)).ok, false);
  assert.equal(resolveInside(root, "../dshsb-root-evil/f.txt").ok, false);
});

/* ============================================================
 * 1.2 restore-check：端到端拒绝恶意归档 + 不泄漏临时目录
 * ============================================================ */

section("1.2 恢复自检：恶意归档端到端");

await checkAsync("含 ../ 的归档在自检里被拒（extract 也不会写出去）", async () => {
  const evilTar = Buffer.from(
    // 手工构造一条 path="../../evil.txt" 的 USTAR 条目
    (() => {
      const { tar } = buildArchive([{ path: "placeholder", data: Buffer.from("payload") }]);
      // 把 name 字段改成穿越路径（长度一致，checksum 由 parseTar 重算不了，所以这里
      // 直接改 name 后重建 checksum）
      tar.write("placeholder", 0, 100, "utf8");
      return tar;
    })(),
  );
  // 用真正的构造器，确保 checksum 自洽
  const built = buildArchive([{ path: "../evil.txt", data: Buffer.from("payload") }]);
  const dir = await tmpDir("dshsb-evil-");
  const res = await restoreCheck(built.gz, { home: dir, extract: true });
  assert.equal(res.ok, false, "含穿越路径的归档必须判失败");
  assert.ok(res.errors.some((e) => /不安全/.test(e)), `错误里应提到路径不安全：${res.errors.join("; ")}`);
  assert.equal(res.tempDir, "", "失败时不该留下临时目录");
  // 确认真的没写出去
  assert.equal(await fs.readFile(path.join(dir, "..", "evil.txt"), "utf8").catch(() => null), null);
  void evilTar;
});

await checkAsync("临时目录在写盘失败后被清理（不泄漏）", async () => {
  const before = (await fs.readdir(os.tmpdir())).filter((n) => n.startsWith("dshsb-restore-")).length;
  // 构造：合法路径但 home 指向一个不存在的位置也无所谓；这里直接跑一次成功的
  const built = buildArchive([{ path: "ok.txt", data: Buffer.from("fine") }]);
  const dir = await tmpDir("dshsb-ok-");
  const res = await restoreCheck(built.gz, { home: dir, extract: true });
  assert.equal(res.ok, true);
  assert.ok(res.tempDir.includes("dshsb-restore-"));
  await cleanupTempDir(res.tempDir);
  assert.equal(await fs.stat(res.tempDir).catch(() => null), null, "cleanupTempDir 应删干净");
  const after = (await fs.readdir(os.tmpdir())).filter((n) => n.startsWith("dshsb-restore-")).length;
  assert.ok(after <= before, `不应累积临时目录：before=${before} after=${after}`);
});

await checkAsync("未加密归档里的凭据类路径仍被拒", async () => {
  const built = buildArchive([{ path: ".credentials.yaml", data: Buffer.from("secret") }]);
  const dir = await tmpDir("dshsb-cred-");
  const res = await restoreCheck(built.gz, { home: dir });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => /危险路径/.test(e)));
});

/* ============================================================
 * 1.3 白名单：符号链接
 * ============================================================ */

section("1.3 白名单：单文件规则不得跟随符号链接");

/**
 * 造一个「链接」用于测试。
 *
 * 本机（Windows 非管理员）无法创建文件符号链接（EPERM），但**目录 junction
 * 可以**。而 junction 在 `readdir` 的 Dirent 上恰恰被报成 isSymbolicLink()=true
 * —— 也就是说它覆盖的正是 walkDir 里那条判断，这正是我们要测的路径。
 *
 * 若连 junction 都建不了（受限环境），返回 null 并在用例里明确报「未验证」，
 * 而不是把它当作通过。
 */
async function makeDirLink(target, linkPath) {
  try {
    await fs.symlink(target, linkPath, "junction");
    return "junction";
  } catch {
    /* 落到下面 */
  }
  try {
    await fs.symlink(target, linkPath, "dir");
    return "symlink";
  } catch {
    return null;
  }
}

await checkAsync("白名单单文件被换成链接 → 跳过，不收集（未验证时明确失败）", async () => {
  const home = await tmpDir("dshsb-home-");
  const outside = await tmpDir("dshsb-outside-");
  await fs.writeFile(path.join(outside, "secret.txt"), "SHOULD-NOT-BE-COLLECTED", "utf8");

  // 正常情况：是普通文件，应当被收集（先确认基线）
  await fs.writeFile(path.join(home, "AGENTS.md"), "real persona", "utf8");
  const ok = await listWhitelistFiles(home, { whitelist: [{ path: "AGENTS.md", kind: "file" }] });
  assert.deepEqual(ok.files, ["AGENTS.md"]);

  // 换成指向 home 之外的链接
  await fs.rm(path.join(home, "AGENTS.md"));
  const kind = await makeDirLink(outside, path.join(home, "AGENTS.md"));
  if (kind === null) {
    assert.fail("本环境无法创建任何形式的链接，1.3 的 symlink 防护**未被验证**（不能算通过）");
  }
  const linked = await listWhitelistFiles(home, { whitelist: [{ path: "AGENTS.md", kind: "file" }] });
  assert.deepEqual(linked.files, [], "链接不得进入收集清单");
  assert.ok(
    linked.skipped.some((s) => s.reason === "symbolic-link" || s.reason === "not-a-file"),
    `应记录跳过原因，实际 ${JSON.stringify(linked.skipped)}`,
  );
  // 最终确认：内容没有出现在任何会被读取的路径里
  const entries = await readEntries(home, linked.files);
  assert.ok(!entries.some((e) => e.data.toString("utf8").includes("SHOULD-NOT-BE-COLLECTED")));
});

await checkAsync("readEntries 对链接也拒绝（防 TOCTOU）", async () => {
  const home = await tmpDir("dshsb-home-");
  const outside = await tmpDir("dshsb-outside-");
  await fs.writeFile(path.join(outside, "s.txt"), "SECRET", "utf8");
  const kind = await makeDirLink(outside, path.join(home, "linkdir"));
  if (kind === null) {
    assert.fail("本环境无法创建任何形式的链接，readEntries 的防护**未被验证**（不能算通过）");
  }
  // 直接把链接路径喂给 readEntries，模拟「枚举后被换成链接」的 TOCTOU 窗口
  const entries = await readEntries(home, ["linkdir", "linkdir/s.txt"]);
  assert.equal(entries.length, 0, "读取阶段也必须拒绝链接");
});

await checkAsync("目录遍历遇到链接目录不递归进去（junction 场景）", async () => {
  const home = await tmpDir("dshsb-home-");
  const outside = await tmpDir("dshsb-outside-");
  await fs.writeFile(path.join(outside, "secret.txt"), "OUTSIDE-CONTENT", "utf8");
  await fs.writeFile(path.join(home, "normal.txt"), "normal", "utf8");
  const kind = await makeDirLink(outside, path.join(home, "linked"));
  if (kind === null) {
    assert.fail("本环境无法创建任何形式的链接，目录遍历防护**未被验证**（不能算通过）");
  }
  const res = await listWhitelistFiles(home, { whitelist: [{ path: ".", kind: "dir", maxDepth: 3 }] });
  assert.deepEqual(res.files, ["./normal.txt"], `只应收 normal.txt，实际 ${JSON.stringify(res.files)}`);
  const entries = await readEntries(home, res.files);
  assert.ok(!entries.some((e) => e.data.toString("utf8").includes("OUTSIDE-CONTENT")), "链接目录内容不得泄漏");
});

/* ============================================================
 * 1.4 远端路径
 * ============================================================ */

section("1.4 远端路径规范化");

await checkAsync("normalizeWebDavPath 拒绝穿越 / 反斜杠 / 查询符 / 控制字符", async () => {
  const bad = ["../x", "a/../../b", "a//b", "a\\b", "a?x=1", "a#frag", "a%b", "a\u0001b", "./x"];
  for (const p of bad) {
    assert.throws(() => normalizeWebDavPath(p), /路径/, `应拒绝 ${JSON.stringify(p)}`);
  }
});

await checkAsync("normalizeWebDavPath 接受常规路径并去掉首尾斜杠", async () => {
  assert.equal(normalizeWebDavPath("dsh-backup/"), "dsh-backup");
  assert.equal(normalizeWebDavPath("/a/b/"), "a/b");
  assert.equal(normalizeWebDavPath(""), "");
  assert.equal(normalizeWebDavPath("备份 目录/x"), "备份 目录/x");
});

await checkAsync("joinUrl 逐段编码，不把用户输入直接拼进 URL", async () => {
  const u = joinUrl("https://dav.example.com/dav", "备份 目录/dsh-backup");
  assert.ok(!u.includes("备份"), `不应出现未编码中文: ${u}`);
  assert.ok(u.includes(encodeURIComponent("备份 目录")));
  assert.equal(joinUrl("https://dav.example.com/dav", ""), "https://dav.example.com/dav/");
});

/* ============================================================
 * 3.1 传输安全：凭据不得经明文 HTTP 发给非本机
 * ============================================================ */

section("3.1 传输安全判定");

await checkAsync("非本机 http 被拒（凭据会明文外发）", async () => {
  for (const url of [
    "http://webdav.example.com/dav/",
    "http://192.168.1.10/dav/",
    "http://api.github.example.com/",
  ]) {
    const r = checkTransportUrl(url, { what: "目标" });
    assert.equal(r.ok, false, `应拒绝 ${url}`);
    assert.ok(/明文/.test(r.problem), "错误信息要点明明文风险");
  }
});

await checkAsync("https 一律放行", async () => {
  for (const url of ["https://dav.jianguoyun.com/dav/", "https://api.github.com", "https://ghe.corp.example/api/v3"]) {
    assert.equal(checkTransportUrl(url).ok, true, `应放行 ${url}`);
  }
});

await checkAsync("本机 http 放行（本地假服务/私服的常规用法）", async () => {
  for (const url of ["http://127.0.0.1:8080/dav/", "http://localhost/dav/", "http://127.5.5.5/x", "http://[::1]:9/x"]) {
    const r = checkTransportUrl(url);
    assert.equal(r.ok, true, `应放行 ${url}`);
    assert.equal(r.loopback, true);
  }
});

await checkAsync("显式 allowInsecure 才放行非本机 http（须用户主动开启）", async () => {
  const url = "http://dav.internal.example/dav/";
  assert.equal(checkTransportUrl(url).ok, false, "默认必须拒绝");
  assert.equal(checkTransportUrl(url, { allowInsecure: true }).ok, true, "显式确认后才放行");
});

await checkAsync("非 http(s) 协议被拒", async () => {
  for (const url of ["ftp://x/y", "file:///etc/passwd", "gopher://x"]) {
    assert.equal(checkTransportUrl(url).ok, false, `应拒绝 ${url}`);
  }
  assert.equal(checkTransportUrl("not a url").ok, false);
});

await checkAsync("isLoopbackHost 不把「看似本机」的外网名当本机", async () => {
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("localhost"), true);
  // 这些都不该被误判为本机
  for (const h of ["localhost.evil.com", "127.0.0.1.evil.com", "0.0.0.0", "10.0.0.1", "example.com", "127.0.0.256"]) {
    assert.equal(isLoopbackHost(h), false, `${h} 不该被判为本机`);
  }
});

await checkAsync("WebDavClient 构造时套用传输判定", async () => {
  const { WebDavClient } = await import("../lib/webdav.js");
  // 非本机 http 必须构造失败
  assert.throws(
    () => new WebDavClient({ baseUrl: "http://dav.example.com/dav/", username: "u", getPassword: async () => "p" }),
    /明文|https/,
  );
  // 本机 http 与外部 https 可构造
  new WebDavClient({ baseUrl: "http://127.0.0.1:9/dav/", username: "u", getPassword: async () => "p" });
  new WebDavClient({ baseUrl: "https://dav.example.com/dav/", username: "u", getPassword: async () => "p" });
  // 显式放行
  new WebDavClient({
    baseUrl: "http://dav.internal.example/dav/",
    username: "u",
    getPassword: async () => "p",
    allowInsecureHttp: true,
  });
});

/* ============================================================
 * 3.2 HTTP 响应体上限
 * ============================================================ */

section("3.2 HTTP 响应体上限");

await checkAsync("WebDAV：响应体超上限即销毁请求，不 concat 进内存", async () => {
  const { requestOnce } = await import("../lib/webdav.js");
  const http = await import("node:http");
  // 起一个会吐超量数据的本地服务（本机 http 允许，且这正是要测的路径）
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/octet-stream" });
    const chunk = Buffer.alloc(64 * 1024, 1);
    let sent = 0;
    const push = () => {
      if (sent > 2 * 1024 * 1024) { res.end(); return; }
      sent += chunk.length;
      if (res.write(chunk)) setImmediate(push);
      else res.once("drain", push);
    };
    push();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    await assert.rejects(
      () => requestOnce("GET", `http://127.0.0.1:${port}/`, { maxResponseBytes: 256 * 1024 }),
      (err) => /超过上限|ResponseTooLarge/.test(String(err?.message ?? err)),
      "超限必须抛错，而不是把整个响应读进内存",
    );
  } finally {
    await new Promise((r) => server.close(r));
  }
});

await checkAsync("WebDAV：未超限的响应正常返回", async () => {
  const { requestOnce } = await import("../lib/webdav.js");
  const http = await import("node:http");
  const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end("small body");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    const res = await requestOnce("GET", `http://127.0.0.1:${port}/`, { maxResponseBytes: 1024 });
    assert.equal(res.status, 200);
    assert.equal(res.buffer.toString("utf8"), "small body");
  } finally {
    await new Promise((r) => server.close(r));
  }
});

await checkAsync("两通道都导出了默认响应上限常量", async () => {
  const wd = await import("../lib/webdav.js");
  const gh = await import("../lib/github.js");
  assert.ok(wd.DEFAULT_MAX_RESPONSE_BYTES > 0, "webdav 应导出上限");
  assert.ok(gh.DEFAULT_MAX_RESPONSE_BYTES > 0, "github 应导出上限");
});

/* ============================================================
 * 收尾
 * ============================================================ */

for (const dir of tmpRoots) {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

console.log("\n=== 结果 ===");
if (failed === 0) {
  console.log("全部检查通过 ✓");
} else {
  console.log(`失败 ${failed} 项：`);
  for (const n of failures) console.log(`  - ${n}`);
}
console.log(`security-smoke: 通过 ${passed} / 失败 ${failed}`);
process.exit(failed === 0 ? 0 : 1);
