import type {
  ContentBlock,
  InteractionRequestPayload,
  InteractionResponse,
} from '../messaging/protocol';

export function interactionResultContent(response: InteractionResponse): ContentBlock[] {
  const value =
    response.kind === 'submit'
      ? { status: 'submitted', value: response.value }
      : response.kind === 'timeout'
        ? { status: 'timed_out', value: response.value }
        : { status: 'cancelled', note: response.note };
  return [{ type: 'text', text: JSON.stringify(value) }];
}

export function interactionResultProvenance(
  request: InteractionRequestPayload,
): 'user' | 'tool' | 'mcp' {
  if (request.kind === 'watch_page' || request.kind === 'schedule') return 'tool';
  if (request.kind === 'mcp_elicitation') return 'mcp';
  return 'user';
}
