import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';

export class CraftignoreManager {
    async addToIgnore(repoUri: vscode.Uri): Promise<boolean> {
        try {
            const versionDir = path.dirname(repoUri.fsPath);
            const repoName = path.basename(repoUri.fsPath);
            const craftignorePath = path.join(versionDir, '.craftignore');

            // Check if .craftignore exists
            try {
                const currentContent = await fs.readFile(craftignorePath, 'utf8');
                const lines = currentContent.split('\n');
                
                // Check if repo is already ignored
                if (lines.some(line => line.trim() === repoName)) {
                    vscode.window.showInformationMessage(`${repoName} is already in .craftignore`);
                    return false;
                }
                
                // Append to existing file
                const updatedContent = currentContent.endsWith('\n') 
                    ? `${currentContent}${repoName}\n`
                    : `${currentContent}\n${repoName}\n`;
                
                await fs.writeFile(craftignorePath, updatedContent, 'utf8');
            } catch (error) {
                // File doesn't exist, create new
                await fs.writeFile(craftignorePath, `${repoName}\n`, 'utf8');
            }

            vscode.window.showInformationMessage(`Added ${repoName} to .craftignore`);
            return true;
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to update .craftignore: ${error}`);
            return false;
        }
    }
}