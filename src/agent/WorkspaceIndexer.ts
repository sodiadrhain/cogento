import * as vscode from 'vscode';
import * as path from 'path';

export interface ProjectInsight {
  techStack: string[];
  summary: string;
  structure: string;
}

export class WorkspaceIndexer {
  constructor(private workspaceRoot: string) {}

  async index(): Promise<string> {
    if (!this.workspaceRoot) return 'No workspace open.';

    const insight: ProjectInsight = {
      techStack: [],
      summary: 'Unknown project',
      structure: '',
    };

    try {
      const rootUri = vscode.Uri.file(this.workspaceRoot);
      const entries = await vscode.workspace.fs.readDirectory(rootUri);

      // 1. Get structure (top 2 levels)
      const structureLines: string[] = [];
      for (const [name, type] of entries) {
        if (name.startsWith('.') || name === 'node_modules') continue;
        structureLines.push(`- ${name}${type === vscode.FileType.Directory ? '/' : ''}`);
      }
      insight.structure = structureLines.join('\n');

      // 2. Scan core files for tech stack and summary
      const highValueFiles = [
        'package.json',
        'README.md',
        'tsconfig.json',
        'requirements.txt',
        'pyproject.toml',
        'Cargo.toml',
        'go.mod',
        'Gemfile',
        'composer.json',
        'build.gradle',
        'pom.xml',
        'Makefile',
        'Dockerfile',
      ];

      const detectedLangs = new Set<string>();

      for (const file of highValueFiles) {
        const fileUri = vscode.Uri.file(path.join(this.workspaceRoot, file));
        try {
          const data = await vscode.workspace.fs.readFile(fileUri);
          const content = Buffer.from(data).toString('utf-8');

          if (file === 'package.json') {
            const pkg = JSON.parse(content);
            const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
            insight.techStack.push(...deps);
            if (pkg.description) insight.summary = pkg.description;
            detectedLangs.add('JavaScript/TypeScript (Node.js)');
          } else if (file === 'README.md') {
            const lines = content.split('\n').filter((l) => l.trim().length > 0);
            if (lines.length > 0 && insight.summary === 'Unknown project') {
              insight.summary = lines.slice(0, 3).join(' ');
            }
          } else if (file === 'requirements.txt' || file === 'pyproject.toml') {
            detectedLangs.add('Python');
          } else if (file === 'Cargo.toml') {
            detectedLangs.add('Rust');
          } else if (file === 'go.mod') {
            detectedLangs.add('Go');
          } else if (file === 'Gemfile') {
            detectedLangs.add('Ruby');
          } else if (file === 'composer.json') {
            detectedLangs.add('PHP');
          } else if (file === 'build.gradle' || file === 'pom.xml') {
            detectedLangs.add('Java/Kotlin');
          } else if (file === 'Makefile') {
            detectedLangs.add('C/C++ (Make)');
          } else if (file === 'Dockerfile') {
            detectedLangs.add('Docker');
          }
        } catch {
          // File might not exist, skip
          if (file.endsWith('.csproj')) detectedLangs.add('C# (.NET)');
        }
      }

      // Fallback for file extensions if no config files found
      if (detectedLangs.size === 0) {
        for (const [name, type] of entries) {
          if (type === vscode.FileType.File) {
            if (name.endsWith('.py')) detectedLangs.add('Python');
            if (name.endsWith('.rs')) detectedLangs.add('Rust');
            if (name.endsWith('.go')) detectedLangs.add('Go');
            if (name.endsWith('.rb')) detectedLangs.add('Ruby');
            if (name.endsWith('.php')) detectedLangs.add('PHP');
            if (name.endsWith('.java') || name.endsWith('.kt')) detectedLangs.add('Java/Kotlin');
            if (name.endsWith('.cs')) detectedLangs.add('C# (.NET)');
            if (name.endsWith('.cpp') || name.endsWith('.c') || name.endsWith('.h'))
              detectedLangs.add('C/C++');
          }
        }
      }

      if (detectedLangs.size > 0) {
        // Use Array.from instead of spread to satisfy TS target limitations possibly
        const langsArray = Array.from(detectedLangs);
        insight.techStack.unshift(...langsArray);
      }

      return this.formatInsight(insight as ProjectInsight);
    } catch (error) {
      console.error('Indexing failed:', error);
      return 'Failed to index workspace infrastructure.';
    }
  }

  private formatInsight(insight: ProjectInsight): string {
    return `
PROJECT INSIGHT:
----------------
Summary: ${insight.summary}
Tech Stack: ${insight.techStack.length > 0 ? insight.techStack.slice(0, 15).join(', ') + (insight.techStack.length > 15 ? '...' : '') : 'Not detected'}
Structure:
${insight.structure}
----------------
`;
  }
}
