/**
 * Bidirectional Protocol Converter (Anthropic <-> Google Cloud Code)
 *
 * 针对长上下文、深度思考（Thinking）与多轮工具调用的完整加固版本
 */

import crypto from 'crypto';
import { signatureCache, FALLBACK_THOUGHT_SIGNATURE } from './signature-cache.mjs';
import { scrubIdentity } from './scrub.mjs';
import { sanitizeSchema } from './schema-sanitizer.mjs';

/**
 * 转换 Anthropic Request 为 Google Cloud Code / Gemini Request
 */
export function convertAnthropicToGoogle(anthropicRequest) {
  let systemInstruction = null;

  // 1. 处理 System Prompt 并清洗竞品标识
  if (anthropicRequest.system) {
    let sysText = '';
    if (typeof anthropicRequest.system === 'string') {
      sysText = anthropicRequest.system;
    } else if (Array.isArray(anthropicRequest.system)) {
      sysText = anthropicRequest.system.map(p => p.text || '').join('\n');
    }
    // 注意：严禁修改 System Prompt 中的稳定前缀，避免破坏 Google 上下文哈希导致缓存击穿
    if (sysText.trim()) {
      systemInstruction = {
        role: 'user',
        parts: [{ text: sysText }],
      };
    }
  }

  // 提前预扫描整个对话历史中的所有 tool_use，构建 call_id -> name 映射表
  const toolNameMap = new Map();
  for (const msg of anthropicRequest.messages || []) {
    if (Array.isArray(msg.content)) {
      for (const item of msg.content) {
        if (item.type === 'tool_use' && item.id && item.name) {
          toolNameMap.set(item.id, item.name);
        }
      }
    }
  }

  // 2. 遍历历史消息并构建严格符合 Google 规范的 parts
  const rawContents = [];

  for (const msg of anthropicRequest.messages || []) {
    const role = msg.role === 'assistant' ? 'model' : 'user';
    const parts = [];

    if (typeof msg.content === 'string') {
      if (msg.content.length > 0) {
        parts.push({ text: msg.content });
      }
    } else if (Array.isArray(msg.content)) {
      for (const item of msg.content) {
        if (item.type === 'text') {
          if (item.text) parts.push({ text: item.text });
        } else if (item.type === 'thinking') {
          // 仅当思考块有文本时保留，附带合法思考签名
          if (item.thinking) {
            parts.push({
              thought: true,
              text: item.thinking,
              thoughtSignature: item.signature || FALLBACK_THOUGHT_SIGNATURE,
            });
          }
        } else if (item.type === 'tool_use') {
          // Assistant 工具调用：Google 强制要求携带 thoughtSignature
          const callId = item.id;
          const sig = signatureCache.get(callId) || FALLBACK_THOUGHT_SIGNATURE;
          parts.push({
            thoughtSignature: sig,
            functionCall: {
              name: item.name,
              args: item.input || {},
              id: item.id,
            },
          });
        } else if (item.type === 'tool_result') {
          // User 工具返回结果：确保 name 与之前的 functionCall 完全一致
          const toolCallId = item.tool_use_id;
          const actualName = item.name || toolNameMap.get(toolCallId) || signatureCache.getName(toolCallId) || 'tool_response';
          
          let responseContent = item.content;
          if (typeof responseContent !== 'string') {
            responseContent = JSON.stringify(responseContent);
          }

          parts.push({
            functionResponse: {
              name: actualName,
              response: {
                output: responseContent,
                content: responseContent,
              },
            },
          });
        } else if (item.type === 'image' && item.source?.data) {
          parts.push({
            inlineData: {
              mimeType: item.source.media_type || 'image/jpeg',
              data: item.source.data,
            },
          });
        }
      }
    }

    if (parts.length > 0) {
      rawContents.push({ role, parts });
    }
  }

  // 3. 规范化 contents：合并连续相同角色，确保以 user 开头
  const contents = [];
  for (const item of rawContents) {
    if (contents.length > 0 && contents[contents.length - 1].role === item.role) {
      // 连续相同 role，合并其 parts
      contents[contents.length - 1].parts.push(...item.parts);
    } else {
      contents.push(item);
    }
  }

  // 确保第一条消息必须是 user 角色
  if (contents.length > 0 && contents[0].role === 'model') {
    contents.unshift({
      role: 'user',
      parts: [{ text: '' }],
    });
  }

  // 4. 处理工具声明 (Tools) 并清洗 Schema (按工具名排序固化，保护前缀缓存哈希)
  let tools = undefined;
  if (anthropicRequest.tools && anthropicRequest.tools.length > 0) {
    const sortedTools = [...anthropicRequest.tools].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    const functionDeclarations = sortedTools.map(t => ({
      name: t.name,
      description: t.description || '',
      parameters: sanitizeSchema(t.input_schema || {}),
    }));
    tools = [{ functionDeclarations }];
  }

  return {
    contents,
    systemInstruction,
    tools,
  };
}

/**
 * 将非流式 Google 响应转为 Anthropic Message
 */
export function convertGoogleToAnthropic(googleData, originalModel) {
  const responseObj = googleData?.response || googleData;
  const candidate = responseObj?.candidates?.[0];
  const parts = candidate?.content?.parts || [];
  const anthropicContent = [];

  let stopReason = 'end_turn';

  for (const part of parts) {
    const sig = part.thoughtSignature || part.thought_signature;

    if (part.thought) {
      anthropicContent.push({
        type: 'thinking',
        thinking: part.text || '',
        signature: sig || FALLBACK_THOUGHT_SIGNATURE,
      });
    } else if (part.text !== undefined && part.text !== '') {
      anthropicContent.push({
        type: 'text',
        text: part.text,
      });
    }

    if (part.functionCall) {
      stopReason = 'tool_use';
      const callId = part.functionCall.id || `toolu_${crypto.randomBytes(12).toString('hex')}`;
      if (sig) {
        signatureCache.set(callId, sig, part.functionCall.name);
      } else {
        signatureCache.set(callId, FALLBACK_THOUGHT_SIGNATURE, part.functionCall.name);
      }

      anthropicContent.push({
        type: 'tool_use',
        id: callId,
        name: part.functionCall.name,
        input: part.functionCall.args || {},
      });
    }
  }

  // 兜底：如果内容为空，补一个空文本块防止下游客户端解析崩溃
  if (anthropicContent.length === 0) {
    anthropicContent.push({ type: 'text', text: '' });
  }

  const usageMeta = responseObj?.usageMetadata || {};
  const promptTokens = usageMeta.promptTokenCount || 0;
  const candidatesTokens = usageMeta.candidatesTokenCount || 0;
  const cachedTokens = usageMeta.cachedContentTokenCount || 0;

  return {
    id: `msg_${crypto.randomBytes(12).toString('hex')}`,
    type: 'message',
    role: 'assistant',
    model: originalModel,
    content: anthropicContent,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: Math.max(0, promptTokens - cachedTokens),
      output_tokens: candidatesTokens,
      cache_read_input_tokens: cachedTokens,
      cache_creation_input_tokens: 0,
    },
  };
}
