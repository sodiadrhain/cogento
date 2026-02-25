import * as vscode from 'vscode';
import * as path from 'path';
import { AgentTool, ToolResult } from './index';

export class ReadFileTool implements AgentTool {
  name = 'readFile';
  description = 'Reads the string contents of a file at the given path.';
  schema = {
    type: 'object',
    properties: {
      filePath: { type: 'string', description: 'Absolute or relative path to the file.' },
    },
    required: ['filePath'],
  };

  constructor(private workspaceRoot: string) {}

  async execute(
    input: { filePath: string },
    _onProgress?: (data: string) => void,
  ): Promise<ToolResult> {
    if (!this.workspaceRoot) {
      return {
        success: false,
        output: '',
        error: 'No workspace folder is open. Please open a folder in VS Code first.',
      };
    }
    try {
      const absolutePath = path.resolve(this.workspaceRoot, input.filePath);
      const uri = vscode.Uri.file(absolutePath);
      const data = await vscode.workspace.fs.readFile(uri);
      const content = new TextDecoder('utf-8').decode(data);
      return { success: true, output: content };
    } catch (err: unknown) {
      const e = err as Error;
      return { success: false, output: '', error: e.message };
    }
  }
}

export class WriteFileTool implements AgentTool {
  name = 'writeFile';
  description =
    'Writes content to a file at the given path. WARNING: Overwrites the ENTIRE file if it exists. DO NOT use this for existing files (like Vue/Svelte components) unless you intend to completely replace the file. For existing files, use editFile.';
  schema = {
    type: 'object',
    properties: {
      filePath: { type: 'string', description: 'Path to write.' },
      contentLines: {
        type: 'array',
        items: { type: 'string' },
        description:
          'An array of strings, where each string is a line of the file. Do NOT include manual \\n escapes.',
      },
    },
    required: ['filePath', 'contentLines'],
  };
  requiresApproval = true;

  constructor(private workspaceRoot: string) {}

  async getPreExecutionInfo(input: { filePath: string; contentLines: string[] }): Promise<unknown> {
    if (!this.workspaceRoot) return null;
    try {
      const absolutePath = path.resolve(this.workspaceRoot, input.filePath);
      const uri = vscode.Uri.file(absolutePath);
      let oldContent = '';
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.size > 1024 * 1024) {
          oldContent = '(File too large for diff > 1MB)';
        } else {
          const data = await vscode.workspace.fs.readFile(uri);
          oldContent = new TextDecoder('utf-8').decode(data);
        }
      } catch {
        // File might be new
      }
      return {
        type: 'file_change',
        filePath: input.filePath,
        oldContent,
        newContent: (input.contentLines || []).join('\n'),
      };
    } catch {
      return null;
    }
  }

  async execute(
    input: { filePath: string; contentLines: string[] },
    onProgress?: (data: string) => void,
  ): Promise<ToolResult> {
    if (!this.workspaceRoot) {
      return {
        success: false,
        output: '',
        error: 'No workspace folder is open. Please open a folder in VS Code first.',
      };
    }
    try {
      const absolutePath = path.resolve(this.workspaceRoot, input.filePath);
      const uri = vscode.Uri.file(absolutePath);
      const content = (input.contentLines || []).join('\n');
      const data = new TextEncoder().encode(content);
      if (onProgress) {
        onProgress(`Writing approved changes to ${input.filePath}...\n`);
      }
      await vscode.workspace.fs.writeFile(uri, data);
      return { success: true, output: `Successfully wrote to ${input.filePath}` };
    } catch (err: unknown) {
      const e = err as Error;
      return { success: false, output: '', error: e.message };
    }
  }
}

export class WriteMultipleFilesTool implements AgentTool {
  name = 'writeMultipleFiles';
  description =
    'Writes content to multiple files at once. WARNING: Overwrites ENTIRE files if they exist. DO NOT use this for modifying existing files. For existing files, use editFile.';
  schema = {
    type: 'object',
    properties: {
      files: {
        type: 'array',
        description: 'Array of file modifications',
        items: {
          type: 'object',
          properties: {
            filePath: { type: 'string', description: 'Path to write.' },
            contentLines: {
              type: 'array',
              items: { type: 'string' },
              description:
                'An array of strings, where each string is a line of the file. Do NOT include manual \\n escapes.',
            },
          },
          required: ['filePath', 'contentLines'],
        },
      },
    },
    required: ['files'],
  };
  requiresApproval = true;

  constructor(private workspaceRoot: string) {}

  async getPreExecutionInfo(input: {
    files: { filePath: string; contentLines: string[] }[];
  }): Promise<unknown> {
    if (!this.workspaceRoot || !input.files) return null;
    try {
      const changes = [];
      for (const file of input.files) {
        const absolutePath = path.resolve(this.workspaceRoot, file.filePath);
        const uri = vscode.Uri.file(absolutePath);
        let oldContent = '';
        try {
          const stat = await vscode.workspace.fs.stat(uri);
          if (stat.size > 1024 * 1024) {
            oldContent = '(File too large for diff > 1MB)';
          } else {
            const data = await vscode.workspace.fs.readFile(uri);
            oldContent = new TextDecoder('utf-8').decode(data);
          }
        } catch {
          // File might be new
        }
        changes.push({
          filePath: file.filePath,
          oldContent,
          newContent: (file.contentLines || []).join('\n'),
        });
      }
      return {
        type: 'multi_file_change',
        changes,
      };
    } catch {
      return null;
    }
  }

  async execute(
    input: { files: { filePath: string; contentLines: string[] }[] },
    onProgress?: (data: string) => void,
  ): Promise<ToolResult> {
    if (!this.workspaceRoot) {
      return {
        success: false,
        output: '',
        error: 'No workspace folder is open. Please open a folder in VS Code first.',
      };
    }
    try {
      const outputs = [];
      for (const file of input.files || []) {
        if (onProgress) {
          onProgress(`Writing approved changes to ${file.filePath}...\n`);
        }
        const absolutePath = path.resolve(this.workspaceRoot, file.filePath);
        const uri = vscode.Uri.file(absolutePath);
        const content = (file.contentLines || []).join('\n');
        const data = new TextEncoder().encode(content);
        await vscode.workspace.fs.writeFile(uri, data);
        outputs.push(`Successfully wrote to ${file.filePath}`);
      }
      return { success: true, output: outputs.join('\n') };
    } catch (err: unknown) {
      const e = err as Error;
      return { success: false, output: '', error: e.message };
    }
  }
}

export class EditFileTool implements AgentTool {
  name = 'editFile';
  description =
    'Replaces exact blocks of text in a file. Use this for surgical edits instead of rewriting the entire file.';
  schema = {
    type: 'object',
    properties: {
      filePath: { type: 'string', description: 'Relative or absolute path to the file.' },
      replacements: {
        type: 'array',
        description: 'Array of search-and-replace blocks.',
        items: {
          type: 'object',
          properties: {
            targetContent: {
              type: 'string',
              description:
                'The exact block of text to be replaced. Must uniquely match something in the file. Include sufficient context lines if the string is short.',
            },
            replacementContent: {
              type: 'string',
              description: 'The new text to replace the targetContent with.',
            },
          },
          required: ['targetContent', 'replacementContent'],
        },
      },
    },
    required: ['filePath', 'replacements'],
  };
  requiresApproval = true;

  constructor(private workspaceRoot: string) {}

  async getPreExecutionInfo(input: {
    filePath: string;
    replacements: { targetContent: string; replacementContent: string }[];
  }): Promise<unknown> {
    if (!this.workspaceRoot) return null;
    try {
      const absolutePath = path.resolve(this.workspaceRoot, input.filePath);
      const uri = vscode.Uri.file(absolutePath);
      const data = await vscode.workspace.fs.readFile(uri);
      const oldContent = new TextDecoder('utf-8').decode(data);

      let newContent = oldContent;
      for (const rep of input.replacements) {
        newContent = newContent.replace(rep.targetContent, rep.replacementContent);
      }

      return {
        type: 'file_change',
        filePath: input.filePath,
        oldContent,
        newContent,
      };
    } catch {
      return null;
    }
  }

  async execute(
    input: {
      filePath: string;
      replacements: { targetContent: string; replacementContent: string }[];
    },
    onProgress?: (data: string) => void,
  ): Promise<ToolResult> {
    if (!this.workspaceRoot) {
      return { success: false, output: '', error: 'No workspace folder is open.' };
    }
    try {
      const absolutePath = path.resolve(this.workspaceRoot, input.filePath);
      const uri = vscode.Uri.file(absolutePath);
      const data = await vscode.workspace.fs.readFile(uri);
      const normalize = (s: string) => s.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '');

      let content = normalize(new TextDecoder('utf-8').decode(data));

      for (const rep of input.replacements) {
        const target = normalize(rep.targetContent);
        const replacement = normalize(rep.replacementContent);

        if (content.indexOf(target) === -1) {
          // Fallback: Try whitespace-insensitive matching for individual lines
          // This is a safety net for LLM indentation hallucinations
          const contentLines = content.split('\n');
          const targetLines = target.split('\n');
          let matchIndex = -1;

          for (let start = 0; start <= contentLines.length - targetLines.length; start++) {
            let matches = true;
            for (let l = 0; l < targetLines.length; l++) {
              if (contentLines[start + l].trim() !== targetLines[l].trim()) {
                matches = false;
                break;
              }
            }
            if (matches) {
              matchIndex = start;
              break;
            }
          }

          if (matchIndex === -1) {
            return {
              success: false,
              output: '',
              error: `Failed to edit ${input.filePath}. Target content not found (even with fuzzy matching). Ensure the block accurately reflects the file code.`,
            };
          }

          // If we found a fuzzy match, replace that specific range of lines
          contentLines.splice(matchIndex, targetLines.length, replacement);
          content = contentLines.join('\n');
        } else {
          content = content.replace(target, replacement);
        }
      }

      const writeData = new TextEncoder().encode(content);
      if (onProgress) {
        onProgress(`Applying surgical edits to ${input.filePath}...\n`);
      }
      await vscode.workspace.fs.writeFile(uri, writeData);
      return { success: true, output: `Successfully edited ${input.filePath}` };
    } catch (err: unknown) {
      const e = err as Error;
      return { success: false, output: '', error: e.message };
    }
  }
}
