import * as vscode from 'vscode';
import { Agent } from '../agent/agent';
import { LLMProvider } from '../providers/provider';
import { OpenAIProvider } from '../providers/openai';
import { AnthropicProvider } from '../providers/anthropic';
import { GeminiProvider } from '../providers/gemini';
import { ReadFileTool, WriteFileTool } from '../tools/fileTools';
import { RunCommandTool } from '../tools/terminalTools';
import { SearchCodeTool } from '../tools/workspaceTools';
import { ConversationManager, Conversation } from '../store/ConversationManager';
import { MessagePart } from '../providers/provider';
import { WorkspaceIndexer } from '../agent/WorkspaceIndexer';

export class ChatViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'cogento.chatView';
    private _view?: vscode.WebviewView;
    private _pendingApprovals: Map<string, (approved: boolean) => void> = new Map();
    private currentConversation: Conversation;
    private agent: Agent | null = null;
    private projectInsight: string = "";
    private isIndexing: boolean = false;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly conversationManager: ConversationManager
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
                agentHistory: []
            };
            this.conversationManager.saveConversation(this.currentConversation);
        }
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                this._extensionUri,
                vscode.Uri.joinPath(this._extensionUri, 'media')
            ]
        };

        webviewView.webview.html = this._getHtmlForWebview();
        this.indexWorkspace();

        let agent: Agent | null = null;
        const workspacePath = vscode.workspace.workspaceFolders?.[0].uri.fsPath || '';

        webviewView.webview.onDidReceiveMessage(
            async message => {
                switch (message.command) {
                    case 'ready':
                        this.syncStateToWebview();
                        return;
                    case 'loadConversation':
                        const conv = this.conversationManager.getConversation(message.id);
                        if (conv) {
                            this.currentConversation = conv;
                            this.agent = null; // Recreate agent for new history context
                            this.syncStateToWebview();
                        }
                        return;
                    case 'newConversation':
                        this.currentConversation = {
                            id: this.conversationManager.generateId(),
                            title: 'New Chat',
                            updatedAt: Date.now(),
                            messages: [],
                            agentHistory: []
                        };
                        this.conversationManager.saveConversation(this.currentConversation);
                        this.agent = null;
                        this.syncStateToWebview();
                        return;
                    case 'deleteConversation':
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
                                agentHistory: []
                            };
                            this.conversationManager.saveConversation(this.currentConversation);
                        }
                        this.agent = null;
                        this.syncStateToWebview();
                        return;
                    case 'pickImage':
                        const imageUris = await vscode.window.showOpenDialog({
                            canSelectMany: true,
                            openLabel: 'Attach Image',
                            filters: { 'Images': ['png', 'jpg', 'jpeg', 'webp'] }
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
                    case 'openFile':
                        const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
                        if (workspaceRoot) {
                            const path = require('path');
                            const filePath = vscode.Uri.file(path.join(workspaceRoot, message.filename));
                            vscode.workspace.openTextDocument(filePath).then(doc => {
                                vscode.window.showTextDocument(doc);
                            }, err => {
                                vscode.window.showErrorMessage(`Could not open file: ${message.filename}`);
                            });
                        }
                        return;
                    case 'fileDropped':
                        if (message.path) {
                            const relativePath = vscode.workspace.asRelativePath(message.path);
                            // Post it back to the webview to insert into the input
                            this._view?.webview.postMessage({ command: 'insertMention', path: relativePath });
                        }
                        return;
                    case 'getFiles':
                        vscode.workspace.findFiles('**/*', '**/node_modules/**', 2000).then(files => {
                            const fileNames = files.map(f => vscode.workspace.asRelativePath(f));
                            const folders = new Set<string>();
                            fileNames.forEach(f => {
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
                    case 'sendMessage':
                        this.currentConversation.messages.push({ 
                            text: message.text, 
                            isUser: true,
                            attachments: message.attachments
                        });
                        if (this.currentConversation.title === 'New Chat') {
                            this.currentConversation.title = message.text.substring(0, 30) + '...';
                            this.conversationManager.saveConversation(this.currentConversation);
                            this.syncStateToWebview(); // Update the top-bar dropdown live!
                        } else {
                            this.conversationManager.saveConversation(this.currentConversation);
                        }

                        // Instantiate agent lazily
                        if (!this.agent) {
                            const config = vscode.workspace.getConfiguration('cogento');
                            const providerName = config.get<string>('provider', 'openai');
                            
                            let provider: LLMProvider;
                            
                            if (providerName === 'anthropic') {
                                const key = config.get<string>('apiKeys.anthropic', '');
                                if (!key) return this.showError('Anthropic API key is missing. Please go to **Settings > Cogento > Api Keys: Anthropic** and paste your key.');
                                provider = new AnthropicProvider(key);
                            } else if (providerName === 'gemini') {
                                const key = config.get<string>('apiKeys.gemini', '');
                                if (!key) return this.showError('Gemini API key is missing. Please go to **Settings > Cogento > Api Keys: Gemini** and paste your key.');
                                provider = new GeminiProvider(key);
                            } else {
                                const key = config.get<string>('apiKeys.openai', '');
                                if (!key) return this.showError('OpenAI API key is missing. Please go to **Settings > Cogento > Api Keys: OpenAI** and paste your key.');
                                provider = new OpenAIProvider(key);
                            }

                            const tools = [
                                new ReadFileTool(workspacePath),
                                new WriteFileTool(workspacePath),
                                new RunCommandTool(workspacePath),
                                new SearchCodeTool()
                            ];
                            this.agent = new Agent(provider, tools, (event) => {
                                if (event.type === 'answer') {
                                    this.currentConversation.messages.push({ text: event.text, isUser: false });
                                    this.conversationManager.saveConversation(this.currentConversation);
                                }
                                this._view?.webview.postMessage({ command: 'agentEvent', event });
                            }, (toolName, toolInput, preInfo) => {
                                return new Promise((resolve) => {
                                    const requestId = Math.random().toString(36).substring(7);
                                    this._pendingApprovals.set(requestId, resolve);
                                    this._view?.webview.postMessage({
                                        command: 'askApproval',
                                        requestId,
                                        toolName,
                                        toolInput,
                                        preInfo
                                    });
                                });
                            }, this.currentConversation.agentHistory, this.projectInsight);
                        }

                        // Construct Multimodal Payload
                        const payload: MessagePart[] = [{ type: 'text', text: message.text }];

                        // Load Context Mentions into the prompt by parsing @filename
                        const mentionRegex = /@([a-zA-Z0-9._\/\-]+)/g;
                        const matchedMentions = Array.from(message.text.matchAll(mentionRegex)).map((m: any) => m[1]);

                        if (matchedMentions.length > 0) {
                            let mentionText = '\n\n--- Mentioned Context ---\n';
                            for (const filename of matchedMentions) {
                                try {
                                    // Clean up trailing slash for resolution if it's a folder
                                    const cleanName = filename.endsWith('/') ? filename.slice(0, -1) : filename;
                                    
                                    // 1. Try to find exactly as mentioned (handles relative paths)
                                    const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri;
                                    let uri: vscode.Uri | undefined;
                                    
                                    if (workspaceRoot) {
                                        uri = vscode.Uri.joinPath(workspaceRoot, cleanName);
                                        try {
                                            await vscode.workspace.fs.stat(uri);
                                        } catch {
                                            uri = undefined; // Not found at root
                                        }
                                    }

                                    // 2. Fallback to searching the workspace if not found at root
                                    if (!uri) {
                                        const files = await vscode.workspace.findFiles(`**/${cleanName}`, '**/node_modules/**', 1);
                                        if (files.length > 0) {
                                            uri = files[0];
                                        }
                                    }
                                    
                                    if (uri) {
                                        const stat = await vscode.workspace.fs.stat(uri);
                                        if (stat.type === vscode.FileType.File) {
                                            const data = await vscode.workspace.fs.readFile(uri);
                                            const content = Buffer.from(data).toString('utf-8');
                                            mentionText += `\nFile: ${filename}\n\`\`\`\n${content}\n\`\`\`\n`;
                                        } else if (stat.type === vscode.FileType.Directory) {
                                            const entries = await vscode.workspace.fs.readDirectory(uri);
                                            const filesList = entries.map(([name, type]) => 
                                                `${name}${type === vscode.FileType.Directory ? '/' : ''}`
                                            ).join(', ');
                                            mentionText += `\nDirectory: ${filename}\nContents: [${filesList}]\n`;
                                        }
                                    } else {
                                        mentionText += `\nPath: ${filename} (Not found)\n`;
                                    }
                                } catch (e) {
                                    console.error('Failed to read mention', e);
                                    this.showError(`Failed to attach context from ${filename}`);
                                }
                            }
                            payload[0].text += mentionText;
                        }

                        // Attach Images
                        if (message.attachments && message.attachments.length > 0) {
                            for (const att of message.attachments) {
                                payload.push({ type: 'image_url', image_url: { url: att } });
                            }
                        }

                        // Run the agent with the user's task
                        await this.agent.run(payload);
                        
                        // Sync final agent history into DB
                        this.currentConversation.agentHistory = this.agent.getHistory();
                        this.conversationManager.saveConversation(this.currentConversation);
                        return;
                    
                    case 'approvalResponse':
                        const resolve = this._pendingApprovals.get(message.requestId);
                        if (resolve) {
                            resolve(message.approved);
                            this._pendingApprovals.delete(message.requestId);
                        }
                        return;

                    case 'changeProvider':
                        vscode.workspace.getConfiguration('cogento').update('provider', message.provider, vscode.ConfigurationTarget.Global);
                        this.agent = null; // Recreate agent on next message to use new provider
                        return;
                    case 'stopAgent':
                        if (this.agent) {
                            this.agent.stop();
                        }
                        return;
                }
            }
        );
    }

    private async indexWorkspace() {
        const workspacePath = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
        if (!workspacePath) return;

        this.isIndexing = true;
        this._view?.webview.postMessage({ command: 'indexingStatus', status: 'indexing' });

        const indexer = new WorkspaceIndexer(workspacePath);
        this.projectInsight = await indexer.index();

        this.isIndexing = false;
        this._view?.webview.postMessage({ command: 'indexingStatus', status: 'complete' });
    }

    // Method to programmatically add a message to the chat view from the extension
    public postMessageToWebview(message: any) {
        if (this._view) {
            this._view.webview.postMessage(message);
        }
    }

    private async showError(message: string) {
        this._view?.webview.postMessage({ command: 'receiveMessage', text: `Error: ${message}` });
        const cleanMessage = message.replace(/\*\*/g, '');
        const selection = await vscode.window.showErrorMessage(`Cogento: ${cleanMessage}`, 'Configure Settings');
        if (selection === 'Configure Settings') {
            vscode.commands.executeCommand('workbench.action.openSettings', '@ext:adesojiawobajo.cogento');
        }
    }

    private syncStateToWebview() {
        if (!this._view) return;
        const conversations = this.conversationManager.getConversations();
        const activeProvider = vscode.workspace.getConfiguration('cogento').get<string>('provider', 'openai');
        this._view.webview.postMessage({
            command: 'syncState',
            conversations,
            currentId: this.currentConversation.id,
            messages: this.currentConversation.messages,
            activeProvider
        });
    }

    private _getHtmlForWebview() {
        const scriptUri = this._view!.webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'media', 'chat.js')
        );
        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Cogento Agent</title>
            <style>
                body {
                    font-family: var(--vscode-font-family);
                    padding: 0px;
                    display: flex;
                    flex-direction: column;
                    height: 100vh;
                    box-sizing: border-box;
                    margin: 0;
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
                    background: var(--vscode-textCodeBlock-background);
                    padding: 8px;
                    border-radius: 4px;
                    overflow-x: auto;
                    margin: 8px 0;
                    max-width: 100%;
                }
                .message code {
                    font-family: var(--vscode-editor-font-family);
                    background: var(--vscode-textCodeBlock-background);
                    padding: 2px 4px;
                    border-radius: 3px;
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

                .left-actions, .right-actions {
                    display: flex;
                    gap: 4px;
                    min-width: 0;
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
                .btn-approve { 
                    background: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: none;
                    padding: 6px 14px;
                    border-radius: 4px;
                    font-weight: 600;
                    cursor: pointer;
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
                
                /* Code block copy button styling */
                .code-block-container {
                    position: relative;
                }
                .copy-button {
                    position: absolute;
                    top: 5px;
                    right: 5px;
                    background: var(--vscode-button-secondaryBackground);
                    color: var(--vscode-button-secondaryForeground);
                    border: none;
                    padding: 2px 6px;
                    border-radius: 3px;
                    font-size: 10px;
                    cursor: pointer;
                    opacity: 0;
                    transition: opacity 0.2s;
                    z-index: 10;
                }
                .code-block-container:hover .copy-button {
                    opacity: 1;
                }
                .copy-button:hover {
                    background: var(--vscode-button-hoverBackground);
                }
                .copy-button.copied {
                    background: var(--vscode-testing-iconPassed);
                    color: white;
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
            <div id="preview-container"></div>
            <div id="input-container" style="position: relative;">
                <div id="suggestions-popup"></div>
                <div id="input-box">
                    <textarea id="message-input" placeholder="Ask Cogento something..." rows="1"></textarea>
                    <div id="input-actions-bar">
                        <div class="left-actions">
                            <select id="provider-select" title="LLM Provider">
                                <option value="openai">OpenAI</option>
                                <option value="anthropic">Anthropic</option>
                                <option value="gemini">Gemini</option>
                            </select>
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
