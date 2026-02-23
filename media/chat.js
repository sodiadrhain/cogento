// @ts-nocheck
const vscode = acquireVsCodeApi();

const messageInput = document.getElementById('message-input');
const sendButton = document.getElementById('send-button');
const stopButton = document.getElementById('btn-stop');
const chatContainer = document.getElementById('chat-container');
const conversationSelect = document.getElementById('conversation-select');
const providerSelect = document.getElementById('provider-select');
const btnNew = document.getElementById('btn-new');
const btnDelete = document.getElementById('btn-delete');
const btnAttach = document.getElementById('btn-attach');
const btnMention = document.getElementById('btn-mention');
const previewContainer = document.getElementById('preview-container');

let currentId = null;
let currentAttachments = [];
let allFiles = [];
let filteredFiles = [];
let suggestionIndex = 0;
let isSuggestionsVisible = false;
let isAgentRunning = false;
const suggestionsPopup = document.getElementById('suggestions-popup');

// Always initialize button states explicitly on load
sendButton.style.display = 'flex';
stopButton.style.display = 'none';

function renderPreviews() {
    previewContainer.innerHTML = '';
    currentAttachments.forEach((att, idx) => {
        const chip = document.createElement('div');
        chip.className = 'preview-chip';
        chip.innerHTML = `<img src="${att.dataUri}"> ${att.name.substring(0, 10)}... <span class="preview-close" data-type="att" data-idx="${idx}">x</span>`;
        previewContainer.appendChild(chip);
    });

    document.querySelectorAll('.preview-close').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const type = e.target.dataset.type;
            const idx = parseInt(e.target.dataset.idx);
            if (type === 'att') currentAttachments.splice(idx, 1);
            renderPreviews();
        });
    });
}

// Signal ready
vscode.postMessage({ command: 'ready' });

btnNew.addEventListener('click', () => {
    vscode.postMessage({ command: 'newConversation' });
});

btnDelete.addEventListener('click', () => {
    if (currentId) vscode.postMessage({ command: 'deleteConversation', id: currentId });
});

conversationSelect.addEventListener('change', (e) => {
    vscode.postMessage({ command: 'loadConversation', id: e.target.value });
});

providerSelect.addEventListener('change', (e) => {
    vscode.postMessage({ command: 'changeProvider', provider: e.target.value });
});

btnAttach.addEventListener('click', () => {
    if (currentAttachments.length >= 5) return;
    vscode.postMessage({ command: 'pickImage' });
});

btnMention.addEventListener('click', () => {
    messageInput.value += ' @';
    messageInput.focus();
});

function clearChat() {
    chatContainer.innerHTML = '<div class="message agent-message">Hello! I am Cogento. How can I help you today?</div>';
}

function logStoredMessages(messages) {
    clearChat();
    messages.forEach(msg => appendMessage(msg.text, msg.isUser, msg.attachments));
}

function parseMarkdown(text) {
    if (!text) return '';
    // Prevent HTML injection
    let html = text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    // Code blocks: ```lang\ncode\n```
    html = html.replace(/```[a-z]*\n([\s\S]*?)```/g, (match, p1) => {
        const id = 'code-' + Math.random().toString(36).substring(2, 9);
        return `<div class="code-block-container">
            <button class="copy-button" onclick="copyCode(this, '${id}')">Copy</button>
            <pre><code id="${id}">${p1}</code></pre>
        </div>`;
    });
    // Inline code: `code`
    html = html.replace(/`([^`\n]+)`/g, (match, p1) => {
        // Detect file patterns: ends with extension, contains path slash, or is a common extensionless file
        const commonFiles = ['Dockerfile', 'Makefile', 'LICENSE', 'README', 'docker-compose', 'Gemfile', 'Cargo', 'Procfile'];
        const isFile = (/\.[a-z0-9]+$/i.test(p1) || p1.includes('/') || commonFiles.some(f => p1.startsWith(f))) && !p1.includes(' ');
        if (isFile) {
            return `<code class="clickable-file" onclick="openFile('${p1}')" title="Open ${p1}">${p1}</code>`;
        }
        return `<code>${p1}</code>`;
    });

    // Paragraphs: Split by double newline and wrap in <p>
    const paragraphs = html.split(/\n\n+/);
    html = paragraphs.map(p => {
        // Don't wrap code blocks in <p>
        if (p.includes('class="code-block-container"')) return p;
        // Basic line break handling within paragraphs
        return `<p>${p.trim().replace(/\n/g, '<br>')}</p>`;
    }).filter(p => p.length > 7).join('');

    // Bold: **text**
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    // Italic: *text*
    html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    // Links: [text](src)
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
    // @mentions for files: @filename.ext
    html = html.replace(/@([a-zA-Z0-9._\/\-]+)/g, '<span class="mention" onclick="openMention(\'$1\')">@$1</span>');
    return html;
}

function openFile(filename) {
    vscode.postMessage({ command: 'openFile', filename });
}

function appendMessage(text, isUser, attachments) {
    const msgDiv = document.createElement('div');
    msgDiv.className = 'message ' + (isUser ? 'user-message' : 'agent-message');
    msgDiv.innerHTML = parseMarkdown(text);

    if (isUser) {
        const footer = document.createElement('div');
        footer.className = 'user-message-footer';
        footer.innerHTML = `
            <div class="restore-icon" title="Restore message to input" onclick="restoreMessage(this)">
                <svg viewBox="0 0 24 24"><path d="M12.5 8c-2.65 0-5.05 1-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z"/></svg>
            </div>
        `;
        // Store the raw text on the icon's parent for easy retrieval
        footer.dataset.text = text;
        msgDiv.appendChild(footer);
    }

    if (attachments && attachments.length > 0) {
        const attContainer = document.createElement('div');
        attContainer.style.display = 'flex';
        attContainer.style.flexWrap = 'wrap';
        attContainer.style.gap = '5px';
        attContainer.style.marginTop = '8px';
        attachments.forEach(att => {
            const img = document.createElement('img');
            img.src = att;
            img.style.maxHeight = '100px';
            img.style.borderRadius = '4px';
            attContainer.appendChild(img);
        });
        msgDiv.appendChild(attContainer);
    }

    chatContainer.appendChild(msgDiv);
    chatContainer.scrollTop = chatContainer.scrollHeight;
}

function sendMessage() {
    const text = messageInput.value.trim();
    if (text || currentAttachments.length > 0) {
        let header = text;
        const atts = currentAttachments.map(a => a.dataUri);
        appendMessage(header, true, atts);

        vscode.postMessage({
            command: 'sendMessage',
            text: text,
            attachments: currentAttachments.map(a => a.dataUri)
        });

        messageInput.value = '';
        messageInput.style.height = 'auto';
        currentAttachments = [];
        renderPreviews();

        sendButton.style.display = 'none';
        stopButton.style.display = 'flex';
        isAgentRunning = true;
    }
}

// Auto-resize textarea
messageInput.addEventListener('input', function () {
    this.style.height = 'auto';
    this.style.height = (this.scrollHeight) + 'px';

    const cursorPosition = this.selectionStart;
    const textBeforeCursor = this.value.substring(0, cursorPosition);
    const mentionMatch = textBeforeCursor.match(/@([a-zA-Z0-9._\/\-]*)$/);

    if (mentionMatch) {
        const query = mentionMatch[1].toLowerCase();
        if (allFiles.length === 0) {
            vscode.postMessage({ command: 'getFiles' });
        }
        filteredFiles = allFiles.filter(f => f.toLowerCase().includes(query)).slice(0, 10);
        if (filteredFiles.length > 0) {
            showSuggestions();
        } else {
            hideSuggestions();
        }
    } else {
        hideSuggestions();
    }
});

sendButton.addEventListener('click', sendMessage);
stopButton.addEventListener('click', () => {
    vscode.postMessage({ command: 'stopAgent' });
    isAgentRunning = false;
    // Reset UI immediately
    sendButton.style.display = 'flex';
    stopButton.style.display = 'none';
    closeThoughtBlock();
});
messageInput.addEventListener('keydown', (e) => {
    if (isSuggestionsVisible) {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            suggestionIndex = (suggestionIndex + 1) % filteredFiles.length;
            renderSuggestions();
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            suggestionIndex = (suggestionIndex - 1 + filteredFiles.length) % filteredFiles.length;
            renderSuggestions();
        } else if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault();
            insertSuggestion(filteredFiles[suggestionIndex]);
        } else if (e.key === 'Escape') {
            hideSuggestions();
        }
        return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});

window.openMention = function (filename) {
    vscode.postMessage({ command: 'openFile', filename: filename });
};

window.copyCode = function (btn, id) {
    const el = document.getElementById(id);
    if (!el) return;
    const code = el.innerText;
    navigator.clipboard.writeText(code).then(() => {
        const oldText = btn.innerText;
        btn.innerText = 'Copied!';
        btn.classList.add('copied');
        setTimeout(() => {
            btn.innerText = oldText;
            btn.classList.remove('copied');
        }, 2000);
    });
};

window.restoreMessage = function (el) {
    const text = el.parentElement.dataset.text;
    if (text) {
        messageInput.value = text;
        messageInput.focus();
        messageInput.dispatchEvent(new Event('input')); // Trigger auto-resize
    }
};

window.respondApproval = function (requestId, approved) {
    const btns = document.getElementById('btns-' + requestId);
    if (btns) {
        if (approved) {
            btns.innerHTML = '<span style="color:var(--vscode-testing-iconPassed)">✓ Approved. Executing...</span>';
            // Re-trigger busy state immediately so user knows it's working
            isAgentRunning = true;
            sendButton.style.display = 'none';
            stopButton.style.display = 'flex';
        } else {
            btns.innerHTML = '<span style="color:var(--vscode-testing-iconError)">✗ Denied</span>';
        }
    }
    vscode.postMessage({ command: 'approvalResponse', requestId: requestId, approved: approved });
};

let currentThoughtBlock = null;
let currentThoughtContent = null;
let currentProgressView = null;

function getOrCreateThoughtBlock() {
    if (!currentThoughtBlock) {
        currentThoughtBlock = document.createElement('details');
        currentThoughtBlock.className = 'thought-process';
        currentThoughtBlock.open = true;

        const summary = document.createElement('summary');
        summary.id = 'active-thought-summary';
        summary.textContent = 'Agent is thinking...';
        currentThoughtBlock.appendChild(summary);

        currentThoughtContent = document.createElement('div');
        currentThoughtContent.className = 'thought-content';
        currentThoughtBlock.appendChild(currentThoughtContent);

        chatContainer.appendChild(currentThoughtBlock);
    }
    return currentThoughtContent;
}

function appendThoughtStep(text, className) {
    const content = getOrCreateThoughtBlock();
    const step = document.createElement('div');
    step.className = 'thought-step ' + (className || '');
    step.innerHTML = parseMarkdown(text);
    content.appendChild(step);
    chatContainer.scrollTop = chatContainer.scrollHeight;
}

function closeThoughtBlock() {
    isAgentRunning = false;
    if (currentThoughtBlock) {
        currentThoughtBlock.open = false;
        const summary = currentThoughtBlock.querySelector('summary');
        if (summary) summary.textContent = 'Show Work Context';
        currentThoughtBlock = null;
        currentThoughtContent = null;
        currentProgressView = null;
    }
    sendButton.style.display = 'flex';
    stopButton.style.display = 'none';
}

function handleAgentEvent(event) {
    if (!isAgentRunning && event.type !== 'start') return;
    if (event.type === 'start') isAgentRunning = true;

    switch (event.type) {
        case 'start':
            appendThoughtStep(event.text);
            break;
        case 'reasoning':
            appendThoughtStep(event.text);
            // Also update the header summary to show what the agent is doing
            const summary = document.getElementById('active-thought-summary');
            if (summary) {
                summary.textContent = event.text.length > 60 ? event.text.substring(0, 57) + '...' : event.text;
            }
            break;
        case 'tool_start':
            appendThoughtStep(event.text, 'step-tool');
            // Create a live terminal view for this tool
            currentProgressView = document.createElement('div');
            currentProgressView.className = 'tool-progress-view';
            currentProgressView.textContent = 'Starting execution...\n';
            getOrCreateThoughtBlock().appendChild(currentProgressView);
            break;
        case 'tool_progress':
            if (currentProgressView) {
                currentProgressView.textContent += event.text;
                currentProgressView.scrollTop = currentProgressView.scrollHeight;
            }
            break;
        case 'tool_end':
            appendThoughtStep(event.text);
            currentProgressView = null;
            break;
        case 'error':
            appendThoughtStep(event.text, 'step-error');
            closeThoughtBlock();
            break;
        case 'answer':
            closeThoughtBlock();
            appendMessage(event.text, false);
            break;
        case 'approval':
            appendThoughtStep('Waiting for tool approval...');
            break;
    }
}

window.addEventListener('message', eventMsg => {
    const message = eventMsg.data;
    switch (message.command) {
        case 'syncState':
            currentId = message.currentId;
            conversationSelect.innerHTML = '';
            message.conversations.forEach(c => {
                const opt = document.createElement('option');
                opt.value = c.id;
                opt.textContent = c.title;
                if (c.id === currentId) opt.selected = true;
                conversationSelect.appendChild(opt);
            });
            if (message.activeProvider) {
                providerSelect.value = message.activeProvider;
            }
            logStoredMessages(message.messages);
            break;
        case 'agentEvent':
            handleAgentEvent(message.event);
            break;
        case 'receiveMessage':
            appendMessage(message.text, false);
            break;
        case 'askApproval':
            const div = document.createElement('div');
            div.className = 'message agent-message';
            
            let displayPreInfo = false;
            let diffBox = null;
            
            try {
                if (message.preInfo && message.preInfo.type === 'file_change') {
                    const oldContent = message.preInfo.oldContent || '';
                    const newContent = message.preInfo.newContent || '';
                    const filePath = message.preInfo.filePath || 'Unknown file';
                    
                    diffBox = renderDiff(oldContent, newContent, filePath);
                    displayPreInfo = true;
                }
            } catch (error) {
                console.error('Error rendering diff:', error);
                displayPreInfo = false; // Fallback to raw JSON
            }
            
            div.innerHTML = `
                <div class="approval-box" style="border-left: 3px solid var(--vscode-button-background)">
                    <strong>Tool Approval Required</strong>
                    <div style="margin-top:5px">Agent wants to run: <code>${message.toolName}</code></div>
                    <pre id="raw-input-${message.requestId}" style="margin:8px 0;padding:8px;background:var(--vscode-textCodeBlock-background);border-radius:4px;white-space:pre-wrap;font-size:12px;border:1px solid var(--vscode-panel-border); display: ${displayPreInfo ? 'none' : 'block'}">${JSON.stringify(message.toolInput, null, 2)}</pre>
                    <div class="approval-diff-container" id="diff-${message.requestId}"></div>
                    <div class="approval-buttons" id="btns-${message.requestId}">
                        <button class="btn-approve" onclick="respondApproval('${message.requestId}', true)">Accept & Run</button>
                        <button class="btn-deny" onclick="respondApproval('${message.requestId}', false)">Reject</button>
                    </div>
                </div>
            `;
            chatContainer.appendChild(div);
            
            if (displayPreInfo && diffBox) {
                const container = div.querySelector(`#diff-${message.requestId}`);
                if (container) container.appendChild(diffBox);
            }
            
            chatContainer.scrollTop = chatContainer.scrollHeight;
            break;
        case 'imageAttached':
            currentAttachments.push({ name: message.name, dataUri: message.dataUri });
            renderPreviews();
            break;
        case 'fileList':
            allFiles = message.files;
            // Re-trigger input logic if needed
            messageInput.dispatchEvent(new Event('input'));
            break;
        case 'insertMention':
            if (message.path) {
                const space = messageInput.value.length > 0 && !messageInput.value.endsWith(' ') ? ' ' : '';
                messageInput.value += space + '@' + message.path + ' ';
                messageInput.focus();
                messageInput.dispatchEvent(new Event('input')); // Trigger auto-resize
            }
            break;
        case 'indexingStatus':
            const indicator = document.getElementById('indexing-indicator');
            if (indicator) {
                if (message.status === 'indexing') {
                    indicator.classList.add('active');
                    messageInput.disabled = true;
                    messageInput.placeholder = 'Cogento is indexing...';
                } else {
                    indicator.classList.remove('active');
                    messageInput.disabled = false;
                    messageInput.placeholder = 'Ask Cogento something...';
                }
            }
            break;
    }
});
function renderDiff(oldContent, newContent, filePath) {
    const oldLines = (oldContent || '').split('\n');
    const newLines = (newContent || '').split('\n');
    const box = document.createElement('div');
    
    // Defensive inline styling to ensure it shows up even if CSS classes are missing
    box.style.margin = '8px 0';
    box.style.border = '1px solid var(--vscode-panel-border)';
    box.style.borderRadius = '4px';
    box.style.backgroundColor = 'var(--vscode-editor-background)';
    box.style.overflow = 'hidden';
    box.style.fontFamily = 'var(--vscode-editor-font-family)';
    box.style.fontSize = '11px';

    const header = document.createElement('div');
    header.style.padding = '4px 8px';
    header.style.backgroundColor = 'var(--vscode-editorWidget-background)';
    header.style.borderBottom = '1px solid var(--vscode-panel-border)';
    header.style.fontWeight = 'bold';
    header.style.display = 'flex';
    header.style.justifyContent = 'space-between';
    header.innerHTML = `<span>Change to: ${filePath}</span> <span>(Diff View)</span>`;
    box.appendChild(header);

    const container = document.createElement('div');
    container.style.maxHeight = '250px';
    container.style.overflowY = 'auto';
    container.style.whiteSpace = 'pre';
    container.style.padding = '4px 0';

    let i = 0, j = 0;
    while (i < oldLines.length || j < newLines.length) {
        if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
            addLine(container, i + 1, oldLines[i], '');
            i++; j++;
        } else {
            if (i < oldLines.length && (j >= newLines.length || oldLines[i] !== newLines[j])) {
                addLine(container, i + 1, oldLines[i], 'deletion');
                i++;
            }
            if (j < newLines.length && (i-1 >= oldLines.length || newLines[j] !== oldLines[i-1])) {
                addLine(container, j + 1, newLines[j], 'addition');
                j++;
            }
        }
    }

    box.appendChild(container);
    return box;
}

function addLine(container, num, content, type) {
    const line = document.createElement('div');
    line.style.display = 'flex';
    line.style.padding = '0 8px';
    
    if (type === 'addition') {
        line.style.backgroundColor = 'var(--vscode-diffEditor-insertedTextBackground, rgba(46, 204, 113, 0.2))';
        line.style.borderLeft = '3px solid #2ecc71';
    } else if (type === 'deletion') {
        line.style.backgroundColor = 'var(--vscode-diffEditor-removedTextBackground, rgba(231, 76, 60, 0.2))';
        line.style.borderLeft = '3px solid #e74c3c';
    }

    const escapedContent = (content || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
    
    line.innerHTML = `<span style="min-width: 25px; color: var(--vscode-descriptionForeground); text-align: right; margin-right: 10px; user-select: none;">${num}</span><span style="flex: 1;">${escapedContent}</span>`;
    container.appendChild(line);
}
function showSuggestions() {
    isSuggestionsVisible = true;
    suggestionsPopup.style.display = 'block';
    renderSuggestions();
}

function hideSuggestions() {
    isSuggestionsVisible = false;
    suggestionsPopup.style.display = 'none';
    suggestionIndex = 0;
}

function renderSuggestions() {
    suggestionsPopup.innerHTML = '';
    filteredFiles.forEach((file, idx) => {
        const item = document.createElement('div');
        item.className = 'suggestion-item' + (idx === suggestionIndex ? ' active' : '');
        item.textContent = file;
        item.onclick = () => insertSuggestion(file);
        suggestionsPopup.appendChild(item);
    });
}

function insertSuggestion(file) {
    const cursorPosition = messageInput.selectionStart;
    const textBeforeCursor = messageInput.value.substring(0, cursorPosition);
    const textAfterCursor = messageInput.value.substring(cursorPosition);
    const mentionMatch = textBeforeCursor.match(/@([a-zA-Z0-9._\/\-]*)$/);

    if (mentionMatch) {
        const beforeMention = textBeforeCursor.substring(0, mentionMatch.index);
        messageInput.value = beforeMention + '@' + file + ' ' + textAfterCursor;
        const newCursorPos = beforeMention.length + file.length + 2;
        messageInput.setSelectionRange(newCursorPos, newCursorPos);
    }
    hideSuggestions();
    messageInput.focus();
}

// Drag and Drop support
window.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
});

window.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    
    // Check multiple possible data types for the dropped path/URI
    let droppedPath = e.dataTransfer.getData('text/uri-list') || 
                      e.dataTransfer.getData('text/plain') ||
                      (e.dataTransfer.files.length > 0 ? e.dataTransfer.files[0].path : null);
    
    // If it's a URI list, it might contain multiple lines; take the first one
    if (droppedPath && droppedPath.includes('\r\n')) {
        droppedPath = droppedPath.split('\r\n')[0];
    } else if (droppedPath && droppedPath.includes('\n')) {
        droppedPath = droppedPath.split('\n')[0];
    }

    if (droppedPath) {
        // Clean up URI scheme if present (e.g., file://)
        if (droppedPath.startsWith('file://')) {
            // Encode/Decode might be needed if there are spaces
            try {
                droppedPath = decodeURI(droppedPath.replace('file://', ''));
            } catch(e) {}
        }
        vscode.postMessage({ command: 'fileDropped', path: droppedPath });
    }
});
