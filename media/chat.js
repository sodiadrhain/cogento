/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
/* global acquireVsCodeApi, document, window, setTimeout, Event, navigator, console */

const vscode = acquireVsCodeApi();

const messageInput = document.getElementById('message-input');
const sendButton = document.getElementById('send-button');
const stopButton = document.getElementById('btn-stop');
const chatContainer = document.getElementById('chat-container');
const conversationSelect = document.getElementById('conversation-select');
const providerSelect = document.getElementById('provider-select');
const modelSelect = document.getElementById('model-select');
const btnNew = document.getElementById('btn-new');
const btnDelete = document.getElementById('btn-delete');
const btnAttach = document.getElementById('btn-attach');
const btnMention = document.getElementById('btn-mention');
const previewContainer = document.getElementById('preview-container');
const workingIndicator = document.getElementById('working-indicator');

let currentId = null;
let currentAttachments = [];
let allFiles = [];
let filteredFiles = [];
let suggestionIndex = 0;
let isSuggestionsVisible = false;
let isAgentRunning = false;
let skipSuggestionsOnce = false;
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

  document.querySelectorAll('.preview-close').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const type = e.target.dataset.type;
      const idx = parseInt(e.target.dataset.idx);
      if (type === 'att') currentAttachments.splice(idx, 1);
      renderPreviews();
    });
  });
}

function escapeHtml(unsafe) {
  if (typeof unsafe !== 'string') return unsafe;
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
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

// Model options per provider
const MODEL_OPTIONS = {
  openai: [
    { value: 'gpt-4o', label: 'GPT-4o' },
    { value: 'gpt-4o-mini', label: 'GPT-4o Mini' },
    { value: 'o3-mini', label: 'o3-mini' },
    { value: 'gpt-4-turbo', label: 'GPT-4 Turbo' },
  ],
  anthropic: [
    { value: 'claude-opus-4-5', label: 'Claude Opus 4.5' },
    { value: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
    { value: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
    { value: 'claude-3-7-sonnet-latest', label: 'Claude 3.7 Sonnet' },
  ],
  gemini: [
    { value: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro (Preview)' },
    { value: 'gemini-3-pro-preview', label: 'Gemini 3 Pro (Preview)' },
    { value: 'gemini-3-flash-preview', label: 'Gemini 3 Flash (Preview)' },
    { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  ],
};

const MODEL_SETTING_KEY = {
  openai: 'openaiModel',
  anthropic: 'anthropicModel',
  gemini: 'geminiModel',
};

function populateModels(provider, savedModel) {
  const options = MODEL_OPTIONS[provider] || [];
  modelSelect.innerHTML = '';
  options.forEach((opt) => {
    const el = document.createElement('option');
    el.value = opt.value;
    el.textContent = opt.label;
    modelSelect.appendChild(el);
  });
  // Select saved model, or default to first option
  if (savedModel && options.some((o) => o.value === savedModel)) {
    modelSelect.value = savedModel;
  } else if (options.length > 0) {
    modelSelect.value = options[0].value;
  }
}

providerSelect.addEventListener('change', (e) => {
  const provider = e.target.value;
  vscode.postMessage({ command: 'changeProvider', provider });
  populateModels(provider);
  // Auto-select first model and persist it
  const firstModel = (MODEL_OPTIONS[provider] || [])[0]?.value;
  if (firstModel) {
    vscode.postMessage({
      command: 'changeModel',
      settingKey: MODEL_SETTING_KEY[provider],
      model: firstModel,
    });
  }
});

modelSelect.addEventListener('change', (e) => {
  const provider = providerSelect.value;
  vscode.postMessage({
    command: 'changeModel',
    settingKey: MODEL_SETTING_KEY[provider],
    model: e.target.value,
  });
});

// Populate models immediately based on the current provider selection
populateModels(providerSelect.value);

btnAttach.addEventListener('click', () => {
  if (currentAttachments.length >= 5) return;
  vscode.postMessage({ command: 'pickImage' });
});

btnMention.addEventListener('click', () => {
  messageInput.value += ' @';
  messageInput.focus();
});

function clearChat() {
  chatContainer.innerHTML =
    '<div class="message agent-message">Hello! I am Cogento. How can I help you today?</div>';
}

function logStoredMessages(messages, events) {
  clearChat();
  messages.forEach((msg) => appendMessage(msg.text, msg.isUser, msg.attachments));

  if (events && events.length > 0) {
    const wasRunning = isAgentRunning;
    isAgentRunning = true; // Temporary allow rendering
    events.forEach((ev) => handleAgentEvent(ev));
    closeThoughtBlock(); // Collapse restored context
    isAgentRunning = wasRunning;
  }
}

function parseMarkdown(text) {
  if (!text) return '';
  // Prevent HTML injection
  let html = text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  html = html.replace(/```([a-z0-9+#]*)\n([\s\S]*?)```/gi, (match, lang, code) => {
    const id = 'code-' + Math.random().toString(36).substring(2, 9);
    let highlighted = code;
    try {
      if (window.hljs) {
        if (lang && window.hljs.getLanguage(lang)) {
          highlighted = window.hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
        } else {
          highlighted = window.hljs.highlightAuto(code).value;
        }
      }
    } catch (e) {
      console.warn('Highlight JS failed', e);
    }
    
    // Using a cleaner overlapping-squares style copy icon
    return `<div class="code-block-container">
            <button class="copy-button" title="Copy Code" onclick="copyCode(this, '${id}')">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
            </button>
            <pre><code id="${id}" class="hljs ${lang || ''}">${highlighted}</code></pre>
        </div>`;
  });
  // Inline code: `code`
  html = html.replace(/`([^`\n]+)`/g, (match, p1) => {
    // Detect file patterns: ends with extension, contains path slash, or is a common extensionless file
    const commonFiles = [
      'Dockerfile',
      'Makefile',
      'LICENSE',
      'README',
      'docker-compose',
      'Gemfile',
      'Cargo',
      'Procfile',
    ];
    const isFile =
      (/\.[a-z0-9]+$/i.test(p1) || p1.includes('/') || commonFiles.some((f) => p1.startsWith(f))) &&
      !p1.includes(' ');
    if (isFile) {
      return `<code class="clickable-file" onclick="openFile('${p1}')" title="Open ${p1}">${p1}</code>`;
    }
    return `<code>${p1}</code>`;
  });

  // Paragraphs: Split by double newline and wrap in <p>
  const paragraphs = html.split(/\n\n+/);
  html = paragraphs
    .map((p) => {
      // Don't wrap code blocks in <p>
      if (p.includes('class="code-block-container"')) return p;
      // Basic line break handling within paragraphs
      return `<p>${p.trim().replace(/\n/g, '<br>')}</p>`;
    })
    .filter((p) => p.length > 7)
    .join('');

  // Bold: **text**
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Italic: *text*
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  // Links: [text](src)
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
  // @mentions for files: @filename.ext
  html = html.replace(
    /@([a-zA-Z0-9._/-]+)/g,
    '<span class="mention" onclick="openMention(\'$1\')">@$1</span>',
  );
  return html;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function openFile(filename) {
  vscode.postMessage({ command: 'openFile', filename });
}

function appendMessage(text, isUser, attachments) {
  const msgDiv = document.createElement('div');
  msgDiv.className = 'message ' + (isUser ? 'user-message' : 'agent-message');
  
  if (isUser && isAgentRunning) {
    msgDiv.className += ' pending';
  }
  if (text === 'AGENT_TIMEOUT') {
    msgDiv.className += ' timeout-message';
    msgDiv.innerHTML = `
            <div><strong>Agent timeout</strong></div>
            <div style="font-size: 0.9em; opacity: 0.8; margin-top: 4px;">The AI request took too long (over 60s). This can happen during peak load or with very complex tasks.</div>
        `;
  } else {
    msgDiv.innerHTML = parseMarkdown(text);
  }

  // Inject universal retry button for agent errors/warnings
  if (!isUser && (text === 'AGENT_TIMEOUT' || text.includes('⚠️'))) {
    const errorFooter = document.createElement('div');
    errorFooter.style.display = 'flex';
    errorFooter.style.justifyContent = 'flex-end';
    errorFooter.style.marginTop = '8px';
    errorFooter.innerHTML = `
        <button class="retry-button" onclick="retryLastMessage()">
            <svg viewBox="0 0 24 24"><path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
            Retry Request
        </button>
    `;
    msgDiv.appendChild(errorFooter);
  }

  if (isUser) {
    const footer = document.createElement('div');
    footer.className = 'user-message-footer';
    
    // Add pending indicator and conditional restore icon
    let footerContent = '';
    if (isAgentRunning) {
        footerContent = `
            <span class="pending-indicator" title="Message is queued">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 14px; height: 14px;"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
            </span>
        `;
    } else {
        footerContent = `
            <div class="restore-icon" title="Restore message to input" onclick="restoreMessage(this)">
                <svg viewBox="0 0 24 24"><path d="M12.5 8c-2.65 0-5.05 1-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z"/></svg>
            </div>
        `;
    }

    footer.innerHTML = footerContent;
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
    attachments.forEach((att) => {
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
    const atts = currentAttachments.map((a) => a.dataUri);
    appendMessage(header, true, atts);

    vscode.postMessage({
      command: 'sendMessage',
      text: text,
      attachments: currentAttachments.map((a) => a.dataUri),
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
  this.style.height = this.scrollHeight + 'px';

  if (skipSuggestionsOnce) {
    skipSuggestionsOnce = false;
    hideSuggestions();
    return;
  }

  const cursorPosition = this.selectionStart;
  const textBeforeCursor = this.value.substring(0, cursorPosition);
  const mentionMatch = textBeforeCursor.match(/@([a-zA-Z0-9._/-]*)$/);

  if (mentionMatch) {
    const query = mentionMatch[1].toLowerCase();
    if (allFiles.length === 0) {
      vscode.postMessage({ command: 'getFiles' });
    }
    filteredFiles = allFiles.filter((f) => f.toLowerCase().includes(query)).slice(0, 10);
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
  workingIndicator.classList.remove('active');
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
    const oldHtml = btn.innerHTML;
    // Checkmark SVG
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.innerHTML = oldHtml;
      btn.classList.remove('copied');
    }, 2000);
  });
};

window.restoreMessage = function (el) {
  const text = el.parentElement.dataset.text;
  if (text) {
    skipSuggestionsOnce = true;
    messageInput.value = text;
    messageInput.focus();
    messageInput.dispatchEvent(new Event('input')); // Trigger auto-resize
  }
};

window.retryLastMessage = function () {
  vscode.postMessage({ command: 'retry' });
};

window.respondApproval = function (requestId, approved) {
  const btns = document.getElementById('btns-' + requestId);

  let modifiedInput = undefined;

  // If approved globally, check if we have individual file decisions
  if (approved) {
    const rawInputBlock = document.getElementById(`raw-input-${requestId}`);
    if (rawInputBlock) {
      try {
        const originalInput = JSON.parse(rawInputBlock.textContent);
        modifiedInput = originalInput; // Start with full input

        const fileWrappers = document.querySelectorAll(`.file-decision-wrapper-${requestId}`);
        if (fileWrappers.length > 0 && originalInput && originalInput.files && Array.isArray(originalInput.files)) {
          const approvedPaths = new Set();
          let allRejected = true;

          fileWrappers.forEach((wrapper) => {
            const decision = wrapper.dataset.decision; // 'accept' or 'reject'
            if (decision !== 'reject') {
              approvedPaths.add(wrapper.dataset.filepath);
              allRejected = false;
            }
          });

          if (allRejected) {
            approved = false;
          } else {
            // Apply filtering for multi-file tools
            originalInput.files = originalInput.files.filter((f) =>
              approvedPaths.has(f.filePath),
            );
          }
        }
      } catch (e) {
        console.error('Failed to parse original input for partial approval:', e);
      }
    }
  }

  if (btns) {
    if (approved) {
      btns.innerHTML =
        '<span style="color:var(--vscode-testing-iconPassed); font-size: 12px; font-weight: 500;">✓ Approved. Executing...</span>';
      // Re-trigger busy state immediately so user knows it's working
      isAgentRunning = true;
      sendButton.style.display = 'none';
      stopButton.style.display = 'flex';
    } else {
      btns.innerHTML = '<span style="color:var(--vscode-testing-iconError); font-size: 12px; font-weight: 500;">✗ Denied</span>';
    }
  }

  vscode.postMessage({
    command: 'approvalResponse',
    requestId: requestId,
    approved: approved,
    modifiedInput: modifiedInput,
  });
};

window.setFileDecision = function (requestId, filePath, decision, btnElement) {
  const wrapper = btnElement.closest('.file-decision-wrapper-' + requestId);
  if (!wrapper) return;

  wrapper.dataset.decision = decision;

  // Replace buttons with static text
  const btnGroup = btnElement.parentElement;
  if (decision === 'accept') {
    btnGroup.innerHTML = '<span style="color:var(--vscode-testing-iconPassed); font-size: 11px;">✓ Accepted</span>';
    wrapper.style.opacity = '1';

    // Instant write to disk
    const rawInputBlock = document.getElementById(`raw-input-${requestId}`);
    if (rawInputBlock) {
      try {
        const originalInput = JSON.parse(rawInputBlock.textContent);
        if (originalInput && originalInput.files) {
          const fileInfo = originalInput.files.find((f) => f.filePath === filePath);
          if (fileInfo && fileInfo.contentLines) {
            vscode.postMessage({ command: 'partialWrite', fileInfo });
          }
        }
      } catch { /* ignore */ }
    }
  } else {
    btnGroup.innerHTML = '<span style="color:var(--vscode-testing-iconError); font-size: 11px;">✗ Rejected</span>';
    wrapper.style.opacity = '0.6'; // Dim rejected files
  }

  // Auto-proceed if all file decisions have been made
  const allWrappers = document.querySelectorAll(`.file-decision-wrapper-${requestId}`);
  if (allWrappers.length > 0) {
    let allDecided = true;
    allWrappers.forEach((w) => {
      // By default when rendered, dataset.decision is 'pending' now
      if (w.dataset.decision === 'pending') {
        allDecided = false;
      }
    });

    if (allDecided) {
      // Small timeout to let the user see their final button click register
      setTimeout(() => {
        window.respondApproval(requestId, true);
      }, 300);
    }
  }
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

let currentStreamingReasoning = null;

function closeThoughtBlock() {
  isAgentRunning = false;
  if (currentThoughtBlock) {
    currentThoughtBlock.open = false;
    const summary = currentThoughtBlock.querySelector('summary');
    if (summary) summary.textContent = 'Show Work Context';
    currentThoughtBlock = null;
    currentThoughtContent = null;
    currentProgressView = null;
    currentStreamingReasoning = null;
  }
  // sendButton.style.display = 'flex'; // Don't reset buttons here if we might be queueing
  // stopButton.style.display = 'none';
}

function handleAgentEvent(event) {
  if (!isAgentRunning && event.type !== 'start') return;
  if (event.type === 'start') isAgentRunning = true;

  switch (event.type) {
    case 'start':
      appendThoughtStep(event.text);
      break;
    case 'thinking': {
      // Update the header summary
      const summaryThinking = document.getElementById('active-thought-summary');
      if (summaryThinking) {
        summaryThinking.textContent =
          event.text.length > 60 ? event.text.substring(0, 57) + '...' : event.text;
      }
      if (!currentStreamingReasoning) {
        const content = getOrCreateThoughtBlock();
        currentStreamingReasoning = document.createElement('div');
        currentStreamingReasoning.className = 'thought-step step-thinking';
        content.appendChild(currentStreamingReasoning);
      }
      currentStreamingReasoning.innerHTML = parseMarkdown(event.text);
      chatContainer.scrollTop = chatContainer.scrollHeight;
      break;
    }
    case 'reasoning': {
      if (currentStreamingReasoning) {
        currentStreamingReasoning.innerHTML = parseMarkdown(event.text);
        currentStreamingReasoning.className = 'thought-step step-reasoning';
        currentStreamingReasoning = null;
      } else {
        appendThoughtStep(event.text, 'step-reasoning');
      }
      // Also update the header summary
      const summary = document.getElementById('active-thought-summary');
      if (summary) {
        summary.textContent =
          event.text.length > 60 ? event.text.substring(0, 57) + '...' : event.text;
      }
      break;
    }
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
    case 'approval_result': {
      // Find the last approval box in the DOM since this event follows it
      const approvalBoxes = document.querySelectorAll('.approval-box');
      if (approvalBoxes.length > 0) {
        const lastBox = approvalBoxes[approvalBoxes.length - 1];
        const btns = lastBox.querySelector('.approval-buttons');
        if (btns) {
           const approved = event.data && event.data.approved;
           if (approved) {
               btns.innerHTML = '<span style="color:var(--vscode-testing-iconPassed); font-size: 12px; font-weight: 500;">✓ Approved. Executed.</span>';
           } else {
               btns.innerHTML = '<span style="color:var(--vscode-testing-iconError); font-size: 12px; font-weight: 500;">✗ Denied</span>';
           }
        }
      }
      break;
    }
  }
}

window.addEventListener('message', (eventMsg) => {
  const message = eventMsg.data;
  switch (message.command) {
    case 'syncState':
      currentId = message.currentId;
      // CRITICAL: Reset all agent UI state to prevent cross-conversation DOM pollution.
      // Old thought blocks and status indicators must be cleared before loading new messages.
      closeThoughtBlock();
      workingIndicator.classList.remove('active');
      isAgentRunning = false;
      sendButton.style.display = 'flex';
      stopButton.style.display = 'none';

      conversationSelect.innerHTML = '';
      message.conversations.forEach((c) => {
        const opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = c.title;
        if (c.id === currentId) opt.selected = true;
        conversationSelect.appendChild(opt);
      });
      if (message.activeProvider) {
        providerSelect.value = message.activeProvider;
        // Populate with saved model if provided, else defaults to first option
        populateModels(message.activeProvider, message.activeModel);
      } else {
        populateModels(providerSelect.value);
      }
      logStoredMessages(message.messages, message.events);
      break;
    case 'agentEvent':
      handleAgentEvent(message.event);
      break;
    case 'agentStatus':
      if (message.status === 'working') {
        // Find the oldest pending message and remove its pending state
        const firstPending = document.querySelector('.message.pending');
        if (firstPending) {
            firstPending.classList.remove('pending');
            const ind = firstPending.querySelector('.pending-indicator');
            if (ind) ind.remove();
            
            // Inject the restore icon now that it's no longer pending
            const footer = firstPending.querySelector('.user-message-footer');
            if (footer && !footer.querySelector('.restore-icon')) {
                const restoreBtn = document.createElement('div');
                restoreBtn.className = 'restore-icon';
                restoreBtn.title = 'Restore message to input';
                restoreBtn.onclick = function() { window.restoreMessage(this); };
                restoreBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12.5 8c-2.65 0-5.05 1-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z"/></svg>';
                footer.appendChild(restoreBtn);
            }
        }

        workingIndicator.classList.add('active');
        isAgentRunning = true;
        sendButton.style.display = 'none';
        stopButton.style.display = 'flex';
        chatContainer.scrollTop = chatContainer.scrollHeight;
      } else {
        workingIndicator.classList.remove('active');
        isAgentRunning = false;
        sendButton.style.display = 'flex';
        stopButton.style.display = 'none';
      }
      break;
    case 'receiveMessage':
      appendMessage(message.text, false);
      break;
    case 'askApproval': {
      const div = document.createElement('div');
      div.className = 'message agent-message';

      let displayPreInfo = false;
      let diffBoxes = [];

      try {
        if (message.preInfo) {
          if (message.preInfo.type === 'file_change') {
            const oldContent = message.preInfo.oldContent || '';
            const newContent = message.preInfo.newContent || '';
            const filePath = message.preInfo.filePath || 'Unknown file';

            const diffBox = renderDiff(oldContent, newContent, filePath);
            diffBoxes.push(diffBox);
            displayPreInfo = true;
          } else if (message.preInfo.type === 'multi_file_change') {
            for (const change of message.preInfo.changes) {
              const oldContent = change.oldContent || '';
              const newContent = change.newContent || '';
              const filePath = change.filePath || 'Unknown file';

              const diffBoxWrapper = document.createElement('div');
              diffBoxWrapper.className = `diff-box-wrapper file-decision-wrapper-${message.requestId}`;
              diffBoxWrapper.dataset.filepath = filePath;
              diffBoxWrapper.dataset.decision = 'pending'; // Start out pending until clicked
              diffBoxWrapper.style.marginBottom = '12px';
              diffBoxWrapper.style.border = '1px solid var(--vscode-panel-border)';
              diffBoxWrapper.style.padding = '8px';
              diffBoxWrapper.style.borderRadius = '4px';

              const headerBar = document.createElement('div');
              headerBar.style.display = 'flex';
              headerBar.style.justifyContent = 'space-between';
              headerBar.style.alignItems = 'flex-start';
              headerBar.style.marginBottom = '8px';

              const fileTitle = document.createElement('strong');
              fileTitle.textContent = filePath;
              fileTitle.style.wordBreak = 'break-word';
              fileTitle.style.marginRight = '8px';
              fileTitle.style.flex = '1';

              const btnGroup = document.createElement('div');
              btnGroup.style.display = 'flex';
              btnGroup.style.gap = '4px';
              btnGroup.style.flexShrink = '0';

              btnGroup.innerHTML = `
                                <div class="file-status-indicator" style="margin-right: 8px; font-size: 11px; align-self: center;"></div>
                                <button class="btn-approve btn-accept-single" onclick="setFileDecision('${message.requestId}', '${filePath}', 'accept', this)">Accept</button>
                                <button class="btn-deny btn-reject-single" onclick="setFileDecision('${message.requestId}', '${filePath}', 'reject', this)">Reject</button>
                            `;

              headerBar.appendChild(fileTitle);
              headerBar.appendChild(btnGroup);
              diffBoxWrapper.appendChild(headerBar);

              const diffBox = renderDiff(oldContent, newContent, filePath);
              diffBoxWrapper.appendChild(diffBox);
              diffBoxes.push(diffBoxWrapper);
            }
            displayPreInfo = true;
          }
        }
      } catch (error) {
        console.error('Error rendering diff:', error);
        displayPreInfo = false; // Fallback to raw JSON
      }

      div.innerHTML = `
                <div class="approval-box">
                    <strong>Tool Approval Required</strong>
                    <div style="margin-top:5px">Agent wants to run: <code>${escapeHtml(message.toolName)}</code></div>
                    <pre id="raw-input-${message.requestId}" style="margin:8px 0;padding:8px;background:var(--vscode-textCodeBlock-background);border-radius:4px;white-space:pre-wrap;font-size:12px;border:1px solid var(--vscode-panel-border); display: ${displayPreInfo ? 'none' : 'block'}">${escapeHtml(JSON.stringify(message.toolInput, null, 2))}</pre>
                    <div class="approval-diff-container" id="diff-${message.requestId}"></div>
                    <div class="approval-buttons" id="btns-${message.requestId}">
                        <button class="btn-approve" onclick="respondApproval('${message.requestId}', true)">${message.preInfo && message.preInfo.type === 'multi_file_change' ? 'Accept All' : 'Accept & Run'}</button>
                        <button class="btn-deny" onclick="respondApproval('${message.requestId}', false)">${message.preInfo && message.preInfo.type === 'multi_file_change' ? 'Reject All' : 'Reject'}</button>
                    </div>
                </div>
            `;
      chatContainer.appendChild(div);

      if (displayPreInfo && diffBoxes.length > 0) {
        const container = div.querySelector(`#diff-${message.requestId}`);
        if (container) {
          diffBoxes.forEach((box) => container.appendChild(box));
        }
      }

      chatContainer.scrollTop = chatContainer.scrollHeight;
      break;
    }
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
        skipSuggestionsOnce = true;
        const space = messageInput.value.length > 0 && !messageInput.value.endsWith(' ') ? ' ' : '';
        messageInput.value += space + '@' + message.path + ' ';
        messageInput.focus();
        messageInput.dispatchEvent(new Event('input')); // Trigger auto-resize
      }
      break;
    case 'indexingStatus': {
      const indicator = document.getElementById('indexing-indicator');
      if (indicator) {
        if (message.status === 'indexing') {
          indicator.classList.add('active');
          messageInput.disabled = true;
          messageInput.placeholder = 'Cogento is indexing...';
        } else {
          indicator.classList.remove('active');
          messageInput.disabled = false;
          messageInput.placeholder = 'Ask Cogento anything...';
        }
      }
      break;
    }
  }
});
function renderDiff(oldContent, newContent, filePath) {
  // PERF FIX: Cap lines before diffing. Rendering 1000+ DOM nodes synchronously
  // blocks the webview main thread and causes the "Working..." freeze.
  const MAX_DIFF_LINES = 100;
  let oldLines = (oldContent || '').split('\n');
  let newLines = (newContent || '').split('\n');
  const isTruncated = oldLines.length > MAX_DIFF_LINES || newLines.length > MAX_DIFF_LINES;
  if (oldLines.length > MAX_DIFF_LINES) oldLines = oldLines.slice(0, MAX_DIFF_LINES);
  if (newLines.length > MAX_DIFF_LINES) newLines = newLines.slice(0, MAX_DIFF_LINES);

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
  header.innerHTML = `<span>Change to: ${filePath}</span> <span>(Diff View${isTruncated ? ' — truncated' : ''})</span>`;
  box.appendChild(header);

  const container = document.createElement('div');
  container.style.maxHeight = '250px';
  container.style.overflowY = 'auto';
  container.style.whiteSpace = 'pre';
  container.style.padding = '4px 0';

  let i = 0,
    j = 0;
  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      addLine(container, i + 1, oldLines[i], '');
      i++;
      j++;
    } else {
      let advanced = false;
      if (i < oldLines.length && (j >= newLines.length || oldLines[i] !== newLines[j])) {
        addLine(container, i + 1, oldLines[i], 'deletion');
        i++;
        advanced = true;
      }
      // Be forgiving: if j needs to advance but the heuristic fails, force it to advance.
      if (j < newLines.length) {
        if (i === 0 || i - 1 >= oldLines.length || newLines[j] !== oldLines[i - 1] || !advanced) {
          addLine(container, j + 1, newLines[j], 'addition');
          j++;
          advanced = true;
        }
      }

      // Absolute safety net against infinite Webview locks
      if (!advanced) {
        if (i < oldLines.length) i++;
        if (j < newLines.length) j++;
      }
    }
  }

  if (isTruncated) {
    const notice = document.createElement('div');
    notice.style.padding = '4px 8px';
    notice.style.color = 'var(--vscode-descriptionForeground)';
    notice.style.fontSize = '10px';
    notice.textContent = '... (diff truncated to first 100 lines)';
    container.appendChild(notice);
  }

  box.appendChild(container);
  return box;
}

function addLine(container, num, content, type) {
  const line = document.createElement('div');
  line.style.display = 'flex';
  line.style.padding = '0 8px';

  if (type === 'addition') {
    line.style.backgroundColor =
      'var(--vscode-diffEditor-insertedTextBackground, rgba(46, 204, 113, 0.2))';
    line.style.borderLeft = '3px solid #2ecc71';
  } else if (type === 'deletion') {
    line.style.backgroundColor =
      'var(--vscode-diffEditor-removedTextBackground, rgba(231, 76, 60, 0.2))';
    line.style.borderLeft = '3px solid #e74c3c';
  }

  const escapedContent = (content || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

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
  const mentionMatch = textBeforeCursor.match(/@([a-zA-Z0-9._/-]*)$/);

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
  let droppedPath =
    e.dataTransfer.getData('text/uri-list') ||
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
      } catch { /* ignore */ }
    }
    vscode.postMessage({ command: 'fileDropped', path: droppedPath });
  }
});
