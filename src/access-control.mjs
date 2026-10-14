/**
 * Access control: a single ADMIN_KEY.
 *
 * The same key logs in to the dashboard and is used by clients as the API key
 * (x-api-key / Authorization: Bearer / x-admin-key).
 * When ADMIN_KEY is not set, the gateway is open (no authentication), as before.
 */
import crypto from 'crypto';

export class AccessControl {
  constructor() {
    this.adminKey = (process.env.ADMIN_KEY || '').trim();
  }

  /** 是否启用鉴权：配置了 ADMIN_KEY */
  get enabled() { return Boolean(this.adminKey); }

  static safeEqual(a, b) {
    const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  }

  static keyFromRequest(req) {
    const h = req.headers || {};
    if (h['x-admin-key']) return String(h['x-admin-key']).trim();
    if (h['x-api-key']) return String(h['x-api-key']).trim();
    const auth = String(h['authorization'] || '');
    if (/^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim();
    return '';
  }

  /** 请求是否带了正确的 ADMIN_KEY（未配置 ADMIN_KEY 时一律放行） */
  isAdmin(req) {
    if (!this.enabled) return true;
    const k = AccessControl.keyFromRequest(req);
    return Boolean(k) && AccessControl.safeEqual(k, this.adminKey);
  }
}
