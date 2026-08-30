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
const DOWNLOAD_ROOT = path.resolve(expand(config.downloadDirectory || path.join(ROOT, 'courses')));
const STATE_ROOT = path.join(process.env.LOCALAPPDATA || os.homedir(), 'PolyUCanvasCourseFetch');
const PROFILE = path.join(STATE_ROOT, 'browser-profile');
const MANIFEST_FILE = path.join(STATE_ROOT, 'manifest.json');
const LOG_FILE = path.join(STATE_ROOT, 'fetch.log');

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
  const line = `${new Date().toLocaleString('en-CA', { hour12: false })}  ${message}`;
  fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
}
function progress(done, total) {
  const width = 30;
  const ratio = total ? done / total : 1;
  const filled = Math.round(width * ratio);
  const percent = Math.round(ratio * 100);
  process.stdout.write(`\r[${'#'.repeat(filled)}${'-'.repeat(width - filled)}] ${percent}% (${done}/${total})`);
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
async function getWithRetry(request, url, attempts = 2) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await request.get(url, { timeout: 10000 });
      if (response.status() < 500) return response;
      last = new Error(`HTTP ${response.status()} ${response.statusText()}`);
    } catch (error) { last = error; }
    if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, 750 * attempt));
  }
  throw last;
}
async function mapLimit(items, limit, worker) {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
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
      console.log('Please sign in to Canvas in the Chrome window.');
      await enter('When the course page is visible, return here and press Enter: ');
      auth = await getWithRetry(context.request, `${BASE}/api/v1/users/self`);
      if (!auth.ok()) throw new Error('No valid Canvas session was detected.');
    }

    let manifest = {};
    try { manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8')); } catch {}
    const courses = (await pages(context.request, `${BASE}/api/v1/courses?per_page=100`)).filter(c => c.name && !c.access_restricted_by_date);
    let downloaded = 0, skipped = 0, failed = 0;
    log(`Sync started: ${courses.length} accessible course(s)`);
    progress(0, courses.length);

    for (const [courseIndex, course] of courses.entries()) {
      const courseDir = path.join(DOWNLOAD_ROOT, safeName(course.name));
      fs.mkdirSync(courseDir, { recursive: true });
      log(`Course: ${course.name}`);
      const found = new Map();
      const fallbackRoutes = new Set();
      const add = (url, label, section = 'Course files') => {
        if (!url) return;
        try { url = new URL(url, BASE).href; } catch { return; }
        const id = fileId(url); if (!id || !url.startsWith(BASE)) return;
        if (!found.has(id)) found.set(id, { id, url, label: label || `file-${id}`, section });
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
      const tryEndpoint = async (url, section, route, detailPages) => {
        try {
          const items = await pages(context.request, url);
          scanObject(items, section);
          if (detailPages) await mapLimit(items, 4, async item => {
            try { const r = await getWithRetry(context.request, detailPages(item)); if (r.ok()) scanObject(await r.json(), section); } catch {}
          });
        } catch (e) {
          fallbackRoutes.add(route);
          log(`  Source unavailable; falling back: ${section} (${shortError(e)})`);
        }
      };

      const scanModules = async () => { try {
        const modules = await pages(context.request, `${BASE}/api/v1/courses/${course.id}/modules?include[]=items&per_page=100`);
        await mapLimit(modules, 4, async module => {
          let items = module.items;
          if (!Array.isArray(items)) items = await pages(context.request, module.items_url || `${BASE}/api/v1/courses/${course.id}/modules/${module.id}/items?per_page=100`);
          const moduleFolder = safeName(module.name || `Module ${module.id}`);
          for (const item of items) {
            if (item.type === 'File' && item.content_id) add(`${BASE}/api/v1/files/${item.content_id}`, item.title, moduleFolder);
            scanObject(item, moduleFolder);
          }
        });
      } catch (e) {
        fallbackRoutes.add('modules');
        log(`  Source unavailable; falling back: Modules (${shortError(e)})`);
      }};
      await Promise.all([
        scanModules(),
        tryEndpoint(`${BASE}/api/v1/courses/${course.id}/assignments?per_page=100`, 'Assignments', 'assignments'),
        tryEndpoint(`${BASE}/api/v1/courses/${course.id}/pages?per_page=100`, 'Pages', 'pages', p => `${BASE}/api/v1/courses/${course.id}/pages/${encodeURIComponent(p.url)}`),
        tryEndpoint(`${BASE}/api/v1/courses/${course.id}/discussion_topics?per_page=100`, 'Announcements and discussions', 'announcements')
      ]);

      for (const route of fallbackRoutes) {
        try {
          await page.goto(`${BASE}/courses/${course.id}/${route}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await page.waitForTimeout(1200);
          const links = await page.locator('a[href*="/files/"]').evaluateAll(as => as.map(a => ({ url: a.href, text: a.textContent.trim() })));
          links.forEach(x => add(x.url, x.text, `Visible ${route}`));
        } catch {}
      }

      log(`  ${found.size} unique file(s) discovered`);
      await mapLimit([...found.values()], 4, async item => {
        try {
          let meta = null;
          const mr = await getWithRetry(context.request, `${BASE}/api/v1/files/${item.id}`);
          if (mr.ok()) meta = await mr.json();
          const name = safeName(meta?.display_name || item.label || `file-${item.id}`);
          const targetDir = path.join(courseDir, safeName(item.section));
          fs.mkdirSync(targetDir, { recursive: true });
          const target = path.join(targetDir, name);
          const key = `${course.id}:${item.id}`;
          const metaStamp = meta ? `${meta.updated_at || ''}|${meta.size || ''}` : null;
          if (metaStamp && fs.existsSync(target) && manifest[key] === metaStamp) { skipped++; return; }
          if (metaStamp && manifest[key] && fs.existsSync(target) && fs.statSync(target).size === Number(meta.size)) {
            manifest[key] = metaStamp;
            fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2), 'utf8');
            skipped++;
            return;
          }
          const downloadUrl = meta?.url || `${BASE}/files/${item.id}/download?download_frd=1`;
          const response = await getWithRetry(context.request, downloadUrl);
          if (!response.ok()) throw new Error(`HTTP ${response.status()} ${response.statusText()}`);
          const headers = response.headers();
          const finalName = filenameFromHeaders(headers, name);
          const finalTarget = path.join(targetDir, finalName);
          const stamp = metaStamp || `${headers.etag || ''}|${headers['last-modified'] || ''}|${headers['content-length'] || ''}`;
          fs.writeFileSync(finalTarget, await response.body()); manifest[key] = stamp;
          fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2), 'utf8');
          downloaded++;
          log(`  Downloaded: ${finalName}`);
        } catch (e) { failed++; log(`  File failed ${item.id}: ${shortError(e)}`); }
      });
      progress(courseIndex + 1, courses.length);
    }
    fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2), 'utf8');
    log(`Sync complete: ${downloaded} downloaded/updated, ${skipped} skipped, ${failed} failed`);
    if (failed === 0) console.log(`\nSUCCESS`);
    else {
      console.log(`\nFAILED (${failed} file${failed === 1 ? '' : 's'})`);
      process.exitCode = 1;
    }
  } finally { await context.close(); }
}

main().catch(error => {
  log(`Sync aborted: ${shortError(error)}`);
  console.log('\nFAILED');
  process.exitCode = 1;
});
