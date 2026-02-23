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
  tools?: any[];
}

export interface Token {
  text: string;
  isFinished: boolean;
}

export interface LLMProvider {
  generate(input: ModelInput, token: vscode.CancellationToken): AsyncIterable<Token>;
}
