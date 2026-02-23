import * as vscode from 'vscode';
import Anthropic from '@anthropic-ai/sdk';
import { LLMProvider, ModelInput, Token } from './provider';
import { extractErrorMessage } from '../utils/errorUtils';

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
                  media_type: mimeType as any,
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

    try {
      const systemContent =
        input.systemPrompt +
        '\n\nImportant: You must strictly return ONLY a JSON object evaluating the tools. No preamble.';

      const stream = await this.client.messages.create({
        model: 'claude-3-5-sonnet-latest',
        max_tokens: 4000,
        system: systemContent,
        messages: messages,
        stream: true,
      });

      cancelToken.onCancellationRequested(() => {
        stream.controller.abort();
      });

      for await (const chunk of stream) {
        if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
          yield { text: chunk.delta.text, isFinished: false };
        }
      }
      yield { text: '', isFinished: true };
    } catch (error: any) {
      console.error('Anthropic API Error:', error);
      const cleanMessage = extractErrorMessage(error);
      yield {
        text: JSON.stringify({
          reasoning: `API Error: ${cleanMessage}`,
          isFinished: true,
          finalAnswer: `I encountered an API error: ${cleanMessage}`,
        }),
        isFinished: true,
      };
    }
  }
}
