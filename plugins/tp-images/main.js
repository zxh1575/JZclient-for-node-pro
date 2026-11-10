'use strict';

// 图片速递 2.0 —— 自包含，不再依赖外部索引服务
//
// 1.x 版本靠 tools/img-index.js 在 127.0.0.1:8790 上列目录，因为插件沙箱没有 fs。
// 2.0 改为插件自己读盘（见 hostfile.js），于是整个插件就是这一个文件夹，导入即用。
//
// 指令：
//   /tp          第 1 页清单
//   /tp down     下一页
//   /tp up       上一页
//   /tp 20       发第 20 张（编号是全清单连续编号，不受当前页影响）
//   /tp dir      看当前目录 + 可切换的目录清单
//   /tp dir 2    切到清单里第 2 个目录
//   /tp ..       回到上一层目录

const path = require('path');
const hf = require('./hostfile');

const CMD = /^\/tp(?:\s+(.+))?$/i;
const MAX_SEND_BYTES = 15 * 1024 * 1024;
const MAX_IMG_BYTES = 15 * 1024 * 1024;
const SCAN_LIMIT = 3000;
const BROWSE_LIMIT = 200;

const EXT_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};
const EXT_OK = new Set(Object.keys(EXT_MIME));

// 上一次清单。编号必须和用户看到的保持一致，所以 /tp N 用这份缓存
let cache = { at: 0, files: [], dirs: [], depth: 0 };
// 上一次 /tp dir 给出的候选，编号对应这里的下标
let choices = { at: 0, list: [], parent: '', current: [] };
// 每个会话翻到第几页。key 是 msg.key，单聊/群各自独立
const pages = new Map();

function holdMs(jz) {
  const m = Number(jz.config.get('holdMinutes'));
  return (Number.isFinite(m) && m > 0 ? m : 10) * 60000;
}

function pageSize(jz) {
  const n = Number(jz.config.get('pageSize'));
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 60) : 15;
}

function depthCfg(jz) {
  const n = Number(jz.config.get('depth'));
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 3) : 0;
}

function resetCache() {
  cache = { at: 0, files: [], dirs: [], depth: 0 };
  pages.clear();
}

// ---------- 目录 ----------

// "C:" 这种光杆盘符 path.resolve 会当成当前工作目录，先补齐分隔符
function toAbs(p) {
  let s = String(p || '').trim();
  if (!s) return '';
  if (/^[A-Za-z]:$/.test(s)) s += path.sep;
  return path.resolve(s);
}

function desktopDirs() {
  const home = hf.homedir();
  if (!home) return [];
  const cands = [
    path.join(home, 'Desktop'),
    path.join(home, 'OneDrive', 'Desktop'),
    path.join(home, 'OneDrive', '桌面'),
    path.join(home, '桌面'),
  ];
  const out = [];
  for (const p of cands) {
    if (hf.isDir(p) && !out.some((x) => x.toLowerCase() === p.toLowerCase())) out.push(p);
  }
  return out;
}

function presets() {
  const home = hf.homedir();
  if (!home) return [];
  const raw = [
    ['桌面', path.join(home, 'Desktop')],
    ['桌面(OneDrive)', path.join(home, 'OneDrive', 'Desktop')],
    ['图片', path.join(home, 'Pictures')],
    ['图片(OneDrive)', path.join(home, 'OneDrive', 'Pictures')],
    ['下载', path.join(home, 'Downloads')],
    ['文档', path.join(home, 'Documents')],
    ['用户目录', home],
  ];
  const out = [];
  const seen = new Set();
  for (const [label, p] of raw) {
    if (!hf.isDir(p)) continue;
    const k = path.resolve(p).toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ label: label, path: p });
  }
  return out;
}

function drives() {
  const out = [];
  for (let c = 65; c <= 90; c += 1) {
    const root = String.fromCharCode(c) + ':\\';
    if (hf.access(root) && hf.isDir(root)) {
      out.push({ label: String.fromCharCode(c) + ':', path: root });
    }
  }
  return out;
}

// 用户选过的目录存在 jz.store 里；空数组 = 自动探测桌面
function chosenDirs(jz) {
  let v = jz.store.get('dirs', null);
  if (!Array.isArray(v)) {
    // 从 1.x 的 tp-index.json 迁移一次，老用户不用重新选
    v = legacyDirs();
    if (v.length) jz.store.set('dirs', v);
  }
  return (Array.isArray(v) ? v : [])
    .filter((p) => typeof p === 'string' && p)
    .map((p) => toAbs(p))
    .filter((p, i, arr) => hf.isDir(p) && arr.findIndex((x) => x.toLowerCase() === p.toLowerCase()) === i);
}

function legacyDirs() {
  try {
    const home = hf.homedir();
    if (!home) return [];
    const f = path.join(home, '.watch-parent-cli', 'tp-index.json');
    const st = hf.stat(f);
    if (!st || !st.isFile || st.size > 64 * 1024) return [];
    const buf = hf.readFile(f, 64 * 1024);
    const d = JSON.parse(buf.toString('utf8'));
    if (!d || !Array.isArray(d.dirs)) return [];
    return d.dirs.filter((p) => typeof p === 'string' && hf.isDir(p));
  } catch (e) {
    return [];
  }
}

function activeDirs(jz) {
  const chosen = chosenDirs(jz);
  return chosen.length ? chosen : desktopDirs();
}

function saveDirs(jz, list) {
  const next = [];
  for (const item of list) {
    const abs = toAbs(item);
    if (!abs) continue;
    if (!hf.isDir(abs)) throw new Error('不是有效目录：' + abs);
    if (!next.some((x) => x.toLowerCase() === abs.toLowerCase())) next.push(abs);
  }
  jz.store.set('dirs', next);
  resetCache();
  choices = { at: 0, list: [], parent: '', current: [] };
  return next;
}

// ---------- 扫描 ----------

function walk(dir, depth, maxDepth, out, seen) {
  if (out.length >= SCAN_LIMIT) return;
  const ents = hf.readdir(dir);
  if (!ents) return;
  for (const ent of ents) {
    if (out.length >= SCAN_LIMIT) return;
    const full = path.join(dir, ent.name);
    if (ent.isDir) {
      if (depth < maxDepth && ent.name.charAt(0) !== '.') walk(full, depth + 1, maxDepth, out, seen);
      continue;
    }
    if (!ent.isFile) continue;
    const ext = path.extname(ent.name).toLowerCase();
    if (!EXT_OK.has(ext)) continue;
    const st = hf.stat(full);
    if (!st || !st.size) continue;
    const key = full.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      name: ent.name,
      path: full,
      size: st.size,
      mtime: st.mtime,
      ext: ext,
      dir: dir,
    });
  }
}

function scan(jz) {
  const dirs = activeDirs(jz);
  const depth = depthCfg(jz);
  const out = [];
  const seen = new Set();
  for (const d of dirs) walk(d, 0, depth, out, seen);
  // 新的排前面：截图之后直接 /tp 1 就是刚截的那张
  out.sort((a, b) => b.mtime - a.mtime);
  out.forEach((f, i) => { f.i = i; });
  return { dirs: dirs, files: out, depth: depth };
}

function needFile() {
  if (!hf.ready()) {
    throw new Error('读不到本机文件（' + (hf.error() || '未知原因') + '）');
  }
}

function rescan(jz) {
  needFile();
  const r = scan(jz);
  cache = { at: Date.now(), files: r.files, dirs: r.dirs, depth: r.depth };
  return cache.files;
}

async function loadList(jz, force) {
  if (!force && cache.files.length && Date.now() - cache.at < holdMs(jz)) {
    return cache.files;
  }
  return rescan(jz);
}

// ---------- 渲染 ----------

function fmtSize(n) {
  const v = Number(n) || 0;
  if (v >= 1048576) return (v / 1048576).toFixed(1) + 'M';
  if (v >= 1024) return Math.round(v / 1024) + 'K';
  return v + 'B';
}

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

function clip(s, max) {
  const v = String(s || '');
  if (v.length <= max) return v;
  return v.slice(0, max - 1) + '…';
}

function dirLabel(dirs) {
  if (!dirs || !dirs.length) return '未设置目录';
  const last = String(dirs[0]).replace(/[\\/]+$/, '').split(/[\\/]/).pop();
  const more = dirs.length > 1 ? ' 等 ' + dirs.length + ' 个' : '';
  return last + more;
}

// 翻页游标，按会话隔离；太旧就当作第 1 页
function getPage(jz, key, total) {
  const size = pageSize(jz);
  const max = Math.max(0, Math.ceil(total / size) - 1);
  const st = pages.get(key);
  if (!st || Date.now() - st.at > holdMs(jz)) return 0;
  return Math.max(0, Math.min(st.page, max));
}

function setPage(key, page) {
  if (pages.size > 200) pages.clear();
  pages.set(key, { page: page, at: Date.now() });
}

// 一屏清单。编号是「全清单连续编号」，翻到第 3 页也能直接 /tp 25 发第 25 张
function render(files, dirs, page, size) {
  const total = files.length;
  const pages_ = Math.max(1, Math.ceil(total / size));
  const from = page * size;
  const shown = files.slice(from, from + size);
  const head = '[ ' + dirLabel(dirs) + ' ] ' + total + ' 张 · '
    + (page + 1) + '/' + pages_ + ' 页（新的在前）';
  const lines = [head];

  shown.forEach((f, idx) => {
    lines.push((from + idx + 1) + '. ' + clip(f.name, 20) + '  ' + fmtSize(f.size));
  });

  const nav = [];
  if (page + 1 < pages_) nav.push('/tp down 下一屏');
  if (page > 0) nav.push('/tp up 上一屏');
  lines.push(nav.length ? '▸ ' + nav.join(' · ') : '▸ 已经是最后一屏');
  lines.push('发 /tp 编号 直接发送 · /tp dir 换目录');
  return lines.join('\n');
}

// 换目录用的候选：快捷位置 + 盘符 + 当前目录的子目录
async function buildChoices(jz) {
  needFile();
  const cur = { dirs: activeDirs(jz), presets: presets(), roots: drives() };
  const list = [];
  const pushIt = (label, p, images) => {
    if (!p) return;
    if (list.some((x) => x.path.toLowerCase() === String(p).toLowerCase())) return;
    list.push({ label: label, path: p, images: images });
  };

  cur.presets.forEach((x) => pushIt(x.label, x.path, null));
  // 其它磁盘也放进来，不然从手表上到不了 D:/E:
  cur.roots.forEach((x) => pushIt(x.label + ' 盘', x.path, null));

  let parent = '';
  const first = cur.dirs[0];
  if (first) {
    const b = browse(first);
    parent = b.parent || '';
    (b.entries || []).forEach((x) => pushIt(x.name, x.path, x.images));
  }

  choices = { at: Date.now(), list: list, parent: parent, current: cur.dirs };
  return choices;
}

function renderChoices(c) {
  const lines = ['当前目录: ' + (c.current.length ? c.current.join(' , ') : '自动探测桌面')];
  lines.push('可切换到（/tp dir 编号）:');
  c.list.slice(0, 12).forEach((x, i) => {
    const cnt = typeof x.images === 'number' ? ' (' + x.images + ')' : '';
    lines.push((i + 1) + '. ' + clip(x.label, 18) + cnt);
  });
  if (c.list.length > 12) lines.push('（还有 ' + (c.list.length - 12) + ' 个，去网页面板里选）');
  if (c.parent) lines.push('发 /tp .. 回上一层');
  lines.push('也可在网页面板「图片速递」里点选任意目录');
  return lines.join('\n');
}

// 数一数这一层有多少张图，选目录时好判断
function countImages(dir) {
  const ents = hf.readdir(dir);
  if (!ents) return null;
  let n = 0;
  for (const ent of ents) {
    if (n > 999) break;
    if (!ent.isFile) continue;
    if (EXT_OK.has(path.extname(ent.name).toLowerCase())) n += 1;
  }
  return n;
}

function browse(rawPath) {
  const target = toAbs(rawPath);
  if (!target) {
    return { ok: true, path: '', parent: '', roots: drives(), presets: presets(), entries: [] };
  }
  if (!hf.isDir(target)) return { ok: false, error: '目录不存在: ' + target };
  const ents = hf.readdir(target);
  if (!ents) return { ok: false, error: '读不了这个目录（可能没有权限）' };
  const entries = [];
  for (const ent of ents) {
    if (entries.length >= BROWSE_LIMIT) break;
    if (!ent.isDir) continue;
    if (ent.name.charAt(0) === '.' || ent.name === 'node_modules') continue;
    const full = path.join(target, ent.name);
    entries.push({ name: ent.name, path: full, images: countImages(full) });
  }
  entries.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-CN'));
  const parent = path.dirname(target);
  return {
    ok: true,
    path: target,
    parent: parent && parent !== target ? parent : '',
    roots: drives(),
    presets: presets(),
    entries: entries,
  };
}

function insideActive(jz, p) {
  const abs = path.resolve(p);
  for (const d of activeDirs(jz)) {
    const base = path.resolve(d);
    if (abs === base) return true;
    if (abs.toLowerCase().startsWith((base + path.sep).toLowerCase())) return true;
  }
  return false;
}

// 换完目录后的提示：有图就带清单，没图就说清楚，别让手表那头以为卡住了
function afterSwitch(key, dirPath, files, dirs, jz) {
  const head = '已切到 ' + dirPath;
  if (!files.length) {
    return head + '\n这个目录里没有图片\n发 /tp .. 回上一层，或 /tp dir 换别的';
  }
  return head + '\n' + render(files, dirs, 0, pageSize(jz));
}

// 发图可能超过 6 秒（要传七牛），所以丢到定时器里，别让 onMessage 超时
function deliver(jz, key, file, idx) {
  jz.timers.after(0, () => {
    jz.chat.image(key, file.path)
      .then(() => jz.log.info('已发送 #' + idx + ' ' + file.name))
      .catch((e) => {
        jz.log.error('发送 #' + idx + ' 失败: ' + e.message);
        jz.chat.text(key, '第 ' + idx + ' 张发送失败：' + e.message).catch(() => {});
      });
  });
}

function apiBase(jz) {
  return '/api/plugin/' + encodeURIComponent(jz.id) + '/api';
}

module.exports = {
  async onLoad(jz) {
    try {
      hf.init();
      jz.log.info('图片速递已启动，本机文件访问就绪（目录：' + (activeDirs(jz)[0] || '未设置') + '）');
    } catch (e) {
      jz.log.error('图片速递启动失败：' + e.message);
    }
  },

  onUnload(jz) {
    resetCache();
    choices = { at: 0, list: [], parent: '', current: [] };
    jz.log.info('图片速递已停止');
  },

  onConfig(jz) {
    // 改了层级、每屏条数或有效期就把旧清单丢掉，避免拿错编号
    resetCache();
    choices = { at: 0, list: [], parent: '', current: [] };
  },

  async onMessage(jz, msg) {
    if (jz.config.get('enabled') === false) return;

    const text = String(msg.text || '').trim();
    const m = CMD.exec(text);
    if (!m) return;

    const key = msg.key;
    const arg = (m[1] || '').trim();

    try {
      // /tp —— 第 1 页
      if (!arg) {
        const files = await loadList(jz, true);
        if (!files.length) {
          await jz.chat.text(key, '当前目录没找到图片（只认 png/jpg/jpeg/gif/webp）\n发 /tp dir 换个目录');
          return;
        }
        setPage(key, 0);
        await jz.chat.text(key, render(files, cache.dirs, 0, pageSize(jz)));
        return;
      }

      // /tp down —— 下一屏
      if (/^(down|next|n)$/i.test(arg)) {
        const files = await loadList(jz, false);
        if (!files.length) {
          await jz.chat.text(key, '清单是空的，先发 /tp');
          return;
        }
        const size = pageSize(jz);
        const last = Math.max(0, Math.ceil(files.length / size) - 1);
        const cur = getPage(jz, key, files.length);
        if (cur >= last) {
          await jz.chat.text(key, '已经是最后一屏了（共 ' + (last + 1) + ' 屏，' + files.length + ' 张）');
          return;
        }
        setPage(key, cur + 1);
        await jz.chat.text(key, render(files, cache.dirs, cur + 1, size));
        return;
      }

      // /tp up —— 上一屏
      if (/^(up|prev|p)$/i.test(arg)) {
        const files = await loadList(jz, false);
        if (!files.length) {
          await jz.chat.text(key, '清单是空的，先发 /tp');
          return;
        }
        const size = pageSize(jz);
        const cur = getPage(jz, key, files.length);
        if (cur <= 0) {
          await jz.chat.text(key, '已经是第一屏了，发 /tp down 往后翻');
          return;
        }
        setPage(key, cur - 1);
        await jz.chat.text(key, render(files, cache.dirs, cur - 1, size));
        return;
      }

      // /tp dir —— 目录清单
      if (/^dir$/i.test(arg)) {
        const c = await buildChoices(jz);
        await jz.chat.text(key, renderChoices(c));
        return;
      }

      // /tp dir 2 —— 切目录
      const md = /^dir\s+(\d{1,3})$/i.exec(arg);
      if (md) {
        const n = Number(md[1]);
        if (!choices.list.length || Date.now() - choices.at > 5 * 60000) await buildChoices(jz);
        const target = choices.list[n - 1];
        if (!target) {
          await jz.chat.text(key, '没有第 ' + n + ' 个，先发 /tp dir 看清单');
          return;
        }
        const dirs = saveDirs(jz, [target.path]);
        const files = await loadList(jz, true);
        await jz.chat.text(key, afterSwitch(key, dirs[0] || target.path, files, dirs, jz));
        return;
      }

      // /tp .. —— 上一层目录
      if (arg === '..' || /^(back|out)$/i.test(arg)) {
        if (!choices.list.length || !choices.parent) await buildChoices(jz);
        if (!choices.parent) {
          await jz.chat.text(key, '已经是最上层了');
          return;
        }
        const parent = choices.parent;
        const dirs = saveDirs(jz, [parent]);
        const files = await loadList(jz, true);
        await jz.chat.text(key, afterSwitch(key, dirs[0] || parent, files, dirs, jz));
        return;
      }

      // /tp N —— 发第 N 张（全清单连续编号）
      const n = Number(arg);
      if (!Number.isInteger(n) || n <= 0) {
        await jz.chat.text(key, '用法：/tp 看清单 · /tp 编号 发送 · /tp down 翻页 · /tp dir 换目录');
        return;
      }

      const files = await loadList(jz, false);
      if (!files.length) {
        await jz.chat.text(key, '清单是空的，先发 /tp 刷新一次');
        return;
      }
      if (n > files.length) {
        await jz.chat.text(key, '只有 ' + files.length + ' 张，没有第 ' + n + ' 张');
        return;
      }

      const f = files[n - 1];
      if (Number(f.size) > MAX_SEND_BYTES) {
        await jz.chat.text(key, '第 ' + n + ' 张有 ' + fmtSize(f.size) + '，超过 15M 发不了');
        return;
      }

      deliver(jz, key, f, n);
    } catch (e) {
      jz.log.error('/tp 处理失败: ' + e.message);
      await jz.chat.text(key, '出错了：' + e.message).catch(() => {});
    }
  },

  async onRequest(jz, req) {
    // 图片清单（面板用）
    if (req.method === 'GET' && req.path === '/status') {
      const files = await loadList(jz, req.query.refresh === '1');
      const base = apiBase(jz);
      const chosen = chosenDirs(jz);
      const offset = Math.max(0, Number(req.query.offset) || 0);
      const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 80));
      return {
        ok: true,
        dirs: cache.dirs,
        chosen: chosen,
        auto: !chosen.length,
        depth: cache.depth,
        at: cache.at,
        total: files.length,
        offset: offset,
        files: files.slice(offset, offset + limit).map((f) => ({
          i: f.i,
          name: f.name,
          size: f.size,
          mtime: f.mtime,
          path: f.path,
          dir: f.dir,
          thumb: base + '/img?i=' + f.i,
        })),
      };
    }

    // 面板缩略图：按快照索引取，不接受任意路径
    if (req.method === 'GET' && req.path === '/img') {
      needFile();
      const i = Number(req.query.i);
      const f = Number.isInteger(i) ? cache.files[i] : null;
      if (!f) return { status: 404, type: 'application/json', body: { ok: false, error: '索引不存在，先刷新列表' } };
      if (!insideActive(jz, f.path)) {
        return { status: 403, type: 'application/json', body: { ok: false, error: '越界' } };
      }
      let buf;
      try {
        buf = hf.readFile(f.path, MAX_IMG_BYTES);
      } catch (e) {
        return { status: 413, type: 'application/json', body: { ok: false, error: e.message } };
      }
      if (!buf) return { status: 404, type: 'application/json', body: { ok: false, error: '文件读不到' } };
      return { status: 200, type: EXT_MIME[f.ext] || 'application/octet-stream', body: buf };
    }

    // 目录浏览：给面板用的选择器
    if (req.method === 'GET' && req.path === '/browse') {
      needFile();
      return browse(req.query.path);
    }

    if (req.method === 'GET' && req.path === '/dirs') {
      needFile();
      const chosen = chosenDirs(jz);
      return {
        ok: true,
        dirs: activeDirs(jz),
        chosen: chosen,
        auto: chosen.length === 0,
        presets: presets(),
        roots: drives(),
        depth: depthCfg(jz),
        ready: hf.ready(),
      };
    }

    // 保存目录选择
    if (req.method === 'POST' && req.path === '/dirs') {
      needFile();
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const dirs = Array.isArray(body.dirs) ? body.dirs : (body.dir ? [body.dir] : []);
      try {
        const saved = saveDirs(jz, dirs);
        return { ok: true, dirs: activeDirs(jz), chosen: saved, auto: saved.length === 0 };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }

    throw new Error('没有这个接口');
  },
};
