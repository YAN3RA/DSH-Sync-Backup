# Architecture

> Moved out of the README so the front page stays usable for someone installing the plugin.
> Everything here is implementation detail; none of it is required to run a backup.

## Module map

```
index.js          Host half: Config + apply, orchestration (run lock, runOnce, status, RPC, scheduler lifecycle)
lib/channels.js     Dual-channel upload + credential resolution + result aggregation
cordis.patch.yml  bundle patch row (row id must byte-match `export const name`)
lib/client.js     Client half: the settings panel (source-as-product, no build)
lib/collect.js    allowlist collection + structural forbidden-path assertions
lib/archive.js    hand-written USTAR writer + gzip (zero dependencies)
lib/crypto.js     AES-256-GCM envelope; lib/keyring.js owns the key and recovery code
lib/webdav.js     WebDAV client; lib/github.js GitHub contents API client
lib/artifacts.js  local artifact listing + pruning; lib/restore-check.js pre-restore verification
lib/scheduler.js  self-rescheduling timers with exponential backoff
lib/user-config.js  config.json allowlist + per-key validation
tools/            verification suites and the two credential helpers
```

## Design decisions

| Design decision | Reason |
| --- | --- |
| Hand-written USTAR instead of the `tar` package | 45 of 259 paths exceed the 100-byte USTAR `name` field, up to 158 bytes; they need `name` + `prefix` splitting. Zero dependencies also keeps the observable attack surface small. |
| `peerDependencies` declared but no `dependencies` | Required by the loader for `link:` installs (see Install). Nothing is installed from them. |
| The panel asks for confirmation before saving `webdavUrl` / `webdavUsername` / `githubRepo` | Those three change *where data goes*; everything else is a quantity or a schedule. Friction belongs where a misclick becomes an exfiltration. |

## Settings panel

### Settings panel

`lib/client.js` adds a **Backup & Sync** section, registered through
`ctx.slots.inject("settings.section", …)` with `id: "sync-backup"` and `inject: () => ({ rpcCall })`.
Transport is the official Connection RPC — no custom `/api` routes, no bundler, and the bundle only
ever does `require("react")`.

| Tab | Contents |
| --- | --- |
| Overview | health bar · run state · payload · **周期与保留 (editable)** · recovery code |
| Artifacts | local encrypted archives, remote copies per channel, prune action |
| Channels | controlled form: WebDAV enable/url/user/path, GitHub enable/repo/path |
| Environment | per-folder inventory with local sizes and risk badges · restore check |

Edit mode reads values straight from the host's `view` rather than a snapshot taken at mount, and only
the keys that actually changed are sent. Numeric inputs convert with `Number()` — the DOM always hands
back a string, and passing it through makes Save look inert.

## Tools (Host half)

### Tools (Host half)

| Tool | Behaviour |
| --- | --- |
| `sync_backup_run` | Defaults to dry-run: pack + verify, no network. `upload: true` uploads and verifies by reading back the SHA256; refused while `dryRun: true`. |
| `sync_backup_status` | Loaded state, last result, per-channel id/SHA256/retained count, effective settings, next planned run. |

> **Why tool outputs are built by omitting keys.** Host validates every tool return value twice, and the
> two gates disagree about absent data: `snapshotJsonValue` rejects `undefined` anywhere
> (`value is not lossless JSON`), while the declared schema rejects a `null` where an `object` or
> `string` is expected. **The only legal encoding of "no value" is an absent key.** This cost one
> real-Host failure that every offline suite had passed.

---

## 恢复与安全的实现要点（本仓库维护者补充）

以下几处是代码审查后加固的边界，改动它们前请先读对应测试：

| 位置 | 不变量 | 回归测试 |
| --- | --- | --- |
| `lib/keyring.js` | **只有 `ENOENT` 才生成新密钥**；文件存在但损坏/无权限一律抛 `KeyError` 并保留原文件。状态页走只读 `keyStatus()`，不产生写副作用。 | `crypto-smoke` 的「损坏的 key 抛错，且原文件一个字节都不动」等 8 条 |
| `lib/archive.js` | `parseTar` 严格校验 `size`（八进制/安全整数/数据与 padding 越界）、拒绝重复路径、限制条目数与解压总量；`openArchive` 给 `gunzipSync` 设 `maxOutputLength` 挡 gzip bomb。 | `security-smoke` 的 1.2 组 |
| `lib/restore-check.js` | 解包前校验每条路径；写盘前按**解析后的绝对路径**确认仍在临时根目录内；临时目录由自身 `try/finally` 兜底清理。 | `security-smoke` 的 1.2 组 |
| `lib/collect.js` | 白名单单文件用 `lstat` 拒绝链接；`readEntries` 复核 `realpath`，堵住路径**中段**是链接（如 junction）时的越界读取。 | `security-smoke` 的 1.3 组 |
| `lib/index-guard.js` | 远端索引里的路径是**数据不是指令**：只接受本插件会生成的确切文件名；索引不可信时**一个文件都不删**。 | `webdav-smoke` / `github-smoke` 的索引信任边界用例 |
| `lib/webdav.js` / `lib/github.js` | 保留策略是**先写新索引、再 best-effort 删除**。反过来一旦索引写失败就会留下指向已删对象的悬空索引。 | 两通道的「先写索引再删除」用例 |
| `index.js` | 所有运行入口（agent 工具 / GUI RPC / 定时器）统一经 `runExclusive()` 拿单次运行锁；`busy` 是可判定形状而不是静默失败。 | `channels-smoke` 的并发互斥用例 |
| `index.js` | 恢复自检用的 manifest 在**裁剪之后**重建（否则关掉 sessions 会稳定误报缺失）；自检失败置 `restoreCheckFailed` 并让该次运行判为未通过。 | `crypto-smoke` / `channels-smoke` |
| `lib/channels.js`（报告 8.3 拆分） | 上传块是**逐字迁移**，行为零变化；两条整体失败路径（无可用通道 / 全部失败）通过 `err.channels` 把逐通道结果带回 catch —— 拆分前 `result.channels` 在抛出前已赋值，失败详情必须仍进 `state.lastChannels` 与工具输出。 | `channels-smoke` 全 19 项（跑真实 apply()）+ `smoke` 118 项 |
| `index.js` (RPC) | `sync-backup.prune` / `sync-backup.restore-check` 整体走 `withRunLock`：备份打包期间**不允许**删产物或读半成品归档；`prune` 的状态快照在锁**外**取（锁内取会把这次 prune 自己标成 busy 回传）。`catalog-sizes` 刻意不持锁（只读源目录，持锁会让 GB 级扫描卡住备份排期）。 | `channels-smoke` [15]（hold 住 PUT 让锁被真实持有） |
| `lib/client.js` (recovery) | 恢复码明文要过**二次确认门**才向 host 请求（报告 3.4），显示后 60 秒（`RECOVERY_TTL_MS`）自动抹掉，离开概览页即清空；明文只活在 React state，绝不落 localStorage/日志。host 侧的授权边界是已认证的注入上下文 RPC 通道本身——本插件不伪造「host 校验用户手势」的能力。 | `client-smoke` 9.7 组 |
