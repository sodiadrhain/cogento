# Cogento AI Coding Agent

**Cogento** is an open-source AI-powered coding agent built for VS Code. It combines a conversational chat interface with direct workspace interactions, allowing you to build, debug, and refactor code with the power of LLMs.

## 🚀 Features

- **Multi-Provider Support**: Switch seamlessly between OpenAI (GPT-4o), Anthropic (Claude 3.5), and Google Gemini (featuring the latest **Gemini 3 Pro/Flash Preview** models).
- **Workspace Context Awareness**: Cogento automatically indexes your project structure and tech stack on startup, providing the LLM with immediate architectural context.
- **Advanced Agentic Architecture**: Cogento acts like a real developer:
  - **Surgical Code Editing**: Uses search-and-replace block tracking to apply targeted AST diffs without regenerating massive files.
  - **Live Diagnostics**: Automatically runs linting checks against the VS Code syntax engine after editing a file, reading warning and error traces to self-correct its own code.
  - **Deep Workspace Indexing**: Leverages native VS Code `findFiles` and regex text parsing for whole-project structural awareness.
  - **AST Symbol Navigation**: Taps into the Language Server Protocol to instantly find Definitions and References in the editor.
  - **Visual Terminal Control**: Spawns visible Pseudo-TTY `vscode.window` instances to safely run dev servers, builds, and bash scripts.
- **Interactive Chat**:
  - **Copy Code**: One-click copy for all generated blocks via inline icons.
  - **Auto-complete Mentions**: Type `@` to suggest and include workspace files and folders in your prompt.
  - **Restore & Retry**: Quickly edit previous messages, or use the robust **"Retry Request"** recovery button if a complex LLM generation times out.
- **Top-Bar Controls**: Instantly access your API keys and provider configurations via the new Header Settings gear icon.
- **Multimodal Support**: Attach images to your prompts for visual context.
- **Clean UI**: A borderless, theme-aware layout that fits perfectly into your VS Code workspace with real-time "Working..." and chronological Tool Action statuses.
- **Conversation History**: Persistent chat history with multi-chat management.

## 🛠️ Getting Started

### Prerequisites

- [VS Code v1.93.0+](https://code.visualstudio.com/)

### Installation

1. Clone this repository.
2. Run `npm install`.
3. Press `F5` to open a new VS Code window with Cogento installed.

## ⚙️ Configuration

To use Cogento, you need to configure your API keys in VS Code settings:

1. Open **Settings** (`Cmd+,` or `Ctrl+,`).
2. Search for `Cogento`.
3. Provide your keys for:
   - `Api Keys: OpenAI`
   - `Api Keys: Anthropic`
   - `Api Keys: Gemini`
4. Select your default provider in `Provider`.

## 🤝 Contributing

Cogento is an open-source project and we welcome contributions! Whether it's fixing bugs, adding new providers, or improving the agent's tools, your help is appreciated.

Please see our [CONTRIBUTING.md](CONTRIBUTING.md) for more details.

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
