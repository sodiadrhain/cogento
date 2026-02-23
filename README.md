# Cogento AI Coding Agent

**Cogento** is an open-source AI-powered coding agent built for VS Code. It combines a conversational chat interface with direct workspace interactions, allowing you to build, debug, and refactor code with the power of LLMs.

![Activity Bar Icon](media/icon.svg)

## 🚀 Features

- **Multi-Provider Support**: Switch seamlessly between OpenAI (GPT-4), Anthropic (Claude 3.5), and Google Gemini.
- **Agentic Workflows**: Cogento can read files, write code, run terminal commands, and search your codebase.
- **Interactive Chat**:
  - **Copy Code**: One-click copy for all generated blocks.
  - **Restore Messages**: Quickly edit and resend previous messages.
  - **Auto-complete Mentions**: Type `@` to suggest and include workspace files and folders in your prompt.
- **Multimodal Support**: Attach images to your prompts for visual context.
- **Clean UI**: A borderless, theme-aware layout that fits perfectly into your VS Code workspace.
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
