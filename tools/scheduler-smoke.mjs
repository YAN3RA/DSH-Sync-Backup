/**
 * dsh-sync-backup / tools/scheduler-smoke.mjs
 *
 * P4 定时器离线单测：**零网络、零真实等待**。
 *
 * 手法：`BackupScheduler` 的 `now` / `setTimer` / `clearTimer` / `getConfig` /
 * `getState` / `runOnce` 全部注入假件，于是可以在「假时钟 + 假计时器」上
 * 精确验证排期、退避、防重入、停启与异常隔离，而不必等 12 小时。
 *
 * 覆盖：
 *   [1] 纯函数 nextRunDelayMs（未跑过 / 未失败 / 指数退避 / 上限 / 时钟回拨 / 非法输入）
 *   [2] 纯函数 shouldTriggerStartupRun
 *   [3] 构造默认与 start/stop 生命周期（stop 不打断在跑的活、重复 start 无副作用）
 *   [4] 排期开关（enabled / schedulerEnabled）
 *   [5] **安全语义**：定时上传的双保险（uploadOnSchedule + dryRun）
 *   [6] 启动触发只跑一次
 *   [7] 到点触发 → runOnce(reason='schedule') → 自动重排
 *   [8] 防重入
 *   [9] 异常与日志失败都不冒泡
 *   [10] 假计时器同步触发不留悬挂句柄
 *   [11] 真实 setTimer/clearTimer 路径（延迟 0，真实 setTimeout）
 *
 * 用法：node tools/scheduler-smoke.mjs
 */

import assert from "node:assert/strict";

import { BackupScheduler, nextRunDelayMs, shouldRemoteSync, shouldTriggerStartupRun } from "../lib/scheduler.js";

let passed = 0;
let failed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.log(`  ✗ ${name}\n      ${err && err.message ? err.message : err}`);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.log(`  ✗ ${name}\n      ${err && err.message ? err.message : err}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

/** 让所有已排的微任务 / 已 resolve 的 promise 跑完。 */
async function flush(turns = 12) {
  for (let i = 0; i < turns; i++) await Promise.resolve();
  await new Promise((r) => setImmediate(r));
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

/* ------------------------------------------------------------------ */
/* 假时钟 + 假计时器                                                    */
/* ------------------------------------------------------------------ */

const HOUR = 3600 * 1000;

function fakeClock(startIso = "2026-10-08T12:00:00.000Z") {
  let nowMs = Date.parse(startIso);
  const timers = [];

  return {
    now: () => new Date(nowMs),
    nowMs: () => nowMs,
    setTimer(fn, ms) {
      const handle = { fn, ms, at: nowMs + ms, cancelled: false, fired: false };
      timers.push(handle);
      return handle;
    },
    clearTimer(handle) {
      if (handle) handle.cancelled = true;
    },
    timers,
    /** 未取消且未触发的计时器。 */
    pending: () => timers.filter((t) => !t.cancelled && !t.fired),
    /** 前进给定毫秒，并触发所有到点的计时器（异步触发，模拟真实事件循环边界）。 */
    async advance(ms) {
      nowMs += ms;
      const due = timers.filter((t) => !t.cancelled && !t.fired && t.at <= nowMs);
      for (const t of due) {
        t.fired = true;
        t.fn();
      }
      await flush();
    },
  };
}

/** 造一个受控的 scheduler 夹具；返回 scheduler 与观测记录。 */
function makeScheduler({ clock, config = {}, state = {}, runOnceImpl } = {}) {
  const calls = { runOnce: [], scheduled: [] };
  let stateObj = { lastRunAt: undefined, failures: 0, ...state };
  let configObj = {
    enabled: true,
    intervalHours: 12,
    startupMinIntervalMs: HOUR,
    maxBackoffHours: 24,
    dryRun: true,
    schedulerEnabled: true,
    uploadOnSchedule: false,
    startupRunOnBoot: true,
    ...config,
  };

  const c = clock ?? fakeClock();
  const scheduler = new BackupScheduler({
    now: c.now,
    setTimer: c.setTimer,
    clearTimer: c.clearTimer,
    getConfig: async () => configObj,
    getState: async () => stateObj,
    runOnce: async (o) => {
      calls.runOnce.push(o);
      if (runOnceImpl) return await runOnceImpl(o, stateObj, configObj);
      return { ok: true };
    },
    onSchedule: (p) => calls.scheduled.push(p),
    log: { info() {}, warn() {}, error() {} },
  });

  return {
    scheduler,
    calls,
    clock: c,
    setConfig: (patch) => {
      configObj = { ...configObj, ...patch };
    },
    setState: (patch) => {
      stateObj = { ...stateObj, ...patch };
    },
    getState: () => stateObj,
  };
}

console.log("=== dsh-sync-backup scheduler smoke ===");

/* ------------------------------------------------------------------ */
section("[1] nextRunDelayMs 纯函数");
/* ------------------------------------------------------------------ */

check("lastRunAt 缺失 → 0（从未跑过立刻排）", () => {
  assert.equal(nextRunDelayMs({ now: "2026-10-08T12:00:00Z", intervalHours: 12 }), 0);
});

check("now 非法 → 0", () => {
  assert.equal(nextRunDelayMs({ now: "not-a-date", lastRunAt: "2026-10-08T00:00:00Z" }), 0);
  assert.equal(nextRunDelayMs({ now: NaN, lastRunAt: "2026-10-08T00:00:00Z" }), 0);
});

check("未失败：返回剩余时间", () => {
  const delay = nextRunDelayMs({
    now: "2026-10-08T06:00:00Z",
    lastRunAt: "2026-10-08T00:00:00Z",
    intervalHours: 12,
  });
  assert.equal(delay, 6 * HOUR);
});

check("未失败：已超期 → 0（不为负）", () => {
  const delay = nextRunDelayMs({
    now: "2026-10-08T20:00:00Z",
    lastRunAt: "2026-10-08T00:00:00Z",
    intervalHours: 12,
  });
  assert.equal(delay, 0);
});

check("failures=1 → 周期翻倍（12h → 24h）", () => {
  const delay = nextRunDelayMs({
    now: "2026-10-08T12:00:00Z",
    lastRunAt: "2026-10-08T12:00:00Z",
    intervalHours: 12,
    failures: 1,
    maxBackoffHours: 96,
  });
  assert.equal(delay, 24 * HOUR);
});

check("failures=2 → 周期 4 倍", () => {
  const delay = nextRunDelayMs({
    now: "2026-10-08T12:00:00Z",
    lastRunAt: "2026-10-08T12:00:00Z",
    intervalHours: 12,
    failures: 2,
    maxBackoffHours: 96,
  });
  assert.equal(delay, 48 * HOUR);
});

check("指数退避受 maxBackoffHours 封顶（12h×2^5=384h → 封 24h）", () => {
  const delay = nextRunDelayMs({
    now: "2026-10-08T12:00:00Z",
    lastRunAt: "2026-10-08T12:00:00Z",
    intervalHours: 12,
    failures: 5,
    maxBackoffHours: 24,
  });
  assert.equal(delay, 24 * HOUR);
});

check("maxBackoffHours 小于 intervalHours 时以 intervalHours 为地板", () => {
  const delay = nextRunDelayMs({
    now: "2026-10-08T12:00:00Z",
    lastRunAt: "2026-10-08T12:00:00Z",
    intervalHours: 12,
    failures: 3,
    maxBackoffHours: 1,
  });
  assert.equal(delay, 12 * HOUR);
});

check("时钟回拨（lastRunAt 在未来）→ 重等一个完整周期", () => {
  const delay = nextRunDelayMs({
    now: "2026-10-08T00:00:00Z",
    lastRunAt: "2026-10-08T12:00:00Z",
    intervalHours: 12,
  });
  assert.equal(delay, 12 * HOUR);
});

check("failures 非法 / 负数 / 非整数都能归一", () => {
  const base = { now: "2026-10-08T12:00:00Z", lastRunAt: "2026-10-08T12:00:00Z", intervalHours: 12 };
  assert.equal(nextRunDelayMs({ ...base, failures: undefined }), 12 * HOUR);
  assert.equal(nextRunDelayMs({ ...base, failures: -3 }), 12 * HOUR);
  assert.equal(nextRunDelayMs({ ...base, failures: "abc" }), 12 * HOUR);
  assert.equal(nextRunDelayMs({ ...base, failures: 1.9 }), 24 * HOUR);
});

check("failures 巨大值被夹到 10（不爆浮点）", () => {
  const delay = nextRunDelayMs({
    now: "2026-10-08T12:00:00Z",
    lastRunAt: "2026-10-08T12:00:00Z",
    intervalHours: 12,
    failures: 1e9,
    maxBackoffHours: 24,
  });
  assert.equal(delay, 24 * HOUR);
});

check("intervalHours 非法 → 回退 12", () => {
  const delay = nextRunDelayMs({
    now: "2026-10-08T06:00:00Z",
    lastRunAt: "2026-10-08T00:00:00Z",
    intervalHours: -5,
  });
  assert.equal(delay, 6 * HOUR);
});

check("now / lastRunAt 接受 Date 与 number", () => {
  const t = Date.parse("2026-10-08T00:00:00Z");
  const delay = nextRunDelayMs({
    now: new Date(t + 3 * HOUR),
    lastRunAt: t,
    intervalHours: 12,
  });
  assert.equal(delay, 9 * HOUR);
});

/* ------------------------------------------------------------------ */
section("[2] shouldTriggerStartupRun 纯函数");
/* ------------------------------------------------------------------ */

check("lastRunAt 缺失 → true", () => {
  assert.equal(shouldTriggerStartupRun({ now: new Date(), startupMinIntervalMs: HOUR }), true);
});

check("now 非法 → false（宁可不动）", () => {
  assert.equal(
    shouldTriggerStartupRun({ lastRunAt: "2026-10-08T00:00:00Z", now: "bad", startupMinIntervalMs: HOUR }),
    false,
  );
});

check("startupMinIntervalMs ≤ 0 / 非法 → true", () => {
  const p = { lastRunAt: "2026-10-08T11:59:00Z", now: "2026-10-08T12:00:00Z" };
  assert.equal(shouldTriggerStartupRun({ ...p, startupMinIntervalMs: 0 }), true);
  assert.equal(shouldTriggerStartupRun({ ...p, startupMinIntervalMs: -1 }), true);
  assert.equal(shouldTriggerStartupRun({ ...p, startupMinIntervalMs: NaN }), true);
});

check("距今不足阈值 → false", () => {
  assert.equal(
    shouldTriggerStartupRun({
      lastRunAt: "2026-10-08T11:30:00Z",
      now: "2026-10-08T12:00:00Z",
      startupMinIntervalMs: HOUR,
    }),
    false,
  );
});

check("距今达到阈值 → true", () => {
  assert.equal(
    shouldTriggerStartupRun({
      lastRunAt: "2026-10-08T11:00:00Z",
      now: "2026-10-08T12:00:00Z",
      startupMinIntervalMs: HOUR,
    }),
    true,
  );
});

/* ------------------------------------------------------------------ */
section("[3] shouldRemoteSync —— 远端周期与本地周期分离（v2 需求②）");
/* ------------------------------------------------------------------ */

// 出网的前置闸门：uploadOnSchedule 必须显式打开，且 dryRun 必须为假。二者独立，缺一即否。
const REMOTE_BASE = { uploadOnSchedule: true, dryRun: false };

check("uploadOnSchedule=false → 永不同步（定时跑只做本地打包）", () => {
  assert.equal(shouldRemoteSync({ uploadOnSchedule: false, dryRun: false }, {}, "2026-10-08T12:00:00Z"), false);
});

check("dryRun=true → 永不同步（第二条保险）", () => {
  assert.equal(shouldRemoteSync({ uploadOnSchedule: true, dryRun: true }, {}, "2026-10-08T12:00:00Z"), false);
});

check("remoteIntervalHours=0 → 每次本地打包都同步（v1 行为）", () => {
  assert.equal(shouldRemoteSync({ ...REMOTE_BASE, remoteIntervalHours: 0 }, { lastSyncAt: "2026-10-08T11:00:00Z" }, "2026-10-08T12:00:00Z"), true);
});

check("remoteIntervalHours 非法/负数 → 退回每次都同步", () => {
  for (const bad of [undefined, NaN, -1, "12"]) {
    assert.equal(shouldRemoteSync({ ...REMOTE_BASE, remoteIntervalHours: bad }, {}, "2026-10-08T12:00:00Z"), true);
  }
});

check("从未同步过（lastSyncAt 缺失）→ 同步，否则启用了也永远不发", () => {
  assert.equal(shouldRemoteSync({ ...REMOTE_BASE, remoteIntervalHours: 24 }, {}, "2026-10-08T12:00:00Z"), true);
  assert.equal(shouldRemoteSync({ ...REMOTE_BASE, remoteIntervalHours: 24 }, { lastSyncAt: "bad" }, "2026-10-08T12:00:00Z"), true);
});

check("窗口未满（6h 周期，距上次同步 3h）→ 跳过，本地照样打包", () => {
  assert.equal(
    shouldRemoteSync(
      { ...REMOTE_BASE, remoteIntervalHours: 6 },
      { lastSyncAt: "2026-10-08T09:00:00Z" },
      "2026-10-08T12:00:00Z",
    ),
    false,
  );
});

check("窗口已满（6h 周期，距上次同步 6h）→ 同步（边界取等号）", () => {
  assert.equal(
    shouldRemoteSync(
      { ...REMOTE_BASE, remoteIntervalHours: 6 },
      { lastSyncAt: "2026-10-08T06:00:00Z" },
      "2026-10-08T12:00:00Z",
    ),
    true,
  );
});

check("now 非法 → false（宁可跳过一轮，也不按 unknown 时刻做决定）", () => {
  assert.equal(
    shouldRemoteSync({ ...REMOTE_BASE, remoteIntervalHours: 6 }, { lastSyncAt: "2026-10-08T09:00:00Z" }, "bad"),
    false,
  );
});

check("一天本地 4 次、远端只同步 1 次（6h / 24h 的真实配比）", () => {
  // 12:00 起，每 6h 本地打包一次；24:00 那次才够 24h 窗口
  const cfg = { ...REMOTE_BASE, remoteIntervalHours: 24 };
  let lastSyncAt = "2026-10-08T00:00:00Z";
  const stamps = ["2026-10-08T12:00:00Z", "2026-10-08T18:00:00Z", "2026-10-09T00:00:00Z"];
  const fired = stamps.map((now) => {
    const go = shouldRemoteSync(cfg, { lastSyncAt }, now);
    if (go) lastSyncAt = now;
    return go;
  });
  assert.deepEqual(fired, [false, false, true]);
});

/* ------------------------------------------------------------------ */
section("[4] 构造默认与 start/stop 生命周期");
/* ------------------------------------------------------------------ */

check("默认 stopped=true、running=false、无 timer、无 nextRunAt", () => {
  const s = new BackupScheduler();
  assert.equal(s.stopped, true);
  assert.equal(s.running, false);
  assert.equal(s.timer, undefined);
  assert.equal(s.nextRunAt, undefined);
});

await checkAsync("start() 后 stopped=false 且排出定时器", async () => {
  const clock = fakeClock();
  const f = makeScheduler({ clock, state: { lastRunAt: clock.now().toISOString() } });
  f.scheduler.start();
  await flush();
  assert.equal(f.scheduler.stopped, false);
  assert.equal(clock.pending().length, 1, "应恰好排了一个定时器");
  assert.equal(clock.pending()[0].ms, 12 * HOUR);
  assert.ok(f.scheduler.nextRunAt instanceof Date);
});

await checkAsync("stop() 清定时器并清 nextRunAt", async () => {
  const clock = fakeClock();
  const f = makeScheduler({ clock, state: { lastRunAt: clock.now().toISOString() } });
  f.scheduler.start();
  await flush();
  f.scheduler.stop();
  await flush();
  assert.equal(f.scheduler.stopped, true);
  assert.equal(f.scheduler.nextRunAt, undefined);
  assert.equal(clock.pending().length, 0);
});

await checkAsync("stop() 不打断在跑的 runOnce（自然结束）", async () => {
  const clock = fakeClock();
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  let finished = false;
  const f = makeScheduler({
    clock,
    config: { startupRunOnBoot: false },
    state: { lastRunAt: undefined },
    runOnceImpl: async () => {
      await gate;
      finished = true;
      return { ok: true };
    },
  });
  f.scheduler.start();
  await flush();
  // delay 为 0（lastRunAt 缺失）→ 需推进假时钟让定时器真正到点
  await clock.advance(0);
  await flush();
  assert.equal(f.scheduler.running, true, "runOnce 应在跑");
  f.scheduler.stop();
  assert.equal(finished, false, "stop 不应打断在跑的活");
  release();
  await flush();
  assert.equal(finished, true, "在跑的活应自然结束");
});

await checkAsync("重复 start() 无副作用（不叠加定时器）", async () => {
  const clock = fakeClock();
  const f = makeScheduler({ clock, state: { lastRunAt: clock.now().toISOString() } });
  f.scheduler.start();
  await flush();
  const n = clock.pending().length;
  f.scheduler.start();
  f.scheduler.start();
  await flush();
  assert.equal(clock.pending().length, n, "不应新增定时器");
});

/* ------------------------------------------------------------------ */
section("[5] 排期开关");
/* ------------------------------------------------------------------ */

await checkAsync("enabled:false → 不排期", async () => {
  const clock = fakeClock();
  const f = makeScheduler({ clock, config: { enabled: false } });
  f.scheduler.start();
  await flush();
  assert.equal(clock.pending().length, 0);
  assert.equal(f.scheduler.nextRunAt, undefined);
  assert.equal(f.calls.runOnce.length, 0);
});

await checkAsync("schedulerEnabled:false → 不排期、不启动触发", async () => {
  const clock = fakeClock();
  const f = makeScheduler({ clock, config: { schedulerEnabled: false } });
  f.scheduler.start();
  await flush();
  assert.equal(clock.pending().length, 0);
  assert.equal(f.calls.runOnce.length, 0);
});

/* ------------------------------------------------------------------ */
section("[6] 安全语义：定时上传的双保险");
/* ------------------------------------------------------------------ */

await checkAsync("默认（uploadOnSchedule 缺省 false）→ 定时跑上传关闭", async () => {
  const clock = fakeClock();
  const f = makeScheduler({ clock, state: { lastRunAt: undefined } });
  f.scheduler.start();
  await flush();
  assert.ok(f.calls.runOnce.length >= 1, "应有启动触发");
  assert.equal(f.calls.runOnce[0].upload, false);
});

await checkAsync("uploadOnSchedule:true 但 dryRun:true → 仍为 false（双保险）", async () => {
  const clock = fakeClock();
  const f = makeScheduler({ clock, config: { uploadOnSchedule: true, dryRun: true }, state: { lastRunAt: undefined } });
  f.scheduler.start();
  await flush();
  assert.equal(f.calls.runOnce[0].upload, false, "dryRun 必须压住 uploadOnSchedule");
});

await checkAsync("uploadOnSchedule:true 且 dryRun:false → 才允许出网", async () => {
  const clock = fakeClock();
  const f = makeScheduler({ clock, config: { uploadOnSchedule: true, dryRun: false }, state: { lastRunAt: undefined } });
  f.scheduler.start();
  await flush();
  assert.equal(f.calls.runOnce[0].upload, true);
});

/* ------------------------------------------------------------------ */
section("[7] 启动触发只跑一次");
/* ------------------------------------------------------------------ */

await checkAsync("lastRunAt 缺失 → 启动触发恰跑一次（不因 delay=0 再跑一次）", async () => {
  const clock = fakeClock();
  const f = makeScheduler({
    clock,
    state: { lastRunAt: undefined },
    runOnceImpl: async (o, state) => {
      state.lastRunAt = clock.now().toISOString();
      return { ok: true };
    },
  });
  f.scheduler.start();
  await flush(20);
  assert.equal(f.calls.runOnce.length, 1, `应只跑一次，实际 ${f.calls.runOnce.length}`);
  assert.equal(f.calls.runOnce[0].reason, "schedule");
  assert.equal(clock.pending().length, 1, "跑完后应排好下一次");
});

await checkAsync("lastRunAt 很新 → 不启动触发，直接排期", async () => {
  const clock = fakeClock();
  const f = makeScheduler({ clock, state: { lastRunAt: clock.now().toISOString() } });
  f.scheduler.start();
  await flush(20);
  assert.equal(f.calls.runOnce.length, 0);
  assert.equal(clock.pending().length, 1);
});

await checkAsync("startupRunOnBoot:false → 不启动触发", async () => {
  const clock = fakeClock();
  const f = makeScheduler({ clock, config: { startupRunOnBoot: false }, state: { lastRunAt: undefined } });
  f.scheduler.start();
  await flush(20);
  assert.equal(f.calls.runOnce.length, 0);
  assert.equal(clock.pending().length, 1, "仍应排期");
});

/* ------------------------------------------------------------------ */
section("[8] 到点触发与自动重排");
/* ------------------------------------------------------------------ */

await checkAsync("推进假时钟 → runOnce(reason='schedule') → 自动重排下一次", async () => {
  const clock = fakeClock();
  const f = makeScheduler({
    clock,
    state: { lastRunAt: clock.now().toISOString() },
    runOnceImpl: async (o, state) => {
      state.lastRunAt = clock.now().toISOString();
      return { ok: true, upload: false };
    },
  });
  f.scheduler.start();
  await flush();
  assert.equal(f.calls.runOnce.length, 0);
  await clock.advance(12 * HOUR);
  await flush(20);
  assert.equal(f.calls.runOnce.length, 1, "到点应跑一次");
  assert.equal(f.calls.runOnce[0].reason, "schedule");
  assert.equal(clock.pending().length, 1, "应重排下一次");
  await clock.advance(12 * HOUR);
  await flush(20);
  assert.equal(f.calls.runOnce.length, 2, "再一个周期应再跑");
});

await checkAsync("失败退避：runOnce 报 ok:false 且 state.failures 增长 → 下次排期拉长", async () => {
  const clock = fakeClock();
  const f = makeScheduler({
    clock,
    state: { lastRunAt: clock.now().toISOString() },
    runOnceImpl: async () => {
      return { ok: false };
    },
  });
  // 手动把 state 设成连续失败 1 次，再看排期
  f.setState({ failures: 1, lastRunAt: clock.now().toISOString() });
  f.scheduler.start();
  await flush();
  assert.equal(clock.pending()[0].ms, 24 * HOUR, "failures=1 应排 2× 周期");
});

await checkAsync("onSchedule 回调收到 nextRunAt / delayMs / upload", async () => {
  const clock = fakeClock();
  const f = makeScheduler({ clock, state: { lastRunAt: clock.now().toISOString() } });
  f.scheduler.start();
  await flush();
  assert.equal(f.calls.scheduled.length, 1);
  assert.equal(f.calls.scheduled[0].delayMs, 12 * HOUR);
  assert.equal(f.calls.scheduled[0].upload, false);
  assert.ok(f.calls.scheduled[0].nextRunAt instanceof Date);
});

/* ------------------------------------------------------------------ */
section("[9] 防重入");
/* ------------------------------------------------------------------ */

await checkAsync("running 为真时再 tick 直接返回（不叠跑）", async () => {
  const clock = fakeClock();
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const f = makeScheduler({
    clock,
    config: { startupRunOnBoot: false },
    state: { lastRunAt: undefined },
    runOnceImpl: async () => {
      await gate;
      return { ok: true };
    },
  });
  f.scheduler.start();
  await flush();
  await clock.advance(0);
  await flush(20);
  assert.equal(f.scheduler.running, true);
  const before = f.calls.runOnce.length;
  await f.scheduler.tick(false);
  await f.scheduler.tick(false);
  assert.equal(f.calls.runOnce.length, before, "重入的 tick 不应新增运行");
  release();
  await flush(20);
});

/* ------------------------------------------------------------------ */
section("[10] 异常隔离");
/* ------------------------------------------------------------------ */

await checkAsync("runOnce 抛错 → tick 不冒泡，且仍重排", async () => {
  const clock = fakeClock();
  const f = makeScheduler({
    clock,
    config: { startupRunOnBoot: false },
    state: { lastRunAt: undefined },
    runOnceImpl: async () => {
      throw new Error("boom");
    },
  });
  f.scheduler.start();
  await flush();
  await clock.advance(0);
  await flush(20);
  assert.equal(f.calls.runOnce.length, 1, "应尝试过一次");
  assert.equal(f.scheduler.running, false);
  assert.equal(clock.pending().length, 1, "失败也应重排（让退避逻辑接管）");
});

await checkAsync("getConfig 抛错 → 不排期也不冒泡", async () => {
  const clock = fakeClock();
  const s = new BackupScheduler({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    getConfig: async () => {
      throw new Error("config boom");
    },
    getState: async () => ({}),
    runOnce: async () => ({ ok: true }),
  });
  s.start();
  await flush(20);
  assert.equal(clock.pending().length, 0);
  assert.equal(s.stopped, false, "只是本轮不排期");
});

await checkAsync("log.info 抛错 → 不冒泡", async () => {
  const clock = fakeClock();
  const s = new BackupScheduler({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    getConfig: async () => ({ enabled: true, intervalHours: 12, startupMinIntervalMs: 0 }),
    getState: async () => ({}),
    runOnce: async () => ({ ok: true }),
    log: {
      info: () => {
        throw new Error("log boom");
      },
      warn: () => {
        throw new Error("log boom");
      },
      error: () => {
        throw new Error("log boom");
      },
    },
  });
  s.start();
  await flush(20);
  assert.equal(s.running, false);
});

/* ------------------------------------------------------------------ */
section("[11] 假计时器同步触发不留悬挂句柄");
/* ------------------------------------------------------------------ */

await checkAsync("setTimer 同步触发（delay 0）后不残留已触发的句柄", async () => {
  const clock = fakeClock();
  const syncTimers = [];
  const firedHandles = new Set();

  // 前两次读状态返回「从未跑过」（delay=0），之后返回刚跑过（正常 12h）——
  // 这样既能让 setTimer 在 delay=0 时同步触发，又不会让测试自身无限递归。
  let stateCalls = 0;
  let lastRunAt;

  const s = new BackupScheduler({
    now: clock.now,
    setTimer: (fn, ms) => {
      const h = { fn, ms };
      syncTimers.push(h);
      if (ms === 0) {
        firedHandles.add(h);
        fn();
      }
      return h;
    },
    clearTimer: () => {},
    getConfig: async () => ({ enabled: true, intervalHours: 12, startupMinIntervalMs: 0 }),
    getState: async () => {
      stateCalls++;
      return stateCalls <= 2 ? {} : { lastRunAt };
    },
    runOnce: async () => {
      lastRunAt = clock.now().toISOString();
      return { ok: true };
    },
    log: { info() {}, warn() {}, error() {} },
  });

  s.start();
  await flush(40);

  assert.ok(firedHandles.size >= 1, "至少应发生一次同步触发");
  assert.ok(s.timer !== undefined, "最终应留下一个有效的下次定时器");
  assert.ok(!firedHandles.has(s.timer), "timer 不得是已触发的陈旧句柄（否则 stop 失效）");
  assert.equal(s.timer.ms, 12 * HOUR, "留下的应是正常周期句柄");

  s.stop();
  assert.equal(s.timer, undefined, "stop 应清干净");
});

/* ------------------------------------------------------------------ */
section("[12] 真实 setTimer / clearTimer 路径");
/* ------------------------------------------------------------------ */

await checkAsync("默认计时器（真实 setTimeout）在 delay=0 时能触发", async () => {
  const s = new BackupScheduler({
    getConfig: async () => ({ enabled: true, intervalHours: 12, startupMinIntervalMs: 0 }),
    getState: async () => ({ lastRunAt: new Date(Date.now() - 48 * HOUR).toISOString() }),
    runOnce: async () => ({ ok: true }),
    log: { info() {}, warn() {}, error() {} },
  });
  s.start();
  await new Promise((r) => setTimeout(r, 60));
  s.stop();
  assert.equal(s.timer, undefined, "stop 后不应留句柄");
});

await checkAsync("stop() 后到点不再触发", async () => {
  let runs = 0;
  const s = new BackupScheduler({
    getConfig: async () => ({ enabled: true, intervalHours: 12, startupMinIntervalMs: 0, startupRunOnBoot: false }),
    getState: async () => ({ lastRunAt: new Date(Date.now() - 48 * HOUR).toISOString() }),
    runOnce: async () => {
      runs++;
      return { ok: true };
    },
    log: { info() {}, warn() {}, error() {} },
  });
  s.start();
  s.stop();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(runs, 0, "stop 后不应再跑");
});

/* ------------------------------------------------------------------ */
console.log(`\nscheduler-smoke: 通过 ${passed} / 失败 ${failed}`);
if (failed > 0) {
  console.log("\n失败明细：");
  for (const f of failures) console.log(`  - ${f.name}\n      ${f.err && f.err.stack ? f.err.stack.split("\n").slice(0, 3).join("\n      ") : f.err}`);
  process.exit(1);
}
