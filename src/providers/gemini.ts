import * as vscode from 'vscode';
import { GoogleGenAI } from '@google/genai';
import { LLMProvider, ModelInput, Token } from './provider';
import { extractErrorMessage } from '../utils/errorUtils';

export class GeminiProvider implements LLMProvider {
  private ai: GoogleGenAI;

  constructor(apiKey: string) {
    this.ai = new GoogleGenAI({ apiKey });
  }

  async *generate(input: ModelInput, cancelToken: vscode.CancellationToken): AsyncIterable<Token> {
    let historyPrompt = '';
    const userParts: any[] = [];

    for (const msg of input.messages) {
      if (typeof msg.content === 'string') {
        historyPrompt += `\n${msg.role.toUpperCase()}:\n${msg.content}\n`;
      } else {
        historyPrompt += `\n${msg.role.toUpperCase()}:\n`;
        for (const part of msg.content) {
          if (part.type === 'text') {
            historyPrompt += part.text + '\n';
          } else if (part.type === 'image_url' && part.image_url) {
            const [prefix, base64] = part.image_url.url.split(',');
            const mimeType = prefix.replace('data:', '').replace(';base64', '');
            userParts.push({
              inlineData: {
                mimeType: mimeType,
                data: base64,
              },
            });
          }
        }
      }
    }

    const fullPrompt = `${input.systemPrompt}\n\nCONVERSATION HISTORY:${historyPrompt}\n\nOUTPUT EXPECTATION: Return EXACTLY ONE JSON block meeting the required schema format above.`;

    // Gemini new SDK accepts array of parts
    const contentsPayload = [fullPrompt, ...userParts];

    try {
      const responseStream = await this.ai.models.generateContentStream({
        model: 'gemini-2.5-flash',
        contents: contentsPayload,
        config: {
          responseMimeType: 'application/json',
        },
      });

      // Note: Official Google GenAI Node SDK doesn't natively expose an abort controller to the `generateContentStream` easily without undici fetch hacks,
      // so we handle it gracefully here at the generator level for MVP.
      let aborted = false;
      cancelToken.onCancellationRequested(() => {
        aborted = true;
      });

      for await (const chunk of responseStream) {
        if (aborted) break;
        if (chunk.text) {
          yield { text: chunk.text, isFinished: false };
        }
      }
      yield { text: '', isFinished: true };
    } catch (error: any) {
      console.error('Gemini API Error:', error);
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
