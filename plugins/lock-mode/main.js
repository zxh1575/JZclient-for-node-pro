'use strict';

// 一键禁用：在聊天里用 /lock 查看并切换「上课禁用」「睡眠禁用」
//
// 读：getClassModes(watchId) / getTimeManageList(watchId, 1)
// 写：updateClassMode(mode) / updateTimeManage(record)
// 两者都走 jz.watches 的逃生舱，方法名在白名单里（update 开头 = 写）

const CLASS_FIELDS = ['classId', 'classWeek', 'createTime', 'holidaySwitch', 'id', 'timePeriod', 'title', 'type', 'watchId'];
const WEEK_NAMES = ['一', '二', '三', '四', '五', '六', '日'];
const SLEEP_TYPE = 1; // 时间管理里 type=1 就是睡眠模式，0 是定时开关机

let busy = false;

// ---------- 返回码 ----------
function unwrap(r) {
  if (!r || typeof r !== 'object') return {};
  if (r.json && typeof r.json === 'object') return r.json;
  return r;
}
function isOk(r) {
  return String(unwrap(r).code || '') === '000001';
}
function why(r) {
  const u = unwrap(r);
  if (u.desc) return u.desc + '（' + (u.code || '?') + '）';
  return '接口返回 ' + (u.code || '未知错误');
}

// ---------- 格式化 ----------
function hhmm(t) {
  const m = String(t || '').match(/^(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) + ':' + m[2] : String(t || '');
}

function weekText(mask) {
  const n = Number(mask);
  // 31（周一~五）是最常见的配置，省掉不显示，手表屏幕窄
  if (!Number.isFinite(n) || n <= 0 || n === 127 || n === 31) return '';
  const out = [];
  for (let i = 0; i < 7; i++) if (n & (1 << i)) out.push(WEEK_NAMES[i]);
  return out.length === 7 ? '' : '周' + out.join('');
}

// 上课禁用的时段是 JSON 字符串：[{"startTime":"08:00:00","endTime":"11:30:00"}]
// 手表一屏放不下太多，最多列 2 段
function classPeriodText(src) {
  let ps = [];
  try { ps = JSON.parse(src.timePeriod || '[]'); } catch (e) { ps = []; }
  const shown = ps.slice(0, 2).map((p) => hhmm(p.startTime) + '-' + hhmm(p.endTime));
  let body = shown.join('、');
  if (ps.length > 2) body += ' 等' + ps.length + '段';
  const w = weekText(src.classWeek);
  return [body, w].filter(Boolean).join(' ') || '未设置时段';
}

function sleepPeriodText(list) {
  const shown = list.slice(0, 2).map((x) => hhmm(x.startTime) + '-' + hhmm(x.endTime)).join('、');
  return list.length > 2 ? shown + ' 等' + list.length + '段' : (shown || '未设置时段');
}

// ---------- 读 ----------
async function readClass(jz, wid) {
  const r = await jz.watches.read('getClassModes', wid);
  const u = unwrap(r);
  // 000002 = 这块表没有上课禁用配置，不算错
  if (String(u.code) === '000002') return { ok: true, list: [] };
  if (!isOk(r)) return { ok: false, error: why(r), list: [] };
  return { ok: true, list: Array.isArray(u.data) ? u.data : [] };
}

async function readSleep(jz, wid) {
  const r = await jz.watches.read('getTimeManageList', wid, SLEEP_TYPE);
  const u = unwrap(r);
  if (!isOk(r)) return { ok: false, error: why(r), list: [] };
  return { ok: true, list: Array.isArray(u.data) ? u.data : [] };
}

// ---------- 摘要 ----------
function classState(list) {
  const total = list.length;
  const on = list.filter((x) => Number(x.classSwitch) === 1).length;
  return { total, on, all: total > 0 && on === total, any: on > 0 };
}

function sleepState(list) {
  const total = list.length;
  const on = list.filter((x) => Number(x.switchStatus) === 1).length;
  return { total, on, all: total > 0 && on === total, any: on > 0 };
}

// ---------- 写 ----------
async function writeClass(jz, wid, on) {
  const cur = await readClass(jz, wid);
  if (!cur.ok) return { ok: false, error: cur.error };
  if (!cur.list.length) return { ok: false, error: '这块表还没有上课禁用时段，先在 App 里加一个再来' };

  let done = 0;
  const fails = [];
  for (const src of cur.list) {
    // 只回传 NewClassMode 声明过的字段，多传会被服务端拒
    const mode = {};
    CLASS_FIELDS.forEach((k) => { if (src[k] !== undefined && src[k] !== null) mode[k] = src[k]; });
    mode.classSwitch = on ? 1 : 0;
    mode.tempSwitch = 0;
    const r = await jz.watches.write('updateClassMode', mode);
    if (isOk(r)) done++; else fails.push((src.title || '时段') + '：' + why(r));
  }

  if (!done) return { ok: false, error: fails[0] || '写入失败' };
  return { ok: true, done, total: cur.list.length, fails };
}

async function writeSleep(jz, wid, on) {
  const cur = await readSleep(jz, wid);
  if (!cur.ok) return { ok: false, error: cur.error };
  if (!cur.list.length) return { ok: false, error: '这块表还没有睡眠时段，先在 App 里加一个再来' };

  let done = 0;
  const fails = [];
  for (const src of cur.list) {
    const next = Object.assign({}, src, { switchStatus: on ? 1 : 0 });
    const r = await jz.watches.write('updateTimeManage', next);
    if (isOk(r)) done++; else fails.push((src.name || '时段') + '：' + why(r));
  }

  if (!done) return { ok: false, error: fails[0] || '写入失败' };
  return { ok: true, done, total: cur.list.length, fails };
}

// ---------- 手表 ----------
async function watchList(jz) {
  const list = await jz.watches.list();
  return Array.isArray(list) ? list : [];
}

function activeWatch(jz, list) {
  const want = String(jz.config.get('watchId') || '').trim();
  if (want) {
    const hit = list.find((w) => String(w.watchId) === want);
    if (hit) return hit;
  }
  const idx = Number(jz.store.get('activeIndex', -1));
  if (Number.isInteger(idx) && idx >= 0 && list[idx]) return list[idx];
  // 没手动选过：先挑在线的，再退回第一块
  const online = list.find((w) => w.online === true || w.watchOnline === true);
  return online || list[0] || null;
}

function watchName(w) {
  if (!w) return '未找到手表';
  const n = w.name || String(w.watchId || '').slice(0, 8);
  return w.model ? n + ' ' + w.model : n;
}

// ---------- 渲染 ----------
function renderStatus(w, cls, slp) {
  const name = watchName(w);
  const out = [name.length > 12 ? name.slice(0, 11) + '…' : name];

  if (!cls.ok) out.push('上课禁用 读取失败：' + cls.error);
  else if (!cls.list.length) out.push('上课禁用 未配置');
  else {
    const s = classState(cls.list);
    out.push('上课禁用 ' + (s.any ? (s.all ? '开' : s.on + '/' + s.total + ' 开') : '关'));
    out.push(' ' + classPeriodText(cls.list[0]));
  }

  if (!slp.ok) out.push('睡眠禁用 读取失败：' + slp.error);
  else if (!slp.list.length) out.push('睡眠禁用 未配置');
  else {
    const s = sleepState(slp.list);
    out.push('睡眠禁用 ' + s.on + '/' + s.total + ' 段开');
    out.push(' ' + sleepPeriodText(slp.list));
  }

  out.push('/lock c 上课 · /lock s 睡眠');
  out.push('/lock on|off · /lock w 换表');
  return out.join('\n');
}

function resultLine(label, res, verbOn) {
  if (res.fails && res.fails.length) {
    return label + ' 部分失败：' + res.fails[0];
  }
  return '✓ ' + label + ' 已' + (verbOn ? '开启' : '关闭') + (res.total > 1 ? '（' + res.total + ' 段）' : '');
}

// ---------- 指令 ----------
function parseOnOff(v) {
  if (v === 'on' || v === '1' || v === '开' || v === '开启') return true;
  if (v === 'off' || v === '0' || v === '关' || v === '关闭') return false;
  return null;
}

function isClassWord(v) {
  return v === 'c' || v === 'class' || v === '上课';
}
function isSleepWord(v) {
  return v === 's' || v === 'sleep' || v === '睡眠';
}
function isWatchWord(v) {
  return v === 'w' || v === 'watch' || v === '表' || v === '手表';
}

async function handle(jz, key, args) {
  if (busy) {
    await jz.chat.text(key, '上一个操作还在执行，等它跑完再发');
    return;
  }
  busy = true;
  try {
    await dispatch(jz, key, args);
  } finally {
    busy = false;
  }
}

async function dispatch(jz, key, args) {
  const a0 = (args[0] || '').toLowerCase();
  const a1 = (args[1] || '').toLowerCase();

  const list = await watchList(jz);
  if (!list.length) {
    await jz.chat.text(key, '没读到手表列表，先确认账号已登录、手表已绑定');
    return;
  }

  // /lock w [编号] —— 列出手表 / 切换
  if (isWatchWord(a0)) {
    if (a1 && /^\d+$/.test(a1)) {
      const idx = Number(a1) - 1;
      if (!list[idx]) {
        await jz.chat.text(key, '只有 ' + list.length + ' 块表，没有第 ' + a1 + ' 块');
        return;
      }
      jz.store.set('activeIndex', idx);
      await jz.chat.text(key, '已切到 ' + watchName(list[idx]));
      return;
    }
    const cur = activeWatch(jz, list);
    const lines = ['可切换（/lock w 编号）'];
    list.forEach((w, i) => {
      const mark = cur && String(w.watchId) === String(cur.watchId) ? ' ←当前' : '';
      lines.push((i + 1) + '. ' + watchName(w) + mark);
    });
    await jz.chat.text(key, lines.join('\n'));
    return;
  }

  const w = activeWatch(jz, list);
  if (!w) {
    await jz.chat.text(key, '没找到可操作的手表');
    return;
  }
  const wid = String(w.watchId);

  // /lock on|off —— 两个一起
  if (a0 === 'on' || a0 === 'off' || a0 === '开' || a0 === '关') {
    const on = parseOnOff(a0);
    const [rc, rs] = await Promise.all([writeClass(jz, wid, on), writeSleep(jz, wid, on)]);
    const lines = [watchName(w)];
    lines.push(rc.ok ? resultLine('上课禁用', rc, on) : '上课禁用 失败：' + rc.error);
    lines.push(rs.ok ? resultLine('睡眠禁用', rs, on) : '睡眠禁用 失败：' + rs.error);
    await jz.chat.text(key, lines.join('\n'));
    return;
  }

  // /lock c [on|off]
  if (isClassWord(a0)) {
    const cls = await readClass(jz, wid);
    if (!cls.ok) { await jz.chat.text(key, '读上课禁用失败：' + cls.error); return; }
    if (!cls.list.length) { await jz.chat.text(key, '这块表还没有上课禁用时段，先在 App 里加一个'); return; }
    const cur = classState(cls.list);
    const on = parseOnOff(a1) === null ? !cur.all : parseOnOff(a1);
    const res = await writeClass(jz, wid, on);
    if (!res.ok) { await jz.chat.text(key, '上课禁用 失败：' + res.error); return; }
    await jz.chat.text(key, resultLine('上课禁用', res, on) + '\n' + classPeriodText(cls.list[0]));
    return;
  }

  // /lock s [on|off]
  if (isSleepWord(a0)) {
    const slp = await readSleep(jz, wid);
    if (!slp.ok) { await jz.chat.text(key, '读睡眠时段失败：' + slp.error); return; }
    if (!slp.list.length) { await jz.chat.text(key, '这块表还没有睡眠时段，先在 App 里加一个'); return; }
    const cur = sleepState(slp.list);
    const on = parseOnOff(a1) === null ? !cur.all : parseOnOff(a1);
    const res = await writeSleep(jz, wid, on);
    if (!res.ok) { await jz.chat.text(key, '睡眠禁用 失败：' + res.error); return; }
    await jz.chat.text(key, resultLine('睡眠禁用', res, on) + '\n' + sleepPeriodText(slp.list));
    return;
  }

  // /lock 或无法识别的参数 —— 都回状态
  const [cls, slp] = await Promise.all([readClass(jz, wid), readSleep(jz, wid)]);
  await jz.chat.text(key, renderStatus(w, cls, slp));
}

// ---------- 钩子 ----------
module.exports = {
  async onLoad(jz) {
    jz.log.info('已就绪，聊天发 /lock 使用');
  },

  async onMessage(jz, msg) {
    const text = String(msg.text || '').trim();
    const m = text.match(/^\/lock(?:\s+([\s\S]+))?$/i);
    if (!m) return;

    const key = msg.key;
    const args = String(m[1] || '').trim().split(/\s+/).filter(Boolean);

    // 丢到后台：读+写要好几秒，超过 onMessage 的 6 秒上限会被宿主记成失败
    jz.timers.after(0, () => {
      handle(jz, key, args).catch((e) => {
        const m2 = (e && e.message) || '未知错误';
        jz.log.error('执行失败: ' + m2);
        jz.chat.text(key, '出错了：' + m2).catch(() => {});
      });
    });
  },

  // WebUI 面板用
  async onRequest(jz, req) {
    const list = await watchList(jz);
    const w = activeWatch(jz, list);
    if (!w) return { ok: false, error: '没有可用手表' };

    if (req.path === '/state') {
      const wid = String(w.watchId);
      const [cls, slp] = await Promise.all([readClass(jz, wid), readSleep(jz, wid)]);
      return {
        ok: true,
        watches: list.map((x) => ({ watchId: String(x.watchId), name: x.name || '', model: x.model || '' })),
        active: String(w.watchId),
        name: watchName(w),
        classMode: cls.ok
          ? Object.assign(classState(cls.list), { periods: cls.list.length ? classPeriodText(cls.list[0]) : '' })
          : { error: cls.error },
        sleepMode: slp.ok
          ? Object.assign(sleepState(slp.list), { periods: slp.list.length ? sleepPeriodText(slp.list) : '' })
          : { error: slp.error },
      };
    }

    if (req.method === 'POST' && req.path === '/toggle') {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const target = String(body.target || '');
      const on = body.on === true || body.on === 1 || body.on === '1';
      const wid = String(w.watchId);
      const res = target === 'sleep' ? await writeSleep(jz, wid, on) : await writeClass(jz, wid, on);
      return { ok: !!res.ok, error: res.error || '', done: res.done || 0, total: res.total || 0 };
    }

    if (req.method === 'POST' && req.path === '/watch') {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const wid = String(body.watchId || '');
      const idx = list.findIndex((x) => String(x.watchId) === wid);
      if (idx < 0) return { ok: false, error: '没有这块表' };
      jz.store.set('activeIndex', idx);
      return { ok: true, name: watchName(list[idx]) };
    }

    return { ok: false, error: '未知接口' };
  },
};
