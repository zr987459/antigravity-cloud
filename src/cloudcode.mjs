/**
 * Google Cloud Code / Antigravity Dispatcher
 */

import { convertAnthropicToGoogle } from './content-converter.mjs';

// 模型别名与降级链映射表 (当 Claude 3P 配额耗尽时，无缝降级到 Gemini 旗舰以防中断)
export const MODEL_FALLBACK_CHAINS = {
  'gemini-3.8-flash-fast': ['gemini-2.5-flash', 'gemini-3.8-flash-tiered'],
  'gemini-3.8-flash-high': ['gemini-3.8-flash-tiered', 'gemini-3.6-flash-high', 'gemini-2.5-flash-thinking'],
  'gemini-3.8-flash': ['gemini-3.8-flash-tiered', 'gemini-2.5-flash'],
  'gemini-3.1-pro-high': ['gemini-3.1-pro-low', 'gemini-2.5-pro'],
  'claude-opus-4-6': ['claude-opus-4-6-thinking', 'claude-sonnet-4-6', 'gemini-3.8-flash-tiered'],
  'claude-sonnet-4-6': ['claude-opus-4-6-thinking', 'gemini-3.8-flash-tiered'],
};

// 官方底层模型标识映射
export function mapToUpstreamModel(clientModel = '') {
  const m = clientModel.toLowerCase();
  if (m.includes('flash-fast')) return 'gemini-2.5-flash';
  if (m.includes('3.8-flash')) return 'gemini-3.8-flash-tiered';
  if (m.includes('3.6-flash')) return 'gemini-3.6-flash-high';
  if (m.includes('3.1-pro')) return 'gemini-3.1-pro-high';
  if (m.includes('2.5-flash')) return 'gemini-2.5-flash-thinking';
  if (m.includes('claude-opus')) return 'claude-opus-4-6-thinking';
  if (m.includes('claude-sonnet')) return 'claude-sonnet-4-6';
  return clientModel;
}

export function buildAntigravityHeaders(accessToken) {
  return {
    'Authorization': `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'User-Agent': 'antigravity/1.10.2 linux/arm64',
    'X-Client-Name': 'antigravity',
    'Connection': 'keep-alive',
  };
}

// 递归对对象属性按字母排序（Canonical JSON 规范化，确保字节流序列化 100% 幂等一致）
export function canonicalize(obj) {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(canonicalize);
  }
  const sortedKeys = Object.keys(obj).sort();
  const result = {};
  for (const key of sortedKeys) {
    result[key] = canonicalize(obj[key]);
  }
  return result;
}

export function buildCloudCodePayload(anthropicRequest) {
  const { contents, systemInstruction, tools } = convertAnthropicToGoogle(anthropicRequest);
  const upstreamModel = mapToUpstreamModel(anthropicRequest.model);
  const hasTools = Boolean(tools && tools.length > 0);

  const generationConfig = {
    maxOutputTokens: anthropicRequest.max_tokens || 8192,
    temperature: anthropicRequest.temperature ?? 0.7,
  };

  // 思考模式配置 (支持 Anthropic Extended Thinking 规范及模型自带思考)
  const isHighReasoning = anthropicRequest.model && (
    anthropicRequest.model.includes('high') ||
    anthropicRequest.model.includes('thinking') ||
    anthropicRequest.model.includes('opus')
  );

  // 工具调用极速派发优化：
  // 1. 若客户端显式声明了 thinking.type === 'enabled'，尊重客户端设定的思考预算
  // 2. 若存在工具调用 (hasTools) 但客户端未显式要求长思考，则将 thinkingBudget 设为 0（关闭工具前冗余思考），实现毫秒级工具派发
  // 3. 纯文本对话且为思考模型时，分配适度预算 (Sonnet 1024, 其余 2048)
  if (anthropicRequest.thinking && anthropicRequest.thinking.type === 'enabled') {
    const budget = anthropicRequest.thinking.budget_tokens || 2048;
    generationConfig.thinkingConfig = {
      includeThoughts: true,
      thinkingBudget: budget,
    };
  } else if (hasTools) {
    // 工具调用模式：禁用冗长前置思考，模型直接秒派发 tool_use
    generationConfig.thinkingConfig = {
      includeThoughts: false,
      thinkingBudget: 0,
    };
  } else if (isHighReasoning) {
    const isSonnet = anthropicRequest.model.includes('sonnet');
    generationConfig.thinkingConfig = {
      includeThoughts: true,
      thinkingBudget: isSonnet ? 1024 : 2048,
    };
  }

  // 极速模式：当指定 fast 时压缩思考预算为 0，达成毫秒级秒出字
  if (anthropicRequest.model && anthropicRequest.model.includes('fast')) {
    generationConfig.thinkingConfig = {
      thinkingBudget: 0,
    };
  }

  const request = {
    contents,
    generationConfig,
  };

  if (systemInstruction) {
    request.systemInstruction = systemInstruction;
  }
  if (hasTools) {
    request.tools = tools;
    // 注入 Google 工具派发模式 (Claude 采用 VALIDATED 模式，Gemini 采用 AUTO 模式)
    const isClaude = Boolean(anthropicRequest.model && anthropicRequest.model.toLowerCase().includes('claude'));
    request.toolConfig = {
      functionCallingConfig: {
        mode: isClaude ? 'VALIDATED' : 'AUTO',
      },
    };
  }

  return {
    model: upstreamModel,
    request: canonicalize(request),
  };
}
