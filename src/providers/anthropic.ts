import * as vscode from 'vscode';
import Anthropic from '@anthropic-ai/sdk';
import { CogentoTimeoutError, LLMProvider, ModelInput, Token } from './provider';

export class AnthropicProvider implements LLMProvider {
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async *generate(input: ModelInput, cancelToken: vscode.CancellationToken): AsyncIterable<Token> {
    const messages: Anthropic.MessageParam[] = [];

    // Anthropic requires strictly alternating roles, user -> assistant.
    // For MVP, if there are sequential same-role messages or multiple system messages, we map them directly (assuming correct input format from Planner)
    for (const msg of input.messages) {
      if (msg.role !== 'system') {
        if (typeof msg.content === 'string') {
          messages.push({
            role: msg.role === 'assistant' ? 'assistant' : 'user',
            content: msg.content,
          });
        } else {
          // It's a multimodal array
          const blocks: Anthropic.ContentBlockParam[] = msg.content.map((part) => {
            if (part.type === 'text') {
              return { type: 'text', text: part.text || '' };
            } else if (part.type === 'image_url' && part.image_url) {
              // parse data:image/png;base64,...
              const [prefix, base64] = part.image_url.url.split(',');
              const mimeType = prefix.replace('data:', '').replace(';base64', '');
              return {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
                  data: base64,
                },
              };
            }
            return { type: 'text', text: '' };
          });

          messages.push({
            role: 'user', // Images usually come from user
            content: blocks,
          });
        }
      }
    }

    let timeoutOccurred = false;
    let timeoutId: NodeJS.Timeout | null = null;
    const controller = new AbortController();

    const resetTimeout = () => {
      if (timeoutId) clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        timeoutOccurred = true;
        controller.abort();
      }, 60000);
    };

    cancelToken.onCancellationRequested(() => {
      if (timeoutId) clearTimeout(timeoutId);
      controller.abort();
    });

    try {
      const systemContent =
        input.systemPrompt +
        '\n\nImportant: You must strictly return ONLY a JSON object evaluating the tools. No preamble.';

      resetTimeout();
      const model =
        vscode.workspace.getConfiguration('cogento').get<string>('anthropicModel') ??
        'claude-sonnet-4-5';
      const stream = await this.client.messages.create(
        {
          model,
          max_tokens: 4000,
          system: systemContent,
          messages: messages,
          stream: true,
        },
        { signal: controller.signal },
      );

      for await (const chunk of stream) {
        resetTimeout();
        if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
          yield { text: chunk.delta.text, isFinished: false };
        }
      }
      if (timeoutId) clearTimeout(timeoutId);
      yield { text: '', isFinished: true };
    } catch (err: unknown) {
      if (timeoutId) clearTimeout(timeoutId);
      const e = err as Error;
      const isAbort =
        e.name === 'AbortError' || (e.message && e.message.toLowerCase().includes('abort'));

      if (isAbort) {
        if (cancelToken.isCancellationRequested) {
          return;
        }
        if (timeoutOccurred) {
          throw new CogentoTimeoutError();
        }
      }
      console.error('Anthropic API Error:', err);
      throw err;
    }
  }
}
