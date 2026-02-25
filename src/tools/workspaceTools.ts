import * as vscode from 'vscode';
import * as path from 'path';
import { AgentTool, ToolResult } from './index';

export class SearchCodeTool implements AgentTool {
  name = 'searchCode';
  description =
    'Searches for a regex pattern across all files in the workspace using VS Code native search. Returns up to 50 match previews with file paths and line numbers.';
  schema = {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Regex or text query to search for.' },
      isRegex: {
        type: 'boolean',
        description: 'Whether the query is a regular expression. Defaults to true.',
      },
      includes: {
        type: 'string',
        description: 'Glob pattern to filter files (e.g. *.ts, src/**). Optional.',
      },
    },
    required: ['query'],
  };

  async execute(
    input: { query: string; isRegex?: boolean; includes?: string },
    _onProgress?: (data: string) => void,
  ): Promise<ToolResult> {
    try {
      if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
        return { success: false, output: '', error: 'No workspace open to search.' };
      }

      const results: string[] = [];
      let matchCount = 0;
      const MAX_RESULTS = 50;

      const isReg = input.isRegex ?? true;
      const regex = new RegExp(
        isReg ? input.query : input.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        'gi',
      );

      const includeGlob = input.includes || '**/*';
      const excludeGlob = '**/{node_modules,.git,dist,out,build,.next,.nx,coverage}/**';

      const files = await vscode.workspace.findFiles(includeGlob, excludeGlob, 5000);

      const decoder = new TextDecoder('utf-8');

      for (const file of files) {
        if (matchCount >= MAX_RESULTS) break;

        try {
          const uint8array = await vscode.workspace.fs.readFile(file);
          const text = decoder.decode(uint8array);

          const lines = text.split('\n');
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            regex.lastIndex = 0;
            if (regex.test(line)) {
              if (matchCount < MAX_RESULTS) {
                const relativePath = vscode.workspace.asRelativePath(file);
                results.push(`${relativePath}:${i + 1} - ${line.trim()}`);
                matchCount++;
              } else {
                break;
              }
            }
          }
        } catch {
          // ignore unreadable files
        }
      }

      const output =
        results.length > 0
          ? `Found ${matchCount} matches${matchCount >= MAX_RESULTS ? ` (showing first ${MAX_RESULTS})` : ''}:\n${results.join('\n')}`
          : 'No matches found.';

      return {
        success: true,
        output,
      };
    } catch (err: unknown) {
      const e = err as Error;
      return { success: false, output: '', error: e.message };
    }
  }
}

export class SearchWorkspaceSymbolTool implements AgentTool {
  name = 'searchWorkspaceSymbol';
  description =
    'Searches for a symbol (like a class, function, or variable name) across the entire workspace using the native AST-based Language Server. This is equivalent to "Go To Symbol in Workspace".';
  schema = {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The symbol name to search for (e.g. "AuthService").' },
    },
    required: ['query'],
  };

  async execute(input: { query: string }): Promise<ToolResult> {
    try {
      const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
        'vscode.executeWorkspaceSymbolProvider',
        input.query,
      );

      if (!symbols || symbols.length === 0) {
        return { success: true, output: `No symbols found matching "${input.query}".` };
      }

      // Format the top 30 results
      const results = symbols.slice(0, 30).map((sym) => {
        const filePath = vscode.workspace.asRelativePath(sym.location.uri);
        const line = sym.location.range.start.line + 1;
        const kindName = vscode.SymbolKind[sym.kind] || 'Symbol';
        return `[${kindName}] ${sym.name} - ${filePath}:${line}${sym.containerName ? ` (in ${sym.containerName})` : ''}`;
      });

      return {
        success: true,
        output: `Found ${symbols.length} matching symbols:\n${results.join('\n')}`,
      };
    } catch (err: unknown) {
      return {
        success: false,
        output: '',
        error: `Failed to execute AST symbol search: ${(err as Error).message}`,
      };
    }
  }
}

export class FindSymbolReferencesTool implements AgentTool {
  name = 'findSymbolReferences';
  description =
    'Finds all references to a specific symbol in a given file. Equivalent to "Find All References". Requires the exact file path and symbol name as text.';
  schema = {
    type: 'object',
    properties: {
      filePath: {
        type: 'string',
        description: 'The relative or absolute file path containing the symbol.',
      },
      symbolName: {
        type: 'string',
        description: 'The exact name of the symbol to find references for.',
      },
    },
    required: ['filePath', 'symbolName'],
  };

  constructor(private workspaceRoot: string) {}

  async execute(input: { filePath: string; symbolName: string }): Promise<ToolResult> {
    try {
      if (!this.workspaceRoot) {
        return { success: false, output: '', error: 'No workspace open to search.' };
      }

      const absolutePath = path.resolve(this.workspaceRoot, input.filePath);
      const uri = vscode.Uri.file(absolutePath);

      // Read the file to locate the symbol's position
      let text = '';
      try {
        const data = await vscode.workspace.fs.readFile(uri);
        text = new TextDecoder('utf-8').decode(data);
      } catch {
        return {
          success: false,
          output: '',
          error: `File not found or unreadable: ${input.filePath}`,
        };
      }

      // Very simple index finder for MVP: find first occurrence of the symbol
      const index = text.indexOf(input.symbolName);
      if (index === -1) {
        return {
          success: false,
          output: '',
          error: `Symbol "${input.symbolName}" not found in ${input.filePath}.`,
        };
      }

      const linesToSymbol = text.substring(0, index).split('\n');
      const line = linesToSymbol.length - 1;
      const character = linesToSymbol[linesToSymbol.length - 1].length;
      const position = new vscode.Position(line, character);

      const locations = await vscode.commands.executeCommand<vscode.Location[]>(
        'vscode.executeReferenceProvider',
        uri,
        position,
      );

      if (!locations || locations.length === 0) {
        return { success: true, output: `No references found for "${input.symbolName}".` };
      }

      const MAX_RESULTS = 50;
      const results = locations.slice(0, MAX_RESULTS).map((loc) => {
        const refPath = vscode.workspace.asRelativePath(loc.uri);
        const refLine = loc.range.start.line + 1;
        return `${refPath}:${refLine}`;
      });

      return {
        success: true,
        output: `Found ${locations.length} references:\n${results.join('\n')}`,
      };
    } catch (err: unknown) {
      const e = err as Error;
      return { success: false, output: '', error: `Failed to find references: ${e.message}` };
    }
  }
}
