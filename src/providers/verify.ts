import type { UnifiedMessage } from '../db/sessionContext';
import {
  ProviderError,
  type Connection,
  type ProviderAdapter,
  type ToolSchema,
  type VerifyResult,
  withUniqueToolCallIds,
} from './types';

/** Settings-only connection verification shared by both wire adapters. */
export async function verifyConnection(
  adapter: ProviderAdapter,
  connection: Connection,
): Promise<VerifyResult> {
  const result: VerifyResult = {
    reachable: false,
    keyValid: false,
    streaming: false,
    toolUse: false,
  };

  let models: string[] | undefined;
  if (adapter.listModels) {
    try {
      models = await adapter.listModels();
      result.reachable = true;
      result.models = models;
    } catch (error) {
      if (error instanceof ProviderError && error.kind === 'auth') {
        result.reachable = true;
        result.failure = 'invalid_key';
        result.detail = error.details.upstreamMessage ?? error.message;
        result.details = error.details;
        return result;
      }
    }
  }

  const probeModel = connection.modelIds?.[0] ?? connection.models?.[0]?.id ?? models?.[0];
  if (!probeModel) {
    if (!result.reachable) {
      result.failure = 'unreachable';
      result.detail = 'no /models endpoint and no manual model list configured';
    }
    return result;
  }

  try {
    await adapter
      .stream({
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
        tools: [],
        params: { maxTokens: 1 },
        model: probeModel,
        signal: AbortSignal.timeout(10_000),
      })
      .final();
    result.reachable = true;
    result.keyValid = true;
    result.streaming = true;
  } catch (error) {
    if (error instanceof ProviderError) {
      result.reachable = error.kind !== 'network';
      result.failure =
        error.kind === 'auth'
          ? 'invalid_key'
          : error.kind === 'network'
            ? 'unreachable'
            : 'protocol_mismatch';
      result.detail = error.details.upstreamMessage ?? error.message;
      result.details = error.details;
    } else {
      result.failure = 'unreachable';
      result.detail = error instanceof Error ? error.message : String(error);
    }
    return result;
  }

  try {
    const prompt: UnifiedMessage = {
      role: 'user',
      content: [{ type: 'text', text: 'Call the echo tool with text="hi".' }],
    };
    const tools: ToolSchema[] = [
      {
        name: 'echo',
        description: 'Echo the given text back.',
        parameters: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
        },
      },
    ];
    const final = await adapter
      .stream({
        messages: [prompt],
        tools,
        params: { maxTokens: 64 },
        model: probeModel,
        signal: AbortSignal.timeout(15_000),
      })
      .final();
    if (final.stopReason !== 'tool_use') return result;
    const echoCalls = withUniqueToolCallIds(
      final.toolCalls.filter((call) => call.name === 'echo' && !call.parseError),
    );
    if (echoCalls.length === 0) return result;

    await adapter
      .stream({
        messages: [
          prompt,
          {
            role: 'assistant',
            content: final.message,
            ...(final.reasoning ? { reasoning: final.reasoning } : {}),
            ...(final.providerState ? { providerState: final.providerState } : {}),
            toolCalls: echoCalls,
          },
          ...echoCalls.map((call): UnifiedMessage => ({
            role: 'tool_result',
            toolCallId: call.id,
            content: [{ type: 'text', text: 'hi' }],
            isError: false,
          })),
        ],
        tools,
        params: { maxTokens: 64 },
        model: probeModel,
        signal: AbortSignal.timeout(15_000),
      })
      .final();
    result.toolUse = true;
  } catch {
    result.toolUse = false;
  }

  return result;
}
