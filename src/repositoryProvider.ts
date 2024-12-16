import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';


import { GitRepositoryScanner, RepositoryStatus } from './gitScanner';

interface TreeItemType extends vscode.TreeItem {
    itemType: 'section' | 'repository' | 'workspaceFolder' | 'versionFolder';
    parent?: string;
}

// Section specific tree item
class SectionTreeItem extends vscode.TreeItem implements TreeItemType {
    public readonly itemType = 'section';
    
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState
    ) {
        super(label, collapsibleState);
        this.contextValue = 'section';
    }
}

// Repository specific tree item
export class RepositoryItem extends vscode.TreeItem implements TreeItemType {
    public readonly itemType: 'repository' | 'workspaceFolder' | 'versionFolder';
    
    constructor(
        public readonly label: string,
        public readonly resourceUri: vscode.Uri,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        itemType: 'repository' | 'workspaceFolder' | 'versionFolder',
        public readonly iconPath: vscode.ThemeIcon | { light: vscode.Uri; dark: vscode.Uri },
        public readonly description?: string,
        public readonly parent?: string
    ) {
        super(label, collapsibleState);
        this.contextValue = itemType;
        this.itemType = itemType;
        this.tooltip = `${this.label}${this.description ? ` - ${this.description}` : ''}`;
    }
}

export class RepositoryProvider implements vscode.TreeDataProvider<TreeItemType> {
    private _onDidChangeTreeData: vscode.EventEmitter<TreeItemType | undefined | null | void> = new vscode.EventEmitter<TreeItemType | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<TreeItemType | undefined | null | void> = this._onDidChangeTreeData.event;

    constructor(private gitScanner: GitRepositoryScanner) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: TreeItemType): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: TreeItemType): Promise<TreeItemType[]> {
        if (!element) {
            // Root level - show sections
            return [
                new SectionTreeItem('Active' , vscode.TreeItemCollapsibleState.Expanded),
                new SectionTreeItem('Ignored', vscode.TreeItemCollapsibleState.Collapsed)
            ];
        } else if (element.itemType === 'section') {
            // Section level - get appropriate workspace folders
            return this.getWorkspaceFolders(element.label === 'Ignored');
        } else if (element.itemType === 'workspaceFolder') {
            // Show versions under SRC directory
            return this.getVersionFolders(element.resourceUri!, element.parent === 'Ignored');
        } else if (element.itemType === 'versionFolder') {
            // Show repositories under version folder
            return this.getRepositoriesInFolder(element.resourceUri!);
        }
        
        return [];
    }

    private async getWorkspaceFolders(showIgnored: boolean): Promise<RepositoryItem[]> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        
        if (!workspaceFolders) {
            return [];
        }

        return workspaceFolders.map(folder => new RepositoryItem(
            folder.name,
            folder.uri,
            vscode.TreeItemCollapsibleState.Expanded,
            'workspaceFolder',
            {
                light: vscode.Uri.file(path.join(__filename, '..', '..', 'resources', 'light', 'folder.svg')),
                dark: vscode.Uri.file(path.join(__filename, '..', '..', 'resources', 'dark', 'folder.svg'))
            },
            undefined,
            showIgnored ? 'Ignored' : 'Active'
        ));
    }

    private async getVersionFolders(workspaceUri: vscode.Uri, showIgnored: boolean): Promise<RepositoryItem[]> {
        const srcPath = vscode.Uri.file(path.join(workspaceUri.fsPath, 'SRC'));
        
        try {
            const entries = await vscode.workspace.fs.readDirectory(srcPath);
            const versionEntries = entries.filter(([name, type]) => 
                type === vscode.FileType.Directory && 
                name.toUpperCase() === name
            );

            const versionItems: RepositoryItem[] = [];

            for (const [name, _] of versionEntries) {
                const versionUri = vscode.Uri.file(path.join(srcPath.fsPath, name));
                const isFullyIgnored = await this.isVersionFullyIgnored(versionUri);
                
                // Only show version if it matches our section
                if (isFullyIgnored === showIgnored) {
                    versionItems.push(new RepositoryItem(
                        name,
                        versionUri,
                        vscode.TreeItemCollapsibleState.Expanded,
                        'versionFolder',
                        new vscode.ThemeIcon('folder'),
                        undefined,
                        showIgnored ? 'Ignored' : 'Active'
                    ));
                }
            }

            return versionItems;

        } catch (error) {
            console.error('Error reading SRC directory:', error);
            return [];
        }
    }

    private async getRepositoriesInFolder(versionUri: vscode.Uri): Promise<RepositoryItem[]> {
        const repositories = await this.gitScanner.scanDirectory(versionUri);
        
        return repositories.map(repo => {
            const label = repo.name;
            const status = repo.status;
            
            let description = '';
            let iconPath: vscode.ThemeIcon | { light: vscode.Uri; dark: vscode.Uri };
            
            if (status.error) {
                description = status.error;
                iconPath = new vscode.ThemeIcon('error');
            } else if (!status.isGitRepo) {
                description = 'Not a git repository';
                iconPath = new vscode.ThemeIcon('git-branch');
            } else {
                if (status.commitsBehind === 0) {
                    description = `Up to date${status.trackingInfo ? ` with ${status.trackingInfo}` : ''}`;
                    iconPath = new vscode.ThemeIcon('check');
                } else {
                    description = `${status.commitsBehind} commits behind${status.trackingInfo ? ` ${status.trackingInfo}` : ''}`;
                    iconPath = new vscode.ThemeIcon('alert');
                }
            }

            return new RepositoryItem(
                label,
                repo.uri,
                vscode.TreeItemCollapsibleState.None,
                'repository',
                iconPath,
                description
            );
        });
    }

    private async isVersionFullyIgnored(versionUri: vscode.Uri): Promise<boolean> {
        try {
            // Get all repositories in the version directory
            const entries = await vscode.workspace.fs.readDirectory(versionUri);
            const repos = entries.filter(([_, type]) => type === vscode.FileType.Directory);
            
            if (repos.length === 0) return false;

            // Read .craftignore file
            const craftignorePath = path.join(versionUri.fsPath, '.craftignore');
            let ignoredRepos: string[] = [];
            
            try {
                const craftignoreContent = await fs.readFile(craftignorePath, 'utf8');
                ignoredRepos = craftignoreContent
                    .split('\n')
                    .map((line: string) => line.trim())
                    .filter((line: string) => line && !line.startsWith('#'));
            } catch {
                return false; // No .craftignore file
            }

            // Check if all repositories are ignored
            return repos.every(([name]) => ignoredRepos.includes(name));

        } catch (error) {
            console.error('Error checking version ignore status:', error);
            return false;
        }
    }
}