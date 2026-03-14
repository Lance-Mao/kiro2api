/**
 * 代理管理 API
 * 提供代理池配置接口
 */

import logger from '../utils/logger.js';
import { getProviderPoolManager } from '../services/service-manager.js';
import { CONFIG } from '../core/config-manager.js';
import { parseProxyUrl } from '../utils/proxy-utils.js';
import fs from 'fs/promises';
import path from 'path';
import net from 'net';

/**
 * 解析请求体
 */
async function parseRequestBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch (error) {
                reject(error);
            }
        });
        req.on('error', reject);
    });
}

/**
 * 发送 JSON 响应
 */
function sendJSON(res, statusCode, data) {
    res.writeHead(statusCode, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    res.end(JSON.stringify(data));
}

/**
 * 获取代理池配置
 */
export async function handleGetProxyPool(req, res) {
    try {
        const poolManager = getProviderPoolManager();
        const stats = poolManager?.proxyPoolManager?.getPoolStats() || {
            totalProxies: 0,
            assignedAccounts: 0,
            distribution: {}
        };

        sendJSON(res, 200, {
            success: true,
            data: {
                proxyPool: CONFIG.PROXY_POOL || [],
                assignStrategy: CONFIG.PROXY_ASSIGN_STRATEGY || 'hash',
                autoAssign: CONFIG.PROXY_AUTO_ASSIGN !== false,
                outboundProxy: CONFIG.PROXY_POOL_OUTBOUND || '',
                stats
            }
        });
        return true;
    } catch (error) {
        logger.error('[Proxy API] Get proxy pool failed:', error);
        sendJSON(res, 500, { success: false, error: error.message });
        return true;
    }
}

/**
 * 更新代理池配置
 */
export async function handleUpdateProxyPool(req, res) {
    try {
        const body = await parseRequestBody(req);
        const { proxyPool, assignStrategy, autoAssign, outboundProxy } = body;

        if (proxyPool !== undefined) {
            CONFIG.PROXY_POOL = proxyPool;
        }
        if (assignStrategy !== undefined) {
            CONFIG.PROXY_ASSIGN_STRATEGY = assignStrategy;
        }
        if (autoAssign !== undefined) {
            CONFIG.PROXY_AUTO_ASSIGN = autoAssign;
        }
        if (outboundProxy !== undefined) {
            CONFIG.PROXY_POOL_OUTBOUND = outboundProxy || null;
        }

        // 保存到配置文件
        const configPath = path.join(process.cwd(), 'configs', 'config.json');
        let configData = {};
        try {
            configData = JSON.parse(await fs.readFile(configPath, 'utf8'));
        } catch (e) {
            const examplePath = path.join(process.cwd(), 'configs', 'config.json.example');
            try {
                configData = JSON.parse(await fs.readFile(examplePath, 'utf8'));
                logger.info('[Proxy API] config.json not found, created from example');
            } catch {
                configData = {};
            }
        }

        configData.PROXY_POOL = CONFIG.PROXY_POOL;
        configData.PROXY_ASSIGN_STRATEGY = CONFIG.PROXY_ASSIGN_STRATEGY;
        configData.PROXY_AUTO_ASSIGN = CONFIG.PROXY_AUTO_ASSIGN;
        configData.PROXY_POOL_OUTBOUND = CONFIG.PROXY_POOL_OUTBOUND;

        await fs.writeFile(configPath, JSON.stringify(configData, null, 2));

        // 重新初始化代理池管理器
        const poolManager = getProviderPoolManager();
        if (poolManager?.proxyPoolManager) {
            poolManager.proxyPoolManager.updateConfig(CONFIG);
        }

        logger.info('[Proxy API] Proxy pool config updated');
        sendJSON(res, 200, { success: true, message: '代理池配置已更新' });
        return true;
    } catch (error) {
        logger.error('[Proxy API] Update proxy pool failed:', error);
        sendJSON(res, 500, { success: false, error: error.message });
        return true;
    }
}

// ==================== 代理健康检测 ====================

/**
 * 解析代理 URL 为 host/port/username/password
 */
function parseProxyParts(proxyUrl) {
    const url = new URL(proxyUrl.includes('://') ? proxyUrl : `http://${proxyUrl}`);
    return {
        host: url.hostname,
        port: parseInt(url.port) || 3128,
        username: url.username ? decodeURIComponent(url.username) : '',
        password: url.password ? decodeURIComponent(url.password) : '',
        protocol: url.protocol.replace(':', '')
    };
}

/**
 * 通过本地 SOCKS5 代理建立到目标的 TCP 隧道
 */
function connectViaLocalSocks5(localHost, localPort, targetHost, targetPort, timeout) {
    return new Promise((resolve, reject) => {
        const socket = net.connect(localPort, localHost);
        socket.setTimeout(timeout);
        let step = 0;
        let buf = Buffer.alloc(0);

        socket.on('connect', () => {
            socket.write(Buffer.from([0x05, 0x01, 0x00]));
        });

        socket.on('data', (chunk) => {
            buf = Buffer.concat([buf, chunk]);
            if (step === 0) {
                if (buf.length < 2) return;
                if (buf[0] !== 0x05 || buf[1] !== 0x00) {
                    socket.destroy();
                    reject(new Error('本地代理 SOCKS5 握手失败'));
                    return;
                }
                const hostBuf = Buffer.from(targetHost);
                const req = Buffer.alloc(7 + hostBuf.length);
                req[0] = 0x05; req[1] = 0x01; req[2] = 0x00; req[3] = 0x03;
                req[4] = hostBuf.length;
                hostBuf.copy(req, 5);
                req.writeUInt16BE(targetPort, 5 + hostBuf.length);
                socket.write(req);
                buf = Buffer.alloc(0);
                step = 1;
            } else if (step === 1) {
                if (buf.length < 4) return;
                if (buf[0] !== 0x05 || buf[1] !== 0x00) {
                    socket.destroy();
                    reject(new Error('本地代理连接目标失败'));
                    return;
                }
                let addrLen;
                if (buf[3] === 0x01) addrLen = 4 + 4 + 2;
                else if (buf[3] === 0x03) { if (buf.length < 5) return; addrLen = 4 + 1 + buf[4] + 2; }
                else if (buf[3] === 0x04) addrLen = 4 + 16 + 2;
                else addrLen = buf.length;
                if (buf.length < addrLen) return;
                socket.removeAllListeners('data');
                socket.removeAllListeners('error');
                socket.removeAllListeners('timeout');
                resolve(socket);
            }
        });

        socket.on('error', (err) => reject(err));
        socket.on('timeout', () => { socket.destroy(); reject(new Error('本地代理连接超时')); });
    });
}

/**
 * 通过本地 HTTP 代理建立到目标的 TCP 隧道
 */
function connectViaLocalHttp(localHost, localPort, targetHost, targetPort, timeout) {
    return new Promise((resolve, reject) => {
        const socket = net.connect(localPort, localHost);
        socket.setTimeout(timeout);

        socket.on('connect', () => {
            socket.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n\r\n`);
        });

        let buf = '';
        socket.on('data', (chunk) => {
            buf += chunk.toString();
            const headerEnd = buf.indexOf('\r\n\r\n');
            if (headerEnd === -1) return;
            const statusMatch = buf.match(/^HTTP\/\d\.\d (\d{3})/);
            if (statusMatch && parseInt(statusMatch[1]) === 200) {
                socket.removeAllListeners('data');
                socket.removeAllListeners('error');
                socket.removeAllListeners('timeout');
                resolve(socket);
            } else {
                socket.destroy();
                reject(new Error('本地 HTTP 代理 CONNECT 失败'));
            }
        });

        socket.on('error', (err) => reject(err));
        socket.on('timeout', () => { socket.destroy(); reject(new Error('本地代理连接超时')); });
    });
}

/**
 * 通过本地代理建立到目标的 TCP 隧道（自动识别 SOCKS5/HTTP）
 */
function connectViaLocalProxy(localProxyUrl, targetHost, targetPort, timeout) {
    const local = parseProxyParts(localProxyUrl);
    if (['socks5', 'socks', 'socks4'].includes(local.protocol)) {
        return connectViaLocalSocks5(local.host, local.port, targetHost, targetPort, timeout);
    }
    return connectViaLocalHttp(local.host, local.port, targetHost, targetPort, timeout);
}

/**
 * 直连到目标 host:port
 */
function connectDirect(host, port, timeout) {
    return new Promise((resolve, reject) => {
        const socket = net.connect(port, host);
        socket.setTimeout(timeout);
        socket.on('connect', () => {
            socket.removeAllListeners('error');
            socket.removeAllListeners('timeout');
            resolve(socket);
        });
        socket.on('error', reject);
        socket.on('timeout', () => { socket.destroy(); reject(new Error('连接超时')); });
    });
}

/**
 * 检测 SOCKS 代理（支持通过本地代理中转）
 * SOCKS5 握手 → 认证 → CONNECT 成功即为健康
 */
function checkSocksProxy(proxyUrl, timeout, outboundProxy) {
    const start = Date.now();
    const target = parseProxyParts(proxyUrl);
    // 用 gstatic 204 端点做连通性测试
    const testHost = 'connectivitycheck.gstatic.com';
    const testPort = 80;

    const getSocket = outboundProxy
        ? connectViaLocalProxy(outboundProxy, target.host, target.port, timeout)
        : connectDirect(target.host, target.port, timeout);

    return getSocket.then((socket) => new Promise((resolve) => {
        socket.setTimeout(timeout);
        let step = 0;       // 0=握手 1=认证 2=CONNECT 3=HTTP
        let buf = Buffer.alloc(0);
        let settled = false;

        function done(result) {
            if (settled) return;
            settled = true;
            socket.removeAllListeners();
            socket.destroy();
            resolve(result);
        }

        function fail(error) {
            done({ proxy: proxyUrl, healthy: false, latency: Date.now() - start, error });
        }

        socket.on('data', (chunk) => {
            if (step === 3) {
                // HTTP 响应阶段 - 只要收到任何数据就算成功
                const text = chunk.toString();
                const latency = Date.now() - start;
                const statusMatch = text.match(/HTTP\/\d\.\d (\d{3})/);
                if (statusMatch) {
                    const code = parseInt(statusMatch[1]);
                    if (code === 204 || code === 200) {
                        done({ proxy: proxyUrl, healthy: true, latency, status: code });
                    } else {
                        fail(`目标返回 ${code}`);
                    }
                } else {
                    // 收到了非 HTTP 数据，但 CONNECT 已成功，仍算健康
                    done({ proxy: proxyUrl, healthy: true, latency, status: 0 });
                }
                return;
            }

            buf = Buffer.concat([buf, chunk]);

            if (step === 0) {
                if (buf.length < 2) return;
                if (buf[0] !== 0x05) {
                    const text = buf.toString('utf8');
                    const msgMatch = text.match(/msg:\s*(.+)/i);
                    fail(msgMatch ? msgMatch[1].trim() : text.trim().substring(0, 100) || 'SOCKS5 握手失败');
                    return;
                }
                if (buf[1] === 0x02) {
                    const userBuf = Buffer.from(target.username);
                    const passBuf = Buffer.from(target.password);
                    const authReq = Buffer.alloc(3 + userBuf.length + passBuf.length);
                    authReq[0] = 0x01;
                    authReq[1] = userBuf.length;
                    userBuf.copy(authReq, 2);
                    authReq[2 + userBuf.length] = passBuf.length;
                    passBuf.copy(authReq, 3 + userBuf.length);
                    socket.write(authReq);
                    buf = Buffer.alloc(0);
                    step = 1;
                } else if (buf[1] === 0x00) {
                    sendConnect();
                } else {
                    fail('SOCKS5 不支持的认证方式');
                }
            } else if (step === 1) {
                if (buf.length < 2) return;
                if (buf[1] !== 0x00) { fail('SOCKS5 认证失败'); return; }
                sendConnect();
            } else if (step === 2) {
                if (buf.length < 4) return;
                if (buf[0] !== 0x05 || buf[1] !== 0x00) {
                    fail(`SOCKS5 CONNECT 失败 (code: ${buf[1]})`);
                    return;
                }
                let expectedLen;
                if (buf[3] === 0x01) expectedLen = 10;
                else if (buf[3] === 0x03) { if (buf.length < 5) return; expectedLen = 7 + buf[4]; }
                else if (buf[3] === 0x04) expectedLen = 22;
                else expectedLen = 10;
                if (buf.length < expectedLen) return;
                // CONNECT 成功，发一个轻量 HTTP 请求验证端到端连通
                step = 3;
                buf = Buffer.alloc(0);
                socket.write(`GET /generate_204 HTTP/1.1\r\nHost: ${testHost}\r\nConnection: close\r\n\r\n`);
            }
        });

        function sendConnect() {
            const hostBuf = Buffer.from(testHost);
            const req = Buffer.alloc(7 + hostBuf.length);
            req[0] = 0x05; req[1] = 0x01; req[2] = 0x00; req[3] = 0x03;
            req[4] = hostBuf.length;
            hostBuf.copy(req, 5);
            req.writeUInt16BE(testPort, 5 + hostBuf.length);
            socket.write(req);
            buf = Buffer.alloc(0);
            step = 2;
        }

        socket.on('end', () => {
            if (step >= 3) {
                // CONNECT 已成功，即使没收到 HTTP 响应也算通
                done({ proxy: proxyUrl, healthy: true, latency: Date.now() - start, status: 0 });
            } else {
                fail(`连接在阶段 ${step} 关闭`);
            }
        });

        socket.on('error', (err) => fail(err.message));
        socket.on('timeout', () => fail('连接超时'));

        socket.write(Buffer.from([0x05, 0x01, 0x02]));
    })).catch((err) => ({
        proxy: proxyUrl, healthy: false, latency: Date.now() - start, error: err.message
    }));
}

/**
 * 检测 HTTP 代理（支持通过本地代理中转），能捕获代理返回的具体错误信息
 */
async function checkHttpProxy(proxyUrl, timeout, outboundProxy) {
    const start = Date.now();
    const target = parseProxyParts(proxyUrl);
    const testHost = 'www.gstatic.com';
    const testPort = 443;

    try {
        const socket = outboundProxy
            ? await connectViaLocalProxy(outboundProxy, target.host, target.port, timeout)
            : await connectDirect(target.host, target.port, timeout);

        let authHeader = '';
        if (target.username) {
            authHeader = `Proxy-Authorization: Basic ${Buffer.from(`${target.username}:${target.password}`).toString('base64')}\r\n`;
        }
        socket.write(`CONNECT ${testHost}:${testPort} HTTP/1.1\r\nHost: ${testHost}:${testPort}\r\n${authHeader}\r\n`);

        return await new Promise((resolve) => {
            socket.setTimeout(timeout);
            let buf = '';
            socket.on('data', (chunk) => {
                buf += chunk.toString();
                const headerEnd = buf.indexOf('\r\n\r\n');
                if (headerEnd === -1) return;
                const header = buf.substring(0, headerEnd);
                const body = buf.substring(headerEnd + 4);
                const statusMatch = header.match(/^HTTP\/\d\.\d (\d{3})/);
                const statusCode = statusMatch ? parseInt(statusMatch[1]) : 0;
                socket.destroy();
                const latency = Date.now() - start;
                if (statusCode === 200) {
                    resolve({ proxy: proxyUrl, healthy: true, latency, status: 200 });
                } else {
                    let errorMsg = `代理返回 ${statusCode}`;
                    const msgMatch = body.match(/msg:\s*(.+)/i);
                    if (msgMatch) errorMsg = msgMatch[1].trim();
                    else if (body.trim()) errorMsg = body.trim().substring(0, 100);
                    resolve({ proxy: proxyUrl, healthy: false, latency, error: errorMsg });
                }
            });
            socket.on('error', (err) => {
                resolve({ proxy: proxyUrl, healthy: false, latency: Date.now() - start, error: err.message });
            });
            socket.on('timeout', () => {
                socket.destroy();
                resolve({ proxy: proxyUrl, healthy: false, latency: timeout, error: '连接超时' });
            });
        });
    } catch (err) {
        return { proxy: proxyUrl, healthy: false, latency: Date.now() - start, error: err.message };
    }
}

/**
 * 检测单个代理的连通性
 * 支持通过本地代理（VPN）中转检测
 */
function checkSingleProxy(proxyUrl, timeout = 10000, outboundProxy = null) {
    const proxyConfig = parseProxyUrl(proxyUrl);
    if (!proxyConfig) {
        return Promise.resolve({ proxy: proxyUrl, healthy: false, latency: 0, error: '无法解析代理地址' });
    }

    if (proxyConfig.proxyType === 'socks') {
        return checkSocksProxy(proxyUrl, timeout, outboundProxy);
    }
    return checkHttpProxy(proxyUrl, timeout, outboundProxy);
}

/**
 * 批量检测代理健康状态
 */
export async function handleProxyHealthCheck(req, res) {
    try {
        const body = await parseRequestBody(req);
        const proxies = body.proxies || CONFIG.PROXY_POOL || [];
        const outboundProxy = body.outboundProxy || CONFIG.PROXY_POOL_OUTBOUND || null;

        if (proxies.length === 0) {
            sendJSON(res, 200, { success: true, data: [] });
            return true;
        }

        if (outboundProxy) {
            logger.info(`[Proxy API] Health checking ${proxies.length} proxies via outbound proxy ${outboundProxy}...`);
        } else {
            logger.info(`[Proxy API] Health checking ${proxies.length} proxies (direct)...`);
        }

        const results = await Promise.allSettled(proxies.map(p => checkSingleProxy(p, 15000, outboundProxy)));

        const data = results.map(r => r.status === 'fulfilled' ? r.value : {
            proxy: '', healthy: false, latency: 0, error: r.reason?.message || 'Unknown error'
        });

        const healthyCount = data.filter(d => d.healthy).length;
        logger.info(`[Proxy API] Health check done: ${healthyCount}/${proxies.length} healthy`);

        sendJSON(res, 200, { success: true, data });
        return true;
    } catch (error) {
        logger.error('[Proxy API] Proxy health check failed:', error);
        sendJSON(res, 500, { success: false, error: error.message });
        return true;
    }
}
