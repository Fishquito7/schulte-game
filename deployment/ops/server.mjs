#!/usr/bin/env node
/**
 * 个人网站静态服务器（HTTPS，仅监听 127.0.0.1，由 SakuraFrp HTTPS 隧道对外）
 *
 * 设计要点：
 *   - 零依赖，只用 Node 内置模块（NAS 上不装任何包）
 *   - TLS 在本地终止：SakuraFrp 的 HTTPS 隧道默认是 SNI 透传，证书必须装在这里
 *   - **支持 HAProxy PROXY protocol v1**：隧道开 proxy_protocol_version = v1 后，
 *     frpc 会在每个连接前面加一行 "PROXY TCP4 <真实IP> <本地IP> <端口> <端口>\r\n"，
 *     这里把它剥离并把真实 IP 挂在 socket 上；没有这一行时按普通 TLS 处理（本地自测可用）。
 *   - 只服务 ./public 下的文件，路径穿越一律 400
 *   - 未找到 → 返回 404.html（状态码仍是 404）
 *   - /api/* 反代到本机的排行榜后端（deployment/server/server.js）
 *   - 访问日志：stdout（site.log）+ access-ip.log（时间·IP·方法·路径·状态·耗时）
 */
import https from 'node:https'
import http from 'node:http'
import net from 'node:net'
import tls from 'node:tls'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, 'public')
const TLS_DIR = path.join(HERE, 'tls')
const ACCESS_LOG = process.env.SITE_ACCESS_LOG || path.join(HERE, 'access-ip.log')

const HOST = process.env.SITE_HOST || '127.0.0.1'
const PORT = Number(process.env.SITE_PORT || 8090)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json'
}

const log = (...a) => console.log(new Date().toISOString(), ...a)

/* ---------------------------------------------------------------- 访问日志 */

// 一行一条：时间 \t IP \t 方法 \t 路径 \t 状态码 \t 耗时
// 用 tab 分隔，方便 awk -F'\t' 取字段。appendFile 每次短开短关，logrotate 轮转后无需重启。
function appendAccess(line) {
  fs.appendFile(ACCESS_LOG, line + '\n', () => {})
}

// 127.0.0.1 / ::1 / ::ffff:1.2.3.4 归一化
function normIp(v) {
  let s = String(v || '').trim()
  if (!s) return '-'
  if (s.startsWith('::ffff:')) s = s.slice(7)
  if (s === '::1') s = '127.0.0.1'
  return s.replace(/^\[|\]$/g, '')
}

/* ------------------------------------------------------- 排行榜后端反代 */

// 它只讲明文 HTTP 且只监听回环，TLS 统一在本进程终止，/api/* 原样转发过去。
const API_UPSTREAM = new URL(process.env.SITE_API_UPSTREAM || 'http://127.0.0.1:8097')

const baseHeaders = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'SAMEORIGIN',
  'strict-transport-security': 'max-age=31536000'
}

function proxyApi(req, res, urlPath) {
  const started = Date.now()
  const clientIp = req.realIp || '127.0.0.1'

  const headers = {
    host: 'fishquito.site',
    accept: req.headers.accept || 'application/json',
    'accept-language': req.headers['accept-language'] || 'zh-CN',
    'x-forwarded-for': clientIp,
    'x-forwarded-proto': 'https'
  }
  if (req.headers['content-type']) headers['content-type'] = req.headers['content-type']
  if (req.headers['content-length']) headers['content-length'] = req.headers['content-length']

  const upstream = http.request(
    {
      host: API_UPSTREAM.hostname,
      port: Number(API_UPSTREAM.port || 80),
      method: req.method,
      path: req.url || urlPath,
      headers,
      timeout: 8000
    },
    (ur) => {
      const h = { ...baseHeaders, 'cache-control': 'no-store' }
      for (const [k, v] of Object.entries(ur.headers)) {
        if (k === 'connection' || k === 'transfer-encoding' || k === 'keep-alive') continue
        h[k] = v
      }
      res.writeHead(ur.statusCode || 502, h)
      ur.pipe(res)
    }
  )

  upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')))
  upstream.on('error', (err) => {
    log('api proxy error', urlPath, err.message, `${Date.now() - started}ms`)
    if (!res.headersSent) {
      const body = JSON.stringify({ error: 'backend unavailable' })
      send(res, 502, {
        ...baseHeaders,
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(Buffer.byteLength(body)),
        'cache-control': 'no-store'
      }, body)
    } else {
      res.destroy()
    }
  })

  req.pipe(upstream)
}

/* ---------------------------------------------------------------- 静态文件 */

function etagOf(st) {
  return `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`
}

async function resolveTarget(urlPath) {
  let rel
  try {
    rel = decodeURIComponent(urlPath)
  } catch {
    return null
  }
  if (rel.includes('\0')) return null
  const target = path.resolve(ROOT, '.' + path.posix.normalize('/' + rel))
  if (target !== ROOT && !target.startsWith(ROOT + path.sep)) return null
  let st
  try {
    st = await fsp.stat(target)
  } catch {
    return { target, st: null }
  }
  if (st.isDirectory()) {
    const idx = path.join(target, 'index.html')
    try {
      return { target: idx, st: await fsp.stat(idx) }
    } catch {
      return { target: idx, st: null }
    }
  }
  return { target, st }
}

function send(res, status, headers, body) {
  res.writeHead(status, headers)
  if (body === undefined) res.end()
  else res.end(body)
}

/* ------------------------------------------------------------------ 请求处理 */

async function handleRequest(req, res) {
  const started = Date.now()
  const urlPath = (req.url || '/').split('?')[0].split('#')[0]

  // PROXY protocol 解析出来的真实 IP 优先；否则退回 XFF / 对端地址
  const ip = normIp(
    req.socket.realIp ||
    String(req.headers['x-forwarded-for'] || '').split(',')[0] ||
    req.socket.remoteAddress
  )
  req.realIp = ip

  res.on('finish', () => {
    const ms = Date.now() - started
    log(res.statusCode, req.method, urlPath, `${ms}ms`)
    appendAccess(`${new Date().toISOString()}\t${ip}\t${req.method}\t${urlPath}\t${res.statusCode}\t${ms}ms`)
  })

  // /api/* → 排行榜后端。POST/PATCH 都要走这里，所以必须放在 405 检查之前
  if (urlPath === '/api' || urlPath.startsWith('/api/')) return proxyApi(req, res, urlPath)

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' }, 'Method Not Allowed\n')
  }

  const hit = await resolveTarget(urlPath)
  if (!hit) {
    return send(res, 400, { 'content-type': 'text/plain; charset=utf-8' }, 'Bad Request\n')
  }

  if (!hit.st) {
    // 404：仍然返回设计好的 404 页面
    try {
      const body = await fsp.readFile(path.join(ROOT, '404.html'))
      return send(res, 404, {
        ...baseHeaders,
        'content-type': 'text/html; charset=utf-8',
        'content-length': String(body.length),
        'cache-control': 'no-store'
      }, req.method === 'HEAD' ? undefined : body)
    } catch {
      return send(res, 404, { ...baseHeaders, 'content-type': 'text/plain; charset=utf-8' }, 'Not Found\n')
    }
  }

  const ext = path.extname(hit.target).toLowerCase()
  const etag = etagOf(hit.st)
  const isHtml = ext === '.html'

  const headers = {
    ...baseHeaders,
    'content-type': MIME[ext] || 'application/octet-stream',
    'content-length': String(hit.st.size),
    etag,
    'last-modified': hit.st.mtime.toUTCString(),
    'cache-control': isHtml ? 'no-cache' : 'public, max-age=3600'
  }

  if (req.headers['if-none-match'] === etag) {
    delete headers['content-length']
    return send(res, 304, headers)
  }

  if (req.method === 'HEAD') return send(res, 200, headers)

  const stream = fs.createReadStream(hit.target)
  stream.on('error', (err) => {
    log('stream error', err.message)
    res.destroy()
  })
  res.writeHead(200, headers)
  stream.pipe(res)
}

/* ------------------------------------------------------- TLS + PROXY protocol */

const TLS_OPTS = {
  cert: fs.readFileSync(path.join(TLS_DIR, 'cert.pem')),
  key: fs.readFileSync(path.join(TLS_DIR, 'key.pem')),
  minVersion: 'TLSv1.2'
}

const secureContext = tls.createSecureContext(TLS_OPTS)
const httpsServer = https.createServer(TLS_OPTS, handleRequest)

httpsServer.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
})
httpsServer.on('tlsClientError', (err) => {
  log('tls error', err.code || err.message)
})

const PROXY_MAX = 110 // v1 报文最长 107 字节

/**
 * 连上来的可能是：
 *   1. frpc 加了 PROXY 头 → "PROXY TCP4 <src> <dst> <sport> <dport>\r\n" + TLS ClientHello
 *   2. 直接 TLS（本地 curl / 健康检查）→ 首字节 0x16
 *   3. PROXY UNKNOWN\r\n + TLS
 * 首字节不是 'P'(0x50) 就当作纯 TLS；是 'P' 就按行读，不是合法 PROXY 行则把字节还回去。
 */
const listener = net.createServer({ pauseOnConnect: true }, (socket) => {
  socket.setNoDelay(true)

  let head = Buffer.alloc(0)

  const handoff = (realIp) => {
    socket.removeListener('readable', onReadable)
    const secure = new tls.TLSSocket(socket, {
      isServer: true,
      secureContext,
      requestCert: false,
      rejectUnauthorized: false
    })
    if (realIp) secure.realIp = realIp
    httpsServer.emit('secureConnection', secure)
  }

  const onReadable = () => {
    // 注意：必须一次性把缓冲区里的字节读完 —— 'readable' 不保证为剩余字节再触发一次
    let b
    while ((b = socket.read(1)) !== null) {
      head = Buffer.concat([head, b])

      // 首字节不是 'P'：不是 PROXY 头，原样交回给 TLS
      if (head.length === 1) {
        if (head[0] !== 0x50) {
          socket.unshift(head)
          return handoff(null)
        }
        continue
      }

      // 收满一行
      if (head[head.length - 1] === 0x0a) {
        const line = head.toString('latin1')
        const m = /^PROXY (?:TCP4|TCP6) (\S+) \S+ \d+ \d+\r?\n$/i.exec(line)
        if (m && net.isIP(m[1])) return handoff(m[1])
        if (/^PROXY UNKNOWN/i.test(line)) return handoff(null)
        socket.unshift(head) // 不是合法 PROXY 行，原样交回
        return handoff(null)
      }

      // 超过最大长度还没换行 → 放弃解析
      if (head.length > PROXY_MAX) {
        socket.unshift(head)
        return handoff(null)
      }
    }
  }

  socket.on('readable', onReadable)
  socket.on('error', () => {})
})

listener.listen(PORT, HOST, () => {
  log(`site listening on https://${HOST}:${PORT} (root: ${ROOT}, proxy-protocol: auto)`)
  log(`access log -> ${ACCESS_LOG}`)
})

/* ---- 纯 HTTP 入口：只做 http -> https 跳转 -------------------------------- */
const HTTP_PORT = Number(process.env.SITE_HTTP_PORT || 8091)
const ALLOWED_HOSTS = new Set(['fishquito.site', 'www.fishquito.site', '127.0.0.1', 'localhost'])

const redirectServer = http.createServer((req, res) => {
  const host = String(req.headers.host || '').split(':')[0].toLowerCase()
  const safeHost = ALLOWED_HOSTS.has(host) ? host : 'fishquito.site'
  const location = `https://${safeHost}${req.url || '/'}`
  log(308, req.method, req.url || '/', '->', location)
  res.writeHead(308, {
    location,
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  })
  res.end(`Redirecting to ${location}\n`)
})

redirectServer.listen(HTTP_PORT, HOST, () => {
  log(`http redirect listening on http://${HOST}:${HTTP_PORT} -> https://fishquito.site`)
})

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    log('shutting down')
    listener.close(() => process.exit(0))
    redirectServer.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 3000).unref()
  })
}
