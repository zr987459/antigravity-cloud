/**
 * Access control: one admin key for the dashboard, one access key per Google account.
 *
 * Sources (merged):
 *   data/keys.json   { "admin_key": "...", "keys": [ { "key": "ak-...", "email": "a@gmail.com", "name": "小王" } ] }
 *   env ADMIN_KEY    overrides admin_key
 *   env ACCESS_KEYS  extra keys, "key1:email1:name1,key2:email2"
 *
 * Keys created in the dashboard are signed with the admin key (HMAC), so they keep working
 * after a restart even though Render's free disk resets. The dashboard list and revocations made
 * at runtime are kept in data/keys.json, which resets on restart; to make a revocation permanent,
 * add the key to "revoked" in the repo's data/keys.json. Changing admin_key invalidates all signed keys.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export class AccessControl {
  constructor(file) {
    this.file = file;
    this.adminKey = '';
    this.keys = []; // { key, email, name, created, source }
    this.load();
  }

  load() {
    let data = {};
    try { if (fs.existsSync(this.file)) data = JSON.parse(fs.readFileSync(this.file, 'utf-8')); }
    catch (e) { console.error('[Access] keys.json 解析失败:', e.message); }
    this.adminKey = (process.env.ADMIN_KEY || data.admin_key || '').trim();
    this.revoked = new Set((Array.isArray(data.revoked) ? data.revoked : []).map(String));
    this.keys = (Array.isArray(data.keys) ? data.keys : [])
      .filter(k => k && k.key)
      .map(k => ({ key: String(k.key).trim(), email: String(k.email || '').trim().toLowerCase(), name: k.name || '', created: k.created || '', source: 'file' }));
    for (const part of (process.env.ACCESS_KEYS || '').split(',')) {
      const [key, email, name] = part.split(':').map(s => (s || '').trim());
      if (key && email && !this.keys.find(k => k.key === key)) {
        this.keys.push({ key, email: email.toLowerCase(), name: name || '', created: '', source: 'env' });
      }
    }
  }

  save() {
    const fileKeys = this.keys.filter(k => k.source === 'file').map(({ key, email, name, created }) => ({ key, email, name, created }));
    let data = {};
    try { if (fs.existsSync(this.file)) data = JSON.parse(fs.readFileSync(this.file, 'utf-8')); } catch (e) {}
    data.keys = fileKeys;
    data.revoked = Array.from(this.revoked);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(data, null, 2), 'utf-8');
  }

  /** 是否启用鉴权：配置了管理密钥或任意访问密钥 */
  get enabled() { return Boolean(this.adminKey) || this.keys.length > 0; }

  static safeEqual(a, b) {
    const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  }

  static keyFromRequest(req) {
    const h = req.headers || {};
    if (h['x-api-key']) return String(h['x-api-key']).trim();
    const auth = String(h['authorization'] || '');
    if (/^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim();
    return '';
  }

  isAdmin(req) {
    if (!this.enabled) return true; // 未配置任何密钥时保持旧行为
    if (!this.adminKey) return false;
    const k = String(req.headers['x-admin-key'] || '').trim() || AccessControl.keyFromRequest(req);
    return Boolean(k) && AccessControl.safeEqual(k, this.adminKey);
  }

  /** 解析调用方：{ role: 'admin' } | { role: 'user', email, name } | null */
  resolve(req) {
    if (!this.enabled) return { role: 'open' };
    if (this.isAdmin(req)) return { role: 'admin' };
    const k = AccessControl.keyFromRequest(req);
    if (!k) return null;
    if (this.revoked.has(k)) return null;
    const hit = this.keys.find(x => AccessControl.safeEqual(x.key, k));
    if (hit && hit.email) return { role: 'user', email: hit.email, name: hit.name };
    const signed = this.verify(k);
    if (!signed) return null;
    if (signed.e) return { role: 'user', email: signed.e, name: signed.n || '' }; // 旧版：生成时已指定账号
    const email = this.findBound ? this.findBound(AccessControl.codeId(k)) : null;
    return email ? { role: 'user', email, name: signed.n || '' } : { role: 'unbound', name: signed.n || '' };
  }

  sign(payload) {
    return crypto.createHmac('sha256', this.adminKey).update(payload).digest('base64url').slice(0, 22);
  }

  /** 每个账号固定一个授权码：由管理密钥签名生成，无需存储，重启不变 */
  accountKey(email) {
    const e = String(email).trim().toLowerCase();
    if (!this.adminKey) return '';
    return `agk-${Buffer.from(e).toString('base64url')}.${this.sign('acct:' + e)}`;
  }

  verifyAccountKey(k) {
    if (!this.adminKey) return null;
    const dot = k.lastIndexOf('.');
    if (dot < 5) return null;
    let e;
    try { e = Buffer.from(k.slice(4, dot), 'base64url').toString('utf-8'); } catch (err) { return null; }
    if (!e || !AccessControl.safeEqual(k.slice(dot + 1), this.sign('acct:' + e))) return null;
    return e;
  }

  verify(k) {
    if (!this.adminKey || !k.startsWith('ak-')) return null;
    const dot = k.lastIndexOf('.');
    if (dot < 4) return null;
    const payload = k.slice(3, dot), sig = k.slice(dot + 1);
    if (!AccessControl.safeEqual(sig, this.sign(payload))) return null;
    try { const p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8')); return p && typeof p === 'object' ? p : null; }
    catch (e) { return null; }
  }

  /** 授权码的唯一 ID（签名部分），绑定时记在账号文件里 */
  static codeId(k) { return String(k).slice(String(k).lastIndexOf('.') + 1); }

  list() {
    return this.keys.map(k => ({ key: k.key, email: k.email, name: k.name, created: k.created, source: k.source }));
  }

  /** 生成授权码（先不绑定账号，可提前发给对方；之后在账号上绑定才生效） */
  create(name = '') {
    const e = '';
    const n = String(name || '').slice(0, 40);
    let key;
    if (this.adminKey) {
      const payload = Buffer.from(JSON.stringify({ n, t: Date.now(), r: crypto.randomBytes(3).toString('hex') })).toString('base64url');
      key = `ak-${payload}.${this.sign(payload)}`;
    } else {
      key = 'ak-' + crypto.randomBytes(18).toString('base64url');
    }
    const entry = { key, email: e, name: n, created: new Date().toISOString(), source: 'file' };
    this.keys.push(entry);
    this.save();
    return entry;
  }

  revoke(key) {
    const i = this.keys.findIndex(k => k.key === key && k.source === 'file');
    if (i >= 0) this.keys.splice(i, 1);
    this.revoked.add(key);
    this.save();
    return true;
  }
}
