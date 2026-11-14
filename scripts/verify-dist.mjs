#!/usr/bin/env node
/**
 * zashboard dist 最小验收（只用 Node 内置模块，无第三方依赖）。
 *
 * 用途：本 fork 带 sing-box Clash 兼容与 KSU 安全区补丁，每次重建后先跑一遍，
 * 确认「样式真的产出、代码分块齐全、补丁标记还在」再发布。
 *
 * 用法：
 *   node scripts/verify-dist.mjs [dist 目录]      # 默认 dist
 *   node scripts/verify-dist.mjs dist --reference <官方 dist 目录>
 *   node scripts/verify-dist.mjs dist --serve
 *
 * 校验项：
 *   1. index.html 存在，且其中所有本地资源引用都存在；
 *   2. 入口 CSS 尺寸正常（Tailwind + daisyUI 被打包，缺样式时只有 ~27 KB）；
 *   3. 入口 CSS 含预检、工具类、daisyUI 组件与主题变量标记，且没有残留 @import；
 *   4. 入口 JS 尺寸正常、动态分块齐全；
 *   5. JS 中含 sing-box 兼容补丁与安全区变量标记；
 *   6. index.html 引了 KSU 的 insets.css（安全区变量来源）；
 *   7. 给了 --reference 时：官方 CSS 里的类选择器必须全部存在于本产物（抓「样式被吞」）；
 *   8. 给了 --serve 时：起一个本地 HTTP 服务，把 index.html、本地资源与 CSS 里的 url()
 *      全部真实抓一遍，确认浏览器请求路径都能 200（模拟 WebView 的取文件方式）。
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const distDir = resolve(args.find((a) => !a.startsWith('--')) ?? 'dist')
const refIndex = args.indexOf('--reference')
const refDir = refIndex >= 0 ? resolve(args[refIndex + 1] ?? '') : null

const failures = []
const notes = []
const fail = (msg) => failures.push(msg)
const note = (msg) => notes.push(msg)
const kb = (n) => `${(n / 1024).toFixed(1)} KB`

// ---------------------------------------------------------------- 1. index.html
const indexPath = join(distDir, 'index.html')
if (!existsSync(indexPath)) {
  fail(`缺少 ${indexPath}`)
  report()
}
const html = readFileSync(indexPath, 'utf8')

const localRefs = [...html.matchAll(/(?:href|src)="([^"]+)"/g)]
  .map((m) => m[1])
  .filter((href) => !/^(?:[a-z]+:)?\/\//i.test(href) && !href.startsWith('data:'))

for (const href of localRefs) {
  const target = join(distDir, href.replace(/^\.\//, '').split('#')[0].split('?')[0])
  if (!existsSync(target)) fail(`index.html 引用的本地资源不存在：${href}`)
}
note(`index.html 本地资源引用 ${localRefs.length} 个，全部存在`)

const cssHref = localRefs.find((h) => h.endsWith('.css'))
const jsHref = localRefs.find((h) => h.endsWith('.js'))
if (!cssHref) fail('index.html 没有引用入口 CSS（构建产物缺失样式）')
if (!jsHref) fail('index.html 没有引用入口 JS')

// ---------------------------------------------------------------- 2. 入口 CSS
const MAIN_CSS_MIN_BYTES = 150 * 1024 // 官方 3.30.0 为 266 KB；缺 Tailwind 时会掉到 ~27 KB
let css = ''
if (cssHref) {
  const cssPath = join(distDir, cssHref.replace(/^\.\//, ''))
  if (existsSync(cssPath)) {
    css = readFileSync(cssPath, 'utf8')
    const size = statSync(cssPath).size
    note(`入口 CSS：${cssPath} ${kb(size)}`)
    if (size < MAIN_CSS_MIN_BYTES) {
      fail(
        `入口 CSS 只有 ${kb(size)}（阈值 ${kb(MAIN_CSS_MIN_BYTES)}），Tailwind/daisyUI 很可能没被打包`,
      )
    }
  }
}

// ---------------------------------------------------------------- 3. CSS 结构标记
const cssMarkers = [
  ['预检 box-sizing', 'box-sizing:border-box'],
  ['工具类 .flex', '.flex{'],
  ['工具类 .hidden', '.hidden{'],
  ['工具类 .grid', '.grid{'],
  ['工具类 .w-full', '.w-full{'],
  ['工具类 .items-center', '.items-center{'],
  ['工具类 .text-sm', '.text-sm{'],
  ['工具类 .absolute', '.absolute{'],
  ['工具类 .overflow-hidden', '.overflow-hidden{'],
  ['daisyUI .btn', '.btn{'],
  ['主题变量 --color-base-100', '--color-base-100'],
  ['主题选择器 [data-theme=', '[data-theme='],
  // 安全区真正落到样式上：Tailwind 任意值类里一旦带空格（如 pt-[var(--np-safe-top, 0px)]），
  // class 属性会被空格切断，规则根本不会生成，顶栏就又被状态栏压住。
  ['安全区顶栏 padding', 'padding-top:var(--np-safe-top'],
  ['安全区底部 padding', 'padding-bottom:var(--np-safe-bottom'],
  // 概览页的设置按钮是 absolute 定位在 CtrlsBar 里的，必须自己加安全区偏移，
  // 否则会钻到状态栏下面（KSU WebUI 是 edge-to-edge）。
  ['设置按钮安全区 top', 'calc(.5rem + var(--np-safe-top'],
  ['设置按钮安全区 right', 'calc(.5rem + var(--np-safe-right'],
]

for (const [label, marker] of cssMarkers) {
  if (!css.includes(marker)) fail(`CSS 缺少 ${label}（${marker}）`)
}
if (css.includes('@import')) {
  fail('CSS 里仍有未处理的 @import（Vite 应内联；常见原因是 @import 被规则挤到后面而失效）')
}
if (css) note(`CSS 结构标记 ${cssMarkers.length} 项`)

// ---------------------------------------------------------------- 4/5. 入口 JS
const MAIN_JS_MIN_BYTES = 1500 * 1024
let js = ''
if (jsHref) {
  const jsPath = join(distDir, jsHref.replace(/^\.\//, ''))
  if (existsSync(jsPath)) {
    js = readFileSync(jsPath, 'utf8')
    const size = statSync(jsPath).size
    note(`入口 JS：${jsPath} ${kb(size)}`)
    if (size < MAIN_JS_MIN_BYTES) fail(`入口 JS 只有 ${kb(size)}，明显小于预期`)
    // 动态分块必须齐全（否则页面按需加载的页面会 404）
    const chunks = [...js.matchAll(/(?:from|import\()\s*["'`]\.\/([^"'`]+\.js)["'`]/g)].map(
      (m) => m[1],
    )
    const assetsDir = join(distDir, 'assets')
    let missing = 0
    for (const chunk of new Set(chunks)) {
      if (!existsSync(join(assetsDir, chunk))) {
        missing++
        fail(`JS 动态分块缺失：assets/${chunk}`)
      }
    }
    note(`JS 动态分块 ${new Set(chunks).size} 个，缺失 ${missing} 个`)
  }
}

const jsMarkers = [
  ['sing-box 内核嗅探', /sing-\?box/],
  ['Core.Singbox', 'Singbox'],
  ['安全区变量', '--np-safe-top'],
  ['后端存储键', 'setup/api-list'],
]
for (const [label, marker] of jsMarkers) {
  const ok = marker instanceof RegExp ? marker.test(js) : js.includes(marker)
  if (!ok) fail(`JS 缺少补丁标记：${label}`)
}

// ---------------------------------------------------------------- 6. KSU 安全区
if (!html.includes('mui.kernelsu.org/internal/insets.css')) {
  fail('index.html 没有引用 https://mui.kernelsu.org/internal/insets.css（KSU 安全区变量来源）')
} else {
  note('index.html 已引用 KSU insets.css')
}

// ---------------------------------------------------------------- 7. 与官方产物对比
if (refDir) {
  const refCssFile = (() => {
    const refHtml = join(refDir, 'index.html')
    if (!existsSync(refHtml)) return null
    const href = [...readFileSync(refHtml, 'utf8').matchAll(/(?:href|src)="([^"]+\.css)"/g)]
      .map((m) => m[1])
      .find((h) => !/^(?:[a-z]+:)?\/\//i.test(h))
    return href ? join(refDir, href.replace(/^\.\//, '')) : null
  })()

  if (!refCssFile || !existsSync(refCssFile)) {
    fail(`--reference 指向的目录里找不到官方入口 CSS：${refDir}`)
  } else {
    const refCss = readFileSync(refCssFile, 'utf8')
    // 只比较「普通类名」：Tailwind 的任意值类（如 .pt-\[env(...)\]）内含转义字符，
    // 我们本来就把它从 env() 换成了 var()，所以两边都跳过，避免误报。
    const simple = (name) => /^[\w-]+$/.test(name) && !name.endsWith('-')
    const classSet = (text) =>
      new Set(
        [...text.matchAll(/\.((?:[\w-]|\\.)+)/g)]
          .map((m) => m[1].replace(/\\/g, ''))
          .filter(simple),
      )
    const ours = classSet(css)
    const refClasses = classSet(refCss)
    const missing = [...refClasses].filter((name) => !ours.has(name))
    const ratio = 1 - missing.length / refClasses.size
    note(
      `与官方 CSS 对比：官方类选择器 ${refClasses.size} 个，本产物覆盖 ${(ratio * 100).toFixed(2)}%（缺 ${missing.length} 个）`,
    )
    if (missing.length) {
      fail(
        `相对官方 CSS 缺少 ${missing.length} 个类选择器，示例：${missing.slice(0, 8).join(', ')}`,
      )
    }
    const refSize = statSync(refCssFile).size
    const ourSize = css ? Buffer.byteLength(css) : 0
    note(`CSS 尺寸对比：本产物 ${kb(ourSize)} / 官方 ${kb(refSize)}`)
    if (ourSize < refSize * 0.8) fail('入口 CSS 明显小于官方产物（阈值 80%）')
  }
}

// ---------------------------------------------------------------- 8. 本地 HTTP 抓取
const serveCheck = async (root, paths) => {
  const { createServer } = await import('node:http')
  const { readFile } = await import('node:fs/promises')
  const { extname } = await import('node:path')
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.webp': 'image/webp',
    '.jpg': 'image/jpeg',
    '.ttf': 'font/ttf',
    '.webmanifest': 'application/manifest+json',
  }

  const server = createServer(async (req, res) => {
    const rel =
      decodeURIComponent((req.url ?? '/').split('?')[0]).replace(/^\/+/, '') || 'index.html'
    try {
      const body = await readFile(join(root, rel))
      res.writeHead(200, { 'content-type': types[extname(rel)] ?? 'application/octet-stream' })
      res.end(body)
    } catch {
      res.writeHead(404).end('not found')
    }
  })

  await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
  const { port } = server.address()

  const unique = [
    ...new Set(paths.map((p) => '/' + p.replace(/^\.\//, '')).map((p) => p.split('#')[0])),
  ]
  const failures = []
  await Promise.all(
    unique.map(async (path) => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}${path}`)
        if (res.status !== 200) failures.push(`${path} -> HTTP ${res.status}`)
        else await res.arrayBuffer()
      } catch (error) {
        failures.push(`${path} -> ${error.message}`)
      }
    }),
  )
  await new Promise((ok) => server.close(ok))

  note(`本地 HTTP 抓取 ${unique.length} 个路径，失败 ${failures.length} 个`)
  for (const line of failures) fail(`本地 HTTP 抓取失败：${line}`)
}

if (args.includes('--serve')) {
  // CSS 里的 url() 相对 CSS 文件自身解析（通常在 assets/ 下），不能当成 dist 根路径。
  const { dirname } = await import('node:path')
  const cssDir = cssHref ? dirname(cssHref.replace(/^\.\//, '')) : ''
  const cssUrls = [...css.matchAll(/url\((\.\.?\/[^)]+)\)/g)]
    .map((m) => m[1].replace(/["']/g, ''))
    .map((ref) => (cssDir ? `${cssDir}/${ref.replace(/^\.\//, '')}` : ref))
  await serveCheck(distDir, ['index.html', ...localRefs, ...cssUrls])
}

// ---------------------------------------------------------------- 输出
function report() {
  console.log(`验收目标：${distDir}`)
  for (const line of notes) console.log(`  · ${line}`)
  if (failures.length) {
    console.log(`\n✗ 未通过（${failures.length} 项）：`)
    for (const line of failures) console.log(`  - ${line}`)
    process.exit(1)
  }
  console.log('\n✓ 通过：样式、分块与补丁标记齐全')
  process.exit(0)
}
report()
