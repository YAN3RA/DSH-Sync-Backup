/**
 * dsh-sync-backup / tools/upload-once.mjs
 *
 * **真实上传一次**到 WebDAV，然后回读校验 SHA256。
 *
 * 与 plugin 内的 runOnce 的区别：本脚本直接驱动 lib（collect → archive → webdav），
 * 不经过 DSH Host、不需要启动 DSH、不排期任何定时器。用途是 P2 的端到端验收。
 *
 * 安全口径：
 *  - 口令**只**从 $DSH_HOME/.credentials.yaml 的 refs 区读取（或环境变量覆盖），
 *    全程不回显、不落盘、不写进任何输出文件；
 *  - 上传目标是 dsh-config-manager 既有配置里的 DAV 根 + `dsh-backup/` 子目录；
 *  - 上传失败不影响任何本地文件（本脚本只读本地、只写远端）。
 *
 * 用法：
 *   node tools/upload-once.mjs                # 默认上传到 dsh-backup/
 *   node tools/upload-once.mjs --dry          # 只打包 + 列计划，不产生网络请求
 *   node tools/upload-once.mjs --dir other/   # 换子目录
 *   node tools/upload-once.mjs --keep 3       # 覆盖保留份数
 *   node tools/upload-once.mjs --list         # 只读：列远端已有快照与索引
 */

import path from "node:path";
import os from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";

import { collect, isForbidden } from "../lib/collect.js";
import { buildArchive, openArchive } from "../lib/archive.js";
import { WebDavClient } from "../lib/webdav.js";
import { resolveCredential, resolveWebdavTarget, readRefFromYaml } from "../lib/creds.js";

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const HOME = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const DIR = val("--dir", "dsh-backup/");
const KEEP = Number(val("--keep", "7"));
const DRY = has("--dry");
const LIST = has("--list");

const REF_OWN = "DSH_SYNC_BACKUP_WEBDAV_PASSWORD";
const REF_FALLBACK = "DSH_CONFIG_MANAGER_SYNC_WEBDAV_PASSWORD";

function mb(n) {
  return (Number(n) / 1024 / 1024).toFixed(2) + " MB";
}

async function main() {
  console.log("=== dsh-sync-backup 真实上传（P2 验收）===");
  console.log(`DSH_HOME = ${HOME}`);
  console.log(`目标目录 = ${DIR}   保留 = ${KEEP}   模式 = ${LIST ? "只读列举" : DRY ? "打包但不上传" : "真实上传"}`);
  console.log("");

  // ---- 1. 口令与目标 ----
  const target = await resolveWebdavTarget(HOME);
  if (!target) {
    console.error("✗ 未找到 WebDAV 目标（$DSH_HOME/dsh-config-manager/sync/sync-config.json）");
    process.exit(2);
  }
  console.log(`DAV 根  = ${target.url}`);
  console.log(`用户名  = ${target.username}`);

  // 优先环境变量 → 本插件槽位 → config-manager 槽位（只报告来源与 ref 名，绝不打印值）
  let pwd;
  let pwdFrom;
  if (process.env[REF_OWN]) {
    pwd = process.env[REF_OWN];
    pwdFrom = `env:${REF_OWN}`;
  } else if (process.env[REF_FALLBACK]) {
    pwd = process.env[REF_FALLBACK];
    pwdFrom = `env:${REF_FALLBACK}`;
  } else {
    for (const ref of [REF_OWN, REF_FALLBACK]) {
      const got = await resolveCredential(null, HOME, ref);
      if (got) {
        pwd = got.value;
        pwdFrom = `${got.source}:${ref}`;
        break;
      }
    }
  }
  if (!pwd) {
    // 最后兜底：直接读文件（resolveCredential 的官方服务分支在无 ctx 时会跳过）
    try {
      const text = await fs.readFile(path.join(HOME, ".credentials.yaml"), "utf8");
      for (const ref of [REF_OWN, REF_FALLBACK]) {
        const v = readRefFromYaml(text, ref);
        if (v) {
          pwd = v;
          pwdFrom = `file:${ref}`;
          break;
        }
      }
    } catch {
      /* 读不到就是没有 */
    }
  }
  if (!pwd) {
    console.error(`✗ 未找到口令：${REF_OWN} / ${REF_FALLBACK} 均未配置`);
    process.exit(2);
  }
  console.log(`口令来源 = ${pwdFrom}（长度 ${pwd.length}，值不回显）`);
  console.log("");

  const client = new WebDavClient({
    baseUrl: target.url,
    username: target.username,
    getPassword: async () => pwd,
    timeoutMs: 300000,
  });

  const colUrl = `${target.url.replace(/\/+$/, "")}/${DIR.replace(/^\/+|\/+$/g, "")}/`;

  // ---- 2. 只读列举模式 ----
  if (LIST) {
    const indexUrl = `${colUrl}dsh-backup-index.json`;
    const { index, missing } = await client.readIndex(indexUrl, pwd);
    if (missing) {
      console.log("远端索引不存在（该集合尚无快照）。");
      process.exit(0);
    }
    console.log(`索引 updatedAt = ${index.updatedAt}`);
    console.log(`快照条数 = ${index.entries.length}`);
    for (const e of index.entries) {
      console.log(
        `  - ${e.id}  ${e.createdAt}  ${mb(e.archiveBytes)}  文件 ${e.fileCount}  sha256 ${String(e.archiveSha256).slice(0, 12)}…`,
      );
    }
    process.exit(0);
  }

  // ---- 3. 本地收集 + 打包 ----
  const t0 = Date.now();
  const { entries, manifest, skipped } = await collect(HOME);
  const hits = entries.filter((e) => isForbidden(e.path));
  if (hits.length > 0) {
    console.error(`✗ 危险路径命中：${hits.map((e) => e.path).join(", ")}`);
    process.exit(3);
  }
  const { gz, gzBytes, rawBytes } = buildArchive(
    entries.map((e) => ({ path: e.path, data: e.data, mode: e.mode, mtimeMs: e.mtimeMs })),
  );
  const restored = openArchive(gz);
  const restoredPaths = new Set(restored.map((r) => r.path));
  const missingLocal = entries.filter((e) => !restoredPaths.has(e.path));
  const sha = createHash("sha256").update(gz).digest("hex");

  console.log(`本地收集: ${entries.length} 个文件（跳过 ${skipped.length}）`);
  console.log(`源 ${mb(entries.reduce((n, e) => n + e.size, 0))} → tar ${mb(rawBytes)} → gzip ${mb(gzBytes)}（${((gzBytes / rawBytes) * 100).toFixed(1)}%）`);
  console.log(`本地 SHA256 = ${sha}`);
  console.log(`解包回验: ${restored.length}/${entries.length}${missingLocal.length ? `（缺失 ${missingLocal.length}）` : " ✓"}`);
  console.log(`打包耗时 ${Date.now() - t0} ms`);
  console.log("");

  if (missingLocal.length > 0) {
    console.error("✗ 本地解包回验失败，终止");
    process.exit(3);
  }

  if (DRY) {
    const id = "（dry 模式未生成）";
    console.log(`--dry 指定：不做任何网络请求。将上传为 ${colUrl}<时间戳>-<随机>.tar.gz`);
    console.log(`计划快照 id ${id}；保留 ${KEEP} 份。`);
    process.exit(0);
  }

  // ---- 4. 真实上传 ----
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const id =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}` +
    `-${randomBytes(4).toString("hex")}`;

  console.log(`开始上传 id = ${id} …`);
  const t1 = Date.now();
  const out = await client.uploadSnapshot({
    dir: DIR,
    id,
    archive: gz,
    manifest: {
      schemaVersion: 1,
      plugin: "dsh-sync-backup",
      id,
      createdAt: now.toISOString(),
      fileCount: entries.length,
      totalBytes: entries.reduce((n, e) => n + e.size, 0),
      archiveBytes: gz.length,
      archiveSha256: sha,
    },
    keepLast: KEEP,
  });
  const uploadMs = Date.now() - t1;
  console.log(`上传完成，耗时 ${uploadMs} ms`);
  console.log(`  归档   ${out.archiveUrl}`);
  console.log(`  清单   ${out.manifestUrl}`);
  console.log(`  索引   ${out.indexUrl}（${out.index.entries.length} 份）`);
  if (out.pruned.length) console.log(`  清理   ${out.pruned.join(", ")}`);
  console.log("");

  // ---- 5. 回读校验 ----
  console.log("回读校验（GET 归档并比对 SHA256）…");
  const t2 = Date.now();
  const back = await client.get(out.archiveUrl, pwd);
  const backSha = createHash("sha256").update(back.buffer).digest("hex");
  const verifyMs = Date.now() - t2;
  console.log(`  远端字节 = ${back.buffer.length}（本地 ${gz.length}）${back.buffer.length === gz.length ? " ✓" : " ✗"}`);
  console.log(`  远端 SHA256 = ${backSha}`);
  console.log(`  长度一致 = ${back.buffer.length === gz.length}；SHA256 一致 = ${backSha === sha}`);
  console.log(`  校验耗时 ${verifyMs} ms`);
  console.log("");

  // 再读一次索引，确认索引里记的就是这份
  const idx = await client.readIndex(out.indexUrl, pwd);
  const rec = idx.index?.entries?.find((e) => e.id === id);
  console.log(`索引回读: ${rec ? `已记录 ${rec.id}（${mb(rec.archiveBytes)}，sha256 ${String(rec.archiveSha256).slice(0, 12)}…）` : "✗ 未找到该条目"}`);
  console.log("");

  const ok = back.buffer.length === gz.length && backSha === sha && !!rec;
  console.log(ok ? "✅ 端到端验收通过：上传 → 索引 → 回读 SHA256 全部一致。" : "❌ 验收失败，见上方差异。");
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error("✗ 异常：", err?.message ?? err);
  process.exit(1);
});
