/**
 * Multi-Account Pool & Automatic Quota Failover
 */

import fs from 'fs';
import path from 'path';
import { TokenManager } from './token-manager.mjs';
import { isLicensed, hasLicense } from './license.mjs';

export class AccountPool {
  constructor(accountsDir) {
    this.accountsDir = accountsDir;
    this.managers = new Map(); // email -> TokenManager
    this.activeEmail = '';
    this.init();
  }

  init() {
    if (!fs.existsSync(this.accountsDir)) {
      fs.mkdirSync(this.accountsDir, { recursive: true });
    }
    const files = fs.readdirSync(this.accountsDir);
    for (const f of files) {
      if (f.endsWith('.json')) {
        const filePath = path.join(this.accountsDir, f);
        const tm = new TokenManager(filePath);
        if (tm.tokenData.email) {
          this.managers.set(tm.tokenData.email, tm);
          if (!this.activeEmail) this.activeEmail = tm.tokenData.email;
        }
      }
    }
  }

  addAccount(refreshToken, email, projectId = '') {
    const filename = `${email.replace(/[^a-zA-Z0-9]/g, '_')}.json`;
    const filePath = path.join(this.accountsDir, filename);
    const tm = new TokenManager(filePath);
    tm.setRefreshToken(refreshToken, email);
    if (projectId) tm.tokenData.projectId = projectId;
    const prev = this.managers.get(email);
    if (prev && prev.tokenData.license && !tm.tokenData.license) { tm.tokenData.license = prev.tokenData.license; tm.save(); }
    if (prev && prev.tokenData.boundCode && !tm.tokenData.boundCode) {
      tm.tokenData.boundCode = prev.tokenData.boundCode; tm.tokenData.boundName = prev.tokenData.boundName || ''; tm.save();
    }
    this.managers.set(email, tm);
    if (!this.activeEmail || !this.managers.has(this.activeEmail)) this.activeEmail = email; // 不抢占当前主控账号
    return tm;
  }

  switchAccount(email) {
    if (this.managers.has(email)) {
      this.activeEmail = email;
      console.log(`[AccountPool] 手动切换活跃账号 ➔ ${email}`);
      return this.getActiveManager();
    }
    return null;
  }

  removeAccount(email) {
    if (this.managers.has(email)) {
      this.managers.delete(email);
      const filename = `${email.replace(/[^a-zA-Z0-9]/g, '_')}.json`;
      const filePath = path.join(this.accountsDir, filename);
      if (fs.existsSync(filePath)) {
        try { fs.unlinkSync(filePath); } catch (e) {}
      }
      if (this.activeEmail === email) {
        this.activeEmail = this.managers.size > 0 ? this.managers.keys().next().value : '';
      }
      return true;
    }
    return false;
  }

  clearAccounts() {
    this.managers.clear();
    this.activeEmail = '';
    if (fs.existsSync(this.accountsDir)) {
      const files = fs.readdirSync(this.accountsDir);
      for (const f of files) {
        if (f.endsWith('.json')) {
          try { fs.unlinkSync(path.join(this.accountsDir, f)); } catch (e) {}
        }
      }
    }
  }

  getActiveManager() {
    if (this.managers.size === 0) return null;
    if (this.activeEmail && this.managers.has(this.activeEmail)) {
      return this.managers.get(this.activeEmail);
    }
    const first = this.managers.values().next().value;
    this.activeEmail = first.tokenData.email;
    return first;
  }

  /** 按授权码 ID 找绑定的账号 */
  findBound(codeId) {
    if (!codeId) return null;
    for (const [email, tm] of this.managers.entries()) if (tm.tokenData.boundCode === codeId) return email.toLowerCase();
    return null;
  }

  bind(email, codeId, name = '') {
    const tm = this.getManager(email); if (!tm) return false;
    for (const other of this.managers.values()) if (other !== tm && other.tokenData.boundCode === codeId) { other.tokenData.boundCode = ''; other.tokenData.boundName = ''; other.save(); }
    tm.tokenData.boundCode = codeId; tm.tokenData.boundName = name || ''; tm.save();
    return true;
  }

  unbind(email) {
    const tm = this.getManager(email); if (!tm) return false;
    tm.tokenData.boundCode = ''; tm.tokenData.boundName = ''; tm.save();
    return true;
  }

  getManager(email) {
    if (!email) return this.getActiveManager();
    const clean = email.trim().toLowerCase();
    // 严格匹配：查不到就返回 null，绝不静默回退到其他账号（防止串号）
    if (this.managers.has(clean)) return this.managers.get(clean);
    return null;
  }

  rotateToNext() {
    if (this.managers.size <= 1) return null;
    const emails = Array.from(this.managers.keys()).filter(e => e === this.activeEmail || isLicensed(this.managers.get(e)));
    if (emails.length <= 1) return null;
    const currentIndex = emails.indexOf(this.activeEmail);
    const nextIndex = (currentIndex + 1) % emails.length;
    this.activeEmail = emails[nextIndex];
    console.log(`[AccountPool] 触发账号池轮换 ➔ 已切换至: ${this.activeEmail}`);
    return this.getActiveManager();
  }

  getAllStatus() {
    const list = [];
    for (const [email, tm] of this.managers.entries()) {
      list.push({
        email,
        isActive: email === this.activeEmail,
        boundCode: tm.tokenData.boundCode || '',
        boundName: tm.tokenData.boundName || '',
        licensed: isLicensed(tm),
        has_license: hasLicense(tm),
        ...tm.getStatus(),
      });
    }
    return list;
  }
}
