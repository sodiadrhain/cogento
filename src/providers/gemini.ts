import * as vscode from 'vscode';
import { GoogleGenAI } from '@google/genai';
import { CogentoTimeoutError, LLMProvider, ModelInput, Token } from './provider';

export class GeminiProvider implements LLMProvider {
  private ai: GoogleGenAI;

  constructor(apiKey: string) {
    this.ai = new GoogleGenAI({ apiKey });
  }

  async *generate(input: ModelInput, cancelToken: vscode.CancellationToken): AsyncIterable<Token> {
    let historyPrompt = '';
    const inlineImages: { mimeType: string; data: string }[] = [];

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
            inlineImages.push({ mimeType, data: base64 });
          }
        }
      }
    }

    const userText = `CONVERSATION HISTORY:${historyPrompt}\n\nIMPORTANT: Return ONLY valid JSON matching the required schema. No markdown fences, no extra text.`;

    const parts: import('@google/genai').Part[] = [{ text: userText }];
    for (const img of inlineImages) {
      parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
    }

    // Read model from VS Code settings, defaulting to gemini-2.5-flash
    const model =
      vscode.workspace.getConfiguration('cogento').get<string>('geminiModel') ?? 'gemini-2.5-flash';

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
      resetTimeout();

      const reqConfig: import('@google/genai').GenerateContentConfig = {
        systemInstruction: input.systemPrompt,
        responseMimeType: 'application/json',
      };

      // Gemini 3 models support dynamic thinking levels
      if (model.startsWith('gemini-3')) {
        reqConfig.thinkingConfig = { thinkingLevel: 'low' as any };
      }

      const responseStream = await this.ai.models.generateContentStream({
        model,
        contents: [{ role: 'user', parts }],
        config: reqConfig,
      });

      // Gemini SDK streaming yields delta chunks — just forward the text directly
      for await (const chunk of responseStream) {
        resetTimeout();
        if (cancelToken.isCancellationRequested || controller.signal.aborted) break;
        if (timeoutOccurred) {
          throw new CogentoTimeoutError();
        }
        if (chunk.text) {
          yield { text: chunk.text, isFinished: false };
        }
      }

      if (timeoutId) clearTimeout(timeoutId);
      yield { text: '', isFinished: true };
    } catch (err: unknown) {
      if (timeoutId) clearTimeout(timeoutId);
      const e = err as Error;
      const isTimeout =
        err instanceof CogentoTimeoutError ||
        e.message?.toLowerCase().includes('timeout') ||
        timeoutOccurred;

      if (isTimeout) {
        throw new CogentoTimeoutError();
      }
      if (cancelToken.isCancellationRequested || controller.signal.aborted) return;
      console.error('Gemini API Error:', err);
      throw err;
    }
  }
}
