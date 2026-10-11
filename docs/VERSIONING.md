# 版本号迭代方案

本文件是版本号的**唯一权威说明**。README 与 Release 页面均以此为准。

---

## 一、格式

```
V<主版本>.<次版本>-<推送日期>
    ↑          ↑        ↑
  重大变化   十进制递增   YYMMDD
```

| 示例 | 含义 |
| --- | --- |
| `V1.0-261008` | **初版**。`V1.0` = 初版版本号，`261008` = 2026-10-08 |
| `V1.1-261115` | 第 1 次迭代，2026-11-15 推送 |
| `V1.2-261203` | 第 2 次迭代，2026-12-03 推送 |
| `V1.9-261231` | 第 9 次迭代 |
| `V2.0-270110` | 主版本跃迁（重大架构变化），2027-01-10 |

### 三条规则

1. **主版本号**（`V1` → `V2`）：**重大架构变化**时递增，同时次版本号归零。日常迭代不动它。
2. **次版本号**（`.0` → `.1` → `.2`）：**每次推送迭代十进制递增**，逢十进一（`.9` 的下一个是 `V2.0`，或者按第 1 条判断是否够格升主版本）。
3. **日期**（`261008`）：该次发布的**推送日期**，`YYMMDD` 六位。**日期跟着实际推送日走**，不是开发完成日。

---

## 二、与 package.json 的关系

npm 只接受 [semver](https://semver.org/)，而 `V1.0-261008` 不是合法 semver。因此：

| 位置 | 值 | 角色 |
| --- | --- | --- |
| **git tag** | `V1.0-261008` | **发布标识**（权威，Release 也用它） |
| **GitHub Release** | `V1.0-261008` | 发布入口 + Assets |
| **`package.json.version`** | `1.0.0` | npm 兼容形式，供加载器与 `lib/version.js` 读 |

映射规则：`V<主>.<次>-<日期>` ↔ `<主>.<次>.0`。**日期不进 package.json**——它只体现在 tag 与 Release 上。

> 为什么不让 package.json 也用日期戳？因为它必须是合法 semver，否则 npm / pnpm 与加载器都会拒绝。用户可见的版本号始终是 tag，这一点在 README 里写清楚了。

`lib/version.js` 从 `package.json` 读一次并缓存，所有 User-Agent 与诊断信息取同一个值——不会出现「User-Agent 说 0.2.0、实际装的是 0.1.0」这种脏线索。

---

## 三、发版流程

```sh
# 0. 工作树必须干净，且已与 origin/main 同步
git status --short          # 应为空
git fetch origin && git rev-list --count origin/main..HEAD   # 应为 0

# 1. 改 package.json 的 version（如 1.0.0 → 1.1.0），提交并推送
#    注意：package.json 是 semver 形式，不带日期
git commit -am "chore: bump version for V1.1-261115"
git push origin main

# 2. 打 annotated tag（日期用**今天的推送日期**）
git tag -a V1.1-261115 -m "V1.1-261115 发布说明：……"
git push origin V1.1-261115

# 3. 建 Release，上传按版本打包的 zip
#    Asset 名：dsh-sync-backup-V1.1-261115.zip
#    内容：该 tag 下的插件目录（含 cordis.patch.yml / index.js / lib / tools / docs）
```

### Asset 打包口径

Asset 是**该 tag 下的插件目录**打包，用于「不装 git 也能拿到某一版」：

```sh
# 在仓库根目录执行（tag 已 checkout）
git archive --format=zip --prefix=dsh-sync-backup/ -o dsh-sync-backup-V1.0-261008.zip V1.0-261008
```

`git archive` 只打包受版本控制的文件，自动排除 `node_modules/`、`.tmp*` 等；`--prefix` 保证解压后是一个可直接 `dsh plugin add link:` 的目录。

---

## 四、获取某个版本

```sh
# 从 tag 克隆
git clone --depth 1 --branch V1.0-261008 https://github.com/YAN3RA/DSH-Sync-Backup.git

# 或从 Release 页面下载 dsh-sync-backup-V1.0-261008.zip
```

---

## 五、历史

| 版本 | 日期 | 说明 |
| --- | --- | --- |
| `V1.0-261008` | 2026-10-08 | 初版：数据安全底座（P0/P1 全部修复）+ 四页签面板 + 加密归档 + 双通道上传 |
| `V1.1-261011` | 2026-10-11 | 清理预览（destructive 先给数）· 术语统一 · 概览诊断折叠 · 恢复码区威胁模型说明 |
