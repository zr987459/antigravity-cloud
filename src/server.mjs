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
import {
  buildAntigravityHeaders,
  buildCloudCodePayload,
  MODEL_FALLBACK_CHAINS,
} from './cloudcode.mjs';
import { convertGoogleToAnthropic } from './content-converter.mjs';
import { handleStreamConversion } from './sse-streamer.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8790;
// 永久保存：启动时先从 GitHub state 分支恢复账号
const persist = new Persist(path.join(__dirname, '..', 'data'));
await persist.restore();
const accountPool = new AccountPool(path.join(__dirname, '..', 'data', 'accounts'));
persist.snapshot();
for (const m of ['addAccount', 'removeAccount', 'clearAccounts']) {
  const orig = accountPool[m].bind(accountPool);
  accountPool[m] = (...args) => { const r = orig(...args); persist.schedule(); return r; };
}
const oauthFlowManager = new OAuthFlowManager(accountPool);
const access = new AccessControl();

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function denyAdmin(res) {
  sendJson(res, 401, { ok: false, need_admin: true, error: '需要管理密钥（ADMIN_KEY）' });
}
// 仅管理员可访问的接口
const ADMIN_PATHS = new Set([
  '/api/status', '/api/stats', '/api/logs', '/api/logs/clear', '/api/gemini/test', '/api/gemini/auth',
  '/api/oauth/exchange', '/api/oauth/token-exchange', '/api/accounts/add-token', '/api/accounts/switch',
  '/api/accounts/remove', '/api/gemini/quota',
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

  // 1.7 管理接口鉴权
  if (ADMIN_PATHS.has(url.pathname) && !access.isAdmin(req)) {
    denyAdmin(res);
    return;
  }

  // 2. 真实配额接口 (/api/gemini/quota)
  if (url.pathname === '/api/gemini/quota') {
    const email = url.searchParams.get('email');
    const mgr = (email && accountPool.getManager(email)) || accountPool.getActiveManager();
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
        if (!access.isAdmin(req)) {
          sendJson(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'API Key 无效或缺失（x-api-key 填 ADMIN_KEY）' } });
          return;
        }
        const activeMgr = accountPool.getActiveManager();

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
            email: activeMgr.tokenData.email,
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
              email: activeMgr.tokenData.email,
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
            email: activeMgr.tokenData.email,
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
