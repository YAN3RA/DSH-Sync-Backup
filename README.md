# DSH-Sync-Backup 使用指南

> **一句话**：把 DSH 的**记忆层**（记忆 / 技能 / 待办 / 会话 / 存储）打包成**加密归档**，留在本地并同步到 WebDAV 与 GitHub 私有仓库——**两条通道、两份可独立回读校验的副本，默认零外传**。
>
> 本指南按真实使用场景组织，每个场景讲「适合谁、能做什么、怎么用、会得到什么」。
>
> 相关文档：[详细功能说明](README-详细说明.md) · [架构与不变量](docs/architecture.md) · [测试与验收](docs/testing.md) · [版本号方案](docs/VERSIONING.md)

---

## 快速开始（安装）

插件包内自带 `cordis.patch.yml`（`dsh.bundle.patch` 声明），装好后 **host 端自动注册，无需手动改 profile**。

> ⚠️ **填地址时别填网页 URL。** 插件页只接受四种 **spec**：**npm 包名** / **Git 地址** / **压缩包（tarball URL 或本地 .tgz）** / **本地绝对路径**。
> 形如 `https://github.com/用户/仓库/tree/main` 的**网页地址不在其中**，会报
> `无法识别这个包名或地址：a URL must point at a git repository or a tarball`。
> 下面每种客户端都给了可直接粘贴的 spec。

### 插件页（桌面版 / 网页版通用）

侧栏 → **插件** → **添加插件** → 粘贴下面任意一行 → 安装 → **完全退出并重启** DSH。

```text
dsh-sync-backup
```
```text
https://github.com/YAN3RA/DSH-Sync-Backup/archive/refs/tags/V1.2-261011.tar.gz
```
```text
git+https://github.com/YAN3RA/DSH-Sync-Backup.git
```

**三种 spec 怎么选：**

| spec | 需要什么 | 适合谁 |
| --- | --- | --- |
| `dsh-sync-backup` | 已发布到 npm registry | **最省事**，装机首选 |
| `https://.../archive/refs/tags/<tag>.tar.gz` | 能访问 GitHub | **最可靠**：纯 HTTPS 下载，不调用 `git`、不需要 SSH key，也不受代理/网络策略影响 |
| `git+https://github.com/...` | 本机 `git` 可用且能连通 GitHub | 想跟随最新提交 |

> 📌 **公司网络 / 代理环境优先用 tarball 那行。** `git+` 形式需要 pnpm 能成功 spawn `git`；某些网络策略下会直接失败，而 tarball 只走 HTTPS。

> ⚠️ 别用 `github:用户/仓库` 简写——pnpm 会把它解析成 **SSH** 地址（`git+ssh://git@github.com/...`），本机没配 SSH key 时会报 `[EPERM] spawn EPERM`。

### 命令行（CLI / web 版）

```sh
dsh plugin --profile desktop add dsh-sync-backup
dsh plugin --profile desktop add https://github.com/YAN3RA/DSH-Sync-Backup/archive/refs/tags/V1.2-261011.tar.gz
dsh plugin --profile desktop add git+https://github.com/YAN3RA/DSH-Sync-Backup.git
```

桌面版自带 CLI 在 `<程序目录>\\resources\\runtime\\cli\\bin\\dsh.cmd`，**必须先完全退出桌面应用**再执行。

### 本地目录（开发用）

```sh
dsh plugin gate <插件目录>
dsh plugin --profile desktop add link:<插件目录>
```

> ⚠️ **不要再往 profile 的 `cordis.patch.yml` 手动 insert 本插件**：bundle patch 已自动注册，重复 insert 同一个 id 会让加载器报 duplicate loader entry id 而无法启动。

装好后打开 **设置 → 备份与同步**，会看到四个页签：**概览 / 产物文件 / 通道配置 / 环境和维护**。

**卸载 / 回滚**：`dsh plugin --profile desktop remove dsh-sync-backup`

**改默认配置**：在 profile 的 `cordis.patch.yml` 里用 id 覆盖（顶层写法，不是 insert）：

```yaml
- id: dsh-sync-backup
  config:
    intervalHours: 6        # 本地打包周期从 12h 改成 6h
```

**插件异常导致 DSH 起不来时临时禁用**（无需卸载）：

```yaml
- id: dsh-sync-backup
  disabled: true
```

---

## 认识它（30 秒）

装上之后你会多出：

- **一个设置分区**「备份与同步」，四个页签管住全部行为；
- **两个 AI 工具**：`sync_backup_run`（立刻跑一次）与 `sync_backup_status`（看状态）；
- **一段提示词小节**，让 AI 知道这些工具存在、边界在哪。

一句话概括：**你的 DSH 记忆层，从此有加密的本地副本 + 两份异地副本，而且默认什么都不往外发。**

> 小提示：三个「外传」闸门默认都是关的——`dryRun: true`、`webdavEnabled: false`（patch 置 true 但不填目标即跳过）、`githubEnabled: false`。**你必须主动填目标、开开关、再关 dryRun，才会真正出网。**

---

## 场景一：换电脑 / 重装 DSH，不再从零开始

**适合谁**：所有人。这是本插件的核心价值。

DSH 的记忆散在 `~/.dsh` 里：全局人格 `AGENTS.md`、长期记忆 `memory/`、技能 `skills/`、待办 `task-board/`、定时任务 `storages/schedule.json`、会话记录 `sessions/`。前面这些**官方备份插件（dsh-config-manager）并不覆盖**——它管的是配置，不管记忆。

本插件做的就是补上这一段：白名单收集这些路径 → 打成 tar → **AES-256-GCM 加密** → 留在本地 + 上传两处。

**怎么用**：

1. 装好插件，重启 DSH；
2. 打开「设置 → 备份与同步 → 通道配置」，填 WebDAV 或 GitHub 目标（或都填）；
3. 用插件自带的脚本录一次凭据（**不要**把口令写进配置文件）：
   ```sh
   node tools/set-webdav-password.mjs --verify
   node tools/set-github-token.mjs --verify
   ```
4. 把 `dryRun` 关掉，然后跑一次：`sync_backup_run(upload: true)`。

**会得到什么**：本地 `$DSH_HOME/dsh-sync-backup/artifacts/` 下有加密归档，远端有两份，每个通道都会**回读校验 SHA256**——PUT 返回 2xx 不算成功，读回来字节对得上才算。

---

## 场景二：定时自动备份，睡前不用管

**适合谁**：不想手动点、希望一直有兜底的人。

插件自带自排期定时器（`schedulerEnabled`，默认开）：

- **本地打包周期** `intervalHours`（默认 12 小时）；
- **远端同步周期** `remoteIntervalHours`（默认 0 = 每次本地打包后立刻同步；可以设成 24 实现「一天本地跑 4 次、远端只传 1 次」）；
- **启动补跑**：距上次成功超过 `startupMinIntervalMs`（默认 1 小时）就立即补一次；
- **失败退避**：连续失败时排期按倍数拉长，上限 `maxBackoffHours`（默认 24 小时）。

> ⚠️ **定时跑默认只做本地打包（零网络）**。要让它自动上传，必须**同时**满足 `uploadOnSchedule: true` **且** `dryRun: false`。两者都是写类动作，改之前请确认。

---

## 场景三：两份异地副本，一份坏了还有一份

**适合谁**：对「数据真的还在」有要求的人。

两个通道**使用同一份载荷、同一个归档 id**，但彼此独立：

- **WebDAV**：往你的网盘发（坚果云、自建等），走 Basic 认证；
- **GitHub**：走 contents API 写**私有仓库**，每次 4 个文件——归档本体 + manifest + `latest.tar.gz` 稳定副本 + `index.json` 索引。

**一个通道失败不会中止另一个**。结果里 `partial: true` 表示半失败；连续 `partialAlertAfter`（默认 3）轮半失败会把状态置为 `needsAttention`，概览页健康条变红提示你介入。

**安全边界**：

- **非本机 http 一律拒绝**。Basic 口令与 Bearer 令牌在明文 HTTP 下等于直接交出去。只有 loopback（`127.0.0.1` / `[::1]`）放行 http；真要用内网私服，得显式打开 `webdavAllowInsecureHttp`。
- **上传被两道闸门卡住**：`dryRun: true` 时 `upload: true` 直接被拒；放行后也必须是「凭据解析 → 目标解析 → MKCOL → PUT → 回读 SHA256」全对才算成功。
- **设置页本身不能上传**。它的端点全是本地操作，唯二「够得着外面」的是 `save-config`（写你自己的 config.json）和 `export-recovery-code`（把你的密钥交给你自己）。

---

## 场景四：只备份你想要的

**适合谁**：磁盘紧张，或者只想保关键东西的人。

「环境和维护」页里可以逐个勾选备份条目，每项都标了**风险等级**和**在本机的实际体积**：

| 条目 | 内容 | 风险 | 默认 |
| --- | --- | --- | --- |
| `persona` | 全局人格与行为指令 | 低 | ✅ |
| `memory-config` | 记忆插件配置 | 低 | ✅ |
| `memory` | 长期记忆（MEMORY.md / workspaces / hub / handoff / semantic） | 低 | ✅ |
| `skills` | 全部技能 | 低 | ✅ |
| `task-board` | 待办账本 | 中 | ✅ |
| `sync-config` | config-manager 的顶层 `*.json` | 中 | ✅ |
| `storages` | 含 `schedule.json` 定时任务 | 中 | ✅ |
| `sessions` | 会话记录（载荷主要来源，约 12 MB） | 高 | ✅ |
| `profiles` | 插件本体与依赖树（GB 级） | 高 | ❌ |

勾选结果空数组 = **用默认集合**（除 `profiles` 外全选）。界面里「一个都不选」是不可达状态——载荷不能为空。

---

## 场景五：不用改一行 YAML

**适合谁**：不想碰配置文件的人。

配置是**分层解析**的，优先级从高到低：

| 位置 | 谁来写 | 作用 |
| --- | --- | --- |
| `$DSH_HOME/dsh-sync-backup/config.json` | 设置页 | **本机覆盖**，保存即生效，不用重启 |
| `cordis.patch.yml` | 你 | **出厂默认**，加载时读一次，改了要重启 |
| schema 默认值 | 代码 | 兜底 |

设置页里改的任何值都写进 `config.json`。**想整体回到出厂状态，删掉那个文件即可，不用重装。**

> 所以文档里写「默认值」时，务必说清是哪一层的默认值——本插件的 README 一律标出「schema 默认 / patch 出厂值」。

---

## 场景六：出事之前的最后一次确认（恢复自检）

**适合谁**：想让「备份成功」这四个字更可信的人。

两种自检：

- **每次打包后自动自检**（`restoreCheck`，默认关）：解密 → 解 tar → 逐条比 SHA256 与 manifest，**纯内存**，不写盘；
- **维护页的「运行恢复前自检」**：解到系统临时目录做真实解包校验，**验完立刻删除**，绝不覆盖 `$DSH_HOME` 里任何现有文件。

自检失败会把本次运行判为未通过，并单独置一个 `restoreCheckFailed` 健康位（不会被混进普通错误里被忽略）。

> ⚠️ **自检通过 ≠ 灾难恢复演练完毕。** 本插件**没有**一键恢复到 `$DSH_HOME` 的写回功能（这是刻意的安全取舍）。真正的手动恢复是：找回恢复码 → 解密归档 → 自己解包。详见[详细功能说明](README-详细说明.md)「已知局限」。

---

## 场景七：磁盘不会无限膨胀

**适合谁**：长期开着定时备份的人。

- **本地**：产物保留 `localKeepDays` 天（默认 7），另受 `keepLast` 份数约束；产物文件页有「立即清理」，清理前可以先在「环境和维护」页看实际占用；
- **远端**：按 `keepLast`（默认 7）逐通道裁剪。

**清理与备份是串行的**：清理、恢复自检都会去拿和备份同一把运行锁，备份进行中会被明确拒绝（`busy`），而不会「删着读」。

> 顺序契约：**先写归档与 manifest → 再写稳定副本 → 最后写索引 → 索引写成功后才 best-effort 删旧**。反过来先删后写会留下指向已删对象的悬空索引；中途崩溃至多留下无引用的孤儿文件，下一轮清理自动收掉。

---

## 场景八：随时知道「上次到底成没成」

**适合谁**：要一个一眼结论的人。

- **AI 侧**：`sync_backup_status` 返回结构化状态 + 人可读文本；
- **面板侧**：概览页顶部一条**健康条**，单一结论——`attention`（半失败达阈值）> `fail` > `partial` > `running` > `never` > `ok`。

会告诉你：上次运行时间与耗时、载荷文件数与体积、压缩率、各通道上次上传的 id / SHA256 前 16 位 / 保留份数、下次计划运行时刻、半失败连续轮数、以及**数据将发往哪里**（含从 config-manager 继承来的目标，界面上不显示口令，只显示配没配）。

---

## 还有这些能力（一句话索引）

- **加密默认开启**：归档落盘或出网前一律走 AES-256-GCM，明文从不写进磁盘；
- **恢复码 = 密钥本身**（base32 编码），不是第二因子；面板只显掩码，点导出要过二次确认，明文 60 秒自动隐藏、离开页签即清空；
- **产物文件页**：本地加密归档列表（文件名 / 体积 / 时间）+ 远端副本摘要 + 立即清理；
- **通道配置页**：改「数据发往哪里」必须二次确认；开关从关变开也要确认（反向不拦）；
- **环境页**：逐条目本机体积统计、运行环境事实、备份集合的保存与恢复默认；
- **零第三方 npm 依赖**：只用 Node 内置模块；声明的两个 peerDependencies 由 harness 提供；
- **可访问性**：页签支持 ←/→/Home/End 键盘导航、roving tabindex、`aria-controls` ↔ `tabpanel`，确认框支持 Escape 取消。

---

## 发布版本

版本号采用 **「主线号 + 推送日期」** 格式：`V<主>.<次>-<YYMMDD>`。

| 示例 | 含义 |
| --- | --- |
| `V1.0-261008` | 初版（V1.0），2026-10-08 推送 |
| `V1.1-261115` | 第 1 次迭代，2026-11-15 推送 |
| `V1.2-261203` | 第 2 次迭代，2026-12-03 推送 |

- **主版本号**（`V1`）：重大架构变化时递增；
- **次版本号**（`.0` / `.1` / `.2`）：**每次迭代十进制递增**；
- **日期**（`261008`）：该次发布的**推送日期**（`YYMMDD`）。

`package.json` 的 `version` 保持 npm 合法的 semver 形式（`V1.2-261203` ↔ `1.2.0`），日期只体现在 **git tag** 与 Release 上。

**发版流程（开发者）**：

```sh
# 1. 提交并推送 main（tag 必须打在已推送的 main 提交上）
git push origin main

# 2. 打 annotated tag 并推送
git tag -a V1.1-261115 -m "发布说明：……"
git push origin V1.1-261115

# 3. 在 GitHub 建 Release，上传按版本打包的 zip 作为 Asset
```

**获取某个版本**：

```sh
git clone --depth 1 --branch V1.0-261008 https://github.com/YAN3RA/DSH-Sync-Backup.git
```

或用 Release 页面的 `dsh-sync-backup-V1.0-261008.zip`（即该 tag 下的插件目录打包）。

---

## 三条原则

1. **默认不外传**：装完就是「本地打包」，要出网必须你亲自填目标、开开关、关 dryRun 三道动作；
2. **回读才算成功**：PUT 返回 2xx 不作数，只有把字节读回来 SHA256 对得上，才记 `ok`；
3. **失败要看得见**：单通道失败不静默、不丢信息（落进 `channels`、进 `state.lastChannels`、进工具输出），整体失败也带回逐通道详情。

---

## 许可

MIT —— 见 [LICENSE](LICENSE)。
