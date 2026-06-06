/**
 * XHTTP HTTP Proxy - Cloudflare Worker
 * 
 * 路由入口：解析 XHTTP 路径，分发到 Durable Object
 */

import { Env, SessionDO } from './session';

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Cache-Control': 'no-store',
  'X-Accel-Buffering': 'no',
};

/**
 * 生成客户端配置说明
 */
function generateSubscription(env: Env, domain: string): string {
  const xpath = `/${env.XPATH}/${env.AUTH_TOKEN}`;
  return [
    `=== ${env.NAME} 客户端配置 ===`,
    ``,
    `类型protocol：HTTP`,
    `地址(address)：${domain}`,
    `端口(port)：443`,
    `传输协议(network)：xhttp`,
    `XHTTP模式：packet-up`,
    `xhttp host：${domain}`,
    `xhttp path：${xpath}`,
    `传输层安全(security)：tls`,
    `sni：${domain}`,
    `alpn：h3,h2,http/1.1`,
    `跳过证书验证：false`,
  ].join('\n');
}

/**
 * 解析 URL 路径
 * 格式: /{xpath}/{auth_token}/{session_id}/{seq}
 */
function parsePath(path: string, xpath: string): {
  isValid: boolean;
  authToken: string;
  sessionId: string;
  seq: number | null;
} {
  const prefix = `/${xpath}/`;
  if (!path.startsWith(prefix)) {
    return { isValid: false, authToken: '', sessionId: '', seq: null };
  }

  const remaining = path.substring(prefix.length);
  const segments = remaining.split('/').filter(s => s.length > 0);

  if (segments.length < 2) {
    return { isValid: false, authToken: '', sessionId: '', seq: null };
  }

  const authToken = segments[0];
  const sessionId = segments[1];
  const seqStr = segments.length >= 3 ? segments[2] : null;
  const seq = seqStr !== null ? parseInt(seqStr, 10) : null;

  return {
    isValid: true,
    authToken,
    sessionId,
    seq: seq !== null && !isNaN(seq) ? seq : null,
  };
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // 健康检查
    if (path === '/') {
      return new Response('Hello, World\n', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    // 客户端配置说明
    if (path === `/${env.SUB_PATH}`) {
      const domain = url.hostname;
      return new Response(generateSubscription(env, domain), {
        status: 200,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }

    // 解析 XHTTP 路径
    const parsed = parsePath(path, env.XPATH);
    if (!parsed.isValid) {
      return new Response('Not Found', { status: 404 });
    }

    // 验证鉴权
    if (parsed.authToken !== env.AUTH_TOKEN) {
      return new Response('Unauthorized', { status: 401 });
    }

    // 获取 Durable Object 实例
    const doId = env.SESSION_DO.idFromName(parsed.sessionId);
    const stub = env.SESSION_DO.get(doId);

    // 构建转发给 DO 的请求（使用 /session/ 前缀）
    const forwardUrl = new URL(request.url);
    if (parsed.seq === null) {
      forwardUrl.pathname = `/session/${parsed.sessionId}`;
    } else {
      forwardUrl.pathname = `/session/${parsed.sessionId}/${parsed.seq}`;
    }

    const forwarded = new Request(forwardUrl.toString(), {
      method: request.method,
      headers: {
        ...Object.fromEntries(request.headers.entries()),
        'X-Seq': parsed.seq !== null ? String(parsed.seq) : '',
        'X-Proxy-Ip': env.PROXY_IP || '',
      },
      body: request.body,
    });

    const resp = await stub.fetch(forwarded);

    // 添加 CORS 头
    const headers = new Headers(resp.headers);
    for (const [key, value] of Object.entries(corsHeaders)) {
      headers.set(key, value);
    }

    return new Response(resp.body, {
      status: resp.status,
      statusText: resp.statusText,
      headers,
    });
  },
};

export { SessionDO };
