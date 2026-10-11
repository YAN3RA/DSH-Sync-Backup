# DSH-Sync-Backup 详细功能说明

把 DSH 的**记忆层**打包成**加密归档**，留在本地并同步到 WebDAV 与 GitHub 私有仓库的纯插件实现：**白名单收集 · AES-256-GCM 加密 · 双通道上传 + 回读校验 · 本地保留策略 · 恢复前自检 · 四页签设置面板**——**零核心修改、零第三方运行时依赖**，随装随用、卸载即净。

> 安装与快速上手见 [README.md](README.md)。本文是完整功能说明：每项能力讲清「做什么、怎么实现、边界在哪、怎么验证」。

---

## 目录

- [这个插件是做什么的（30 秒了解）](#这个插件是做什么的30-秒了解)
- [备份范围（白名单）](#备份范围白名单)
- [加密与密钥](#加密与密钥)
- [双通道上传](#双通道上传)
- [保留策略与清理](#保留策略与清理)
- [恢复前自检](#恢复前自检)
- [设置面板（四页签）](#设置面板四页签)
- [AI 工具与提示词小节](#ai-工具与提示词小节)
- [配置项完整参考](#配置项完整参考)
- [安装](#安装)
- [凭据管理](#凭据管理)
- [安全设计](#安全设计)
- [工作原理](#工作原理)
- [版本方案](#版本方案)（权威说明见 [docs/VERSIONING.md](docs/VERSIONING.md)）
- [已知局限](#已知局限)
- [测试](#测试)
- [License](#license)

---

## 这个插件是做什么的（30 秒了解）

**它补的是官方备份插件没有覆盖的那一段**：`dsh-config-manager` 管配置，不管记忆。而 DSH 的记忆散在 `~/.dsh` 里——人格文件、长期记忆、技能、待办、定时任务、会话记录。

本插件把这些路径按**白名单**收集 → 打 tar → 加密 → 留在本地 + 上传两处，给你**一份本地 + 两份异地**的加密副本。

| 你会得到 | 怎么来的 |
| --- | --- |
| 加密的本地归档 | 每次运行落进 `$DSH_HOME/dsh-sync-backup/artifacts/`，按天数与份数自动清理 |
| 两份异地副本 | WebDAV 与 GitHub 私有仓库，同一份载荷、同一个 id，各自回读校验 |
| 一个定时器 | 本地打包周期与远端同步周期分离，失败自动退避 |
| 一个可视面板 | 四个页签管住全部行为，不用改 YAML |
| 两个 AI 工具 | `sync_backup_run` / `sync_backup_status` |
| 人类可读的状态 | 健康条给单一结论，细节可展开 |

**默认行为**：装上就只做**本地打包**。三个外传闸门（`dryRun: true`、`webdavEnabled`、`githubEnabled`）默认都是关的，要出网必须你亲自开。

---

## 备份范围（白名单）

源根 = `$DSH_HOME`（默认 `~/.dsh`）。这是**白名单，不是黑名单**——白名单之外的路径在结构上就不具备进入归档的能力。

| 路径 | 用途 | 是否可关 |
| --- | --- | --- |
| `AGENTS.md` | 全局指令 / 人格基线 | ❌ |
| `dsh-auto-memory.json` | 记忆插件配置 | ❌ |
| `memory/**` | **核心**：MEMORY.md / workspaces / hub / handoff / semantic | `semantic` 可关 |
| `skills/**` | 全部技能 | ❌ |
| `storages/**` | 含 `schedule.json` 定时任务 | ❌ |
| `task-board/**` | 待办账本 + 调度 | ❌ |
| `dsh-config-manager/sync/*.json` | **仅顶层 `*.json`** | ❌ |
| `sessions/**` | 会话记录 | `includeSessions` |

### ⚠️ 陷阱：绝不递归 `dsh-config-manager/sync/`

那个目录下存着几百个历史快照子目录。把它当 `dir` 条目列出来，载荷会膨胀约 **3 倍**（实测 423 个子目录 / 510 个文件 / 13,218,599 B）。正确做法是用 `kind: "glob"` + `pattern: /^[^\\/]+\.json$/` 只取顶层。

### 结构性排除（永不进归档）

- `.credentials.yaml` —— 明文凭据容器，**永不离开本机**；
- `profiles/**`（约 1.3 GiB）、`web-login/**`、`dsh-runtimes/**`、`models/**`、`speech-to-text/**`、`dsh-config-manager/exports/**`、`subagent-gc-backup/**`。

收集阶段还有一道**运行时兜底**：任何命中危险路径的条目会让本次运行直接中止（`归档命中危险路径，已中止`），而不是悄悄带上。

### 符号链接与 junction

白名单里的每一条都会 `lstat` + `realpath` 双重复核：

- **单文件**被换成链接 → 跳过，不收集；
- **路径中间段**是链接（Windows 上非管理员可建 junction，而 `Dirent.isSymbolicLink()` 对 junction 返回 true、`lstat` 返回 false）→ 用 `realpath` 复核是否仍在 `$DSH_HOME` 内，越界即跳过。

> 这不是理论风险：测试夹具真实抓到过 `sub/junction/f.txt` 顺着 junction 越界读取。

---

## 加密与密钥

**归档在落盘或出网之前，一律走 AES-256-GCM。明文从不写进磁盘。**

| 项 | 说明 |
| --- | --- |
| 算法 | AES-256-GCM（认证加密，密文被篡改会被检测到） |
| 密钥结构 | **信封加密**：真正的密钥（DEK）只以**密文**形态存在 `key.b64` 里，由两把独立的 KEK 分别包裹 |
| DEK 位置 | `$DSH_HOME/dsh-sync-backup/key.b64`（内含 `wrappedLocal` + `wrappedRecovery`，均为密文） |
| 本机 KEK | 交由 DSH 宿主凭据库保管，record key = `dsh-sync-backup/local-kek`（**不落盘到插件目录**） |
| 恢复码 | 编码一把**独立的随机恢复秘密**（不是 DEK 本身）；经 HKDF 派生恢复 KEK |
| 生成时机 | 首次运行时生成，**DEK 永不离开本机** |

### 密钥文件的严格契约

- **只有 `ENOENT` 才会生成新密钥**。文件存在但损坏 / 无权限 / 编码非法 → 一律抛 `KeyError` 并**保留原文件一个字节都不动**。
  > 这条是 P0 修复：旧行为会「自动生成新密钥」，等于在用户毫无察觉的情况下让所有历史归档永久不可解。
- **信封形态**：`{v:2, kdf:"hkdf-sha256", wrappedLocal:{…}, wrappedRecovery:{…,salt}}`。两份包裹用**不同的 AAD** 绑定用途，把 `wrappedLocal` 搬到 `wrappedRecovery` 位置会认证失败。
- **未知信封版本一律 fail closed**（`EKEYENVELOPEVERSION`），不猜着解。
- **本机 KEK 丢失 = `locked`，不是 `invalid`**：文件是好的，只是暂时解不开。此时**绝不生成新 KEK**（那会假装一切正常，而归档其实解不开了），面板提示改用恢复码导入。
- v3 的**明文 Base64 密钥会自动迁移**到信封结构：DEK 保持不变，所以**既有归档不需要重新加密**，仍然解得开。迁移会**更换恢复码**，必须在界面重新展示确认。
- 状态页走**只读** `keyStatus()`，不产生任何写副作用。

### 恢复码的显示契约

- 面板平时只显示**掩码**；
- 点「导出恢复码」先进**二次确认框**（`role="alertdialog"`，支持 Escape 取消）；
- 确认后明文只显示 **60 秒**（`RECOVERY_TTL_MS`），到期自动抹掉，**离开概览页也立刻清空**；
- 明文只活在 React state 里——**不进 localStorage、不进日志、不进 URL**。

> ⚠️ **恢复码不落盘，因此无法事后从磁盘重算**。信封里只存了由它派生出的恢复 KEK 密文。首次生成 / 迁移 / 更换时必须**一次性抄走**；丢了 = 归档全部不可解。

**威胁模型**：归档密钥走信封加密（DEK 只以密文存在），本机 KEK 由 DSH 宿主凭据库保管。但——**宿主的凭据存储本身是明文 YAML（权限 0600），不加密**。所以本机 KEK 带来的是**物理隔离**（KEK 与 `key.b64` 不再同一文件、同一目录），不是加密增益。因此：

- ✅ **加密保护的是归档离开本机之后**：网盘或仓库被人拿走，没有恢复码就打不开；
- ❌ **它不防能读你本机 `.dsh` 目录的人**：两处都读得到。

要更强的隔离，请把该目录排除出任何自动同步，并单独备份恢复码。面板的恢复码区域也用简明语言写了这条。

---

## 双通道上传

两个通道**使用同一份载荷、同一个归档 id**，但彼此完全独立。

### 归档 id

形如 `20261008-201530-ab12cd34`：本地时间 `YYYYMMDD-HHMMSS` + 8 位随机 hex，天然按时间排序。

### WebDAV 通道

- Basic 认证，口令只读**本插件自己的槽位**（不回退 config-manager 的槽位）；
- 目标解析：优先用插件配置的 `webdavUrl` / `webdavUsername`；留空才回退读 `$DSH_HOME/dsh-config-manager/sync/sync-config.json`；
- 路径逐段规范化 + `encodeURIComponent`（拒绝反斜杠、`?`、`#`、`%`、控制字符、空段、`.`、`..`）；
- **从不读 URL、不跟随重定向、不读状态文件**。

### GitHub 通道

- 走 contents API 写**私有仓库**，每次 4 个文件：归档本体 + `.manifest.json` + `latest.tar.gz` 稳定副本 + `index.json`；
- Bearer 认证，PAT 只读本插件槽位，缺失即整通道跳过（**不计半失败**）；
- `githubApiBaseUrl` 可改，用于 GitHub Enterprise 或测试假服务。

### 上传顺序契约

**先写归档与 manifest → 再写稳定副本 → 最后写索引 → 索引写成功后才 best-effort 删旧快照。**

反过来（先删后写）会留下指向已删对象的**悬空索引**；按这个顺序，中途崩溃至多留下无引用的**孤儿文件**，下一轮清理自动收掉。

### 索引是数据，不是指令

远端 `index.json` 里的路径**永远不被信任**：

- 只接受本插件会生成的确切文件名（正则 `/^\d{8}-\d{6}-[0-9a-f]{8}$/` 校验 id，再精确匹配文件名）；
- 条目还要校验 `createdAt` / `archiveBytes` / `archiveSha256` 的形状；
- **索引不可信时，一个文件都不删**——孤儿文件可以下轮再收，删错一个文件却不可逆。

> 这条挡的是「路径注入放大成远端任意删」。

### 回读才算成功

PUT 返回 2xx **不作数**。每个通道上传后立刻 GET 回来，比对**字节长度 + SHA256**，两者都对才记 `ok`。

### 半失败与告警

- 单通道失败**不中止**另一通道，结果里 `partial: true`；
- 连续 `partialAlertAfter`（默认 3）轮半失败 → `state.needsAttention = true`，概览页健康条转红；
- **整体失败也要看得见**：「没有任何可用通道」与「全部通道失败」两条路径会把逐通道结果附在错误上带回，最终仍进 `state.lastChannels` 与工具输出。

### 传输安全

**非本机 http 一律拒绝。** WebDAV 走 Basic、GitHub 走 Bearer，明文 HTTP 等于直接交出凭据。

- 只有 loopback（`127.0.0.1`、`[::1]`、`localhost`）自动放行 http；
- 内网私服等特殊场景需**显式**打开 `webdavAllowInsecureHttp` / `githubAllowInsecureHttp`（默认 false，界面会持续提示）；
- `isLoopbackHost` 不把 `localhost.evil.com`、`0.0.0.0`、越界八位组（如 `127.0.0.256`）当本机。

### 响应体大小上限

两个客户端都**不信 `Content-Length`**（可撒谎、分块时不存在），改为边收边累加，超过 `DEFAULT_MAX_RESPONSE_BYTES`（256 MB）立刻 `destroy` 并 reject。

---

## 保留策略与清理

### 本地

- 产物目录：`$DSH_HOME/dsh-sync-backup/artifacts/`；
- 两个独立条件，任一命中即删：年龄超过 `localKeepDays`（>0 才生效）、按时间排序后超出 `keepLast` 份的部分；
- **结构性兜底**：文件名必须匹配产物正则才可能被删——这同时挡住 `<id>.tar.gz.tmp-<hex>` 残留（临时文件由 `persist` 的 catch 清理）；
- 写产物用 **`tmp` + `rename`**：进程中断不会留下截断的半包。

### 远端

按通道各自的 `keepLast`（默认 7）裁剪，**无基于天数的远端清理**。

### 清理前先给数（报告 5.6）

「立即清理」是**两段式**，避免误删：

1. 点一下 → 先向服务端要**预览**（`preview: true`，**零删除、不持锁**——它只读目录）；
2. 有命中 → 按钮文案变成「**确认删除 N 份（X MB）**」，提示行同时给出保留数；
3. 再点一次 → 真删。

没有可清理项时直接给结论（`没有可清理的产物（共 N 份）`），不会逼你对一个什么都不做的按钮点两次。

预览与实际删除**共用同一段判定代码**（`lib/artifacts.js` 的 `planPrune`）——预览说删 2 份、实际删了 3 份，比不给预览更糟。回归测试专门钉住「预览数 == 实删数」。

### 清理与备份串行

维护页的「立即清理」和「恢复自检」都在服务端拿**同一把运行锁**：

- 备份进行中 → 明确返回 `busy`，不会「删着读」；
- `catalog-sizes`（体积统计）**刻意不持锁**——它只读源目录、不碰产物，为一次 GB 级扫描卡住备份排期得不偿失。

---

## 恢复前自检

两种粒度：

| 入口 | 行为 | 是否写盘 |
| --- | --- | --- |
| 每次打包后自动自检（`restoreCheck`，默认关） | 解密 → 解 tar → 逐条比 SHA256 与 manifest | ❌ 纯内存 |
| 维护页「运行恢复前自检」 | 解到系统临时目录做真实解包校验 | 解到临时目录，**验完立刻删除** |

安全性（存档解析侧）：

- `parseTar` 严格校验：`size` 必须是合法八进制/安全整数、`offset+size+padding` 越界即拒、**拒绝重复路径**、限制条目数与总解压量（gzip bomb 防护）；
- 每条路径都过 `checkArchivePath`（拒空/控制字符/绝对路径/盘符/UNC/`.`/`..`/空段）；
- 写盘前用 `resolveInside` 按**解析后的绝对路径**确认仍在临时根内（`/tmp/x` 与 `/tmp/xy` 这种兄弟目录也算越界）；
- 临时目录由自身 `try/finally` 兜底清理，写盘失败也清干净。

自检失败 → 本次运行判为未通过，并单独置 `restoreCheckFailed` 健康位。

---

## 设置面板（四页签）

`lib/client.js` 通过官方 `ctx.slots.inject("settings.section")` 注册「备份与同步」分区，走**官方 Connection RPC 通道**（无自定义 `/api` 路由、无打包器，客户端 bundle 只 `require("react")`）。

| 页签 | 内容 |
| --- | --- |
| **概览** | 健康条（单一结论）· 运行状态 · 载荷 · 周期与保留（可编辑）· 恢复码 |
| **产物文件** | 本地加密归档表格 · 远端副本摘要 · 立即清理 |
| **通道配置** | WebDAV / GitHub 的目标、开关、路径；「数据将发往哪里」摘要 |
| **环境和维护** | 备份集合勾选（带风险与体积）· 运行环境事实 · 恢复前自检 |

### 术语口径（报告 10.13）

同一件事只用同一个词：

| 术语 | 含义 |
| --- | --- |
| **归档** | 一次备份产生的加密包（用户视角的「我的备份」） |
| **产物** | 落在本地磁盘上的归档文件（磁盘视角） |
| **远端副本** | 已上传到某个通道的归档 |
| **本地备份 / 远端同步** | 两类动作：前者总是本地零网络，后者才出网 |
| **恢复自检** | `restore-check`（说「自检」时一律指它，不用「校验」） |

### 交互口径

- **编辑态读 host 的 `view`（唯一事实源）**，不是挂载时的快照；只发真正变了的键；
- 数字输入过 `Number()`（DOM 只给字符串，直接透传会让「保存」看起来没反应）；
- 改「数据发往哪里」（`webdavUrl` / `webdavUsername` / `githubRepo`）必须**二次确认**；通道开关从**关变开**也要确认（反向不拦——那是收紧）；
- **服务端为准，前端不推断健康状态**；前端不做加密、密钥生成、路径规范化等安全逻辑。

### 可访问性

- 页签条：`role="tablist"`，←/→ 循环、Home/End 跳首尾，**roving tabindex**（只有选中项可聚焦）；
- 每个页签带 `aria-controls` → 面板 `role="tabpanel"` `id="dsb-panel-<tab>"` 且 `aria-labelledby` 指回页签；
- 两个确认框：`role="alertdialog"` + `aria-modal` + **Escape 取消**；
- 窄窗口下页签条换行、面板 `min-width:0`、表格横向滚动。

---

## AI 工具与提示词小节

### `sync_backup_run`

立刻执行一次备份。

- **默认 dry-run**：只打包、核对清单与体积，**零网络**；
- `upload: true` 才真实上传（`config.dryRun` 为 true 时**拒绝**）；
- 单通道失败不中止另一通道，`partial: true` 表示半失败；
- 返回是**可判定形状**：`ok` / `busy` / `error` + `errorKind`。

### `sync_backup_status`

返回结构化状态 + 人可读文本：上次运行结果、各通道上次上传的 id/SHA256/保留份数、载荷体积、下次计划运行时刻、保留设置、半失败累计是否触发 `needsAttention`。

### 提示词小节

插件会注册一段说明（`promptSection`，默认开；`sectionOrder` 默认 30），让 AI 知道这两个工具存在、边界在哪。

### ⚠️ 工具返回值的「无值」编码

Host 会对工具返回值做两道校验，两者对「缺值」的处置相反：

1. **lossless JSON**：任意层级出现 `undefined` → 整个调用失败（`value is not lossless JSON`）；
2. **output.schema**：声明了类型的键若存在就必须匹配，`null` 不是 `object`/`string`。

**所以「无值」的唯一合法编码是「键缺席」**——既不能给 `undefined` 也不能给 `null`。离线冒烟用假 ctx 不过这两道门，只有真实 Host 才会暴露。

---

## 配置项完整参考

配置分层解析：`$DSH_HOME/dsh-sync-backup/config.json`（设置页写，最高）> `cordis.patch.yml`（出厂默认）> schema 默认值。合并用 `??` 而非 `||`——用 `||` 的话 `false` / `0` / `""` 与「未设置」无法区分。

| 键 | schema 默认 | patch 出厂值 | 说明 |
| --- | --- | --- | --- |
| `enabled` | `true` | `true` | 总开关。关掉不注册工具、不排期 |
| `intervalHours` | `12` | `12` | 本地打包周期（小时） |
| `remoteIntervalHours` | `0` | `0` | 远端同步周期。0 = 每次本地打包后立刻同步 |
| `startupMinIntervalMs` | `3600000` | 同 | 启动补跑阈值 |
| `maxBackoffHours` | `24` | `24` | 连续失败退避上限 |
| `keepLast` | `7` | `7` | 保留最近 N 份 |
| `partialAlertAfter` | `3` | `3` | 连续 N 轮半失败触发 `needsAttention` |
| `includeSessions` | `true` | `true` | 是否包含 `sessions/` |
| `includeSemantic` | `true` | `true` | 是否包含 `memory/semantic/` |
| `persistArchive` | `true` | **`false`** | 本地是否留加密归档（**注意两层不一致**） |
| `localKeepDays` | `7` | `7` | 本地产物保留天数 |
| `selectedPaths` | `[]` | `[]` | 勾选条目；空 = 默认集合（除 profiles 外全选） |
| `restoreCheck` | `false` | `false` | 打包后是否自动自检 |
| `dryRun` | `true` | `true` | **上传总闸门**，true 时拒绝一切 upload |
| `webdavEnabled` | `false` | **`true`** | WebDAV 开关（无目标即跳过，不算失败） |
| `webdavUrl` / `webdavUsername` | `""` | `""` | 目标；留空回退读 config-manager |
| `webdavPath` | `"dsh-backup/"` | 同 | 目标目录（相对 DAV 根） |
| `webdavCredentialRef` | `""` | `""` | 口令槽位名；空 = 本插件槽位 |
| `webdavTimeoutMs` | `300000` | 同 | 单次请求超时（ms） |
| `webdavAllowInsecureHttp` | `false` | `false` | 是否允许非本机明文 http |
| `githubEnabled` | `false` | （未列，取 schema） | GitHub 开关 |
| `githubRepo` | `""` | `""` | `owner/repo`，留空跳过该通道 |
| `githubPath` | `"dsh-backup/"` | 同 | 仓库内目录 |
| `githubCredentialRef` | `""` | `""` | PAT 槽位名 |
| `githubApiBaseUrl` | `""` | — | 留空用 `api.github.com` |
| `githubWriteLatest` | `true` | `true` | 是否写 `latest.tar.gz` |
| `githubBranch` | `""` | `""` | 留空用仓库默认分支 |
| `githubTimeoutMs` | `300000` | 同 | 单次请求超时（ms） |
| `githubAllowInsecureHttp` | `false` | `false` | 同 WebDAV |
| `dataDir` | `"dsh-sync-backup"` | 同 | 状态与产物目录（相对 `$DSH_HOME`） |
| `promptSection` | `true` | `true` | 是否注册提示词小节 |
| `sectionOrder` | `30` | `30` | 小节排序 |
| `schedulerEnabled` | `true` | `true` | 自排期开关 |
| `uploadOnSchedule` | `false` | `false` | 定时跑是否自动上传（**须同时** `dryRun: false`） |
| `startupRunOnBoot` | `true` | `true` | 启动是否允许补跑 |

> ⚠️ **注意 `persistArchive` 与 `webdavEnabled` 两层默认值不一致**——这正是「读有效值而不是假设」的理由。设置页概览显示的是**合并后**的有效值。

数值范围约束（`lib/user-config.js` 的 `NUMBER_BOUNDS`）：`intervalHours` 1–720 整数、`remoteIntervalHours` 0–720 整数、`keepLast` 1–1000 整数、`localKeepDays` 0–3650 整数。越界值在加载与保存两侧都会被丢弃并回落默认。

---

## 安装

### 安装方式与 spec 格式

插件页 / CLI 的 `add` 参数叫 **spec**，只接受四种写法：

| spec 类型 | 例 | 说明 |
| --- | --- | --- |
| **npm 包名** | `dsh-sync-backup` | 最省事；走 registry |
| **Git 地址** | `git+https://github.com/YAN3RA/DSH-Sync-Backup.git` | 需要本机 `git` 可用且能连通 |
| **压缩包** | `https://github.com/YAN3RA/DSH-Sync-Backup/archive/refs/tags/V1.5-261011.tar.gz` | **最可靠**：纯 HTTPS，不 spawn `git`、无需 SSH key |
| **本地路径** | `link:/path/to/dsh-sync-backup` | 开发用；改代码只需重启 |

> ⚠️ **网页 URL 不是合法 spec**。`https://github.com/用户/仓库/tree/main` 这种网页地址会被拒：
> `无法识别这个包名或地址：a URL must point at a git repository or a tarball`。
> 要「从 GitHub 装」就用上面的 **tarball** 或 **git+https** 形式。

> ⚠️ **别用 `github:用户/仓库` 简写**：pnpm 会把它解析为 SSH 地址 `git+ssh://git@github.com/...`，
> 本机无 SSH key 时报 `[EPERM] spawn EPERM`。

### 三种客户端

| 客户端 | 入口 | 备注 |
| --- | --- | --- |
| **桌面版**（官方 0.2.0-rc.2） | 侧栏「插件」→ 添加插件；或自带 CLI | profile 固定为 `desktop`，数据根 `~/.dsh` |
| **网页版 / CLI** | `dsh plugin --profile <profile> add <spec>` | 与桌面版同一套 spec |
| **本地 link** | `dsh plugin --profile desktop add link:<目录>` | 需声明 peerDependencies（见下） |

桌面版自带 CLI：`<程序目录>\resources\runtime\cli\bin\dsh.cmd`，**必须先完全退出桌面应用**。

### 标准安装

```sh
dsh plugin gate <插件目录或包地址>              # 安装前安全扫描（可选但推荐）
dsh plugin --profile desktop add dsh-sync-backup
# 或（不依赖 git / registry）
dsh plugin --profile desktop add https://github.com/YAN3RA/DSH-Sync-Backup/archive/refs/tags/V1.5-261011.tar.gz
# 完全退出并重启 DSH
```

### 装完不生效

- **必须完全退出并重启** DSH 才加载新的 JS 模块（只刷新浏览器不够）；
- 确认包名进了 profile：`~/.dsh/profiles/desktop/package.json` 的 `bundles`；
- 插件加载失败是**静默的**（stderr 只在 64 KB 内存环形缓冲，不落盘）；
- **升级要「先卸载再装新版」**（不支持自动更新）。

**link 安装的沙箱坑**：`link:` 安装会写 `$DSH_HOME/profiles/<profile>/`，在工作区沙箱下可能报 `EPERM ... package.json.lock`——那是**沙箱拒绝**，不是文件锁。

**pnpm 最小发布年龄拦截**：报 `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` 时，整个 lockfile 都在被策略检查，所以 24 小时内新增的**任何**依赖都会连带挡住这次安装。用 `--config.minimumReleaseAge=0` 清掉。

### 必须声明 peerDependencies

`link:` 安装是符号链接，所以 manifest **必须**在 `peerDependencies` 里列出 `@deepseek-ai/dsh-tools` 与 `@deepseek-ai/schemastery`，否则加载器不会拦截那两个裸 import——插件会**静默加载失败**（连状态目录都不会建）。改 manifest 只需重启，不用重装。

### 卸载

```sh
dsh plugin --profile desktop remove dsh-sync-backup
```

---

## 凭据管理

密钥**从不**存在 patch 文件里、本仓库里、或状态文件里。它们住在 DSH 的凭据层：`$DSH_HOME/.credentials.yaml` 的 `refs:` 块。

| 槽位 | 用途 | 回退 |
| --- | --- | --- |
| `DSH_SYNC_BACKUP_WEBDAV_PASSWORD` | WebDAV 口令 | **无**（刻意不回退 config-manager 的槽位） |
| `DSH_SYNC_BACKUP_GITHUB_TOKEN` | GitHub PAT | **无**（缺失即跳过该通道） |

> 为什么刻意不回退 config-manager 的槽位？借别人的专用密码，会让本插件的可用性绑在**另一个插件的配置**上；对方改密码或卸载，本插件会以一种很难归因的方式失败。代价是你要在本插件里录一次专用密码。

### 用自带的脚本录（推荐）

**绝不把令牌贴进命令行**——它会进 shell history 和进程表。用自带脚本，它支持环境变量或隐藏输入，写 `refs:` 块时会先备份再做原子替换：

```sh
# 隐藏交互输入——推荐；不回显、不进 history
node tools/set-webdav-password.mjs --verify
node tools/set-github-token.mjs --verify

# 或从你自己导出的环境变量读
$env:DSH_SYNC_BACKUP_GITHUB_TOKEN = "..."
node tools/set-github-token.mjs --from-env --verify
```

四个开关：`--check`（只读状态）、`--dry-run`（逐行预览）、`--verify`（证明能用）、`--remove`。

脚本只报值的**类型与长度**，从不报值本身。面板也从不渲染或存储口令——忘了就重跑一次脚本，没有任何代价。

### PAT 类型建议

**Fine-grained PAT（推荐）**：只授权单个仓库，权限只勾 **Contents: Read and write**，别的不勾。经典 PAT 需要 `repo` 范围。

---

## 安全设计

| 边界 | 做法 | 为什么 |
| --- | --- | --- |
| 密钥丢失 | 只有 `ENOENT` 才生成新密钥 | 否则一次权限异常就静默毁掉全部历史归档 |
| 归档解析 | 严格 region 校验 + 限流 + 拒重复路径 | 恶意归档不该能撑爆内存或越界写 |
| 路径穿越 | `resolveInside` 按解析后绝对路径判定 | 前缀比较能骗过天真实现（`/tmp/x` vs `/tmp/xy`） |
| 远端索引 | 只认本插件生成的确切文件名，不可信零删除 | 路径注入会放大成远端任意删 |
| 链接越界 | 白名单项 `lstat` + `realpath` 双查 | 只查最后一段时，中间段 junction 能越界读 |
| 明文凭据 | 非本机 http 一律拒 | Basic / Bearer 明文即等于交出凭据 |
| 响应体 | 不信 `Content-Length`，边收边限 | 长度头可撒谎，分块时还不存在 |
| 单次运行 | 全入口共用一把锁（host 编排层） | 层内加锁盖不住 agent 工具 / GUI / 定时器三条入口 |
| 上传成功 | 回读 SHA256 才算 | PUT 返回 2xx 不等于落盘正确 |
| 恢复码 | 二次确认 + 60s TTL + 离开页签清空 | 缩小明文在内存与屏幕上的暴露窗口 |

### 两项必须保留的安全亮点

1. **WebDAV 客户端从不读 URL、不跟随重定向、不读状态文件**；
2. **keyring 的 `inflight` 去重**（并发请求同一密钥时只算一次）。

---

## 工作原理

```
┌─ apply(ctx, config) ──────────────────────────────────────────┐
│  config 就地合并：mergeConfig(patch基线, config.json)          │
│  effectiveReady（promise）── 排期前先 await，避免按初值算排期   │
│                                                               │
│  runExclusive ──► withRunLock ──► runOnce                     │
│     ↑ 单次运行锁（agent 工具 / GUI RPC / 定时器 共用）           │
│                                                               │
│  runOnce:                                                     │
│   ① collect（白名单 + lstat/realpath 复核）                    │
│   ② buildArchive（手写 USTAR + gzip）                          │
│   ③ encryptBytes（AES-256-GCM）                                │
│   ④ persistArchive（tmp + rename）→ prune（本地保留）           │
│   ⑤ restoreCheck（纯内存校验，可选）                            │
│   ⑥ chans.uploadBoth（lib/channels.js：双通道 + 回读 + 聚合）    │
│   ⑦ saveState（失败也不影响 Host）                              │
│                                                               │
│  statusSnapshot ──► 工具输出 + GUI view（同一份事实）           │
│  mountRpc ──► GUI RPC 通道（始终本地操作）                      │
│  BackupScheduler ──► 自排期 + 失败退避                          │
└───────────────────────────────────────────────────────────────┘
```

模块地图与不变量见 [docs/architecture.md](docs/architecture.md)。

---

## 版本方案

版本号采用 **「主线号 + 推送日期」** 格式：`V<主>.<次>-<YYMMDD>`。

| 示例 | 含义 |
| --- | --- |
| `V1.0-261008` | 初版，2026-10-08 推送 |
| `V1.2-261011` | 第 2 次迭代，2026-10-11 推送 |
| `V1.3-261011` | 第 3 次迭代，2026-10-11 推送 |
| `V1.4-261011` | 第 4 次迭代，2026-10-11 推送 |
| `V1.5-261011` | 第 5 次迭代，2026-10-11 推送（P0 修复：启动竞态） |

- 主版本号重大架构变化时递增；次版本号**每次迭代十进制递增**；日期为该次发布的推送日期。
- `package.json` 的 `version` 保持 npm 合法 semver（`1.5.0` 对应 `V1.5-<date>`），日期只体现在 **git tag 与 Release** 上。
- Release 的 Assets 提供该版本的插件目录 zip：`dsh-sync-backup-V1.5-261011.zip`。

---

## 已知局限

- **`restore-check` 只验证，不恢复**。插件证明归档**能**被解密、解包、与 manifest 逐条对上，但**没有**写回 `$DSH_HOME`、也没有一键恢复。**自检通过 ≠ 灾难恢复演练完成**。手动恢复 = 找回恢复码 → 解密 → 自己解包。
- **密钥采用信封加密**。`key.b64` 里只有**密文**（DEK 由两把 KEK 分别包裹），本机 KEK 交由 DSH 宿主凭据库保管。但宿主凭据库本身是明文 YAML —— 所以本机 KEK 带来的是**物理隔离**（不再与密钥文件同目录），不是加密增益。把整个 `.dsh` 目录拷走，两处都会一起被拿走。加密保护的是**归档离开本机之后**，不防能读本机目录的人。
- **远端保留只按份数**（`keepLast`），没有基于天数的远端清理。
- **GitHub 通道的真实上传尚未验证**。测试里只对着假传输层跑（本地假服务，真 socket），没有对真实仓库做过一次 live 上传。
- **恢复码不落盘，无法事后重算**。信封里只存了由它派生的恢复 KEK 密文，恢复秘密本身不在磁盘上。丢掉 = 归档全部不可解；**首次生成 / 迁移 / 更换时必须一次性抄走**（面板届时会强制展示确认）。

---

## 测试

```sh
npm test              # 全部离线套件 + 全量 dry-run
npm run dry-run:full  # 全量打包 + 解包后逐文件 SHA256 比对
npm run security-smoke # 恶意归档 / 符号链接 / 密钥 / 索引夹具
npm run host-gates    # 需要 Electron-as-Node，见 docs/testing.md
```

覆盖口径、CI 跑什么、以及**刻意不进 CI** 的部分见 [docs/testing.md](docs/testing.md)。

---

## License

MIT —— 见 [LICENSE](LICENSE)。
