import * as vscode from 'vscode';

/**
 * We'll group logs in a nested object:
 *   logsData[workspaceFolderName][versionFolderName][repoName] = array of log lines
 */
type LogsData = {
    [workspaceFolder: string]: {
        [versionFolder: string]: {
            [repoName: string]: string[];
        };
    };
};

export class LogsProvider implements vscode.TreeDataProvider<LogItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<LogItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private logsData: LogsData = {};

    constructor() {}

    /**
     * Add a log line for a specific workspace -> version -> repo
     */
    addLog(workspaceFolder: string, versionFolder: string, repoName: string, message: string) {
        if (!this.logsData[workspaceFolder]) {
            this.logsData[workspaceFolder] = {};
        }
        if (!this.logsData[workspaceFolder][versionFolder]) {
            this.logsData[workspaceFolder][versionFolder] = {};
        }
        if (!this.logsData[workspaceFolder][versionFolder][repoName]) {
            this.logsData[workspaceFolder][versionFolder][repoName] = [];
        }

        this.logsData[workspaceFolder][versionFolder][repoName].push(message);
        this._onDidChangeTreeData.fire();
    }

    clear() {
        this.logsData = {};
        this._onDidChangeTreeData.fire();
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: LogItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: LogItem): LogItem[] {
        if (!element) {
            // Root: workspace folders
            return Object.keys(this.logsData).map(ws => new LogItem(ws, 'workspaceFolder', vscode.TreeItemCollapsibleState.Expanded));
        }

        if (element.itemType === 'workspaceFolder') {
            // Show version folders
            const versionFolders = Object.keys(this.logsData[element.label]);
            return versionFolders.map(ver =>
                new LogItem(ver, 'versionFolder', vscode.TreeItemCollapsibleState.Expanded, element.label)
            );
        }

        if (element.itemType === 'versionFolder') {
            // Show repos
            const wsName = element.workspaceFolder!;
            const repoNames = Object.keys(this.logsData[wsName][element.label]);
            return repoNames.map(repo =>
                new LogItem(repo, 'repo', vscode.TreeItemCollapsibleState.Expanded, wsName, element.label)
            );
        }

        if (element.itemType === 'repo') {
            // Show log lines
            const wsName = element.workspaceFolder!;
            const verName = element.versionFolder!;
            const lines = this.logsData[wsName][verName][element.label];
            return lines.map((line, idx) => new LogItem(line, 'logLine', vscode.TreeItemCollapsibleState.None));
        }

        // Default
        return [];
    }
}

type LogItemType = 'workspaceFolder' | 'versionFolder' | 'repo' | 'logLine';

export class LogItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly itemType: LogItemType,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly workspaceFolder?: string,
        public readonly versionFolder?: string
    ) {
        super(label, collapsibleState);
        this.contextValue = itemType;
    }
}
