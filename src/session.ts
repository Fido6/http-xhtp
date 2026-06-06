/**
 * XHTTP HTTP Proxy - Cloudflare Worker
 * 
 * 基于 Cloudflare Sockets API 的 TCP 隧道代理
 * 优化 DO 时长使用：Alarm 机制 + 空闲超时 + 快速清理
 */

import { connect } from 'cloudflare:sockets';

export interface Env {
  AUTH_TOKEN: string;
  XPATH: string;
  SUB_PATH: string;
  NAME: string;
  PROXY_IP: string;
  FAKE_WEB: string;
  SESSION_DO: DurableObjectNamespace;
}

// 从 TLS ClientHello 提取 SNI
function extractSNI(data: Uint8Array): string | null {
  try {
    if (data.length < 5 || data[0] !== 0x16) return null;
    let offset = 5;
    if (offset + 4 > data.length || data[offset] !== 0x01) return null;
    offset += 4; // HandshakeType + Length
    if (offset + 34 > data.length) return null;
    offset += 34; // Version + Random
    if (offset >= data.length) return null;
    offset += 1 + data[offset]; // SessionID
    if (offset + 2 > data.length) return null;
    offset += 2 + ((data[offset] << 8) | data[offset + 1]); // CipherSuites
    if (offset >= data.length) return null;
    offset += 1 + data[offset]; // CompressionMethods
    if (offset + 2 > data.length) return null;
    const extLen = (data[offset] << 8) | data[offset + 1];
    offset += 2;
    const extEnd = offset + extLen;
    while (offset + 4 <= extEnd && offset + 4 <= data.length) {
      const type = (data[offset] << 8) | data[offset + 1];
      const len = (data[offset + 2] << 8) | data[offset + 3];
      offset += 4;
      if (type === 0x0000 && offset + 5 <= data.length) {
        const nameLen = (data[offset + 3] << 8) | data[offset + 4];
        if (data[offset + 2] === 0x00 && offset + 5 + nameLen <= data.length) {
          return new TextDecoder().decode(data.slice(offset + 5, offset + 5 + nameLen));
        }
      }
      offset += len;
    }
    return null;
  } catch { return null; }
}

// TCP socket → WritableStream 中继
async function pipeSocketToWriter(
  socket: { readable: ReadableStream<Uint8Array> },
  writer: WritableStreamDefaultWriter<Uint8Array>,
  onActivity?: () => void,
): Promise<void> {
  const reader = socket.readable.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      onActivity?.();
      await writer.write(value);
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

// ==================== Durable Object ====================

const IDLE_TIMEOUT = 60_000;      // 空闲超时 60s
const SESSION_TIMEOUT = 30_000;    // 未建立下游时的超时

export class SessionDO {
  private state: DurableObjectState;
  private env: Env;

  // 会话状态
  private nextSeq = 0;
  private initialized = false;
  private downstreamStarted = false;
  private cleaned = false;
  private pendingBuffers: Map<number, Uint8Array> = new Map();
  private lastActiveAt = Date.now();

  // 连接状态
  private connectTarget: string | null = null;
  private tcpSocket: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array>; close(): void } | null = null;
  private proxyIp: string | null = null;
  private usedProxy = false;

  // 下行流
  private downstream: WritableStream<Uint8Array> | null = null;
  private aborter: AbortController | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/session\/([^/]+)(?:\/([0-9]+))?$/);
    if (!m) return new Response('Not Found', { status: 404 });

    const seq = m[2] ? parseInt(m[2]) : null;

    // 从请求头获取 proxyIP
    const proxyIpHeader = request.headers.get('X-Proxy-Ip');
    if (proxyIpHeader) this.proxyIp = proxyIpHeader;

    // GET → 建立下行流
    if (request.method === 'GET' && seq === null) {
      return this.handleDownstream();
    }

    // POST → 上传数据包
    if (request.method === 'POST' && seq !== null) {
      const contentLength = request.headers.get('content-length');
      if (contentLength && parseInt(contentLength) > 1_000_000) {
        return new Response(null, { status: 413 });
      }

      const ab = await request.arrayBuffer();
      if (ab.byteLength > 1_000_000) {
        return new Response(null, { status: 413 });
      }

      const data = new Uint8Array(ab);
      try {
        await this.processPacket(seq, data);
        return new Response(null, { status: 200 });
      } catch (err) {
        console.error(`ERROR POST seq=${seq}:`, err);
        this.cleanup();
        return new Response(null, { status: 500 });
      }
    }

    return new Response('Not Found', { status: 404 });
  }

  // ---------- 下行流 ----------

  private handleDownstream(): Response {
    this.downstreamStarted = true;
    this.touch();

    const { readable, writable } = new TransformStream<Uint8Array>();
    this.downstream = writable;

    // 如果已经初始化，立即开始管道
    if (this.initialized && this.tcpSocket) {
      this.startDownstreamPiping();
    }

    return new Response(readable, {
      status: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
        'Content-Type': 'application/octet-stream',
        'Transfer-Encoding': 'chunked',
      },
    });
  }

  // ---------- 数据包处理 ----------

  private async processPacket(seq: number, data: Uint8Array): Promise<void> {
    if (this.cleaned) throw new Error('session closed');

    this.touch();
    this.pendingBuffers.set(seq, data);

    while (this.pendingBuffers.has(this.nextSeq)) {
      const next = this.pendingBuffers.get(this.nextSeq)!;
      this.pendingBuffers.delete(this.nextSeq);

      if (!this.initialized && this.nextSeq === 0) {
        await this.initialize(next);
      } else {
        if (!this.tcpSocket) {
          this.nextSeq++;
          continue;
        }
        // 写入 TCP socket
        const writer = this.tcpSocket.writable.getWriter();
        await writer.write(next);
        writer.releaseLock();
      }

      this.nextSeq++;
    }

    if (this.pendingBuffers.size > 30) {
      throw new Error('Too many buffered packets');
    }

    // 未建立下游时，设置 alarm 超时清理
    if (!this.downstreamStarted) {
      await this.state.storage.setAlarm(Date.now() + SESSION_TIMEOUT);
    }
  }

  // ---------- 初始化连接 ----------

  private async initialize(firstPacket: Uint8Array): Promise<void> {
    if (this.initialized) return;

    // 解析第一个包，判断是 CONNECT 还是 TLS 直连
    const text = new TextDecoder().decode(firstPacket.slice(0, Math.min(firstPacket.length, 100)));

    if (text.startsWith('CONNECT ')) {
      await this.initializeConnect(firstPacket);
    } else if (firstPacket[0] === 0x16) {
      await this.initializeTlsDirect(firstPacket);
    } else {
      throw new Error('Unknown protocol in first packet');
    }

    this.initialized = true;

    // 如果下游已建立，开始管道
    if (this.downstream) {
      this.startDownstreamPiping();
    }
  }

  private async initializeConnect(data: Uint8Array): Promise<void> {
    const text = new TextDecoder().decode(data);
    const firstLine = text.split('\r\n')[0];
    const parts = firstLine.split(' ');
    if (parts.length < 2) throw new Error('Invalid CONNECT');

    const target = parts[1];
    const [hostname, portStr] = target.split(':');
    const port = parseInt(portStr || '443', 10);

    console.log(`CONNECT to ${hostname}:${port}`);

    // 先直连
    let socket = await this.tryOpenSocket(hostname, port);

    // 直连失败且有 proxyIP，通过 proxyIP
    if (!socket && this.proxyIp) {
      console.log(`Direct failed, trying proxyIP ${this.proxyIp}`);
      socket = await this.tryOpenSocket(this.proxyIp, 443);
      this.usedProxy = true;
    }

    if (!socket) throw new Error('All connection attempts failed');

    this.tcpSocket = socket;
    this.connectTarget = hostname;

    // 发送 200 Connection Established
    if (this.downstream) {
      const writer = this.downstream.getWriter();
      await writer.write(new TextEncoder().encode('HTTP/1.1 200 Connection Established\r\n\r\n'));
      writer.releaseLock();
    }
  }

  private async initializeTlsDirect(data: Uint8Array): Promise<void> {
    const sni = extractSNI(data);
    if (!sni) throw new Error('Failed to extract SNI');

    console.log(`TLS direct to ${sni}:443`);

    const socket = await this.tryOpenSocket(sni, 443);
    if (!socket) throw new Error('Connection failed');

    this.tcpSocket = socket;
    this.connectTarget = sni;

    // 写入初始 TLS 数据
    const writer = socket.writable.getWriter();
    await writer.write(data);
    writer.releaseLock();
  }

  // ---------- Socket 工具 ----------

  private async tryOpenSocket(
    hostname: string,
    port: number,
  ): Promise<{ readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array>; close(): void } | null> {
    try {
      const socket = connect({ hostname, port });
      await socket.opened; // 等待连接完全建立
      console.log(`Connected to ${hostname}:${port}`);
      return socket;
    } catch (err) {
      console.error(`Connect to ${hostname}:${port} failed:`, err);
      return null;
    }
  }

  // ---------- 下行管道 ----------

  private startDownstreamPiping(): void {
    if (!this.downstream || !this.tcpSocket) return;
    if (this.aborter) return;

    this.aborter = new AbortController();
    const downstream = this.downstream;
    const socket = this.tcpSocket;

    (async () => {
      await pipeSocketToWriter(socket, downstream.getWriter(), () => this.touch());
    })()
      .catch(() => {})
      .finally(() => this.cleanup());
  }

  // ---------- Alarm & 清理 ----------

  async alarm(): Promise<void> {
    // 未建立下游，直接清理
    if (!this.downstreamStarted) {
      this.cleanup();
      return;
    }

    // 空闲超时，关闭会话
    const idleFor = Date.now() - this.lastActiveAt;
    if (idleFor >= IDLE_TIMEOUT) {
      console.log(`Idle timeout (${idleFor}ms), closing session`);
      this.cleanup();
      return;
    }

    // 仍在活跃，重新设置 alarm
    await this.state.storage.setAlarm(Date.now() + (IDLE_TIMEOUT - idleFor));
  }

  private touch(): void {
    this.lastActiveAt = Date.now();
    this.state.storage.setAlarm(this.lastActiveAt + IDLE_TIMEOUT).catch(() => {});
  }

  private cleanup(): void {
    if (this.cleaned) return;
    this.cleaned = true;
    console.log('DO cleanup');

    try { this.aborter?.abort(); } catch {}
    this.aborter = null;

    try { this.tcpSocket?.close(); } catch {}
    this.tcpSocket = null;
    this.downstream = null;
    this.connectTarget = null;
    this.pendingBuffers.clear();
  }
}
