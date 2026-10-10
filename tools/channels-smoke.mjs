/**
 * dsh-sync-backup / tools/channels-smoke.mjs
 *
 * **双通道集成测试** —— 补的是前三套测试都覆盖不到的那一段：
 * `index.js` 里 `runOnce({ upload: true })` 的**编排逻辑本身**。
 *
 * 为什么需要它：
 *  - P2 的真实验收走的是独立脚本 `tools/upload-once.mjs`，从未执行插件自己的
 *    runOnce 上传分支；
 *  - `github-smoke.mjs` 测的是 `lib/github.js` 这个库，不是插件编排；
 *  - 于是「WebDAV 成功 + GitHub 失败 → partial」「零通道 → 报错」「凭据缺失 →
 *    整通道跳过且不计半失败」这些分支一直没被跑过。
 *
 * 做法：起两个本地 `node:http` 假服务（假 WebDAV 与假 GitHub contents API），
 * 用假 ctx + 临时 DSH_HOME 驱动真实 `plugin.apply()` 注册出的 `sync_backup_run`。
 * **零外网**（两个服务都监听 127.0.0.1；失败场景指向必然拒绝连接的端口 1）。
 *
 * 用法：node --import ./tools/_hooks-register.mjs tools/channels-smoke.mjs
 */

import path from "node:path";
import os from "node:os";
import http from "node:http";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";

import * as plugin from "../index.js";

let passed = 0;
let failed = 0;
const failures = [];

function check(ok, label, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    failures.push(label);
    console.log(`  ✗ ${label}${detail ? "  — " + detail : ""}`);
  }
}
function checkAsync(label, fn) {
  return fn()
    .then(() => {
      passed++;
      console.log(`  ✓ ${label}`);
    })
    .catch((e) => {
      failed++;
      failures.push(label);
      console.log(`  ✗ ${label}  — ${e.message}`);
    });
}
function section(t) {
  console.log(`\n${t}`);
}

const CRED = ["test", "cred", "0123456789"].join("-");
const UNREACHABLE_WEBDAV = "http://127.0.0.1:1/dav/";
const UNREACHABLE_API = "http://127.0.0.1:1";

/* ============================================================
 * 1–10：编排分支（假目标 / 假 API，零 socket 依赖成功路径）
 * ============================================================ */

section("[1] 归档 id 形状：两通道共用同一 id");
await checkAsync("id 一致且符合 YYYYMMDD-HHMMSS-8hex", async () => {
  const r = await runOnce({ webdav: "ok", github: "ok" });
  const w = r.channels?.webdav;
  const g = r.channels?.github;
  if (!w || !g) throw new Error(`通道结果缺失：${JSON.stringify(Object.keys(r.channels ?? {}))}`);
  if (w.id !== g.id) throw new Error(`两通道 id 不一致：${w.id} vs ${g.id}`);
  if (!/^\d{8}-\d{6}-[0-9a-f]{8}$/.test(w.id)) throw new Error(`id 形状不对：${w.id}`);
});

section("[2] WebDAV 成功 + GitHub 成功 → partial=false");
await checkAsync("全成功", async () => {
  const r = await runOnce({ webdav: "ok", github: "ok" });
  if (r.ok !== true) throw new Error(`整体应成功：${r.error}`);
  if (r.partial !== false) throw new Error("partial 应为 false");
  if (r.channels.webdav.ok !== true || r.channels.github.ok !== true) throw new Error("两通道都应 ok");
  if (r.remoteId !== r.channels.webdav.id) throw new Error("remoteId 应取 WebDAV 通道的 id");
  if (!r.remoteSha256) throw new Error("缺 remoteSha256");
  if (r.dryRun !== false) throw new Error("dryRun 应为 false");
});

section("[3] WebDAV 成功 + GitHub 失败 → partial=true（半失败不中止另一通道）");
await checkAsync("半失败", async () => {
  const r = await runOnce({ webdav: "ok", github: "fail" });
  if (r.ok !== true) throw new Error(`半失败时整体仍应 ok：${r.error}`);
  if (r.partial !== true) throw new Error("partial 应为 true");
  if (r.channels.webdav.ok !== true) throw new Error("WebDAV 应成功");
  if (r.channels.github.ok !== false) throw new Error("GitHub 应失败");
  if (!r.channels.github.error) throw new Error("失败通道应带 error");
  if (!/GitHub/.test(r.partialReason ?? "")) throw new Error(`partialReason 应含通道名：${r.partialReason}`);
});

section("[4] WebDAV 失败 + GitHub 成功 → partial=true（反向）");
await checkAsync("反向半失败", async () => {
  const r = await runOnce({ webdav: "fail", github: "ok" });
  if (r.ok !== true) throw new Error(`半失败时整体仍应 ok：${r.error}`);
  if (r.partial !== true) throw new Error("partial 应为 true");
  if (r.channels.github.ok !== true) throw new Error("GitHub 应成功");
  if (r.channels.webdav.ok !== false) throw new Error("WebDAV 应失败");
  // 工具返回值过 Host 两道门：① 不许有 undefined（lossless JSON）；
  // ② 声明了类型的键若存在就必须匹配（null 不是 object/string）。
  // 所以「无远端」必须表现为**键缺席**。
  if ("remoteId" in r) throw new Error(`WebDAV 失败时不应有 remoteId 键，实为 ${JSON.stringify(r.remoteId)}`);
});

section("[5] 两通道都失败 → 整体失败且不标 partial");
await checkAsync("全失败", async () => {
  const r = await runOnce({ webdav: "fail", github: "fail" });
  if (r.ok !== false) throw new Error("整体应失败");
  if (!/全部上传通道失败/.test(r.error ?? "")) throw new Error(`错误信息不对：${r.error}`);
  if (r.partial === true) throw new Error("全失败时不应标 partial");
});

section("[6] 没有任何可用通道 → 明确报错");
await checkAsync("零通道", async () => {
  const r = await runOnce({ webdav: "none", github: "none" });
  if (r.ok !== false) throw new Error("应失败");
  if (!/没有任何可用的上传通道/.test(r.error ?? "")) throw new Error(`错误信息不对：${r.error}`);
});

section("[7] GitHub 未配凭据 → 整通道跳过且不计入半失败");
await checkAsync("凭据缺失跳过", async () => {
  const r = await runOnce({ webdav: "ok", github: "nocred" });
  if (r.ok !== true) throw new Error(`应成功：${r.error}`);
  if (r.partial !== false) throw new Error("被跳过的通道不应计入半失败");
  if (r.channels.github?.skipped !== true) throw new Error("GitHub 应标 skipped");
  if (r.channels.webdav.ok !== true) throw new Error("WebDAV 应成功");
});

section("[8] WebDAV 停用 → 只剩 GitHub，不是半失败");
await checkAsync("webdavEnabled=false", async () => {
  const r = await runOnce({ webdav: "none", github: "ok" });
  if (r.ok !== true) throw new Error(`应成功：${r.error}`);
  if (r.partial !== false) throw new Error("未启用的通道不应算作半失败");
  if (r.channels.webdav !== undefined) throw new Error("WebDAV 通道不应出现在结果里");
});

section("[9] 回读 SHA256 不一致 → 该通道判失败");
await checkAsync("GitHub 回读被篡改", async () => {
  const gh = await startFakeGithub({ corruptTarGz: true });
  try {
    const r = await runOnce({ webdav: "none", github: "ok", githubApiBaseUrl: `http://127.0.0.1:${gh.port}` });
    if (r.channels.github.ok !== false) throw new Error("GitHub 应失败");
    if (!/回读校验失败/.test(r.channels.github.error ?? "")) throw new Error(`错误信息不对：${r.channels.github.error}`);
    if (r.ok !== false) throw new Error("唯一通道失败时整体应失败");
  } finally {
    await gh.close();
  }
});

section("[10] GitHub 通道 meta-last：索引必须是最后一次 PUT");
await checkAsync("索引最后写", async () => {
  const gh = await startFakeGithub();
  try {
    const r = await runOnce({ webdav: "none", github: "ok", githubApiBaseUrl: `http://127.0.0.1:${gh.port}` });
    if (r.ok !== true) throw new Error(`应成功：${r.error}`);
    const puts = gh.state.requests.filter((q) => q.method === "PUT");
    if (puts.length === 0) throw new Error("假 API 没收到任何 PUT");
    const last = puts[puts.length - 1];
    if (!/index\.json/.test(last.path)) throw new Error(`最后一次 PUT 不是索引：${last.path}`);
    const keys = [...gh.state.files.keys()].join(" ");
    if (!/\.tar\.gz/.test(keys)) throw new Error(`缺归档本体：${keys}`);
    if (!/manifest\.json/.test(keys)) throw new Error(`缺 manifest：${keys}`);
    if (!/latest\.tar\.gz/.test(keys)) throw new Error(`githubWriteLatest 为真却缺 latest：${keys}`);
  } finally {
    await gh.close();
  }
});

/* ============================================================
 * 11–12：状态落盘（半失败升级 / 归零）
 * ============================================================ */

section("[11] 半失败写入 state 并在达阈值时置 needsAttention");
await checkAsync("阈值 1 → 立即触发", async () => {
  const home = await mkTmpHome();
  try {
    await runOnce({ webdav: "ok", github: "fail", home, partialAlertAfter: 1 });
    const st = await readState(home);
    if (st.lastPartial !== true) throw new Error("lastPartial 应为 true");
    if (st.partialStreak !== 1) throw new Error(`partialStreak 应为 1：${st.partialStreak}`);
    if (st.needsAttention !== true) throw new Error("阈值 1 时 needsAttention 应为 true");
    if (!st.lastChannels) throw new Error("lastChannels 应落盘");
    if (!st.lastChannels.github?.error) throw new Error("lastChannels 应保留失败原因");
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

await checkAsync("连续两次半失败 → partialStreak=2，阈值 3 时未触发", async () => {
  const home = await mkTmpHome();
  try {
    await runOnce({ webdav: "ok", github: "fail", home, partialAlertAfter: 3 });
    await runOnce({ webdav: "ok", github: "fail", home, partialAlertAfter: 3 });
    const st = await readState(home);
    if (st.partialStreak !== 2) throw new Error(`partialStreak 应为 2：${st.partialStreak}`);
    if (st.needsAttention !== false) throw new Error("未达阈值不应触发");
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

await checkAsync("并发触发（3 个入口同时开跑）→ 只有一个真跑，其余 busy", async () => {
  const home = await mkTmpHome();
  try {
    const outs = await runOnce({ webdav: "ok", github: "fail", home, partialAlertAfter: 3, concurrent: true });
    const ran = outs.filter((o) => o.busy !== true && o.errorKind !== "busy");
    const busy = outs.filter((o) => o.busy === true || o.errorKind === "busy");
    if (outs.length !== 3) throw new Error(`应发起 3 次，实际 ${outs.length}`);
    if (ran.length !== 1) throw new Error(`只应有一次真正执行，实际 ${ran.length} 次`);
    if (busy.length !== 2) throw new Error(`另外两次应报 busy，实际 ${busy.length} 次`);
    // busy 的形状必须可判定：调用方据此重试而不是去查故障
    for (const b of busy) {
      if (typeof b.error !== "string" || b.error.length === 0) throw new Error("busy 必须带可读原因");
    }
    // 关键：state 只被那次真正执行写了一次，没有互相覆盖
    const st = await readState(home);
    if (st.runs !== 1) throw new Error(`state.runs 应为 1（无并发覆盖），实际 ${st.runs}`);
    if (st.partialStreak !== 1) throw new Error(`partialStreak 应为 1，实际 ${st.partialStreak}`);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

await checkAsync("半失败后一次全成功 → 计数归零、告警复位", async () => {
  const home = await mkTmpHome();
  try {
    await runOnce({ webdav: "ok", github: "fail", home, partialAlertAfter: 1 });
    await runOnce({ webdav: "ok", github: "ok", home, partialAlertAfter: 1 });
    const st = await readState(home);
    if (st.partialStreak !== 0) throw new Error(`成功后 partialStreak 应归零：${st.partialStreak}`);
    if (st.needsAttention !== false) throw new Error("needsAttention 应复位");
    if (st.lastPartial !== false) throw new Error("lastPartial 应为 false");
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

/* ============================================================
 * 13：真实本地 HTTP 端到端（仍零外网）
 * ============================================================ */

section("[13] 端到端：本地假 WebDAV + 本地假 GitHub API（真 socket）");
await checkAsync("两通道都收到文件，且远端字节与本地 SHA256 一致", async () => {
  const wd = await startFakeWebdav();
  const gh = await startFakeGithub({ requireAuth: true });
  const home = await mkTmpHome();
  try {
    const r = await runOnce({
      webdav: "local",
      github: "ok",
      home,
      webdavBaseUrl: `http://127.0.0.1:${wd.port}/dav/`,
      githubApiBaseUrl: `http://127.0.0.1:${gh.port}`,
    });
    if (r.ok !== true) throw new Error(`应成功：${r.error}`);
    if (r.partial !== false) throw new Error("partial 应为 false");
    if (wd.state.files.size === 0) throw new Error("假 WebDAV 未收到任何文件");
    if (gh.state.files.size === 0) throw new Error("假 GitHub 未收到任何文件");

    const wKeys = [...wd.state.files.keys()];
    if (!wKeys.some((k) => /\.tar\.gz$/.test(k))) throw new Error(`WebDAV 缺归档：${wKeys.join(" ")}`);
    if (!wKeys.some((k) => /index\.json$/.test(k))) throw new Error(`WebDAV 缺索引：${wKeys.join(" ")}`);
    const gKeys = [...gh.state.files.keys()];
    if (!gKeys.some((k) => /\.tar\.gz$/.test(k))) throw new Error(`GitHub 缺归档：${gKeys.join(" ")}`);
    if (!gKeys.some((k) => /index\.json$/.test(k))) throw new Error(`GitHub 缺索引：${gKeys.join(" ")}`);

    // 远端归档字节必须与本地载荷 SHA256 一致（回读校验就是这么做的）
    const localSha = r.channels.webdav.sha256;
    const remote = wd.state.files.get(wKeys.find((k) => /\.tar\.gz$/.test(k)));
    const remoteSha = createHash("sha256").update(remote).digest("hex");
    if (remoteSha !== localSha) throw new Error(`WebDAV 远端与本地不一致：${remoteSha} vs ${localSha}`);

    // GitHub 的归档字节也必须一致（base64 往返不能损坏）
    const gTar = gh.state.files.get(gKeys.find((k) => /\.tar\.gz$/.test(k)));
    const gSha = createHash("sha256").update(gTar.data).digest("hex");
    if (gSha !== localSha) throw new Error(`GitHub 远端与本地不一致：${gSha} vs ${localSha}`);

    // 索引内容可解析，且 entries 指向已存在的归档
    const idx = JSON.parse(wd.state.files.get(wKeys.find((k) => /index\.json$/.test(k))).toString("utf8"));
    if (!Array.isArray(idx.entries) || idx.entries.length !== 1) throw new Error(`索引条目数不对：${idx.entries?.length}`);
    if (idx.entries[0].archiveSha256 !== localSha) throw new Error("索引里的 archiveSha256 与本地不一致");
    if (idx.entries[0].id !== r.channels.webdav.id) throw new Error("索引 id 与结果不一致");
  } finally {
    await wd.close();
    await gh.close();
    await fs.rm(home, { recursive: true, force: true });
  }
});

await checkAsync("假 GitHub 会验令牌：无令牌请求被拒 → 通道失败", async () => {
  const gh = await startFakeGithub({ requireAuth: true, rejectAll: true });
  try {
    const r = await runOnce({ webdav: "none", github: "ok", githubApiBaseUrl: `http://127.0.0.1:${gh.port}` });
    if (r.ok !== false) throw new Error("401 时整体应失败");
    if (r.channels.github.ok !== false) throw new Error("GitHub 通道应失败");
  } finally {
    await gh.close();
  }
});

/* ============================================================
 * 14：保留策略在编排层生效
 * ============================================================ */

section("[14] keepLast 裁剪：超过保留份数的旧快照被 DELETE");
await checkAsync("keepLast=2 时第 3 次上传删掉最旧一份", async () => {
  const wd = await startFakeWebdav();
  const home = await mkTmpHome();
  try {
    const base = `http://127.0.0.1:${wd.port}/dav/`;
    for (let i = 0; i < 3; i++) {
      const r = await runOnce({ webdav: "local", github: "none", home, webdavBaseUrl: base, keepLast: 2 });
      if (r.ok !== true) throw new Error(`第 ${i + 1} 次应成功：${r.error}`);
    }
    const tars = [...wd.state.files.keys()].filter((k) => /\.tar\.gz$/.test(k));
    if (tars.length !== 2) throw new Error(`远端应只剩 2 份归档，实为 ${tars.length}：${tars.join(" ")}`);
    const idx = JSON.parse(
      wd.state.files.get([...wd.state.files.keys()].find((k) => /index\.json$/.test(k))).toString("utf8"),
    );
    if (idx.entries.length !== 2) throw new Error(`索引应只剩 2 条：${idx.entries.length}`);
    // 索引里每一条都必须能在远端找到对应文件
    for (const e of idx.entries) {
      const hit = [...wd.state.files.keys()].some((k) => k.endsWith(`${e.id}.tar.gz`));
      if (!hit) throw new Error(`索引条目 ${e.id} 指向不存在的归档`);
    }
    const pruned = wd.state.requests.filter((q) => q.method === "DELETE");
    if (pruned.length === 0) throw new Error("没有发生裁剪 DELETE");
  } finally {
    await wd.close();
    await fs.rm(home, { recursive: true, force: true });
  }
});

/* ============================================================
 * 脚手架
 * ============================================================ */

/**
 * 用假 ctx 驱动**真实** plugin.apply()，再调 sync_backup_run(upload=true)。
 *
 * opts:
 *   webdav: "ok" | "fail" | "none" | "local"    —— 通道开关 / 失败 / 本地假服务
 *   github: "ok" | "fail" | "none" | "nocred"   —— 同上；nocred = 有 repo 无令牌
 *   home, webdavBaseUrl, githubApiBaseUrl, partialAlertAfter, keepLast
 */
async function runOnce(opts = {}) {
  const home = opts.home ?? (await mkTmpHome());
  const autoClean = !opts.home;

  // WebDAV 目标：none → 通道停用；fail → 必然拒绝连接；ok/local → 可用的假地址
  const webdavEnabled = opts.webdav !== "none";
  const webdavBaseUrl =
    opts.webdavBaseUrl ?? (opts.webdav === "fail" ? UNREACHABLE_WEBDAV : UNREACHABLE_WEBDAV);
  // 注意：webdav="ok" 仍需一个**真实可达**的地址才会成功，故 "ok" 也指向本地假服务；
  // 为此 runOnce 内部会按需自动起一个假 WebDAV（见下）。
  let autoWebdav = null;
  let finalWebdavUrl = webdavBaseUrl;
  if (opts.webdav === "ok" || opts.webdav === "local") {
    if (opts.webdavBaseUrl) finalWebdavUrl = opts.webdavBaseUrl;
    else {
      autoWebdav = await startFakeWebdav();
      finalWebdavUrl = `http://127.0.0.1:${autoWebdav.port}/dav/`;
    }
  }

  // v2 起 WebDAV 目标改由**插件自己的 config** 提供（webdavUrl / webdavUsername）；
  // sync-config.json 仍写一份，用来覆盖「未显式配置时的迁移期兜底」这条分支。
  const syncDir = path.join(home, "dsh-config-manager", "sync");
  await fs.mkdir(syncDir, { recursive: true });
  await fs.writeFile(
    path.join(syncDir, "sync-config.json"),
    JSON.stringify({ webdav: { url: finalWebdavUrl, username: "u@example.com" } }),
    "utf8",
  );

  const refs = ["version: 1", "refs:", `  DSH_SYNC_BACKUP_WEBDAV_PASSWORD: pwd-test-value`];
  if (opts.github !== "nocred") refs.push(`  DSH_SYNC_BACKUP_GITHUB_TOKEN: ${CRED}`);
  await fs.writeFile(path.join(home, ".credentials.yaml"), refs.join("\n") + "\n", "utf8");

  // GitHub 目标：none → 不配仓库（跳过）；fail → 必然拒绝连接；ok → 本地假 API。
  // ⚠️ 绝不能留空 apiBaseUrl，否则会打真实的 api.github.com —— 测试必须零外网。
  // 	v3 起 GitHub 有自己的总开关 `githubEnabled`（默认 false）。这条 fixture 里
  // 	它必须跟着 opts.github 走，否则「填了 repo」也会被当成通道关闭 —— 那样测的
  // 	就是默认值，而不是被测用例想要的状态。
  let autoGithub = null;
  let githubApiBaseUrl = opts.githubApiBaseUrl ?? "";
  if (opts.github === "fail") {
    githubApiBaseUrl = UNREACHABLE_API;
  } else if ((opts.github === "ok" || opts.github === "local") && !githubApiBaseUrl) {
    autoGithub = await startFakeGithub({ requireAuth: true });
    githubApiBaseUrl = `http://127.0.0.1:${autoGithub.port}`;
  }
  const githubRepo = opts.github === "none" ? "" : "example-owner/example-repo";
  const githubEnabled = opts.github !== "none";

  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const registered = [];
  const systemPromptStub = { section: () => () => {} };
  // 假 ctx 必须覆盖 apply() 真实触及的每个服务入口（2026-10-09 补）：
  //   ctx.get  —— 可选服务口径（systemPrompt 缺席时不得阻塞 fiber）
  //   ctx.inject —— RPC 挂载点（connection + webServer）
  //   ctx.logger —— BackupScheduler 日志出口
  // 本文件不测 RPC，故 inject 只记录、不回调用例（保持纯 host 通道语义）。
  const ctx = {
    tools: { register: (d) => registered.push(d) },
    systemPrompt: systemPromptStub,
    get: (name) => (name === "systemPrompt" ? systemPromptStub : undefined),
    inject: () => () => {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    effect: (fn) => fn(),
  };
  plugin.apply(
    ctx,
    plugin.Config.resolve({
      dryRun: false,
      webdavEnabled,
      githubRepo,
      githubEnabled,
      githubApiBaseUrl,
      // 	v3：默认会在本地留下产物。这个 fixture 每个用例都用**独立的临时 home**
      // 并在结束时 rm -rf，留产物既没意义也会让清理变成 rmdir ENOTEMPTY。
      persistArchive: false,
      restoreCheck: false,
      partialAlertAfter: opts.partialAlertAfter ?? 3,
      keepLast: opts.keepLast ?? 7,
      // ⚠️ 必须关掉调度器与启动补跑。
      // 它们会在 apply() 时并发发起一次真实 runOnce；用例随后显式调工具时，
      // 编排层的单次运行锁会把那次显式调用判成 busy —— 于是本用例实际只跑了
      // 一次，累加断言失真。（这在加锁之前是「两次并发读写 state 互相覆盖」，
      // 竞态恰好凑出期望值，所以问题一直被掩盖着。）
      // 本文件测的是 runOnce 的编排与状态累加，不测调度器 —— 关掉才是干净的夹具。
      schedulerEnabled: false,
      startupRunOnBoot: false,
    }),
  );
  const runTool = registered.find((r) => r.name === "sync_backup_run");
  let out;
  try {
    if (opts.concurrent === true) {
      // 并发用例：对**同一个实例**同时发起多次运行。
      // 这正是审查报告 2.2 描述的场景（定时器刚触发 + 用户点立即备份 + agent 调工具），
      // 也是唯一能真正验证单次运行互斥的形状 —— 顺序调用每次都新建实例，锁无从体现。
      out = await Promise.all([
        runTool.execute({ upload: true }, {}),
        runTool.execute({ upload: true }, {}),
        runTool.execute({ upload: true }, {}),
      ]);
    } else {
      out = await runTool.execute({ upload: true }, {});
    }
  } finally {
    process.env.DSH_HOME = prevHome;
  }

  if (autoWebdav) await autoWebdav.close();
  if (autoGithub) await autoGithub.close();
  if (autoClean) await fs.rm(home, { recursive: true, force: true });
  if (opts.concurrent === true) {
    for (const o of out) assertLossless(o);
    return out;
  }
  assertLossless(out);
  return out;
}

/**
 * Host 用 snapshotJsonValue 校验工具返回值：任何层级的 `undefined` 都会让整个
 * 工具调用以 `value is not lossless JSON` 失败（源：dsh-tools lib/index.js:2577-2578）。
 * 每个用例都过一遍 —— 只测到个别字段会漏掉同类缺陷。
 */
function assertLossless(v, p = "") {
  if (v === undefined) throw new Error(`返回值含 undefined：${p || "(root)"}`);
  if (v === null || typeof v !== "object") return;
  if (Array.isArray(v)) { v.forEach((x, i) => assertLossless(x, `${p}[${i}]`)); return; }
  for (const k of Object.keys(v)) assertLossless(v[k], p ? `${p}.${k}` : k);
}

async function mkTmpHome() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "dsh-sync-backup-ch-"));
  await fs.writeFile(path.join(home, "AGENTS.md"), "# test agents\n", "utf8");
  await fs.writeFile(path.join(home, "dsh-auto-memory.json"), '{"a":1}\n', "utf8");
  await fs.mkdir(path.join(home, "memory"), { recursive: true });
  await fs.writeFile(path.join(home, "memory", "MEMORY.md"), "# memory\n", "utf8");
  return home;
}

async function readState(home) {
  const p = path.join(home, "dsh-sync-backup", "state.json");
  return JSON.parse(await fs.readFile(p, "utf8"));
}

/* ---------- 假 WebDAV ---------- */
async function startFakeWebdav() {
  const state = { files: new Map(), requests: [] };
  const server = http.createServer((req, r) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const key = decodeURIComponent(url.pathname);
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      state.requests.push({ method: req.method, path: key });
      if (req.method === "MKCOL") {
        r.writeHead(201);
        return r.end();
      }
      if (req.method === "PUT") {
        state.files.set(key, body);
        r.writeHead(201);
        return r.end();
      }
      if (req.method === "GET" || req.method === "HEAD") {
        const f = state.files.get(key);
        if (!f) {
          r.writeHead(404);
          return r.end();
        }
        r.writeHead(200, { "Content-Length": String(f.length) });
        return r.end(req.method === "HEAD" ? undefined : f);
      }
      if (req.method === "DELETE") {
        state.files.delete(key);
        r.writeHead(204);
        return r.end();
      }
      r.writeHead(405);
      r.end();
    });
  });
  await new Promise((res) => server.listen(0, "127.0.0.1", res));
  return {
    port: server.address().port,
    state,
    close: () => new Promise((res) => server.close(res)),
  };
}

/* ---------- 假 GitHub contents API ---------- */
async function startFakeGithub(opts = {}) {
  const state = { files: new Map(), requests: [] };
  const server = http.createServer((req, r) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      state.requests.push({ method: req.method, path: url.pathname, query: url.search });

      if (opts.rejectAll || (opts.requireAuth && !String(req.headers.authorization ?? "").startsWith("Bearer "))) {
        r.writeHead(401, { "Content-Type": "application/json" });
        return r.end(JSON.stringify({ message: "Bad credentials" }));
      }

      const m = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/contents\/(.*)$/);
      if (!m) {
        r.writeHead(404, { "Content-Type": "application/json" });
        return r.end(JSON.stringify({ message: "Not Found" }));
      }
      const rel = decodeURIComponent(m[3]).replace(/^\/+/, "");
      const existing = state.files.get(rel);

      if (req.method === "GET") {
        if (!existing) {
          r.writeHead(404, { "Content-Type": "application/json" });
          return r.end(JSON.stringify({ message: "Not Found" }));
        }
        r.writeHead(200, { "Content-Type": "application/json" });
        return r.end(
          JSON.stringify({
            name: rel.split("/").pop(),
            path: rel,
            type: "file",
            sha: existing.sha,
            size: existing.data.length,
            encoding: "base64",
            content: existing.data.toString("base64").replace(/(.{60})/g, "$1\n"),
          }),
        );
      }
      if (req.method === "PUT") {
        let payload;
        try {
          payload = JSON.parse(raw.toString("utf8"));
        } catch {
          r.writeHead(400, { "Content-Type": "application/json" });
          return r.end(JSON.stringify({ message: "bad json" }));
        }
        if (existing && payload.sha !== existing.sha) {
          r.writeHead(409, { "Content-Type": "application/json" });
          return r.end(JSON.stringify({ message: "sha mismatch" }));
        }
        if (payload.content === "" || payload.content === undefined) {
          r.writeHead(422, { "Content-Type": "application/json" });
          return r.end(JSON.stringify({ message: "content is required" }));
        }
        const data = Buffer.from(payload.content, "base64");
        const sha = createHash("sha1").update(data).digest("hex");
        // corruptTarGz：归档本体落盘时被篡改 1 字节，用于验证回读校验真的会拦下来
        const stored = opts.corruptTarGz && /\.tar\.gz$/.test(rel) ? Buffer.from(data) : data;
        if (opts.corruptTarGz && /\.tar\.gz$/.test(rel)) stored[0] = stored[0] ^ 0xff;
        state.files.set(rel, { data: stored, sha });
        r.writeHead(existing ? 200 : 201, { "Content-Type": "application/json" });
        return r.end(
          JSON.stringify({ content: { path: rel, sha }, commit: { sha: "commit-" + sha.slice(0, 8) } }),
        );
      }
      if (req.method === "DELETE") {
        if (!existing) {
          r.writeHead(422, { "Content-Type": "application/json" });
          return r.end(JSON.stringify({ message: "sha required" }));
        }
        state.files.delete(rel);
        r.writeHead(200, { "Content-Type": "application/json" });
        return r.end(JSON.stringify({ commit: { sha: "del" } }));
      }
      r.writeHead(405);
      r.end();
    });
  });
  await new Promise((res) => server.listen(0, "127.0.0.1", res));
  return {
    port: server.address().port,
    state,
    close: () => new Promise((res) => server.close(res)),
  };
}

console.log("\n=== 结果 ===");
if (failed === 0) {
  console.log(`channels-smoke: 通过 ${passed} / 失败 0\n全部通过。`);
} else {
  console.log(`channels-smoke: 通过 ${passed} / 失败 ${failed}`);
  for (const f of failures) console.log(`  ✗ ${f}`);
}
process.exit(failed === 0 ? 0 : 1);
