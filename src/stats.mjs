/**
 * Multi-Tenant Usage & Telemetry Stats Tracker (按账号完全隔离统计 + 24h/7d 真实趋势)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export class StatsTracker {
  constructor(storageDir) {
    this.storageDir = storageDir;
    this.dataFile = path.join(storageDir, 'user_stats.json');
    this.userStats = {}; // { [email]: { totals..., logs: [], hourly: {}, daily: {} } }
    this.maxLogsPerUser = 80;
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
  }

  load() {
    try {
      if (fs.existsSync(this.dataFile)) {
        this.userStats = JSON.parse(fs.readFileSync(this.dataFile, 'utf-8'));
      }
    } catch (e) {
      this.userStats = {};
    }
  }

  save() {
    try {
      fs.writeFileSync(this.dataFile, JSON.stringify(this.userStats, null, 2), 'utf-8');
    } catch (e) {}
  }

  getUserBucket(email) {
    const key = (email || 'anonymous').trim().toLowerCase();
    if (!this.userStats[key]) {
      this.userStats[key] = {
        total_requests: 0,
        total_tokens: 0,
        input_tokens: 0,
        output_tokens: 0,
        cached_tokens: 0,
        avg_latency_ms: 0,
        logs: [],
        hourly: {}, // { 'YYYY-MM-DD HH': {requests, tokens} }  近 24h
        daily: {},  // { 'YYYY-MM-DD': {requests, tokens} }     近 7d
      };
    }
    const b = this.userStats[key];
    if (!b.hourly) b.hourly = {};
    if (!b.daily) b.daily = {};
    return { key, bucket: b };
  }

  recordRequest({
    email,
    model,
    latency_ms,
    status = 200,
    input_tokens = 0,
    output_tokens = 0,
    cached_tokens = 0,
    is_stream = false,
    error = null,
  }) {
    const { bucket } = this.getUserBucket(email);
    bucket.total_requests++;
    bucket.input_tokens += input_tokens;
    bucket.output_tokens += output_tokens;
    bucket.cached_tokens += cached_tokens;
    bucket.total_tokens = bucket.input_tokens + bucket.output_tokens;
    bucket.avg_latency_ms = latency_ms;

    const now = new Date();
    const timeStr = now.toLocaleTimeString('zh-CN', { hour12: false });
    const tokenTotal = input_tokens + output_tokens;

    // 小时桶（用于 24h 趋势）
    const hourKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}`;
    const h = bucket.hourly[hourKey] || { requests: 0, tokens: 0 };
    h.requests++;
    h.tokens += tokenTotal;
    bucket.hourly[hourKey] = h;

    // 日桶（用于 7d 趋势）
    const dayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const d = bucket.daily[dayKey] || { requests: 0, tokens: 0 };
    d.requests++;
    d.tokens += tokenTotal;
    bucket.daily[dayKey] = d;

    // 桶瘦身：小时桶只留 48 个，日桶只留 14 个
    const hourKeys = Object.keys(bucket.hourly).sort();
    while (hourKeys.length > 48) {
      delete bucket.hourly[hourKeys.shift()];
    }
    const dayKeys = Object.keys(bucket.daily).sort();
    while (dayKeys.length > 14) {
      delete bucket.daily[dayKeys.shift()];
    }

    const logEntry = {
      id: Date.now() + '_' + Math.random().toString(36).substring(2, 6),
      time: timeStr,
      timestamp: Date.now(),
      model,
      latency_ms,
      status,
      tokens: {
        input: input_tokens,
        output: output_tokens,
        cached: cached_tokens,
      },
      is_stream,
      error,
    };

    bucket.logs.unshift(logEntry);
    if (bucket.logs.length > this.maxLogsPerUser) {
      bucket.logs.pop();
    }

    this.save();
  }

  getStats(email = null) {
    if (email) return this.getUserStats(email);
    let totalReqs = 0, totalTokens = 0, inTokens = 0, outTokens = 0, cachedTokens = 0;
    for (const b of Object.values(this.userStats)) {
      totalReqs += (b.total_requests || 0);
      totalTokens += (b.total_tokens || 0);
      inTokens += (b.input_tokens || 0);
      outTokens += (b.output_tokens || 0);
      cachedTokens += (b.cached_tokens || 0);
    }
    return {
      total_requests: totalReqs,
      total_tokens: totalTokens,
      input_tokens: inTokens,
      output_tokens: outTokens,
      cached_tokens: cachedTokens,
      avg_latency_ms: 0,
    };
  }

  getUserStats(email) {
    const { bucket } = this.getUserBucket(email);
    return {
      total_requests: bucket.total_requests,
      total_tokens: bucket.total_tokens,
      input_tokens: bucket.input_tokens,
      output_tokens: bucket.output_tokens,
      cached_tokens: bucket.cached_tokens,
      avg_latency_ms: bucket.avg_latency_ms,
    };
  }

  /**
   * 真实趋势数据（按账号隔离）
   * mode: '24h' => 最近 24 个小时桶; '7d' => 最近 7 天日桶
   */
  getTrendData(email, mode = '24h') {
    const { bucket } = this.getUserBucket(email);
    const now = new Date();
    const labels = [];
    const tokens = [];
    const requests = [];

    if (mode === '7d') {
      for (let i = 6; i >= 0; i--) {
        const t = new Date(now.getTime() - i * 24 * 3600 * 1000);
        const key = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
        labels.push(`${t.getMonth() + 1}/${t.getDate()}`);
        const d = bucket.daily?.[key];
        tokens.push(d?.tokens || 0);
        requests.push(d?.requests || 0);
      }
    } else {
      for (let i = 23; i >= 0; i--) {
        const t = new Date(now.getTime() - i * 3600 * 1000);
        const key = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')} ${String(t.getHours()).padStart(2, '0')}`;
        labels.push(String(t.getHours()).padStart(2, '0') + ':00');
        const h = bucket.hourly?.[key];
        tokens.push(h?.tokens || 0);
        requests.push(h?.requests || 0);
      }
    }

    return { mode, labels, tokens, requests };
  }

  /**
   * 近 7 天真实用量汇总（用于配额面板"7天"条，替代 Google 未开放的周度字段）
   */
  getUserWeekUsage(email) {
    const { bucket } = this.getUserBucket(email);
    const now = new Date();
    let requests = 0, tokens = 0, cached = 0;
    for (let i = 0; i < 7; i++) {
      const t = new Date(now.getTime() - i * 24 * 3600 * 1000);
      const key = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
      const d = bucket.daily?.[key];
      if (d) {
        requests += d.requests;
        tokens += d.tokens;
      }
    }
    // 用今日已发生的请求占 7 天总量的比例，给"7天消耗进度条"一个真实走向
    const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const today = bucket.daily?.[todayKey];
    return {
      requests_7d: requests,
      tokens_7d: tokens,
      requests_today: today?.requests || 0,
      tokens_today: today?.tokens || 0,
    };
  }

  getUserLogs(email) {
    const { bucket } = this.getUserBucket(email);
    return bucket.logs;
  }

  getAllLogs(limit = 100) {
    const all = [];
    for (const [email, b] of Object.entries(this.userStats)) for (const l of b.logs || []) all.push({ ...l, email });
    return all.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)).slice(0, limit);
  }

  clearAllLogs() {
    for (const b of Object.values(this.userStats)) b.logs = [];
    this.save();
  }

  clearUserLogs(email) {
    const { bucket } = this.getUserBucket(email);
    bucket.logs = [];
    this.save();
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const statsTracker = new StatsTracker(path.join(__dirname, '..', 'data'));
