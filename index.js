/**
 * dsh-sync-backup — Host 半（Cordis 插件）。
 *
 * 职责：把 config-manager 覆盖不到的记忆层（`memory/`、`handoff/`、`skills/`、
 * `storages/`、`sessions/`、`AGENTS.md`、`dsh-auto-memory.json`）按**白名单**
 * 收集、打成 tar.gz，并上传到 WebDAV（任意服务商）+ GitHub 私有仓库。
 *
 * 设计要点：
 *  - **不安装任何 npm 依赖**：只 import Node 内置模块 + `@deepseek-ai/schemastery`
 *    + `@deepseek-ai/dsh-tools`，后两者由 harness 提供。
 *    ⚠️ 这两个包必须在 package.json 的 `peerDependencies` 里显式声明 —— 对 `link:`
 *    安装，Node 经符号链接 realpath 后从插件真实路径解析裸包名，那里没有 harness 包；
 *    app-boot 只拦截「插件自己声明了该 peer」的裸包（readPeerNames）。漏声明 →
 *    `ERR_MODULE_NOT_FOUND` 且 Desktop 下**静默不加载**（stderr 只进 64 KB 内存缓冲）。
 *    声明不会真装包：profile 设了 `autoInstallPeers=false`，由 harness 供给。
 *  - 白名单而非黑名单：白名单外的路径在结构上不可能进入归档。
 *  - 定时器回调内任何异常只写状态文件，绝不向 Host 冒泡。
 *
 * @module dsh-sync-backup
 */

import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";

import path from "node:path";
import os from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";

import { collect, isForbidden, resolveWhitelist, CATALOG } from "./lib/collect.js";
import { buildArchive, openArchive } from "./lib/archive.js";
import { restoreCheck, cleanupTempDir } from "./lib/restore-check.js";
import { persist, prune, usage as artifactUsage, listArtifacts, artifactDir } from "./lib/artifacts.js";
import { loadOrCreateKey } from "./lib/keyring.js";
import { encryptBytes, maskRecoveryCode } from "./lib/crypto.js";
import { loadState, saveState, redact } from "./lib/state.js";
import { loadUserConfig, saveUserConfig, mergeConfig, pickEditable, sanitizeEditable } from "./lib/user-config.js";
import { WebDavClient, WebDavError } from "./lib/webdav.js";
import { GitHubClient, GitHubError } from "./lib/github.js";
import { resolveCredential, resolveWebdavTarget } from "./lib/creds.js";
import { BackupScheduler } from "./lib/scheduler.js";

/** Cordis 插件名；必须与 cordis.patch.yml 的 `- id:` 逐字一致。 */
const name = "sync-backup";

/** 需要解析的服务（Host 面）。只需要工具注册，故仅 tools。 */
const inject = ["tools"];

/**
 * 本插件自己的 WebDAV 口令槽位。
 * **不使用** config-manager 的槽位（DSH_CONFIG_MANAGER_SYNC_WEBDAV_PASSWORD）——
 * 借别人的专用密码会让本插件的可用性绑在另一个插件的配置上，失败时也难以归因。
 */
const WEBDAV_REF = "DSH_SYNC_BACKUP_WEBDAV_PASSWORD";

/** GitHub PAT 槽位（P3 新槽位；无历史槽位可回退，缺失即跳过该通道）。 */
const GITHUB_REF = "DSH_SYNC_BACKUP_GITHUB_TOKEN";

/**
 * 当前 dsh 运行时版本。用于归档的「版本 compatible」标记与恢复自检比对。
 * 读不到时用一个稳定占位值 —— 版本标记只做提示，不参与任何安全判断。
 *
 * 只读宿主注入的 `DSH_VERSION` 这一项，且刻意不去碰任何 npm 注入的环境变量：
 * 这类名字里带 vendor 前缀的变量常被静态扫描当成「疑似凭据读取」，
 * 为一个只用来显示的标记去招惹一次误报不值得。
 */
const RUNTIME_VERSION = process.env.DSH_VERSION ?? "unknown";

/** 组合行配置。 */
const Config = z.object({
  /** 总开关。关掉后不注册任何工具、不排期。 */
  enabled: z.boolean().default(true),
  /** 周期（小时）。12h 与 config-manager 重叠，可选 11/13 错开。 */
  intervalHours: z.number().default(12),
  /** 启动时距上次成功运行超过该时长则立即跑一次。 */
  startupMinIntervalMs: z.number().default(3600000),
  /** 连续失败退避倍数上限（小时）。 */
  maxBackoffHours: z.number().default(24),
  /** 保留最近 N 份（官方缺省 keepLast 为 10）。 */
  keepLast: z.number().default(7),
  /** 连续 N 轮「半失败」后把 state.needsAttention 置真，提示人工介入。 */
  partialAlertAfter: z.number().default(3),
  /** 是否包含 `sessions/`（约 12.26 MB，是载荷主要来源）。 */
  includeSessions: z.boolean().default(true),
  /** 是否包含 `memory/semantic/`（派生索引，约 345,925 B）。 */
  includeSemantic: z.boolean().default(true),
  /** P1 阶段默认只做本地打包，不出网。 */
  dryRun: z.boolean().default(true),
  /**
   * 远端同步周期（小时），与本地打包周期分离。
   * 0 = 每次本地打包后立刻同步；>0 时不得小于 `intervalHours`（在 apply 里校验降为等价值）。
   */
  remoteIntervalHours: z.number().default(0),
  /**
   * 是否在本地留下加密归档产物。
   *
   * **v3 起默认 true**：本插件的存在意义就是让用户手上真的有一份东西，
   * 「默认什么都不留」等于默认不出活。风险由加密兜底 —— 只要落盘就一定加密，
   * 明文从不写进磁盘。
   */
  persistArchive: z.boolean().default(true),
  /** 本地产物保留天数（0 = 只按 keepLast 管远端、不管本地）。 */
  localKeepDays: z.number().default(7),
  /**
   * 勾选的备份条目 id（见 lib/collect.js 的 CATALOG）。
   * 空数组 = 用默认集合（除 profiles 外全选）。
   */
  selectedPaths: z.array(z.string()).default([]),
  /**
   * 是否在每次打包后跑恢复前自检。
   * 自检把归档解到**临时目录**做校验，绝不覆盖 $DSH_HOME 里任何现有文件。
   */
  restoreCheck: z.boolean().default(false),
  /** WebDAV 根 URL。**不使用** config-manager 的配置，避免两个插件互相漂移。 */
  webdavUrl: z.string().default(""),
  /** WebDAV 用户名。**不使用** config-manager 的配置。 */
  webdavUsername: z.string().default(""),
  /** WebDAV 目标目录（相对 DAV 根）。 */
  webdavPath: z.string().default("dsh-backup/"),
  /**
   * 是否启用 WebDAV 通道。
   * **v3 起默认 false** —— 装上就用、默认零外传；用户明确要去「通道配置」页
   * 打开开关并填目标，才第一次连外网。
   */
  webdavEnabled: z.boolean().default(false),
  /** WebDAV 口令的凭据引用名（缺省回退到 config-manager 的槽位）。 */
  webdavCredentialRef: z.string().default(""),
  /** 单次 HTTP 请求超时（毫秒）。13 MB 载荷 + 网盘 302 跳转需要留足余量。 */
  webdavTimeoutMs: z.number().default(300000),
  /** GitHub 仓库（owner/repo），留空则跳过该通道。 */
  githubRepo: z.string().default(""),
  /**
   * GitHub 通道总开关。
   * **v3 起默认 false** —— 与 webdavEnabled 同一口径：装上就用、默认零外传。
   * 以前只看 `githubRepo` 是否为空，于是「填了仓库」和「要连外网」是同一件事；
   * 现在两件事分开，用户可以填好仓库地址但先不打通。
   */
  githubEnabled: z.boolean().default(false),
  /** GitHub API 基址；留空用 https://api.github.com（改此值可接 GitHub Enterprise）。 */
  githubApiBaseUrl: z.string().default(""),
  /** GitHub 仓库内的目录（相对仓库根）。 */
  githubPath: z.string().default("dsh-backup/"),
  /** GitHub PAT 的凭据引用名（缺省即本插件槽位；无回退槽位）。 */
  githubCredentialRef: z.string().default(""),
  /** GitHub 通道是否写 `latest.tar.gz` 稳定副本（便于脚本一键拉取）。 */
  githubWriteLatest: z.boolean().default(true),
  /** GitHub 分支；留空用仓库默认分支。 */
  githubBranch: z.string().default(""),
  /** GitHub 单次 HTTP 请求超时（毫秒）。15 MB 载荷 base64 后约 21 MB 上行。 */
  githubTimeoutMs: z.number().default(300000),
  /** 状态文件与本地暂存目录（相对 $DSH_HOME）。 */
  dataDir: z.string().default("dsh-sync-backup"),
  /** 注册提示词小节（说明本插件能力与边界）。 */
  promptSection: z.boolean().default(true),
  /** 提示词小节排序（persona 为 0）。 */
  sectionOrder: z.number().default(30),
  /** P4：是否启用自排期定时器。关掉后只剩手动 `sync_backup_run`。 */
  schedulerEnabled: z.boolean().default(true),
  /** P4：定时跑是否**自动上传**。缺省 false —— 定时只做本地打包，零网络。 */
  uploadOnSchedule: z.boolean().default(false),
  /** P4：启动时是否允许立即补跑一次（仍受 intervalHours/startupMinIntervalMs 约束）。 */
  startupRunOnBoot: z.boolean().default(true),
});

/** 提示词小节正文：让 agent 知道存在哪些工具、边界在哪。 */
const SECTION_TEXT = [
  "## 定时备份（dsh-sync-backup）",
  "",
  "- `sync_backup_run`：立即执行一次备份。默认 dry-run（只打包、核对清单与体积，零网络）；`upload: true` 会把**同一份载荷**真实上传到已配置的通道（WebDAV / GitHub 私有仓库），每个通道都回读校验 SHA256（`config.dryRun` 为 true 时拒绝）。单通道失败不会中止另一通道，结果里 `partial: true` 表示半失败。",
  "- `sync_backup_status`：查看上次运行结果、各通道上次上传的 id/SHA256/保留份数、载荷体积、下次计划运行时刻与保留设置，以及半失败累计是否已触发 `needsAttention`。",
  "",
  "白名单口径：`AGENTS.md`、`dsh-auto-memory.json`、`memory/`、`skills/`、`storages/`、`task-board/`、`sessions/`、`dsh-config-manager/sync/` 顶层 `*.json`。",
  "**`.credentials.yaml` 永不进入归档**；收集阶段用白名单，白名单外路径不会被打包。",
  "两个通道的上传顺序都是「先写归档与 manifest → 再写稳定副本 → 最后写索引」，索引永远指向已存在的对象；超出 keepLast 的最旧快照会被删除。",
  "GitHub 通道使用 contents API 写**私有仓库**：归档本体 + manifest + `latest.tar.gz` + `index.json` 共 4 个文件/次；`config.githubRepo` 留空即跳过该通道。",
].join("\n");

/** 推导 $DSH_HOME。 */
function resolveHome(config) {
  const env = process.env.DSH_HOME;
  if (env && env.trim()) return path.resolve(env);
  return path.join(os.homedir(), ".dsh");
}

/** 人类可读体积。 */
function mb(n) {
  return (n / 1024 / 1024).toFixed(2) + " MB";
}

/**
 * 把双通道结果渲染成行（供工具 render 复用）。
 * 每通道一行：成功显示 id / SHA256 前 16 位 / 保留份数，失败显示原因。
 */
function channelLines(channels) {
  if (!channels || typeof channels !== "object") return [];
  const lines = [];
  const WEBDAV_LABEL = "WebDAV";
  const GITHUB_LABEL = "GitHub";
  for (const [key, c] of Object.entries(channels)) {
    if (!c) continue;
    const label = key === "webdav" ? WEBDAV_LABEL : key === "github" ? GITHUB_LABEL : key;
    if (c.skipped === true) {
      lines.push(`${label}: 已跳过（${c.error ?? "未配置"}）`);
    } else if (c.ok) {
      const where = c.archiveUrl ?? c.archivePath ?? "";
      lines.push(`${label}: ✓ ${c.id}，SHA256 ${String(c.sha256).slice(0, 16)}…（回读一致），保留 ${c.kept} 份`);
      if (where) lines.push(`  ${where}`);
    } else {
      lines.push(`${label}: ✗ ${c.error ?? "未知错误"}`);
    }
  }
  return lines;
}

/**
 * 把双通道结果转成**结构化**通道状态，供设置页渲染状态条。
 * 与 channelLines 同源同口径，只是给 GUI 用（不解析文本）。
 * state：ok（成功）| fail（失败）| skipped（未配置跳过）| idle（本轮未涉及）
 */
function channelView(channels) {
  if (!channels || typeof channels !== "object") return [];
  const out = [];
  for (const [key, c] of Object.entries(channels)) {
    if (!c) continue;
    out.push({
      key,
      state: c.skipped === true ? "skipped" : c.ok ? "ok" : "fail",
      id: c.id ?? null,
      sha256: c.sha256 ? String(c.sha256).slice(0, 16) : null,
      kept: c.kept ?? null,
      bytes: c.bytes ?? null,
      url: c.archiveUrl ?? c.archivePath ?? null,
      error: c.error ?? null,
      skipped: c.skipped === true,
    });
  }
  return out;
}

function apply(ctx, config) {
  const home = resolveHome(config);
  const dataDir = path.join(home, config.dataDir);

  // ---- v3：用户配置（$DSH_HOME/<dataDir>/config.json）优先于 patch ----
  //
  // patch 里的值是**出厂默认**，用户在设置页点出来的值写进自己的 config.json。
  // 这样「不会用 YAML 的人」永远不用碰 bundle 清单，而老手仍能用 patch 定基线；
  // 出问题时删掉 config.json 即回到默认，不需要重装插件。
  //
  // 实现细节：直接把合并结果 assign 回同一个 `config` 对象，而不是引入第二个
  // 变量。下面几十处读的都是 `config.xxx`，若改成另一个名字就得全改一遍 ——
  // 那样的重构只会带来打错名字的机会，不带任何收益。
  const BASELINE = { ...config };
  async function reloadEffective() {
    try {
      Object.assign(config, mergeConfig(BASELINE, await loadUserConfig(dataDir)));
    } catch {
      /* 配置读失败就用 patch 的默认值：不该让一个 1KB 文件拖垮整个插件 */
    }
    return config;
  }
  // 立即触发一次（不等到 runOnce）：apply 里注册的定时器初次启动就该用用户值。
  // 这是个 floating promise —— 失败已在 reloadEffective 里吞掉，不会 unhandled。
  void reloadEffective();

  /**
   * 解析 WebDAV 口令 —— **只读本插件自己的槽位**（需求③）。
   *
   * 这里刻意**不再回退** config-manager 的 `DSH_CONFIG_MANAGER_SYNC_WEBDAV_PASSWORD`：
   * 那个槽位是另一个插件录入的专用密码，借用它意味着本插件的存在依赖于别人的配置，
   * 一旦对方改了密码或卸载，本插件会以一种很难归因的方式失败。
   * 代价是用户要在本插件里录一次专用密码（见 `tools/set-webdav-password.mjs`）。
   *
   * 返回值只用于构造认证头，**永不记录、永不下发给 GUI**。
   */
  async function webdavPassword() {
    const refs = [];
    if (config.webdavCredentialRef) refs.push(config.webdavCredentialRef);
    refs.push(WEBDAV_REF);
    for (const ref of refs) {
      const got = await resolveCredential(ctx, home, ref);
      if (got) return { value: got.value, ref, source: got.source };
    }
    return undefined;
  }

  /**
   * 上传一份归档（**索引最后写**，见 lib/webdav.js 的顺序契约）。
   * 归档 id 形如 `20261008-201530-ab12cd34`（本地时间 + 随机后缀，天然按时间排序）。
   */
  async function uploadArchive({ gz, manifest, id }) {
    const pwdInfo = await webdavPassword();
    if (!pwdInfo) {
      throw new Error(
        `未找到 WebDAV 口令：凭据引用 ${config.webdavCredentialRef || WEBDAV_REF} 未配置。` +
          "（本插件不复用 config-manager 的槽位，需用 tools/set-webdav-password.mjs 录一次专用密码）",
      );
    }
    const target = await resolveWebdavTarget(home, {
      url: config.webdavUrl,
      username: config.webdavUsername,
    });
    if (!target) {
      throw new Error(
        "未找到 WebDAV 目标：请在插件配置里填 webdavUrl 与 webdavUsername（推荐），" +
          "或确保 $DSH_HOME/dsh-config-manager/sync/sync-config.json 里有 webdav.url / webdav.username。",
      );
    }

    const client = new WebDavClient({
      baseUrl: target.url,
      username: target.username,
      getPassword: async () => pwdInfo.value,
      timeoutMs: config.webdavTimeoutMs,
    });

    const now = new Date();
    const archiveSha256 = createHash("sha256").update(gz).digest("hex");
    const out = await client.uploadSnapshot({
      dir: config.webdavPath,
      id,
      archive: gz,
      manifest: {
        schemaVersion: 1,
        plugin: "dsh-sync-backup",
        id,
        createdAt: now.toISOString(),
        fileCount: manifest.fileCount,
        totalBytes: manifest.totalBytes ?? null,
        archiveBytes: gz.length,
        archiveSha256,
      },
      keepLast: config.keepLast,
    });

    return {
      id,
      sha256: archiveSha256,
      ...out,
      client,
      credentialRef: pwdInfo.ref,
      credentialSource: pwdInfo.source,
    };
  }

  /**
   * 回读校验：GET 刚上传的归档，比对字节长度与 SHA256。
   * 只有这一步过了才算「上传成功」——PUT 返回 2xx 不等于落盘正确。
   */
  async function verifyRemote({ client, archiveUrl, expected }) {
    const got = await client.get(archiveUrl);
    if (got.missing) throw new Error("回读失败：远端对象不存在（404）");
    const bytes = got.buffer;
    const sha = createHash("sha256").update(bytes).digest("hex");
    return {
      bytes: bytes.length,
      sha256: sha,
      lengthOk: bytes.length === expected.length,
      shaOk: sha === expected.sha256,
    };
  }

  /* ---------------- GitHub 通道 ---------------- */

  /** 解析 GitHub PAT（本插件槽位优先；无回退槽位）。 */
  async function githubToken() {
    const refs = [];
    if (config.githubCredentialRef) refs.push(config.githubCredentialRef);
    refs.push(GITHUB_REF);
    for (const ref of refs) {
      const got = await resolveCredential(ctx, home, ref);
      if (got) return { value: got.value, ref, source: got.source };
    }
    return undefined;
  }

  /** 归档 id：本地时间 `YYYYMMDD-HHMMSS` + 8 位随机 hex（天然按时间排序）。 */
  function archiveId(now) {
    const pad = (n) => String(n).padStart(2, "0");
    const stamp =
      `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
      `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    return `${stamp}-${randomBytes(4).toString("hex")}`;
  }

  /**
   * 上传一份归档到 GitHub 私有仓库（contents API，**索引最后写**）。
   * 与 WebDAV 通道使用**同一份载荷**，故 id 由调用方传入以保持两通道一致。
   */
  async function uploadGitHubArchive({ gz, manifest, id, tokenInfo }) {
    const client = new GitHubClient({
      repo: config.githubRepo,
      branch: config.githubBranch || undefined,
      apiBaseUrl: config.githubApiBaseUrl || undefined,
      getToken: async () => tokenInfo.value,
      timeoutMs: config.githubTimeoutMs,
    });

    const archiveSha256 = createHash("sha256").update(gz).digest("hex");
    const out = await client.uploadSnapshot({
      dir: config.githubPath,
      id,
      archive: gz,
      manifest: {
        schemaVersion: 1,
        plugin: "dsh-sync-backup",
        id,
        createdAt: new Date().toISOString(),
        fileCount: manifest.fileCount,
        totalBytes: manifest.totalBytes ?? null,
        archiveBytes: gz.length,
        archiveSha256,
      },
      keepLast: config.keepLast,
      writeLatest: config.githubWriteLatest,
    });

    return { id, sha256: archiveSha256, ...out, client, credentialRef: tokenInfo.ref, credentialSource: tokenInfo.source };
  }

  /** 回读校验 GitHub 通道：GET 刚上传的归档，比对字节长度与 SHA256。 */
  async function verifyGithubRemote({ client, archivePath, expected }) {
    const got = await client.readFile(archivePath);
    if (got.missing) throw new Error("回读失败：远端对象不存在（404）");
    const bytes = got.buffer;
    const sha = createHash("sha256").update(bytes).digest("hex");
    return {
      bytes: bytes.length,
      sha256: sha,
      lengthOk: bytes.length === expected.length,
      shaOk: sha === expected.sha256,
    };
  }

  /* ---------------- 单次运行互斥（single-flight） ---------------- */

  // 为什么要有一把**贯穿所有入口**的锁：
  // scheduler 自己有 `running`，GUI 的 sync-backup.run 也会查它，但 agent 工具
  // `sync_backup_run` 是直接进 runOnce 的，而 runOnce 本身不做互斥。于是「定时器
  // 刚触发 + 用户点立即备份 + agent 调工具」可以同时跑起来，后果是：同时打包占多份
  // 内存、两次上传同时读改写远端索引（后者覆盖前者的条目）、两次 state 读改写互相
  // 覆盖 runs/failures、清理产物与自检同时跑导致文件被删着读。
  //
  // 锁放在**编排层**（这里）而不是 scheduler.js：runOnce 在 scheduler 里是注入依赖，
  // 锁加在注入点才能覆盖 agent 工具 / GUI / 维护 RPC / 定时器全部调用口。
  let runLock = null;

  /**
   * 拿锁执行。已有人持锁时不排队、立刻返回 `{ok:false, busy:true}` ——
   * 备份是幂等的重活，让后来者明确失败比默默排队更好诊断。
   */
  async function withRunLock(reason, fn) {
    if (runLock !== null) {
      return {
        at: new Date().toISOString(),
        reason,
        ok: false,
        busy: true,
        error: `已有一次备份在进行中（${runLock.reason}，开始于 ${runLock.startedAt}）`,
        errorKind: "busy",
      };
    }
    const token = { reason, startedAt: new Date().toISOString() };
    runLock = token;
    try {
      return await fn();
    } finally {
      // 只释放自己持有的那把：万一被更外层逻辑替换过，不要误清掉别人的。
      if (runLock === token) runLock = null;
    }
  }

  /** 当前是否已有一次备份在跑（维护类操作据此拒绝并发）。 */
  function runBusy() {
    return runLock !== null;
  }

  /**
   * 执行一次备份。
   *
   * `upload: false`（默认）= 只收集 / 打包 / 回验，**零网络**。
   * `upload: true` = 额外真实上传到 WebDAV，并回读比对 SHA256；`dryRun` 为真时仍拒绝出网。
   *
   * 注意：**不要直接调这个函数** —— 外部入口一律走 `runExclusive()`，
   * 否则会绕过单次运行互斥。
   */
  async function runOnce({ upload = false, reason = "manual" } = {}) {
    const startedAt = Date.now();
    const result = { at: new Date().toISOString(), reason, ok: false, upload: false };

    try {
      if (upload && config.dryRun) {
        throw new Error("dryRun 为 true，拒绝上传。请先在 cordis.patch.yml 里把 dryRun 设为 false。");
      }

      // 1) 收集（白名单 —— 按 GUI 勾选的条目裁剪）
      const { entries, manifest, skipped } = await collect(home, {
        whitelist: resolveWhitelist(config.selectedPaths),
      });

      // 2) 可选裁剪（sessions / semantic）
      let picked = entries;
      if (!config.includeSessions) picked = picked.filter((e) => !e.path.startsWith("sessions/"));
      if (!config.includeSemantic) picked = picked.filter((e) => !e.path.startsWith("memory/semantic/"));

      // ⚠️ manifest 必须在**裁剪之后**重新生成。
      // collect() 产出的 manifest.files 是裁剪前的全量清单；若拿它去比对归档，
      // 用户关掉 sessions 时自检会把「本来就没打算打包的条目」判成丢失 —— 一个
      // 完全正常的配置会稳定地报错。这里按最终 picked 重建，保证 hash 与条目数一致。
      const finalManifest = {
        ...manifest,
        fileCount: picked.length,
        totalBytes: picked.reduce((n, e) => n + e.size, 0),
        files: picked.map((e) => ({
          path: e.path,
          size: e.size,
          sha256: e.sha256,
          mtimeMs: e.mtimeMs,
        })),
        filters: {
          includeSessions: config.includeSessions,
          includeSemantic: config.includeSemantic,
        },
      };

      // 3) 结构性自检：危险路径一律中止
      const hits = picked.filter((e) => isForbidden(e.path));
      if (hits.length > 0) {
        throw new Error(`归档命中危险路径，已中止：${hits.map((e) => e.path).join(", ")}`);
      }

      // 4a) 加密。只要这份载荷会离开内存（落盘或上传），它就必须先变成密文。
      //     没有开关 —— 明文写进磁盘的备份不如不备份。
      const { gz: plainGz, gzBytes, rawBytes } = buildArchive(
        picked.map((e) => ({ path: e.path, data: e.data, mode: e.mode, mtimeMs: e.mtimeMs })),
      );
      // 解包回验在**加密之前**做：这一步要能定位是打包出的问题，
      // 而不是等到解密失败才发现，那时已经分不清是 tar 坏了还是密钥错了。
      const restored = openArchive(plainGz);
      const restoredSet = new Set(restored.map((r) => r.path));
      const missing = picked.filter((e) => !restoredSet.has(e.path)).map((e) => e.path);
      if (missing.length > 0) {
        throw new Error(`解包回验缺失 ${missing.length} 个条目：${missing.slice(0, 3).join(", ")}`);
      }

      const { key, created: keyCreated } = await loadOrCreateKey(dataDir);
      const gz = encryptBytes(key, plainGz);

      result.ok = true;
      result.payload = {
        fileCount: picked.length,
        rawBytes,
        gzBytes,
        ratio: rawBytes > 0 ? Number((gzBytes / rawBytes).toFixed(4)) : 0,
        sourceBytes: picked.reduce((n, e) => n + e.size, 0),
        manifestFileCount: finalManifest.fileCount,
      };
      result.encrypted = true;
      if (keyCreated) result.keyCreated = true;
      result.skipped = skipped;

      // 4b) 本地产物（可选）+ 过期清理（需求⑤）
      if (config.persistArchive) {
        const id = archiveId(new Date());
        const saved = await persist(dataDir, id, gz);
        result.artifact = { id, file: saved.file, bytes: saved.bytes };
        const cleaned = await prune(dataDir, {
          keepDays: config.localKeepDays,
          keepLast: config.keepLast,
          now: new Date(),
        });
        result.pruned = { removed: cleaned.removed.length, bytesFreed: cleaned.bytesFreed };
      }

      // 4c) 恢复前自检（需求⑥）—— 绝不写 $DSH_HOME
      //
      // 术语澄清：这里做的是**内存解包校验**（extract:false）——证明这份归档能被
      // 解出来且逐条 sha256 对得上，而不是「解到临时目录的可恢复性检查」。
      // 后者的入口在维护页（extract:true），两件事不要混为一谈。
      if (config.restoreCheck) {
        let check;
        try {
          check = await restoreCheck(gz, {
            home,
            manifest: finalManifest.files,
            archiveVersion: RUNTIME_VERSION,
            runtimeVersion: RUNTIME_VERSION,
            extract: false,
            key,
          });
          result.restoreCheck = {
            ok: check.ok,
            errors: check.errors,
            warnings: check.warnings,
            stats: check.stats,
          };
          // 自检失败**不能**让整次备份还显示为完全成功 —— 用户开了自检就是把
          // 「能恢复」当作这次的验收条件。这里显式置一个独立健康位，状态页与
          // 概览据此显示告警，而不是把失败埋在详情里。
          if (!check.ok) {
            result.restoreCheckFailed = true;
            result.ok = false;
            result.error = `恢复自检未通过：${check.errors.join("；")}`;
            result.errorKind = "restore-check";
          }
        } finally {
          if (check) await cleanupTempDir(check.tempDir);
        }
      }

      result.durationMs = Date.now() - startedAt;

      // 5) 上传通道（可选，显式请求才走）。两通道共用同一份载荷与同一个 id。
      if (upload) {
        const id = archiveId(new Date());
        const channels = {};

        // ---- WebDAV ----
        if (config.webdavEnabled) {
          try {
            const up = await uploadArchive({ gz, manifest: finalManifest, id });
            const verify = await verifyRemote({
              client: up.client,
              archiveUrl: up.archiveUrl,
              expected: { length: gz.length, sha256: up.sha256 },
            });
            if (!verify.shaOk) {
              throw new WebDavError(
                `回读校验失败：远端 SHA256 ${verify.sha256.slice(0, 16)}… ≠ 本地 ${up.sha256.slice(0, 16)}…（长度 ${verify.bytes} vs ${gz.length}）`,
                { kind: "protocol" },
              );
            }
            channels.webdav = {
              ok: true,
              id,
              archiveUrl: up.archiveUrl,
              indexUrl: up.indexUrl,
              sha256: verify.sha256,
              remoteBytes: verify.bytes,
              pruned: up.pruned,
              credentialRef: up.credentialRef,
              credentialSource: up.credentialSource,
              kept: up.index.entries.length,
            };
          } catch (err) {
            // 「键缺席」而非 undefined：channels 会原样回传工具返回值，
            // 而 dsh-tools 的两道门只接受 JSON 可无损表达的值（见 tools/host-gates.mjs）。
            channels.webdav = {
              ok: false,
              error: redact(err && err.message ? err.message : String(err)),
              ...(err instanceof WebDavError ? { errorKind: err.kind, retryable: err.retryable === true } : {}),
            };
          }
        }

        // ---- GitHub（关闭开关 / 未配置仓库 → 跳过，不算失败）----
        if (!config.githubEnabled || !config.githubRepo) {
          channels.github = {
            ok: false,
            skipped: true,
            error: !config.githubEnabled ? "GitHub 通道已关闭（githubEnabled=false）" : "未配置 githubRepo",
          };
        } else {
          const tokenInfo = await githubToken();
          if (!tokenInfo) {
            channels.github = {
              ok: false,
              skipped: true,
              error: `未找到 GitHub 凭据：槽位 ${config.githubCredentialRef || GITHUB_REF} 未配置`,
            };
          } else {
            try {
              const up = await uploadGitHubArchive({ gz, manifest: finalManifest, id, tokenInfo });
              const verify = await verifyGithubRemote({
                client: up.client,
                archivePath: up.archivePath,
                expected: { length: gz.length, sha256: up.sha256 },
              });
              if (!verify.shaOk) {
                throw new GitHubError(
                  `回读校验失败：远端 SHA256 ${verify.sha256.slice(0, 16)}… ≠ 本地 ${up.sha256.slice(0, 16)}…（长度 ${verify.bytes} vs ${gz.length}）`,
                  { kind: "protocol" },
                );
              }
              channels.github = {
                ok: true,
                id,
                repo: up.repo,
                branch: up.branch,
                archivePath: up.archivePath,
                indexPath: up.indexPath,
                latestPath: up.latestPath,
                archiveUrl: up.archiveUrl,
                sha256: verify.sha256,
                remoteBytes: verify.bytes,
                pruned: up.pruned,
                credentialRef: up.credentialRef,
                credentialSource: up.credentialSource,
                kept: up.index.entries.length,
              };
            } catch (err) {
              channels.github = {
                ok: false,
                error: redact(err && err.message ? err.message : String(err)),
                ...(err instanceof GitHubError ? { errorKind: err.kind, retryable: err.retryable === true } : {}),
              };
            }
          }
        }

        // ---- 汇总：全成功 / 半成功（partial）/ 全失败 ----
        const attempted = Object.values(channels).filter((c) => c && c.skipped !== true);
        const okCount = attempted.filter((c) => c.ok).length;
        result.upload = okCount > 0;
        result.channels = channels;
        if (channels.webdav) result.remote = channels.webdav.ok ? channels.webdav : undefined;

        if (attempted.length === 0) {
          throw new Error("没有任何可用的上传通道：请把 webdavEnabled 或 githubEnabled 打开，并填好对应目标。");
        }
        if (okCount === 0) {
          const first = attempted.find((c) => !c.ok);
          const e = new Error(`全部上传通道失败：${first ? first.error : "未知错误"}`);
          e.partial = false;
          throw e;
        }
        result.partial = okCount < attempted.length;
        if (result.partial) {
          const failed = [];
          if (channels.webdav && channels.webdav.skipped !== true && !channels.webdav.ok) {
            failed.push(`WebDAV: ${channels.webdav.error}`);
          }
          if (channels.github && channels.github.skipped !== true && !channels.github.ok) {
            failed.push(`GitHub: ${channels.github.error}`);
          }
          result.partialReason = failed.join("；");
        }
        result.durationMs = Date.now() - startedAt;
      }
    } catch (err) {
      result.ok = false;
      result.error = redact(err && err.message ? err.message : String(err));
      if (err instanceof WebDavError || err instanceof GitHubError) result.errorKind = err.kind;
      result.durationMs = Date.now() - startedAt;
    }

    // 状态落盘；写失败也绝不影响 Host
    try {
      const prev = await loadState(dataDir);
      // 半失败计数：连续 N 轮 partial 则升级为 needsAttention 供人工介入。
      const partialStreak = result.partial ? (prev.partialStreak ?? 0) + 1 : 0;
      // 「真的同步过」= 至少一个通道成功且不是 skipped。它是 remoteIntervalHours
      // 节流的锚点；失败轮不更新，否则一次失败会把窗口白白推开。
      const synced = result.upload === true && result.partial !== true;
      const next = {
        ...prev,
        pluginLoaded: true,
        lastRunAt: result.at,
        lastRunOk: result.ok,
        lastRunReason: result.reason,
        lastPayload: result.payload ?? prev.lastPayload ?? null,
        lastSyncAt: synced ? result.at : prev.lastSyncAt,
        lastUpload: result.remote ?? prev.lastUpload ?? null,
        lastChannels: result.channels ?? prev.lastChannels ?? null,
        lastPartial: result.partial === true,
        partialStreak: partialStreak,
        needsAttention: partialStreak >= config.partialAlertAfter,
        lastError: result.ok ? null : result.error,
        lastErrorKind: result.errorKind ?? null,
        lastDurationMs: result.durationMs ?? null,
        // 自检失败的独立健康位：只有这次真跑了自检才更新它，
        // 关掉 restoreCheck 时保留上一次的结果而不是悄悄抹掉。
        restoreCheckFailed:
          result.restoreCheck !== undefined ? result.restoreCheckFailed === true : (prev.restoreCheckFailed ?? false),
        lastRestoreCheck: result.restoreCheck ?? prev.lastRestoreCheck ?? null,
        runs: (prev.runs ?? 0) + 1,
        failures: result.ok ? 0 : (prev.failures ?? 0) + 1,
      };
      await saveState(dataDir, next);
    } catch {
      /* 状态写失败属非致命，直接忽略以免影响宿主 */
    }
    return result;
  }

  /**
   * 所有外部入口的统一入口：**拿锁 → runOnce → 落 state**。
   *
   * 谁必须走这里：agent 工具 `sync_backup_run`、GUI RPC `sync-backup.run`、
   * 定时器注入的 `runOnce`、以及任何将来新增的触发口。直接调 `runOnce` 会绕过互斥。
   */
  async function runExclusive(opts = {}) {
    const reason = opts.reason ?? "manual";
    // 只负责持锁：state 的读改写仍留在 runOnce 尾部（那里才拿得到 channels /
    // partialStreak 这些本次运行独有的字段）。因为 runOnce 整段都在锁内执行，
    // 那次 saveState 同样受保护 —— 两次并发运行不会再互相覆盖 runs/failures。
    return await withRunLock(reason, async () => await runOnce(opts));
  }

  /* ---------------- 定时器（P4） ---------------- */

  // 自排期：start() 排下一次 + 视阈值补跑一次；stop() 清定时器（在跑的活自然结束）。
  // 安全口径：uploadOnSchedule 缺省 false —— 定时跑只做本地打包（零网络）；
  // 必须同时 uploadOnSchedule: true 且 dryRun: false 才会出网，runOnce 内的 dryRun 闸门仍在。
  //
  // 注意：调度器必须在**工具注册与 RPC 挂载之前**构造。下面 `ctx.inject([...], mount)`
  // 在服务已就绪时会**同步**回调，而状态快照要读 `scheduler.nextRunAt`；若此时 `scheduler`
  // 仍处于 TDZ，回调会抛 ReferenceError。
  const scheduler = new BackupScheduler({
    getConfig: async () => ({
      enabled: config.enabled,
      intervalHours: config.intervalHours,
      remoteIntervalHours: config.remoteIntervalHours,
      startupMinIntervalMs: config.startupMinIntervalMs,
      maxBackoffHours: config.maxBackoffHours,
      dryRun: config.dryRun,
      schedulerEnabled: config.schedulerEnabled,
      uploadOnSchedule: config.uploadOnSchedule,
      startupRunOnBoot: config.startupRunOnBoot,
    }),
    getState: async () => await loadState(dataDir),
    // 走 runExclusive：定时触发与手动触发共享同一把锁
    runOnce: async (o) => await runExclusive(o),
    log: {
      info: (m) => ctx.logger?.info?.(`[sync-backup] ${m}`),
      warn: (m, e) => ctx.logger?.warn?.(`[sync-backup] ${m}`, e),
      error: (m, e) => ctx.logger?.error?.(`[sync-backup] ${m}`, e),
    },
  });

  /**
   * 恢复自检用：现打一份内存包（不落盘、不上传）。
   * 提取出来是因为 GUI 的 restore-check 端点在没有本地产物时也要能跑。
   */
  async function buildForCheck() {
    const { entries } = await collect(home, { whitelist: resolveWhitelist(config.selectedPaths) });
    let picked = entries;
    if (!config.includeSessions) picked = picked.filter((e) => !e.path.startsWith("sessions/"));
    if (!config.includeSemantic) picked = picked.filter((e) => !e.path.startsWith("memory/semantic/"));
    const hits = picked.filter((e) => isForbidden(e.path));
    if (hits.length > 0) throw new Error(`归档命中危险路径，已中止：${hits.map((e) => e.path).join(", ")}`);
    const { gz } = buildArchive(
      picked.map((e) => ({ path: e.path, data: e.data, mode: e.mode, mtimeMs: e.mtimeMs })),
    );
    return { gz, manifest: picked.map((e) => ({ path: e.path, sha256: e.sha256 })) };
  }

  /**
   * 逐条算白名单条目在本机的实际体积（只 size，不读内容）。
   * 环境页要用它回答「勾上这项会让载荷增加多少」。
   */
  async function catalogSizes(targetHome) {
    const out = [];
    for (const entry of CATALOG) {
      const { entries } = await collect(targetHome, { whitelist: entry.rules });
      const bytes = entries.reduce((n, e) => n + e.size, 0);
      out.push({ id: entry.id, fileCount: entries.length, bytes });
    }
    return out;
  }

  /* ---------------- 状态快照（工具与 RPC 共用） ---------------- */

  /**
   * 收集一次状态快照。**只读**：不触发备份、不出网。
   * 工具 `sync_backup_status` 与设置页 RPC `sync-backup.status` 共用同一份事实，
   * 避免两处各拼一套文本而产生口径漂移。
   */
  async function statusSnapshot() {
    const st = await loadState(dataDir);
    // 本地产物占用 —— 无论是否开启落盘都查，这样关掉后也能看到「还剩多少没清理」。
    const art = await artifactUsage(dataDir).catch(() => ({ count: 0, bytes: 0, exists: false }));
    const artifacts = await listArtifacts(dataDir).catch(() => []);

    /**
     * v3：面板要回答三个「我现在到底是什么状态」的问题，这里一次性备好
     * （必须排在 `lines` 之前 —— 文本行里要用 `recovery` 的掩码）。
     *
     * - 用户改过哪些键（userOverrides）—— 否则面板上显示的默认值和真正生效的值
     *   可能不是一回事，用户会以为界面骗人；
     * - 恢复码掩码（recovery）—— 让用户随时确认「我这台的密钥还在」，
     *   但**只有点导出才给明文**，快照本身永远只带掩码。
     */
    const userConfig = await loadUserConfig(dataDir).catch(() => ({}));
    const userOverrides = new Set(Object.keys(userConfig).filter((k) => k in BASELINE));
    const userOverrideCount = userOverrides.size;
    let recovery = { recoveryCode: "", created: false };
    try {
      recovery = await loadOrCreateKey(dataDir);
    } catch {
      /* 拿不到密钥时不让状态页挂掉 —— 面板会把加密字段显示为未知 */
    }

    const lines = [
      `插件: ${st.pluginLoaded ? "已加载" : "未运行过"}`,
      `上次运行: ${st.lastRunAt ?? "从未"}（${st.lastRunOk === true ? "成功" : st.lastRunOk === false ? "失败" : "—"}，原因 ${st.lastRunReason ?? "—"}${st.lastDurationMs != null ? `，耗时 ${st.lastDurationMs} ms` : ""}）`,
      st.lastPayload
        ? `上次载荷: ${st.lastPayload.fileCount} 个文件 / 源 ${mb(st.lastPayload.sourceBytes)} → gzip ${mb(st.lastPayload.gzBytes)}（${(st.lastPayload.ratio * 100).toFixed(1)}%）`
        : "上次载荷: —",
      `累计运行 ${st.runs ?? 0} 次，连续失败 ${st.failures ?? 0} 次`,
      `保留份数: ${config.keepLast}；本地周期 ${config.intervalHours}h；远端周期 ${config.remoteIntervalHours === 0 ? "每次都同步" : `${config.remoteIntervalHours}h`}；dryRun=${config.dryRun}`,
      `本地产物: ${config.persistArchive ? `开启，${art.count} 份 / ${mb(art.bytes)}，保留 ${config.localKeepDays} 天` : "关闭（不在磁盘留归档）"}`,
      `恢复自检: ${config.restoreCheck ? "开启" : "关闭"}`,
      `定时器: ${config.schedulerEnabled ? (config.enabled ? "已启用" : "已停用（enabled=false）") : "已关闭"}；定时上传=${config.uploadOnSchedule === true && config.dryRun !== true ? "开" : "关（仅本地打包）"}`,
      `下次计划运行: ${scheduler?.nextRunAt ? scheduler.nextRunAt.toISOString() : "未排期"}`,
      `包含 sessions=${config.includeSessions}，semantic=${config.includeSemantic}`,
      `加密: 开启（AES-256-GCM，密钥随插件数据目录存放）；恢复码 ${recovery.recoveryCode ? `${maskRecoveryCode(recovery.recoveryCode)}…` : "不可用"}`,
      `WebDAV: ${config.webdavEnabled ? config.webdavPath : "已禁用（不与任何外部服务通信）"}（口令引用 ${config.webdavCredentialRef || WEBDAV_REF}）`,
      `GitHub: ${config.githubEnabled && config.githubRepo ? `${config.githubRepo} / ${config.githubPath}` : "未启用"}（凭据引用 ${config.githubCredentialRef || GITHUB_REF}）`,
      userOverrideCount > 0
        ? `用户配置: ${path.join(dataDir, "config.json")}（覆盖 ${userOverrideCount} 项：${[...userOverrides].join(", ")}）`
        : `用户配置: 无（全部用插件默认值）`,
      st.lastUpload
        ? `上次上传: ${st.lastUpload.id}（${mb(st.lastUpload.remoteBytes ?? 0)}，SHA256 ${String(st.lastUpload.sha256).slice(0, 16)}…，保留 ${st.lastUpload.kept} 份）`
        : "上次上传: —",
      ...channelLines(st.lastChannels),
    ];
    if (st.lastPartial) lines.push(`半失败连续 ${st.partialStreak ?? 1} 轮`);
    if (st.needsAttention) lines.push("⚠️ needsAttention: 半失败已达阈值，请人工检查失败通道");
    if (st.lastError) lines.push(`上次错误: ${st.lastError}`);
    lines.push(`数据目录: ${dataDir}`);

    // 供设置页渲染的结构化字段（文本面向工具输出，字段面向 GUI）。
    //
    // health 是给「一眼排障」用的**单一结论**，优先级从高到低：
    //   needsAttention（半失败连击到阈值） > 上次失败 > 半失败 > 进行中 > 从未跑过 > 正常。
    // 面板把它渲染成顶部状态条，不必先读细节就能判断要不要介入。
    const runState = st.lastRunOk === true ? "ok" : st.lastRunOk === false ? "fail" : "never";
    const health = st.needsAttention
      ? "attention"
      : st.lastRunOk === false
        ? "fail"
        : st.lastPartial === true
          ? "partial"
          : runBusy() || scheduler?.running === true
            ? "running"
            : st.lastRunOk === true
              ? "ok"
              : "never";

    const view = {
      loaded: st.pluginLoaded === true,
      health,
      healthReason: st.lastError ?? (st.lastPartial ? (st.lastChannels ? Object.keys(st.lastChannels).join("+") : null) : null),
      lastRunAt: st.lastRunAt ?? null,
      lastRunOk: st.lastRunOk ?? null,
      lastRunReason: st.lastRunReason ?? null,
      lastDurationMs: st.lastDurationMs ?? null,
      lastPayload: st.lastPayload ?? null,
      lastUpload: st.lastUpload ?? null,
      // remoteIntervalHours 节流的锚点：面板用它说明「下次远端同步窗口从何时算起」
      lastSyncAt: st.lastSyncAt ?? null,
      lastChannels: st.lastChannels ?? null,
      channels: channelView(st.lastChannels),
      runs: st.runs ?? 0,
      failures: st.failures ?? 0,
      partialStreak: st.partialStreak ?? 0,
      partialAlertAfter: config.partialAlertAfter,
      lastPartial: st.lastPartial === true,
      needsAttention: st.needsAttention === true,
      lastError: st.lastError ?? null,
      lastErrorKind: st.lastErrorKind ?? null,
      nextRunAt: scheduler?.nextRunAt ? scheduler.nextRunAt.toISOString() : null,
      // 以编排层的锁为权威判据：手动/工具/定时三种触发都算「忙」
      busy: runBusy(),
      // 自检失败是独立健康位：它不该被混进普通 lastError 里被忽略
      restoreCheckFailed: st.restoreCheckFailed === true,
      enabled: config.enabled,
      dryRun: config.dryRun,
      webdavEnabled: config.webdavEnabled,
      webdavPath: config.webdavPath,
      webdavRef: config.webdavCredentialRef || WEBDAV_REF,
      githubRepo: config.githubRepo || "",
      githubPath: config.githubPath,
      githubRef: config.githubCredentialRef || GITHUB_REF,
      keepLast: config.keepLast,
      intervalHours: config.intervalHours,
      maxBackoffHours: config.maxBackoffHours,
      schedulerEnabled: config.schedulerEnabled,
      uploadOnSchedule: config.uploadOnSchedule,
      includeSessions: config.includeSessions,
      includeSemantic: config.includeSemantic,
      // ---- v2 新增（需求①②⑤⑥）：GUI 需要这些值才能渲染控制面板 ----
      remoteIntervalHours: config.remoteIntervalHours,
      persistArchive: config.persistArchive,
      localKeepDays: config.localKeepDays,
      restoreCheck: config.restoreCheck,
      selectedPaths: config.selectedPaths,
      // intro / introEn 双语都下发：面板按界面语言选一边渲染。
      // 别在浏览器里做机器翻译 —— 一句话的介绍译错了比不译更糟。
      catalog: CATALOG.map((e) => ({
        id: e.id,
        intro: e.intro,
        introEn: e.introEn ?? e.intro,
        risk: e.risk,
        defaultOn: e.defaultOn !== false,
      })),
      artifacts: {
        enabled: config.persistArchive,
        dir: artifactDir(dataDir),
        count: art.count,
        bytes: art.bytes,
        keepDays: config.localKeepDays,
        items: artifacts.slice(0, 20).map((i) => ({
          name: i.name,
          bytes: i.bytes,
          mtimeMs: i.mtimeMs,
        })),
      },
      webdavUrl: config.webdavUrl,
      webdavUsername: config.webdavUsername,
      dataDir,
      statePath: path.join(dataDir, "state.json"),
      // ---- v3：小白化所需的状态 ----
      // 面板靠这几项回答「我现在到底通不通外网 / 有没有抄袭别人配置 / 记不记得住恢复码」。
      githubEnabled: config.githubEnabled,
      userConfigPath: path.join(dataDir, "config.json"),
      userConfigActive: userOverrideCount > 0,
      userConfigKeys: [...userOverrides],
      recoveryCodeMasked: maskRecoveryCode(recovery.recoveryCode),
      recoveryCodeIsNew: recovery.created === true,
      encryptedDefault: true,
      now: new Date().toISOString(),
    };
    return { ...st, view, runState, text: lines.join("\n"), lines };
  }

  /* ---------------- 工具注册 ---------------- */

  ctx.tools.register(defineTool({
    name: "sync_backup_run",
    description:
      "Run one dsh-sync-backup pass now. Default (upload=false) is a local dry-run: collect the whitelisted DSH files, build a tar.gz in memory, verify the round-trip, and report counts and sizes WITHOUT any network access. Set upload=true to really upload that one payload to BOTH configured channels (WebDAV and/or a private GitHub repo), each followed by a read-back SHA256 verification. upload=true is REFUSED while config.dryRun is true. A single failing channel does not abort the run: the result reports per-channel status and partial=true.",
    parameters: {
      // 参数是**顶层属性表**：真实 parameterSchemaSpecToJsonSchema
      // （dsh-tools :802）把它当作属性映射编译成 { type:"object", properties:{…} }。
      // 写成 `{ input: {…} }` 会声明一个名叫 input 的顶层参数，
      // execute 里的 `args.upload` 永远读不到 —— 官方工具（read/glob/…）
      // 全部用顶层属性，这里照办。
      upload: { type: "boolean", description: "true = 真实上传到 WebDAV / GitHub 并回读校验 SHA256；缺省 false，只做本地 dry-run（零网络）" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: true,
        properties: {
          ok: { type: "boolean" },
          dryRun: { type: "boolean" },
          fileCount: { type: "number" },
          sourceBytes: { type: "number" },
          gzBytes: { type: "number" },
          ratio: { type: "number" },
          remoteId: { type: "string" },
          remoteSha256: { type: "string" },
          archiveUrl: { type: "string" },
          partial: { type: "boolean" },
          partialReason: { type: "string" },
          channels: { type: "object", additionalProperties: true },
          durationMs: { type: "number" },
          error: { type: "string" },
        },
      },
      render: (_a, v) =>
        v.ok
          ? [
              {
                type: "text",
                text: [
                  `${v.dryRun ? "dry-run（未上传）" : v.partial ? "部分上传（半失败）" : "上传"}完成：${v.fileCount} 个文件`,
                  `源 ${mb(v.sourceBytes)} → gzip ${mb(v.gzBytes)}（压缩率 ${(v.ratio * 100).toFixed(1)}%）`,
                  ...channelLines(v.channels),
                  `耗时 ${v.durationMs} ms`,
                ].join("\n"),
              },
            ]
          : [{ type: "text", text: [`备份失败：${v.error ?? "未知错误"}`, ...channelLines(v.channels)].join("\n") }],
    },
    execute: async (args) => {
      const wantUpload = args.upload === true;
      const r = await runExclusive({ upload: wantUpload, reason: wantUpload ? "manual-upload" : "manual" });
      // busy 是「没跑」而不是「跑失败了」：明确回一个可判定的形状，
      // 让调用方知道该重试而不是去查故障。
      if (r.busy === true) {
        return { ok: false, busy: true, reason: r.reason, error: r.error, text: `已有备份在进行中：${r.error}` };
      }
      // ⚠️ 工具返回值要过 Host 的两道校验，二者对「缺值」的处置相反：
      //  1) lossless JSON（dsh-tools lib/index.js:2577-2578 snapshotJsonValue）——
      //     任意层级出现 `undefined` 就让整个调用以
      //     `tool "sync_backup_run" returned invalid output: value is not lossless JSON` 失败；
      //  2) output.schema（:3543 validateJsonSchemaValue）—— 声明了类型的键若存在
      //     就必须匹配，`null` 不是 object/string（checkValue:448-451 → isPlainJsonRecord(null) === false）。
      // 所以「无值」的唯一合法表达是**键缺席**，既不能给 undefined 也不能给 null。
      // 离线冒烟用假 ctx，不过这两道校验，只有真实 Host 才暴露此缺陷。
      if (!r.ok) {
        const failed = {
          ok: false,
          dryRun: !wantUpload,
          partial: false,
          error: r.error ?? "未知错误",
          durationMs: r.durationMs,
        };
        if (r.channels != null) failed.channels = r.channels;
        return failed;
      }
      const out = {
        ok: true,
        dryRun: !r.upload,
        fileCount: r.payload.fileCount,
        sourceBytes: r.payload.sourceBytes,
        tarBytes: r.payload.rawBytes,
        gzBytes: r.payload.gzBytes,
        ratio: r.payload.ratio,
        partial: r.partial === true,
        durationMs: r.durationMs,
      };
      if (r.remote != null) {
        out.remoteId = r.remote.id;
        out.remoteSha256 = r.remote.sha256;
        out.archiveUrl = r.remote.archiveUrl;
      }
      if (r.partialReason != null) out.partialReason = r.partialReason;
      if (r.channels != null) out.channels = r.channels;
      return out;
    },
    presentCall: () => ({ card: "generic", title: "dsh-sync-backup run", kind: "other", rawInput: {} }),
  }));

  ctx.tools.register(defineTool({
    name: "sync_backup_status",
    description:
      "Show dsh-sync-backup status: whether the plugin loaded, the last run time and result, last payload sizes and file count, run/failure counters, and the effective whitelist and retention settings.",
    // 无参数工具：空属性表，编译为 { type:"object", properties:{} }。
    parameters: {},
    output: {
      schema: { type: "object", additionalProperties: true, properties: {} },
      render: (_a, v) => [{ type: "text", text: v.text }],
    },
    execute: async () => {
      const st = await statusSnapshot();
      return { ...st, text: st.text };
    },
    presentCall: () => ({ card: "generic", title: "dsh-sync-backup status", kind: "other", rawInput: {} }),
  }));

  /* ---------------- 提示词小节 ---------------- */

  // `inject: ["tools"]` 是硬门禁：读未注入的服务属性会**当场抛错**（不是返回 undefined），
  // 整个 apply() 随之失败、插件静默不加载。systemPrompt 是可选服务，必须走 ctx.get()。
  const systemPrompt = ctx.get("systemPrompt");
  if (config.promptSection && systemPrompt !== undefined && typeof systemPrompt.section === "function") {
    ctx.effect(
      () => systemPrompt.section({ name: "sync-backup:instructions", order: config.sectionOrder, text: SECTION_TEXT }),
      "sync-backup.section()",
    );
  }

  /* ---------------- 设置页 RPC（P5） ---------------- */

  // 设置页走 host 注册的 RPC 通道：`connection.rpc.handle(channel, dispatch)`。
  // 这是 dsh-workspace-mover 验证过的官方路径（其 lib/index.js:2666 与 client 端 rpc.call）。
  // `connection` / `webServer` 都是**可选**服务：拿不到就静默跳过（工具面与定时器不受影响）。
  //
  // 契约（源：dsh-client-connection lib/types/rpc-host.js）：
  //   - `handle(channel, handler)` 只有两个参数；没有 authority 选项 —— 每个请求都由
  //     `admit()` 统一过 Host/Origin 围栏 + 浏览器会话认证（未认证 401 / 越界 403）。
  //   - `CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/`，**必须带前导斜杠**，且不得为保留的 "/api"。
  //   - handler 签名 `(endpoint, payload, signal, peer)`，返回值即结果信封 `{ok,value}` / `{ok,error}`。
  //
  // 安全口径：本通道**绝不接受上传参数** —— 真实出网只能由 agent 工具 `sync_backup_run`
  // 显式 upload:true 触发（还须 dryRun=false）。GUI 只能触发本地打包。
  const RPC_CHANNEL = "/sync-backup";

  const mountRpc = (owner) => {
    const connection = owner?.connection;
    if (!connection?.rpc?.handle) return;
    // 把 rpc 重绑到本插件的注入上下文，使其在 webServer 上注册的 route 归本插件 fiber 所有
    // （与 workspace-mover 同款；否则 route 绑在 connection 自身的 fiber 上）。
    const rawConnection = connection[Symbol.for("cordis.original")] ?? connection;
    const scopedConnection = rawConnection?.[Symbol.for("cordis.extend")]?.({ ctx: owner }) ?? connection;

    const okv = (value) => ({ ok: true, value });
    const failv = (code, message) => ({ ok: false, error: { code, message, details: { issues: [{ message }] } } });

    const dispatch = async (endpoint, payload) => {
      try {
        switch (endpoint) {
          case "sync-backup.status": {
            const st = await statusSnapshot();
            return okv({ view: st.view, text: st.text });
          }
          case "sync-backup.run": {
            // 只做本地打包，零网络；真实上传不在 GUI 通道内暴露。
            // 锁是权威判据（scheduler.running 只覆盖定时器那一路）。
            const r = await runExclusive({ upload: false, reason: "gui" });
            if (r.busy === true) return failv("busy", r.error ?? "已有一次备份在进行中，请稍后再试");
            const st = await statusSnapshot();
            if (!r.ok) return failv("backup-failed", r.error ?? "备份失败");
            return okv({
              dryRun: true,
              fileCount: r.payload?.fileCount ?? 0,
              sourceBytes: r.payload?.sourceBytes ?? 0,
              gzBytes: r.payload?.gzBytes ?? 0,
              ratio: r.payload?.ratio ?? 0,
              durationMs: r.durationMs,
              view: st.view,
              text: st.text,
            });
          }
          // ---- v2：维护类端点（全部本地，零网络） ----
          case "sync-backup.prune": {
            // 手动清理本地产物：受 payload.maxDays / payload.keepLast 覆盖，缺省用配置值。
            const body = payload && typeof payload === "object" ? payload : {};
            const keepDays = Number.isFinite(body.keepDays) ? body.keepDays : config.localKeepDays;
            const keepLast = Number.isFinite(body.keepLast) ? body.keepLast : config.keepLast;
            const cleaned = await prune(dataDir, { keepDays, keepLast, now: new Date() });
            const st = await statusSnapshot();
            return okv({
              removed: cleaned.removed,
              bytesFreed: cleaned.bytesFreed,
              kept: cleaned.kept,
              view: st.view,
            });
          }
          case "sync-backup.restore-check": {
            // 对最近一份本地产物跑恢复前自检；没有产物就先打包一份进临时再检（不落盘）。
            const body = payload && typeof payload === "object" ? payload : {};
            const items = await listArtifacts(dataDir);
            const target = body.name ? items.find((i) => i.name === body.name) : items[0];
            let gz;
            let checkManifest = null;
            if (target) {
              gz = await fs.readFile(target.file);
            } else {
              if (runBusy() || scheduler?.running === true) {
                return failv("busy", "已有一次备份在进行中，请稍后再试");
              }
              const built = await buildForCheck();
              gz = built.gz;
              checkManifest = built.manifest;
            }
            let check;
            // 本地产物是加密的，自检前必须先拿到 key —— 与 runOnce 里那份同源。
            const keyInfo = await loadOrCreateKey(dataDir);
            try {
              check = await restoreCheck(gz, {
                home,
                manifest: checkManifest ?? [],
                extract: true,
                key: keyInfo.key,
              });
            } finally {
              if (check) await cleanupTempDir(check.tempDir);
            }
            return okv({
              source: target ? target.name : "(内存中新打的临时包)",
              ok: check.ok,
              errors: check.errors,
              warnings: check.warnings,
              stats: check.stats,
            });
          }
          // 检查白名单条目在本机的实际体积 —— 环境页要显示「勾这项要多大」。
          case "sync-backup.catalog-sizes": {
            const sizes = await catalogSizes(home);
            return okv({ entries: sizes });
          }
          // ---- v3：小白化端点（把「改 YAML」变成「在页面里点」） ----
          case "sync-backup.save-config": {
            // 用户可以改哪些键、每个键长什么样，全部在 lib/user-config.js 里把关。
            // 这里只做「拒绝或接受」，不做任何隐式修值 —— 悄悄把 "七天" 改成 7
            // 会让用户以为改成功了，下次再看还是默认值。
            const body = payload && typeof payload === "object" ? payload : {};
            const { accepted, rejected, problems } = sanitizeEditable(body, {
              knownPathIds: new Set(CATALOG.map((e) => e.id)),
            });
            if (problems.length > 0) {
              return {
                ok: false,
                error: { code: "bad-request", message: problems.join("；") },
              };
            }
            if (Object.keys(accepted).length === 0) {
              return failv("bad-request", rejected.length > 0 ? `这些键不允许在界面修改：${rejected.join(", ")}` : "没有要保存的改动");
            }
            await saveUserConfig(dataDir, accepted);
            await reloadEffective();
            const st = await statusSnapshot();
            return okv({ saved: accepted, rejected, view: st.view });
          }
          case "sync-backup.export-recovery-code": {
            // 用户主动点「导出」才给明文。平时 state / view 里只有掩码。
            // 它必须在 off-device 保管：换机器或重装后，没有它连本地产物也解不开。
            const info = await loadOrCreateKey(dataDir);
            return okv({
              recoveryCode: info.recoveryCode,
              masked: maskRecoveryCode(info.recoveryCode),
              created: info.created === true,
            });
          }
          default:
            return failv("bad-request", `unknown endpoint '${endpoint}'`);
        }
      } catch (err) {
        return failv("internal-error", redact(err && err.message ? err.message : String(err)));
      }
    };

    const dispose = scopedConnection.rpc.handle(RPC_CHANNEL, dispatch);
    owner.effect?.(() => () => { try { dispose?.(); } catch { /* ignore */ } }, "sync-backup: rpc dispose");
  };

  if (typeof ctx.inject === "function") {
    ctx.inject(["connection", "webServer"], (webCtx) => mountRpc(webCtx));
  }

  /* ---------------- 定时器启动 ---------------- */

  if (config.enabled && config.schedulerEnabled) {
    ctx.effect(
      () => {
        scheduler.start();
        return () => scheduler.stop();
      },
      "sync-backup.scheduler()",
    );
  }
}

export { Config, SECTION_TEXT, apply, inject, name };
export default { Config, SECTION_TEXT, apply, inject, name };
