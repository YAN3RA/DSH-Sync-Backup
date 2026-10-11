/**
 * 传输安全判定：凭据**不得经明文 HTTP 发给非本机目标**，且**不得被重定向引导到内网**。
 *
 * WebDAV 走 Basic 认证、GitHub 走 Bearer PAT —— 两者在 http: 下都是明文。
 * 所以在允许 http: 之前必须先回答一个问题：目标是不是本机？
 *
 * 允许的 http: 只有 loopback（127.0.0.0/8、::1、localhost）——
 * 那是本地假服务与自建私服的常规用法，流量不出网卡。其余一律要求 https:，
 * 除非调用方显式传 allowInsecure 且由**用户本人**在界面上确认过风险
 * （本模块只负责判定，不负责拿到那个确认）。
 *
 * 重定向场景（2.2）：`Location` 是**远端给出的输入**，与用户亲手填的 baseUrl
 * 不在同一个信任级别上。一台被攻陷或本身恶意的 WebDAV 服务器只要回一个
 * `302 Location: http://169.254.169.254/...`，就能把「带 Basic 凭据、以本机身份
 * 发出」的请求引去内网或云元数据（SSRF）—— 即使跨源时已经剥掉了 Authorization，
 * 请求本身仍是一次由内到外、命中内网可达性的真实探测。所以每一跳都要复核：
 *   - 目标协议必须仍是 http(s)；
 *   - 云元数据地址一律拒绝（备份客户端没有任何正当理由访问实例元数据）；
 *   - 明文 HTTP 仍只允许本机；
 *   - **公网起点不得被引导到内网/本机**（反向允许：用户自己配的内网服务可以自跳）。
 *
 * 零第三方依赖。
 *
 * @module dsh-sync-backup/lib/transport-guard
 */

/**
 * 云元数据端点（实例身份/临时凭据的来源，是 SSRF 的首要目标）。
 * 这些都是「应答即可读出凭据」的地址，不存在误伤的正当用法。
 */
const METADATA_HOSTS = new Set([
  "169.254.169.254", // AWS / Azure / GCP / OpenStack IMDS
  "169.254.170.2", // AWS ECS task metadata
  "100.100.100.200", // 阿里云
  "fd00:ec2::254", // AWS IMDSv2（IPv6）
  "metadata.google.internal",
]);

/** 归一化主机名：小写、去 IPv6 方括号。 */
function normalizeHost(hostname) {
  return String(hostname ?? "").toLowerCase().replace(/^\[|\]$/g, "");
}

/** 解析点分十进制 IPv4；任一段 >255 或形态不符返回 null。 */
function parseIPv4(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : null;
}

/**
 * 把主机名归类成网络位置。
 *
 * @param {string} hostname
 * @returns {"loopback"|"private"|"link-local"|"metadata"|"public"}
 */
export function classifyHost(hostname) {
  const h = normalizeHost(hostname);
  if (h === "") return "public";
  if (METADATA_HOSTS.has(h)) return "metadata";
  if (h === "localhost" || h.endsWith(".localhost")) return "loopback";

  // v4-mapped IPv6（::ffff:192.168.1.1）按内层 IPv4 判定，否则会被当成陌生公网地址。
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(h);
  const v4 = parseIPv4(mapped ? mapped[1] : h);
  if (v4) {
    const [a, b] = v4;
    if (METADATA_HOSTS.has(`${a}.${b}.${v4[2]}.${v4[3]}`)) return "metadata";
    if (a === 127) return "loopback";
    if (a === 169 && b === 254) return "link-local"; // 169.254.0.0/16
    if (a === 10) return "private";
    if (a === 172 && b >= 16 && b <= 31) return "private";
    if (a === 192 && b === 168) return "private";
    if (a === 100 && b >= 64 && b <= 127) return "private"; // CGNAT 100.64.0.0/10
    if (a === 0) return "private"; // 0.0.0.0/8「本网络」，不是可达目标
    return "public";
  }

  if (h.includes(":")) {
    if (h === "::1" || h === "0:0:0:0:0:0:0:1") return "loopback";
    const first = h.split(":")[0];
    if (/^f[cd][0-9a-f]{0,2}$/.test(first)) return "private"; // fc00::/7 ULA
    if (/^fe[89ab][0-9a-f]?$/.test(first)) return "link-local"; // fe80::/10
    return "public";
  }

  return "public";
}

/** 判断主机名是否指向本机。 */
export function isLoopbackHost(hostname) {
  return classifyHost(hostname) === "loopback";
}

/** 是否为非公网地址（本机 / 私网 / 链路本地）—— 即「SSRF 值得引导过去」的范围。 */
export function isLocalTrustHost(hostname) {
  const k = classifyHost(hostname);
  return k === "loopback" || k === "private" || k === "link-local";
}

/** 是否指向云元数据端点。 */
export function isCloudMetadataHost(hostname) {
  return classifyHost(hostname) === "metadata";
}

/**
 * 校验一个外部目标的传输安全性。
 *
 * @param {string} url 已解析或待解析的绝对 URL
 * @param {{allowInsecure?: boolean, what?: string}} [opts]
 * @returns {{ok:true, loopback:boolean}|{ok:false, problem:string}}
 */
export function checkTransportUrl(url, opts = {}) {
  const what = opts.what ?? "目标地址";
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return { ok: false, problem: `${what} 不是合法 URL` };
  }
  if (parsed.protocol === "https:") return { ok: true, loopback: false };
  if (parsed.protocol !== "http:") {
    return { ok: false, problem: `${what} 的协议必须是 http(s): ${parsed.protocol}` };
  }
  const loopback = isLoopbackHost(parsed.hostname);
  if (loopback) return { ok: true, loopback: true };
  if (opts.allowInsecure === true) return { ok: true, loopback: false };
  return {
    ok: false,
    problem:
      `${what} 使用明文 HTTP 且目标不是本机（${parsed.hostname}）：` +
      "凭据会以明文发送。请改用 https://；仅当目标是本机私有服务时 http:// 才被接受。" +
      "（如确需对非本机使用 http，须由用户显式确认风险）",
  };
}

/**
 * 复验一次重定向的**目标**（逐跳调用）。
 *
 * 与 `checkTransportUrl` 的分工：后者回答「这个地址本身安全吗」，
 * 本函数额外回答「从当前地址跳到它，合不合理」—— 后者才是 SSRF 的判据。
 *
 * @param {string} fromUrl 当前所在 URL
 * @param {string} toUrl   解析后的下一跳 URL
 * @param {{allowInsecure?: boolean, what?: string}} [opts]
 * @returns {{ok:true, loopback:boolean, kind:string}|{ok:false, problem:string}}
 */
export function verifyRedirectTarget(fromUrl, toUrl, opts = {}) {
  const what = opts.what ?? "重定向目标";

  let to;
  try {
    to = new URL(String(toUrl));
  } catch {
    return { ok: false, problem: `${what} 不是合法 URL` };
  }

  if (to.protocol !== "http:" && to.protocol !== "https:") {
    return { ok: false, problem: `${what} 的协议必须是 http(s): ${to.protocol}` };
  }

  // 云元数据：任何起点、任何跳数都不允许（读它即可拿到实例凭据）。
  if (isCloudMetadataHost(to.hostname)) {
    return {
      ok: false,
      problem: `${what}指向云元数据地址（${to.hostname}）：备份客户端没有访问实例元数据的正当理由，拒绝跟随`,
    };
  }

  // 传输安全：明文 HTTP 仍只允许本机（覆盖 HTTPS → 非本机 HTTP 的降级）。
  const transport = checkTransportUrl(to.toString(), { allowInsecure: opts.allowInsecure, what });
  if (!transport.ok) return transport;

  // SSRF：公网起点被引导到内网/本机 —— 反向允许（内网自建服务可以自跳），
  // 因为「用户自己配的内网地址互相跳」是无害的，而「公网服务器把请求导进内网」不是。
  let fromHost = "";
  try {
    fromHost = new URL(String(fromUrl)).hostname;
  } catch {
    fromHost = "";
  }
  const kind = classifyHost(to.hostname);
  if (isLocalTrustHost(to.hostname) && !isLocalTrustHost(fromHost)) {
    return {
      ok: false,
      problem: `${what}从公网地址被引导到内网地址（${to.hostname}）：疑似 SSRF，拒绝跟随`,
    };
  }

  return { ok: true, loopback: transport.loopback === true, kind };
}

export default {
  isLoopbackHost,
  isLocalTrustHost,
  isCloudMetadataHost,
  classifyHost,
  checkTransportUrl,
  verifyRedirectTarget,
};
