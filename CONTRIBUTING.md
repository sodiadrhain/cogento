# Contributing to Cogento

First off, thank you for considering contributing to Cogento! It's people like you that make Cogento such a great tool.

## How Can I Contribute?

### Reporting Bugs

- Use the GitHub Issue Tracker.
- Describe the bug and provide steps to reproduce.

### Suggesting Enhancements

- Open a GitHub Issue with the "enhancement" label.
- Explain why the feature would be useful.

### Pull Requests

1. Fork the repo and create your branch from `main`.
2. If you've added code that should be tested, add tests.
3. If you've changed APIs, update the documentation.
4. Ensure the test suite passes.
5. Make sure your code lints.
6. Issue that pull request!

## Development Setup

1. **Clone the repo**:

   ```bash
   git clone https://github.com/sodiadrhain/cogento.git
   cd cogento
   ```

2. **Install dependencies**:

   ```bash
   npm install
   ```

3. **Run the build in watch mode**:

   ```bash
   npm run watch
   ```

4. **Debug**:
   - Open the project in VS Code.
   - Press `F5` to start a new VS Code Instance with your changes.

## Coding Standards

- **Linting & Formatting**: We use ESLint and Prettier to maintain code quality.
  - Run `npm run lint` to check for errors.
  - Run `npm run format` to automatically format your code.
- **TypeScript**: Use strict type-checking where possible.
- **CSS**: Use the VS Code theme variables (`var(--vscode-...)`) to ensure theme compatibility.
- **Icons**: Use SVG for icons inside the webview, and monochromatic icons for the sidebar.

## License

By contributing, you agree that your contributions will be licensed under its MIT License.
