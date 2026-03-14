/**
 * 代理池管理模块
 * 支持自动分配代理给账号，支持多种分配策略
 */

import logger from './logger.js';
import crypto from 'crypto';

/**
 * 脱敏代理 URL（隐藏认证信息）
 */
function maskProxyUrl(proxyUrl) {
    try {
        const url = new URL(proxyUrl);
        if (url.username) {
            url.username = url.username.substring(0, 3) + '***';
            url.password = '***';
        }
        return url.toString();
    } catch {
        return proxyUrl?.substring(0, 20) + '***';
    }
}

export class ProxyPoolManager {
    constructor(config) {
        this.config = config;
        this.proxyPool = config.PROXY_POOL || [];
        this.assignStrategy = config.PROXY_ASSIGN_STRATEGY || 'hash';
        this.accountProxyMap = new Map();
        this.currentIndex = 0;

        logger.info(`[Proxy Pool] Initialized with ${this.proxyPool.length} proxies, strategy: ${this.assignStrategy}`);
    }

    /**
     * 为账号自动分配代理
     * @param {string} accountId - 账号 UUID
     * @param {Object} accountConfig - 账号配置
     * @returns {string|null} 代理 URL
     */
    assignProxyForAccount(accountId, accountConfig) {
        if (accountConfig?.PROXY_URL) {
            return accountConfig.PROXY_URL;
        }

        if (this.proxyPool.length === 0) {
            return null;
        }

        if (this.accountProxyMap.has(accountId)) {
            return this.accountProxyMap.get(accountId);
        }

        let proxyUrl;
        switch (this.assignStrategy) {
            case 'round-robin':
                proxyUrl = this._assignRoundRobin();
                break;
            case 'random':
                proxyUrl = this._assignRandom();
                break;
            case 'hash':
            default:
                proxyUrl = this._assignByHash(accountId);
        }

        this.accountProxyMap.set(accountId, proxyUrl);
        logger.info(`[Proxy Pool] Assigned proxy to ${accountId}: ${maskProxyUrl(proxyUrl)}`);

        return proxyUrl;
    }

    _assignRoundRobin() {
        const proxy = this.proxyPool[this.currentIndex];
        this.currentIndex = (this.currentIndex + 1) % this.proxyPool.length;
        return proxy;
    }

    _assignRandom() {
        const index = Math.floor(Math.random() * this.proxyPool.length);
        return this.proxyPool[index];
    }

    _assignByHash(accountId) {
        const hash = crypto.createHash('md5').update(accountId).digest('hex');
        const index = parseInt(hash.substring(0, 8), 16) % this.proxyPool.length;
        return this.proxyPool[index];
    }

    getPoolStats() {
        const stats = {
            totalProxies: this.proxyPool.length,
            assignedAccounts: this.accountProxyMap.size,
            distribution: {}
        };

        for (const proxy of this.proxyPool) {
            stats.distribution[maskProxyUrl(proxy)] = 0;
        }

        for (const proxyUrl of this.accountProxyMap.values()) {
            const masked = maskProxyUrl(proxyUrl);
            if (stats.distribution[masked] !== undefined) {
                stats.distribution[masked]++;
            }
        }

        return stats;
    }

    reassignAll() {
        this.accountProxyMap.clear();
        this.currentIndex = 0;
        logger.info('[Proxy Pool] Cleared all proxy assignments');
    }

    updateConfig(config) {
        this.proxyPool = config.PROXY_POOL || [];
        this.assignStrategy = config.PROXY_ASSIGN_STRATEGY || 'hash';
        // 代理池变了，清除旧的缓存映射
        this.accountProxyMap.clear();
        this.currentIndex = 0;
        logger.info(`[Proxy Pool] Config updated: ${this.proxyPool.length} proxies, strategy: ${this.assignStrategy}`);
    }
}
