const { chromium } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const ROOT = path.resolve(__dirname, '..');
const configPath = path.join(ROOT, 'config.json');
const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
const expand = value => String(value).replace(/%USERPROFILE%/gi, os.homedir());
const BASE = String(config.canvasUrl || 'https://canvas.polyu.edu.hk').replace(/\/$/, '');
const DOWNLOAD_ROOT = path.resolve(expand(config.downloadDirectory || path.join(os.homedir(), 'Desktop', 'PolyU Canvas Courses')));
const STATE_ROOT = path.join(process.env.LOCALAPPDATA || os.homedir(), 'CanvasCourseDownloader');
const LEGACY_PROFILE = path.join(DOWNLOAD_ROOT, '.browser-profile');
const PROFILE = fs.existsSync(LEGACY_PROFILE) ? LEGACY_PROFILE : path.join(STATE_ROOT, 'browser-profile');
const MANIFEST_FILE = path.join(DOWNLOAD_ROOT, '.canvas-sync-manifest.json');
const LOG_FILE = path.join(DOWNLOAD_ROOT, 'sync.log');

fs.mkdirSync(DOWNLOAD_ROOT, { recursive: true });
fs.mkdirSync(STATE_ROOT, { recursive: true });

const chromeCandidates = process.platform === 'win32' ? [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
] : process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'] : ['/usr/bin/google-chrome', '/usr/bin/chromium'];
const CHROME = chromeCandidates.find(fs.existsSync);

function safeName(value) {
  const clean = String(value || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().replace(/[. ]+$/g, '');
  return clean || '_unnamed_';
}
function log(message) {
  const line = `${new Date().toLocaleString('zh-CN', { hour12: false })}  ${message}`;
  console.log(line); fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
}
function shortError(error) {
  return String(error?.message || error || 'Unknown error').split(/\r?\n/, 1)[0].replace(/cookie:\s*.*/i, 'cookie: [redacted]');
}
function enter(message) {
  return new Promise(resolve => { const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); rl.question(message, () => { rl.close(); resolve(); }); });
}
function nextLink(header) {
  for (const part of String(header || '').split(',')) { const m = part.match(/<([^>]+)>;\s*rel="next"/); if (m) return m[1]; }
  return null;
}
async function getWithRetry(request, url, attempts = 3) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await request.get(url);
      if (response.status() < 500) return response;
      last = new Error(`HTTP ${response.status()} ${response.statusText()}`);
    } catch (error) { last = error; }
    if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, 750 * attempt));
  }
  throw last;
}
async function pages(request, url) {
  const result = [];
  while (url) {
    const r = await getWithRetry(request, url);
    if (!r.ok()) throw new Error(`HTTP ${r.status()} ${r.statusText()}: ${url}`);
    result.push(...await r.json()); url = nextLink(r.headers().link);
  }
  return result;
}
function urlsFromHtml(html) {
  const result = [];
  const re = /(?:href|data-api-endpoint)=["']([^"']+)["']/gi;
  let m; while ((m = re.exec(String(html || '')))) result.push(m[1].replace(/&amp;/g, '&'));
  return result;
}
function fileId(url) {
  const m = String(url || '').match(/(?:\/api\/v1)?\/files\/(\d+)|\/courses\/\d+\/files\/(\d+)/);
  return m ? (m[1] || m[2]) : null;
}
function filenameFromHeaders(headers, fallback) {
  const cd = headers['content-disposition'] || '';
  const utf = cd.match(/filename\*=UTF-8''([^;]+)/i);
  const plain = cd.match(/filename="?([^";]+)"?/i);
  try { return safeName(decodeURIComponent(utf ? utf[1] : plain ? plain[1] : fallback)); } catch { return safeName(fallback); }
}

async function main() {
  if (!CHROME) throw new Error('Google Chrome not found. Install Chrome first.');
  const context = await chromium.launchPersistentContext(PROFILE, { executablePath: CHROME, headless: false, viewport: null, args: ['--start-maximized'] });
  try {
    const page = context.pages()[0] || await context.newPage();
    await page.goto(`${BASE}/courses`, { waitUntil: 'domcontentloaded' });
    let auth = await getWithRetry(context.request, `${BASE}/api/v1/users/self`);
    if (!auth.ok()) {
      console.log('请在打开的 Chrome 中登录 Canvas。');
      await enter('登录后回到此窗口按 Enter：');
      auth = await getWithRetry(context.request, `${BASE}/api/v1/users/self`);
      if (!auth.ok()) throw new Error('未检测到有效登录。');
    }

    let manifest = {};
    try { manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8')); } catch {}
    const courses = (await pages(context.request, `${BASE}/api/v1/courses?per_page=100`)).filter(c => c.name && !c.access_restricted_by_date);
    let downloaded = 0, skipped = 0, failed = 0;
    log(`同步开始，共 ${courses.length} 门可访问课程`);

    for (const course of courses) {
      const courseDir = path.join(DOWNLOAD_ROOT, safeName(course.name));
      fs.mkdirSync(courseDir, { recursive: true });
      log(`课程：${course.name}`);
      const found = new Map();
      const add = (url, label, section = 'Course files') => {
        if (!url) return;
        try { url = new URL(url, BASE).href; } catch { return; }
        const id = fileId(url); if (!id || !url.startsWith(BASE)) return;
        found.set(id, { id, url, label: label || `file-${id}`, section });
      };
      const scanObject = (obj, section) => {
        if (!obj) return;
        if (Array.isArray(obj)) return obj.forEach(v => scanObject(v, section));
        if (typeof obj === 'string') return urlsFromHtml(obj).forEach(u => add(u, null, section));
        if (typeof obj !== 'object') return;
        if (obj.url) add(obj.url, obj.display_name || obj.filename || obj.title, section);
        if (obj.html_url) add(obj.html_url, obj.display_name || obj.filename || obj.title, section);
        Object.values(obj).forEach(v => scanObject(v, section));
      };
      const tryEndpoint = async (url, section, detailPages) => {
        try {
          const items = await pages(context.request, url);
          scanObject(items, section);
          if (detailPages) for (const item of items) {
            try { const r = await getWithRetry(context.request, detailPages(item)); if (r.ok()) scanObject(await r.json(), section); } catch {}
          }
        } catch (e) { log(`  路径受限，已降级：${section} (${shortError(e)})`); }
      };

      await tryEndpoint(`${BASE}/api/v1/courses/${course.id}/modules?include[]=items&per_page=100`, 'Modules');
      await tryEndpoint(`${BASE}/api/v1/courses/${course.id}/assignments?per_page=100`, 'Assignments');
      await tryEndpoint(`${BASE}/api/v1/courses/${course.id}/pages?per_page=100`, 'Pages', p => `${BASE}/api/v1/courses/${course.id}/pages/${encodeURIComponent(p.url)}`);
      await tryEndpoint(`${BASE}/api/v1/courses/${course.id}/discussion_topics?per_page=100`, 'Announcements and discussions');

      for (const route of ['modules', 'assignments', 'pages', 'announcements']) {
        try {
          await page.goto(`${BASE}/courses/${course.id}/${route}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await page.waitForTimeout(1200);
          const links = await page.locator('a[href*="/files/"]').evaluateAll(as => as.map(a => ({ url: a.href, text: a.textContent.trim() })));
          links.forEach(x => add(x.url, x.text, `Visible ${route}`));
        } catch {}
      }

      for (const item of found.values()) {
        try {
          let meta = null;
          const mr = await getWithRetry(context.request, `${BASE}/api/v1/files/${item.id}`);
          if (mr.ok()) meta = await mr.json();
          const downloadUrl = meta?.url || `${BASE}/files/${item.id}/download?download_frd=1`;
          const response = await getWithRetry(context.request, downloadUrl);
          if (!response.ok()) throw new Error(`HTTP ${response.status()} ${response.statusText()}`);
          const headers = response.headers();
          const name = filenameFromHeaders(headers, meta?.display_name || item.label || `file-${item.id}`);
          const targetDir = path.join(courseDir, safeName(item.section));
          fs.mkdirSync(targetDir, { recursive: true });
          const target = path.join(targetDir, name);
          const stamp = `${headers.etag || ''}|${headers['last-modified'] || ''}|${headers['content-length'] || ''}`;
          const key = `${course.id}:${item.id}`;
          if (fs.existsSync(target) && stamp !== '||' && manifest[key] === stamp) { skipped++; continue; }
          fs.writeFileSync(target, await response.body()); manifest[key] = stamp; downloaded++;
          log(`  已下载：${name}`);
        } catch (e) { failed++; log(`  文件失败 ${item.id}：${shortError(e)}`); }
      }
    }
    fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2), 'utf8');
    log(`同步完成：下载/更新 ${downloaded}，跳过 ${skipped}，失败 ${failed}`);
  } finally { await context.close(); }
}

main().catch(error => { log(`同步中止：${shortError(error)}`); process.exitCode = 1; });
