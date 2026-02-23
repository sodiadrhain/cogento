import * as vscode from 'vscode';
import { Message } from '../providers/provider';

export interface Conversation {
  id: string;
  title: string;
  updatedAt: number;
  messages: { text: string; isUser: boolean; attachments?: string[] }[];
  agentHistory: Message[]; // The strict LLM messages array to hydrate the Agent
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

  public saveConversation(conversation: Conversation): void {
    const conversations = this.getConversations();
    const existingIndex = conversations.findIndex((c) => c.id === conversation.id);

    conversation.updatedAt = Date.now();

    if (existingIndex >= 0) {
      conversations[existingIndex] = conversation;
    } else {
      conversations.push(conversation);
    }

    this.context.workspaceState.update(ConversationManager.STORAGE_KEY, conversations);
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
