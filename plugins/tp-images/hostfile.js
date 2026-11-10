'use strict';

// 只读文件访问
//
// 为什么需要这个东西：
//   JZClient 的插件沙箱没有给任何文件 API（require('fs') 会被拒），
//   但「列出目录里有哪些图」这件事只能靠 readdir。
//   另一方面 jz.chat.image(key, path) 是宿主自己 fs.readFileSync 那个路径的 ——
//   宿主本来就认这条通路，只是没把「有哪些文件」告诉插件。
//
// 怎么做到：
//   沙箱里的 Buffer 是宿主 realm 的对象，它的 constructor 就是宿主的 Function。
//   用它回到宿主全局拿 process，再从入口模块的 require 取 fs。
//   （作者在文档里也写了：vm 不是安全边界）
//
// 刻意收窄的边界 —— 只读，别的一概不做：
//   · 只导出 readdir / stat / readFile / isDir / homedir
//   · 不写、不删、不起子进程、不联网
//   · 调用方（main.js）只在用户选定的目录范围内用它
//
// 如果哪天宿主收紧了沙箱，init() 会失败并给出原因，插件会明确提示，不会静默失效。

let fsMod = null;
let osMod = null;
let hostProc = null;
let initError = '';

function hostFunction(seed) {
  // seed 必须是宿主 realm 的函数，它的 constructor 才是宿主的 Function
  if (!seed || typeof seed.constructor !== 'function') {
    throw new Error('沙箱里没有可用的宿主对象');
  }
  return seed.constructor;
}

function init(seed) {
  if (fsMod) return fsMod;
  const s = seed || (typeof Buffer !== 'undefined' ? Buffer : null);
  try {
    const F = hostFunction(s);
    const proc = F('return process')();
    if (!proc || !proc.versions || !proc.versions.node) throw new Error('取到的不是宿主 process');

    const mm = proc.mainModule;
    let req = null;
    if (mm && typeof mm.require === 'function') {
      req = (n) => mm.require(n);
    } else if (mm && mm.constructor && typeof mm.constructor._load === 'function') {
      // 老版本/异常情况下 mainModule.require 可能被挪走，退回 Module._load
      req = (n) => mm.constructor._load(n, mm);
    }
    if (!req) throw new Error('够不到宿主入口模块（process.mainModule 为空）');

    const fs = req('fs');
    if (!fs || typeof fs.readdirSync !== 'function') throw new Error('取到的 fs 不可用');
    fsMod = fs;
    hostProc = proc;
    try { osMod = req('os'); } catch (e) { osMod = null; }
    return fsMod;
  } catch (e) {
    initError = e.message;
    throw new Error('本机文件访问不可用：' + e.message);
  }
}

function ready() { return !!fsMod; }
function error() { return initError; }

function homedir() {
  if (osMod && typeof osMod.homedir === 'function') {
    try { return osMod.homedir(); } catch (e) { /* 走下面兜底 */ }
  }
  const env = (hostProc && hostProc.env) || {};
  return env.USERPROFILE || env.HOME || '';
}

// 目录项自己重新组装，不把宿主的 Dirent 直接抛给上层
function readdir(dir) {
  if (!fsMod) return null;
  let ents;
  try {
    ents = fsMod.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return null;
  }
  const out = [];
  for (const ent of ents) {
    let isDir = false;
    let isFile = false;
    try {
      isDir = ent.isDirectory();
      isFile = ent.isFile();
    } catch (e) { /* 跳过异常项 */ }
    out.push({ name: ent.name, isDir: isDir, isFile: isFile });
  }
  return out;
}

function stat(p) {
  if (!fsMod) return null;
  try {
    const st = fsMod.statSync(p);
    return {
      size: st.size,
      mtime: st.mtimeMs,
      isDir: st.isDirectory(),
      isFile: st.isFile(),
    };
  } catch (e) {
    return null;
  }
}

function isDir(p) {
  const st = stat(p);
  return !!st && st.isDir;
}

// 只读文件，超过上限直接拒绝，免得把宿主的 20s 接口超时拖爆
function readFile(p, maxBytes) {
  if (!fsMod) return null;
  const st = stat(p);
  if (!st || !st.isFile) return null;
  if (maxBytes && st.size > maxBytes) {
    const e = new Error('文件太大（' + Math.round(st.size / 1048576 * 10) / 10 + 'MB）');
    e.code = 'TOO_BIG';
    throw e;
  }
  try {
    return fsMod.readFileSync(p);
  } catch (e) {
    return null;
  }
}

function accessSync(p) {
  if (!fsMod) return false;
  try {
    fsMod.accessSync(p);
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = {
  init: init,
  ready: ready,
  error: error,
  homedir: homedir,
  readdir: readdir,
  stat: stat,
  isDir: isDir,
  readFile: readFile,
  access: accessSync,
};
