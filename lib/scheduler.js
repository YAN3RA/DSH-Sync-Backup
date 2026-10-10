/**
 * dsh-sync-backup / lib/scheduler.js
 *
 * 零依赖自排期定时器（P4）。设计范式照抄 `dsh-config-manager/lib/sync/backup-scheduler.js`：
 *
 *  - **依赖全注入**：`setTimer` / `clearTimer` / `now` / `getConfig` / `getState` / `runOnce`
 *    都可由调用方替换 —— 于是**不启动 DSH 也能离线测**（假计时器 + 假时钟）。
 *  - **stop 不打断在跑的活**：`stop()` 只清定时器并标记不再排期，正在执行的 `runOnce`
 *    允许自然结束（与官方先例逐字同构）。
 *  - **异常绝不冒泡**：定时回调内的任何异常只走 `log`，绝不向 Host 抛 ——
 *    否则会连带打断 DSH 的插件树。
 *  - **防重入**：`running` 为真时 tick 直接返回，避免 15 MB 打包期间叠上下一次。
 *
 * 安全口径：**默认不自动上传**。`uploadOnSchedule` 缺省 false，所以定时跑只做本地
 * 打包（零网络）；只有显式把 `uploadOnSchedule: true` 且 `dryRun: false` 才会真实出网，
 * 并且 `runOnce` 内部的 dryRun 闸门仍然生效（双保险）。
 *
 * @module dsh-sync-backup/lib/scheduler
 */

/** 把时间值归一为毫秒数；非法返回 undefined。 */
function toMs(v) {
  if (v === undefined || v === null) return undefined;
  if (v instanceof Date) {
    const t = v.getTime();
    return Number.isFinite(t) ? t : undefined;
  }
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : undefined;
  }
  return undefined;
}

/** 小时 → 毫秒（非法或非正数则取 fallback）。 */
function hoursToMs(hours, fallbackHours) {
  const n = Number(hours);
  const h = Number.isFinite(n) && n > 0 ? n : fallbackHours;
  return h * 3600 * 1000;
}

/**
 * 距下次运行还有多久（毫秒）。返回 0 表示「立刻该跑」。
 *
 * 语义：
 *  - `lastRunAt` 缺失/非法 → `0`（从未跑过，立刻排）。
 *  - 未失败（failures = 0）→ `intervalHours - elapsed`，下限 0。
 *  - 连续失败 n ≥ 1 次 → 等效周期放大为 `intervalHours × 2^n`，**上限 maxBackoffHours**，
 *    再减去已过去的时间，下限 0。冷却是**按连续失败次数指数退避**的，一次成功即归零。
 *  - 时钟回拨（elapsed < 0）→ 按一个完整周期重新等，不做 0 延迟风暴。
 *
 * @param {{now: Date|number|string, lastRunAt?: Date|number|string, intervalHours?: number,
 *          failures?: number, maxBackoffHours?: number}} opts
 * @returns {number} 毫秒
 */
export function nextRunDelayMs(opts = {}) {
  const intervalMs = hoursToMs(opts.intervalHours, 12);
  const capMs = Math.max(intervalMs, hoursToMs(opts.maxBackoffHours, 24));

  const nowMs = toMs(opts.now);
  if (nowMs === undefined) return 0;

  const lastMs = toMs(opts.lastRunAt);
  if (lastMs === undefined) return 0;

  const elapsed = nowMs - lastMs;
  if (elapsed < 0) return intervalMs; // 时钟回拨：重等一个周期

  const failures = Math.max(0, Math.min(10, Math.floor(Number(opts.failures) || 0)));
  const effective = failures > 0 ? Math.min(intervalMs * Math.pow(2, failures), capMs) : intervalMs;

  const remain = effective - elapsed;
  return remain > 0 ? remain : 0;
}

/**
 * 本次调度是否该带出网同步（远端周期独立节流）。
 *
 * 语义：
 *  - 前置：`uploadOnSchedule === true` 且 `dryRun !== true`（双保险，任一不满足即 false）。
 *  - `remoteIntervalHours` ≤ 0 / 非法 → **每次本地打包都同步**（v1 行为）。
 *  - `> 0` → 距上次成功远端同步（`lastSyncAt`）已超过该小时数才同步；从未同步过 → 同步。
 *  - 从未同步过（lastSyncAt 缺失/非法）→ 同步，否则第一次启用后可能永远不同步。
 *
 * @param {{uploadOnSchedule?: boolean, dryRun?: boolean, remoteIntervalHours?: number}} cfg
 * @param {{lastSyncAt?: Date|number|string}} [st]
 * @param {Date|number|string} [now] 当前时刻
 * @returns {boolean}
 */
export function shouldRemoteSync(cfg = {}, st = {}, now) {
  if (cfg.uploadOnSchedule !== true || cfg.dryRun === true) return false;

  const hours = Number(cfg.remoteIntervalHours);
  if (!Number.isFinite(hours) || hours <= 0) return true;

  const lastMs = toMs(st.lastSyncAt);
  if (lastMs === undefined) return true;

  const nowMs = toMs(now);
  if (nowMs === undefined) return false;

  return nowMs - lastMs >= hours * 3600 * 1000;
}

/**
 * 启动时是否应立即跑一次。
 *
 * 语义：从未跑过 → 是；`startupMinIntervalMs` ≤ 0/非法 → 是；否则「距上次运行 ≥ 阈值」才算。
 * 与官方先例 `shouldTriggerStartupRun` 同口径 —— 避免每次重启 DSH 都白跑一次 15 MB 打包。
 *
 * @param {{lastRunAt?: Date|number|string, now: Date|number|string, startupMinIntervalMs?: number}} opts
 * @returns {boolean}
 */
export function shouldTriggerStartupRun(opts = {}) {
  const lastMs = toMs(opts.lastRunAt);
  if (lastMs === undefined) return true;

  const nowMs = toMs(opts.now);
  if (nowMs === undefined) return false;

  const min = Number(opts.startupMinIntervalMs);
  if (!Number.isFinite(min) || min <= 0) return true;

  return nowMs - lastMs >= min;
}

/**
 * 自排期器。
 *
 * 生命周期：`start()` → 排期 + 启动触发；`stop()` → 清定时器（在跑的活自然结束）。
 * 每次 tick 完成后自动重排，故无需外部驱动。
 */
export class BackupScheduler {
  /**
   * @param {object} opts
   * @param {() => object|Promise<object>} [opts.getConfig]  读组合行配置
   * @param {() => object|Promise<object>} [opts.getState]   读状态文件（取 lastRunAt / failures）
   * @param {(o: {upload: boolean, reason: string}) => Promise<object>} [opts.runOnce]
   * @param {() => Date} [opts.now]
   * @param {(fn: Function, ms: number) => any} [opts.setTimer]
   * @param {(t: any) => void} [opts.clearTimer]
   * @param {{info?: Function, warn?: Function, error?: Function}} [opts.log]
   * @param {(plan: {nextRunAt: Date, delayMs: number, upload: boolean}) => void} [opts.onSchedule]
   */
  constructor(opts = {}) {
    this.getConfig = opts.getConfig ?? (() => ({ enabled: true }));
    this.getState = opts.getState ?? (async () => ({}));
    this.runOnce = typeof opts.runOnce === "function" ? opts.runOnce : undefined;
    this.now = opts.now ?? (() => new Date());
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t));
    this.log = opts.log ?? {};
    this.onSchedule = typeof opts.onSchedule === "function" ? opts.onSchedule : undefined;

    this.timer = undefined;
    this.stopped = true;
    this.running = false;
    /** 下次计划运行的时刻（未排期时为 undefined）—— 只读展示用。 */
    this.nextRunAt = undefined;
  }

  /** 启动：排定时器 + 视阈值执行一次启动触发。重复调用无副作用。 */
  start() {
    if (!this.stopped) return;
    this.stopped = false;
    void this.begin();
  }

  /**
   * 启动路径：**启动触发优先**。
   * 若确实触发了启动补跑，则由那次 tick 的 finally 负责重排 —— 避免
   * 「启动触发」与「delay 0 的立即排期」各跑一次（官方先例此处会跑两次）。
   */
  async begin() {
    try {
      const ran = await this.startupRun();
      if (ran) return;
    } catch (err) {
      this._log("error", "启动触发失败", err);
    }
    await this.refreshTimer();
  }

  /** 停止：清定时器并标记不再排期；**正在执行的 runOnce 允许自然结束**。 */
  stop() {
    this.stopped = true;
    if (this.timer !== undefined) {
      try {
        this.clearTimer(this.timer);
      } catch {
        /* 清定时器失败视为已停 */
      }
      this.timer = undefined;
    }
    this.nextRunAt = undefined;
  }

  /** 内部：安全日志（日志自身失败也绝不冒泡）。 */
  _log(level, message, err) {
    try {
      const fn = this.log && typeof this.log[level] === "function" ? this.log[level] : undefined;
      if (fn) fn.call(this.log, message, err === undefined ? undefined : { error: String((err && err.message) || err) });
    } catch {
      /* 忽略 */
    }
  }

  /** 依据配置与状态算出本次排期（返回 undefined 表示不排期）。 */
  async plan() {
    const cfg = (await this.getConfig()) ?? {};
    if (cfg.enabled === false || cfg.schedulerEnabled === false) return undefined;

    const st = (await this.getState()) ?? {};
    const delay = nextRunDelayMs({
      now: this.now(),
      lastRunAt: st.lastRunAt,
      intervalHours: cfg.intervalHours,
      failures: st.failures,
      maxBackoffHours: cfg.maxBackoffHours,
    });
    return {
      delay,
      // 定时跑默认只做本地打包：uploadOnSchedule 缺省 false，dryRun 缺省 true —— 双保险；
      // 打开后再由 remoteIntervalHours 做远端节流（0 = 每次都同步）。
      upload: shouldRemoteSync(cfg, st, this.now()),
      reason: "schedule",
    };
  }

  /** 重排定时器（配置变更后亦可调用）。 */
  async refreshTimer() {
    if (this.stopped) return;

    if (this.timer !== undefined) {
      try {
        this.clearTimer(this.timer);
      } catch {
        /* 忽略 */
      }
      this.timer = undefined;
    }

    let p;
    try {
      p = await this.plan();
    } catch (err) {
      this._log("warn", "定时备份排期失败（本轮不排期）", err);
      return;
    }

    if (this.stopped || p === undefined) {
      this.nextRunAt = undefined;
      return;
    }

    const delay = Math.max(0, p.delay);
    this.nextRunAt = new Date(toMs(this.now()) + delay);
    if (this.onSchedule) {
      try {
        this.onSchedule({ nextRunAt: this.nextRunAt, delayMs: delay, upload: p.upload });
      } catch {
        /* 回调失败不影响排期 */
      }
    }

    let fired = false;
    const cb = () => {
      fired = true;
      this.timer = undefined;
      if (this.stopped) return;
      void this.tick(p.upload);
    };
    this.timer = this.setTimer(cb, delay);
    // 假计时器可能在 setTimer 内**同步**触发 cb（delay 0）；此时句柄已作废，
    // 上面的赋值会把陈旧 handle 留下，这里补偿清零，避免悬挂句柄与 stop 失效。
    if (fired) this.timer = undefined;
  }

  /** 执行一次定时运行；结束后自动重排。异常只记日志。返回是否真的跑了。 */
  async tick(upload) {
    if (this.stopped || this.running) return false;
    if (typeof this.runOnce !== "function") return false;

    this.running = true;
    try {
      const r = await this.runOnce({ upload: upload === true, reason: "schedule" });
      const ok = r && r.ok === true;
      const partial = r && r.partial === true;
      this._log("info", `定时备份${ok ? (partial ? "完成（半失败）" : "完成") : "失败"}`);
      return true;
    } catch (err) {
      // 绝不向 Host 冒泡：定时回调抛错会打断插件树
      this._log("error", "定时备份触发失败", err);
      return false;
    } finally {
      this.running = false;
      if (!this.stopped) void this.refreshTimer();
    }
  }

  /** 启动触发：距上次运行超过阈值才跑，避免每次重启都白跑一次打包。返回是否真的跑了。 */
  async startupRun() {
    try {
      const cfg = (await this.getConfig()) ?? {};
      if (this.stopped || cfg.enabled === false || cfg.schedulerEnabled === false) return false;
      if (cfg.startupRunOnBoot === false) return false;

      const st = (await this.getState()) ?? {};
      const due = shouldTriggerStartupRun({
        lastRunAt: st.lastRunAt,
        now: this.now(),
        startupMinIntervalMs: cfg.startupMinIntervalMs,
      });
      if (!due) return false;
      if (this.stopped || this.running) return false;

      return await this.tick(shouldRemoteSync(cfg, st, this.now()));
    } catch (err) {
      this._log("error", "启动触发失败", err);
      return false;
    }
  }
}

export default { BackupScheduler, nextRunDelayMs, shouldRemoteSync, shouldTriggerStartupRun };
