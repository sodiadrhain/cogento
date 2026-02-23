import * as vscode from 'vscode';
import OpenAI from 'openai';
import { LLMProvider, ModelInput, Token } from './provider';
import { extractErrorMessage } from '../utils/errorUtils';

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
          content: msg.content as any, // Safely cast to ChatCompletionContentPart[]
        });
      }
    }

    try {
      const stream = await this.client.chat.completions.create({
        model: 'gpt-4o', // default model
        messages: messages,
        stream: true,
        response_format: { type: 'json_object' },
      });

      cancelToken.onCancellationRequested(() => {
        stream.controller.abort();
      });

      for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content || '';
        if (content) {
          yield { text: content, isFinished: false };
        }
      }
      yield { text: '', isFinished: true };
    } catch (error: any) {
      console.error('OpenAI API Error:', error);
      const cleanMessage = extractErrorMessage(error);
      // Yield a fallback JSON so the planner doesn't crash completely, or let it throw
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
