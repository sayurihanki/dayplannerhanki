// Day Planner v2 — app entry. Pure scheduling logic + AI ordering (advisory) + local-first persistence.
import './style.css';
import ICAL from 'ical.js';
import { storage } from './storage.js';
import { aiMessage } from './api.js';

  /* Day Planner — notes-driven. Write your day in plain words. Lines with a clock time
     (e.g. "17:00-18:30 Run outside") are PINNED to that time; everything else becomes a
     flexible task placed into open gaps. Plain sentences are read as preferences. Claude
     interprets the notes; JavaScript places everything deterministically (no overlaps,
     nothing past the window, nothing dropped). If the AI is unavailable, a local interpreter runs. */
  const TAGS = [
    { id: '#deep',    short: 'deep',     name: 'DeepWork',                emoji: '\u{1F629}',         cls: 'tag-deepwork',      aliases: ['deepwork', 'deep-work', 'focus'] },
    { id: '#fitness', short: 'fitness',  name: 'Fitness + Health',        emoji: '\u{1F3CB}\u{FE0F}', cls: 'tag-fitness',       aliases: ['health', 'workout', 'gym', 'exercise', 'run', 'walk'] },
    { id: '#rest',    short: 'rest',     name: 'Routine Rest',            emoji: '\u{1F634}',         cls: 'tag-rest',          aliases: ['sleep', 'nap'] },
    { id: '#admin',   short: 'admin',    name: 'Admin',                   emoji: '\u{1F9FD}',         cls: 'tag-admin',         aliases: ['chore', 'chores', 'errand', 'errands', 'laundry', 'email'] },
    { id: '#travel',  short: 'travel',   name: 'Travel',                  emoji: '\u{1F697}',         cls: 'tag-travel',        aliases: ['drive', 'commute'] },
    { id: '#break',   short: 'break',    name: 'Break',                   emoji: '\u2615',            cls: 'tag-break',         aliases: ['coffee', 'snack'] },
    { id: '#ready',   short: 'ready',    name: 'Getting Ready',           emoji: '\u{1F485}',         cls: 'tag-ready',         aliases: ['getready', 'getting-ready', 'shower'] },
    { id: '#plan',    short: 'plan',     name: 'Planning + Writing',      emoji: '\u{1F4BC}',         cls: 'tag-planning',      aliases: ['planning', 'writing', 'write', 'research'] },
    { id: '#meeting', short: 'meeting',  name: 'Relationships + Meeting', emoji: '\u{1F497}',         cls: 'tag-relationships', aliases: ['relationship', 'relationships', 'meet', 'meeting', 'lunch', 'dinner', 'family'] },
  ];
  const TAG_BY_ID = Object.fromEntries(TAGS.map(t => [t.id, t]));
  const TAG_CLASS = Object.fromEntries(TAGS.map(t => [t.id, t.cls]));
  const TAG_ALIAS_MAP = (() => { const m = {}; TAGS.forEach(t => { m[t.short] = t.id; t.aliases.forEach(a => { m[a.toLowerCase()] = t.id; }); }); return m; })();
  function tagInfo(tagId) { if (!tagId) return null; const norm = String(tagId).toLowerCase(); if (TAG_BY_ID[norm]) return TAG_BY_ID[norm]; const stripped = norm.startsWith('#') ? norm.slice(1) : norm; if (TAG_ALIAS_MAP[stripped]) return TAG_BY_ID[TAG_ALIAS_MAP[stripped]]; return null; }
  function normalizeTag(tagId) { const info = tagInfo(tagId); return info ? info.id : (tagId ? String(tagId).toLowerCase() : null); }
  function normalizeTagSafe(t) { if (!t) return null; const n = normalizeTag(t); return tagInfo(n) ? n : null; }
  const MODEL = 'claude-sonnet-4-6';
  const PX_PER_MIN = 1.05;
  const STORAGE_KEYS = { settings: 'planner:settings', lastPlan: 'planner:lastPlan' };
  function pad2(n) { return String(n).padStart(2, '0'); }
  function parseHHMM(str) { if (typeof str !== 'string') return null; const m = str.trim().match(/^(\d{1,2}):(\d{2})$/); if (!m) return null; const h = +m[1], min = +m[2]; if (h < 0 || h > 23 || min < 0 || min > 59) return null; return h * 60 + min; }
  function fmtHHMM(mins) { return `${pad2(Math.floor(mins / 60))}:${pad2(mins % 60)}`; }
  function fmtDuration(mins) { if (mins < 60) return `${mins}m`; const h = Math.floor(mins / 60), m = mins % 60; return m === 0 ? `${h}h` : `${h}h ${m}m`; }
  function nowMinutes() { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); }
  function todayLocalISO() { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
  function formatDateHeading(iso) { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }); }
  function escapeHTML(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function uid(p) { return p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function parseDurationToken(tok) {
    if (!tok) return null;
    const s = String(tok).trim().toLowerCase().replace(/\s+/g, '');
    let m;
    if ((m = s.match(/^(\d+)h(?:r|ours?)?(\d+)m?(?:in)?$/))) return (+m[1]) * 60 + (+m[2]);
    if ((m = s.match(/^(\d+(?:\.\d+)?)h(?:r|ours?)?$/))) return Math.round(parseFloat(m[1]) * 60);
    if ((m = s.match(/^(\d+)m(?:in(?:ute)?s?)?$/))) return +m[1];
    if ((m = s.match(/^(\d+)$/))) { const n = +m[1]; if (n > 0 && n <= 600) return n; }
    return null;
  }
  function to24(h, min, mer) { h = +h; min = min ? +min : 0; if (mer) { mer = mer.replace(/\./g, '').toLowerCase(); if (mer === 'pm' && h < 12) h += 12; if (mer === 'am' && h === 12) h = 0; } return h * 60 + min; }
  function extractTimeRange(line) {
    const re = /(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?\s*(?:-|\u2013|\u2014|to|until)\s*(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/i;
    const m = line.match(re);
    if (!m) return null;
    let mer1 = m[3], mer2 = m[6];
    if (!mer1 && mer2) mer1 = mer2;
    if (!mer2 && mer1) mer2 = mer1;
    if (+m[1] > 23 || +m[4] > 23) return null;
    const sM = to24(m[1], m[2], mer1), eM = to24(m[4], m[5], mer2);
    if (isNaN(sM) || isNaN(eM) || eM <= sM || sM >= 1440 || eM > 1440) return null;
    const rest = (line.slice(0, m.index) + ' ' + line.slice(m.index + m[0].length)).trim();
    return { startMin: sM, endMin: eM, rest };
  }
  function findTimeRanges(line) {
    const re = /(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?\s*(?:-|\u2013|\u2014|to|until)\s*(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/ig;
    const out = []; let m;
    while ((m = re.exec(line)) !== null) {
      let mer1 = m[3], mer2 = m[6]; if (!mer1 && mer2) mer1 = mer2; if (!mer2 && mer1) mer2 = mer1;
      if (+m[1] > 23 || +m[4] > 23) continue;
      const sM = to24(m[1], m[2], mer1), eM = to24(m[4], m[5], mer2);
      if (isNaN(sM) || isNaN(eM) || eM <= sM || sM >= 1440 || eM > 1440) continue;
      out.push({ startMin: sM, endMin: eM, index: m.index, end: m.index + m[0].length });
    }
    return out;
  }
  function splitTimedLine(line) {
    const ranges = findTimeRanges(line);
    if (!ranges.length) return [];
    const segs = [];
    for (let i = 0; i < ranges.length; i++) {
      const r = ranges[i];
      const after = line.slice(r.end, i + 1 < ranges.length ? ranges[i + 1].index : line.length);
      const before = i === 0 ? line.slice(0, r.index) : '';
      const label = cleanEdges(after) || cleanEdges(before);
      segs.push({ startMin: r.startMin, endMin: r.endMin, label });
    }
    return segs;
  }
  function extractTag(text, allowBare = true) {
    let tag = null, out = text;
    const hash = out.match(/(?:^|\s)#([a-z][a-z-]*)/i);
    if (hash) { const t = normalizeTag('#' + hash[1].toLowerCase()); if (tagInfo(t)) { tag = t; out = out.slice(0, hash.index) + ' ' + out.slice(hash.index + hash[0].length); } }
    if (!tag && allowBare) { const words = out.trim().split(/\s+/); if (words.length > 1) { const last = words[words.length - 1].toLowerCase().replace(/[^a-z-]/g, ''); if (TAG_ALIAS_MAP[last]) { tag = TAG_ALIAS_MAP[last]; words.pop(); out = words.join(' '); } } }
    return { tag, text: out.replace(/\s+/g, ' ').trim() };
  }
  function cleanEdges(s) { return s.replace(/\|/g, ' ').replace(/\s+/g, ' ').replace(/^[\s\-\u2013\u2014:,]+/, '').replace(/[\s\-\u2013\u2014:,]+$/, '').trim(); }
  function parseFlexTodo(line) {
    let work = line;
    let duration = null;
    const unit = work.match(/(?:^|\s|\|)(\d+\s*h(?:r|ours?)?\s*\d*\s*m?|\d+(?:\.\d+)?\s*h(?:r|ours?)?|\d+\s*m(?:in(?:ute)?s?)?)(?=\s|\||,|$)/i);
    if (unit) { const d = parseDurationToken(unit[1]); if (d) { duration = d; work = work.slice(0, unit.index) + ' ' + work.slice(unit.index + unit[0].length); } }
    const tg = extractTag(work); const tag = tg.tag; work = tg.text;
    if (duration == null) { const tr = work.match(/(?:^|\s|\|)(\d{1,3})\s*\|?\s*$/); if (tr) { const n = +tr[1]; if (n > 0 && n <= 480) { duration = n; work = work.slice(0, tr.index); } } }
    const title = cleanEdges(work);
    if (!title) return null;
    return { title, duration: duration || 30, tag };
  }
  function parseDayText(text) {
    const todos = [], fixed = [];
    text.split('\n').forEach(raw => {
      const line = raw.trim();
      if (!line || line.startsWith('//')) return;
      const segs = splitTimedLine(line);
      if (segs.length) { segs.forEach(seg => { const r = extractTag(seg.label, false); fixed.push({ start: fmtHHMM(seg.startMin), end: fmtHHMM(seg.endMin), startMin: seg.startMin, endMin: seg.endMin, title: r.text || 'Block', tag: r.tag }); }); }
      else { const t = parseFlexTodo(line); if (t) todos.push(t); }
    });
    return { todos, fixed };
  }
  function parseCalendarLines(text) {
    const rows = [];
    text.split('\n').forEach(raw => { const line = raw.trim(); if (!line) return; splitTimedLine(line).forEach(seg => { rows.push({ id: uid('c'), start: fmtHHMM(seg.startMin), end: fmtHHMM(seg.endMin), label: seg.label || 'Busy', enabled: true }); }); });
    return rows;
  }
  function icsEscape(t) { return String(t).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;'); }
  function foldLine(line) {
    const enc = new TextEncoder();
    if (enc.encode(line).length <= 75) return line;
    const out = []; let cur = '', curBytes = 0;
    for (const ch of line) { const b = enc.encode(ch).length; const max = out.length === 0 ? 75 : 74; if (curBytes + b > max) { out.push(cur); cur = ch; curBytes = b; } else { cur += ch; curBytes += b; } }
    if (cur) out.push(cur);
    return out.map((seg, i) => i === 0 ? seg : ' ' + seg).join('\r\n');
  }
  function dateToICSLocal(dateStr, hhmm) { const [y, m, d] = dateStr.split('-'); const [h, mn] = hhmm.split(':'); return `${y}${m}${d}T${pad2(h)}${pad2(mn)}00`; }
  function icsStampUTC() { const d = new Date(); return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}T${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}Z`; }
  function hashStr(s) { let h = 5381; for (let i = 0; i < s.length; i++) { h = ((h << 5) + h) + s.charCodeAt(i); h |= 0; } return (h >>> 0).toString(36); }
  function buildICS(blocks, dateStr) {
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Day Planner//EN', 'CALSCALE:GREGORIAN'];
    const stamp = icsStampUTC();
    blocks.forEach(b => {
      if (!['todo', 'pinned', 'focus', 'freetime'].includes(b.type)) return;
      lines.push('BEGIN:VEVENT');
      lines.push(`UID:${hashStr(dateStr + b.start + b.end + b.title)}@dayplanner.local`);
      lines.push(`DTSTAMP:${stamp}`);
      lines.push(`DTSTART:${dateToICSLocal(dateStr, b.start)}`);
      lines.push(`DTEND:${dateToICSLocal(dateStr, b.end)}`);
      const info = b.tag ? tagInfo(b.tag) : null;
      lines.push(`SUMMARY:${icsEscape(info ? `${info.emoji} ${b.title}` : b.title)}`);
      if (info) lines.push(`CATEGORIES:${icsEscape(info.name)}`);
      else if (b.type === 'focus') lines.push('CATEGORIES:Focus');
      else if (b.type === 'freetime') lines.push('CATEGORIES:Free');
      lines.push('DESCRIPTION:Planned by Day Planner');
      if (b.type === 'freetime') lines.push('TRANSP:TRANSPARENT');
      lines.push('END:VEVENT');
    });
    lines.push('END:VCALENDAR');
    return lines.map(foldLine).join('\r\n') + '\r\n';
  }
  function downloadICS(text, filename) {
    const blob = new Blob([text], { type: 'text/calendar;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function downloadSingleICS(b) {
    if (!state.planContext) return;
    const ics = buildICS([b], state.planContext.date);
    const safe = (b.title || 'event').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 40) || 'event';
    downloadICS(ics, `${safe}-${state.planContext.date}.ics`);
    showToast('Calendar file downloaded');
  }
  function computeGaps(anchors, startMin, endMin) {
    const sorted = [...anchors].sort((a, b) => a.startMin - b.startMin);
    const gaps = []; let cur = startMin;
    for (const b of sorted) { if (b.startMin > cur) gaps.push([cur, Math.min(b.startMin, endMin)]); cur = Math.max(cur, b.endMin); if (cur >= endMin) break; }
    if (cur < endMin) gaps.push([cur, endMin]);
    return gaps.filter(([s, e]) => e > s);
  }
  function fillGapsWithHolds(blocks, startMin, endMin) {
    const sorted = [...blocks].sort((a, b) => parseHHMM(a.start) - parseHHMM(b.start));
    const result = []; let cursor = startMin, focusIdx = 0;
    function pushHold(s, e) { const dur = e - s; if (dur <= 0) return; if (dur >= 30) { focusIdx += 1; result.push({ start: fmtHHMM(s), end: fmtHHMM(e), title: focusIdx === 1 ? 'Focus' : `Focus ${focusIdx}`, tag: null, type: 'focus' }); } else result.push({ start: fmtHHMM(s), end: fmtHHMM(e), title: 'Free time', tag: null, type: 'freetime' }); }
    for (const b of sorted) { const s = parseHHMM(b.start), e = parseHHMM(b.end); if (s == null || e == null) continue; if (s > cursor) pushHold(cursor, s); result.push(b); if (e > cursor) cursor = e; }
    if (cursor < endMin) pushHold(cursor, endMin);
    return result;
  }
  function packSchedule(items, anchors, startMin, endMin) {
    const gaps = computeGaps(anchors, startMin, endMin);
    let gi = 0, cursor = startMin;
    const placed = [], unscheduled = [];
    function findSlot(dur) { let g = gi; while (g < gaps.length) { const [gs, ge] = gaps[g]; const p = Math.max(cursor, gs); if (p + dur <= ge) return { p, g }; g++; } return null; }
    let pendingBreak = 0;
    for (const it of items) {
      if (it.kind === 'break') { pendingBreak = Math.max(pendingBreak, it.duration || 0); continue; }
      const td = it.todo, dur = td.duration;
      let slot = null, withBreak = false;
      if (pendingBreak > 0) { slot = findSlot(pendingBreak + dur); if (slot) withBreak = true; }
      if (!slot) { slot = findSlot(dur); withBreak = false; }
      if (!slot) { unscheduled.push(td); pendingBreak = 0; continue; }
      let start = slot.p; gi = slot.g;
      if (withBreak) { placed.push({ start: fmtHHMM(start), end: fmtHHMM(start + pendingBreak), title: 'Break', tag: '#break', type: 'break' }); start += pendingBreak; }
      placed.push({ start: fmtHHMM(start), end: fmtHHMM(start + dur), title: td.title, tag: td.tag || null, type: 'todo', itemId: it.id });
      cursor = start + dur; pendingBreak = 0;
    }
    const anchorBlocks = anchors.map(a => ({ start: a.start, end: a.end, title: a.title, tag: a.tag || null, type: a.type, itemId: a.itemId, srcCal: a.srcCal }));
    const all = fillGapsWithHolds([...placed, ...anchorBlocks], startMin, endMin);
    return { blocks: all, unscheduled };
  }
  function itemsFromTodoOrder(order) { const items = []; let prevDeep = false; order.forEach(t => { const isDeep = t.tag === '#deep'; if (isDeep && prevDeep) items.push({ kind: 'break', duration: 10 }); items.push({ kind: 'todo', id: t.id, todo: t }); prevDeep = isDeep; }); return items; }
  function localOrder(todos) { const priority = { '#deep': 0, '#plan': 1, '#meeting': 2, '#admin': 3, '#fitness': 4, '#ready': 5, '#travel': 6, '#rest': 7, '#break': 8 }; return todos.map((t, i) => ({ t, i })).sort((a, b) => { const pa = priority[a.t.tag] ?? 5, pb = priority[b.t.tag] ?? 5; return pa !== pb ? pa - pb : a.i - b.i; }).map(x => x.t); }
  function buildAnchors(calendarAnchors, fixedBlocks) { const pin = fixedBlocks.map(f => ({ start: f.start, end: f.end, startMin: f.startMin != null ? f.startMin : parseHHMM(f.start), endMin: f.endMin != null ? f.endMin : parseHHMM(f.end), title: f.title, tag: f.tag, type: 'pinned', itemId: f.id })); return [...calendarAnchors, ...pin]; }
  function enabledCalendarAnchors() { return state.calendar.filter(c => c.enabled).map(c => ({ start: c.start, end: c.end, startMin: parseHHMM(c.start), endMin: parseHHMM(c.end), title: c.label, tag: null, type: c.pinned ? 'pinned' : 'busy', itemId: c.id, srcCal: true })); }
  function normTitle(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
  function dedupeCalendar(calendarAnchors, fixedBlocks) {
    return calendarAnchors.filter(c => !fixedBlocks.some(f => {
      const fs = f.startMin != null ? f.startMin : parseHHMM(f.start);
      const fe = f.endMin != null ? f.endMin : parseHHMM(f.end);
      if (fs == null || fe == null) return false;
      const sameTime = c.startMin === fs && c.endMin === fe;
      const overlap = Math.max(c.startMin, fs) < Math.min(c.endMin, fe);
      const ct = normTitle(c.title), ft = normTitle(f.title);
      const sameTitle = ct && ct === ft;
      return sameTime || (sameTitle && overlap);
    }));
  }
  function assembleAnchors(calendarAnchors, fixedBlocks) { return buildAnchors(dedupeCalendar(calendarAnchors, fixedBlocks), fixedBlocks); }
  function anchorIssues(anchors, sM, eM) { const issues = []; anchors.forEach(a => { if (a.startMin < sM || a.endMin > eM) issues.push(`${a.title} (${a.start}\u2013${a.end}) is outside your day window`); }); const sorted = [...anchors].sort((x, y) => x.startMin - y.startMin); for (let i = 1; i < sorted.length; i++) if (sorted[i].startMin < sorted[i - 1].endMin) issues.push(`${sorted[i - 1].title} and ${sorted[i].title} overlap`); return issues; }
  const state = {
    dayText:
`Write Razer brief, 90m, deep work
Reply to Nicole's email - 15m, admin
Pick up package, 20m, travel
Lunch with Sachin, 60m
Walk, 30m, fitness

17:00-18:30 Run outside
18:30-19:30 Meeting with SFYR online
19:30-20:00 Dinner
20:00-21:00 Research more projects, deep work

Deep work in the morning, keep the afternoon lighter`,
    calendar: [
      { id: uid('c'), start: '12:00', end: '13:00', label: 'Standup', enabled: true },
      { id: uid('c'), start: '15:30', end: '16:00', label: 'Sync with Vinod', enabled: true },
    ],
    calAddText: '',
    calImporting: false,
    date: todayLocalISO(),
    startTime: '09:00',
    endTime: '21:30',
    loading: false, error: null, rawResponse: null,
    blocks: null, unscheduled: [], rationale: null, engine: null,
    flexTodos: null, fixedBlocks: null, planContext: null, editingItemId: null,
    templates: [], templatesOpen: false, pendingDeleteKey: null, namingTemplate: false, undo: [],
    completed: new Set(),
  };
  function calcCapacity() {
    const sM = parseHHMM(state.startTime), eM = parseHHMM(state.endTime);
    if (sM == null || eM == null || eM <= sM) return null;
    const { todos, fixed } = parseDayText(state.dayText);
    const anchors = assembleAnchors(enabledCalendarAnchors(), fixed);
    const gaps = computeGaps(anchors, sM, eM);
    const available = gaps.reduce((a, [s, e]) => a + (e - s), 0);
    const todoMins = todos.reduce((a, t) => a + t.duration, 0);
    const ratio = available > 0 ? todoMins / available : (todoMins > 0 ? 2 : 0);
    const status = ratio < 0.75 ? 'under' : ratio <= 1.0 ? 'tight' : 'over';
    return { todoMins, available, ratio, status, pct: Math.min(100, Math.max(0, Math.round(ratio * 100))), nTodos: todos.length, nFixed: fixed.length };
  }
  let saveTimer = null, saveStatus = { state: 'idle' };
  function legacyToDay(v) {
    const dayLines = [];
    if (v.todosText) v.todosText.split('\n').forEach(l => { if (l.trim()) dayLines.push(l.trim()); });
    if (v.constraintsText && v.constraintsText.trim()) dayLines.push(v.constraintsText.trim());
    const calendar = v.busyText ? parseCalendarLines(v.busyText) : [];
    return { dayText: dayLines.join('\n'), calendar };
  }
  async function loadPersistedState() {
    try {
      const s = await storage.get(STORAGE_KEYS.settings);
      if (s && s.value) {
        const v = JSON.parse(s.value);
        if (typeof v.dayText === 'string') { state.dayText = v.dayText; if (Array.isArray(v.calendar)) state.calendar = v.calendar; }
        else if (v.todosText || v.busyText) { const mig = legacyToDay(v); state.dayText = mig.dayText; state.calendar = mig.calendar; }
        if (typeof v.startTime === 'string') state.startTime = v.startTime;
        if (typeof v.endTime === 'string') state.endTime = v.endTime;
      }
    } catch (e) {}
    try {
      const lp = await storage.get(STORAGE_KEYS.lastPlan);
      if (lp && lp.value) { const v = JSON.parse(lp.value); if (v && Array.isArray(v.blocks) && v.planContext) { state.blocks = v.blocks; state.unscheduled = v.unscheduled || []; state.rationale = v.rationale || null; state.engine = v.engine || null; state.flexTodos = v.flexTodos || null; state.fixedBlocks = v.fixedBlocks || null; state.planContext = v.planContext; state.completed = new Set(Array.isArray(v.completed) ? v.completed : []); } }
    } catch (e) {}
    try {
      const tpls = await storage.list('planner:tpl:');
      if (tpls && tpls.keys) { const items = []; for (const k of tpls.keys) { try { const r = await storage.get(k); if (r && r.value) items.push({ key: k, ...JSON.parse(r.value) }); } catch (e) {} } items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)); state.templates = items; }
    } catch (e) {}
  }
  function schedulePersist() { saveStatus = { state: 'saving' }; updateSaveIndicator(); if (saveTimer) clearTimeout(saveTimer); saveTimer = setTimeout(persistSettings, 500); }
  async function persistSettings() {
    try { await storage.set(STORAGE_KEYS.settings, JSON.stringify({ dayText: state.dayText, calendar: state.calendar, startTime: state.startTime, endTime: state.endTime })); saveStatus = { state: 'saved' }; }
    catch (e) { saveStatus = { state: 'idle' }; }
    updateSaveIndicator();
  }
  async function persistPlan() {
    try { if (!state.blocks) { await storage.delete(STORAGE_KEYS.lastPlan); return; } await storage.set(STORAGE_KEYS.lastPlan, JSON.stringify({ blocks: state.blocks, unscheduled: state.unscheduled, rationale: state.rationale, engine: state.engine, flexTodos: state.flexTodos, fixedBlocks: state.fixedBlocks, planContext: state.planContext, completed: [...state.completed] })); } catch (e) {}
  }
  function updateSaveIndicator() {
    const el = document.getElementById('saveStatus'); if (!el) return;
    if (saveStatus.state === 'saving') el.innerHTML = `<div class="dot" style="background:#fbbf24"></div><span>Saving</span>`;
    else if (saveStatus.state === 'saved') el.innerHTML = `<div class="dot"></div><span>Saved</span>`;
    else el.innerHTML = '';
  }
  async function saveTemplate(name) {
    const id = 'planner:tpl:' + Date.now();
    const data = { name, dayText: state.dayText, calendar: state.calendar, startTime: state.startTime, endTime: state.endTime, createdAt: Date.now() };
    try { await storage.set(id, JSON.stringify(data)); state.templates = [{ key: id, ...data }, ...state.templates]; showToast(`Saved template "${name}"`); } catch (e) { showToast('Could not save template'); }
    patchTemplates();
  }
  async function deleteTemplate(key) { try { await storage.delete(key); state.templates = state.templates.filter(t => t.key !== key); showToast('Template deleted'); } catch (e) {} state.pendingDeleteKey = null; patchTemplates(); }
  function applyTemplate(key) {
    const t = state.templates.find(x => x.key === key); if (!t) return;
    if (typeof t.dayText === 'string') { state.dayText = t.dayText; state.calendar = Array.isArray(t.calendar) ? t.calendar.map(c => ({ ...c })) : []; }
    else { const mig = legacyToDay(t); state.dayText = mig.dayText; state.calendar = mig.calendar; }
    if (t.startTime) state.startTime = t.startTime;
    if (t.endTime) state.endTime = t.endTime;
    state.templatesOpen = false;
    syncInputsFromState(); schedulePersist(); showToast(`Loaded "${t.name}"`);
    updateDerived(); patchCalendar(); patchTemplates();
  }
  let toastTimer = null;
  function showToast(message, action) {
    const el = document.getElementById('toast'); if (!el) return;
    el.innerHTML = `<span>${escapeHTML(message)}</span>` + (action ? `<button class="toast-action" id="toastAction">${escapeHTML(action.label)}</button>` : '');
    el.classList.add('show');
    if (action) { const b = document.getElementById('toastAction'); if (b) b.addEventListener('click', () => { el.classList.remove('show'); action.fn(); }); }
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), action ? 5000 : 2200);
  }
  function snapshot() { state.undo.push(JSON.stringify({ blocks: state.blocks, unscheduled: state.unscheduled, rationale: state.rationale, engine: state.engine, flexTodos: state.flexTodos, fixedBlocks: state.fixedBlocks, planContext: state.planContext })); if (state.undo.length > 25) state.undo.shift(); }
  function undo() {
    if (!state.undo.length) { showToast('Nothing to undo'); return; }
    const s = JSON.parse(state.undo.pop());
    Object.assign(state, { blocks: s.blocks, unscheduled: s.unscheduled, rationale: s.rationale, engine: s.engine, flexTodos: s.flexTodos, fixedBlocks: s.fixedBlocks, planContext: s.planContext });
    state.editingItemId = null; persistPlan(); patchPlan(); showToast('Change undone');
  }
  function repackFromModel() {
    const ctx = state.planContext;
    const sM = parseHHMM(ctx.startTime), eM = parseHHMM(ctx.endTime);
    const anchors = assembleAnchors(ctx.calendarAnchors || [], state.fixedBlocks || []);
    const { blocks, unscheduled } = packSchedule(itemsFromTodoOrder(state.flexTodos || []), anchors, sM, eM);
    state.blocks = blocks; state.unscheduled = unscheduled; persistPlan();
  }
  const root = document.getElementById('root');
  function mountShell() {
    root.innerHTML = `
      <div class="relative">
        <div class="header-glow"></div>
        <div class="relative max-w-3xl mx-auto px-6 py-12 md:py-14">
          <header class="mb-8 flex items-start justify-between gap-4">
            <div class="flex items-center gap-3">
              <div class="w-9 h-9 rounded-lg bg-violet-100 flex items-center justify-center">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#7c3aed" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
              </div>
              <div>
                <h1 class="text-3xl font-bold text-slate-900 tracking-tight">Day Planner</h1>
                <p class="text-sm text-slate-500 mt-0.5">Brain-dump, paste an email or agenda, or jot a few lines \u2014 I'll shape it into a schedule.</p>
              </div>
            </div>
            <div id="saveStatus" class="save-status mt-3" aria-live="polite"></div>
          </header>
          <section class="card p-5 md:p-6 mb-5">
            <div class="flex items-baseline justify-between mb-1.5">
              <label class="text-sm font-semibold text-slate-800" for="dayText">Your day</label>
              <span class="engine-badge ai" title="Claude reads your notes">\u2726 understands plain notes</span>
            </div>
            <p class="text-xs text-slate-500 mb-3 leading-relaxed">Tasks, rough durations, anything on your mind. Anything with a time like <span class="font-mono bg-slate-100 px-1 rounded">17:00-18:30 Run outside</span> gets pinned to exactly that time \u2014 you can even paste a whole run of them on one line (<span class="font-mono bg-slate-100 px-1 rounded">17:00-18:30 | Run \u00b7 18:30-19:30 | Meeting</span>). Everything else fills the open gaps, and plain sentences (\u201cdeep work in the morning\u201d) are read as preferences. Formatting is forgiving \u2014 commas, dashes, pipes, am/pm all work. You can even paste an email or calendar agenda and I'll pull the events out.</p>
            <div class="flex flex-wrap items-center gap-1.5 mb-2.5">
              <span class="text-[11px] uppercase tracking-wide font-semibold text-slate-400 mr-1">add tag</span>
              ${TAGS.map(t => `<button class="qi-chip qi-tag ${t.cls}" data-day-tag="${t.id}" type="button" title="${escapeHTML(t.name)}"><span class="qi-emoji">${t.emoji}</span><span>${t.short}</span></button>`).join('')}
            </div>
            <textarea id="dayText" rows="12" class="day-textarea" placeholder="e.g.&#10;Write the brief, 90m, deep work&#10;Reply to Nicole, 15m&#10;Lunch with Sachin around noon&#10;17:00-18:30 Run outside&#10;Keep mornings for focused work">${escapeHTML(state.dayText)}</textarea>
            <p id="dayPreview" class="text-xs text-slate-500 mt-2.5"></p>
          </section>
          <section class="card p-5 md:p-6 mb-5">
            <div class="flex items-baseline justify-between mb-1">
              <h2 class="text-sm font-semibold text-slate-800">Already on your calendar</h2>
              <span class="text-[11px] text-slate-400">optional</span>
            </div>
            <p class="text-xs text-slate-500 mb-3">Events you can't move. The switch includes or ignores one without deleting it; the <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" style="display:inline;vertical-align:-1px"><path d="M16 3l5 5-4 1-3 3v4l-2 2-3-3-5 5-1-1 5-5-3-3 2-2h4l3-3 1-4z"/></svg> pin shows it in your schedule at its exact time (imported events arrive pinned). Unpinned events still block the time, just without a titled block.</p>
            <div id="calendarRegion"></div>
          </section>
          <section class="card p-5 md:p-6 mb-6">
            <div class="grid md:grid-cols-3 gap-4 mb-4">
              <div><label class="label-tag block mb-1.5" for="date">Date</label><input id="date" type="date" value="${state.date}" class="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-800" /></div>
              <div><label class="label-tag block mb-1.5" for="startTime">Start</label><input id="startTime" type="time" value="${state.startTime}" class="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-800" /></div>
              <div><label class="label-tag block mb-1.5" for="endTime">End</label><input id="endTime" type="time" value="${state.endTime}" class="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-800" /></div>
            </div>
            <div id="capacityRegion"></div>
            <div id="anchorWarn"></div>
            <div class="flex flex-col md:flex-row md:items-center md:justify-between gap-3 mt-4 pt-4 border-t border-slate-100">
              <p id="windowText" class="text-xs text-slate-500"></p>
              <div class="flex items-center gap-2 relative">
                <div id="templatesRegion" class="relative"></div>
                <button id="planBtn" class="px-5 py-2.5 rounded-lg text-sm font-semibold inline-flex items-center justify-center gap-2 min-w-[200px]"></button>
              </div>
            </div>
          </section>
          <div id="errorRegion"></div>
          <div id="planRegion"></div>
        </div>
      </div>`;
    bindStaticEvents();
  }
  function syncInputsFromState() { const set = (id, v) => { const el = document.getElementById(id); if (el && el.value !== v) el.value = v; }; set('dayText', state.dayText); set('date', state.date); set('startTime', state.startTime); set('endTime', state.endTime); }
  function renderCapacityMeter(cap) {
    const labels = { under: 'Comfortable fit', tight: 'Cutting it close', over: 'Over capacity' };
    const colors = { under: 'text-emerald-700', tight: 'text-amber-700', over: 'text-red-700' };
    const overflow = cap.todoMins - cap.available;
    return `<div><div class="flex items-baseline justify-between mb-1.5"><span class="text-xs font-semibold ${colors[cap.status]}">${labels[cap.status]}</span><span class="text-xs text-slate-500 tabular-nums">${fmtDuration(cap.todoMins)} of tasks \u00b7 ${fmtDuration(Math.max(0, cap.available))} open${cap.status === 'over' ? ` (over by ${fmtDuration(overflow)})` : ''}</span></div><div class="capacity-track"><div class="capacity-fill ${cap.status}" style="width: ${cap.pct}%"></div></div><p class="text-[11px] text-slate-400 mt-1.5">Estimate before breaks, around your pinned blocks and calendar.</p></div>`;
  }
  function updateDerived() {
    const sM = parseHHMM(state.startTime), eM = parseHHMM(state.endTime);
    const valid = sM != null && eM != null && eM > sM;
    const { todos, fixed } = parseDayText(state.dayText);
    const preview = document.getElementById('dayPreview');
    if (preview) { const total = todos.reduce((a, t) => a + t.duration, 0); const bits = [`${todos.length} task${todos.length === 1 ? '' : 's'}`]; if (fixed.length) bits.push(`${fixed.length} pinned time${fixed.length === 1 ? '' : 's'}`); bits.push(`~${fmtDuration(total)} of work`); preview.innerHTML = `Reading: ${bits.join(' \u00b7 ')}`; }
    const capRegion = document.getElementById('capacityRegion');
    if (capRegion) { const cap = calcCapacity(); capRegion.innerHTML = (cap && valid) ? renderCapacityMeter(cap) : ''; }
    const warn = document.getElementById('anchorWarn');
    if (warn) { if (valid) { const anchors = assembleAnchors(enabledCalendarAnchors(), fixed); const issues = anchorIssues(anchors, sM, eM); warn.innerHTML = issues.length ? `<div class="mt-3 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">${escapeHTML(issues[0])}${issues.length > 1 ? ` (+${issues.length - 1} more)` : ''}</div>` : ''; } else warn.innerHTML = ''; }
    const windowText = document.getElementById('windowText');
    if (windowText) windowText.textContent = valid ? `Window: ${fmtDuration(eM - sM)} (${state.startTime} to ${state.endTime})` : 'End time must be after start time.';
    updatePlanButton(todos.length + fixed.length > 0 && valid && !state.loading);
  }
  function updatePlanButton(canSubmit) {
    const btn = document.getElementById('planBtn'); if (!btn) return;
    btn.disabled = !canSubmit;
    btn.className = `${canSubmit ? 'bg-slate-900 hover:bg-slate-800 text-white' : 'bg-slate-200 text-slate-400 cursor-not-allowed'} px-5 py-2.5 rounded-lg text-sm font-semibold inline-flex items-center justify-center gap-2 min-w-[200px]`;
    btn.innerHTML = state.loading ? `<span class="spinner"></span><span>Planning\u2026</span>` : `<span>${state.blocks ? 'Re-plan my day' : 'Plan my day'}</span><kbd class="hidden md:inline-flex items-center text-[10px] font-mono bg-white/20 px-1.5 py-0.5 rounded">\u2318\u21b5</kbd>`;
  }
  function patchCalendar() {
    const region = document.getElementById('calendarRegion'); if (!region) return;
    const rows = state.calendar.map(c => `<div class="cal-row ${c.enabled ? '' : 'disabled'}"><label class="switch" title="${c.enabled ? 'Included' : 'Ignored'}"><input type="checkbox" ${c.enabled ? 'checked' : ''} data-cal-toggle="${c.id}" aria-label="Include ${escapeHTML(c.label)}" /><span class="track"></span><span class="thumb"></span></label><span class="cal-time">${escapeHTML(c.start)}\u2013${escapeHTML(c.end)}</span><span class="cal-label">${escapeHTML(c.label)}</span>${c.pinned ? `<span class="cal-pin-tag" title="Shown in your schedule at this exact time">pinned</span>` : ''}<button class="cal-pin ${c.pinned ? 'is-on' : ''}" data-cal-pin="${c.id}" title="${c.pinned ? 'Pinned to your schedule at this exact time \u2014 tap to make it block time only' : 'Tap to pin into your schedule at this exact time'}" aria-label="${c.pinned ? 'Unpin' : 'Pin'} ${escapeHTML(c.label)}"><svg width="14" height="14" viewBox="0 0 24 24" fill="${c.pinned ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 3l5 5-4 1-3 3v4l-2 2-3-3-5 5-1-1 5-5-3-3 2-2h4l3-3 1-4z"/></svg></button><button class="cal-del" data-cal-del="${c.id}" title="Remove" aria-label="Remove ${escapeHTML(c.label)}"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div>`).join('');
    region.innerHTML = `${state.calendar.length ? `<div class="space-y-2 mb-3">${rows}</div>` : `<div class="text-xs text-slate-400 mb-3 py-2">Nothing booked yet.</div>`}<div class="flex items-center gap-2"><input id="calAdd" type="text" value="${escapeHTML(state.calAddText)}" placeholder="12:00-13:00 Standup" class="flex-1 bg-white border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-800" aria-label="Add a calendar event" /><button id="calAddBtn" class="px-3.5 py-2 rounded-lg text-sm font-semibold border border-slate-200 bg-white text-slate-700 hover:bg-slate-50">Add</button></div><div class="mt-3 pt-3 border-t border-slate-100 flex items-center justify-between gap-3 flex-wrap"><button id="calImportBtn" ${state.calImporting ? 'disabled' : ''} class="px-3 py-2 rounded-lg text-sm font-semibold border ${state.calImporting ? 'border-slate-200 text-slate-400 cursor-wait' : 'border-violet-200 text-violet-700 hover:bg-violet-50'} bg-white inline-flex items-center gap-1.5">${state.calImporting ? '<span class="spinner" style="border-color:rgba(124,58,237,0.3);border-top-color:#7c3aed"></span><span>Reading file\u2026</span>' : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/></svg><span>Import .ics file</span>'}</button><span class="text-[11px] text-slate-400 flex-1 min-w-[180px]">Import an .ics file exported from Google Calendar, Outlook, or Apple Calendar. Events on the selected date are converted to your local time and pinned to their exact times (tap the pin to make one block time only). Recurring events are expanded. You can also paste an agenda into "Your day" above and the AI will read it. (Live one-click sync needs OAuth \u2014 see the README.)</span></div>`;
    bindCalendarEvents();
  }
  function patchTemplates() {
    const region = document.getElementById('templatesRegion'); if (!region) return;
    const hasT = state.templates.length > 0;
    const canSave = state.dayText.trim().length > 0;
    region.innerHTML = `<button id="templatesBtn" aria-haspopup="true" aria-expanded="${state.templatesOpen}" class="px-3 py-2.5 rounded-lg text-sm font-medium border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 inline-flex items-center gap-1.5"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg><span>Templates</span>${hasT ? `<span class="text-[10px] bg-slate-100 text-slate-600 rounded-full px-1.5 py-0.5 font-bold">${state.templates.length}</span>` : ''}</button>${state.templatesOpen ? `<div class="templates-menu" id="templatesMenu" role="menu"><div class="px-3 py-2 border-b border-slate-100">${state.namingTemplate ? `<div class="flex items-center gap-2"><input id="tplNameInput" type="text" placeholder="Template name" class="flex-1 min-w-0 border border-slate-200 rounded-md px-2 py-1 text-sm" /><button id="tplNameSave" class="text-[11px] font-semibold text-violet-700 hover:text-violet-900">Save</button><button id="tplNameCancel" class="text-[11px] font-semibold text-slate-500 hover:text-slate-700">Cancel</button></div>` : `<div class="flex items-center justify-between"><span class="text-[11px] uppercase tracking-wide font-semibold text-slate-400">Templates</span><button id="saveTemplateBtn" ${canSave ? '' : 'disabled'} class="text-[11px] font-semibold ${canSave ? 'text-violet-700 hover:text-violet-900' : 'text-slate-300 cursor-not-allowed'}">Save current</button></div>`}</div>${hasT ? state.templates.map(t => { const nT = (typeof t.dayText === 'string') ? parseDayText(t.dayText).todos.length : parseDayText(legacyToDay(t).dayText).todos.length; return `<div class="tpl-item" data-apply-template="${t.key}" role="menuitem" tabindex="0"><div class="flex-1 min-w-0"><div class="font-medium text-slate-800 truncate">${escapeHTML(t.name)}</div><div class="tpl-meta">${nT} tasks${t.startTime && t.endTime ? ` \u00b7 ${t.startTime}\u2013${t.endTime}` : ''}</div></div>${state.pendingDeleteKey === t.key ? `<div class="flex items-center gap-1.5 flex-shrink-0"><button class="text-[11px] font-semibold text-red-600" data-confirm-delete="${t.key}">Delete</button><button class="text-[11px] font-semibold text-slate-500" data-cancel-delete="1">Cancel</button></div>` : `<button class="tpl-delete" data-delete-template="${t.key}" title="Delete" aria-label="Delete template"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>`}</div>`; }).join('') : `<div class="px-3 py-4 text-xs text-slate-400 text-center">No templates yet. Save your current setup to reuse it.</div>`}</div>` : ''}`;
    bindTemplatesEvents();
    const nameInput = document.getElementById('tplNameInput'); if (nameInput) nameInput.focus();
  }
  function patchError() {
    const region = document.getElementById('errorRegion'); if (!region) return;
    if (!state.error) { region.innerHTML = ''; return; }
    region.innerHTML = `<div class="mb-6 bg-red-50 border border-red-200 rounded-xl px-4 py-3 flex items-start gap-3" role="alert"><svg class="mt-0.5 flex-shrink-0" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#dc2626" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg><div class="flex-1 min-w-0"><p class="text-sm text-red-800 font-medium">${escapeHTML(state.error)}</p></div><button id="dismissError" class="text-red-700 hover:text-red-900 flex-shrink-0" aria-label="Dismiss"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div>`;
    const d = document.getElementById('dismissError'); if (d) d.addEventListener('click', () => { state.error = null; patchError(); });
  }
  function patchPlan() {
    const region = document.getElementById('planRegion'); if (!region) return;
    region.innerHTML = state.blocks ? renderTimeline() : '';
    bindPlanEvents();
    if (state.editingItemId != null) { const f = document.getElementById(`edit-title-${state.editingItemId}`); if (f) f.focus(); }
    const pb = document.getElementById('planBtn'); updatePlanButton(pb ? !pb.disabled : false);
  }
  function renderTimeline() {
    const blocks = state.blocks, ctx = state.planContext, rationale = state.rationale;
    const todoCount = blocks.filter(b => b.type === 'todo').length;
    const pinCount = blocks.filter(b => b.type === 'pinned').length;
    const breakCount = blocks.filter(b => b.type === 'break').length;
    const focusCount = blocks.filter(b => b.type === 'focus').length;
    const isToday = ctx.date === todayLocalISO();
    const now = nowMinutes();
    const planStart = parseHHMM(ctx.startTime), planEnd = parseHHMM(ctx.endTime);
    const isLive = isToday && now >= planStart && now < planEnd;
    let activeIdx = -1;
    if (isLive) activeIdx = blocks.findIndex(b => { const s = parseHHMM(b.start), e = parseHHMM(b.end); return s != null && e != null && now >= s && now < e; });
    const rows = blocks.map((b, i) => renderBlockRow(b, i, { isLive, now, activeIdx })).join('');
    const doneCount = blocks.filter(b => b.type === 'todo' && state.completed.has(b.itemId)).length;
    const chips = [`${todoCount} task${todoCount === 1 ? '' : 's'} placed`];
    if (doneCount) chips.push(`${doneCount} done`);
    if (pinCount) chips.push(`${pinCount} pinned`);
    if (focusCount) chips.push(`${focusCount} focus hold${focusCount === 1 ? '' : 's'}`);
    if (breakCount) chips.push(`${breakCount} break${breakCount === 1 ? '' : 's'}`);
    const engineBadge = state.engine === 'ai' ? `<span class="engine-badge ai" title="Interpreted by Claude">\u2726 AI plan</span>` : `<span class="engine-badge local" title="Built locally without the AI">Local plan</span>`;
    const overflow = state.unscheduled && state.unscheduled.length ? renderOverflowCard() : '';
    return `<section class="mt-2"><div class="flex flex-col md:flex-row md:items-end md:justify-between gap-3 mb-5"><div><div class="flex items-center gap-3 flex-wrap"><h2 class="text-xl font-bold text-slate-900">${escapeHTML(formatDateHeading(ctx.date))}</h2>${engineBadge}${isLive ? `<span class="text-[10px] font-bold uppercase tracking-wider text-violet-700 bg-violet-100 px-2 py-1 rounded-full">Live</span>` : ''}</div><div class="flex flex-wrap gap-2 mt-2">${chips.map(s => `<span class="summary-chip">${escapeHTML(s)}</span>`).join('')}</div></div><div class="flex items-center gap-2 flex-wrap">${state.undo.length ? `<button id="undoBtn" class="px-3 py-2 rounded-lg text-xs font-semibold border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 inline-flex items-center gap-1.5"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7v6h6"/><path d="M3 13a9 9 0 1 0 3-7.7L3 8"/></svg>Undo</button>` : ''}<button id="clearPlanBtn" class="px-3 py-2 rounded-lg text-xs font-semibold border border-slate-200 bg-white text-slate-600 hover:bg-slate-50">Clear</button><button id="downloadBtn" class="px-3.5 py-2 rounded-lg text-sm font-semibold bg-violet-600 text-white hover:bg-violet-700 inline-flex items-center gap-1.5" title="Download every task, pinned block and focus hold as one .ics"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>Download all .ics</button></div></div>${overflow}${rationale ? `<div class="rationale-card"><svg class="flex-shrink-0 mt-0.5" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#7c3aed" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg><p class="text-sm text-slate-700 leading-relaxed flex-1">${escapeHTML(rationale)}</p></div>` : ''}<p class="text-xs text-slate-400 mb-3">Drag a task by its handle to reorder, or click any task to edit. Hover a block and tap <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="display:inline;vertical-align:-1px"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> to save just that one to your calendar.</p><div class="space-y-3" id="blockList">${rows}</div></section>`;
  }
  function renderOverflowCard() {
    const list = state.unscheduled;
    const total = list.reduce((a, t) => a + t.duration, 0);
    return `<div class="overflow-card" role="alert"><div class="flex items-start gap-3"><svg class="flex-shrink-0 mt-0.5" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#d97706" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg><div class="flex-1 min-w-0"><p class="text-sm font-semibold text-amber-900">${list.length} task${list.length === 1 ? '' : 's'} didn't fit (${fmtDuration(total)})</p><p class="text-sm text-amber-800 mt-0.5">${list.map(t => escapeHTML(t.title)).join(', ')}</p><div class="flex items-center gap-2 mt-2.5"><button id="extendBtn" class="text-xs font-semibold text-white bg-amber-600 hover:bg-amber-700 px-3 py-1.5 rounded-md">Extend day to fit</button><span class="text-[11px] text-amber-700">or shorten tasks / free up time, then re-plan</span></div></div></div></div>`;
  }
  function tagClassFor(b) { if (b.type === 'busy') return 'tag-busy'; if (b.type === 'break') return 'tag-sysbreak'; if (b.type === 'focus') return 'tag-focus'; if (b.type === 'freetime') return 'tag-freetime'; if (b.tag && TAG_CLASS[b.tag]) return TAG_CLASS[b.tag]; return 'tag-none'; }
  function renderBlockRow(b, i, live) {
    const s = parseHHMM(b.start), e = parseHHMM(b.end);
    const dur = (s != null && e != null) ? (e - s) : 30;
    const height = Math.round(Math.max(56, Math.min(dur * PX_PER_MIN, 340)));
    const tagCls = tagClassFor(b);
    const isTodo = b.type === 'todo', isPinned = b.type === 'pinned', isBreak = b.type === 'break', isBusy = b.type === 'busy', isFocus = b.type === 'focus', isFree = b.type === 'freetime';
    const fromCal = !!b.srcCal;
    const isEditable = (isTodo || isPinned) && !fromCal;
    const canIcs = isTodo || isPinned;
    const isPast = live.isLive && e <= live.now;
    const isActive = live.isLive && i === live.activeIdx;
    const isEditing = isEditable && state.editingItemId === b.itemId;
    const isDone = isTodo && state.completed.has(b.itemId);
    const cardCls = `block-card ${tagCls} ${isEditable ? 'is-editable' : ''} ${canIcs ? 'is-downloadable' : ''} ${isTodo ? 'is-flex' : ''} ${isBreak ? 'is-break' : ''} ${isBusy ? 'is-busy' : ''} ${isFocus ? 'is-focus' : ''} ${isFree ? 'is-freetime' : ''} ${isActive ? 'is-active' : ''} ${isPast ? 'is-past' : ''} ${isDone ? 'is-completed' : ''}`;
    let metaHtml = '';
    if (isBreak || isFree) metaHtml = '';
    else if (isFocus) metaHtml = `<div class="text-sm text-slate-500 mt-1">${dur} min \u00b7 <span class="chip">focus hold</span></div>`;
    else if (isBusy) metaHtml = `<div class="text-sm text-slate-500 mt-1">${dur} min \u00b7 calendar</div>`;
    else { const info = b.tag ? tagInfo(b.tag) : null; const tagHtml = info ? `<span class="chip">${info.emoji} ${escapeHTML(info.name)}</span>` : (b.tag ? `<span class="chip">${escapeHTML(b.tag)}</span>` : ''); const pinHtml = isPinned ? `<span class="pin-badge"><svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M16 3l5 5-4 1-3 3v4l-2 2-3-3-5 5-1-1 5-5-3-3 2-2h4l3-3 1-4z"/></svg>pinned</span>` : ''; const calHtml = fromCal ? `<span class="chip">from calendar</span>` : ''; metaHtml = `<div class="text-sm text-slate-500 mt-1 flex items-center gap-2 flex-wrap">${dur} min${tagHtml ? ' \u00b7 ' + tagHtml : ''}${pinHtml ? ' ' + pinHtml : ''}${calHtml ? ' ' + calHtml : ''}</div>`; }
    const titleSize = (isBreak || isFree) ? '' : 'text-base';
    const titleInfo = (isTodo || isPinned) && b.tag ? tagInfo(b.tag) : null;
    const titleHtml = titleInfo ? `<span class="block-emoji">${titleInfo.emoji}</span>${escapeHTML(b.title)}` : escapeHTML(b.title);
    let progressHtml = '';
    if (isActive) { const pct = Math.min(100, Math.max(0, ((live.now - s) / dur) * 100)); progressHtml = `<div class="progress-bar" style="width: ${pct}%"></div>`; }
    const nowBadge = isActive ? `<span class="now-badge"><span class="pulse-dot"></span>NOW</span>` : '';
    const handle = isTodo ? `<span class="drag-handle" aria-hidden="true" title="Drag to reorder"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg></span>` : '';
    const icsBtn = canIcs ? `<button class="block-ics" data-block-ics="${b.itemId}" title="Save this to calendar (.ics)" aria-label="Download ${escapeHTML(b.title)} as a calendar file"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></button>` : '';
    const completeBtn = isTodo ? `<button class="complete-btn${isDone ? ' is-done' : ''}" data-complete="${b.itemId}" title="${isDone ? 'Mark incomplete' : 'Mark complete'}" aria-label="${isDone ? 'Mark incomplete' : 'Mark complete'}: ${escapeHTML(b.title)}"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg></button>` : '';
    const editForm = isEditing ? renderEditor(b) : '';
    const a11y = isEditable ? `role="button" tabindex="0" aria-label="${escapeHTML(b.title)}, ${b.start} to ${b.end}, ${dur} minutes. Activate to edit." data-block-edit="${b.itemId}"` : '';
    const dragAttrs = isTodo ? `draggable="true" data-item-id="${b.itemId}"` : '';
    return `<div class="block-row flex items-start gap-4" ${dragAttrs} style="animation-delay: ${i * 40}ms"><div class="time-col"><div>${escapeHTML(b.start)}</div><div class="time-sep">\u00b7</div><div class="time-end">${escapeHTML(b.end)}</div></div><div class="flex-1 min-w-0"><div class="${cardCls}" ${a11y} style="min-height: ${height}px"><div class="flex items-start gap-2">${handle}<div class="block-title font-semibold text-slate-900 ${titleSize} flex-1 min-w-0">${titleHtml}</div>${icsBtn}${completeBtn}${nowBadge}</div>${metaHtml}${progressHtml}</div>${editForm}</div></div>`;
  }
  function renderEditor(b) {
    const id = b.itemId;
    const isPinned = b.type === 'pinned';
    const timeOrDuration = isPinned
      ? `<div class="grid grid-cols-2 gap-2"><div><label class="label-tag block mb-1" for="edit-start-${id}">Start</label><input id="edit-start-${id}" type="time" value="${b.start}" class="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-sm" /></div><div><label class="label-tag block mb-1" for="edit-end-${id}">End</label><input id="edit-end-${id}" type="time" value="${b.end}" class="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-sm" /></div></div>`
      : `<div><label class="label-tag block mb-1" for="edit-dur-${id}">Duration (min)</label><div class="flex items-stretch"><button class="step-btn" data-block-action="dur-dec" data-item-id="${id}" type="button" aria-label="Decrease duration">\u2212</button><input id="edit-dur-${id}" type="number" min="5" step="5" value="${parseHHMM(b.end) - parseHHMM(b.start)}" class="w-full text-center border-y border-slate-200 px-2 py-2 text-sm" /><button class="step-btn" data-block-action="dur-inc" data-item-id="${id}" type="button" aria-label="Increase duration">+</button></div></div>`;
    return `<div class="block-editor" id="editor-${id}">${isPinned ? `<p class="text-[11px] text-slate-400 mb-2.5">Pinned block \u2014 set its own time below.</p>` : `<p class="text-[11px] text-slate-400 mb-2.5">Scheduled ${b.start}\u2013${b.end} (placed automatically). Edit details and the day re-packs.</p>`}<div class="mb-2"><label class="label-tag block mb-1" for="edit-title-${id}">Title</label><input id="edit-title-${id}" type="text" value="${escapeHTML(b.title)}" class="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-sm" /></div><div class="grid grid-cols-2 gap-2 mb-3">${timeOrDuration}<div><label class="label-tag block mb-1" for="edit-tag-${id}">Tag</label><select id="edit-tag-${id}" class="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-sm"><option value="" ${!b.tag ? 'selected' : ''}>None</option>${TAGS.map(t => `<option value="${t.id}" ${t.id === (b.tag || '') ? 'selected' : ''}>${t.emoji} ${escapeHTML(t.name)}</option>`).join('')}</select></div></div><div class="flex items-center justify-between gap-2"><div class="flex items-center gap-3"><button data-block-action="remove" data-item-id="${id}" class="text-xs font-semibold text-red-600 hover:text-red-800 inline-flex items-center gap-1"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/></svg><span>Remove</span></button><button data-block-action="download" data-item-id="${id}" class="text-xs font-semibold text-slate-600 hover:text-violet-700 inline-flex items-center gap-1"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg><span>.ics</span></button></div><div class="flex gap-2"><button data-block-action="cancel-edit" data-item-id="${id}" class="text-xs font-semibold text-slate-600 hover:text-slate-900 px-3 py-1.5 rounded-md border border-slate-200 hover:bg-slate-50">Cancel</button><button data-block-action="save-edit" data-item-id="${id}" class="text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 px-3 py-1.5 rounded-md">Save</button></div></div></div>`;
  }
  function bindStaticEvents() {
    const dayEl = document.getElementById('dayText');
    if (dayEl) dayEl.addEventListener('input', e => { state.dayText = e.target.value; schedulePersist(); updateDerived(); });
    document.querySelectorAll('[data-day-tag]').forEach(btn => btn.addEventListener('click', () => insertDayTag(btn.dataset.dayTag)));
    const dateEl = document.getElementById('date');
    if (dateEl) dateEl.addEventListener('change', e => { state.date = e.target.value; });
    const startEl = document.getElementById('startTime');
    if (startEl) startEl.addEventListener('change', e => { state.startTime = e.target.value; schedulePersist(); updateDerived(); });
    const endEl = document.getElementById('endTime');
    if (endEl) endEl.addEventListener('change', e => { state.endTime = e.target.value; schedulePersist(); updateDerived(); });
    const planBtn = document.getElementById('planBtn');
    if (planBtn) planBtn.addEventListener('click', onPlan);
  }
  function insertDayTag(tagId) {
    const ta = document.getElementById('dayText'); if (!ta) return;
    const text = ta.value, c = ta.selectionStart;
    const needSpace = c > 0 && !/\s$/.test(text.slice(0, c));
    const ins = (needSpace ? ' ' : '') + tagId + ' ';
    const next = text.slice(0, c) + ins + text.slice(c);
    ta.value = next; state.dayText = next;
    const np = c + ins.length; ta.focus(); try { ta.setSelectionRange(np, np); } catch (e) {}
    schedulePersist(); updateDerived();
  }
  function bindCalendarEvents() {
    const addEl = document.getElementById('calAdd');
    if (addEl) { addEl.addEventListener('input', e => { state.calAddText = e.target.value; }); addEl.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addCalendarFromInput(); } }); }
    const addBtn = document.getElementById('calAddBtn');
    if (addBtn) addBtn.addEventListener('click', addCalendarFromInput);
    const importBtn = document.getElementById('calImportBtn');
    if (importBtn) importBtn.addEventListener('click', importFromConnector);
    document.querySelectorAll('[data-cal-toggle]').forEach(el => el.addEventListener('change', () => toggleCalendar(el.dataset.calToggle)));
    document.querySelectorAll('[data-cal-pin]').forEach(el => el.addEventListener('click', () => toggleCalPin(el.dataset.calPin)));
    document.querySelectorAll('[data-cal-del]').forEach(el => el.addEventListener('click', () => removeCalendar(el.dataset.calDel)));
  }
  function addCalendarFromInput() {
    const rows = parseCalendarLines(state.calAddText);
    if (!rows.length) { showToast('Add a time like 12:00-13:00 Standup'); return; }
    state.calendar = [...state.calendar, ...rows];
    state.calAddText = '';
    schedulePersist(); patchCalendar(); updateDerived();
    const a = document.getElementById('calAdd'); if (a) a.focus();
  }
  function toggleCalendar(id) { const c = state.calendar.find(x => x.id === id); if (!c) return; c.enabled = !c.enabled; schedulePersist(); patchCalendar(); updateDerived(); }
  function toggleCalPin(id) { const c = state.calendar.find(x => x.id === id); if (!c) return; c.pinned = !c.pinned; schedulePersist(); patchCalendar(); updateDerived(); }
  function removeCalendar(id) { state.calendar = state.calendar.filter(x => x.id !== id); schedulePersist(); patchCalendar(); updateDerived(); }
  function isoToLocal(x) {
    if (typeof x !== 'string') return null;
    const t = x.trim();
    if (/^\d{1,2}:\d{2}$/.test(t)) { const m = parseHHMM(t); return m == null ? null : { min: m, date: null }; }
    const d = new Date(t);
    if (isNaN(d.getTime())) return null;
    return { min: d.getHours() * 60 + d.getMinutes(), date: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` };
  }
  function eventToLocal(ev) {
    const s = isoToLocal(ev.start), e = isoToLocal(ev.end);
    if (!s || !e) return null;
    let sMin = s.min, eMin = e.min;
    if (eMin <= sMin) { if (e.date && s.date && e.date > s.date) eMin = 1439; else return null; }
    return { sMin, eMin, localDate: s.date };
  }
  function importFromConnector() {
    if (state.calImporting) return;
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.ics,text/calendar';
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      if (!file) return;
      state.calImporting = true; patchCalendar();
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const occ = parseICSForDate(String(reader.result || ''), state.date);
          let added = 0;
          occ.forEach(o => {
            if (o.eMin <= o.sMin) return;
            const start = fmtHHMM(o.sMin), end = fmtHHMM(o.eMin), label = (o.title || 'Busy').trim() || 'Busy';
            if (state.calendar.some(c => c.start === start && c.end === end && normTitle(c.label) === normTitle(label))) return;
            state.calendar.push({ id: uid('c'), start, end, label, enabled: true, pinned: true }); added++;
          });
          state.calImporting = false; schedulePersist(); patchCalendar(); updateDerived();
          showToast(added ? `Imported ${added} event${added === 1 ? '' : 's'} for ${formatDateHeading(state.date)}` : `No timed events on ${formatDateHeading(state.date)} in that file`);
        } catch (e) { state.calImporting = false; patchCalendar(); showToast('Could not read that .ics file'); }
      };
      reader.onerror = () => { state.calImporting = false; patchCalendar(); showToast('Could not read that file'); };
      reader.readAsText(file);
    });
    input.click();
  }
  function parseICSForDate(text, dateStr) {
    const comp = new ICAL.Component(ICAL.parse(text));
    const vevents = comp.getAllSubcomponents('vevent');
    const [Y, M, D] = dateStr.split('-').map(Number);
    const dayStart = new Date(Y, M - 1, D, 0, 0, 0, 0);
    const dayEnd = new Date(Y, M - 1, D + 1, 0, 0, 0, 0);
    const out = [];
    const pushOcc = (sd, ed, title) => {
      if (!(ed > dayStart && sd < dayEnd)) return;
      const sMin = sd.getHours() * 60 + sd.getMinutes();
      const sameDay = ed.getFullYear() === sd.getFullYear() && ed.getMonth() === sd.getMonth() && ed.getDate() === sd.getDate();
      const eMin = sameDay ? (ed.getHours() * 60 + ed.getMinutes()) : 1439;
      out.push({ sMin, eMin, title });
    };
    vevents.forEach(ve => {
      let ev; try { ev = new ICAL.Event(ve); } catch (e) { return; }
      if (ev.startDate && ev.startDate.isDate) return;
      const title = ev.summary || 'Busy';
      if (ev.isRecurring && ev.isRecurring()) {
        try { const it = ev.iterator(); let next, guard = 0; while ((next = it.next()) && guard++ < 2000) { const det = ev.getOccurrenceDetails(next); const sd = det.startDate.toJSDate(), ed = det.endDate.toJSDate(); if (sd >= dayEnd) break; pushOcc(sd, ed, title); } } catch (e) {}
      } else { try { pushOcc(ev.startDate.toJSDate(), ev.endDate.toJSDate(), title); } catch (e) {} }
    });
    return out;
  }
  function bindTemplatesEvents() {
    const tplBtn = document.getElementById('templatesBtn');
    if (tplBtn) tplBtn.addEventListener('click', e => { e.stopPropagation(); state.templatesOpen = !state.templatesOpen; state.namingTemplate = false; state.pendingDeleteKey = null; patchTemplates(); });
    document.querySelectorAll('[data-apply-template]').forEach(el => {
      el.addEventListener('click', e => { if (e.target.closest('[data-delete-template]') || e.target.closest('[data-confirm-delete]') || e.target.closest('[data-cancel-delete]')) return; applyTemplate(el.dataset.applyTemplate); });
      el.addEventListener('keydown', e => { if (e.key === 'Enter') applyTemplate(el.dataset.applyTemplate); });
    });
    document.querySelectorAll('[data-delete-template]').forEach(el => el.addEventListener('click', e => { e.stopPropagation(); state.pendingDeleteKey = el.dataset.deleteTemplate; patchTemplates(); }));
    document.querySelectorAll('[data-confirm-delete]').forEach(el => el.addEventListener('click', e => { e.stopPropagation(); deleteTemplate(el.dataset.confirmDelete); }));
    document.querySelectorAll('[data-cancel-delete]').forEach(el => el.addEventListener('click', e => { e.stopPropagation(); state.pendingDeleteKey = null; patchTemplates(); }));
    const saveTplBtn = document.getElementById('saveTemplateBtn');
    if (saveTplBtn) saveTplBtn.addEventListener('click', e => { e.stopPropagation(); state.namingTemplate = true; patchTemplates(); });
    const nameSave = document.getElementById('tplNameSave'); if (nameSave) nameSave.addEventListener('click', e => { e.stopPropagation(); commitTemplateName(); });
    const nameCancel = document.getElementById('tplNameCancel'); if (nameCancel) nameCancel.addEventListener('click', e => { e.stopPropagation(); state.namingTemplate = false; patchTemplates(); });
    const nameInput = document.getElementById('tplNameInput'); if (nameInput) nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); commitTemplateName(); } if (e.key === 'Escape') { state.namingTemplate = false; patchTemplates(); } });
  }
  function commitTemplateName() { const input = document.getElementById('tplNameInput'); const name = input ? input.value.trim() : ''; if (!name) { if (input) input.focus(); return; } state.namingTemplate = false; state.templatesOpen = false; saveTemplate(name); }
  function bindPlanEvents() {
    const undoBtn = document.getElementById('undoBtn'); if (undoBtn) undoBtn.addEventListener('click', undo);
    const clearBtn = document.getElementById('clearPlanBtn');
    if (clearBtn) clearBtn.addEventListener('click', () => { state.blocks = null; state.rationale = null; state.planContext = null; state.editingItemId = null; state.unscheduled = []; state.engine = null; state.flexTodos = null; state.fixedBlocks = null; state.undo = []; state.completed = new Set(); persistPlan(); patchPlan(); updateDerived(); });
    const downloadBtn = document.getElementById('downloadBtn');
    if (downloadBtn) downloadBtn.addEventListener('click', () => { if (!state.blocks || !state.planContext) return; downloadICS(buildICS(state.blocks, state.planContext.date), `day-planner-${state.planContext.date}.ics`); showToast('Full day downloaded'); });
    const extendBtn = document.getElementById('extendBtn'); if (extendBtn) extendBtn.addEventListener('click', extendDayToFit);
    document.querySelectorAll('[data-block-ics]').forEach(el => el.addEventListener('click', e => { e.stopPropagation(); const b = state.blocks.find(x => x.itemId === el.dataset.blockIcs); if (b) downloadSingleICS(b); }));
    document.querySelectorAll('[data-complete]').forEach(el => el.addEventListener('click', e => { e.stopPropagation(); const id = el.dataset.complete; if (state.completed.has(id)) state.completed.delete(id); else state.completed.add(id); persistPlan(); patchPlan(); }));
    document.querySelectorAll('[data-block-edit]').forEach(el => {
      const open = () => { const id = el.dataset.blockEdit; state.editingItemId = state.editingItemId === id ? null : id; patchPlan(); };
      el.addEventListener('click', e => { if (e.target.closest('[data-block-action]') || e.target.closest('[data-block-ics]') || e.target.closest('[data-complete]')) return; open(); });
      el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    });
    document.querySelectorAll('[data-block-action]').forEach(el => el.addEventListener('click', e => { e.stopPropagation(); handleBlockAction(el.dataset.itemId, el.dataset.blockAction); }));
    bindDragAndDrop();
  }
  let dragSrcId = null;
  function bindDragAndDrop() {
    document.querySelectorAll('.block-row[draggable="true"]').forEach(row => {
      row.addEventListener('dragstart', e => { dragSrcId = row.dataset.itemId; row.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', dragSrcId); } catch (err) {} });
      row.addEventListener('dragend', () => { row.classList.remove('dragging'); document.querySelectorAll('.drag-over').forEach(r => r.classList.remove('drag-over')); dragSrcId = null; });
      row.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; });
      row.addEventListener('dragenter', e => { e.preventDefault(); if (row.dataset.itemId !== dragSrcId) row.classList.add('drag-over'); });
      row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
      row.addEventListener('drop', e => { e.preventDefault(); row.classList.remove('drag-over'); const t = row.dataset.itemId; if (dragSrcId != null && t !== dragSrcId) reorderTodos(dragSrcId, t); });
    });
  }
  function reorderTodos(srcId, targetId) {
    if (!state.flexTodos) return;
    const from = state.flexTodos.findIndex(t => t.id === srcId);
    const to = state.flexTodos.findIndex(t => t.id === targetId);
    if (from === -1 || to === -1) return;
    snapshot();
    const [moved] = state.flexTodos.splice(from, 1);
    state.flexTodos.splice(to, 0, moved);
    repackFromModel(); patchPlan();
  }
  function handleBlockAction(id, action) {
    if (action === 'dur-inc' || action === 'dur-dec') { const inp = document.getElementById(`edit-dur-${id}`); if (!inp) return; let v = parseInt(inp.value, 10) || 30; v = action === 'dur-inc' ? v + 5 : Math.max(5, v - 5); inp.value = v; return; }
    if (action === 'cancel-edit') { state.editingItemId = null; patchPlan(); return; }
    if (action === 'download') { const b = state.blocks.find(x => x.itemId === id); if (b) downloadSingleICS(b); return; }
    if (action === 'remove') {
      snapshot();
      if (String(id).startsWith('f')) state.fixedBlocks = state.fixedBlocks.filter(f => f.id !== id);
      else state.flexTodos = state.flexTodos.filter(t => t.id !== id);
      state.editingItemId = null; repackFromModel(); patchPlan();
      showToast('Removed', { label: 'Undo', fn: undo });
      return;
    }
    if (action === 'save-edit') {
      const titleEl = document.getElementById(`edit-title-${id}`);
      const tagEl = document.getElementById(`edit-tag-${id}`);
      if (!titleEl || !titleEl.value.trim()) { showToast('Title can\u2019t be empty'); return; }
      const tag = (tagEl && tagEl.value) ? tagEl.value : null;
      if (String(id).startsWith('f')) {
        const sEl = document.getElementById(`edit-start-${id}`), eEl = document.getElementById(`edit-end-${id}`);
        const sM = parseHHMM(sEl && sEl.value), eM = parseHHMM(eEl && eEl.value);
        if (sM == null || eM == null || eM <= sM) { showToast('End must be after start'); return; }
        snapshot();
        const f = state.fixedBlocks.find(x => x.id === id);
        if (f) { f.title = titleEl.value.trim(); f.tag = tag; f.start = fmtHHMM(sM); f.end = fmtHHMM(eM); f.startMin = sM; f.endMin = eM; }
      } else {
        const durEl = document.getElementById(`edit-dur-${id}`); const dur = parseInt(durEl && durEl.value, 10);
        if (!dur || dur < 5) { showToast('Duration must be at least 5 min'); return; }
        snapshot();
        const t = state.flexTodos.find(x => x.id === id);
        if (t) { t.title = titleEl.value.trim(); t.duration = dur; t.tag = tag; }
      }
      state.editingItemId = null; repackFromModel(); patchPlan();
      return;
    }
  }
  function extendDayToFit() {
    const need = state.unscheduled.reduce((a, t) => a + t.duration, 0); if (!need) return;
    const eM = parseHHMM(state.planContext.endTime);
    const newEnd = Math.min(24 * 60 - 1, eM + Math.ceil(need / 15) * 15);
    snapshot();
    state.planContext.endTime = fmtHHMM(newEnd); state.endTime = fmtHHMM(newEnd);
    syncInputsFromState(); repackFromModel(); patchPlan(); updateDerived();
    showToast(`Day extended to ${fmtHHMM(newEnd)}`);
  }
  const SYSTEM_PROMPT = `You are a scheduling assistant. The person will give you whatever is on their mind about their day — a tidy list, a messy brain-dump, or pasted text such as an email, a calendar agenda, or a Slack message. Read all of it and turn it into a structured, ordered plan. Pull out the real tasks and appointments; ignore greetings, signatures, quoted reply threads, links, and other noise.

The application places flexible tasks into the open time itself — you do NOT assign clock times to flexible tasks. You DO carry over any time the person explicitly attached to something.

From the notes, extract three things:
1. Flexible tasks: things to do that aren't tied to a clock time. Give each a short title, an estimated duration in minutes (infer a sensible one if unstated), and a tag if one clearly fits (else null).
2. Fixed blocks: anything tied to a specific clock time, written however the person wrote it \u2014 "17:00-18:30 Run outside", "lunch at noon", "call with Sam at 3 for 30 min", "dentist 9\u20139:45", "standup 10am". Give each start and end in 24-hour HH:MM, a title, and a tag if clear. If only a start time is given, choose a reasonable duration.
3. Preferences: honor stated preferences (e.g. "deep work in the morning", "lighter afternoon", "no meetings after 4") by ORDERING the flexible tasks accordingly.

Tag vocabulary: #deep DeepWork; #plan Planning + Writing; #meeting Relationships + Meeting; #admin Admin; #fitness Fitness + Health; #ready Getting Ready; #travel Travel; #rest Routine Rest; #break Break.

Order the flexible tasks in the sequence they should be done. Front-load demanding work when energy is usually higher, group similar tags, and respect the person's preferences and any fixed blocks.

Output ONLY raw JSON, no markdown, no prose:
{
  "rationale": "One or two warm, concise sentences on the key choices.",
  "todos": [ { "title": "Write the brief", "duration": 90, "tag": "#deep" } ],
  "fixed": [ { "start": "17:00", "end": "18:30", "title": "Run outside", "tag": "#fitness" } ]
}

Durations are minutes; times are 24-hour. Use null for tag when unclear. Include every task exactly once. If something has a clock time it goes in "fixed", not "todos".`;
  function buildPrompt() {
    const cal = state.calendar.filter(c => c.enabled);
    const calLines = cal.length ? cal.map(c => `- ${c.start}-${c.end}: ${c.label}`).join('\n') : '- (none)';
    return `Planning window: ${state.startTime} to ${state.endTime}\n\nNotes about the day:\n${state.dayText.trim() || '(empty)'}\n\nAlready on the calendar (treat as unavailable, do not reschedule):\n${calLines}\n\nReturn the ordering JSON only.`;
  }
  function buildPlanFromAI(json, sM, eM) {
    const todosRaw = Array.isArray(json.todos) ? json.todos : [];
    const fixedRaw = Array.isArray(json.fixed) ? json.fixed : [];
    const todos = []; let ti = 1;
    for (const t of todosRaw) { if (!t || !t.title) continue; let dur = Math.round(Number(t.duration)); if (!isFinite(dur) || dur < 5) dur = 30; dur = Math.min(dur, 600); todos.push({ id: 't' + (ti++), title: String(t.title).trim(), duration: dur, tag: normalizeTagSafe(t.tag) }); }
    const fixed = []; let fi = 1;
    for (const f of fixedRaw) { if (!f || !f.title) continue; const s = parseHHMM(f.start), e = parseHHMM(f.end); if (s == null || e == null || e <= s) continue; fixed.push({ id: 'f' + (fi++), start: fmtHHMM(s), end: fmtHHMM(e), startMin: s, endMin: e, title: String(f.title).trim(), tag: normalizeTagSafe(f.tag) }); }
    return { todos, fixed };
  }
  function buildPlanLocal() {
    const { todos, fixed } = parseDayText(state.dayText);
    const withIds = todos.map((t, i) => ({ id: 't' + (i + 1), ...t }));
    const ordered = localOrder(withIds);
    const fixedIds = fixed.map((f, i) => ({ id: 'f' + (i + 1), ...f }));
    return { todos: ordered, fixed: fixedIds, rationale: 'Planned locally: focused work earlier, similar tasks grouped, and your pinned times kept exactly.' };
  }
  function parseAIJson(text) {
    if (!text || !text.trim()) return { ok: false };
    let cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
    let json;
    try { json = JSON.parse(cleaned); } catch (e) { const m = cleaned.match(/\{[\s\S]*\}/); if (!m) return { ok: false }; try { json = JSON.parse(m[0]); } catch (e2) { return { ok: false }; } }
    if (!json || typeof json !== 'object') return { ok: false };
    return { ok: true, json };
  }
  async function onPlan() {
    if (state.loading) return;
    const sM = parseHHMM(state.startTime), eM = parseHHMM(state.endTime);
    if (sM == null || eM == null || eM <= sM) return;
    const { todos: lt, fixed: lf } = parseDayText(state.dayText);
    if (lt.length + lf.length === 0) return;
    if (state.blocks) snapshot();
    state.loading = true; state.error = null; state.rawResponse = null; state.editingItemId = null;
    updatePlanButton(false);
    const region = document.getElementById('planRegion');
    if (region && !state.blocks) region.innerHTML = `<div class="text-sm text-slate-400 py-6">Reading your notes and building the day\u2026</div>`;
    let lp = buildPlanLocal();
    let todos = lp.todos, fixed = lp.fixed, rationale = lp.rationale, engine = 'local';
    try {
      const data = await aiMessage({ system: SYSTEM_PROMPT, messages: [{ role: 'user', content: buildPrompt() }], max_tokens: 1500 });
      const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
      if (data.stop_reason === 'max_tokens') { showToast('AI response was cut off \u2014 used a local plan'); }
      else { const parsed = parseAIJson(text); if (parsed.ok) { const built = buildPlanFromAI(parsed.json, sM, eM); if (built.todos.length + built.fixed.length > 0) { todos = built.todos; fixed = built.fixed; rationale = parsed.json.rationale || 'Ordered to front-load focused work and group similar tasks, around your fixed times.'; engine = 'ai'; } else { showToast('Couldn\u2019t read tasks from the notes \u2014 used a local plan'); } } else { showToast('AI response was unreadable \u2014 used a local plan'); } }
    } catch (err) { showToast(err && err.noBackend ? 'No AI backend configured \u2014 built a local plan' : 'AI unavailable \u2014 built a local plan'); }
    const calAnchors = enabledCalendarAnchors();
    const anchors = assembleAnchors(calAnchors, fixed);
    const { blocks, unscheduled } = packSchedule(itemsFromTodoOrder(todos), anchors, sM, eM);
    state.blocks = blocks; state.unscheduled = unscheduled; state.rationale = rationale; state.engine = engine;
    state.flexTodos = todos; state.fixedBlocks = fixed;
    state.planContext = { date: state.date, startTime: state.startTime, endTime: state.endTime, calendarAnchors: calAnchors };
    state.completed = new Set();
    state.loading = false;
    persistPlan(); patchError(); patchPlan(); updateDerived();
    setTimeout(() => { const el = document.querySelector('#planRegion section'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 100);
  }
  document.addEventListener('click', (e) => { if (state.templatesOpen) { const menu = document.getElementById('templatesMenu'), btn = document.getElementById('templatesBtn'); if (menu && !menu.contains(e.target) && btn && !btn.contains(e.target)) { state.templatesOpen = false; patchTemplates(); } } });
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); onPlan(); return; }
    if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z')) { const tag = (e.target && e.target.tagName) || ''; if (tag !== 'TEXTAREA' && tag !== 'INPUT') { e.preventDefault(); undo(); } return; }
    if (e.key === 'Escape') { if (state.editingItemId != null) { state.editingItemId = null; patchPlan(); } else if (state.templatesOpen) { state.templatesOpen = false; patchTemplates(); } }
  });
  setInterval(() => { if (!state.blocks || !state.planContext) return; if (state.editingItemId != null || state.loading) return; if (state.planContext.date !== todayLocalISO()) return; patchPlan(); }, 30000);
  (async function init() {
    mountShell(); updateDerived(); patchCalendar(); patchTemplates();
    try { await loadPersistedState(); syncInputsFromState(); updateDerived(); patchCalendar(); patchTemplates(); patchPlan(); } catch (e) {}
  })();
