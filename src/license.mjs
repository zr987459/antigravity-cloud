/**
 * App 授权码（Ed25519 签名，按 Google 账号签发）
 *
 * - 只有持有私钥的管理员（你的 Render 后台）能签发：code = AG-<签名>，签的是账号邮箱
 * - App 里只内置公钥：能验真伪，造不出新码；一个码只对一个邮箱有效，换号无效
 * - 环境变量 LICENSE_MODE=app 时（安卓独立版），没授权的账号不能调用模型
 */
import crypto from 'crypto';
import fs from 'fs';

const PUBLIC_KEY_DER_B64 = 'MCowBQYDK2VwAyEAIxKn+jZOcmIzbEOgnsymWiT72BatAl0+G5D9kWRPVW4=';
const publicKey = crypto.createPublicKey({ key: Buffer.from(PUBLIC_KEY_DER_B64, 'base64'), format: 'der', type: 'spki' });

const msgFor = email => Buffer.from('ag-lic-v1:' + String(email || '').trim().toLowerCase());

export const licenseMode = () => process.env.LICENSE_MODE === 'app';

export function verifyLicense(email, code) {
  try {
    const c = String(code || '').trim();
    if (!email || !c.startsWith('AG-')) return false;
    const sig = Buffer.from(c.slice(3), 'base64url');
    if (sig.length !== 64) return false;
    return crypto.verify(null, msgFor(email), publicKey, sig);
  } catch (e) { return false; }
}

// ---------------- 在线租约 ----------------
// 总后台按「邮箱 + 设备」签发 7 天有效的租约，App 每 10 分钟续一次；管理员吊销后续不上，离线最多再用到租约到期。
export const DEVICE_ID = String(process.env.AG_DEVICE || '').slice(0, 64);
const LEASE_DAYS = 7;
const leaseMsg = payload => Buffer.from('ag-lease-v1:' + payload);

export function issueLease(email, device) {
  if (!privateKey) throw new Error('这台服务器没有签发私钥');
  const payload = Buffer.from(JSON.stringify({ e: String(email).trim().toLowerCase(), d: String(device || '').slice(0, 64), x: Date.now() + LEASE_DAYS * 86400000 })).toString('base64url');
  return 'AGL-' + payload + '.' + crypto.sign(null, leaseMsg(payload), privateKey).toString('base64url');
}

const leaseCache = new Map(); // lease -> { e, d, x } | null
export function readLease(lease) {
  const c = String(lease || '');
  if (leaseCache.has(c)) return leaseCache.get(c);
  let out = null;
  try {
    if (c.startsWith('AGL-')) {
      const dot = c.lastIndexOf('.');
      const payload = c.slice(4, dot), sig = Buffer.from(c.slice(dot + 1), 'base64url');
      if (sig.length === 64 && crypto.verify(null, leaseMsg(payload), publicKey, sig)) out = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
    }
  } catch (e) { out = null; }
  if (leaseCache.size > 200) leaseCache.clear();
  leaseCache.set(c, out);
  return out;
}
export function verifyLease(email, lease, device = DEVICE_ID) {
  const p = readLease(lease);
  return Boolean(p && p.e === String(email || '').trim().toLowerCase() && p.d === device && Date.now() < p.x);
}

/** 账号是否可用：非 App 模式一律可用；App 模式必须有对得上邮箱的授权码 + 未过期的在线租约 */
export function isLicensed(tm) {
  if (!licenseMode()) return true;
  const d = tm && tm.tokenData || {};
  return verifyLicense(d.email, d.license) && verifyLease(d.email, d.lease);
}
/** 只看授权码（不看租约），用于续租 */
export function hasLicense(tm) {
  const d = tm && tm.tokenData || {};
  return verifyLicense(d.email, d.license);
}

let privateKey = null;
export function loadSigner(keysFile) {
  try {
    let pem = process.env.LICENSE_PRIVATE_KEY || '';
    if (!pem && fs.existsSync(keysFile)) pem = JSON.parse(fs.readFileSync(keysFile, 'utf-8')).license_private_key || '';
    if (pem) privateKey = crypto.createPrivateKey(pem.replace(/\\n/g, '\n'));
  } catch (e) { console.error('[License] 私钥加载失败:', e.message); }
  return Boolean(privateKey);
}
export const canIssue = () => Boolean(privateKey);

export function issueLicense(email) {
  if (!privateKey) throw new Error('这台服务器没有签发私钥');
  const e = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new Error('邮箱格式不对');
  return 'AG-' + crypto.sign(null, msgFor(e), privateKey).toString('base64url');
}

// ---------------- 授权码（邀请码）自动激活 ----------------
// 管理员生成 AGI-xxxx 发给朋友；朋友在 App 里填入，App 联网到总后台激活，
// 总后台把这个码锁定到他的邮箱，并签回该邮箱的 App 授权（AG-...），之后离线可用。

export const HOME_URL = process.env.AG_HOME_URL || 'https://antigravity-gateway-it14.onrender.com';
const INVITE_DAYS = 7;

export function issueInvite(note = '') {
  if (!privateKey) throw new Error('这台服务器没有签发私钥');
  const payload = Buffer.from(JSON.stringify({
    i: crypto.randomBytes(6).toString('hex'),
    n: String(note || '').slice(0, 40),
    x: Date.now() + INVITE_DAYS * 864e5,
  })).toString('base64url');
  const sig = crypto.sign(null, Buffer.from('ag-inv-v1:' + payload), privateKey).toString('base64url');
  return `AGI-${payload}.${sig}`;
}

export function verifyInvite(code) {
  try {
    const c = String(code || '').trim();
    if (!c.startsWith('AGI-')) return null;
    const dot = c.lastIndexOf('.');
    const payload = c.slice(4, dot), sig = Buffer.from(c.slice(dot + 1), 'base64url');
    if (sig.length !== 64 || !crypto.verify(null, Buffer.from('ag-inv-v1:' + payload), publicKey, sig)) return null;
    const p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
    return p && p.i ? p : null;
  } catch (e) { return null; }
}

/** 总后台的 App 用户登记（内存 + 本地文件；重部署后由 App 心跳自动补回） */
export class AppRegistry {
  constructor(file) {
    this.file = file;
    this.byInvite = new Map(); // inviteId -> { invite_id, email, note, activated, last_seen, version }
    try { for (const u of JSON.parse(fs.readFileSync(file, 'utf-8'))) this.byInvite.set(u.invite_id, u); } catch (e) {}
  }
  save() { try { fs.writeFileSync(this.file, JSON.stringify([...this.byInvite.values()], null, 2)); } catch (e) {} }
  ownerOf(id) { return this.byInvite.get(id)?.email || ''; }
  bind(id, email, note, extra = {}) {
    const prev = this.byInvite.get(id) || {};
    this.byInvite.set(id, { ...prev, invite_id: id, email, note: note ?? prev.note ?? '', activated: prev.activated || Date.now(), last_seen: Date.now(), ...extra });
    this.save();
  }
  list() { return [...this.byInvite.values()].sort((a, b) => (b.last_seen || 0) - (a.last_seen || 0)); }
  isRevoked(email, id) {
    const e = String(email || '').toLowerCase();
    return [...this.byInvite.values()].some(u => u.revoked && (u.email === e || (id && u.invite_id === id)));
  }
  setRevoked(id, on) {
    const u = this.byInvite.get(id); if (!u) return false;
    u.revoked = Boolean(on); u.revoked_at = on ? Date.now() : undefined;
    this.save(); return true;
  }
}
