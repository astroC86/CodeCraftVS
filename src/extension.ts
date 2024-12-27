import * as vscode from 'vscode';

import { GitRepositoryScanner } from './gitScanner';
import { CraftignoreManager } from './craftignoreManager';
import { RepositoryUpdater  } from './repositoryUpdater';
import { RepositoryProvider, RepositoryItem } from './repositoryProvider';
import { LogsProvider } from './logsProvider';

let logsProvider: LogsProvider;

export async function activate(context: vscode.ExtensionContext) {
    logsProvider             = new LogsProvider();
    const gitScanner         = new GitRepositoryScanner();
    const repositoryUpdater  = new RepositoryUpdater();
    const craftignoreManager = new CraftignoreManager();
    const repositoryProvider = new RepositoryProvider(gitScanner);
    
    // Register the tree data provider
    vscode.window.registerTreeDataProvider(
        'gitStatusChecker.repositoryView',
        repositoryProvider
    );
    
    vscode.window.registerTreeDataProvider(
        'gitStatusChecker.LogsView', 
        logsProvider
    );

    // Status bar item to show overall status
    const statusBarItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Left,
        100
    );
    statusBarItem.command = 'gitStatusChecker.checkStatus';
    context.subscriptions.push(statusBarItem);
    
    // Register refresh command
    let refreshCommand = vscode.commands.registerCommand(
        'gitStatusChecker.refresh',
        async () => {
            try {
                statusBarItem.text = "$(sync~spin) Checking repository status...";
                statusBarItem.show();
                await repositoryProvider.refresh();
                await updateStatusBar(statusBarItem, gitScanner);
            } catch (error) {
                vscode.window.showErrorMessage(
                    `Failed to refresh repository status: ${error}`
                );
            }
        }
    );

    let updateRepoCommand = vscode.commands.registerCommand(
        'gitStatusChecker.updateRepository',
        async (item: RepositoryItem) => {
            if (item.itemType === 'repository') {
                const success = await repositoryUpdater.updateRepository(item.resourceUri);
                if (success) {
                    repositoryProvider.refresh();
                }
            }
        }
    );
    
    // Register check status command
    let checkStatusCommand = vscode.commands.registerCommand(
        'gitStatusChecker.checkStatus',
        () => vscode.commands.executeCommand('gitStatusChecker.refresh')
    );
    
    // Register add to ignore command
    let addToIgnoreCommand = vscode.commands.registerCommand(
        'gitStatusChecker.addToIgnore',
        async (item: RepositoryItem) => {
            const answer = await vscode.window.showWarningMessage(
                `Are you sure you want to add ${item.label} to .craftignore?`,
                'Yes', 'No'
            );
            
            if (answer === 'Yes') {
                const success = await craftignoreManager.addToIgnore(item.resourceUri);
                if (success) {
                    repositoryProvider.refresh();
                }
            }
        }
    );
    
    // Add commands to subscriptions
    context.subscriptions.push(updateRepoCommand);
    context.subscriptions.push(refreshCommand);
    context.subscriptions.push(checkStatusCommand);
    context.subscriptions.push(addToIgnoreCommand);
    
    // Initial status check
    vscode.commands.executeCommand('gitStatusChecker.refresh');
}


async function updateStatusBar(
    statusBarItem: vscode.StatusBarItem,
    scanner: GitRepositoryScanner
): Promise<void> {
    const stats = await scanner.getOverallStats();
    
    if (stats.totalRepos === 0) {
        statusBarItem.text = "$(git-branch) No repositories found";
    } else if (stats.reposBehind === 0) {
        statusBarItem.text = `$(check) All ${stats.totalRepos} repositories up to date`;
    } else {
        statusBarItem.text = `$(alert) ${stats.reposBehind}/${stats.totalRepos} repositories need updates`;
    }
    
    statusBarItem.show();
}

export function getLogsProvider(): LogsProvider {
    return logsProvider;
}

export function deactivate() {}
