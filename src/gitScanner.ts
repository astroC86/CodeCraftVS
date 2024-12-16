// gitScanner.ts
import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import { CacheManager } from './cacheManager';
import * as path from 'path';

const execAsync = promisify(exec);

export interface RepositoryStatus {
    isGitRepo: boolean;
    commitsBehind: number;
    trackingInfo?: string;
    error?: string;
}

export interface Repository {
    name: string;
    uri: vscode.Uri;
    status: RepositoryStatus;
}

export class GitRepositoryScanner {
    private cacheManager: CacheManager;
    private MAX_CONCURRENT = 10; // Adjust based on system capabilities

    constructor() {
        this.cacheManager = new CacheManager();
    }

    async scanDirectory(folderUri: vscode.Uri): Promise<Repository[]> {
        try {
            const entries = await vscode.workspace.fs.readDirectory(folderUri);
            const directories = entries.filter(([_, type]) => type === vscode.FileType.Directory);

            // Process repositories in batches to avoid overwhelming the system
            const repositories: Repository[] = [];
            for (let i = 0; i < directories.length; i += this.MAX_CONCURRENT) {
                const batch = directories.slice(i, i + this.MAX_CONCURRENT);
                const batchResults = await Promise.all(
                    batch.map(async ([name]) => {
                        const repoPath = path.join(folderUri.fsPath, name);
                        const repoUri = vscode.Uri.file(repoPath);
                        
                        // Check cache first
                        const cachedStatus = this.cacheManager.get(repoPath);
                        if (cachedStatus) {
                            return {
                                name,
                                uri: repoUri,
                                status: cachedStatus
                            };
                        }

                        const status = await this.checkRepository(repoPath);
                        this.cacheManager.set(repoPath, status);
                        
                        return {
                            name,
                            uri: repoUri,
                            status
                        };
                    })
                );
                repositories.push(...batchResults);
            }

            return repositories;
        } catch (error) {
            console.error('Error scanning directory:', error);
            return [];
        }
    }

    private async checkRepository(repoPath: string): Promise<RepositoryStatus> {
        try {
            // Fast check for git repository
            const isGitRepo = await this.quickGitCheck(repoPath);
            if (!isGitRepo) {
                return { isGitRepo: false, commitsBehind: 0 };
            }

            // Fetch and status checks in parallel
            const [trackingInfo, behindCount] = await Promise.all([
                this.getTrackingInfo(repoPath),
                this.getCommitsBehind(repoPath)
            ]);

            if (!trackingInfo) {
                return {
                    isGitRepo: true,
                    commitsBehind: 0,
                    error: 'No tracking branch configured'
                };
            }

            return {
                isGitRepo: true,
                commitsBehind: behindCount,
                trackingInfo: `${trackingInfo.currentBranch} → ${trackingInfo.trackingBranch}`
            };

        } catch (error) {
            return {
                isGitRepo: true,
                commitsBehind: 0,
                error: `Error: ${error instanceof Error ? error.message : String(error)}`
            };
        }
    }

    private async quickGitCheck(repoPath: string): Promise<boolean> {
        try {
            await execAsync('git rev-parse --git-dir', { cwd: repoPath });
            return true;
        } catch {
            return false;
        }
    }

    private async getTrackingInfo(repoPath: string): Promise<{ currentBranch: string; trackingBranch: string; } | null> {
        try {
            const [currentBranch, trackingBranch] = await Promise.all([
                execAsync('git rev-parse --abbrev-ref HEAD', { cwd: repoPath }),
                execAsync('git rev-parse --abbrev-ref @{upstream}', { cwd: repoPath })
            ]);

            return {
                currentBranch: currentBranch.stdout.trim(),
                trackingBranch: trackingBranch.stdout.trim()
            };
        } catch {
            return null;
        }
    }

    private async getCommitsBehind(repoPath: string): Promise<number> {
        try {
            await execAsync('git fetch', { cwd: repoPath });
            const { stdout } = await execAsync('git rev-list --count HEAD..@{upstream}', { cwd: repoPath });
            return parseInt(stdout.trim() || '0');
        } catch {
            return 0;
        }
    }

    clearCache(): void {
        this.cacheManager.clear();
    }

    async getOverallStats(): Promise<{ totalRepos: number; reposBehind: number }> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            return { totalRepos: 0, reposBehind: 0 };
        }
    
        let totalRepos = 0;
        let reposBehind = 0;
    
        // Process each workspace folder
        for (const folder of workspaceFolders) {
            // Look specifically in the SRC directory
            const srcPath = vscode.Uri.file(path.join(folder.uri.fsPath, 'SRC'));
            
            try {
                // Get all version directories
                const entries = await vscode.workspace.fs.readDirectory(srcPath);
                const versionDirs = entries.filter(([name, type]) => 
                    type === vscode.FileType.Directory && 
                    name.toUpperCase() === name
                );
    
                // Process each version directory
                for (const [versionName] of versionDirs) {
                    const versionPath = vscode.Uri.file(path.join(srcPath.fsPath, versionName));
                    const repositories = await this.scanDirectory(versionPath);
                    
                    for (const repo of repositories) {
                        if (repo.status.isGitRepo && !repo.status.error) {
                            totalRepos++;
                            if (repo.status.commitsBehind > 0) {
                                reposBehind++;
                            }
                        }
                    }
                }
            } catch (error) {
                console.error('Error scanning SRC directory:', error);
            }
        }
    
        return { totalRepos, reposBehind };
    }
}