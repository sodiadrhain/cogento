import * as vscode from 'vscode';

export interface MessagePart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string }; // e.g. "data:image/png;base64,..."
}

export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string | MessagePart[];
}

export interface ModelInput {
  systemPrompt: string;
  messages: Message[];
  tools?: unknown[];
}

export interface Token {
  text: string;
  isFinished: boolean;
}

export class CogentoTimeoutError extends Error {
  constructor(message: string = 'The AI request timed out after 60 seconds.') {
    super(message);
    this.name = 'CogentoTimeoutError';
  }
}

export interface LLMProvider {
  generate(input: ModelInput, token: vscode.CancellationToken): AsyncIterable<Token>;
}
