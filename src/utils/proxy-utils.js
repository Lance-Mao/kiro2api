/**
 * 代理工具模块
 * 支持 HTTP、HTTPS 和 SOCKS5 代理，支持链式代理（出站代理）
 */

import { HttpsProxyAgent } from 'https-proxy-agent';
import logger from './logger.js';
import { HttpProxyAgent } from 'http-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import net from 'net';
import http from 'http';
import https from 'https';
import tls from 'tls';

/**
 * 将各种格式的代理字符串标准化为 protocol://username:password@host:port 格式
 */
function normalizeProxyUrl(raw, defaultProtocol = 'http') {
    if (!raw || typeof raw !== 'string') return raw;
    const trimmed = raw.trim();
    if (!trimmed) return trimmed;

    if (/^(socks[45]?|https?):\/\//i.test(trimmed)) {
        return trimmed;
    }

    if (trimmed.includes('@')) {
        const atIndex = trimmed.indexOf('@');
        const left = trimmed.substring(0, atIndex);
        const right = trimmed.substring(atIndex + 1);
        const leftParts = left.split(':');
        const rightParts = right.split(':');

        if (rightParts.length >= 2 && /^\d+$/.test(rightParts[rightParts.length - 1])) {
            const port = rightParts.pop();
            const host = rightParts.join(':');
            return `${defaultProtocol}://${left}@${host}:${port}`;
        } else if (leftParts.length >= 2 && /^\d+$/.test(leftParts[leftParts.length - 1])) {
            const port = leftParts.pop();
            const host = leftParts.join(':');
            return `${defaultProtocol}://${right}@${host}:${port}`;
        }
        return `${defaultProtocol}://${trimmed}`;
    }

    const parts = trimmed.split(':');
    if (parts.length === 4 && /^\d+$/.test(parts[1])) {
        return `${defaultProtocol}://${parts[2]}:${parts[3]}@${parts[0]}:${parts[1]}`;
    }
    if (parts.length === 2 && /^\d+$/.test(parts[1])) {
        return `${defaultProtocol}://${parts[0]}:${parts[1]}`;
    }
    return trimmed;
}

/**
 * 解析代理 URL 为组件
 */
export function parseProxyParts(proxyUrl) {
    const url = new URL(proxyUrl.includes('://') ? proxyUrl : `http://${proxyUrl}`);
    return {
        host: url.hostname,
        port: parseInt(url.port) || 3128,
        username: url.username ? decodeURIComponent(url.username) : '',
        password: url.password ? decodeURIComponent(url.password) : '',
        protocol: url.protocol.replace(':', '')
    };
}

// ==================== 链式代理隧道建立 ====================

/**
 * 通过本地 SOCKS5 代理建立到目标的 TCP 隧道
 */
function tunnelViaSocks5(localHost, localPort, targetHost, targetPort, timeout) {
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
                    reject(new Error('本地 SOCKS5 握手失败'));
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
                if (buf[3] === 0x01) addrLen = 10;
                else if (buf[3] === 0x03) { if (buf.length < 5) return; addrLen = 7 + buf[4]; }
                else if (buf[3] === 0x04) addrLen = 22;
                else addrLen = buf.length;
                if (buf.length < addrLen) return;
                socket.removeAllListeners('data');
                socket.removeAllListeners('error');
                socket.removeAllListeners('timeout');
                resolve(socket);
            }
        });

        socket.on('error', reject);
        socket.on('timeout', () => { socket.destroy(); reject(new Error('本地代理连接超时')); });
    });
}

/**
 * 通过本地 HTTP 代理建立到目标的 TCP 隧道
 */
function tunnelViaHttp(localHost, localPort, targetHost, targetPort, timeout) {
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

        socket.on('error', reject);
        socket.on('timeout', () => { socket.destroy(); reject(new Error('本地代理连接超时')); });
    });
}

/**
 * 通过本地代理建立到目标的 TCP 隧道（自动识别协议）
 */
export function tunnelViaLocalProxy(outboundUrl, targetHost, targetPort, timeout = 15000) {
    const local = parseProxyParts(outboundUrl);
    if (['socks5', 'socks', 'socks4'].includes(local.protocol)) {
        return tunnelViaSocks5(local.host, local.port, targetHost, targetPort, timeout);
    }
    return tunnelViaHttp(local.host, local.port, targetHost, targetPort, timeout);
}

// ==================== 链式代理 Agent ====================

/**
 * 在已有 socket 上完成 SOCKS5 握手 → 认证 → CONNECT
 */
function socks5ConnectOnSocket(socket, username, password, targetHost, targetPort) {
    return new Promise((resolve, reject) => {
        socket.setTimeout(15000);
        let step = 0;
        let buf = Buffer.alloc(0);
        let settled = false;

        function finish(err) {
            if (settled) return;
            settled = true;
            socket.removeListener('data', onData);
            socket.removeListener('error', onError);
            socket.removeListener('timeout', onTimeout);
            if (err) reject(err);
            else resolve(socket);
        }

        function sendConnect() {
            const hostBuf = Buffer.from(targetHost);
            const req = Buffer.alloc(7 + hostBuf.length);
            req[0] = 0x05; req[1] = 0x01; req[2] = 0x00; req[3] = 0x03;
            req[4] = hostBuf.length;
            hostBuf.copy(req, 5);
            req.writeUInt16BE(targetPort, 5 + hostBuf.length);
            socket.write(req);
            buf = Buffer.alloc(0);
            step = 2;
        }

        function onData(chunk) {
            buf = Buffer.concat([buf, chunk]);
            if (step === 0) {
                if (buf.length < 2) return;
                if (buf[0] !== 0x05) {
                    const text = buf.toString('utf8');
                    const msgMatch = text.match(/msg:\s*(.+)/i);
                    finish(new Error(msgMatch ? msgMatch[1].trim() : 'SOCKS5 握手失败'));
                    return;
                }
                if (buf[1] === 0x02) {
                    const userBuf = Buffer.from(username);
                    const passBuf = Buffer.from(password);
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
                    finish(new Error('SOCKS5 不支持的认证方式'));
                }
            } else if (step === 1) {
                if (buf.length < 2) return;
                if (buf[1] !== 0x00) { finish(new Error('SOCKS5 认证失败')); return; }
                sendConnect();
            } else if (step === 2) {
                if (buf.length < 4) return;
                if (buf[0] !== 0x05 || buf[1] !== 0x00) {
                    finish(new Error(`SOCKS5 CONNECT 失败 (code: ${buf[1]})`));
                    return;
                }
                let expectedLen;
                if (buf[3] === 0x01) expectedLen = 10;
                else if (buf[3] === 0x03) { if (buf.length < 5) return; expectedLen = 7 + buf[4]; }
                else if (buf[3] === 0x04) expectedLen = 22;
                else expectedLen = 10;
                if (buf.length < expectedLen) return;
                finish(null);
            }
        }

        function onError(err) { finish(err); }
        function onTimeout() { socket.destroy(); finish(new Error('连接超时')); }

        socket.on('data', onData);
        socket.on('error', onError);
        socket.on('timeout', onTimeout);

        socket.write(Buffer.from([0x05, 0x01, 0x02]));
    });
}

/**
 * 在已有 socket 上完成 HTTP CONNECT
 */
function httpConnectOnSocket(socket, username, password, targetHost, targetPort) {
    return new Promise((resolve, reject) => {
        socket.setTimeout(15000);
        let authHeader = '';
        if (username) {
            authHeader = `Proxy-Authorization: Basic ${Buffer.from(`${username}:${password}`).toString('base64')}\r\n`;
        }
        socket.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n${authHeader}\r\n`);

        let buf = '';
        function onData(chunk) {
            buf += chunk.toString();
            const headerEnd = buf.indexOf('\r\n\r\n');
            if (headerEnd === -1) return;
            const statusMatch = buf.match(/^HTTP\/\d\.\d (\d{3})/);
            const statusCode = statusMatch ? parseInt(statusMatch[1]) : 0;
            socket.removeListener('data', onData);
            socket.removeListener('error', onError);
            socket.removeListener('timeout', onTimeout);
            if (statusCode === 200) {
                resolve(socket);
            } else {
                const body = buf.substring(headerEnd + 4);
                const msgMatch = body.match(/msg:\s*(.+)/i);
                socket.destroy();
                reject(new Error(msgMatch ? msgMatch[1].trim() : `代理返回 ${statusCode}`));
            }
        }
        function onError(err) { reject(err); }
        function onTimeout() { socket.destroy(); reject(new Error('连接超时')); }

        socket.on('data', onData);
        socket.on('error', onError);
        socket.on('timeout', onTimeout);
    });
}

/**
 * 链式 SOCKS5 代理 Agent（HTTP 请求用）
 */
class ChainedSocksAgent extends http.Agent {
    constructor(targetProxyUrl, outboundProxyUrl) {
        super({ keepAlive: false });
        this.targetUrl = targetProxyUrl;
        this.outboundUrl = outboundProxyUrl;
        this.target = parseProxyParts(targetProxyUrl);
    }

    createConnection(options, callback) {
        const targetHost = options.hostname || options.host;
        const targetPort = parseInt(options.port) || 80;

        tunnelViaLocalProxy(this.outboundUrl, this.target.host, this.target.port)
            .then(socket => socks5ConnectOnSocket(socket, this.target.username, this.target.password, targetHost, targetPort))
            .then(socket => callback(null, socket))
            .catch(err => callback(err));
    }
}

/**
 * 链式 SOCKS5 代理 TLS Agent（HTTPS 请求用）
 */
class ChainedSocksTlsAgent extends https.Agent {
    constructor(targetProxyUrl, outboundProxyUrl) {
        super({ keepAlive: false });
        this.targetUrl = targetProxyUrl;
        this.outboundUrl = outboundProxyUrl;
        this.target = parseProxyParts(targetProxyUrl);
    }

    createConnection(options, callback) {
        const targetHost = options.hostname || options.host;
        const targetPort = parseInt(options.port) || 443;

        tunnelViaLocalProxy(this.outboundUrl, this.target.host, this.target.port)
            .then(socket => socks5ConnectOnSocket(socket, this.target.username, this.target.password, targetHost, targetPort))
            .then(socket => {
                const tlsSocket = tls.connect({
                    socket,
                    servername: options.servername || targetHost
                });
                tlsSocket.on('error', (err) => callback(err));
                tlsSocket.on('secureConnect', () => callback(null, tlsSocket));
            })
            .catch(err => callback(err));
    }
}

/**
 * 链式 HTTP 代理 Agent（HTTP 请求用）
 */
class ChainedHttpAgent extends http.Agent {
    constructor(targetProxyUrl, outboundProxyUrl) {
        super({ keepAlive: false });
        this.targetUrl = targetProxyUrl;
        this.outboundUrl = outboundProxyUrl;
        this.target = parseProxyParts(targetProxyUrl);
    }

    createConnection(options, callback) {
        const targetHost = options.hostname || options.host;
        const targetPort = parseInt(options.port) || 80;

        tunnelViaLocalProxy(this.outboundUrl, this.target.host, this.target.port)
            .then(socket => httpConnectOnSocket(socket, this.target.username, this.target.password, targetHost, targetPort))
            .then(socket => callback(null, socket))
            .catch(err => callback(err));
    }
}

/**
 * 链式 HTTP 代理 TLS Agent（HTTPS 请求用）
 */
class ChainedHttpTlsAgent extends https.Agent {
    constructor(targetProxyUrl, outboundProxyUrl) {
        super({ keepAlive: false });
        this.targetUrl = targetProxyUrl;
        this.outboundUrl = outboundProxyUrl;
        this.target = parseProxyParts(targetProxyUrl);
    }

    createConnection(options, callback) {
        const targetHost = options.hostname || options.host;
        const targetPort = parseInt(options.port) || 443;

        tunnelViaLocalProxy(this.outboundUrl, this.target.host, this.target.port)
            .then(socket => httpConnectOnSocket(socket, this.target.username, this.target.password, targetHost, targetPort))
            .then(socket => {
                const tlsSocket = tls.connect({
                    socket,
                    servername: options.servername || targetHost
                });
                tlsSocket.on('error', (err) => callback(err));
                tlsSocket.on('secureConnect', () => callback(null, tlsSocket));
            })
            .catch(err => callback(err));
    }
}

// ==================== 公共 API ====================

/**
 * 解析代理URL并返回相应的代理配置
 * @param {string} proxyUrl - 代理URL，支持多种格式
 * @param {string|null} outboundProxy - 出站代理URL（链式代理），可选
 * @returns {Object|null} 代理配置对象，包含 httpAgent 和 httpsAgent
 */
export function parseProxyUrl(proxyUrl, outboundProxy = null) {
    if (!proxyUrl || typeof proxyUrl !== 'string') {
        return null;
    }

    const normalizedUrl = normalizeProxyUrl(proxyUrl.trim());
    if (!normalizedUrl) {
        return null;
    }

    try {
        const url = new URL(normalizedUrl);
        const protocol = url.protocol.toLowerCase();

        // 有出站代理时使用链式 Agent
        if (outboundProxy) {
            if (protocol === 'socks5:' || protocol === 'socks4:' || protocol === 'socks:') {
                return {
                    httpAgent: new ChainedSocksAgent(normalizedUrl, outboundProxy),
                    httpsAgent: new ChainedSocksTlsAgent(normalizedUrl, outboundProxy),
                    proxyType: 'socks-chained'
                };
            } else if (protocol === 'http:' || protocol === 'https:') {
                return {
                    httpAgent: new ChainedHttpAgent(normalizedUrl, outboundProxy),
                    httpsAgent: new ChainedHttpTlsAgent(normalizedUrl, outboundProxy),
                    proxyType: 'http-chained'
                };
            }
        }

        // 无出站代理，使用原生 Agent
        if (protocol === 'socks5:' || protocol === 'socks4:' || protocol === 'socks:') {
            const socksAgent = new SocksProxyAgent(normalizedUrl);
            return {
                httpAgent: socksAgent,
                httpsAgent: socksAgent,
                proxyType: 'socks'
            };
        } else if (protocol === 'http:' || protocol === 'https:') {
            return {
                httpAgent: new HttpProxyAgent(normalizedUrl),
                httpsAgent: new HttpsProxyAgent(normalizedUrl),
                proxyType: 'http'
            };
        } else {
            logger.warn(`[Proxy] Unsupported proxy protocol: ${protocol}`);
            return null;
        }
    } catch (error) {
        logger.error(`[Proxy] Failed to parse proxy URL "${proxyUrl}": ${error.message}`);
        return null;
    }
}

/**
 * 检查指定的提供商是否启用了代理
 */
export function isProxyEnabledForProvider(config, providerType) {
    if (!config || !config.PROXY_URL || !config.PROXY_ENABLED_PROVIDERS) {
        return false;
    }
    const enabledProviders = config.PROXY_ENABLED_PROVIDERS;
    if (!Array.isArray(enabledProviders)) {
        return false;
    }
    return enabledProviders.includes(providerType);
}

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

/**
 * 获取指定提供商的代理配置（支持账号级代理 + 链式代理）
 */
export function getProxyConfigForProvider(config, providerType, accountConfig = null) {
    // 优先级 1：账号级代理配置
    if (accountConfig?.PROXY_URL) {
        // 如果账号的代理在代理池中，或者是自动分配的，使用出站代理做链式
        const outboundUrl = config.PROXY_POOL_OUTBOUND || null;
        let useOutbound = false;
        if (outboundUrl) {
            const pool = config.PROXY_POOL || [];
            useOutbound = accountConfig._proxyAutoAssigned || pool.includes(accountConfig.PROXY_URL);
        }
        const proxyConfig = parseProxyUrl(accountConfig.PROXY_URL, useOutbound ? outboundUrl : null);
        if (proxyConfig) {
            const suffix = useOutbound ? ` via ${maskProxyUrl(outboundUrl)}` : '';
            logger.info(`[Proxy] Using ${proxyConfig.proxyType} proxy for ${providerType} (${accountConfig.customName || accountConfig.uuid || 'unknown'}): ${maskProxyUrl(accountConfig.PROXY_URL)}${suffix}`);
            return proxyConfig;
        }
    }

    // 优先级 2：全局代理配置
    if (!isProxyEnabledForProvider(config, providerType)) {
        return null;
    }

    const proxyConfig = parseProxyUrl(config.PROXY_URL);
    if (proxyConfig) {
        logger.info(`[Proxy] Using global ${proxyConfig.proxyType} proxy for ${providerType}: ${maskProxyUrl(config.PROXY_URL)}`);
    }
    return proxyConfig;
}

/**
 * 为 axios 配置代理（支持账号级代理）
 */
export function configureAxiosProxy(axiosConfig, config, providerType, accountConfig = null) {
    const proxyConfig = getProxyConfigForProvider(config, providerType, accountConfig);

    if (proxyConfig) {
        axiosConfig.httpAgent = proxyConfig.httpAgent;
        axiosConfig.httpsAgent = proxyConfig.httpsAgent;
        axiosConfig.proxy = false;
    }

    return axiosConfig;
}

/**
 * 为 google-auth-library 配置代理
 */
export function getGoogleAuthProxyConfig(config, providerType) {
    const proxyConfig = getProxyConfigForProvider(config, providerType);

    if (proxyConfig) {
        return {
            agent: proxyConfig.httpsAgent
        };
    }

    return null;
}
