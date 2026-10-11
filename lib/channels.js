/*
 * lib/channels.js — 双通道上传与结果聚合（报告 8.3 拆分自 index.js）。
 *
 * 为什么单独成模块：这一段是 index.js 里最长、也最独立的一块 —— 它只做
 * 「解析凭据 → 上传 → 回读校验 → 组装通道状态」，不碰编排层的单次运行锁，
 * 也不写 state。抽出来之后 index.js 只负责流程与生命周期。
 *
 * 边界口径（迁移时逐字保持，不改行为）：
 *  - config 传的是 apply() 里那个**就地合并**的活对象引用，所以 reloadEffective
 *    之后读到的永远是最新值 —— 与拆分前一致。
 *  - 通道失败一律落成 channels.<key> 的结构，而不是抛出去打断另一条通道；
 *    只有「一条通道都没尝试」和「全部失败」才抛，由调用方（runOnce）统一兜。
 *  - 「键缺席」而不是 undefined：channels 会原样进工具返回值，而 dsh-tools 的
 *    snapshotJsonValue 拒任意层级的 undefined（见 tools/host-gates.mjs）。
 */
import { createHash, randomBytes } from "node:crypto";

import { WebDavClient, WebDavError } from "./webdav.js";
import { GitHubClient, GitHubError } from "./github.js";
import { resolveCredential, resolveWebdavTarget } from "./creds.js";
import { redact } from "./state.js";

/**
 * 本插件自己的 WebDAV 口令槽位。
 * **不使用** config-manager 的槽位（DSH_CONFIG_MANAGER_SYNC_WEBDAV_PASSWORD）——
 * 借别人的专用密码会让本插件的可用性绑在另一个插件的配置上，失败时也难以归因。
 */
export const WEBDAV_REF = "DSH_SYNC_BACKUP_WEBDAV_PASSWORD";

/** GitHub PAT 槽位（P3 新槽位；无历史槽位可回退，缺失即跳过该通道）。 */
export const GITHUB_REF = "DSH_SYNC_BACKUP_GITHUB_TOKEN";

/** 归档 id：本地时间 `YYYYMMDD-HHMMSS` + 8 位随机 hex（天然按时间排序）。 */
export function archiveId(now) {
  const pad = (n) => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${stamp}-${randomBytes(4).toString("hex")}`;
}

function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * 造一对通道操作。env 里的三个依赖都是 apply() 已有的：
 *  - ctx  —— 只为 resolveCredential 读槽位；
 *  - home —— $DSH_HOME（口令与 sync-config.json 都在它下面）；
 *  - config —— 活配置对象引用（见文件头的就地合并口径）。
 */
export function createChannels({ ctx, home, config }) {
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

  /** WebDAV 目标解析（含 config-manager 回退），失败即返回 undefined 由调用方降级。 */
  function resolveWebdav() {
    return resolveWebdavTarget(home, { url: config.webdavUrl, username: config.webdavUsername });
  }

  /**
   * 上传一份归档（内容对象全部写完后**索引最后写**；索引写成功后才 best-effort 删旧快照，见 lib/webdav.js 的顺序契约）。
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
    const target = await resolveWebdav();
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
      // 显式配置才放行「非本机 + http」；否则只允许 https 或本机
      allowInsecureHttp: config.webdavAllowInsecureHttp === true,
    });

    const archiveSha256 = sha256Hex(gz);
    const out = await client.uploadSnapshot({
      dir: config.webdavPath,
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
    const sha = sha256Hex(bytes);
    return {
      bytes: bytes.length,
      sha256: sha,
      lengthOk: bytes.length === expected.length,
      shaOk: sha === expected.sha256,
    };
  }

  /**
   * 上传一份归档到 GitHub 私有仓库（contents API，内容对象写完后**索引最后写**；索引写成功后才删旧快照）。
   * 与 WebDAV 通道使用**同一份载荷**，故 id 由调用方传入以保持两通道一致。
   */
  async function uploadGitHubArchive({ gz, manifest, id, tokenInfo }) {
    const client = new GitHubClient({
      repo: config.githubRepo,
      branch: config.githubBranch || undefined,
      apiBaseUrl: config.githubApiBaseUrl || undefined,
      getToken: async () => tokenInfo.value,
      timeoutMs: config.githubTimeoutMs,
      allowInsecureHttp: config.githubAllowInsecureHttp === true,
    });

    const archiveSha256 = sha256Hex(gz);
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
    const sha = sha256Hex(bytes);
    return {
      bytes: bytes.length,
      sha256: sha,
      lengthOk: bytes.length === expected.length,
      shaOk: sha === expected.sha256,
    };
  }

  /**
   * 双通道上传 + 结果聚合（报告 8.3：这一段从 runOnce 里整块搬来，逻辑逐字未改）。
   *
   * 返回 `{ id, channels, upload, partial, partialReason, remote }`；
   * 「没有任何可用通道」与「全部通道失败」仍按原语义抛出，由 runOnce 的统一 catch 收尾。
   */
  async function uploadBoth({ gz, manifest, id }) {
    const channels = {};

    // ---- WebDAV ----
    if (config.webdavEnabled) {
      try {
        const up = await uploadArchive({ gz, manifest, id });
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
          const up = await uploadGitHubArchive({ gz, manifest, id, tokenInfo });
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
    const out = {
      id,
      channels,
      upload: okCount > 0,
      remote: channels.webdav ? (channels.webdav.ok ? channels.webdav : undefined) : undefined,
    };

    if (attempted.length === 0) {
      const e = new Error("没有任何可用的上传通道：请把 webdavEnabled 或 githubEnabled 打开，并填好对应目标。");
      e.channels = channels;
      throw e;
    }
    if (okCount === 0) {
      const first = attempted.find((c) => !c.ok);
      const e = new Error(`全部上传通道失败：${first ? first.error : "未知错误"}`);
      e.partial = false;
      // 拆分前 result.channels 在抛出**之前**就已设好，失败通道的详情会落进
      // state.lastChannels 与工具输出。抛出时把同一份 channels 附在错误上，
      // 由调用方的 catch 读回 —— 否则失败可见性会随拆分一起丢掉。
      e.channels = channels;
      throw e;
    }
    out.partial = okCount < attempted.length;
    if (out.partial) {
      const failed = [];
      if (channels.webdav && channels.webdav.skipped !== true && !channels.webdav.ok) {
        failed.push(`WebDAV: ${channels.webdav.error}`);
      }
      if (channels.github && channels.github.skipped !== true && !channels.github.ok) {
        failed.push(`GitHub: ${channels.github.error}`);
      }
      out.partialReason = failed.join("；");
    }
    return out;
  }

  return {
    webdavPassword,
    githubToken,
    resolveWebdav,
    uploadArchive,
    verifyRemote,
    uploadGitHubArchive,
    verifyGithubRemote,
    uploadBoth,
  };
}
