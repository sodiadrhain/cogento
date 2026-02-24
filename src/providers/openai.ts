import * as vscode from 'vscode';
import OpenAI from 'openai';
import { CogentoTimeoutError, LLMProvider, ModelInput, Token } from './provider';

export class OpenAIProvider implements LLMProvider {
  private client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey, dangerouslyAllowBrowser: true }); // We run in extension host or webview
  }

  async *generate(input: ModelInput, cancelToken: vscode.CancellationToken): AsyncIterable<Token> {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: input.systemPrompt },
    ];

    for (const msg of input.messages) {
      if (typeof msg.content === 'string') {
        messages.push({
          role: msg.role === 'assistant' ? 'assistant' : msg.role === 'system' ? 'system' : 'user',
          content: msg.content,
        });
      } else {
        // OpenAI natively accepts our MessagePart structure for user roles
        messages.push({
          role: 'user', // System/Assistant usually stay string
          content: msg.content as unknown as OpenAI.Chat.ChatCompletionContentPart[], // Safely cast to ChatCompletionContentPart[]
        });
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
      resetTimeout(); // Start timeout before creation to catch hanging create calls
      const model =
        vscode.workspace.getConfiguration('cogento').get<string>('openaiModel') ?? 'gpt-4o';
      const stream = await this.client.chat.completions.create(
        {
          model,
          messages: messages,
          stream: true,
          response_format: { type: 'json_object' },
        },
        { signal: controller.signal },
      );

      for await (const chunk of stream) {
        resetTimeout(); // Reset 60s timeout on every chunk to catch stalls
        const content = chunk.choices[0]?.delta?.content || '';
        if (content) {
          yield { text: content, isFinished: false };
        }
      }

      if (timeoutId) clearTimeout(timeoutId);
      yield { text: '', isFinished: true };
    } catch (err: unknown) {
      if (timeoutId) clearTimeout(timeoutId);
      const e = err as Error;

      const isAbort =
        e.name === 'AbortError' ||
        e.name === 'APIUserAbortError' ||
        (e.message && e.message.toLowerCase().includes('abort'));

      if (isAbort) {
        if (cancelToken.isCancellationRequested) {
          return;
        }
        if (timeoutOccurred) {
          throw new CogentoTimeoutError();
        }
      }
      console.error('OpenAI API Error:', err);
      throw err;
    }
  }
}
