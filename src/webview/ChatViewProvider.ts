import * as vscode from 'vscode';
import * as path from 'path';
import { Agent } from '../agent/agent';
import { WorkspaceIndexer } from '../agent/WorkspaceIndexer';
import { LLMProvider } from '../providers/provider';
import { OpenAIProvider } from '../providers/openai';
import { AnthropicProvider } from '../providers/anthropic';
import { GeminiProvider } from '../providers/gemini';
import { ReadFileTool, WriteFileTool, WriteMultipleFilesTool } from '../tools/fileTools';
import { RunCommandTool } from '../tools/terminalTools';
import {
  FindSymbolReferencesTool,
  SearchCodeTool,
  SearchWorkspaceSymbolTool,
} from '../tools/workspaceTools';
import { ConversationManager, Conversation } from '../store/ConversationManager';
import { MessagePart } from '../providers/provider';

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'cogento.chatView';
  private _view?: vscode.WebviewView;
  private _pendingApprovals: Map<
    string,
    (approved: { approved: boolean; modifiedInput?: unknown }) => void
  > = new Map();
  private currentConversation: Conversation;
  private agent: Agent | null = null;
  private _messageQueue: { text: string; attachments?: string[] }[] = [];
  private _isProcessingQueue: boolean = false;
  private _currentQueueCts: vscode.CancellationTokenSource | null = null;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly conversationManager: ConversationManager,
  ) {
    const conversations = this.conversationManager.getConversations();
    if (conversations.length > 0) {
      this.currentConversation = conversations[conversations.length - 1];
    } else {
      this.currentConversation = {
        id: this.conversationManager.generateId(),
        title: 'New Chat',
        updatedAt: Date.now(),
        messages: [],
        agentHistory: [],
      };
      this.conversationManager.saveConversation(this.currentConversation);
    }
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri, vscode.Uri.joinPath(this._extensionUri, 'media')],
    };

    webviewView.webview.html = this._getHtmlForWebview();

    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.command) {
        case 'ready':
          this.syncStateToWebview();
          return;
        case 'loadConversation': {
          const conv = this.conversationManager.getConversation(message.id);
          if (conv) {
            this.abortPendingApprovals();
            if (this._currentQueueCts) this._currentQueueCts.cancel();
            if (this.agent) this.agent.stop();
            this._messageQueue = [];
            this.currentConversation = conv;
            this.agent = null; // Recreate agent for new history context
            this.syncStateToWebview();
          }
          return;
        }
        case 'newConversation':
          this.abortPendingApprovals();
          if (this._currentQueueCts) this._currentQueueCts.cancel();
          if (this.agent) this.agent.stop();
          this._messageQueue = [];
          this.currentConversation = {
            id: this.conversationManager.generateId(),
            title: 'New Chat',
            updatedAt: Date.now(),
            messages: [],
            agentHistory: [],
          };
          this.conversationManager.saveConversation(this.currentConversation);
          this.agent = null;
          this.syncStateToWebview();
          return;
        case 'deleteConversation': {
          this.abortPendingApprovals();
          if (this._currentQueueCts) this._currentQueueCts.cancel();
          if (this.agent) this.agent.stop();
          this._messageQueue = [];
          this.conversationManager.deleteConversation(message.id);
          const remaining = this.conversationManager.getConversations();
          if (remaining.length > 0) {
            this.currentConversation = remaining[remaining.length - 1];
          } else {
            this.currentConversation = {
              id: this.conversationManager.generateId(),
              title: 'New Chat',
              updatedAt: Date.now(),
              messages: [],
              agentHistory: [],
            };
            this.conversationManager.saveConversation(this.currentConversation);
          }
          this.agent = null;
          this.syncStateToWebview();
          return;
        }
        case 'pickImage': {
          const imageUris = await vscode.window.showOpenDialog({
            canSelectMany: true,
            openLabel: 'Attach Image',
            filters: { Images: ['png', 'jpg', 'jpeg', 'webp'] },
          });
          if (imageUris) {
            for (const uri of imageUris) {
              const data = await vscode.workspace.fs.readFile(uri);
              const base64 = Buffer.from(data).toString('base64');
              const ext = uri.fsPath.split('.').pop() || 'png';
              const mimeType = ext === 'jpg' ? 'jpeg' : ext;
              const dataUri = `data:image/${mimeType};base64,${base64}`;
              const name = uri.fsPath.split(/[/\\]/).pop();
              this._view?.webview.postMessage({ command: 'imageAttached', name, dataUri });
            }
          }
          return;
        }
        case 'openFile': {
          const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
          if (workspaceRoot) {
            // First, try direct exact path
            const exactPath = vscode.Uri.file(path.join(workspaceRoot, message.filename));
            vscode.workspace.openTextDocument(exactPath).then(
              (doc) => {
                vscode.window.showTextDocument(doc);
              },
              async () => {
                try {
                  const partialPath = message.filename.startsWith('/')
                    ? message.filename.substring(1)
                    : message.filename;
                  const files = await vscode.workspace.findFiles(
                    `**/${partialPath}`,
                    '**/node_modules/**',
                    1,
                  );
                  if (files && files.length > 0) {
                    const doc = await vscode.workspace.openTextDocument(files[0]);
                    vscode.window.showTextDocument(doc);
                  } else {
                    vscode.window.showErrorMessage(
                      `Could not find file: ${message.filename} in workspace`,
                    );
                  }
                } catch {
                  vscode.window.showErrorMessage(`Could not find file: ${message.filename}`);
                }
              },
            );
          }
          return;
        }
        case 'fileDropped':
          if (message.path) {
            const relativePath = vscode.workspace.asRelativePath(message.path);
            // Post it back to the webview to insert into the input
            this._view?.webview.postMessage({ command: 'insertMention', path: relativePath });
          }
          return;
        case 'getFiles':
          vscode.workspace.findFiles('**/*', '**/node_modules/**', 2000).then((files) => {
            const fileNames = files.map((f) => vscode.workspace.asRelativePath(f));
            const folders = new Set<string>();
            fileNames.forEach((f) => {
              const parts = f.split('/');
              // Add all parent directories
              for (let i = 1; i < parts.length; i++) {
                folders.add(parts.slice(0, i).join('/') + '/');
              }
            });
            const allPaths = [...fileNames, ...Array.from(folders)];
            this._view?.webview.postMessage({ command: 'fileList', files: allPaths });
          });
          return;
        case 'sendMessage': {
          this.currentConversation.messages.push({
            text: message.text,
            isUser: true,
            attachments: message.attachments,
          });

          this._messageQueue.push({
            text: message.text,
            attachments: message.attachments,
          });

          if (this.currentConversation.title === 'New Chat') {
            this.currentConversation.title = message.text.substring(0, 30) + '...';
            this.conversationManager.saveConversation(this.currentConversation);
            this.syncStateToWebview(); // Update the top-bar dropdown live!
          } else {
            this.conversationManager.saveConversation(this.currentConversation);
          }

          this._processQueue();
          return;
        }

        case 'approvalResponse': {
          const resolve = this._pendingApprovals.get(message.requestId);
          if (resolve) {
            resolve({
              approved: message.approved,
              modifiedInput: message.modifiedInput,
            });
            this._pendingApprovals.delete(message.requestId);
          }
          return;
        }

        case 'partialWrite': {
          const { fileInfo } = message;
          if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
            const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
            const absPath = path.resolve(workspaceRoot, fileInfo.filePath);
            vscode.workspace.fs
              .writeFile(
                vscode.Uri.file(absPath),
                new TextEncoder().encode((fileInfo.contentLines || []).join('\n')),
              )
              .then(
                () => {
                  this._view?.webview.postMessage({
                    command: 'agentEvent',
                    event: {
                      type: 'tool_progress',
                      text: `Writing approved changes to ${fileInfo.filePath}...\n`,
                    },
                  });
                },
                (err: unknown) => {
                  const e = err as Error;
                  console.error('Failed partial write', e);
                },
              );
          }
          return;
        }

        case 'changeProvider':
          vscode.workspace
            .getConfiguration('cogento')
            .update('provider', message.provider, vscode.ConfigurationTarget.Global);
          this.agent = null; // Recreate agent on next message to use new provider
          return;
        case 'changeModel':
          vscode.workspace
            .getConfiguration('cogento')
            .update(message.settingKey, message.model, vscode.ConfigurationTarget.Global);
          this.agent = null; // Recreate agent to use new model
          return;
        case 'stopAgent':
          this.abortPendingApprovals();
          if (this._currentQueueCts) this._currentQueueCts.cancel();
          if (this.agent) {
            this.agent.stop();
          }
          this._messageQueue = []; // Clear queue on stop
          // If not processing, ensures UI clears immediately
          if (!this._isProcessingQueue) {
            this._view?.webview.postMessage({ command: 'agentStatus', status: 'idle' });
          }
          return;
        case 'retry': {
          // Find the last user message to retry
          const lastUserMsg = [...this.currentConversation.messages]
            .reverse()
            .find((m) => m.isUser);
          if (lastUserMsg) {
            // Clean up the agent's internal LLM history so we don't duplicate the prompt
            // and don't feed the error/timeout response back into the LLM context.
            const historyToClean = this.agent
              ? this.agent.getHistory()
              : this.currentConversation.agentHistory;

            if (historyToClean && historyToClean.length > 0) {
              // Find the index of the last user message in the LLM history
              const lastUserIdx = historyToClean.map((m) => m.role).lastIndexOf('user');
              if (lastUserIdx !== -1) {
                // Slice off the last user message and anything that came after it (the errors)
                historyToClean.splice(lastUserIdx);
              }
            }

            this._messageQueue.push({
              text: lastUserMsg.text,
              attachments: lastUserMsg.attachments,
            });
            this._processQueue();
          }
          return;
        }
      }
    });
  }

  private async _processQueue() {
    if (this._isProcessingQueue || this._messageQueue.length === 0) return;

    this._isProcessingQueue = true;
    this._currentQueueCts = new vscode.CancellationTokenSource();
    const token = this._currentQueueCts.token;
    const workspacePath = vscode.workspace.workspaceFolders?.[0].uri.fsPath || '';

    try {
      while (this._messageQueue.length > 0 && !token.isCancellationRequested) {
        const message = this._messageQueue.shift()!;

        this._view?.webview.postMessage({ command: 'agentStatus', status: 'working' });

        // Instantiate agent lazily
        if (!this.agent) {
          const config = vscode.workspace.getConfiguration('cogento');
          const providerName = config.get<string>('provider', 'openai');

          let provider: LLMProvider;

          if (providerName === 'anthropic') {
            const key = config.get<string>('apiKeys.anthropic', '');
            if (!key) {
              this.showError('Anthropic API key is missing.');
              break;
            }
            provider = new AnthropicProvider(key);
          } else if (providerName === 'gemini') {
            const key = config.get<string>('apiKeys.gemini', '');
            if (!key) {
              this.showError('Gemini API key is missing.');
              break;
            }
            provider = new GeminiProvider(key);
          } else {
            const key = config.get<string>('apiKeys.openai', '');
            if (!key) {
              this.showError('OpenAI API key is missing.');
              break;
            }
            provider = new OpenAIProvider(key);
          }

          const tools = [
            new ReadFileTool(workspacePath),
            new WriteFileTool(workspacePath),
            new WriteMultipleFilesTool(workspacePath),
            new RunCommandTool(workspacePath),
            new SearchCodeTool(),
            new SearchWorkspaceSymbolTool(),
            new FindSymbolReferencesTool(workspacePath),
          ];
          this.agent = new Agent(
            provider,
            tools,
            (event) => {
              // Collect events for the Work Context UI (in-memory only, no disk write here)
              const persistableTypes = ['reasoning', 'tool_start', 'tool_end', 'error'];
              if (persistableTypes.includes(event.type)) {
                if (!this.currentConversation.events) {
                  this.currentConversation.events = [];
                }
                // Truncate event text to prevent state bloat/freezes during serialization
                const truncatedEvent = {
                  ...event,
                  text:
                    event.text.length > 3000 ? event.text.substring(0, 2997) + '...' : event.text,
                };
                this.currentConversation.events.push(truncatedEvent);
              }

              if (event.type === 'answer') {
                // Collect the answer in-memory. Save to disk happens once after run() completes.
                this.currentConversation.messages.push({ text: event.text, isUser: false });
              }

              this._view?.webview.postMessage({ command: 'agentEvent', event });
            },
            (toolName, toolInput, preInfo) => {
              return new Promise<{ approved: boolean; modifiedInput?: unknown }>((resolve) => {
                const requestId = Math.random().toString(36).substring(7);
                this._pendingApprovals.set(requestId, resolve);
                this._view?.webview.postMessage({
                  command: 'askApproval',
                  requestId,
                  toolName,
                  toolInput,
                  preInfo,
                });
              });
            },
            this.currentConversation.agentHistory,
          );
        }

        // Construct Multimodal Payload
        const payload: MessagePart[] = [{ type: 'text', text: message.text }];

        // Load Context Mentions
        const mentionRegex = /@([a-zA-Z0-9._/-]+)/g;
        const matchedMentions = Array.from(message.text.matchAll(mentionRegex)).map(
          (m: RegExpMatchArray) => m[1],
        );

        if (matchedMentions.length > 0) {
          let mentionText = '\n\n--- Mentioned Context ---\n';
          for (const filename of matchedMentions) {
            try {
              const cleanName = filename.endsWith('/') ? filename.slice(0, -1) : filename;
              const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri;
              let uri: vscode.Uri | undefined;

              if (workspaceRoot) {
                uri = vscode.Uri.joinPath(workspaceRoot, cleanName);
                try {
                  await vscode.workspace.fs.stat(uri);
                } catch {
                  uri = undefined;
                }
              }

              if (!uri) {
                const files = await vscode.workspace.findFiles(
                  `**/${cleanName}`,
                  '**/node_modules/**',
                  1,
                );
                if (files.length > 0) uri = files[0];
              }

              if (uri) {
                const stat = await vscode.workspace.fs.stat(uri);
                if (stat.type === vscode.FileType.File) {
                  // Limit size to 1MB to prevent hangs
                  if (stat.size > 1024 * 1024) {
                    mentionText += `\nFile: ${filename} (Omitted: File too large > 1MB)\n`;
                  } else {
                    const data = await vscode.workspace.fs.readFile(uri);
                    const content = Buffer.from(data).toString('utf-8');
                    mentionText += `\nFile: ${filename}\n\`\`\`\n${content}\n\`\`\`\n`;
                  }
                } else if (stat.type === vscode.FileType.Directory) {
                  const entries = await vscode.workspace.fs.readDirectory(uri);
                  const filesList = entries
                    .map(
                      ([name, type]) => `${name}${type === vscode.FileType.Directory ? '/' : ''}`,
                    )
                    .join(', ');
                  mentionText += `\nDirectory: ${filename}\nContents: [${filesList}]\n`;
                }
              }
            } catch (e) {
              console.error('Failed to read mention', e);
            }
          }
          payload[0].text += mentionText;
        }

        if (message.attachments && message.attachments.length > 0) {
          for (const att of message.attachments) {
            payload.push({ type: 'image_url', image_url: { url: att } });
          }
        }

        try {
          // Hard 90-second per-run timeout: if agent.run() is still hanging after 90s
          // (e.g. a huge LLM response stalls mid-stream), we force-cancel it.
          const RUN_TIMEOUT_MS = 90000;
          let runTimeoutId: NodeJS.Timeout | null = null;
          const runTimeoutPromise = new Promise<void>((_, reject) => {
            runTimeoutId = setTimeout(() => {
              if (this.agent) {
                this.agent.stop();
              }
              reject(new Error('Agent run timed out after 90 seconds.'));
            }, RUN_TIMEOUT_MS);
          });

          let projectInsight: string | undefined;
          if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
            const indexer = new WorkspaceIndexer(vscode.workspace.workspaceFolders[0].uri.fsPath);
            projectInsight = await indexer.index();
          }

          await Promise.race([this.agent.run(payload, projectInsight), runTimeoutPromise]);
          if (runTimeoutId) clearTimeout(runTimeoutId);
        } catch (err: unknown) {
          const e = err as Error;
          this._view?.webview.postMessage({
            command: 'agentEvent',
            event: { type: 'error', text: `Agent Error: ${e.message || 'Unknown error'}` },
          });
          // Force-clear the working indicator in UI immediately on error
          this._view?.webview.postMessage({ command: 'agentStatus', status: 'idle' });
        }

        if (this.agent) {
          this.currentConversation.agentHistory = this.agent.getHistory();
        }
        this.conversationManager.saveConversation(this.currentConversation);
      }
    } finally {
      this._isProcessingQueue = false;
      this._view?.webview.postMessage({ command: 'agentStatus', status: 'idle' });
    }
  }

  // Method to programmatically add a message to the chat view from the extension
  public postMessageToWebview(message: unknown) {
    if (this._view) {
      this._view.webview.postMessage(message);
    }
  }

  private async showError(message: string) {
    this._view?.webview.postMessage({ command: 'receiveMessage', text: `Error: ${message}` });
    const cleanMessage = message.replace(/\*\*/g, '');
    const selection = await vscode.window.showErrorMessage(
      `Cogento: ${cleanMessage}`,
      'Configure Settings',
    );
    if (selection === 'Configure Settings') {
      vscode.commands.executeCommand('workbench.action.openSettings', '@ext:sodiadrhain.cogento');
    }
  }

  private syncStateToWebview() {
    if (!this._view) return;
    const conversations = this.conversationManager.getConversations();
    const activeProvider = vscode.workspace
      .getConfiguration('cogento')
      .get<string>('provider', 'openai');
    const modelSettingKey =
      activeProvider === 'gemini'
        ? 'geminiModel'
        : activeProvider === 'anthropic'
          ? 'anthropicModel'
          : 'openaiModel';
    const activeModel = vscode.workspace
      .getConfiguration('cogento')
      .get<string>(modelSettingKey, '');
    this._view.webview.postMessage({
      command: 'syncState',
      conversations,
      currentId: this.currentConversation.id,
      messages: this.currentConversation.messages,
      events: this.currentConversation.events || [],
      activeProvider,
      activeModel,
    });
  }

  private abortPendingApprovals() {
    for (const resolve of this._pendingApprovals.values()) {
      resolve({ approved: false });
    }
    this._pendingApprovals.clear();
  }

  private _getHtmlForWebview() {
    const scriptUri = this._view!.webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'media', 'chat.js'),
    );
    return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Cogento Agent</title>
            <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
            <script>
                // Load appropriate syntax highlighting theme based on VS Code theme class
                const isLight = document.body && document.body.classList.contains('vscode-light');
                const themeUrl = isLight 
                    ? "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css"
                    : "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/vs2015.min.css";
                document.write('<link rel="stylesheet" href="' + themeUrl + '">');
            </script>
            <style>
                body {
                    font-family: var(--vscode-font-family);
                    padding: 0px;
                    display: flex;
                    flex-direction: column;
                    height: 100vh;
                    box-sizing: border-box;
                    margin: 0;
                    overflow: hidden;
                }
                * {
                    box-sizing: border-box;
                }
                #top-bar {
                    display: flex;
                    gap: 5px;
                    padding: 6px 10px;
                    background: var(--vscode-editorGroupHeader-tabsBackground);
                    align-items: center;
                }
                #conversation-select {
                    flex: 1;
                    min-width: 0;
                    padding: 4px;
                    background: var(--vscode-dropdown-background);
                    color: var(--vscode-dropdown-foreground);
                    border: 1px solid transparent;
                    outline: none;
                }
                #conversation-select:hover, #conversation-select:focus {
                    border-color: transparent;
                    outline: none;
                }
                #provider-select {
                    background: transparent;
                    color: var(--vscode-descriptionForeground);
                    border: 1px solid transparent;
                    border-radius: 4px;
                    font-size: 11px;
                    cursor: pointer;
                    padding: 2px 4px;
                    max-width: 80px;
                    outline: none;
                }
                #provider-select:hover, #provider-select:focus {
                    background: var(--vscode-toolbar-hoverBackground);
                    color: var(--vscode-dropdown-foreground);
                    border-color: transparent;
                    outline: none;
                }
                #model-select {
                    background: transparent;
                    color: var(--vscode-descriptionForeground);
                    border: 1px solid transparent;
                    border-radius: 4px;
                    font-size: 11px;
                    cursor: pointer;
                    padding: 2px 4px;
                    max-width: 140px;
                    flex: 1;
                    min-width: 0;
                    text-overflow: ellipsis;
                    overflow: hidden;
                    white-space: nowrap;
                    outline: none;
                }
                #model-select:hover, #model-select:focus {
                    background: var(--vscode-toolbar-hoverBackground);
                    color: var(--vscode-dropdown-foreground);
                    border-color: transparent;
                    outline: none;
                }
                #chat-container {
                    flex: 1;
                    overflow-y: auto;
                    overflow-x: hidden;
                    display: flex;
                    flex-direction: column;
                    gap: 12px;
                    padding: 10px;
                }
                .message {
                    padding: 8px 12px;
                    border-radius: 8px;
                    max-width: 95%;
                    word-wrap: break-word;
                    overflow-wrap: break-word;
                    word-break: break-word;
                    line-height: 1.5;
                }
                .message p {
                    margin: 0 0 12px 0;
                }
                .message p:last-child {
                    margin-bottom: 0;
                }
                .message pre {
                    padding: 12px;
                    border-radius: 6px;
                    overflow-x: auto;
                    margin: 12px 0;
                    font-size: 11.5px;
                    max-width: 100%;
                    border: 1px solid var(--vscode-widget-border);
                    box-shadow: 0 2px 4px rgba(0,0,0,0.1);
                }
                .message pre .hljs {
                    background: transparent;
                    padding: 0;
                }
                .message code {
                    font-family: var(--vscode-editor-font-family);
                    background: var(--vscode-textCodeBlock-background);
                    padding: 3px 6px;
                    border-radius: 4px;
                    border: 1px solid var(--vscode-widget-border);
                    font-size: 0.9em;
                }
                .message pre code {
                    padding: 0;
                    border: none;
                    background: transparent;
                }
                .clickable-file {
                    color: var(--vscode-textLink-foreground) !important;
                    text-decoration: underline;
                    cursor: pointer;
                    background: var(--vscode-textBlockQuote-background) !important;
                }
                .clickable-file:hover {
                    color: var(--vscode-textLink-activeForeground) !important;
                    background: var(--vscode-toolbar-hoverBackground) !important;
                }
                .user-message {
                    background-color: var(--vscode-editorWidget-background);
                    color: var(--vscode-foreground);
                    align-self: flex-end;
                    position: relative;
                    padding-bottom: 24px; /* Space for restore icon */
                    border: 1px solid var(--vscode-panel-border);
                }
                .user-message-footer {
                    position: absolute;
                    bottom: 4px;
                    right: 8px;
                    display: flex;
                    align-items: center;
                }
                .restore-icon {
                    cursor: pointer;
                    opacity: 0.7;
                    transition: opacity 0.2s;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    padding: 2px;
                    border-radius: 3px;
                }
                .restore-icon:hover {
                    opacity: 1;
                    background: rgba(255, 255, 255, 0.1);
                }
                .restore-icon svg {
                    width: 14px;
                    height: 14px;
                    fill: currentColor;
                }
                .user-message:hover {
                    /* opacity: 0.8; */ /* Removed global hover opacity */
                }
                .agent-message {
                    background-color: var(--vscode-editorDesktop-background);
                    border: 1px solid var(--vscode-panel-border);
                    align-self: flex-start;
                }
                .timeout-message {
                    border-left: 3px solid var(--vscode-errorForeground);
                    background: var(--vscode-inputValidation-errorBackground);
                }
                .retry-button {
                    margin-top: 8px;
                    background: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: none;
                    padding: 4px 12px;
                    border-radius: 4px;
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    font-size: 11px;
                }
                .retry-button:hover {
                    background: var(--vscode-button-hoverBackground);
                }
                .retry-button svg {
                    width: 12px;
                    height: 12px;
                    fill: currentColor;
                }
                #input-container {
                    padding: 8px;
                    background: var(--vscode-editor-background);
                }

                #input-box {
                    display: flex;
                    flex-direction: column;
                    border: 1px solid transparent; /* No border by default */
                    background: var(--vscode-input-background);
                    border-radius: 4px;
                    padding: 4px;
                }

                #message-input {
                    width: 100%;
                    min-height: 24px;
                    max-height: 200px;
                    padding: 4px 8px;
                    border: none;
                    background: transparent;
                    color: var(--vscode-input-foreground);
                    resize: none;
                    font-family: var(--vscode-editor-font-family);
                    font-size: var(--vscode-editor-font-size);
                    line-height: 1.4;
                    overflow-y: auto;
                    outline: none;
                    box-sizing: border-box;
                }

                #input-actions-bar {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    padding: 2px 4px;
                    border-top: 1px solid var(--vscode-panel-border);
                    margin-top: 4px;
                }

                .left-actions {
                    display: flex;
                    align-items: center;
                    gap: 4px;
                    flex: 1;
                    min-width: 0;
                    margin-right: 8px;
                }
                .right-actions {
                    display: flex;
                    align-items: center;
                    gap: 4px;
                    flex-shrink: 0;
                }
                
                .icon-button {
                    flex-shrink: 0;
                    background: transparent;
                    color: var(--vscode-icon-foreground);
                    border: none;
                    padding: 4px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    cursor: pointer;
                    border-radius: 4px;
                }
                .icon-button:hover {
                    background: var(--vscode-toolbar-hoverBackground);
                    color: var(--vscode-toolbar-hoverOutline);
                }
                #btn-stop {
                    display: none;
                    color: var(--vscode-errorForeground);
                }
                .icon-button svg {
                    width: 16px;
                    height: 16px;
                    fill: currentColor;
                }
                #send-button {
                    background: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                }
                #send-button:hover {
                    background: var(--vscode-button-hoverBackground);
                }

                button:hover {
                    background: var(--vscode-button-hoverBackground);
                }
                .approval-box {
                    margin-top: 8px;
                    padding: 8px;
                    background: var(--vscode-editor-background);
                    border: 1px solid var(--vscode-focusBorder);
                    border-radius: 4px;
                }
                .approval-buttons {
                    display: flex;
                    gap: 8px;
                    margin-top: 8px;
                }
                .user-message-footer {
                    display: flex;
                    align-items: center;
                    justify-content: flex-end;
                    gap: 8px;
                    margin-top: 4px;
                }
                .pending-indicator {
                    font-size: 0.85em;
                    color: var(--vscode-descriptionForeground);
                    font-style: italic;
                    opacity: 0.8;
                }
                .message.pending {
                    opacity: 0.5;
                    filter: grayscale(100%);
                    transition: opacity 0.3s, filter 0.3s;
                }
                .btn-approve { 
                    background: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: none;
                    padding: 6px 14px;
                    border-radius: 4px;
                    cursor: pointer;
                    white-space: nowrap;
                }
                .btn-approve:hover {
                    background: var(--vscode-button-hoverBackground);
                }
                .btn-deny {
                    background: var(--vscode-button-secondaryBackground);
                    color: var(--vscode-button-secondaryForeground);
                    border: none;
                    padding: 6px 14px;
                    border-radius: 4px;
                    cursor: pointer;
                    white-space: nowrap;
                }
                .btn-accept-single, .btn-reject-single {
                    padding: 4px 8px;
                    font-size: 11px;
                }
                .btn-deny:hover {
                    background: var(--vscode-button-secondaryHoverBackground);
                }
                .diff-review-box {
                    margin: 8px 0;
                    border: 1px solid var(--vscode-panel-border);
                    border-radius: 4px;
                    background: var(--vscode-editor-background);
                    overflow: hidden;
                    font-family: var(--vscode-editor-font-family);
                    font-size: 11px;
                }
                .diff-header {
                    padding: 4px 8px;
                    background: var(--vscode-editorWidget-background);
                    border-bottom: 1px solid var(--vscode-panel-border);
                    font-weight: bold;
                    display: flex;
                    justify-content: space-between;
                }
                .diff-content {
                    max-height: 250px;
                    overflow-y: auto;
                    white-space: pre;
                    padding: 4px 0;
                }
                .diff-line {
                    display: flex;
                    padding: 0 8px;
                }
                .diff-line.addition {
                    background: var(--vscode-diffEditor-insertedTextBackground);
                    border-left: 3px solid #2ecc71;
                }
                .diff-line.deletion {
                    background: var(--vscode-diffEditor-removedTextBackground);
                    border-left: 3px solid #e74c3c;
                }
                .diff-line-num {
                    min-width: 25px;
                    color: var(--vscode-descriptionForeground);
                    text-align: right;
                    margin-right: 10px;
                    user-select: none;
                }
                .diff-line-content {
                    flex: 1;
                }
                .thought-process {
                    font-size: 0.9em;
                    margin: 8px 0;
                    border: 1px solid var(--vscode-panel-border);
                    border-radius: 4px;
                    background: var(--vscode-editorWidget-background);
                    max-width: 98%;
                }
                .thought-process summary {
                    cursor: pointer;
                    padding: 6px 10px;
                    font-weight: 600;
                    color: var(--vscode-descriptionForeground);
                    user-select: none;
                    outline: none !important;
                }
                .thought-process summary:focus, .thought-process summary:hover {
                    outline: none !important;
                    background: var(--vscode-toolbar-hoverBackground);
                }
                .thought-content {
                    padding: 8px 12px;
                    color: var(--vscode-foreground);
                    border-top: 1px solid var(--vscode-panel-border);
                }
                .thought-step {
                    margin-bottom: 8px;
                    line-height: 1.4;
                }
                .thought-step:last-child {
                    margin-bottom: 0;
                }
                .tool-progress-view {
                    margin-top: 8px;
                    padding: 8px;
                    background: var(--vscode-terminal-background);
                    color: var(--vscode-terminal-foreground);
                    font-family: var(--vscode-editor-font-family);
                    font-size: 11px;
                    border-radius: 4px;
                    white-space: pre-wrap;
                    overflow-x: auto;
                    max-height: 200px;
                    border: 1px solid var(--vscode-panel-border);
                }

                .indexing-status {
                    display: none;
                    font-size: 11px;
                    padding: 6px 10px;
                    background: var(--vscode-editorWidget-background);
                    border-bottom: 1px solid var(--vscode-panel-border);
                    color: var(--vscode-descriptionForeground);
                    align-items: center;
                    gap: 8px;
                }
                .indexing-status.active {
                    display: flex;
                }
                .spinner {
                    width: 12px;
                    height: 12px;
                    border: 2px solid var(--vscode-descriptionForeground);
                    border-top-color: transparent;
                    border-radius: 50%;
                    animation: spin 1s linear infinite;
                }
                @keyframes spin {
                    to { transform: rotate(360deg); }
                }

                #working-indicator {
                    display: none;
                    padding: 8px 12px;
                    align-items: center;
                    gap: 8px;
                    color: var(--vscode-descriptionForeground);
                    font-size: 11px;
                }
                #working-indicator.active {
                    display: flex;
                }
                #working-indicator .spinner {
                    border: 1px solid var(--vscode-descriptionForeground);
                    border-top-color: transparent;
                }

                
                /* Code block copy button styling */
                .code-block-container {
                    position: relative;
                }
                .copy-button {
                    position: absolute;
                    top: 5px;
                    right: 5px;
                    background: var(--vscode-editorWidget-background);
                    color: var(--vscode-icon-foreground);
                    border: 1px solid var(--vscode-widget-border);
                    padding: 4px;
                    border-radius: 4px;
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    z-index: 10;
                    opacity: 0.8;
                }
                .copy-button svg {
                    width: 14px;
                    height: 14px;
                }
                .copy-button:hover {
                    opacity: 1;
                    background: var(--vscode-toolbar-hoverBackground);
                }
                .copy-button.copied {
                    color: var(--vscode-testing-iconPassed);
                    border-color: var(--vscode-testing-iconPassed);
                }
                .thought-step {
                    margin-bottom: 4px;
                }
                .step-tool { color: var(--vscode-symbolIcon-functionForeground); }
                .step-error { color: var(--vscode-errorForeground); }
                
                #input-container {
                    padding: 10px;
                    border-top: 1px solid var(--vscode-panel-border);
                }
                
                #preview-container {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 5px;
                    padding: 0 10px;
                }
                .preview-chip {
                    display: flex;
                    align-items: center;
                    gap: 5px;
                    padding: 2px 6px;
                    background: var(--vscode-badge-background);
                    color: var(--vscode-badge-foreground);
                    border-radius: 10px;
                    font-size: 11px;
                }
                .preview-chip img {
                    height: 16px;
                    width: 16px;
                    object-fit: cover;
                    border-radius: 2px;
                }
                .mention {
                    color: var(--vscode-textLink-foreground);
                    cursor: pointer;
                    font-weight: bold;
                    background: var(--vscode-editor-selectionBackground);
                    padding: 0 2px;
                    border-radius: 2px;
                }
                .mention:hover {
                    text-decoration: underline;
                }
                .mention:hover {
                    text-decoration: underline;
                }
                #suggestions-popup {
                    position: absolute;
                    bottom: 100%;
                    left: 0;
                    width: 100%;
                    max-height: 200px;
                    background: var(--vscode-editorWidget-background);
                    border: 1px solid var(--vscode-editorWidget-border);
                    box-shadow: 0 4px 8px rgba(0,0,0,0.3);
                    overflow-y: auto;
                    display: none;
                    z-index: 1000;
                    border-radius: 4px;
                }
                .suggestion-item {
                    padding: 4px 8px;
                    cursor: pointer;
                    font-family: var(--vscode-editor-font-family);
                    font-size: 12px;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }
                .suggestion-item:hover, .suggestion-item.active {
                    background: var(--vscode-list-hoverBackground);
                    color: var(--vscode-list-hoverForeground);
                }
                .preview-close {
                    cursor: pointer;
                    opacity: 0.7;
                }
                .preview-close:hover { opacity: 1; }
            </style>
        </head>
        <body>
            <div id="indexing-indicator" class="indexing-status">
                <div class="spinner"></div>
                <span>Cogento is indexing your workspace...</span>
            </div>
            <div id="top-bar">
                <select id="conversation-select"></select>
                <button id="btn-new" class="icon-button" title="New Chat">
                    <svg viewBox="0 0 16 16"><path d="M14 7v1H8v6H7V8H1V7h6V1h1v6h6z"/></svg>
                </button>
                <button id="btn-delete" class="icon-button" title="Delete Chat">
                    <svg viewBox="0 0 16 16"><path d="M3 14c0 1.1.9 2 2 2h6c1.1 0 2-.9 2-2V4H3v10zM14 2h-3.5l-1-1h-5l-1 1H2v1h12V2z"/></svg>
                </button>
            </div>
            <div id="chat-container">
            </div>
            <div id="working-indicator">
                <div class="spinner"></div>
                <span>Working...</span>
            </div>
            <div id="preview-container"></div>
            <div id="input-container" style="position: relative;">
                <div id="suggestions-popup"></div>
                <div id="input-box">
                    <textarea id="message-input" placeholder="Ask Cogento anything..." rows="1"></textarea>
                    <div id="input-actions-bar">
                        <div class="left-actions">
                            <select id="provider-select" title="LLM Provider">
                                <option value="openai">OpenAI</option>
                                <option value="anthropic">Anthropic</option>
                                <option value="gemini">Gemini</option>
                            </select>
                            <select id="model-select" title="Model"></select>
                            <button id="btn-attach" class="icon-button" title="Attach context">
                                <svg viewBox="0 0 16 16"><path d="M10.5 4.5l-4 4a1.41 1.41 0 002 2l4-4a2.83 2.83 0 00-4-4l-5.5 5.5a4.24 4.24 0 006 6l4.5-4.5h-1l-4.5 4.5a3.24 3.24 0 01-4.5-4.5l5.5-5.5a1.83 1.83 0 012.5 2.5l-4 4a.41.41 0 01-.5-.5l4-4h-1z"/></svg>
                            </button>
                            <button id="btn-mention" class="icon-button" title="Mention context" style="font-weight: bold; font-size: 14px;">
                                @
                            </button>
                        </div>
                        <div class="right-actions">
                            <button id="send-button" class="icon-button" title="Send">
                                <svg viewBox="0 0 16 16"><path d="M15.5 8L.5.5l2.5 7.5L.5 15.5 15.5 8z"/></svg>
                            </button>
                            <button id="btn-stop" class="icon-button" title="Stop Agent">
                                <svg viewBox="0 0 16 16"><path d="M2 2h12v12H2z" fill="currentColor"/></svg>
                            </button>
                        </div>
                    </div>
                </div>
            </div>
            <script src="${scriptUri}"></script>
        </body>
        </html>`;
  }
}
