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
      const data = await vscode.workspace.fs.readFile(uri);
      const content = new TextDecoder('utf-8').decode(data);
      return { success: true, output: content };
    } catch (error: any) {
      return { success: false, output: '', error: error.message };
    }
  }
}

export class WriteFileTool implements AgentTool {
  name = 'writeFile';
  description = 'Writes content to a file at the given path. Overwrites if it exists.';
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

  async getPreExecutionInfo(input: { filePath: string; contentLines: string[] }): Promise<any> {
    if (!this.workspaceRoot) return null;
    try {
      const absolutePath = path.resolve(this.workspaceRoot, input.filePath);
      const uri = vscode.Uri.file(absolutePath);
      let oldContent = '';
      try {
        const data = await vscode.workspace.fs.readFile(uri);
        oldContent = new TextDecoder('utf-8').decode(data);
      } catch (e) {
        // File might be new
      }
      return {
        type: 'file_change',
        filePath: input.filePath,
        oldContent,
        newContent: (input.contentLines || []).join('\n'),
      };
    } catch (error) {
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
      await vscode.workspace.fs.writeFile(uri, data);
      return { success: true, output: `Successfully wrote to ${input.filePath}` };
    } catch (error: any) {
      return { success: false, output: '', error: error.message };
    }
  }
}
