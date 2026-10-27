import * as vscode from 'vscode';
import { DEFAULT_MODEL_CONFIG, validateModelConfig } from './config.js';
import type { ChatMessage } from './providers/openaiCompatible.js';
import { sendChatMessage } from './runtime.js';
import { scanWorkspace } from './workspace/context.js';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Nox AI');
  const chatHistory: ChatMessage[] = [];

  const chat = vscode.commands.registerCommand('noxAi.chat', async () => {
    const message = await vscode.window.showInputBox({ prompt: 'Message Nox AI using the configured local model' });
    if (!message?.trim()) {
      return;
    }

    try {
      const reply = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Nox AI is thinking',
      }, () => sendChatMessage(DEFAULT_MODEL_CONFIG, chatHistory, message));
      chatHistory.push({ role: 'user', content: message }, { role: 'assistant', content: reply });
      output.appendLine(`You: ${message}\nNox AI: ${reply}\n`);
      output.show(true);
    } catch (error) {
      void vscode.window.showErrorMessage(`Nox AI request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  const explain = vscode.commands.registerCommand('noxAi.explain', async () => {
    const config = validateModelConfig({
      provider: 'ollama',
      baseUrl: 'http://localhost:11434',
      model: 'llama3.1',
    });

    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    const root = workspaceFolders[0]?.uri.fsPath ?? process.cwd();
    const files = await scanWorkspace(root, { maxFiles: 20 });

    const summary = files.slice(0, 5).map((file) => file.path).join(', ') || 'No files indexed';
    void vscode.window.showInformationMessage(`Nox AI ready: ${config.provider} @ ${config.baseUrl} (${summary})`);
  });

  const validate = vscode.commands.registerCommand('noxAi.validateWorkspace', async () => {
    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    if (workspaceFolders.length === 0) {
      void vscode.window.showWarningMessage('No workspace folder is open.');
      return;
    }

    const root = workspaceFolders[0].uri.fsPath;
    const files = await scanWorkspace(root, { maxFiles: 50 });
    void vscode.window.showInformationMessage(`Scanned ${files.length} workspace files.`);
  });

  context.subscriptions.push(output, chat, explain, validate);
}

export function deactivate(): void {
  // Intentionally empty.
}
