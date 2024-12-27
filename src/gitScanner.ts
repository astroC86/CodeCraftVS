// gitScanner.ts
import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs/promises';
import { CacheManager } from './cacheManager';
// Logs provider
import { getLogsProvider } from './extension';

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
    private logsProvider = getLogsProvider(); // so we can log scanning steps
    private MAX_CONCURRENT = 10;

    constructor() {
        this.cacheManager = new CacheManager();
    }

    /**
     * Returns an array of *all* subdirectories under a folder (each treated as a repo),
     * ignoring .craftignore. This does *not* do logging or skipping.
     */
    async scanDirectory(folderUri: vscode.Uri): Promise<Repository[]> {
        try {
            const entries = await vscode.workspace.fs.readDirectory(folderUri);
            const directories = entries.filter(([_, type]) => type === vscode.FileType.Directory);

            const repositories: Repository[] = [];
            for (let i = 0; i < directories.length; i += this.MAX_CONCURRENT) {
                const batch = directories.slice(i, i + this.MAX_CONCURRENT);
                const batchResults = await Promise.all(
                    batch.map(async ([name]) => {
                        const repoPath = path.join(folderUri.fsPath, name);
                        const repoUri = vscode.Uri.file(repoPath);

                        // Check cache
                        const cachedStatus = this.cacheManager.get(repoPath);
                        if (cachedStatus) {
                            return { name, uri: repoUri, status: cachedStatus };
                        }

                        // Do a fresh check
                        const status = await this.checkRepository(repoPath);
                        this.cacheManager.set(repoPath, status);

                        return { name, uri: repoUri, status };
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

    /**
     * A helper method that:
     * 1) Reads .craftignore
     * 2) Filters out ignored repos
     * 3) Checks all active repos
     * 4) Logs progress for them (if you want logs)
     * 
     * Returns an array of *active* repos (each with a status).
     */
    async scanAndLogActiveRepos(
        workspaceFolderName: string,
        versionFolderName: string,
        versionFolderUri: vscode.Uri
    ): Promise<Repository[]> {
        // 1) Read .craftignore
        const craftignorePath = path.join(versionFolderUri.fsPath, '.craftignore');
        let ignoredRepos: string[] = [];
        try {
            const content = await fs.readFile(craftignorePath, 'utf8');
            ignoredRepos = content
                .split('\n')
                .map(line => line.trim())
                .filter(line => line && !line.startsWith('#'));
        } catch {
            // no .craftignore => no ignored repos
        }

        // 2) Get *all* subdirs
        const entries = await vscode.workspace.fs.readDirectory(versionFolderUri);
        const directories = entries
            .filter(([_, type]) => type === vscode.FileType.Directory)
            .map(([name]) => name);

        // 3) Filter out the ignored ones
        const activeRepos = directories.filter(name => !ignoredRepos.includes(name));

        // 4) For each active repo, do the normal checkRepository + logs
        const results: Repository[] = [];
        for (let i = 0; i < activeRepos.length; i += this.MAX_CONCURRENT) {
            const batch = activeRepos.slice(i, i + this.MAX_CONCURRENT);
            const batchResults = await Promise.all(
                batch.map(async (repoName) => {
                    const repoPath = path.join(versionFolderUri.fsPath, repoName);
                    const repoUri = vscode.Uri.file(repoPath);

                    // Maybe log that we are scanning
                    this.logsProvider.addLog(
                        workspaceFolderName,
                        versionFolderName,
                        repoName,
                        `Scanning repo: ${repoPath}`
                    );

                    // Check cache
                    const cachedStatus = this.cacheManager.get(repoPath);
                    if (cachedStatus) {
                        this.logsProvider.addLog(
                            workspaceFolderName,
                            versionFolderName,
                            repoName,
                            `Loaded from cache: behind=${cachedStatus.commitsBehind}`
                        );
                        return { name: repoName, uri: repoUri, status: cachedStatus };
                    }

                    // Check repository
                    const status = await this.checkRepository(repoPath);

                    // Add logs
                    if (!status.isGitRepo) {
                        this.logsProvider.addLog(
                            workspaceFolderName,
                            versionFolderName,
                            repoName,
                            `Not a Git repo.`
                        );
                    } else if (status.error) {
                        this.logsProvider.addLog(
                            workspaceFolderName,
                            versionFolderName,
                            repoName,
                            `Error: ${status.error}`
                        );
                    } else {
                        this.logsProvider.addLog(
                            workspaceFolderName,
                            versionFolderName,
                            repoName,
                            `Behind: ${status.commitsBehind} commits. Tracking: ${status.trackingInfo}`
                        );
                    }

                    this.cacheManager.set(repoPath, status);
                    return { name: repoName, uri: repoUri, status };
                })
            );
            results.push(...batchResults);
        }

        return results;
    }

    private async checkRepository(repoPath: string): Promise<RepositoryStatus> {
        try {
            // Quick check
            const isGitRepo = await this.quickGitCheck(repoPath);
            if (!isGitRepo) {
                return { isGitRepo: false, commitsBehind: 0 };
            }

            // Fetch + get behind info
            await execAsync('git fetch', { cwd: repoPath });
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
            const msg = error instanceof Error ? error.message : String(error);
            return {
                isGitRepo: true,
                commitsBehind: 0,
                error: `Error: ${msg}`
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
        this.logsProvider.addLog('ALL', 'ALL', 'ALL', 'Clearing cache');
        this.cacheManager.clear();
    }

    /**
     * Example: get overall stats for all *active* repos in the workspace
     * (excludes .craftignore).
     */
    async getOverallStats(): Promise<{ totalRepos: number; reposBehind: number }> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            return { totalRepos: 0, reposBehind: 0 };
        }

        let totalRepos = 0;
        let reposBehind = 0;

        for (const folder of workspaceFolders) {
            const srcPath = vscode.Uri.file(path.join(folder.uri.fsPath, 'SRC'));

            try {
                // For each uppercase version folder under SRC
                const entries = await vscode.workspace.fs.readDirectory(srcPath);
                const versionDirs = entries.filter(([name, type]) =>
                    type === vscode.FileType.Directory && name.toUpperCase() === name
                );

                for (const [versionName] of versionDirs) {
                    const versionUri = vscode.Uri.file(path.join(srcPath.fsPath, versionName));

                    // Reuse our "scanAndLogActiveRepos" method,
                    // or a variant that doesn't create logs if you prefer.
                    // We'll get only active repos (skipping .craftignore).
                    const repos = await this.scanAndLogActiveRepos(folder.name, versionName, versionUri);

                    // Count how many are behind
                    for (const r of repos) {
                        if (r.status.isGitRepo && !r.status.error) {
                            totalRepos++;
                            if (r.status.commitsBehind > 0) {
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
