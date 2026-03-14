/**
 * 代理管理模块
 * Proxy Management Module
 */

const PROXY_PAGE_SIZE = 10;

class ProxyManager {
    constructor() {
        this.proxyPool = [];
        this.assignStrategy = 'hash';
        this.autoAssign = true;
        this.outboundProxy = '';
        this.stats = null;
        this.healthStatus = {};
        this.selectedIndices = new Set();
        this.currentPage = 1;
        this.init();
    }

    async init() {
        if (document.readyState === 'loading') {
            await new Promise(resolve => {
                window.addEventListener('componentsLoaded', resolve, { once: true });
            });
        }

        await this.loadProxyPool();
        this.bindEvents();
        this.render();
    }

    async loadProxyPool() {
        try {
            const response = await fetch('/api/proxy-pool', {
                headers: {
                    'Authorization': `Bearer ${localStorage.getItem('authToken')}`
                }
            });
            const data = await response.json();
            if (data.success) {
                this.proxyPool = data.data.proxyPool || [];
                this.assignStrategy = data.data.assignStrategy || 'hash';
                this.autoAssign = data.data.autoAssign !== false;
                this.outboundProxy = data.data.outboundProxy || '';
                this.stats = data.data.stats;
            }
        } catch (error) {
            console.error('Failed to load proxy pool:', error);
            this.showToast('加载代理池配置失败', 'error');
        }
    }

    get totalPages() {
        return Math.max(1, Math.ceil(this.proxyPool.length / PROXY_PAGE_SIZE));
    }

    get pagedProxies() {
        const start = (this.currentPage - 1) * PROXY_PAGE_SIZE;
        return this.proxyPool.slice(start, start + PROXY_PAGE_SIZE).map((proxy, i) => ({
            proxy,
            index: start + i
        }));
    }

    bindEvents() {
        const addProxyBtn = document.getElementById('addProxyBtn');
        if (addProxyBtn) {
            addProxyBtn.addEventListener('click', () => this.showAddProxyDialog());
        }

        const saveProxyPoolBtn = document.getElementById('saveProxyPoolBtn');
        if (saveProxyPoolBtn) {
            saveProxyPoolBtn.addEventListener('click', () => this.saveProxyPool());
        }

        const checkProxyHealthBtn = document.getElementById('checkProxyHealthBtn');
        if (checkProxyHealthBtn) {
            checkProxyHealthBtn.addEventListener('click', () => this.checkProxyHealth());
        }

        const selectAllCheckbox = document.getElementById('proxySelectAll');
        if (selectAllCheckbox) {
            selectAllCheckbox.addEventListener('change', (e) => this.toggleSelectAll(e.target.checked));
        }

        const batchDeleteBtn = document.getElementById('batchDeleteProxyBtn');
        if (batchDeleteBtn) {
            batchDeleteBtn.addEventListener('click', () => this.batchDelete());
        }

        const deleteUnhealthyBtn = document.getElementById('deleteUnhealthyBtn');
        if (deleteUnhealthyBtn) {
            deleteUnhealthyBtn.addEventListener('click', () => this.deleteUnhealthy());
        }
    }

    render() {
        this.renderProxyPool();
        this.renderPagination();
        this.renderToolbar();
        this.renderStats();
    }

    _getHealthDot(proxy) {
        const h = this.healthStatus[proxy];
        if (!h) return '<span class="proxy-health-dot health-unknown" title="未检测"></span>';
        if (h.checking) return '<span class="proxy-health-dot health-checking"><i class="fas fa-spinner fa-spin" style="font-size:10px"></i></span>';
        if (h.healthy) return `<span class="proxy-health-dot health-ok" title="正常 ${h.latency}ms"></span><span class="proxy-latency">${h.latency}ms</span>${h.ip ? `<span class="proxy-latency" style="color:var(--text-tertiary)">${h.ip}</span>` : ''}`;
        return `<span class="proxy-health-dot health-fail" title="${h.error || '不可用'}"></span><span class="proxy-error-text" title="${h.error || ''}">${h.error || '不可用'}</span>`;
    }

    renderToolbar() {
        const toolbar = document.getElementById('proxyListToolbar');
        if (!toolbar) return;

        toolbar.style.display = this.proxyPool.length > 0 ? 'flex' : 'none';

        const countInfo = document.getElementById('proxyCountInfo');
        if (countInfo) {
            countInfo.textContent = `共 ${this.proxyPool.length} 个代理`;
        }

        const batchDeleteBtn = document.getElementById('batchDeleteProxyBtn');
        if (batchDeleteBtn) {
            batchDeleteBtn.style.display = this.selectedIndices.size > 0 ? 'inline-flex' : 'none';
            if (this.selectedIndices.size > 0) {
                batchDeleteBtn.innerHTML = `<i class="fas fa-trash"></i> 删除选中 (${this.selectedIndices.size})`;
            }
        }

        const deleteUnhealthyBtn = document.getElementById('deleteUnhealthyBtn');
        if (deleteUnhealthyBtn) {
            const unhealthyCount = this.proxyPool.filter(p => this.healthStatus[p] && !this.healthStatus[p].healthy).length;
            deleteUnhealthyBtn.style.display = unhealthyCount > 0 ? 'inline-flex' : 'none';
            if (unhealthyCount > 0) {
                deleteUnhealthyBtn.innerHTML = `<i class="fas fa-times-circle"></i> 删除不可用 (${unhealthyCount})`;
            }
        }

        const selectAllCheckbox = document.getElementById('proxySelectAll');
        if (selectAllCheckbox) {
            const pageIndices = this.pagedProxies.map(p => p.index);
            const allPageSelected = pageIndices.length > 0 && pageIndices.every(i => this.selectedIndices.has(i));
            selectAllCheckbox.checked = allPageSelected;
            selectAllCheckbox.indeterminate = !allPageSelected && pageIndices.some(i => this.selectedIndices.has(i));
        }
    }

    renderProxyPool() {
        const container = document.getElementById('proxyPoolList');
        if (!container) return;

        if (this.proxyPool.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <i class="fas fa-network-wired"></i>
                    <p>暂无代理配置</p>
                    <small>点击下方按钮添加代理</small>
                </div>
            `;
        } else {
            container.innerHTML = this.pagedProxies.map(({ proxy, index }) => `
                <div class="proxy-item">
                    <input type="checkbox" class="proxy-checkbox" data-index="${index}" ${this.selectedIndices.has(index) ? 'checked' : ''} onchange="proxyManager.toggleSelect(${index}, this.checked)" />
                    <i class="fas fa-server proxy-icon"></i>
                    <input type="text" value="${proxy}" data-index="${index}" class="proxy-input" />
                    <span class="proxy-health-info">${this._getHealthDot(proxy)}</span>
                    <button class="btn-danger" onclick="proxyManager.removeProxy(${index})">
                        <i class="fas fa-trash"></i>
                    </button>
                </div>
            `).join('');
        }

        const autoAssignCheckbox = document.getElementById('autoAssignProxy');
        if (autoAssignCheckbox) {
            autoAssignCheckbox.checked = this.autoAssign;
        }

        const assignStrategySelect = document.getElementById('assignStrategy');
        if (assignStrategySelect) {
            assignStrategySelect.value = this.assignStrategy;
        }

        const outboundInput = document.getElementById('proxyPoolOutbound');
        if (outboundInput) {
            outboundInput.value = this.outboundProxy;
        }
    }

    renderPagination() {
        const container = document.getElementById('proxyPagination');
        if (!container) return;

        if (this.totalPages <= 1) {
            container.innerHTML = '';
            return;
        }

        container.innerHTML = `
            <button class="btn-small pagination-btn" ${this.currentPage <= 1 ? 'disabled' : ''} onclick="proxyManager.goToPage(${this.currentPage - 1})">
                <i class="fas fa-chevron-left"></i>
            </button>
            <span class="pagination-info">${this.currentPage} / ${this.totalPages}</span>
            <button class="btn-small pagination-btn" ${this.currentPage >= this.totalPages ? 'disabled' : ''} onclick="proxyManager.goToPage(${this.currentPage + 1})">
                <i class="fas fa-chevron-right"></i>
            </button>
        `;
    }

    goToPage(page) {
        if (page < 1 || page > this.totalPages) return;
        this.currentPage = page;
        this.renderProxyPool();
        this.renderPagination();
        this.renderToolbar();
    }

    toggleSelect(index, checked) {
        if (checked) {
            this.selectedIndices.add(index);
        } else {
            this.selectedIndices.delete(index);
        }
        this.renderToolbar();
    }

    toggleSelectAll(checked) {
        const pageIndices = this.pagedProxies.map(p => p.index);
        if (checked) {
            pageIndices.forEach(i => this.selectedIndices.add(i));
        } else {
            pageIndices.forEach(i => this.selectedIndices.delete(i));
        }
        this.renderProxyPool();
        this.renderToolbar();
    }

    async batchDelete() {
        if (this.selectedIndices.size === 0) return;

        const count = this.selectedIndices.size;
        const confirmed = window.showConfirm
            ? await window.showConfirm(`确定要删除选中的 ${count} 个代理吗？`)
            : confirm(`确定要删除选中的 ${count} 个代理吗？`);

        if (!confirmed) return;

        // 从大到小排序，避免删除时索引偏移
        const sorted = [...this.selectedIndices].sort((a, b) => b - a);
        for (const idx of sorted) {
            this.proxyPool.splice(idx, 1);
        }
        this.selectedIndices.clear();

        // 修正页码
        if (this.currentPage > this.totalPages) {
            this.currentPage = this.totalPages;
        }

        this.render();
        this.showToast(`已删除 ${count} 个代理`, 'success');
    }

    async deleteUnhealthy() {
        const unhealthy = this.proxyPool.filter(p => this.healthStatus[p] && !this.healthStatus[p].healthy);
        if (unhealthy.length === 0) return;

        const confirmed = window.showConfirm
            ? await window.showConfirm(`确定要删除 ${unhealthy.length} 个不可用代理吗？`)
            : confirm(`确定要删除 ${unhealthy.length} 个不可用代理吗？`);

        if (!confirmed) return;

        this.proxyPool = this.proxyPool.filter(p => !(this.healthStatus[p] && !this.healthStatus[p].healthy));
        this.selectedIndices.clear();

        if (this.currentPage > this.totalPages) {
            this.currentPage = this.totalPages;
        }

        this.render();
        this.showToast(`已删除 ${unhealthy.length} 个不可用代理`, 'success');
    }

    renderStats() {
        const statsContainer = document.getElementById('proxyStats');
        if (!statsContainer || !this.stats) return;

        const distributionHtml = Object.entries(this.stats.distribution || {}).map(([proxy, count]) => `
            <div class="dist-item">
                <span class="proxy-name">${proxy}</span>
                <span class="account-count">${count} 个账号</span>
            </div>
        `).join('');

        statsContainer.innerHTML = `
            <h4>统计信息</h4>
            <p>代理池大小: ${this.stats.totalProxies}</p>
            <p>已分配账号: ${this.stats.assignedAccounts}</p>
            <div class="distribution">
                ${distributionHtml}
            </div>
        `;
    }

    async checkProxyHealth() {
        if (this.proxyPool.length === 0) {
            this.showToast('代理池为空', 'warning');
            return;
        }

        const proxyInputs = document.querySelectorAll('.proxy-input');
        const currentProxies = Array.from(proxyInputs).map(input => input.value.trim()).filter(v => v);
        if (currentProxies.length === 0) {
            this.showToast('代理池为空', 'warning');
            return;
        }

        const btn = document.getElementById('checkProxyHealthBtn');
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 检测中...';
        }

        this.healthStatus = {};
        currentProxies.forEach(p => { this.healthStatus[p] = { checking: true }; });
        this.renderProxyPool();

        try {
            const response = await fetch('/api/proxy-pool/health-check', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${localStorage.getItem('authToken')}`
                },
                body: JSON.stringify({ proxies: currentProxies, outboundProxy: this.outboundProxy || null })
            });
            const data = await response.json();
            if (data.success) {
                this.healthStatus = {};
                for (const item of data.data) {
                    this.healthStatus[item.proxy] = item;
                }
                const ok = data.data.filter(d => d.healthy).length;
                this.showToast(`检测完成：${ok}/${data.data.length} 可用`, ok === data.data.length ? 'success' : 'warning');
            } else {
                this.showToast('检测失败: ' + data.error, 'error');
            }
        } catch (error) {
            console.error('Health check failed:', error);
            this.showToast('检测请求失败', 'error');
        }

        this.render();

        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<i class="fas fa-heartbeat"></i> 检测代理';
        }
    }

    showAddProxyDialog() {
        const modal = document.createElement('div');
        modal.className = 'proxy-modal-overlay';
        modal.innerHTML = `
            <div class="proxy-modal">
                <div class="proxy-modal-header">
                    <h3>添加代理</h3>
                    <button class="proxy-modal-close" onclick="this.closest('.proxy-modal-overlay').remove()">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
                <div class="proxy-modal-body">
                    <div class="form-group">
                        <label>默认协议</label>
                        <select id="proxyProtocolSelect" class="proxy-input-large" style="height:auto;padding:10px 12px;font-family:inherit">
                            <option value="http">HTTP / HTTPS</option>
                            <option value="socks5">SOCKS5</option>
                            <option value="socks4">SOCKS4</option>
                        </select>
                        <small class="form-hint">
                            当代理地址没有协议前缀时，自动添加此协议
                        </small>
                    </div>
                    <div class="form-group">
                        <label>代理地址（每行一个）</label>
                        <textarea id="newProxyUrl" class="proxy-input-large"
                               rows="6"
                               placeholder="支持多种格式，每行一个：&#10;host:port:username:password&#10;username:password@host:port&#10;host:port@username:password&#10;http://user:pass@host:port"></textarea>
                        <small class="form-hint">
                            已有协议前缀（http://、socks5://）的地址不受上方选择影响
                        </small>
                    </div>
                </div>
                <div class="proxy-modal-footer">
                    <button class="btn-secondary" onclick="this.closest('.proxy-modal-overlay').remove()">取消</button>
                    <button class="btn-primary" id="confirmAddProxy">添加</button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        const input = document.getElementById('newProxyUrl');
        input.focus();

        document.getElementById('confirmAddProxy').addEventListener('click', () => {
            const protocol = document.getElementById('proxyProtocolSelect').value;
            const lines = input.value.split('\n').map(l => l.trim()).filter(l => l);
            if (lines.length === 0) {
                this.showToast('请输入代理地址', 'warning');
                return;
            }
            // 对没有协议前缀的地址，加上选择的协议
            const normalized = lines.map(line => {
                if (/^(socks[45]?|https?):\/\//i.test(line)) return line;
                return this._normalizeProxyLine(line, protocol);
            });
            const newOnes = normalized.filter(l => !this.proxyPool.includes(l));
            this.proxyPool.push(...newOnes);
            // 跳到最后一页看新添加的
            this.currentPage = this.totalPages;
            this.render();
            modal.remove();
            this.showToast(`已添加 ${newOnes.length} 个代理${lines.length > newOnes.length ? `（${lines.length - newOnes.length} 个重复已跳过）` : ''}`, 'success');
        });

        modal.addEventListener('click', (e) => {
            if (e.target === modal) modal.remove();
        });
    }

    removeProxy(index) {
        const proxy = this.proxyPool[index];
        const modal = document.createElement('div');
        modal.className = 'proxy-modal-overlay';
        modal.innerHTML = `
            <div class="proxy-modal" style="max-width:420px">
                <div class="proxy-modal-header">
                    <h3>删除代理</h3>
                    <button class="proxy-modal-close" onclick="this.closest('.proxy-modal-overlay').remove()">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
                <div class="proxy-modal-body">
                    <p style="margin:0;color:var(--text-secondary)">确定要删除以下代理吗？</p>
                    <code style="display:block;margin-top:12px;padding:10px;background:var(--bg-secondary);border-radius:6px;font-size:13px;word-break:break-all">${proxy}</code>
                </div>
                <div class="proxy-modal-footer">
                    <button class="btn-secondary" onclick="this.closest('.proxy-modal-overlay').remove()">取消</button>
                    <button class="btn-danger" id="confirmRemoveProxy">删除</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        document.getElementById('confirmRemoveProxy').addEventListener('click', () => {
            this.proxyPool.splice(index, 1);
            this.selectedIndices.delete(index);
            if (this.currentPage > this.totalPages) {
                this.currentPage = this.totalPages;
            }
            this.render();
            modal.remove();
            this.showToast('代理已删除', 'success');
        });
        modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
    }

    async saveProxyPool() {
        try {
            const proxyInputs = document.querySelectorAll('.proxy-input');
            // 只更新当前页的值到 proxyPool
            proxyInputs.forEach(input => {
                const idx = parseInt(input.dataset.index);
                if (!isNaN(idx) && idx < this.proxyPool.length) {
                    this.proxyPool[idx] = input.value.trim();
                }
            });
            this.proxyPool = this.proxyPool.filter(v => v);

            const autoAssignCheckbox = document.getElementById('autoAssignProxy');
            this.autoAssign = autoAssignCheckbox ? autoAssignCheckbox.checked : true;

            const assignStrategySelect = document.getElementById('assignStrategy');
            this.assignStrategy = assignStrategySelect ? assignStrategySelect.value : 'hash';

            const outboundInput = document.getElementById('proxyPoolOutbound');
            this.outboundProxy = outboundInput ? outboundInput.value.trim() : '';

            const response = await fetch('/api/proxy-pool', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${localStorage.getItem('authToken')}`
                },
                body: JSON.stringify({
                    proxyPool: this.proxyPool,
                    assignStrategy: this.assignStrategy,
                    autoAssign: this.autoAssign,
                    outboundProxy: this.outboundProxy
                })
            });

            const data = await response.json();
            if (data.success) {
                this.showToast('代理池配置已保存', 'success');
                await this.loadProxyPool();
                this.render();
            } else {
                this.showToast('保存失败: ' + data.error, 'error');
            }
        } catch (error) {
            console.error('Failed to save proxy pool:', error);
            this.showToast('保存失败', 'error');
        }
    }

    showToast(message, type = 'info') {
        if (window.showToast) {
            window.showToast(message, type);
        } else {
            alert(message);
        }
    }

    /**
     * 前端标准化代理地址（与后端 normalizeProxyUrl 逻辑一致）
     */
    _normalizeProxyLine(line, protocol = 'http') {
        if (!line) return line;
        // 已有协议头直接返回
        if (/^(socks[45]?|https?):\/\//i.test(line)) return line;

        // 有 @ 符号
        if (line.includes('@')) {
            const atIdx = line.indexOf('@');
            const left = line.substring(0, atIdx);
            const right = line.substring(atIdx + 1);
            const leftParts = left.split(':');
            const rightParts = right.split(':');

            if (rightParts.length >= 2 && /^\d+$/.test(rightParts[rightParts.length - 1])) {
                // user:pass@host:port
                const port = rightParts.pop();
                const host = rightParts.join(':');
                return `${protocol}://${left}@${host}:${port}`;
            } else if (leftParts.length >= 2 && /^\d+$/.test(leftParts[leftParts.length - 1])) {
                // host:port@user:pass
                const port = leftParts.pop();
                const host = leftParts.join(':');
                return `${protocol}://${right}@${host}:${port}`;
            }
            return `${protocol}://${line}`;
        }

        // hostname:port:username:password
        const parts = line.split(':');
        if (parts.length === 4 && /^\d+$/.test(parts[1])) {
            return `${protocol}://${parts[2]}:${parts[3]}@${parts[0]}:${parts[1]}`;
        }
        // host:port
        if (parts.length === 2 && /^\d+$/.test(parts[1])) {
            return `${protocol}://${parts[0]}:${parts[1]}`;
        }
        return `${protocol}://${line}`;
    }
}

// 初始化代理管理器
let proxyManager;
window.addEventListener('componentsLoaded', () => {
    proxyManager = new ProxyManager();
    window.proxyManager = proxyManager;
});
