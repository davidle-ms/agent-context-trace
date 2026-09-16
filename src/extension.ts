import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext): void {
    context.subscriptions.push(vscode.commands.registerCommand('agentContextTrace.show', () => {
        void vscode.window.showInformationMessage('Agent Context Trace');
    }));
}