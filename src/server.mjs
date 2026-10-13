/**
 * Antigravity Cloud Gateway Server (Clean Cloud Edition)
 *
 * 专为云端高可用部署（Render / Koyeb / Docker）打造的轻量代理中枢：
 * 1. 兼容 Anthropic Messages API (/v1/messages)，支持 Gemini 3.8 / 2.5 及 Claude 3P 模型
 * 2. 深度思考 (Thinking) 与思考签名 (Thought Signature) 智能补全
 * 3. 实时官方配额探测 (/api/gemini/quota)
 * 4. 多账号池无缝轮换与故障转移
 * 5. 纯净极简，零冗余插件，超低内存占用 (< 30MB)
 */

import http from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { AccountPool } from './account-pool.mjs';
import { signatureCache } from './signature-cache.mjs';
import { OAuthFlowManager } from './oauth-flow.mjs';
import { runConnectivityTest } from './test-runner.mjs';
import { fetchRealQuota } from './quota-fetcher.mjs';
import { getModelsResponse } from './models-catalog.mjs';
import { statsTracker } from './stats.mjs';
import { ANTIGRAVITY_ENDPOINTS, ANTIGRAVITY_ENDPOINT_DAILY } from './constants.mjs';
import { AccessControl } from './access-control.mjs';
import { Persist } from './persist.mjs';
import { licenseMode, isLicensed, hasLicense, issueLease, verifyLease, DEVICE_ID, verifyLicense, loadSigner, canIssue, issueLicense, issueInvite, verifyInvite, AppRegistry, HOME_URL } from './license.mjs';
import {
  buildAntigravityHeaders,
  buildCloudCodePayload,
  MODEL_FALLBACK_CHAINS,
} from './cloudcode.mjs';
import { convertGoogleToAnthropic } from './content-converter.mjs';
import { handleStreamConversion } from './sse-streamer.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8790;
// 永久保存：启动时先从 GitHub state 分支恢复账号/绑定/授权码
const persist = new Persist(path.join(__dirname, '..', 'data'));
await persist.restore();
const accountPool = new AccountPool(path.join(__dirname, '..', 'data', 'accounts'));
persist.snapshot();
for (const m of ['addAccount', 'removeAccount', 'clearAccounts', 'bind', 'unbind']) {
  const orig = accountPool[m].bind(accountPool);
  accountPool[m] = (...args) => { const r = orig(...args); persist.schedule(); return r; };
}
const oauthFlowManager = new OAuthFlowManager(accountPool);
const access = new AccessControl(path.join(__dirname, '..', 'data', 'keys.json'));
loadSigner(path.join(__dirname, '..', 'data', 'keys.json'));
const appRegistry = new AppRegistry(path.join(__dirname, '..', 'data', 'app-users.json'));
{ const o = appRegistry.save.bind(appRegistry); appRegistry.save = () => { o(); persist.schedule(); }; }
const APP_VERSION_FILE = path.join(__dirname, '..', 'public', 'app-version.json');
const APP_INTEGRITY_FILE = path.join(__dirname, '..', 'public', 'app-integrity.json');

// App 模式：定时向总后台报到 + 续租（同步账号到管理员后台；被吊销的账号立刻失效）
const ATTEST = { cert: String(process.env.AG_ATT_CERT || ''), hash: String(process.env.AG_ATT_HASH || '') };
async function appHeartbeat() {
  if (!licenseMode()) return;
  const mgrs = Array.from(accountPool.managers.values()).filter(hasLicense);
  if (!mgrs.length) return;
  const accounts = mgrs.map(tm => ({ email: tm.tokenData.email, license: tm.tokenData.license, invite_id: tm.tokenData.inviteId || '', note: tm.tokenData.inviteNote || '' }));
  const body = JSON.stringify({ accounts, version: process.env.APP_VERSION || '', device: DEVICE_ID, att: ATTEST });
  try {
    await fetch(HOME_URL + '/api/app/ping', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    const r = await fetch(HOME_URL + '/api/app/lease', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    const d = await r.json().catch(() => null);
    if (!d || !d.ok) return;
    for (const tm of mgrs) {
      const e = tm.tokenData.email;
      if ((d.revoked || []).includes(e)) {
        delete tm.tokenData.license; delete tm.tokenData.lease; tm.save();
        console.log('[License] 账号已被管理员吊销:', e);
        continue;
      }
      const lease = d.leases && d.leases[e];
      if (lease && verifyLease(e, lease) && lease !== tm.tokenData.lease) { tm.tokenData.lease = lease; tm.save(); }
    }
  } catch (e) {}
}
if (licenseMode()) { setTimeout(appHeartbeat, 1500); setInterval(appHeartbeat, 10 * 60 * 1000); }
access.findBound = id => accountPool.findBound(id);
{ const origSave = access.save.bind(access); access.save = () => { origSave(); persist.schedule(); }; }

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function denyAdmin(res) {
  sendJson(res, 401, { ok: false, need_admin: true, error: '需要管理密钥' });
}
// 仅管理员可访问的接口
const ADMIN_PATHS = new Set([
  '/api/status', '/api/stats', '/api/logs', '/api/logs/clear', '/api/gemini/test', '/api/gemini/auth',
  '/api/oauth/exchange', '/api/oauth/token-exchange', '/api/accounts/add-token', '/api/accounts/switch',
  '/api/accounts/remove', '/api/keys', '/api/keys/create', '/api/keys/revoke', '/api/accounts/bind', '/api/accounts/unbind', '/api/accounts/license', '/api/license/issue', '/api/license/invite', '/api/app/users', '/api/app/users/revoke', '/api/accounts/restore',
]);
function readBody(req) {
  return new Promise(resolve => { let b = ''; req.on('data', c => (b += c)); req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (e) { resolve({}); } }); });
}
const dashboardHtmlPath = path.join(__dirname, 'dashboard.html');
const tokenHtmlPath = path.join(__dirname, 'token-page.html');

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, x-admin-key, anthropic-version');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // 1. 控制台主页
  if (url.pathname === '/' || url.pathname === '/index.html') {
    if (fs.existsSync(dashboardHtmlPath)) {
      const html = fs.readFileSync(dashboardHtmlPath, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
  }

  // 1.1 Token 专属提取页面 (/token, /get-token)
  if (url.pathname === '/token' || url.pathname === '/get-token' || url.pathname === '/token.html') {
    if (fs.existsSync(tokenHtmlPath)) {
      const html = fs.readFileSync(tokenHtmlPath, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
  }

  // 1.5 云端 / 本地主端口直接接管 OAuth 回调（标准 RFC 8252 Desktop 客户端回调始终使用 localhost:51121 换票）
  if (url.pathname === '/oauth-callback') {
    const code = url.searchParams.get('code');
    const redirectUri = `http://localhost:${oauthFlowManager.fixedPort}/oauth-callback`;
    const result = await oauthFlowManager.processCallbackCode(code, redirectUri);
    res.writeHead(result.status, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(result.html);
    return;
  }

  // 1.55 App 下载（APK 由 CI 提交到 public/Antigravity.apk）
  if (url.pathname === '/app.apk' || url.pathname === '/app') {
    const k = url.searchParams.get('k') || '';
    const apk = path.join(__dirname, '..', 'public', 'Antigravity.apk');
    if (!fs.existsSync(apk)) { sendJson(res, 404, { error: 'APK 还没生成' }); return; }
    const st = fs.statSync(apk);
    res.writeHead(200, {
      'Content-Type': 'application/vnd.android.package-archive',
      'Content-Length': st.size,
      'Content-Disposition': 'attachment; filename="Antigravity.apk"',
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(apk).pipe(res);
    return;
  }

  // 1.6 公开健康检查（不暴露账号）
  if (url.pathname === '/health') {
    sendJson(res, 200, { ok: true, app: 'antigravity-gateway', version: '3.1.0', auth: access.enabled });
    return;
  }

  // 1.65 App 公共接口（总后台）：版本、激活、心跳
  if (url.pathname === '/api/app/version') {
    let v = {};
    try { v = JSON.parse(fs.readFileSync(APP_VERSION_FILE, 'utf-8')); } catch (e) {}
    sendJson(res, 200, { ok: true, ...v, url: '/app.apk' });
    return;
  }
  if (url.pathname === '/api/app/activate' && req.method === 'POST') {
    const { invite, email } = await readBody(req);
    const e = String(email || '').trim().toLowerCase();
    let p = verifyInvite(invite);
    const ak = String(invite || '').trim();
    if (!p && ak.startsWith('ak-')) {
      const q = access.verify(ak);
      if (q && !(access.revoked && access.revoked.has(ak))) p = { i: 'ak:' + AccessControl.codeId(ak), n: q.n || '' };
    }
    if (!canIssue()) { sendJson(res, 400, { ok: false, error: '总后台未开启签发' }); return; }
    if (!p || !e) { sendJson(res, 400, { ok: false, error: '授权码不对' }); return; }
    const owner = appRegistry.ownerOf(p.i);
    if (owner && owner !== e) { sendJson(res, 409, { ok: false, error: '这个授权码已经被别的账号用了' }); return; }
    if (!owner && p.x && Date.now() > p.x) { sendJson(res, 400, { ok: false, error: '授权码已过期，请找管理员重新生成' }); return; }
    if (appRegistry.isRevoked(e, p.i)) { sendJson(res, 403, { ok: false, error: '这个授权已被管理员吊销' }); return; }
    appRegistry.bind(p.i, e, p.n || '');
    sendJson(res, 200, { ok: true, license: issueLicense(e), invite_id: p.i, note: p.n || '' });
    return;
  }
  if (url.pathname === '/api/app/restore' && req.method === 'POST') {
    const { email } = await readBody(req);
    const e = String(email || '').trim().toLowerCase();
    const hit = e && appRegistry.list().find(u => u.email === e);
    if (!hit || hit.revoked || appRegistry.isRevoked(e) || !canIssue()) { sendJson(res, 404, { ok: false }); return; }
    sendJson(res, 200, { ok: true, license: issueLicense(e), invite_id: hit.invite_id, note: hit.note || '' });
    return;
  }
  if (url.pathname === '/api/app/lease' && req.method === 'POST') {
    const { accounts, version, device, att } = await readBody(req);
    if (!canIssue()) { sendJson(res, 400, { ok: false, error: '总后台未开启签发' }); return; }
    // 安装包核验：证书必须是官方签名，代码哈希必须和该版本的官方构建一致
    let official = {};
    try { official = JSON.parse(fs.readFileSync(APP_INTEGRITY_FILE, 'utf-8')); } catch (e) {}
    const a = att || {};
    const v = String(version || '');
    if ((official.cert && a.cert !== official.cert) || (official.hashes && official.hashes[v] && ![].concat(official.hashes[v]).includes(a.hash))) {
      console.warn('[License] 非官方安装包请求续租，已拒绝:', v, String(a.cert || '').slice(0, 12), String(a.hash || '').slice(0, 12));
      sendJson(res, 403, { ok: false, tamper: true, error: '安装包不是官方版本' }); return;
    }
    const dev = String(device || '').slice(0, 64);
    const leases = {}, revoked = [];
    for (const x of Array.isArray(accounts) ? accounts.slice(0, 20) : []) {
      const e = String(x.email || '').trim().toLowerCase();
      if (!verifyLicense(e, x.license)) continue;
      if (appRegistry.isRevoked(e, x.invite_id)) { revoked.push(e); continue; }
      leases[e] = issueLease(e, dev);
    }
    sendJson(res, 200, { ok: true, leases, revoked });
    return;
  }
  if (url.pathname === '/api/app/ping' && req.method === 'POST') {
    const body = await readBody(req);
    const { accounts, version } = body;
    for (const a of Array.isArray(accounts) ? accounts.slice(0, 20) : []) {
      const e = String(a.email || '').trim().toLowerCase();
      if (!verifyLicense(e, a.license)) continue;
      const id = String(a.invite_id || 'email:' + e).slice(0, 40);
      const owner = appRegistry.ownerOf(id);
      if (owner && owner !== e) continue;
      appRegistry.bind(id, e, a.note ? String(a.note).slice(0, 40) : undefined, { version: String(version || '').slice(0, 20), device: String(body.device || '').slice(0, 12) });
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  // 1.7 管理接口鉴权
  if (ADMIN_PATHS.has(url.pathname) && !access.isAdmin(req)) {
    denyAdmin(res);
    return;
  }

  // 1.8 授权码管理
  if (url.pathname === '/api/keys') {
    const keys = access.list().map(k => ({ ...k, bound: k.email || accountPool.findBound(AccessControl.codeId(k.key)) || '' }));
    sendJson(res, 200, { ok: true, enabled: access.enabled, has_admin: Boolean(access.adminKey), keys });
    return;
  }
  if (url.pathname === '/api/keys/create' && req.method === 'POST') {
    const { name } = await readBody(req);
    const entry = access.create(name);
    sendJson(res, 200, { ok: true, key: entry });
    return;
  }
  if (url.pathname === '/api/keys/revoke' && req.method === 'POST') {
    const { key } = await readBody(req);
    sendJson(res, 200, { ok: access.revoke(key) });
    return;
  }

  if (url.pathname === '/api/license/invite' && req.method === 'POST') {
    const { note } = await readBody(req);
    try { sendJson(res, 200, { ok: true, code: issueInvite(note) }); }
    catch (e) { sendJson(res, 400, { ok: false, error: e.message }); }
    return;
  }
  if (url.pathname === '/api/app/users') {
    sendJson(res, 200, { ok: true, users: appRegistry.list() });
    return;
  }
  if (url.pathname === '/api/app/users/revoke' && req.method === 'POST') {
    const { invite_id, revoked } = await readBody(req);
    sendJson(res, 200, { ok: appRegistry.setRevoked(String(invite_id || ''), revoked !== false) });
    return;
  }

  // App 授权码：管理员签发（只有带私钥的服务器能签）
  if (url.pathname === '/api/license/issue' && req.method === 'POST') {
    const { email } = await readBody(req);
    try { sendJson(res, 200, { ok: true, email: String(email || '').trim().toLowerCase(), code: issueLicense(email) }); }
    catch (e) { sendJson(res, 400, { ok: false, error: e.message }); }
    return;
  }

  // App 授权码：给本机账号激活
  if (url.pathname === '/api/accounts/restore' && req.method === 'POST') {
    const { email } = await readBody(req);
    const tm = Array.from(accountPool.managers.values()).find(t => t.tokenData.email === email);
    if (!tm) { sendJson(res, 404, { ok: false }); return; }
    if (isLicensed(tm)) { sendJson(res, 200, { ok: true }); return; }
    if (hasLicense(tm)) { await appHeartbeat(); sendJson(res, 200, { ok: isLicensed(tm), restored: isLicensed(tm) }); return; }
    try {
      const r = await fetch(HOME_URL + '/api/app/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
      const d = await r.json().catch(() => ({}));
      if (d.ok && verifyLicense(tm.tokenData.email, d.license)) {
        tm.tokenData.license = d.license; tm.tokenData.inviteId = d.invite_id || ''; tm.tokenData.inviteNote = d.note || ''; tm.save();
        await appHeartbeat();
        sendJson(res, 200, { ok: true, restored: true }); return;
      }
    } catch (e) {}
    sendJson(res, 200, { ok: false });
    return;
  }
  if (url.pathname === '/api/accounts/license' && req.method === 'POST') {
    const { email, code } = await readBody(req);
    const tm = accountPool.getManager(String(email || ''));
    if (!tm) { sendJson(res, 400, { ok: false, error: '账号不存在' }); return; }
    const c = String(code || '').trim();
    if (c.startsWith('AGI-') || c.startsWith('ak-')) {
      try {
        const r = await fetch(HOME_URL + '/api/app/activate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ invite: c, email: tm.tokenData.email }) });
        const d = await r.json().catch(() => ({}));
        if (!d.ok || !verifyLicense(tm.tokenData.email, d.license)) { sendJson(res, 400, { ok: false, error: d.error || '激活失败' }); return; }
        tm.tokenData.license = d.license; tm.tokenData.inviteId = d.invite_id || ''; tm.tokenData.inviteNote = d.note || ''; tm.save();
        await appHeartbeat();
        sendJson(res, 200, { ok: true });
      } catch (e) { sendJson(res, 502, { ok: false, error: '连不上总后台，检查网络后再试（总后台休眠时第一次可能要等半分钟）' }); }
      return;
    }
    if (!verifyLicense(tm.tokenData.email, c)) { sendJson(res, 400, { ok: false, error: '授权码不对，或不是给这个账号的' }); return; }
    tm.tokenData.license = c; tm.save();
    await appHeartbeat();
    sendJson(res, 200, { ok: true });
    return;
  }

  if (url.pathname === '/api/accounts/bind' && req.method === 'POST') {
    const { email, key } = await readBody(req);
    const k = String(key || '').trim();
    const p = access.verify(k);
    if (!p || p.e) { sendJson(res, 400, { ok: false, error: '授权码不对' }); return; }
    if (!accountPool.getManager(email)) { sendJson(res, 400, { ok: false, error: '账号不存在' }); return; }
    if (!access.keys.find(x => x.key === k)) { access.keys.push({ key: k, email: '', name: p.n || '', created: new Date(p.t || Date.now()).toISOString(), source: 'file' }); access.save(); }
    accountPool.bind(email, AccessControl.codeId(k), p.n || '');
    sendJson(res, 200, { ok: true });
    return;
  }
  if (url.pathname === '/api/accounts/unbind' && req.method === 'POST') {
    const { email } = await readBody(req);
    sendJson(res, 200, { ok: accountPool.unbind(email) });
    return;
  }

  // 1.9 调用方自查：授权码对应的账号
  if (url.pathname === '/api/me') {
    const who = access.resolve(req);
    if (!who) { sendJson(res, 401, { ok: false, error: '授权码无效' }); return; }
    if (who.role === 'unbound') { sendJson(res, 403, { ok: false, error: '授权码还没绑定账号' }); return; }
    sendJson(res, 200, { ok: true, role: who.role, email: who.email || null, name: who.name || null });
    return;
  }

  // 2. 真实配额接口 (/api/gemini/quota)
  if (url.pathname === '/api/gemini/quota') {
    const who = access.resolve(req);
    if (!who || who.role === 'unbound') { sendJson(res, 401, { ok: false, error: '需要授权码或管理密钥' }); return; }
    let mgr;
    if (who.role === 'user') mgr = accountPool.getManager(who.email);
    else {
      const email = url.searchParams.get('email');
      mgr = email ? accountPool.getManager(email) : accountPool.getActiveManager();
      mgr = mgr || accountPool.getActiveManager();
    }
    const quotaData = await fetchRealQuota(mgr);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(quotaData));
    return;
  }

  // 3. 统计数据与日志
  if (url.pathname === '/api/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(statsTracker.getStats(), null, 2));
    return;
  }

  if (url.pathname === '/api/logs') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(statsTracker.getAllLogs(100)));
    return;
  }

  if (url.pathname === '/api/logs/clear' && req.method === 'POST') {
    statsTracker.clearAllLogs();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // 4. 模型列表接口
  if (url.pathname === '/v1/models' || url.pathname === '/models' || url.pathname === '/api/models') {
    const catalog = getModelsResponse();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(catalog, null, 2));
    return;
  }

  // 5. 服务状态
  if (url.pathname === '/api/status') {
    const activeMgr = accountPool.getActiveManager();
    const host = req.headers.host || '';
    const status = {
      app: 'antigravity-gateway',
      version: '3.1.0',
      auth_enabled: access.enabled,
      port: PORT,
      auth_url: oauthFlowManager.getAuthUrl(host),
      active_account: activeMgr ? activeMgr.getStatus() : null,
      accounts: accountPool.getAllStatus(),
      stats: statsTracker.getStats(),
      signature_cache_size: signatureCache.size(),
      persist: persist.status(),
      license_mode: licenseMode() ? 'app' : '',
      can_issue: canIssue(),
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status, null, 2));
    return;
  }

  // 6. 出字测速
  if (url.pathname === '/api/gemini/test' && req.method === 'POST') {
    const activeMgr = accountPool.getActiveManager();
    const testResult = await runConnectivityTest(activeMgr, accountPool);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(testResult));
    return;
  }

  // 7. OAuth 授权链接
  if (url.pathname === '/api/gemini/auth' && req.method === 'POST') {
    const host = req.headers.host || '';
    const authUrl = oauthFlowManager.getAuthUrl(host);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      auth_url: authUrl,
      message: '授权链接已就绪',
    }));
    return;
  }

  // 8. 手动回贴回调 URL 或 Code 换票入池
  if (url.pathname === '/api/oauth/exchange' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', async () => {
      try {
        const { code_or_url } = JSON.parse(body);
        if (!code_or_url) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: '请粘贴回调 URL 或 Code' }));
          return;
        }
        const tokenResult = await oauthFlowManager.exchangeRawInput(code_or_url);
        if (tokenResult.refreshToken && tokenResult.email) {
          accountPool.addAccount(tokenResult.refreshToken, tokenResult.email);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          message: `账号 ${tokenResult.email} 授权成功并加入账号池！`,
          email: tokenResult.email,
          refreshToken: tokenResult.refreshToken,
        }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // 8.5 专门提取 Token 的 API (给 /token 页面使用)
  if (url.pathname === '/api/oauth/token-exchange' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', async () => {
      try {
        const { code_or_url } = JSON.parse(body);
        if (!code_or_url) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: '请粘贴回调 URL 或 Code' }));
          return;
        }
        const tokenResult = await oauthFlowManager.exchangeRawInput(code_or_url);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          email: tokenResult.email,
          refreshToken: tokenResult.refreshToken,
          accessToken: tokenResult.accessToken,
        }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // 8.6 直接通过 Refresh Token 添加并激活账号
  if (url.pathname === '/api/accounts/add-token' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', async () => {
      try {
        const { refresh_token, email } = JSON.parse(body);
        if (!refresh_token || !refresh_token.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: '请提供有效的 Refresh Token' }));
          return;
        }
        const result = await oauthFlowManager.validateAndAddRefreshToken(refresh_token);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          message: `账号 ${result.email} 验证通过并已成功加入账号池！`,
          email: result.email,
        }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // 9. 账号切换与管理
  if (url.pathname === '/api/accounts/switch' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      try {
        const { email } = JSON.parse(body);
        accountPool.switchAccount(email);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, message: `已切换至账号 ${email}` }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  if (url.pathname === '/api/accounts/remove' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      try {
        const { email } = JSON.parse(body);
        accountPool.removeAccount(email);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, message: `已移除账号 ${email}` }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // 10. 核心 Anthropic 协议推理接口：/v1/messages
  if (url.pathname === '/v1/messages' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', async () => {
      const startTime = Date.now();
      try {
        const anthropicReq = JSON.parse(body);
        const who = access.resolve(req);
        if (!who) {
          sendJson(res, 401, { type: 'error', error: { type: 'authentication_error', message: '授权码无效或缺失（x-api-key）' } });
          return;
        }
        if (who.role === 'unbound') {
          sendJson(res, 403, { type: 'error', error: { type: 'permission_error', message: '授权码还没绑定账号，请联系管理员' } });
          return;
        }
        // 授权码绑定的账号专用，不会串用其他账号
        let activeMgr = who.role === 'user' ? accountPool.getManager(who.email) : accountPool.getActiveManager();
        if (who.role === 'user' && !activeMgr) {
          sendJson(res, 403, { type: 'error', error: { type: 'permission_error', message: '该授权码绑定的账号已不在账号池，请联系管理员' } });
          return;
        }

        if (activeMgr && who.role !== 'user' && !isLicensed(activeMgr)) {
          activeMgr = Array.from(accountPool.managers.values()).find(isLicensed) || null;
          if (!activeMgr) {
            sendJson(res, 403, { type: 'error', error: { type: 'permission_error', message: '账号还没授权：在 App 里给账号填入授权码后才能使用' } });
            return;
          }
        }

        if (!activeMgr) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: {
              type: 'authentication_error',
              message: '账号池暂无可用 Google 账号，请在控制台添加账号',
            },
          }));
          return;
        }

        let accessToken = await activeMgr.getValidAccessToken();
        const isStreaming = Boolean(anthropicReq.stream);
        let lastFailedDetails = null;

        // 第一优先级直连 daily.sandbox 推理集群
        let response = null;
        try {
          const streamUrl = `${ANTIGRAVITY_ENDPOINT_DAILY}/v1internal:streamGenerateContent?alt=sse`;
          const nonStreamUrl = `${ANTIGRAVITY_ENDPOINT_DAILY}/v1internal:generateContent`;
          const targetUrl = isStreaming ? streamUrl : nonStreamUrl;

          response = await fetch(targetUrl, {
            method: 'POST',
            headers: buildAntigravityHeaders(accessToken),
            body: JSON.stringify(buildCloudCodePayload(anthropicReq)),
          });
        } catch (e) {
          lastFailedDetails = { status: 500, body: e.message };
        }

        // 若 daily.sandbox 异常，再轮询 fallback 集群
        if (!response || !response.ok) {
          const executeAttempt = async (modelToUse) => {
            const reqCopy = { ...anthropicReq, model: modelToUse };
            const payload = buildCloudCodePayload(reqCopy);
            const headers = buildAntigravityHeaders(accessToken);

            for (const host of ANTIGRAVITY_ENDPOINTS) {
              const upstreamEndpoint = isStreaming
                ? `${host}/v1internal:streamGenerateContent?alt=sse`
                : `${host}/v1internal:generateContent`;

              try {
                const res = await fetch(upstreamEndpoint, {
                  method: 'POST',
                  headers,
                  body: JSON.stringify(payload),
                });
                if (res.ok) return res;

                const errText = await res.text().catch(() => '');
                lastFailedDetails = { status: res.status, body: errText };
              } catch (e) {
                lastFailedDetails = { status: 500, body: e.message };
              }
            }
            return null;
          };

          response = await executeAttempt(anthropicReq.model);

          if (!response || !response.ok) {
            const fallbacks = MODEL_FALLBACK_CHAINS[anthropicReq.model] || [];
            for (const fallbackModel of fallbacks) {
              response = await executeAttempt(fallbackModel);
              if (response && response.ok) break;
            }
          }
        }

        if (!response || !response.ok) {
          const errDetail = lastFailedDetails ? lastFailedDetails.body : 'Google 集群无响应';
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: {
              type: 'upstream_error',
              message: errDetail,
            },
          }));
          statsTracker.recordRequest({
            model: anthropicReq.model,
            latency_ms: Date.now() - startTime,
            status: 502,
            error: errDetail.slice(0, 100),
          });
          return;
        }

        const totalLatency = Date.now() - startTime;

        if (isStreaming) {
          await handleStreamConversion(response, res, anthropicReq.model, (usage) => {
            statsTracker.recordRequest({
              model: anthropicReq.model,
              latency_ms: Date.now() - startTime,
              status: 200,
              is_stream: true,
              input_tokens: usage.input_tokens,
              output_tokens: usage.output_tokens,
              cached_tokens: usage.cached_tokens,
            });
          });
        } else {
          const googleData = await response.json();
          const anthropicResp = convertGoogleToAnthropic(googleData, anthropicReq.model);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(anthropicResp));

          statsTracker.recordRequest({
            model: anthropicReq.model,
            latency_ms: totalLatency,
            status: 200,
            is_stream: false,
            input_tokens: anthropicResp.usage?.input_tokens || 0,
            output_tokens: anthropicResp.usage?.output_tokens || 0,
            cached_tokens: anthropicResp.usage?.cache_read_input_tokens || 0,
          });
        }
      } catch (err) {
        console.error('[Messages Handler Error]', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: {
            type: 'api_error',
            message: err.message,
          },
        }));
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Endpoint not found' }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Antigravity Cloud Gateway (v3.1.0) 运行在 http://0.0.0.0:${PORT}`);
});
