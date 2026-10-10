// dsh-sync-backup — client half（source-as-product，无需构建）
//
// 在「设置 → 备份与同步」里放一个面板，四个子页面（tab）：
//   概览 / 产物文件 / 通道配置 / 环境和维护
//
// 设计口径：
//   - 只读展示 host 侧备份状态（view 结构化字段，不解析文本）；
//   - 「立即备份」按钮 → 触发一次**本地打包**（零网络）；真实出网不在 GUI 通道内暴露。
//   - 视觉与 config-manager 同源：容器/键值行/徽章/状态条一律对齐 --cm-* 语义 token
//     （间距 4px 网格、字号 11/12/12.5/13 阶梯、圆角 6-8px）。
//
// 通信走官方 Connection 一元 RPC（`ctx.connection.rpc.call(channel, endpoint, payload)`），
// 与 dsh-workspace-mover 同款：host 侧 `connection.rpc.handle("/sync-backup", dispatch)` 注册，
// 每个请求都由宿主统一过 Host/Origin 围栏 + 浏览器会话认证。
//
// 安全口径：本面板**没有任何上传入口**，也没有任何凭据回显控件（口令只写不读）。
// 真实出网只能由对话里的 agent 工具 `sync_backup_run(upload=true)` 触发，且要求 config.dryRun === false。
window.__ModuleLoader__.load({
	id: "dsh-sync-backup",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const React = require("react");
		const { useState, useEffect } = React;

		const CHANNEL = "/sync-backup";
		const STYLE_ID = "dsh-sync-backup-style";
		const h = (tag, props, ...children) => React.createElement(tag, props ?? null, ...children);

		const STRINGS = {
			zh: {
				sectionLabel: "备份与同步",
				title: "备份与同步",
				sub: "把配置与记忆打包成一份归档；上传是可选的，且只由对话触发。",

				// —— 通用 ——
				loading: "读取状态中…",
				refresh: "刷新",
				runNow: "立即备份",
				running: "正在打包…",
				done: "✓ 打包完成：{files} 个文件 → gzip {gz}",
				failed: "失败：{msg}",
				contextStale: "会话已失效，请刷新页面后重试。",
				unavailable: "宿主 RPC 通道不可用（插件可能尚未加载）。",
				empty: "—",
				never: "从未",
				on: "已启用",
				off: "已停用",
				okLabel: "成功",
				failLabel: "失败",
				copies: "份",
				files: "文件",
				unitMin: "分钟",
				unitHour: "小时",
				unitDay: "天",
				agoSuffix: "前",
				agoJustNow: "刚刚",
				agoMin: "{n} 分钟前",
				agoHour: "{n} 小时前",
				agoDay: "{n} 天前",
				durationLabel: "耗时",
				emptyHint: "暂无数据",

				// —— tab ——
				tabOverview: "概览",
				tabArtifacts: "产物文件",
				tabChannels: "通道配置",
				tabEnv: "环境和维护",

				// —— 健康档位 ——
				health: "当前状态",
				healthOk: "正常",
				healthFail: "上次失败",
				healthPartial: "半失败",
				healthAttention: "需要处理",
				healthRunning: "正在运行",
				healthNever: "从未运行",
				healthHint: "看这一行就够：绿色=正常，蓝=正在跑，黄=部分通道失败，红=上次失败或已到告警阈值。",
				busy: "备份进行中",

				// —— 概览：运行状态 ——
				groupRun: "运行状态",
				lastRun: "上次运行",
				lastRunResult: "上次结果",
				lastRunReason: "触发原因",
				runs: "累计运行",
				failures: "连续失败",
				nextRun: "下次计划运行",
				notScheduled: "未排期",
				lastError: "上次错误",
				lastErrorKind: "错误类型",

				// —— 概览：备份内容 ——
				groupPayload: "备份内容",
				payloadFiles: "文件数",
				payloadSource: "源体积",
				payloadGzip: "压缩后",
				payloadRatio: "压缩率",

				// —— 概览：备份数量 ——
				groupRetention: "备份数量",
				keepLast: "远端保留份数",
				localKeepDays: "本地保留天数",
				retentionNote: "控制保留多少份远端历史副本、以及本地归档留几天。",
				snippetTitle: "建议配置片段（可直接粘进 patch）",
				copySnippet: "复制片段",
				copied: "已复制片段",
				copyFailed: "复制失败，请手动选中下方文本复制",

				// —— 产物文件 ——
				artifactTitle: "本地产物",
				artifactName: "文件名",
				artifactSize: "体积",
				artifactMtime: "修改时间",
				artifactLocal: "本地",
				artifactsEmpty: "本地没有归档产物。",
				artifactsDisabled: "当前不在磁盘保留归档（persistArchive=false）",
				artifactsDisabledWhy: "磁盘上的归档谁都能读，缺省关闭。需要本地留档就在 patch 里把 persistArchive 改成 true。",
				artifactDir: "产物目录",
				pruneNow: "立即清理",
				pruning: "清理中…",
				pruned: "清理完成：移除 {n} 份，释放 {bytes}，保留 {kept} 份。",
				prunedNone: "清理完成：没有需要移除的产物。",
				remoteArtifacts: "远端产物",
				remoteWebdav: "WebDAV",
				remoteGithub: "GitHub",
				uploadId: "上次上传",
				shaPrefix: "SHA256",
				keptCopies: "保留",
				remotePath: "路径",
				githubEmpty: "未配置（通道跳过）",

				// —— 通道配置 ——
				channelTitle: "上传通道",
				dryRunWarn: "当前处于保护闸门状态（dryRun=true），任何上传都会被拒绝。",
				localInterval: "本地打包周期",
				remoteInterval: "远端同步周期",
				remoteIntervalZero: "每次打包后立刻同步",
				intervalConstraint: "约束：remoteIntervalHours=0 表示每次都同步；>0 时不得小于 intervalHours，否则按 intervalHours 对齐。",
				editWhere: "这两项改完立刻生效；想整体回到出厂默认，删掉插件的 config.json 即可。",
				webdavTitle: "WebDAV",
				githubTitle: "GitHub",
				webdavUrl: "服务地址",
				webdavUser: "用户名",
				webdavPath: "远端路径",
				webdavRef: "凭据引用",
				webdavState: "通道开关",
				webdavOff: "已禁用",
				webdavUrlEmpty: "未配置，请在 patch 的 webdavUrl 里填",
				passwordNote: "口令只写不读：本插件不回显已保存的专用密码，重置请用 tools/set-webdav-password.mjs。",
				githubRepo: "仓库",
				githubPath: "远端路径",
				githubRef: "凭据引用",
				githubWriteLatest: "写 latest 副本",
				patHint: "生成 PAT：打开 https://github.com/settings/tokens 新建 token，需要 repo 权限，且仓库必须为私有。",
				patLink: "打开 GitHub token 页",
				uploadHint: "上传说明：真实上传只能由对话里的 agent 工具触发（需 dryRun=false）。本面板只做本地打包与只读展示。",

				// —— 环境和维护：备份文件夹 ——
				catalogTitle: "备份文件夹选择",
				catalogNote: "勾选决定哪些内容进备份。改完点「保存」；「恢复默认」= 回到默认集合（除 profiles 外全选）。至少要留一项。",
				catalogUsingDefaults: "当前：默认集合（除 profiles 外全选）。勾选任意一项即可自定义。",
				catalogCustom: "当前：自定义集合（{n} 项已选）。",
				catalogResetBtn: "恢复默认",
				riskLabel: "风险",
				riskLow: "低风险",
				riskMedium: "中风险",
				riskHigh: "高风险",
				catalogStat: "本机 {files} 个文件 / {bytes}",
				catalogLoading: "正在统计本机体积…",
				catalogError: "体积统计失败：{msg}",
				catalogIdle: "未统计",
				recalcBtn: "重新统计体积",
				recalculating: "统计中…",

				// —— 环境和维护：运行环境 ——
				runtimeTitle: "插件运行环境",
				envDataDir: "数据目录",
				envStatePath: "状态文件",
				envInterval: "本地周期",
				envRemoteInterval: "远端周期",
				envScheduler: "定时器",
				envUploadOnSchedule: "定时上传",
				envUploadOnScheduleOff: "定时上传=关",
				envIncludeSessions: "含 sessions",
				envIncludeSemantic: "含 semantic",
				envRestoreCheck: "每次打包后自检",
				envPersistArchive: "本地留档",
				envEnabled: "插件总开关",
				envBackoff: "失败退避上限",
				envAlertAfter: "告警阈值",

				// —— 环境和维护：备份数据验证 ——
				verifyTitle: "备份数据验证",
				verifyBtn: "运行恢复前自检",
				verifying: "自检中…",
				verifyNote: "自检把归档解到临时目录验证能否还原，**不会写入或修改任何现有文件**。",
				verifySource: "样本",
				verifyResult: "结论",
				verifyOk: "可恢复",
				verifyFail: "不可恢复",
				verifyErrors: "错误",
				verifyWarnings: "警告",
				verifyStats: "统计",
				verifyEntries: "条目",
				verifyBytes: "字节",
				verifyForbidden: "越界路径",
				verifyLongPaths: "超长路径",
				verifyNone: "无",

				// —— v3：本页可直接改（不再手改 cordis.patch.yml）——
				edit: "编辑",
				cancel: "取消",
				save: "保存",
				saving: "保存中…",
				saveOk: "已保存 {n} 项改动。",
				saveNothing: "没有要保存的改动。",
				rejectedKeys: "这些键不允许在界面修改：{keys}",
				badNumber: "「{k}」需要非负数字，现在填的是「{v}」。",
				userConfigNote: "界面改动写进插件自己的 config.json，优先级高于 cordis.patch.yml；删掉该文件即回到默认值。",
				inlineEditHint: "不用去改 YAML 了：点「编辑」在本页直接改，改完即生效。",

				// 二次确认：改「备份发往哪里」必须再问一次
				remoteChangeTitle: "这会改变备份发往哪里",
				remoteChangeBody: "你改动了指向外部服务器的字段（{keys}）。保存后，之后的备份会发往新的目标。",
				remoteChangeYes: "确认，仍然保存",

				// —— 概览：周期与保留（可编辑）——
				groupSchedule: "周期与保留",
				editSchedule: "编辑周期与保留",
				masterSwitch: "启用定时备份",
				remoteZeroHint: "填 0 = 每次打包后立刻同步；大于 0 时不得小于本地周期，否则会被对齐到本地周期。",
				scheduleNote: "控制多久打一次包、保留多少份。",

				// —— 概览：恢复码 ——
				recoveryTitle: "恢复码",
				recoveryCurrent: "当前掩码",
				recoveryExport: "导出恢复码",
				recoveryExporting: "导出中…",
				recoveryOnlyOnce: "恢复码（只显示这一次）",
				recoveryWarn: "拿到它就等于拿到全部数据：请立刻抄到离线处保管。换机器或重装之后，没有它连本地归档也解不开。",
				recoveryCopy: "复制",
				recoveryCopied: "已复制到剪贴板",
				recoveryCopyFailed: "复制失败，请手动选中下方文本复制",
				recoveryHide: "隐藏",
				recoveryUnavailable: "当前没有可用的恢复码（host 读不到密钥），无法导出。",
				recoveryEncryptedNote: "归档默认加密，只有这把密钥能解开。",

				// —— 通道配置（可编辑）——
				channelFormNote: "控制压缩包发往哪里。改动 {n} 项后点保存。",
				channelEnableLabel: "启用这个通道",
				userPlaceholder: "登录用户名",
				repoPlaceholder: "owner/repo（仓库必须为私有）",
				pathPlaceholder: "dsh-backup/"
			},
			en: {
				sectionLabel: "Backup & Sync",
				title: "Backup & Sync",
				sub: "Packs config and memory into one archive; uploading is optional and only the conversation can trigger it.",

				loading: "Loading status…",
				refresh: "Refresh",
				runNow: "Back up now",
				running: "Packing…",
				done: "Packed: {files} files, gzip {gz}",
				failed: "Failed: {msg}",
				contextStale: "Session is stale, reload the page and try again.",
				unavailable: "Host RPC channel unavailable (plugin may not be loaded).",
				empty: "—",
				never: "never",
				on: "enabled",
				off: "disabled",
				okLabel: "ok",
				failLabel: "failed",
				copies: "copies",
				files: "files",
				unitMin: "min",
				unitHour: "h",
				unitDay: "d",
				agoSuffix: "ago",
				agoJustNow: "just now",
				agoMin: "{n} min ago",
				agoHour: "{n} h ago",
				agoDay: "{n} d ago",
				durationLabel: "Duration",
				emptyHint: "no data",

				tabOverview: "Overview",
				tabArtifacts: "Artifacts",
				tabChannels: "Channels",
				tabEnv: "Environment",

				health: "Status",
				healthOk: "healthy",
				healthFail: "last run failed",
				healthPartial: "partial failure",
				healthAttention: "needs attention",
				healthRunning: "running",
				healthNever: "never ran",
				healthHint: "This one line is enough: green = healthy, blue = running, amber = a channel failed, red = last run failed or the alert threshold was reached.",
				busy: "backup running",

				groupRun: "Run state",
				lastRun: "Last run",
				lastRunResult: "Last result",
				lastRunReason: "Trigger",
				runs: "Runs",
				failures: "Consecutive failures",
				nextRun: "Next scheduled run",
				notScheduled: "not scheduled",
				lastError: "Last error",
				lastErrorKind: "Error kind",

				groupPayload: "Payload",
				payloadFiles: "Files",
				payloadSource: "Source",
				payloadGzip: "Gzip",
				payloadRatio: "Ratio",

				groupRetention: "Retention",
				keepLast: "Remote copies kept",
				localKeepDays: "Local keep days",
				retentionNote: "How many remote historical copies to keep, and how many days local archives survive.",
				snippetTitle: "Suggested patch snippet",
				copySnippet: "Copy snippet",
				copied: "Snippet copied",
				copyFailed: "Copy failed — select the text below manually",

				artifactTitle: "Local artifacts",
				artifactName: "Name",
				artifactSize: "Size",
				artifactMtime: "Modified",
				artifactLocal: "local",
				artifactsEmpty: "No local archive artifacts.",
				artifactsDisabled: "Archives are not kept on disk (persistArchive=false)",
				artifactsDisabledWhy: "Anything on disk can be read by anyone, so this is off by default. Set persistArchive=true in the patch to keep local archives.",
				artifactDir: "Artifact dir",
				pruneNow: "Prune now",
				pruning: "Pruning…",
				pruned: "Pruned: removed {n}, freed {bytes}, kept {kept}.",
				prunedNone: "Pruned: nothing to remove.",
				remoteArtifacts: "Remote artifacts",
				remoteWebdav: "WebDAV",
				remoteGithub: "GitHub",
				uploadId: "Last upload",
				shaPrefix: "SHA256",
				keptCopies: "kept",
				remotePath: "path",
				githubEmpty: "not configured (channel skipped)",

				channelTitle: "Upload channels",
				dryRunWarn: "Protection gate is on (dryRun=true): every upload will be refused.",
				localInterval: "Local pack interval",
				remoteInterval: "Remote sync interval",
				remoteIntervalZero: "sync right after every pack",
				intervalConstraint: "Constraint: remoteIntervalHours=0 means sync every run; when >0 it must not be smaller than intervalHours, otherwise it is aligned to intervalHours.",
				editWhere: "Both take effect immediately. Delete the plugin's config.json to fall back to factory defaults.",
				webdavTitle: "WebDAV",
				githubTitle: "GitHub",
				webdavUrl: "URL",
				webdavUser: "Username",
				webdavPath: "Remote path",
				webdavRef: "Credential ref",
				webdavState: "Channel",
				webdavOff: "disabled",
				webdavUrlEmpty: "not configured, fill webdavUrl in the patch",
				passwordNote: "Write-only password: this plugin never echoes the stored dedicated password. To reset it use tools/set-webdav-password.mjs.",
				githubRepo: "Repo",
				githubPath: "Remote path",
				githubRef: "Credential ref",
				githubWriteLatest: "Write latest copy",
				patHint: "PAT: open https://github.com/settings/tokens and create a token with repo scope; the repository must be private.",
				patLink: "Open GitHub token page",
				uploadHint: "Uploads: only the agent tool in the conversation can upload for real (requires dryRun=false). This panel packs locally and displays read-only state.",

				catalogTitle: "Backup folder selection",
				catalogNote: "The checkboxes decide what goes into the backup. Press Save when done; Restore defaults goes back to the default set (everything but profiles). At least one item must stay selected.",
				catalogUsingDefaults: "Now: default set (everything except profiles). Tick any box to customise.",
				catalogCustom: "Now: custom set ({n} item(s) selected).",
				catalogResetBtn: "Restore defaults",
				riskLabel: "risk",
				riskLow: "low risk",
				riskMedium: "medium risk",
				riskHigh: "high risk",
				catalogStat: "{files} files / {bytes} on this machine",
				catalogLoading: "Measuring local size…",
				catalogError: "Size measurement failed: {msg}",
				catalogIdle: "not measured",
				recalcBtn: "Re-measure",
				recalculating: "Measuring…",

				runtimeTitle: "Runtime environment",
				envDataDir: "Data dir",
				envStatePath: "State file",
				envInterval: "Local interval",
				envRemoteInterval: "Remote interval",
				envScheduler: "Scheduler",
				envUploadOnSchedule: "Scheduled upload",
				envUploadOnScheduleOff: "scheduled upload=off",
				envIncludeSessions: "Sessions",
				envIncludeSemantic: "Semantic",
				envRestoreCheck: "Check after pack",
				envPersistArchive: "Local archives",
				envEnabled: "Plugin switch",
				envBackoff: "Max backoff",
				envAlertAfter: "Alert threshold",

				verifyTitle: "Backup verification",
				verifyBtn: "Run restore check",
				verifying: "Checking…",
				verifyNote: "The check extracts the archive into a temp dir to prove it can be restored. It never writes or modifies any existing file.",
				verifySource: "Sample",
				verifyResult: "Result",
				verifyOk: "restorable",
				verifyFail: "not restorable",
				verifyErrors: "Errors",
				verifyWarnings: "Warnings",
				verifyStats: "Stats",
				verifyEntries: "entries",
				verifyBytes: "bytes",
				verifyForbidden: "forbidden",
				verifyLongPaths: "long paths",
				verifyNone: "none",

				// v3: editable in place — no more hand-editing cordis.patch.yml
				edit: "Edit",
				cancel: "Cancel",
				save: "Save",
				saving: "Saving…",
				saveOk: "Saved {n} change(s).",
				saveNothing: "Nothing to save.",
				rejectedKeys: "These keys cannot be edited here: {keys}",
				badNumber: "{k} needs a non-negative number; you entered {v}.",
				userConfigNote: "Changes made here are written to the plugin's own config.json, which overrides cordis.patch.yml. Delete that file to fall back to defaults.",
				inlineEditHint: "No YAML needed: press Edit, change it here, and it takes effect right away.",

				// Second confirmation: redirecting where backups go must be confirmed
				remoteChangeTitle: "This changes where backups are sent",
				remoteChangeBody: "You edited fields that point at an external server ({keys}). After saving, future backups go to the new destination.",
				remoteChangeYes: "Save anyway",

				groupSchedule: "Schedule & retention",
				editSchedule: "Edit schedule & retention",
				masterSwitch: "Enable scheduled backup",
				remoteZeroHint: "0 means sync right after every pack; any larger value must not be below the local interval, otherwise it is raised to match.",
				scheduleNote: "How often to pack, and how many copies to keep.",

				recoveryTitle: "Recovery code",
				recoveryCurrent: "Masked",
				recoveryExport: "Export recovery code",
				recoveryExporting: "Exporting…",
				recoveryOnlyOnce: "Recovery code (shown once)",
				recoveryWarn: "Anyone holding this code holds all your data: copy it somewhere offline now. After moving to another machine or reinstalling, local archives cannot be opened without it.",
				recoveryCopy: "Copy",
				recoveryCopied: "Copied to clipboard",
				recoveryCopyFailed: "Copy failed — select the text below manually",
				recoveryHide: "Hide",
				recoveryUnavailable: "No recovery code is available (the host cannot read its key), so nothing can be exported.",
				recoveryEncryptedNote: "Archives are encrypted by default; only this key can open them.",

				channelFormNote: "Where the archive is sent. Press Save once you have {n} change(s).",
				channelEnableLabel: "Enable this channel",
				userPlaceholder: "login username",
				repoPlaceholder: "owner/repo (must be private)",
				pathPlaceholder: "dsh-backup/"
			}
		};

		const lang = (navigator.language || "en").toLowerCase().startsWith("zh") ? "zh" : "en";
		const t = (key, vars) => {
			let s = (STRINGS[lang] ?? STRINGS.en)[key] ?? key;
			if (vars) for (const k of Object.keys(vars)) s = s.split(`{${k}}`).join(String(vars[k]));
			return s;
		};

		// 标点也随语言走。中文版这里原本把全角括号、冒号、逗号**硬编码**在模板串里，
		// 于是英文界面会混进中文字符（一段纯英文里出现「（）」非常显眼）。
		// 渲染冒烟测试对此加了回归断言：英文渲染结果里不得出现任何 CJK 字符。
		const zhPunct = lang === "zh";
		const LP = zhPunct ? "（" : "(";
		const RP = zhPunct ? "）" : ")";
		const CL = zhPunct ? "：" : ": ";
		const CM = zhPunct ? "，" : ", ";
		const DOT = zhPunct ? "。" : ". ";

		const errMsg = (err) => {
			const raw = err?.message ?? String(err);
			// cordis 对已失活 fiber 一律拒绝，文案对用户没有意义，换成可操作提示。
			return /inactive context/i.test(raw) ? t("contextStale") : raw;
		};

		const fmtBytes = (n) => {
			const v = Number(n);
			if (!Number.isFinite(v) || v < 0) return t("empty");
			if (v < 1024) return `${v} B`;
			if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
			if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(2)} MB`;
			return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`;
		};

		const fmtTime = (iso) => {
			if (!iso) return t("never");
			const d = new Date(iso);
			return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
		};

		const fmtMtime = (ms) => {
			const v = Number(ms);
			if (!Number.isFinite(v) || v <= 0) return t("empty");
			return fmtTime(new Date(v).toISOString());
		};

		// 相对时间：排障时「3 分钟前」比 ISO 时间戳更快建立「新鲜度」直觉。
		// 回退到绝对时间，且任何非法输入都不得抛错（面板要能渲染残缺状态）。
		const fmtAgo = (iso, nowMs) => {
			if (!iso) return t("never");
			const ms = new Date(iso).getTime();
			if (Number.isNaN(ms)) return String(iso);
			const diff = Number.isFinite(nowMs) ? nowMs - ms : 0;
			if (diff < 0) return fmtTime(iso);
			const s = Math.floor(diff / 1000);
			if (s < 45) return t("agoJustNow");
			const m = Math.floor(s / 60);
			if (m < 60) return t("agoMin", { n: m });
			const hh = Math.floor(m / 60);
			if (hh < 48) return t("agoHour", { n: hh });
			return t("agoDay", { n: Math.floor(hh / 24) });
		};

		const fmtDuration = (ms) => {
			const v = Number(ms);
			if (!Number.isFinite(v) || v < 0) return t("empty");
			return v < 1000 ? `${v} ms` : `${(v / 1000).toFixed(1)} s`;
		};

		const fmtRatio = (r) => (Number.isFinite(r) ? `${(r * 100).toFixed(1)}%` : t("empty"));

		const fmtBool = (b, offText) => (b ? t("on") : offText ?? t("off"));

		function ensureStyle() {
			if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
			const style = document.createElement("style");
			style.id = STYLE_ID;
			// 样式一律消费宿主注入的 --cm-* 语义 token，并各自带一个中性兜底值：
			// 宿主没注入时（老内核 / 独立预览）仍能看清层级，不会变成一片纯色块。
			style.textContent = [
				".dsb-panel{max-width:820px;font-size:var(--cm-fs-base,12.5px);line-height:1.6;",
				"color:var(--cm-text-1,inherit);padding:var(--cm-sp-2,4px) 0}",
				".dsb-h1{font-size:var(--cm-fs-title,13px);font-weight:600;margin:0 0 var(--cm-sp-2,4px)}",
				".dsb-sub{margin:0 0 var(--cm-sp-6,12px);font-size:var(--cm-fs-table,12px);",
				"color:var(--cm-text-3,rgba(127,127,127,.9))}",
				// 标题行右侧放全局操作（刷新 / 立即备份）
				".dsb-head{display:flex;align-items:baseline;gap:var(--cm-sp-4,8px);flex-wrap:wrap}",
				".dsb-head .dsb-spacer{flex:1 1 auto}",

				// —— tab 条：与 config-manager 的分段控件同度量（24px 高、6px 圆角）——
				".dsb-tabs{display:inline-flex;align-items:center;gap:var(--cm-sp-1,2px);",
				"padding:var(--cm-sp-1,2px);margin:0 0 var(--cm-sp-5,10px);",
				"border:1px solid var(--cm-line-1,rgba(127,127,127,.28));",
				"border-radius:var(--cm-r-2,6px);background:var(--cm-surface-2,rgba(127,127,127,.08))}",
				".dsb-tab{appearance:none;border:none;background:none;color:var(--cm-text-3,rgba(127,127,127,.95));",
				"font:inherit;font-size:var(--cm-fs-table,12px);cursor:pointer;",
				"height:var(--cm-h-sm,24px);padding:0 var(--cm-sp-5,10px);border-radius:var(--cm-r-1,4px);",
				"transition:background-color var(--cm-motion-fast,120ms) ease,color var(--cm-motion-fast,120ms) ease}",
				".dsb-tab:hover{background:var(--cm-surface-hover,rgba(127,127,127,.14));color:var(--cm-text-2,inherit)}",
				".dsb-tab[aria-selected='true']{background:var(--cm-accent-fill,rgba(99,140,255,.16));",
				"color:var(--cm-accent,#638cff);font-weight:600}",

				// —— 卡片 ——
				".dsb-card{border:1px solid var(--cm-line-1,rgba(127,127,127,.28));",
				"border-radius:var(--cm-r-3,8px);background:var(--cm-surface-2,rgba(127,127,127,.06));",
				"padding:var(--cm-sp-6,12px);margin:0 0 var(--cm-sp-5,10px)}",
				".dsb-groupHeader{display:flex;align-items:baseline;gap:var(--cm-sp-4,8px);",
				"margin:0 0 var(--cm-sp-4,8px)}",
				".dsb-groupLabel{flex:none;white-space:nowrap;font-size:var(--cm-fs-meta,11px);font-weight:700;",
				"letter-spacing:.02em;color:var(--cm-text-3,rgba(127,127,127,.95));margin:0}",
				".dsb-groupNote{font-size:var(--cm-fs-meta,11px);color:var(--cm-text-3,rgba(127,127,127,.95));min-width:0}",

				// —— 键值行（对齐 .kvRow：88px 键宽、4px 上下留白、12px 字号）——
				".dsb-kvRow{display:flex;align-items:baseline;gap:var(--cm-sp-5,10px);",
				"padding:var(--cm-sp-2,4px) 0;font-size:var(--cm-fs-table,12px);min-width:0;",
				"border-bottom:1px solid color-mix(in srgb,var(--cm-line-1,rgba(127,127,127,.28)) 55%,transparent)}",
				".dsb-kvRow:last-child{border-bottom:none}",
				".dsb-kvKey{flex:none;width:88px;font-size:var(--cm-fs-meta,11px);",
				"color:var(--cm-text-3,rgba(127,127,127,.95))}",
				".dsb-kvValue{flex:1 1 auto;min-width:0;overflow-wrap:anywhere}",
				".dsb-kvValue.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;",
				"font-size:var(--cm-fs-table,12px)}",

				// —— 状态条（对齐 .statStrip：32px 单行、8px 圆角）——
				".dsb-health{display:flex;align-items:center;gap:var(--cm-sp-5,10px);",
				"min-height:var(--cm-h-lg,32px);padding:0 var(--cm-sp-6,12px);",
				"border:1px solid var(--cm-line-1,rgba(127,127,127,.28));",
				"border-radius:var(--cm-r-3,8px);background:var(--cm-surface-2,rgba(127,127,127,.06));",
				"margin:0 0 var(--cm-sp-4,8px);flex-wrap:wrap}",
				".dsb-health[data-tone='error']{border-color:color-mix(in srgb,var(--cm-error,#d24646) 45%,transparent);",
				"background:color-mix(in srgb,var(--cm-error,#d24646) 7%,transparent)}",
				".dsb-health[data-tone='warn']{border-color:color-mix(in srgb,var(--cm-warn,#d29628) 40%,transparent);",
				"background:color-mix(in srgb,var(--cm-warn,#d29628) 6%,transparent)}",
				".dsb-health[data-tone='ok']{border-color:color-mix(in srgb,var(--cm-ok,#2e9e57) 35%,transparent)}",
				".dsb-health[data-tone='info']{border-color:color-mix(in srgb,var(--cm-accent,#638cff) 40%,transparent)}",
				".dsb-dot{display:inline-block;width:7px;height:7px;border-radius:50%;flex:none;",
				"background:var(--cm-text-3,#9e9e9e);transition:background-color var(--cm-motion-fast,120ms) ease}",
				".dsb-dot[data-kind='ok']{background:var(--cm-ok,#2e9e57)}",
				".dsb-dot[data-kind='info']{background:var(--cm-accent,#638cff)}",
				".dsb-dot[data-kind='warn']{background:var(--cm-warn,#d29628)}",
				".dsb-dot[data-kind='error']{background:var(--cm-error,#d24646)}",
				".dsb-dot[data-pulse='1']{animation:dsbPulse 1.2s ease-in-out infinite}",
				"@keyframes dsbPulse{0%,100%{opacity:1}50%{opacity:.35}}",
				".dsb-healthTitle{font-size:var(--cm-fs-table,12px);font-weight:600;white-space:nowrap}",
				".dsb-healthDetail{font-size:var(--cm-fs-meta,11px);color:var(--cm-text-3,rgba(127,127,127,.95));",
				"min-width:0;overflow-wrap:anywhere}",

				// —— 指标段（对齐 .statSeg：12px 内边距、竖线分隔）——
				".dsb-statStrip{display:flex;align-items:stretch;flex-wrap:wrap;gap:0;",
				"border:1px solid var(--cm-line-1,rgba(127,127,127,.28));",
				"border-radius:var(--cm-r-3,8px);background:var(--cm-surface-2,rgba(127,127,127,.06))}",
				".dsb-statSeg{display:flex;align-items:center;gap:var(--cm-sp-3,6px);",
				"padding:var(--cm-sp-3,6px) var(--cm-sp-6,12px);font-size:var(--cm-fs-meta,11px);",
				"color:var(--cm-text-2,inherit);white-space:nowrap}",
				".dsb-statSeg+.dsb-statSeg{border-left:1px solid var(--cm-line-1,rgba(127,127,127,.28))}",
				".dsb-statSeg>span:first-child{color:var(--cm-text-3,rgba(127,127,127,.95))}",
				".dsb-statSeg b{font-size:var(--cm-fs-table,12px)}",

				// —— 徽章（对齐 .badge：18px 高、8px 圆角、11px 粗体）——
				".dsb-badge{display:inline-flex;align-items:center;gap:var(--cm-sp-2,4px);",
				"height:18px;padding:0 var(--cm-sp-3,6px);border-radius:var(--cm-r-3,8px);",
				"font-size:var(--cm-fs-meta,11px);font-weight:600;line-height:1.25;white-space:nowrap;",
				"border:1px solid var(--cm-line-2,rgba(127,127,127,.35));color:var(--cm-text-2,inherit)}",
				".dsb-badge[data-tone='ok']{border-color:color-mix(in srgb,var(--cm-ok,#2e9e57) 35%,transparent);",
				"background:color-mix(in srgb,var(--cm-ok,#2e9e57) 9%,transparent);color:var(--cm-ok,#2e9e57)}",
				".dsb-badge[data-tone='info']{border-color:color-mix(in srgb,var(--cm-accent,#638cff) 30%,transparent);",
				"background:color-mix(in srgb,var(--cm-accent,#638cff) 8%,transparent);color:var(--cm-accent,#638cff)}",
				".dsb-badge[data-tone='warn']{border-color:color-mix(in srgb,var(--cm-warn,#d29628) 40%,transparent);",
				"background:color-mix(in srgb,var(--cm-warn,#d29628) 9%,transparent);color:var(--cm-warn,#d29628)}",
				".dsb-badge[data-tone='error']{border-color:color-mix(in srgb,var(--cm-error,#d24646) 45%,transparent);",
				"background:color-mix(in srgb,var(--cm-error,#d24646) 9%,transparent);color:var(--cm-error,#d24646)}",
				".dsb-badge[data-source='local']{font-weight:700}",

				// —— 横幅（四态，紧凑）——
				".dsb-banner{display:flex;align-items:center;flex-wrap:wrap;gap:var(--cm-sp-3,6px) var(--cm-sp-5,10px);",
				"padding:var(--cm-sp-4,8px) var(--cm-sp-6,12px);border-radius:var(--cm-r-3,8px);",
				"border:1px solid var(--cm-line-2,rgba(127,127,127,.35));",
				"background:var(--cm-surface-2,rgba(127,127,127,.06));font-size:var(--cm-fs-base,12.5px);",
				"margin:0 0 var(--cm-sp-5,10px);width:100%;box-sizing:border-box}",
				".dsb-banner[data-kind='warn']{border-color:color-mix(in srgb,var(--cm-warn,#d29628) 45%,transparent);",
				"background:color-mix(in srgb,var(--cm-warn,#d29628) 10%,transparent);color:var(--cm-warn,#d29628)}",
				".dsb-banner[data-kind='error']{border-color:color-mix(in srgb,var(--cm-error,#d24646) 45%,transparent);",
				"background:color-mix(in srgb,var(--cm-error,#d24646) 8%,transparent);color:var(--cm-error,#d24646)}",
				".dsb-banner[data-kind='ok']{border-color:color-mix(in srgb,var(--cm-ok,#2e9e57) 40%,transparent);",
				"background:color-mix(in srgb,var(--cm-ok,#2e9e57) 9%,transparent);color:var(--cm-ok,#2e9e57)}",
				".dsb-banner[data-kind='info']{color:var(--cm-text-2,inherit)}",

				// —— 表格（产物列表）——
				".dsb-table{width:100%;border-collapse:collapse;font-size:var(--cm-fs-table,12px)}",
				".dsb-table th{text-align:left;font-size:var(--cm-fs-meta,11px);font-weight:700;",
				"color:var(--cm-text-3,rgba(127,127,127,.95));padding:var(--cm-sp-2,4px) var(--cm-sp-4,8px);",
				"border-bottom:1px solid var(--cm-line-1,rgba(127,127,127,.28));white-space:nowrap}",
				".dsb-table td{padding:var(--cm-sp-2,4px) var(--cm-sp-4,8px);",
				"border-bottom:1px solid color-mix(in srgb,var(--cm-line-1,rgba(127,127,127,.28)) 55%,transparent);",
				"overflow-wrap:anywhere;vertical-align:top}",
				".dsb-table tr:last-child td{border-bottom:none}",
				".dsb-table td.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}",

				// —— 条目清单（备份文件夹选择）——
				".dsb-item{display:flex;gap:var(--cm-sp-4,8px);align-items:flex-start;",
				"padding:var(--cm-sp-3,6px) 0;border-bottom:1px solid color-mix(in srgb,var(--cm-line-1,rgba(127,127,127,.28)) 55%,transparent)}",
				".dsb-item:last-child{border-bottom:none}",
				".dsb-item input[type='checkbox']{margin:3px 0 0;flex:none;",
				"accent-color:var(--cm-accent,#638cff);cursor:default}",
				".dsb-itemMain{flex:1 1 auto;min-width:0}",
				".dsb-itemTitle{display:flex;align-items:center;gap:var(--cm-sp-3,6px);flex-wrap:wrap;",
				"font-size:var(--cm-fs-table,12px);font-weight:600}",
				".dsb-itemIntro{font-size:var(--cm-fs-meta,11px);color:var(--cm-text-3,rgba(127,127,127,.95));",
				"margin-top:var(--cm-sp-1,2px)}",
				".dsb-itemStat{font-size:var(--cm-fs-meta,11px);color:var(--cm-text-2,inherit);margin-top:var(--cm-sp-1,2px)}",

				// —— 只读代码块（建议配置片段）——
				".dsb-code{margin:var(--cm-sp-3,6px) 0 0;padding:var(--cm-sp-4,8px) var(--cm-sp-5,10px);",
				"border:1px solid var(--cm-line-1,rgba(127,127,127,.28));border-radius:var(--cm-r-2,6px);",
				"background:var(--cm-input-bg,rgba(127,127,127,.08));",
				"font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;",
				"font-size:var(--cm-fs-table,12px);white-space:pre;overflow-x:auto;",
				"user-select:text;-webkit-user-select:text}",

				// —— 操作行与按钮 ——
				".dsb-actionRow{display:flex;align-items:center;gap:var(--cm-sp-4,8px);flex-wrap:wrap;",
				"margin:var(--cm-sp-5,10px) 0}",
				".dsb-btn{appearance:none;border:1px solid var(--cm-line-2,rgba(127,127,127,.42));",
				"background:transparent;color:inherit;border-radius:var(--cm-r-2,6px);",
				"padding:0 var(--cm-sp-6,12px);height:var(--cm-h-md,28px);",
				"font:inherit;font-size:var(--cm-fs-table,12px);cursor:pointer;",
				"transition:border-color var(--cm-motion-fast,120ms) ease,background-color var(--cm-motion-fast,120ms) ease}",
				".dsb-btn:hover:not(:disabled){border-color:var(--cm-accent,#638cff)}",
				".dsb-btn:disabled{opacity:.5;cursor:default}",
				".dsb-btn.primary{border-color:color-mix(in srgb,var(--cm-accent,#638cff) 55%,transparent);",
				"background:var(--cm-accent-fill,rgba(99,140,255,.14));color:var(--cm-accent,#638cff)}",
				".dsb-link{color:var(--cm-accent,#638cff);text-decoration:none;font-size:var(--cm-fs-table,12px)}",

				".dsb-hint{font-size:var(--cm-fs-meta,11px);color:var(--cm-text-3,rgba(127,127,127,.95));",
				"margin:var(--cm-sp-4,8px) 0 0;overflow-wrap:anywhere}",
				".dsb-note{margin:0 0 var(--cm-sp-5,10px);padding:var(--cm-sp-3,6px) var(--cm-sp-5,10px);",
				"border-radius:var(--cm-r-2,6px);font-size:var(--cm-fs-table,12px);white-space:pre-wrap;",
				"overflow-wrap:anywhere;border:1px solid var(--cm-line-2,rgba(127,127,127,.35));",
				"background:var(--cm-surface-2,rgba(127,127,127,.06))}",
				".dsb-note[data-tone='ok']{border-color:color-mix(in srgb,var(--cm-ok,#2e9e57) 40%,transparent);",
				"background:color-mix(in srgb,var(--cm-ok,#2e9e57) 9%,transparent)}",
				".dsb-note[data-tone='error']{border-color:color-mix(in srgb,var(--cm-error,#d24646) 45%,transparent);",
				"background:color-mix(in srgb,var(--cm-error,#d24646) 8%,transparent)}",
				".dsb-note[data-tone='warn']{border-color:color-mix(in srgb,var(--cm-warn,#d29628) 45%,transparent);",
				"background:color-mix(in srgb,var(--cm-warn,#d29628) 10%,transparent)}",
				".dsb-empty{padding:var(--cm-sp-5,10px) 0;font-size:var(--cm-fs-table,12px);",
				"color:var(--cm-text-3,rgba(127,127,127,.95))}"
			].join("");
			document.head.appendChild(style);
		}

		/* ---------------- 原子组件（全部无状态，便于测试直接展开） ---------------- */

		/** 键值行：键宽 88px，与 config-manager 的 .kvRow 同度量。 */
		function KV({ k, v, mono }) {
			return h("div", { className: "dsb-kvRow" },
				h("div", { className: "dsb-kvKey" }, k),
				h("div", { className: `dsb-kvValue${mono ? " mono" : ""}` }, v)
			);
		}

		/** 徽章：tone 决定语义色，source 用于「本地 / WebDAV / GitHub」来源区分。 */
		function Badge({ tone, source, text }) {
			const props = { className: "dsb-badge" };
			if (tone) props["data-tone"] = tone;
			if (source) props["data-source"] = source;
			return h("span", props, text);
		}

		/** 卡片：标题（groupLabel）+ 可选说明（groupNote）+ 可选右上动作 + 内容。 */
		function Card({ title, note, action, children }) {
			return h("div", { className: "dsb-card" },
				h("div", { className: "dsb-groupHeader" },
					h("div", { className: "dsb-groupLabel" }, title),
					note ? h("div", { className: "dsb-groupNote" }, note) : null,
					action ? h("div", { className: "dsb-cardAction" }, action) : null
				),
				children
			);
		}

		/** 横幅：四态提示条（warn / error / ok / info）。 */
		function Banner({ kind, children }) {
			return h("div", { className: "dsb-banner", "data-kind": kind ?? "info", role: "status" }, children);
		}

		/** 一组「标签 + 数值」的指标段，对齐 .statStrip / .statSeg。 */
		function StatStrip({ items }) {
			return h("div", { className: "dsb-statStrip" }, items.map((it, i) =>
				h("div", { className: "dsb-statSeg", key: `seg-${i}` },
					h("span", null, it.label),
					h("b", null, it.value)
				)
			));
		}

		// health 六档 → （语义色, 文案）。running 用 info（蓝），与「正在跑」这个状态匹配。
		const HEALTH_MAP = {
			ok: ["ok", "healthOk"],
			fail: ["error", "healthFail"],
			attention: ["error", "healthAttention"],
			partial: ["warn", "healthPartial"],
			running: ["info", "healthRunning"],
			never: ["", "healthNever"]
		};

		/** 顶部状态条：单一结论 + 细节。颜色由 health 决定，running 时圆点脉动。 */
		function HealthBar({ v }) {
			const [tone, labelKey] = HEALTH_MAP[v.health] ?? ["", "healthNever"];
			const bits = [fmtAgo(v.lastRunAt, Date.parse(v.now))];
			if (v.lastDurationMs != null) bits.push(`${t("durationLabel")} ${fmtDuration(v.lastDurationMs)}`);
			if (v.lastRunReason) bits.push(v.lastRunReason);
			if (v.lastError) bits.push(v.lastError);
			else if (v.lastPartial && v.partialStreak) bits.push(`${v.partialStreak} ${t("copies")}`);
			if (v.healthReason && !v.lastError) bits.push(String(v.healthReason));
			const dotProps = { className: "dsb-dot" };
			if (tone) dotProps["data-kind"] = tone;
			if (v.health === "running" || v.busy === true) dotProps["data-pulse"] = "1";
			const barProps = { className: "dsb-health" };
			if (tone) barProps["data-tone"] = tone;
			return h("div", barProps,
				h("span", dotProps),
				h("div", { className: "dsb-healthTitle" }, `${t("health")}${CL}${t(labelKey)}`),
				h("div", { className: "dsb-healthDetail" }, bits.filter(Boolean).join(" · ")),
				v.health === "running" || v.busy === true
					? h(Badge, { tone: "info", text: t("busy") })
					: null
			);
		}

		/** 保留设置的可复制片段：host 没有保存端点，所以给可直接粘进 patch 的文本。 */
		const patchSnippet = (v) => [
			"- insert:",
			"    - id: sync-backup",
			"      name: 'dsh-sync-backup'",
			"      config:",
			`        keepLast: ${v.keepLast ?? 7}`,
			`        localKeepDays: ${v.localKeepDays ?? 7}`
		].join("\n");

		/* ---------------- 四个子页面 ---------------- */

		/** 数字输入框的 value 必须是字符串：给 number 会让 React 受控警告并让清空变成 NaN。 */
		const numVal = (x) => (x === undefined || x === null || x === "" ? "" : String(x));

		/**
		 * 一张可编辑卡片的草稿状态。
		 *
		 * 「未发生」比「发生了但没人知道」更安全 —— 所以 draft 的重量必须跟 commit 相当。
		 * 少传一个字段，用户点保存时就以为改了那个值，其实它连 payload 都没进。
		 *
		 * @param {object} v 当前 view（宿主的唯一事实源）
		 * @param {string[]} keys 这张卡负责的键
		 * @param {(patch: object) => Promise<boolean>} commit 落盘；返回 true 表示成功（成功后关闭编辑态）
		 */
		function useDraft(v, keys, commit) {
			// 首帧（status 还没回来）v 是空对象，draft 若就此冻结会永远停在空值 ——
			// 面板会显示几个空白输入框，而 status 明明早就带着真值回来了。
			// 所以**编辑态之外一律直接读 view**：用户看到的值必须始终是宿主的当前值。
			const live = {};
			for (const k of keys) live[k] = v[k];
			const [on, setOn] = useState(false);
			const [saving, setSaving] = useState(false);
			const [draft, setDraft] = useState(live);
			const [json, setJson] = useState(JSON.stringify(live, Object.keys(live).sort()));
			const snapshot = () => JSON.stringify(draft, Object.keys(draft).sort());
			/** 只有真正变了的键进 payload：把整张卡都发出去，会把用户没碰过的东西也记录成「用户改过」。 */
			const changed = () => {
				const ini = JSON.parse(json), out = {};
				for (const k of Object.keys(draft)) if (JSON.stringify(draft[k]) !== JSON.stringify(ini[k])) out[k] = draft[k];
				return out;
			};
			const save = async () => {
				if (saving) return;
				setSaving(true);
				try {
					const ok = await commit(changed());
					if (ok) setOn(false);
				} finally { setSaving(false); }
			};
			return {
				// 非编辑态直接透传 view：值永远跟着宿主走，不存在「渲染时的快照」
				on, saving,
				draft: on ? draft : live,
				dirty: on ? snapshot() !== json : false,
				open: () => { setDraft(live); setJson(JSON.stringify(live, Object.keys(live).sort())); setOn(true); },
				close: () => setOn(false),
				set: (k, x) => setDraft((d) => ({ ...d, [k]: x })),
				changed, save
			};
		}

		/** 概览页「周期与保留」这张卡负责的键。 */
		const SCHED_KEYS = ["enabled", "keepLast", "localKeepDays", "intervalHours", "remoteIntervalHours", "restoreCheck"];
		/** 通道页负责的键（口令不在此列：它只能由终端写入）。 */
		const CHANNEL_KEYS = ["webdavEnabled", "webdavUrl", "webdavUsername", "webdavPath", "githubEnabled", "githubRepo", "githubPath"];
		/** 改了就等于「换地方放备份」的键 —— 保存前必须二次确认。 */
		const REMOTE_KEYS = ["webdavUrl", "webdavUsername", "githubRepo"];
		/**
		 * 通道总开关。**只在 false → true 时**要求确认。
		 *
		 * 报告 5.2：关掉通道是「停止外传」，没有任何风险，不该被确认框拦住；
		 * 打开通道才是「以后会把数据发出去」这个不可逆意图的起点。所以要判方向，
		 * 不能把这两个键丢进 REMOTE_KEYS 一刀切 —— 那样关通道也会弹框，用户点几次
		 * 就会养成无脑确认的习惯，确认框也就失效了。
		 */
		const CHANNEL_SWITCH_KEYS = ["webdavEnabled", "githubEnabled"];

		/**
		 * 带二次确认的草稿。
		 *
		 * 只对 REMOTE_KEYS 生效：开关个 permet 份数写错顶多丢一次 Sohn team building；
		 * 而地址写错意味着**把整个家备份的内容发到了别人的服务器上**，且可能几周后才发现。
		 * 二次确认的成本是一次点击，漏确认的代价不可逆，因此只在这类键上加。
		 */
		function useConfirmDraft(v, keys, commit) {
			const base = useDraft(v, keys, commit);
			const [pending, setPending] = useState(null);
			return {
				...base,
				pending,
				requestSave: () => {
					const ch = base.changed();
					const hit = Object.keys(ch).filter((k) => REMOTE_KEYS.includes(k));
					// 通道从「关」变「开」也要确认：它会改变今后是否外传。
					// 反向（开→关）不确认 —— 那是收紧，不该被拦。
					for (const k of CHANNEL_SWITCH_KEYS) {
						if (Object.prototype.hasOwnProperty.call(ch, k) && ch[k] === true) hit.push(k);
					}
					if (hit.length > 0) { setPending(hit); return; }
					void base.save();
				},
				confirmSave: () => { setPending(null); void base.save(); },
				cancelPending: () => setPending(null)
			};
		}

		/** 二次确认：改「备份发往哪里」必须再问一次。 */
		function ConfirmBlock({ keys, onYes, onNo }) {
			return h("div", { className: "dsb-confirm", role: "alertdialog" },
				h("div", { className: "dsb-confirmTitle" }, t("remoteChangeTitle")),
				h("div", { className: "dsb-confirmBody" }, t("remoteChangeBody", { keys })),
				h("div", { className: "dsb-actionRow" },
					h("button", { type: "button", className: "dsb-btn primary", onClick: () => { void onYes(); } }, t("remoteChangeYes")),
					h("button", { type: "button", className: "dsb-btn", onClick: onNo }, t("cancel"))
				)
			);
		}

		/* ---------------- 四个子页面 ---------------- */

		/** 概览：健康条 → 运行状态 → 备份内容 → 周期与保留（可编辑）→ 恢复码。 */
		function OverviewTab({ v, dSch, dRc }) {
			const p = v.lastPayload ?? null;
			// host 的 view 里没有「恢复码不可用」这个布尔位，只有 maskRecoveryCode()
			// 的兜底串 "(未设置)"，所以能否导出必须由掩码反推，不能指望一个不存在的字段。
			const rcMasked = String(v.recoveryCodeMasked ?? "");
			const rcUnavailable = rcMasked.length === 0 || rcMasked === t("empty") || rcMasked.includes("(未设置)");
			return [
				h(HealthBar, { v, key: "hb" }),
				h("div", { className: "dsb-hint", key: "hh" }, t("healthHint")),
				h(Card, { title: t("groupRun"), key: "run" },
					KV({ k: t("lastRun"), v: v.lastRunAt ? `${fmtTime(v.lastRunAt)}${LP}${fmtAgo(v.lastRunAt, Date.parse(v.now))}${RP}` : t("never") }),
					KV({
						k: t("lastRunResult"),
						v: v.lastRunOk === true ? t("okLabel") : v.lastRunOk === false ? t("failLabel") : t("empty")
					}),
					KV({ k: t("lastRunReason"), v: v.lastRunReason || t("empty") }),
					KV({ k: t("durationLabel"), v: fmtDuration(v.lastDurationMs) }),
					KV({ k: t("runs"), v: `${v.runs ?? 0}` }),
					KV({ k: t("failures"), v: `${v.failures ?? 0}` }),
					KV({ k: t("nextRun"), v: v.nextRunAt ? fmtTime(v.nextRunAt) : t("notScheduled") }),
					v.lastError ? KV({ k: t("lastError"), v: String(v.lastError) }) : null,
					v.lastErrorKind ? KV({ k: t("lastErrorKind"), v: String(v.lastErrorKind) }) : null
				),
				h(Card, { title: t("groupPayload"), key: "payload" },
					h(StatStrip, {
						items: [
							{ label: t("payloadFiles"), value: p ? String(p.fileCount) : t("empty") },
							{ label: t("payloadSource"), value: p ? fmtBytes(p.sourceBytes) : t("empty") },
							{ label: t("payloadGzip"), value: p ? fmtBytes(p.gzBytes) : t("empty") },
							{ label: t("payloadRatio"), value: p ? fmtRatio(p.ratio) : t("empty") }
						]
					})
				),
				h(Card, {
					title: t("groupSchedule"), note: t("scheduleNote"), key: "sched",
					action: dSch.on ? null : h("button", { type: "button", className: "dsb-btn", onClick: dSch.open }, t("editSchedule"))
				},
					dSch.on
						? [
							h("label", { className: "dsb-field", key: "f-en" },
								h("span", { className: "dsb-fieldLabel" }, t("masterSwitch")),
								h("input", {
									type: "checkbox", checked: dSch.draft.enabled === true,
									onChange: (e) => dSch.set("enabled", e.target.checked === true)
								})
							),
							h("label", { className: "dsb-field", key: "f-kl" },
								h("span", { className: "dsb-fieldLabel" }, t("keepLast")),
								h("input", {
									// 输入框给的一定是字符串；原样塞进去会让 host 的形状校验把整个保存请求拒掉。
									// 空串按「清空」处理，落到 0 —— 让用户能表达「不保留」。
									type: "number", min: "1", step: "1", value: numVal(dSch.draft.keepLast),
									onChange: (e) => dSch.set("keepLast", e.target.value === "" ? 0 : Number(e.target.value))
								})
							),
							h("label", { className: "dsb-field", key: "f-ld" },
								h("span", { className: "dsb-fieldLabel" }, t("localKeepDays")),
								h("input", {
									type: "number", min: "0", step: "1", value: numVal(dSch.draft.localKeepDays),
									onChange: (e) => dSch.set("localKeepDays", e.target.value === "" ? 0 : Number(e.target.value))
								})
							),
							h("label", { className: "dsb-field", key: "f-iv" },
								h("span", { className: "dsb-fieldLabel" }, t("localInterval")),
								h("input", {
									type: "number", min: "1", step: "1", value: numVal(dSch.draft.intervalHours),
									onChange: (e) => dSch.set("intervalHours", e.target.value === "" ? 0 : Number(e.target.value))
								})
							),
							h("label", { className: "dsb-field", key: "f-ri" },
								h("span", { className: "dsb-fieldLabel" }, t("remoteInterval")),
								h("input", {
									type: "number", min: "0", step: "1", value: numVal(dSch.draft.remoteIntervalHours),
									onChange: (e) => dSch.set("remoteIntervalHours", e.target.value === "" ? 0 : Number(e.target.value))
								})
							),
							h("div", { className: "dsb-hint", key: "rzh" }, t("remoteZeroHint")),
							h("label", { className: "dsb-field", key: "f-rc" },
								h("span", { className: "dsb-fieldLabel" }, t("envRestoreCheck")),
								h("input", {
									type: "checkbox", checked: dSch.draft.restoreCheck === true,
									onChange: (e) => dSch.set("restoreCheck", e.target.checked === true)
								})
							),
							h("div", { className: "dsb-hint", key: "ucn" }, t("userConfigNote")),
							h("div", { className: "dsb-actionRow", key: "ar" },
								h("button", { type: "button", className: "dsb-btn primary", onClick: () => dSch.save() }, dSch.saving ? t("saving") : t("save")),
								h("button", { type: "button", className: "dsb-btn", onClick: () => dSch.close() }, t("cancel"))
							)
						]
						: [
							KV({ k: t("masterSwitch"), v: fmtBool(v.enabled) }),
							KV({ k: t("keepLast"), v: `${v.keepLast ?? t("empty")} ${t("copies")}` }),
							KV({ k: t("localKeepDays"), v: `${v.localKeepDays ?? t("empty")} ${t("unitDay")}` }),
							KV({ k: t("localInterval"), v: `${v.intervalHours ?? t("empty")} ${t("unitHour")}` }),
							KV({ k: t("remoteInterval"), v: Number(v.remoteIntervalHours) === 0 ? t("remoteIntervalZero") : `${v.remoteIntervalHours} ${t("unitHour")}` }),
							KV({ k: t("envRestoreCheck"), v: fmtBool(v.restoreCheck) }),
							h("div", { className: "dsb-hint" }, t("inlineEditHint"))
						]
				),
				h(Card, { title: t("recoveryTitle"), note: t("recoveryEncryptedNote"), key: "rec" },
					KV({ k: t("recoveryCurrent"), v: rcMasked || t("empty"), mono: true }),
					dRc.code
						? h("div", { className: "dsb-recovery" },
							h("div", { className: "dsb-groupLabel" }, t("recoveryOnlyOnce")),
							h("pre", { className: "dsb-code", "data-severity": "warn" }, dRc.code),
							h(Banner, { kind: "warn" }, t("recoveryWarn")),
							h("div", { className: "dsb-actionRow" },
								h("button", { type: "button", className: "dsb-btn", onClick: () => dRc.copy() }, dRc.copyNote || t("recoveryCopy")),
								h("button", { type: "button", className: "dsb-btn", onClick: () => dRc.hide() }, t("recoveryHide"))
							)
						)
						: rcUnavailable
							? h("div", { className: "dsb-hint" }, t("recoveryUnavailable"))
							: h("div", { className: "dsb-actionRow" },
								h("button", {
									type: "button", className: "dsb-btn",
									disabled: dRc.busy,
									onClick: () => dRc.export()
								}, dRc.busy ? t("recoveryExporting") : t("recoveryExport"))
							)
				)
			];
		}

		/** 产物文件：本地表格 + 远端摘要 + 清理按钮。 */
		function ArtifactsTab({ v, onPrune, op }) {
			const art = v.artifacts ?? {};
			const items = Array.isArray(art.items) ? art.items : [];
			const u = v.lastUpload ?? null;
			const disabled = art.enabled === false;
			const rows = items.map((it) =>
				h("tr", { key: `art-${it.name}` },
					h("td", { className: "mono" }, it.name),
					h("td", null, fmtBytes(it.bytes)),
					h("td", null, fmtMtime(it.mtimeMs)),
					h("td", null, h(Badge, { source: "local", text: t("artifactLocal") }))
				)
			);
			return [
				disabled ? h(Banner, { kind: "warn", key: "off" },
					t("artifactsDisabled"),
					h("span", { key: "why" }, t("artifactsDisabledWhy"))
				) : null,
				h(Card, { title: t("artifactTitle"), key: "local" },
					items.length === 0
						? h("div", { className: "dsb-empty" }, t("artifactsEmpty"))
						: h("table", { className: "dsb-table" },
							h("thead", null, h("tr", null,
								h("th", null, t("artifactName")),
								h("th", null, t("artifactSize")),
								h("th", null, t("artifactMtime")),
								h("th", null, t("artifactLocal"))
							)),
							h("tbody", null, rows)
						),
					h("div", { className: "dsb-hint" }, `${t("artifactDir")}${CL}${art.dir || t("empty")}`)
				),
				h(Card, { title: t("remoteArtifacts"), key: "remote" },
					h("div", { className: "dsb-kvRow" },
						h("div", { className: "dsb-kvKey" }, h(Badge, { source: "webdav", text: t("remoteWebdav") })),
						h("div", { className: "dsb-kvValue" },
							`${t("remotePath")}${CL}${v.webdavPath || t("empty")}${CM}${t("keepLast")}${CL}${v.keepLast ?? t("empty")} ${t("copies")}`
						)
					),
					h("div", { className: "dsb-kvRow" },
						h("div", { className: "dsb-kvKey" }, h(Badge, { source: "github", text: t("remoteGithub") })),
						h("div", { className: "dsb-kvValue" },
							`${v.githubRepo ? `${v.githubRepo}${CM}${t("remotePath")}${CL}${v.githubPath || t("empty")}` : t("githubEmpty")}${CM}${t("keepLast")}${CL}${v.keepLast ?? t("empty")} ${t("copies")}`
						)
					),
					KV({ k: t("uploadId"), v: u ? `${u.id}${CM}${t("shaPrefix")} ${String(u.sha256 ?? "").slice(0, 16)}${CM}${t("keptCopies")} ${u.kept ?? t("empty")} ${t("copies")}` : t("empty"), mono: true })
				),
				h("div", { className: "dsb-actionRow", key: "prune" },
					h("button", {
						type: "button",
						className: "dsb-btn",
						// 报告 5.3：备份运行中禁用（服务端 prune 也已纳入同一把锁做权威重验）
						disabled: op !== null || v.busy === true,
						onClick: () => { void onPrune(); }
					}, op === "prune" ? t("pruning") : t("pruneNow"))
				)
			];
		}

		/** 通道配置：周期说明 + WebDAV 卡 + GitHub 卡（凭据只显示引用名）。 */
		function ChannelsTab({ v, dCh, pending }) {
			const dv = dCh.draft;
			return [
				v.dryRun ? h(Banner, { kind: "error", key: "dry" }, t("dryRunWarn")) : null,
				h("div", { className: "dsb-hint", key: "note" }, t("channelFormNote", { n: Object.keys(dCh.changed()).length })),
				h(Card, {
					title: t("webdavTitle"), key: "wd",
					action: h("label", { className: "dsb-switch" },
						h("span", null, t("channelEnableLabel")),
						h("input", {
							type: "checkbox", checked: dv.webdavEnabled === true,
							onChange: (e) => dCh.set("webdavEnabled", e.target.checked === true)
						})
					)
				},
					h("label", { className: "dsb-field", key: "f-url" },
						h("span", { className: "dsb-fieldLabel" }, t("webdavUrl")),
						h("input", {
							type: "text", value: dv.webdavUrl ?? "", placeholder: "https://dav.example.com/dav/",
							onChange: (e) => dCh.set("webdavUrl", e.target.value)
						})
					),
					h("label", { className: "dsb-field", key: "f-user" },
						h("span", { className: "dsb-fieldLabel" }, t("webdavUser")),
						h("input", {
							type: "text", value: dv.webdavUsername ?? "", placeholder: t("userPlaceholder"),
							onChange: (e) => dCh.set("webdavUsername", e.target.value)
						})
					),
					h("label", { className: "dsb-field", key: "f-path" },
						h("span", { className: "dsb-fieldLabel" }, t("webdavPath")),
						h("input", {
							type: "text", value: dv.webdavPath ?? "", placeholder: t("pathPlaceholder"),
							onChange: (e) => dCh.set("webdavPath", e.target.value)
						})
					),
					KV({ k: t("webdavRef"), v: v.webdavRef || t("empty"), mono: true }),
					h("div", { className: "dsb-hint" }, t("passwordNote"))
				),
				h(Card, {
					title: t("githubTitle"), key: "gh",
					action: h("label", { className: "dsb-switch" },
						h("span", null, t("channelEnableLabel")),
						h("input", {
							type: "checkbox", checked: dv.githubEnabled === true,
							onChange: (e) => dCh.set("githubEnabled", e.target.checked === true)
						})
					)
				},
					h("label", { className: "dsb-field", key: "f-repo" },
						h("span", { className: "dsb-fieldLabel" }, t("githubRepo")),
						h("input", {
							type: "text", value: dv.githubRepo ?? "", placeholder: t("repoPlaceholder"),
							onChange: (e) => dCh.set("githubRepo", e.target.value)
						})
					),
					h("label", { className: "dsb-field", key: "f-gp" },
						h("span", { className: "dsb-fieldLabel" }, t("githubPath")),
						h("input", {
							type: "text", value: dv.githubPath ?? "", placeholder: t("pathPlaceholder"),
							onChange: (e) => dCh.set("githubPath", e.target.value)
						})
					),
					KV({ k: t("githubRef"), v: v.githubRef || t("empty"), mono: true }),
					h("div", { className: "dsb-hint" }, t("patHint")),
					h("div", { className: "dsb-actionRow" },
						h("a", { className: "dsb-link", href: "https://github.com/settings/tokens", target: "_blank", rel: "noreferrer" }, t("patLink"))
					)
				),
				pending
					? h(ConfirmBlock, {
						key: "confirm",
						keys: pending.join(CM + " "),
						onYes: () => dCh.confirmSave(pending),
						onNo: () => dCh.cancelPending()
					})
					: null,
				h("div", { className: "dsb-actionRow", key: "save" },
					h("button", {
						type: "button", className: "dsb-btn primary", disabled: dCh.saving,
						onClick: () => dCh.requestSave()
					}, dCh.saving ? t("saving") : t("save"))
				),
				h("div", { className: "dsb-hint", key: "ucn" }, t("userConfigNote")),
				h("div", { className: "dsb-hint", key: "up" }, t("uploadHint"))
			];
		}

		const RISK_TONE = { low: "ok", medium: "warn", high: "error" };
		const RISK_TEXT = { low: "riskLow", medium: "riskMedium", high: "riskHigh" };

		/**
		 * 备份文件夹选择：**可编辑**。
		 *
		 * 语义陷阱（报告 4.2）：`selectedPaths: []` 表示「用默认集合」，所以空数组
		 * 不能同时表示「一个都不选」—— 两者编码相同。解法是把「跟随默认」做成一个
		 * **显式状态**：只要用户动过任何一个勾选框，就落到具体 id 列表（至少留一个）；
		 * 「恢复默认」按钮把它清回 `[]`。这样两种意图在界面上各有各的入口，
		 * 不需要升级 schema 也不会互相冒充。
		 *
		 * @param {object} p
		 * @param {(ids: string[]) => void} p.onChange 草稿回调；传 [] = 恢复默认集合
		 */
		function CatalogList({ v, sizes, sizesState, draft, onChange }) {
			const catalog = Array.isArray(v.catalog) ? v.catalog : [];
			// 有效选择：草稿优先（用户正在编辑），否则用已保存值
			const saved = Array.isArray(v.selectedPaths) ? v.selectedPaths : [];
			const current = draft !== undefined ? draft : saved;
			const usingDefaults = current.length === 0;
			if (catalog.length === 0) return h("div", { className: "dsb-empty" }, t("emptyHint"));
			return [
				h("div", { className: "dsb-hint", key: "catmode" },
					usingDefaults ? t("catalogUsingDefaults") : t("catalogCustom", { n: current.length })
				),
				...catalog.map((e) => {
					// 空列表 = 默认集合（除 defaultOn=false 外全选）
					const on = !usingDefaults ? current.includes(e.id) : e.defaultOn !== false;
					const size = sizes?.[e.id] ?? null;
					/** 从当前状态算出勾选后的 id 列表。 */
					const toggle = () => {
						const base = usingDefaults
							? catalog.filter((x) => x.defaultOn !== false).map((x) => x.id)
							: current.slice();
						const next = on ? base.filter((id) => id !== e.id) : [...new Set([...base, e.id])];
						// 「一个都不选」是无效状态：备份至少要收一样东西，否则载荷恒为空。
						// 这里直接拦住并提示，比允许保存后在备份时才发现要好。
						if (next.length === 0) return;
						onChange?.(next);
					};
					return h("div", { className: "dsb-item", key: `cat-${e.id}` },
						h("input", {
							type: "checkbox",
							checked: !!on,
							disabled: typeof onChange !== "function",
							readOnly: typeof onChange !== "function",
							onChange: toggle
						}),
					h("div", { className: "dsb-itemMain" },
						h("div", { className: "dsb-itemTitle" },
							h("span", null, e.id),
							h(Badge, { tone: RISK_TONE[e.risk] ?? null, text: t(RISK_TEXT[e.risk] ?? "riskLow") })
						),
						// intro 由 host 下发双语（见 lib/collect.js 的 CATALOG），按界面语言选一边。
						// 别在浏览器里做机器翻译 —— 一句话的介绍译错了比不译更糟。
						h("div", { className: "dsb-itemIntro" }, (lang === "zh" ? (e.intro || e.introEn) : (e.introEn || e.intro)) || ""),
						sizesState === "error"
							? h("div", { className: "dsb-itemStat" }, t("catalogError", { msg: String(sizes?.__error ?? "") }))
							: size
								? h("div", { className: "dsb-itemStat" }, t("catalogStat", { files: size.fileCount, bytes: fmtBytes(size.bytes) }))
								: h("div", { className: "dsb-itemStat" }, sizesState === "loading" ? t("catalogLoading") : t("catalogIdle"))
					)
				);
				})
			];
		}

		/** 环境和维护：备份文件夹选择 → 运行环境 → 备份数据验证。 */
		function EnvTab({ v, sizes, sizesState, onRecalc, onRestoreCheck, check, op, catDraft, onCatChange, onCatSave, onCatReset }) {
			const st = check?.stats ?? null;
			const list = (arr, key) => (Array.isArray(arr) && arr.length > 0
				? arr.map((x, i) => h("div", { key: `${key}-${i}` }, `· ${String(x)}`))
				: h("div", { key: `${key}-none` }, t("verifyNone")));
			const catDirty = catDraft !== undefined;
			return [
				h(Card, { title: t("catalogTitle"), note: t("catalogNote"), key: "cat" },
					h(CatalogList, { v, sizes, sizesState, draft: catDraft, onChange: onCatChange }),
					h("div", { className: "dsb-actionRow" },
						h("button", {
							type: "button",
							className: "dsb-btn primary",
							// 备份运行中不允许改集合：下一次运行读的会是改到一半的配置
							disabled: !catDirty || op !== null || v.busy === true,
							onClick: () => { void onCatSave?.(); }
						}, t("save")),
						// 「恢复默认」总是可用：它就是「把集合交回默认」这个动作本身
						h("button", {
							type: "button",
							className: "dsb-btn",
							disabled: op !== null || v.busy === true,
							onClick: () => { void onCatReset?.(); }
						}, t("catalogResetBtn")),
						h("button", {
							type: "button",
							className: "dsb-btn",
							// 报告 5.3：备份进行中不发起本机体积扫描（catalog-sizes 是只读，服务端不持锁，
							// 但在打包期间扫 GB 级目录只会加剧争用）
							disabled: op !== null || v.busy === true,
							onClick: () => { void onRecalc(); }
						}, op === "catalog" ? t("recalculating") : t("recalcBtn"))
					)
				),
				h(Card, { title: t("runtimeTitle"), key: "env" },
					KV({ k: t("envDataDir"), v: v.dataDir || t("empty"), mono: true }),
					KV({ k: t("envStatePath"), v: v.statePath || t("empty"), mono: true }),
					KV({ k: t("envInterval"), v: `${v.intervalHours ?? t("empty")} ${t("unitHour")}` }),
					KV({ k: t("envRemoteInterval"), v: Number(v.remoteIntervalHours) === 0 ? t("remoteIntervalZero") : `${v.remoteIntervalHours} ${t("unitHour")}` }),
					KV({ k: t("envScheduler"), v: fmtBool(v.schedulerEnabled) }),
					KV({ k: t("envUploadOnSchedule"), v: v.uploadOnSchedule ? t("on") : t("envUploadOnScheduleOff") }),
					KV({ k: t("envIncludeSessions"), v: fmtBool(v.includeSessions) }),
					KV({ k: t("envIncludeSemantic"), v: fmtBool(v.includeSemantic) }),
					KV({ k: t("envRestoreCheck"), v: fmtBool(v.restoreCheck) }),
					KV({ k: t("envPersistArchive"), v: fmtBool(v.persistArchive) }),
					KV({ k: t("envEnabled"), v: fmtBool(v.enabled) }),
					KV({ k: t("envBackoff"), v: `${v.maxBackoffHours ?? t("empty")} ${t("unitHour")}` }),
					KV({ k: t("envAlertAfter"), v: `${v.partialAlertAfter ?? t("empty")} ${t("copies")}` })
				),
				h(Card, { title: t("verifyTitle"), key: "verify" },
					h("div", { className: "dsb-hint" }, t("verifyNote")),
					check ? [
						KV({ k: t("verifySource"), v: check.source || t("empty"), mono: true }),
						KV({
							k: t("verifyResult"),
							v: check.ok
								? h(Badge, { tone: "ok", text: t("verifyOk") })
								: h(Badge, { tone: "error", text: t("verifyFail") })
						}),
						KV({ k: t("verifyErrors"), v: list(check.errors, "err") }),
						KV({ k: t("verifyWarnings"), v: list(check.warnings, "warn") }),
						st ? KV({
							k: t("verifyStats"),
							v: `${t("verifyEntries")} ${st.entries ?? 0}${CM}${t("verifyBytes")} ${fmtBytes(st.bytes)}${CM}${t("verifyForbidden")} ${st.forbidden ?? 0}${CM}${t("verifyLongPaths")} ${st.longPaths ?? 0}`
						}) : null
					] : null,
					h("div", { className: "dsb-actionRow" },
						h("button", {
							type: "button",
							className: "dsb-btn",
							// 报告 5.3：自检读产物/现打包，备份运行中禁用（服务端同样持锁重验）
							disabled: op !== null || v.busy === true,
							onClick: () => { void onRestoreCheck(); }
						}, op === "restore" ? t("verifying") : t("verifyBtn"))
					)
				)
			];
		}

		const TABS = ["overview", "artifacts", "channels", "env"];
		const TAB_LABEL = { overview: "tabOverview", artifacts: "tabArtifacts", channels: "tabChannels", env: "tabEnv" };

		function SyncBackupSection({ rpcCall }) {
			const [view, setView] = useState(null);         // host 的 view（唯一事实源）
			const [note, setNote] = useState("");           // 全局提示文案
			const [tone, setTone] = useState("info");       // info | ok | warn | error
			const [busy, setBusy] = useState(false);        // 立即备份进行中
			const [ready, setReady] = useState(false);      // 首次状态已到达
			const [tab, setTab] = useState("overview");     // 当前子页面
			const [op, setOp] = useState(null);             // null | prune | restore | catalog
			const [sizes, setSizes] = useState({});         // catalog id → {fileCount, bytes}
			const [sizesState, setSizesState] = useState("idle"); // idle | loading | error
			const [check, setCheck] = useState(null);       // restore-check 结果
			const [copyNote, setCopyNote] = useState("");   // 复制片段的结果提示
			const [recovery, setRecovery] = useState("");   // 明文恢复码（只活在内存，刷新即消失）
			const [recoveryNote, setRecoveryNote] = useState(""); // 复制结果提示

			const call = async (endpoint, payload) => {
				if (typeof rpcCall !== "function") throw new Error(t("unavailable"));
				const res = await rpcCall(endpoint, payload ?? {});
				if (!res?.ok) {
					const err = new Error(res?.error?.message ?? endpoint);
					err.code = res?.error?.code;
					throw err;
				}
				return res.value;
			};

			const refresh = async (opts) => {
				try {
					const v = await call("sync-backup.status");
					setView(v?.view ?? null);
					// 保存成功后要立刻刷新，但刷新不能把「保存成功」这条提示冲掉 ——
					// 否则用户点了保存却什么反馈都没有，只能靠猜。
					if (!opts?.keepNote) {
						setNote("");
						setTone("info");
					}
				} catch (err) {
					setNote(t("failed", { msg: errMsg(err) }));
					setTone("error");
				} finally {
					setReady(true);
				}
			};

			/**
			 * 落盘：只发真正变了的键给 host。
			 *
			 * 选择在**保存这一步**而不是「进入编辑态」时去查看变更，是因为中间
			 * 用户可能来回改回原值；以最后一次对比为准才不会写上无人改过的键。
			 */
			/**
			 * 数字键的形状关。host 的 EDITABLE_TYPES 只认「有限且非负」的 number，
			 * 把 NaN / 负数放过去，用户看到的只会是一句英文 bad-request ——
			 * 界面上要先说清是哪一个键、填了什么，别拿协议错误当报错文案。
			 * 注意 patch 里数字键可能仍是上一次留下的字符串，两边都得拦。
			 */
			const NUMERIC_KEYS = ["keepLast", "localKeepDays", "intervalHours", "remoteIntervalHours"];
			const badNumber = (x) => (typeof x === "number" ? !Number.isFinite(x) || x < 0 : true);
			const saveConfig = async (patch) => {
				const keys = Object.keys(patch);
				if (keys.length === 0) { setNote(t("saveNothing")); setTone("info"); return false; }
				// 数字输入框清空/乱填会得到 NaN。host 的 EDITABLE_TYPES 只认有限非负数，
				// 让它去拒就只剩一句英文 bad-request —— 在界面上说清是哪一个键、填了什么。
				for (const k of NUMERIC_KEYS) {
					if (k in patch && badNumber(patch[k])) {
						setNote(t("badNumber", { k, v: String(patch[k]) }));
						setTone("error");
						return false;
					}
				}
				try {
					await call("sync-backup.save-config", patch);
					if (alive.current) { setNote(t("saveOk", { n: keys.length })); setTone("ok"); }
					// 保存后必须用新 view 覆盖本地，否则界面还在显示旧值；
					// 但这一趟刷新要保住上面刚写的成功提示（keepNote）。
					await refresh({ keepNote: true });
					return true;
				} catch (err) {
					if (alive.current) { setNote(t("failed", { msg: errMsg(err) })); setTone("error"); }
					return false;
				}
			};

			/** 复制恢复码。失败要说出来 —— 用户以为复制成功了却没成功，是丢钥匙的起点。 */
			const copyRecovery = async () => {
				try {
					if (navigator?.clipboard?.writeText) await navigator.clipboard.writeText(recovery);
					else throw new Error("no clipboard");
					if (alive.current) setRecoveryNote(t("recoveryCopied"));
				} catch {
					if (alive.current) setRecoveryNote(t("copyFailed"));
				}
			};

			/** 导出恢复码：只在用户主动点击查看时才向 host 要明文，绝不落 localStorage。 */
			const exportRecoveryCode = async () => {
				setOp("recovery");
				try {
					const r = await call("sync-backup.export-recovery-code", {});
					if (!alive.current) return;
					setRecovery(r?.recoveryCode ?? "");
				} catch (err) {
					if (alive.current) { setNote(t("failed", { msg: errMsg(err) })); setTone("error"); }
				} finally {
					if (alive.current) setOp(null);
				}
			};

			// 卸载标记：异步回调不得再 setState（否则热重载后 React 会对已卸载树告警）。
			// 用 useState 存这个对象（而不是每次渲染新建字面量）—— 只有**首次渲染**那一份
			// 会被 cleanup 闭包捕获并置 false，新建的字面量永远停在 true，等于没做防护。
			const [alive] = useState({ current: true });
			useEffect(() => () => { alive.current = false; }, []);
			useEffect(() => { void refresh(); }, []);

			const runNow = async () => {
				setBusy(true);
				setNote(t("running"));
				setTone("info");
				try {
					const r = await call("sync-backup.run");
					if (!alive.current) return;
					setView(r?.view ?? null);
					setNote(t("done", { files: r?.fileCount ?? 0, gz: fmtBytes(r?.gzBytes) }));
					setTone("ok");
				} catch (err) {
					if (!alive.current) return;
					setNote(t("failed", { msg: errMsg(err) }));
					setTone("error");
				} finally {
					if (alive.current) setBusy(false);
				}
			};

			/** 统计每个备份条目在本机的实际体积（catalog-sizes，本地只读）。 */
			const loadSizes = async () => {
				setOp("catalog");
				setSizesState("loading");
				try {
					const r = await call("sync-backup.catalog-sizes");
					const map = {};
					for (const e of Array.isArray(r?.entries) ? r.entries : []) map[e.id] = e;
					if (!alive.current) return;
					setSizes(map);
					setSizesState("done");
				} catch (err) {
					if (!alive.current) return;
					setSizes({ __error: errMsg(err) });
					setSizesState("error");
				} finally {
					if (alive.current) setOp(null);
				}
			};

			const prune = async () => {
				setOp("prune");
				setNote(t("pruning"));
				setTone("info");
				try {
					const r = await call("sync-backup.prune", {});
					if (!alive.current) return;
					const removed = Array.isArray(r?.removed) ? r.removed : [];
					setView(r?.view ?? null);
					setNote(removed.length === 0
						? t("prunedNone")
						: t("pruned", { n: removed.length, bytes: fmtBytes(r?.bytesFreed), kept: r?.kept ?? 0 }));
					setTone("ok");
				} catch (err) {
					if (!alive.current) return;
					setNote(t("failed", { msg: errMsg(err) }));
					setTone("error");
				} finally {
					if (alive.current) setOp(null);
				}
			};

			const restoreCheck = async () => {
				setOp("restore");
				setNote(t("verifying"));
				setTone("info");
				try {
					const r = await call("sync-backup.restore-check", {});
					if (!alive.current) return;
					setCheck(r ?? null);
					setNote(r?.ok ? t("verifyOk") : t("verifyFail"));
					setTone(r?.ok ? "ok" : "error");
				} catch (err) {
					if (!alive.current) return;
					setNote(t("failed", { msg: errMsg(err) }));
					setTone("error");
				} finally {
					if (alive.current) setOp(null);
				}
			};

			/** 复制建议配置片段：优先用剪贴板 API，失败就提示手动选中（不静默失败）。 */
			const copySnippet = async () => {
				const text = patchSnippet(v);
				try {
					if (navigator?.clipboard?.writeText) await navigator.clipboard.writeText(text);
					else throw new Error("no clipboard");
					if (alive.current) setCopyNote(t("copied"));
				} catch {
					if (alive.current) setCopyNote(t("copyFailed"));
				}
			};

			// 进入「环境和维护」且尚未统计过 → 自动补一次体积（loading / error 都在此收敛）。
			useEffect(() => {
				if (tab === "env" && sizesState === "idle" && op === null) void loadSizes();
			}, [tab, sizesState, op]);

			// draft 必须在 !ready 早退**之前**声明：Hook 的顺序不能跟着分支走。
			// 这里用 view ?? {} 而不是下面的 v，因为 v 在早退之后才定义。
			const seedView = view ?? {};
			const dSch = useDraft(seedView, SCHED_KEYS, saveConfig);
			const dCh = useConfirmDraft(seedView, CHANNEL_KEYS, saveConfig);

			/**
			 * 备份目录集合的草稿。
			 *
			 * 不塞进 useDraft：那个钩子按「键的字符串/数字值」比对变更，而这里是
			 * 一个 id 数组，且 `[]` 有特殊含义（= 跟随默认集合）。独立成一小块状态，
			 * 语义反而清楚：`catDraft === undefined` 表示「没在编辑」（显示已保存值），
			 * 一旦动过勾选就变成具体数组，保存或被刷新后清回 undefined。
			 */
			const [catDraft, setCatDraft] = useState(undefined);
			// view 更新（保存成功后的 refresh）意味着服务端已接受新值，草稿使命结束
			useEffect(() => { setCatDraft(undefined); }, [seedView]);
			const saveCatalog = async (ids) => {
				const okRun = await saveConfig({ selectedPaths: ids });
				if (okRun) setCatDraft(undefined);
			};
			const dRc = {
				busy: op === "recovery",
				code: recovery,
				copyNote: recoveryNote,
				export: () => { void exportRecoveryCode(); },
				copy: () => { void copyRecovery(); },
				hide: () => { setRecovery(""); setRecoveryNote(""); }
			};

			if (!ready) return h("div", { className: "dsb-panel" }, h("div", { className: "dsb-sub" }, t("loading")));

			const v = view ?? {};

			const tabs = h("div", { className: "dsb-tabs", role: "tablist" }, TABS.map((id) =>
				h("button", {
					type: "button",
					className: "dsb-tab",
					role: "tab",
					key: `tab-${id}`,
					"aria-selected": tab === id ? "true" : "false",
					onClick: () => { setTab(id); }
				}, t(TAB_LABEL[id]))
			));

			let body;
			if (tab === "artifacts") {
				body = ArtifactsTab({ v, onPrune: prune, op });
			} else if (tab === "channels") {
				body = ChannelsTab({ v, dCh: dCh, pending: dCh.pending });
			} else if (tab === "env") {
				body = EnvTab({
					v, sizes, sizesState, onRecalc: loadSizes, onRestoreCheck: restoreCheck, check, op,
					catDraft,
					onCatChange: (ids) => setCatDraft(ids),
					onCatSave: () => {
						// 草稿只存在于内存；到这里一定是有值才允许点保存
						if (catDraft !== undefined) void saveCatalog(catDraft);
					},
					// 「恢复默认」= 显式写空数组（服务端语义：用默认集合）
					onCatReset: () => { void saveCatalog([]); }
				});
			} else {
				body = OverviewTab({ v, dSch, dRc });
			}

			return h("div", { className: "dsb-panel" },
				h("div", { className: "dsb-head" },
					h("div", { className: "dsb-h1" },
						t("title"),
						v.busy || busy ? h(Badge, { tone: "info", text: t("busy") }) : null
					),
					h("div", { className: "dsb-spacer" }),
					h("button", {
						type: "button",
						className: "dsb-btn primary",
						disabled: busy || v.busy === true,
						onClick: () => { void runNow(); }
					}, busy ? t("running") : t("runNow")),
					h("button", {
						type: "button",
						className: "dsb-btn",
						disabled: busy,
						onClick: () => { void refresh(); }
					}, t("refresh"))
				),
				h("div", { className: "dsb-sub" }, t("sub")),
				note ? h("div", { className: "dsb-note", "data-tone": tone, role: "status", "aria-live": "polite" }, note) : null,
				tabs,
				body
			);
		}

		function registerPanel(ctx, rpcCall) {
			// 宿主无槽位系统时静默跳过（不影响 host 半的工具与定时器）
			if (typeof ctx.slots?.inject !== "function" || typeof ctx.slots?.register !== "function") return;
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "sync-backup",
				order: 70,
				label: () => t("sectionLabel"),
				inject: () => ({ rpcCall })
			}, SyncBackupSection));
		}

		// connection：RPC 通道；slots：设置页分区。未注入时访问 ctx.<name> 会被宿主拒绝。
		var inject = ["connection", "slots"];

		function apply(ctx) {
			// 在 apply（上下文必然活跃）时立即捕获 connection 实例本身，而不是持有 ctx 做惰性访问：
			// 桌面版热重载会废弃旧 fiber，此后 ctx.connection 抛
			// "cannot get required service 'connection' in inactive context"。
			// 捕获到的实例由提供方插件持有，不受本插件 fiber 存亡影响。
			let connection = null;
			try { connection = ctx.connection; } catch { /* 上下文未就绪：rpcCall 内兜底重取 */ }
			const rpcCall = (endpoint, payload) => {
				if (!connection) {
					try { connection = ctx.connection; } catch { /* 仍然失活：走友好报错 */ }
				}
				if (!connection) throw new Error(t("contextStale"));
				return connection.rpc.call(CHANNEL, endpoint, payload ?? {});
			};

			ensureStyle();
			registerPanel(ctx, rpcCall);
		}

		module.exports = { inject, apply };
		return module.exports;
	}
});
