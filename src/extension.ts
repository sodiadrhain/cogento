import * as vscode from 'vscode';
import { ChatViewProvider } from './webview/ChatViewProvider';
import { ConversationManager } from './store/ConversationManager';

export function activate(context: vscode.ExtensionContext) {
  console.log('Cogento extension is now active!');

  const conversationManager = new ConversationManager(context);
  const provider = new ChatViewProvider(context.extensionUri, conversationManager);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider),
  );

  // Provide a command to manually focus the sidebar if desired
  const startDisposable = vscode.commands.registerCommand('cogento.start', () => {
    vscode.commands.executeCommand('workbench.view.extension.cogento-sidebar'); // Focuses the container
    // OR focuses the view itself
    vscode.commands.executeCommand('cogento.chatView.focus');
  });

  context.subscriptions.push(startDisposable);
}

export function deactivate() {}
