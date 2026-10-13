/**
 * Real-time SSE Protocol Streamer (Google Chunked Stream -> Anthropic SSE Stream)
 */

import crypto from 'crypto';
import { signatureCache, FALLBACK_THOUGHT_SIGNATURE } from './signature-cache.mjs';

/**
 * 将 Google 的流式输出逐块解析并转换为 Anthropic 标准 Server-Sent Events 事件
 */
export async function handleStreamConversion(upstreamRes, clientRes, originalModel, onFinish = null) {
  clientRes.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  clientRes.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  clientRes.setHeader('Connection', 'keep-alive');
  clientRes.flushHeaders?.();

  const messageId = `msg_${crypto.randomBytes(12).toString('hex')}`;
  let blockIndex = 0;
  let currentBlockType = null; // 'thinking' | 'text' | null
  let hasEmittedStart = false;
  let stopReason = 'end_turn';

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;

  let latestSeenSignature = FALLBACK_THOUGHT_SIGNATURE;
  let thinkingHasSignature = false;

  const sendEvent = (event, data) => {
    clientRes.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const closeCurrentBlock = () => {
    if (currentBlockType !== null) {
      if (currentBlockType === 'thinking' && !thinkingHasSignature) {
        sendEvent('content_block_delta', {
          type: 'content_block_delta',
          index: blockIndex,
          delta: {
            type: 'signature_delta',
            signature: latestSeenSignature || FALLBACK_THOUGHT_SIGNATURE,
          },
        });
        thinkingHasSignature = true;
      }

      sendEvent('content_block_stop', {
        type: 'content_block_stop',
        index: blockIndex,
      });
      blockIndex++;
      currentBlockType = null;
      thinkingHasSignature = false;
    }
  };

  const reader = upstreamRes.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let jsonStr = trimmed;
        if (jsonStr.startsWith('data:')) {
          jsonStr = jsonStr.slice(5).trim();
        }
        if (!jsonStr || jsonStr === '[DONE]') continue;

        let chunk;
        try {
          chunk = JSON.parse(jsonStr);
        } catch (e) {
          continue;
        }

        const inner = chunk.response || chunk;
        if (inner.usageMetadata) {
          inputTokens = inner.usageMetadata.promptTokenCount || inputTokens;
          outputTokens = inner.usageMetadata.candidatesTokenCount || outputTokens;
          cacheReadTokens = inner.usageMetadata.cachedContentTokenCount || cacheReadTokens;
        }

        const candidate = inner?.candidates?.[0];
        const parts = candidate?.content?.parts || [];

        // 1. 发送 message_start 事件
        if (!hasEmittedStart && parts.length > 0) {
          hasEmittedStart = true;
          sendEvent('message_start', {
            type: 'message_start',
            message: {
              id: messageId,
              type: 'message',
              role: 'assistant',
              content: [],
              model: originalModel,
              stop_reason: null,
              stop_sequence: null,
              usage: {
                input_tokens: Math.max(0, inputTokens - cacheReadTokens),
                output_tokens: 1,
                cache_read_input_tokens: cacheReadTokens,
                cache_creation_input_tokens: 0,
              },
            },
          });
        }

        // 2. 遍历各 part 分段处理
        for (const part of parts) {
          const sig = part.thoughtSignature || part.thought_signature;
          if (sig) {
            latestSeenSignature = sig;
          }

          if (part.text !== undefined) {
            const isThought = part.thought === true;
            const targetType = isThought ? 'thinking' : 'text';

            if (currentBlockType !== targetType) {
              closeCurrentBlock();
              currentBlockType = targetType;
              sendEvent('content_block_start', {
                type: 'content_block_start',
                index: blockIndex,
                content_block: isThought
                  ? { type: 'thinking', thinking: '' }
                  : { type: 'text', text: '' },
              });
            }

            if (part.text) {
              sendEvent('content_block_delta', {
                type: 'content_block_delta',
                index: blockIndex,
                delta: isThought
                  ? { type: 'thinking_delta', thinking: part.text }
                  : { type: 'text_delta', text: part.text },
              });
            }

            if (isThought && sig) {
              sendEvent('content_block_delta', {
                type: 'content_block_delta',
                index: blockIndex,
                delta: { type: 'signature_delta', signature: sig },
              });
              thinkingHasSignature = true;
            }
          } else if (part.functionCall) {
            closeCurrentBlock();
            stopReason = 'tool_use';
            const callId = part.functionCall.id || `toolu_${crypto.randomBytes(12).toString('hex')}`;
            const actualSig = sig || latestSeenSignature || FALLBACK_THOUGHT_SIGNATURE;

            signatureCache.set(callId, actualSig, part.functionCall.name);

            sendEvent('content_block_start', {
              type: 'content_block_start',
              index: blockIndex,
              content_block: {
                type: 'tool_use',
                id: callId,
                name: part.functionCall.name,
                input: {},
              },
            });

            const argsStr = JSON.stringify(part.functionCall.args || {});
            sendEvent('content_block_delta', {
              type: 'content_block_delta',
              index: blockIndex,
              delta: {
                type: 'input_json_delta',
                partial_json: argsStr,
              },
            });

            closeCurrentBlock();
          }
        }
      }
    }

    closeCurrentBlock();

    // 3. 终结事件
    sendEvent('message_delta', {
      type: 'message_delta',
      delta: {
        stop_reason: stopReason,
        stop_sequence: null,
      },
      usage: {
        output_tokens: outputTokens || 1,
      },
    });

    sendEvent('message_stop', {
      type: 'message_stop',
    });

    if (typeof onFinish === 'function') {
      onFinish({
        input_tokens: Math.max(0, inputTokens - cacheReadTokens),
        output_tokens: outputTokens || 1,
        cached_tokens: cacheReadTokens,
      });
    }

    clientRes.end();
  } catch (err) {
    console.error('[Stream Processing Error]', err);
    try {
      clientRes.end();
    } catch (e) {}
  }
}
