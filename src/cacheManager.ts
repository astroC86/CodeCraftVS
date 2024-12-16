// cacheManager.ts
import * as vscode from 'vscode';
import { RepositoryStatus } from './gitScanner';

interface CacheEntry {
    status: RepositoryStatus;
    timestamp: number;
}

export class CacheManager {
    private cache: Map<string, CacheEntry> = new Map();
    private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes

    set(repoPath: string, status: RepositoryStatus): void {
        this.cache.set(repoPath, {
            status,
            timestamp: Date.now()
        });
    }

    get(repoPath: string): RepositoryStatus | null {
        const entry = this.cache.get(repoPath);
        if (!entry) return null;
        
        if (Date.now() - entry.timestamp > this.CACHE_TTL) {
            this.cache.delete(repoPath);
            return null;
        }
        
        return entry.status;
    }

    clear(): void {
        this.cache.clear();
    }
}