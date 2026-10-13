/**
 * Ultra-Simple License Manager (纯粹的一密钥绑一账号)
 *
 * 极简商业逻辑：
 * 1. 密钥格式随你定（比如：AG-123456，甚至任意字符串）
 * 2. 谁先用这个密钥绑定他的 Google 账号，这个密钥就彻底归这个账号所有
 * 3. 其他账号再用这个密钥直接被拒；没有密钥的账号无法调用
 */

import fs from 'fs';
import path from 'path';

export class LicenseManager {
  constructor(storageDir) {
    this.storageDir = storageDir;
    this.dataFile = path.join(storageDir, 'licenses.json');
    this.configFile = path.join(storageDir, 'license-config.json');
    this.bindings = {}; // { [apiKey]: boundEmail }
    this.enforced = false; // 默认为关闭强制鉴权（开放模式），防止误伤已有用户
    this.ensureStorage();
    this.load();
  }

  ensureStorage() {
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }
    if (!fs.existsSync(this.dataFile)) {
      fs.writeFileSync(this.dataFile, JSON.stringify({}, null, 2), 'utf-8');
    }
    if (!fs.existsSync(this.configFile)) {
      fs.writeFileSync(this.configFile, JSON.stringify({ enforced: false }, null, 2), 'utf-8');
    }
  }

  load() {
    try {
      if (fs.existsSync(this.dataFile)) {
        this.bindings = JSON.parse(fs.readFileSync(this.dataFile, 'utf-8'));
      }
      if (fs.existsSync(this.configFile)) {
        const cfg = JSON.parse(fs.readFileSync(this.configFile, 'utf-8'));
        this.enforced = Boolean(cfg.enforced);
      }
    } catch (e) {
      this.bindings = {};
    }
  }

  save() {
    try {
      fs.writeFileSync(this.dataFile, JSON.stringify(this.bindings, null, 2), 'utf-8');
    } catch (e) {}
  }

  /**
   * 开关强制鉴权模式 (开 = 所有账号必须绑卡才能调用；关 = 开放模式，任何人可直接用)
   */
  setEnforced(flag) {
    this.enforced = Boolean(flag);
    try {
      fs.writeFileSync(this.configFile, JSON.stringify({ enforced: this.enforced }, null, 2), 'utf-8');
      console.log(`[LicenseManager] 强制鉴权模式已${this.enforced ? '开启' : '关闭'}（实时热生效）`);
    } catch (e) {}
    return this.enforced;
  }

  isEnforced() {
    return this.enforced;
  }

  /**
   * 批量添加/生成可用密钥
   */
  addKeys(keys) {
    keys.forEach(k => {
      const cleanKey = k.trim();
      if (!this.bindings[cleanKey]) {
        this.bindings[cleanKey] = null; // null 表示尚未绑定任何账号
      }
    });
    this.save();
  }

  /**
   * 绑定密钥与 Google 邮箱 (一个密钥强绑定一个账号)
   */
  bindKey(key, email) {
    if (!key || !email) return { ok: false, message: '密钥和账号不能为空' };
    const cleanKey = key.trim();
    const cleanEmail = email.trim().toLowerCase();

    // 如果密钥不存在于数据库中，提示无效
    if (!(cleanKey in this.bindings)) {
      return { ok: false, message: '无效的密钥，请先在发卡网购买' };
    }

    const currentOwner = this.bindings[cleanKey];

    // 如果该密钥已经被其他账号绑定
    if (currentOwner && currentOwner !== cleanEmail) {
      return { ok: false, message: `该密钥已被账号 (${currentOwner}) 绑定，严禁一卡多用！` };
    }

    // 绑定成功
    this.bindings[cleanKey] = cleanEmail;
    this.save();
    return { ok: true, message: '绑定成功！该密钥已与您的账号永久绑定' };
  }

  /**
   * 鉴权：检查该邮箱或密钥是否合法
   */
  checkAuthorization(email, key = null) {
    if (!email) return { authorized: false, reason: '未识别到 Google 账号' };
    const cleanEmail = email.trim().toLowerCase();

    // 如果传了 key，检查 key 是否匹配
    if (key && (key in this.bindings)) {
      const owner = this.bindings[key];
      if (!owner) {
        // 自动绑定
        this.bindings[key] = cleanEmail;
        this.save();
        return { authorized: true };
      }
      return owner === cleanEmail
        ? { authorized: true }
        : { authorized: false, reason: '该密钥已被其他账号绑定' };
    }

    // 检查该邮箱是否已有绑定的密钥
    for (const [k, bound] of Object.entries(this.bindings)) {
      if (bound === cleanEmail) {
        return { authorized: true, key: k };
      }
    }

    return { authorized: false, reason: '该账号尚未绑定有效密钥，请先输入密钥绑定' };
  }

  getAll() {
    return this.bindings;
  }
}
