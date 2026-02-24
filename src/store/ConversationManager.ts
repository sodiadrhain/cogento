import * as vscode from 'vscode';
import { Message } from '../providers/provider';

import { AgentEvent } from '../agent/agent';

export interface Conversation {
  id: string;
  title: string;
  updatedAt: number;
  messages: { text: string; isUser: boolean; attachments?: string[] }[];
  agentHistory: Message[]; // The strict LLM messages array to hydrate the Agent
  events?: AgentEvent[]; // Stores AgentEvents for the Work Context UI
}

export class ConversationManager {
  private static readonly STORAGE_KEY = 'cogento.conversations';

  constructor(private context: vscode.ExtensionContext) {}

  public getConversations(): Conversation[] {
    return this.context.workspaceState.get<Conversation[]>(ConversationManager.STORAGE_KEY) || [];
  }

  public getConversation(id: string): Conversation | undefined {
    return this.getConversations().find((c) => c.id === id);
  }

  public saveConversation(conversation: Conversation): Thenable<void> {
    const conversations = this.getConversations();
    const existingIndex = conversations.findIndex((c) => c.id === conversation.id);

    conversation.updatedAt = Date.now();
    // Cap events and messages to prevent massive serialization payloads
    if (conversation.events && conversation.events.length > 50) {
      conversation.events = conversation.events.slice(-50);
    }
    if (conversation.messages && conversation.messages.length > 100) {
      conversation.messages = conversation.messages.slice(-100);
    }

    if (existingIndex >= 0) {
      conversations[existingIndex] = conversation;
    } else {
      conversations.push(conversation);
    }

    // Sort by updatedAt and keep only the last 10 to prevent massive state bloat
    const sorted = conversations
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, 10);

    return this.context.workspaceState.update(ConversationManager.STORAGE_KEY, sorted);
  }

  public deleteConversation(id: string): void {
    const conversations = this.getConversations().filter((c) => c.id !== id);
    this.context.workspaceState.update(ConversationManager.STORAGE_KEY, conversations);
  }

  public generateId(): string {
    return (
      Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15)
    );
  }
}
