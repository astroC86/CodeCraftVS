// repositoryUpdater.ts
import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export class RepositoryUpdater {
    async updateRepository(repoUri: vscode.Uri): Promise<boolean> {
        const repoPath = repoUri.fsPath;
        
        // Create progress notification
        return vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Updating repository: ${repoPath}`,
            cancellable: false
        }, async (progress) => {
            try {
                // Step 1: Fetch latest changes
                progress.report({ message: 'Fetching latest changes...' });
                await execAsync('git fetch', { cwd: repoPath });

                // Step 2: Check for local changes
                const { stdout: statusOutput } = await execAsync('git status --porcelain', { cwd: repoPath });
                if (statusOutput.trim()) {
                    const answer = await vscode.window.showWarningMessage(
                        'Repository has local changes. Choose how to proceed:',
                        'Stash and Update',
                        'Reset and Update',
                        'Cancel'
                    );

                    if (answer === 'Cancel') {
                        return false;
                    }

                    if (answer === 'Stash and Update') {
                        progress.report({ message: 'Stashing local changes...' });
                        await execAsync('git stash', { cwd: repoPath });
                    } else if (answer === 'Reset and Update') {
                        progress.report({ message: 'Resetting local changes...' });
                        await execAsync('git reset --hard', { cwd: repoPath });
                    }
                }

                // Step 3: Get current branch
                const { stdout: branchOutput } = await execAsync(
                    'git rev-parse --abbrev-ref HEAD',
                    { cwd: repoPath }
                );
                const currentBranch = branchOutput.trim();

                // Step 4: Pull changes
                progress.report({ message: 'Pulling latest changes...' });
                const { stdout: pullOutput } = await execAsync(
                    `git pull origin ${currentBranch}`,
                    { cwd: repoPath }
                );

                // Step 5: Check if changes were applied
                if (pullOutput.includes('Already up to date')) {
                    vscode.window.showInformationMessage('Repository is already up to date');
                } else {
                    vscode.window.showInformationMessage('Repository updated successfully');
                }

                return true;

            } catch (error) {
                const errorMsg = error instanceof Error ? error.message : String(error);
                vscode.window.showErrorMessage(`Failed to update repository: ${errorMsg}`);
                return false;
            }
        });
    }
}