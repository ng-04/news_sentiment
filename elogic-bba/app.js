// E-Logic BBA: a static site (hash routes) over site-data.json, plus Ask E-Logic, a cited answer bot
// over the handbook PDF and the master-data workbook. The bot reuses the Local Q&A engine: documents
// are read in this browser, and questions go straight to Anthropic with the visitor's own key.
import * as engine from '../local-qa/engine.js';
import * as charts from '../local-qa/qa-chart.js';

const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'style') node.style.cssText = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) node.append(c);
  return node;
};
const icon = (name, cls = '') => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  if (cls) svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
};
const webStore = (kind) => ({
  get(key) { try { return window[kind].getItem(key); } catch (e) { return null; } },
  set(key, value) {
    try { if (value == null) window[kind].removeItem(key); else window[kind].setItem(key, value); } catch (e) { /* blocked */ }
  },
});
const session = webStore('sessionStorage');
const local = webStore('localStorage');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const countBy = (rows, key) => rows.reduce((m, r) => m.set(r[key], (m.get(r[key]) || 0) + 1), new Map());

const DOCS = [
  { name: 'E-Logic_BBA_Student_Handbook_2026-27.pdf', kb: 'pdf' },
  { name: 'E-Logic_BBA_Master_Data_2026-27.xlsx', kb: 'xlsx' },
];
// The two documents are about 170k characters; sending them whole (prompt-cached) beats retrieval for
// "list every…" and "how many…" questions. Past this size the bot falls back to best-matching passages.
const FULL_CONTEXT_LIMIT = 260000;

// Academic calendar 2026-27, as printed on page 10 of the handbook.
const CALENDAR = [
  ['2026-07-20', 'Orientation', 'Orientation for the 2026-29 batch'],
  ['2026-07-27', 'Classes', 'Odd semester classes begin'],
  ['2026-09-14', 'Exams', 'Mid-term exams, odd semester'],
  ['2026-10-10', 'Parents', 'Parent-Teacher Meeting 1'],
  ['2026-11-06', 'Break', 'Deepavali break begins'],
  ['2026-11-23', 'Exams', 'End-term exams, odd semester'],
  ['2027-01-04', 'Classes', 'Even semester classes begin'],
  ['2027-01-22', 'Campus', 'E-Fest, the annual festival'],
  ['2027-02-15', 'Exams', 'Mid-term exams, even semester'],
  ['2027-03-13', 'Parents', 'Parent-Teacher Meeting 2'],
  ['2027-04-26', 'Exams', 'End-term exams, even semester'],
  ['2027-05-17', 'Internship', 'Summer internship begins'],
];
const TRACKS = [
  { name: 'Marketing', code: 'MKT', img: 'photo-1552664730-d307ca884978', text: 'Brands, sales, retail and digital campaigns, planned and measured end to end.' },
  { name: 'Finance', code: 'FIN', img: 'photo-1531482615713-2afd69097998', text: 'Valuation, investments, markets and FinTech, with live portfolio work.' },
  { name: 'Human Resources', code: 'HRM', img: 'photo-1522202176988-66273c2fd55f', text: 'Hiring, rewards, learning and labour law for the modern workplace.' },
  { name: 'Business Analytics', code: 'BAN', img: 'photo-1517048676732-d65bc937f952', text: 'Dashboards, predictive models and machine learning for managers.' },
];

let data = null;

// ================================================================== routing

const VIEWS = ['home', 'programme', 'curriculum', 'faculty', 'students', 'handbook', 'ask'];
let curSem = 0; // 0 = all semesters

function route() {
  const [view, sub] = location.hash.replace(/^#/, '').split('/');
  const name = VIEWS.includes(view) ? view : 'home';
  for (const v of document.querySelectorAll('.view')) v.hidden = v.dataset.view !== name;
  for (const a of document.querySelectorAll('.primary-nav a[data-route]')) a.classList.toggle('is-current', a.dataset.route === name);
  $('primary-nav').classList.remove('is-open');
  $('nav-toggle').setAttribute('aria-expanded', 'false');
  $('fab').hidden = name === 'ask';
  if (name === 'curriculum' && sub && /^[1-6]$/.test(sub)) { curSem = Number(sub); renderCurriculum(); }
  const target = sub && name === 'programme' ? document.getElementById(`programme-${sub}`) : null;
  if (target) target.scrollIntoView({ behavior: 'smooth' });
  else window.scrollTo({ top: 0 });
  if (name === 'ask') openAsk();
}

// ================================================================== home

function heroCarousel() {
  const slides = [...document.querySelectorAll('.hero-slide')];
  const dots = document.querySelector('.hero-dots');
  let at = 0;
  let timer = null;
  const show = (i) => {
    at = (i + slides.length) % slides.length;
    slides.forEach((s, k) => s.classList.toggle('is-active', k === at));
    [...dots.children].forEach((d, k) => d.setAttribute('aria-selected', String(k === at)));
  };
  const restart = () => {
    clearInterval(timer);
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) timer = setInterval(() => show(at + 1), 7000);
  };
  slides.forEach((_, k) => dots.append(el('button', { role: 'tab', 'aria-label': `Slide ${k + 1}`, onclick: () => { show(k); restart(); } })));
  document.querySelectorAll('.hero-arrow').forEach((b) => b.addEventListener('click', () => { show(at + Number(b.dataset.dir)); restart(); }));
  show(0);
  restart();
}

function renderHome() {
  const students = data.students;
  const states = new Set(students.map((s) => s['Home State'])).size;
  const stats = [
    [String(students.length), 'students across three batches'],
    [String(data.curriculum.length), 'subjects in the curriculum'],
    [String(data.faculty.length), 'faculty members'],
    [String(states), 'home states represented'],
    [`94<span>%</span>`, 'placed or in higher study'],
  ];
  $('home-stats').replaceChildren(...stats.map(([v, k]) => {
    const strong = el('strong');
    strong.innerHTML = v; // static markup from the list above
    return el('div', { class: 'stat' }, strong, el('p', { text: k }));
  }));
  $('q-subjects').textContent = `${data.curriculum.length} subjects · ${data.totalCredits} credits`;
  document.querySelectorAll('[data-total-credits]').forEach((n) => { n.textContent = data.totalCredits; });

  $('home-tracks').replaceChildren(...TRACKS.map((t) => {
    const n = data.curriculum.filter((c) => c['Subject Code'].startsWith(t.code)).length;
    return el('a', { class: 'track', href: '#curriculum/5', style: `--img:url('https://images.unsplash.com/${t.img}?w=700&q=70&auto=format&fit=crop')` },
      el('div', { class: 'track-body' }, el('b', { text: `${n} subjects · Year 3` }), el('h3', { text: t.name }), el('p', { text: t.text })));
  }));

  $('home-audience').replaceChildren(...starterGroups().map((g) => el('div', { class: 'aud' }, el('h3', { text: g.who }),
    g.questions.slice(0, 2).map((q) => el('button', { type: 'button', text: q, onclick: () => askFromAnywhere(q) })))));

  const today = new Date().toISOString().slice(0, 10);
  const upcoming = CALENDAR.filter(([d]) => d >= today);
  const shown = (upcoming.length >= 4 ? upcoming : CALENDAR.slice(-4)).slice(0, 4);
  const fmt = new Intl.DateTimeFormat('en-IN', { month: 'short', year: 'numeric' });
  $('home-events').replaceChildren(...shown.map(([d, kind, text], i) => {
    const date = new Date(`${d}T00:00:00`);
    return el('article', { class: `event${i === 0 && upcoming.length ? ' is-next' : ''}` },
      el('div', { class: 'event-date' }, el('strong', { text: String(date.getDate()).padStart(2, '0') }), el('span', { text: fmt.format(date) })),
      el('div', { class: 'event-body' }, el('b', { text: i === 0 && upcoming.length ? `Next up · ${kind}` : kind }), el('p', { text })));
  }));
}

// ================================================================== programme

function renderStructure() {
  const bySem = new Map();
  for (const c of data.curriculum) {
    const s = bySem.get(c.Semester) || { core: 0, coreCredits: 0, electives: 0 };
    if (c.Type === 'Core') { s.core += 1; s.coreCredits += c.Credits; } else s.electives += 1;
    bySem.set(c.Semester, s);
  }
  const elective = { 3: 'Choose 1 open elective (2 credits) of 3', 4: 'Choose 1 open elective (2 credits) of 3', 5: '2 subjects (8 credits) of your specialisation', 6: '2 subjects (8 credits) of your specialisation' };
  const rows = [...bySem.entries()].map(([sem, s]) => {
    const earned = s.coreCredits + (sem >= 5 ? 8 : sem >= 3 ? 2 : 0);
    return el('tr', {}, el('td', { text: `Semester ${sem}` }), el('td', { text: `Year ${Math.ceil(sem / 2)}` }),
      el('td', { class: 'num', text: String(s.core) }), el('td', { class: 'num', text: String(s.coreCredits) }),
      el('td', { text: elective[sem] || '-' }), el('td', { class: 'num', text: String(earned) }));
  });
  $('structure-table').replaceChildren(
    el('thead', {}, el('tr', {}, ['Semester', 'Year', 'Core subjects', 'Core credits', 'Electives', 'Credits earned'].map((h) => el('th', { text: h })))),
    el('tbody', {}, rows),
    el('tfoot', {}, el('tr', {}, el('td', { text: 'Total' }), el('td'), el('td'), el('td'), el('td'), el('td', { class: 'num', text: String(data.totalCredits) }))));
}

// ================================================================== curriculum

const tag = (text) => el('span', { class: `tag tag-${text.toLowerCase()}`, text });
const facultyName = (id) => (data.faculty.find((f) => f.id === id) || {}).name || id;

function renderCurriculum() {
  if (!data) return;
  const tabs = $('sem-tabs');
  if (!tabs.children.length) {
    ['All', 1, 2, 3, 4, 5, 6].forEach((s, i) => tabs.append(el('button', { role: 'tab', type: 'button', text: i ? `Sem ${s}` : s,
      onclick: () => { curSem = i; renderCurriculum(); } })));
    $('cur-type').addEventListener('change', renderCurriculum);
    $('cur-assess').addEventListener('change', renderCurriculum);
  }
  [...tabs.children].forEach((b, i) => b.setAttribute('aria-selected', String(i === curSem)));
  const type = $('cur-type').value;
  const assess = $('cur-assess').value;
  const rows = data.curriculum.filter((c) => (!curSem || c.Semester === curSem) && (!type || c.Type === type) && (!assess || c.Assessment === assess));
  const credits = rows.reduce((n, r) => n + r.Credits, 0);
  const sessions = rows.reduce((n, r) => n + r['Total Sessions'], 0);
  $('cur-kpis').replaceChildren(
    kpi(rows.length, 'subjects shown'), kpi(credits, 'credits offered (incl. every elective)'), kpi(sessions.toLocaleString('en-IN'), 'sessions in total'),
    kpi(rows.filter((r) => r.Type === 'Elective').length, 'electives'));
  const body = [];
  let lastSem = null;
  for (const r of rows) {
    if (!curSem && r.Semester !== lastSem) {
      body.push(el('tr', { class: 'sem-row' }, el('td', { colspan: 9, text: `Semester ${r.Semester} · ${r['Programme Year']}` })));
      lastSem = r.Semester;
    }
    body.push(el('tr', {}, el('td', { text: r['Subject Code'] }), el('td', {}, el('strong', { text: r.Subject }),
      r['Elective Group'] !== '-' ? el('div', { class: 'qa-ref', text: r['Elective Group'] }) : null),
    el('td', { text: r['Academic Year'] }), el('td', { class: 'num', text: String(r.Credits) }), el('td', { class: 'num', text: String(r['Sessions per Credit']) }),
    el('td', { class: 'num', text: String(r['Total Sessions']) }), el('td', {}, tag(r.Type)), el('td', {}, tag(r.Assessment)),
    el('td', { text: facultyName(r['Faculty ID']) })));
  }
  $('cur-table').replaceChildren(
    el('thead', {}, el('tr', {}, ['Code', 'Subject', 'Academic Year', 'Credits', 'Sessions / credit', 'Sessions', 'Type', 'Assessment', 'Faculty'].map((h) => el('th', { text: h })))),
    el('tbody', {}, body.length ? body : el('tr', {}, el('td', { colspan: 9, text: 'No subjects match these filters.' }))));
}

const kpi = (value, label) => el('div', { class: 'kpi' }, el('strong', { text: String(value) }), el('span', { text: label }));

// ================================================================== faculty

const AVATAR = ['#e35a1b', '#1f4e9c', '#11804a', '#8a3ffc', '#b8430d', '#16233f', '#0f7a7a', '#a0337a'];
const initials = (name) => name.replace(/\(.*?\)|Prof\.|Dr\.|Adv\.|Ms\.|Mr\./g, '').trim().split(/\s+/).map((p) => p[0]).slice(0, 2).join('');

function renderFaculty() {
  const areaSel = $('fac-area');
  if (areaSel.options.length === 1) {
    [...new Set(data.faculty.map((f) => f.area))].sort().forEach((a) => areaSel.append(el('option', { text: a })));
    areaSel.addEventListener('change', renderFaculty);
    $('fac-q').addEventListener('input', renderFaculty);
  }
  const q = $('fac-q').value.trim().toLowerCase();
  const area = areaSel.value;
  const subjectName = (code) => (data.curriculum.find((c) => c['Subject Code'] === code) || {}).Subject || code;
  const people = data.faculty.filter((f) => (!area || f.area === area)
    && (!q || [f.name, f.area, f.designation, f.role, ...f.subjects.map(subjectName), ...f.subjects].join(' ').toLowerCase().includes(q)));
  $('fac-grid').replaceChildren(...people.map((f, i) => el('article', { class: 'person' },
    el('div', { class: 'person-top' }, el('span', { class: 'avatar', style: `background:${AVATAR[data.faculty.indexOf(f) % AVATAR.length]}`, text: initials(f.name) }),
      el('div', {}, el('h3', { text: f.name }), el('div', { class: 'desig', text: f.designation }))),
    el('p', { class: 'area', text: `${f.area} · ${f.qualification} · ${f.experience} years` }),
    f.role !== '-' ? el('span', { class: 'role', text: f.role }) : null,
    el('div', { class: 'subj' }, f.subjects.map((code) => el('span', { class: 'tag', title: subjectName(code), text: code }))))));
  const rows = data.facultyAssignments.filter((r) => people.some((p) => p.id === r['Faculty ID']));
  $('fac-table').replaceChildren(
    el('thead', {}, el('tr', {}, ['Prof Name', 'Semester', 'Term', 'Code', 'Subject', 'Type', 'Sections', 'Sessions', 'Status'].map((h) => el('th', { text: h })))),
    el('tbody', {}, rows.map((r) => el('tr', {}, el('td', { text: r['Prof Name'] }), el('td', { class: 'num', text: String(r.Semester) }),
      el('td', { text: r.Term }), el('td', { text: r['Subject Code'] }), el('td', { text: r.Subject }), el('td', {}, tag(r.Type)),
      el('td', { text: r.Sections }), el('td', { class: 'num', text: String(r['Sessions Assigned']) }), el('td', { text: r.Status })))));
}

// ================================================================== students

const STU_COLS = ['Student ID', 'Student Name', 'Batch', 'Current Semester', 'Section', 'Home State', 'Home City', 'Parent / Guardian',
  'Relationship', 'Date of Admission', 'Specialisation', 'CGPA', 'Attendance % (current sem)', 'Fee Status', 'Faculty Mentor'];

function hbars(node, counts, limit = 10) {
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
  const max = Math.max(...rows.map((r) => r[1]));
  node.replaceChildren(...rows.map(([k, v]) => el('div', { class: 'hbar' }, el('span', { text: k }),
    el('div', { class: 'hbar-track' }, el('div', { class: 'hbar-fill', style: `width:${(v / max) * 100}%` })), el('b', { text: String(v) }))));
}

function renderStudents() {
  const all = data.students;
  const batchSel = $('stu-batch');
  const stateSel = $('stu-state');
  if (batchSel.options.length === 1) {
    [...new Set(all.map((s) => s.Batch))].sort().forEach((b) => batchSel.append(el('option', { text: b })));
    [...new Set(all.map((s) => s['Home State']))].sort().forEach((b) => stateSel.append(el('option', { text: b })));
    for (const n of [batchSel, stateSel]) n.addEventListener('change', renderStudents);
    $('stu-q').addEventListener('input', renderStudents);
    const graded = all.filter((s) => typeof s.CGPA === 'number');
    const avg = graded.reduce((n, s) => n + s.CGPA, 0) / graded.length;
    const low = all.filter((s) => s['Attendance % (current sem)'] < 75);
    $('stu-kpis').replaceChildren(kpi(all.length, 'students'), kpi(new Set(all.map((s) => s['Home State'])).size, 'home states'),
      kpi(all.filter((s) => s['Hostel Resident'] === 'Yes').length, 'hostel residents'), kpi(avg.toFixed(2), 'average CGPA (Years 2-3)'),
      kpi(low.length, 'below 75% attendance'), kpi(all.filter((s) => s['Fee Status'] !== 'Paid').length, 'with fees pending'));
    hbars($('stu-states'), countBy(all, 'Home State'));
    hbars($('stu-tracks'), countBy(all.filter((s) => s['Current Year'] === 'Year 3'), 'Specialisation'));
    $('stu-risk').replaceChildren(el('div', { class: 'risk' }, low.map((s) => el('span', { class: 'tag tag-low', title: `${s.Batch}, mentor ${s['Faculty Mentor']}`,
      text: `${s['Student Name']} · ${s['Attendance % (current sem)']}%` }))));
  }
  const q = $('stu-q').value.trim().toLowerCase();
  const rows = all.filter((s) => (!batchSel.value || s.Batch === batchSel.value) && (!stateSel.value || s['Home State'] === stateSel.value)
    && (!q || [s['Student ID'], s['Student Name'], s['Parent / Guardian'], s['Home City'], s['Faculty Mentor']].join(' ').toLowerCase().includes(q)));
  $('stu-table').replaceChildren(
    el('thead', {}, el('tr', {}, STU_COLS.map((h) => el('th', { text: h === 'Attendance % (current sem)' ? 'Attendance %' : h })))),
    el('tbody', {}, rows.map((s) => el('tr', {}, STU_COLS.map((h) => {
      const v = s[h];
      if (h === 'Attendance % (current sem)') return el('td', { class: 'num' }, v < 75 ? el('span', { class: 'tag tag-low', text: `${v}` }) : String(v));
      if (h === 'Fee Status') return el('td', {}, v === 'Paid' ? 'Paid' : el('span', { class: 'tag tag-elective', text: v }));
      return el('td', { class: typeof v === 'number' ? 'num' : null, text: String(v) });
    })))));
  $('stu-count').textContent = `Showing ${plural(rows.length, 'student')} of ${all.length}. More columns (date of birth, parent contact, category, scholarship, electives) are in the Student Master sheet.`;
}

// ================================================================== Ask E-Logic: knowledge base

const kb = { files: [], chunks: [], index: null, full: true, ready: null };

function kbStatus(key, text, cls = '') {
  const n = document.querySelector(`[data-kb="${key}"]`);
  n.textContent = text;
  n.className = cls;
}

function defaultSettings() {
  const s = Object.fromEntries(Object.entries(engine.PARAMS).map(([k, p]) => [k, p.default]));
  return { ...s, max_answer_tokens: 2000, history_turns: 4 };
}
const settings = defaultSettings();

/** Fetches, reads and chunks both documents once. Embeds them only if they're too big to send whole. */
function loadKnowledgeBase() {
  kb.ready ||= (async () => {
    const params = { chunk_strategy: settings.chunk_strategy, chunk_size: settings.chunk_size, chunk_overlap: settings.chunk_overlap };
    let next = 1;
    for (const doc of DOCS) {
      kbStatus(doc.kb, 'reading…', 'busy');
      try {
        const buffer = await (await fetch(`docs/${doc.name}`)).arrayBuffer();
        const parsed = await engine.parseFile(doc.name, buffer);
        const record = { fileId: `f${next++}`, name: doc.name, folder: '', pages: parsed.pages, parsed };
        const chunks = engine.chunkFile(record.fileId, record, parsed, params);
        kb.files.push(record);
        kb.chunks.push(...chunks);
        kbStatus(doc.kb, parsed.pages ? `${parsed.pages} pages` : `${parsed.tables.length} sheets · ${parsed.units.length} rows`, 'ok');
      } catch (e) {
        kbStatus(doc.kb, 'failed', 'err');
        throw new Error(`Couldn’t read ${doc.name}: ${e.message}. Check your connection (the readers load from a CDN) and reload.`);
      }
    }
    const chars = kb.chunks.reduce((n, c) => n + c.text.length, 0);
    kb.full = chars <= FULL_CONTEXT_LIMIT;
    if (!kb.full) {
      showStatus('Preparing search (first time only, about 34 MB)…');
      kb.index = new engine.VectorIndex();
      kb.index.add(kb.chunks, await engine.embedPassages(kb.chunks.map((c) => c.text)));
      hideStatus();
    }
  })().catch((e) => { kb.ready = null; throw e; });
  return kb.ready;
}

// ================================================================== Ask E-Logic: key and model

const readKey = () => session.get('localqa.apiKey') || local.get('localqa.apiKey') || '';
const readWorkspace = () => session.get('localqa.workspace') || local.get('localqa.workspace') || '';
function storeKey() {
  const key = $('api-key').value.trim();
  const ws = $('workspace').value.trim();
  const remember = $('remember-key').checked;
  session.set('localqa.apiKey', remember ? null : key || null);
  local.set('localqa.apiKey', remember ? key || null : null);
  session.set('localqa.workspace', remember ? null : ws || null);
  local.set('localqa.workspace', remember ? ws || null : null);
  $('key-status').textContent = key ? '' : 'No key yet.';
}
const model = () => $('model').value;

function wireKey() {
  const select = $('model');
  engine.MODELS.forEach((m) => select.append(el('option', { value: m, text: m })));
  select.value = engine.MODELS.includes(local.get('elogic.model')) ? local.get('elogic.model') : 'claude-sonnet-5';
  if (!select.value) select.selectedIndex = 0;
  select.addEventListener('change', () => local.set('elogic.model', select.value));
  $('api-key').value = readKey();
  $('workspace').value = readWorkspace();
  $('remember-key').checked = !!local.get('localqa.apiKey');
  for (const id of ['api-key', 'workspace']) $(id).addEventListener('change', storeKey);
  $('remember-key').addEventListener('change', storeKey);
  $('test-key').addEventListener('click', async () => {
    storeKey();
    const status = $('key-status');
    if (!readKey()) { status.textContent = 'Enter a key first.'; return; }
    status.textContent = 'Testing…';
    try {
      await engine.testKey(readKey(), readWorkspace());
      status.textContent = '✓ Key works';
    } catch (e) {
      status.textContent = e.message;
      if (e.code === 'needs_workspace' || e.code === 'bad_workspace') document.querySelector('.ws').open = true;
    }
  });
}

// ================================================================== Ask E-Logic: chat

const chat = { history: [], asking: false, count: 0, asked: 0 };

function starterGroups() {
  const pickStudent = (pred) => data.students.find(pred) || data.students[0];
  const first = pickStudent((s) => s['Current Semester'] === 1);
  const second = pickStudent((s) => s['Current Semester'] === 3 && typeof s.CGPA === 'number');
  return [
    { who: 'Students', questions: [
      'What are my open elective options in Semester 3, and how is each one assessed?',
      'What happens if my attendance falls below 75%?',
      'How many credits do I need to graduate, and how are they split across semesters?'] },
    { who: 'Parents', questions: [
      `Who is the faculty mentor for ${first['Student Name']}, and how do I contact them?`,
      `What are the attendance, CGPA and fee status of ${second['Student Name']}?`,
      'When is the next Parent-Teacher Meeting, and when are fee instalments due?'] },
    { who: 'Faculty', questions: [
      'Which subjects does Dr. Kavya Reddy teach, and how many sessions are assigned?',
      'List the Year 2 students with attendance below 80%, with their mentors.',
      'How is a Workshop subject evaluated, and how many sessions per credit does it get?'] },
    { who: 'Dean', questions: [
      'Chart the number of students by home state.',
      'What is the average CGPA by batch?',
      'Which students have fees due or partially paid, and who are their mentors?'] },
  ];
}

function renderStarters() {
  $('starters').replaceChildren(...starterGroups().map((g) => el('div', { class: 'starter-group' }, el('h3', { text: g.who }),
    g.questions.map((q) => el('button', { class: 'chip-q', type: 'button', text: q, onclick: () => ask(q) })))));
}

let pending = null;
function askFromAnywhere(q) {
  pending = q;
  if (location.hash === '#ask') openAsk(); else location.hash = '#ask';
}

function openAsk() {
  loadKnowledgeBase().then(() => {
    if (pending) { const q = pending; pending = null; ask(q); }
  }).catch((e) => showStatus(e.message, true));
  setTimeout(() => $('question').focus({ preventScroll: true }), 50);
}

function showStatus(text, error = false) {
  const s = $('chat-status');
  s.textContent = text;
  s.classList.toggle('is-error', error);
  s.hidden = false;
}
const hideStatus = () => { $('chat-status').hidden = true; };

const botBubble = (...children) => el('div', { class: 'msg-bot' },
  el('span', { class: 'bot-avatar', 'aria-hidden': 'true' }, el('i'), el('i'), el('i'), el('b')),
  el('div', { class: 'msg-bot-body' }, ...children));

/** Builds the prompt with the Local Q&A engine, then moves the documents into a cached system block so
 *  follow-up questions reuse them instead of paying for them again. */
function buildRequest(question, hits, history) {
  const catalog = engine.chartCatalog(kb.files);
  const { system, messages } = engine.buildPrompt(question, hits, history, settings, catalog, kb.full);
  const last = messages[messages.length - 1].content;
  const cut = last.lastIndexOf('\n\nQuestion: ');
  const documents = last.slice(0, cut);
  const today = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
  const persona = 'You are Ask E-Logic, the assistant for the BBA programme at E-Logic School of Business (a fictitious institution). '
    + 'You help students, parents and guardians, faculty and the Dean. The documents are the BBA Student Handbook 2026-27 (PDF) '
    + 'and the BBA master data workbook, with the sheets Curriculum Master, Student Master and Faculty Master. '
    + `Today is ${today}; use it for questions about what is next or coming up. Be warm and direct. `;
  return {
    system: [
      { type: 'text', text: persona + system.replace('provided in their message', 'provided below') },
      { type: 'text', text: documents, cache_control: { type: 'ephemeral' } },
    ],
    messages: [...messages.slice(0, -1), { role: 'user', content: last.slice(cut + 2) }],
  };
}

async function ask(question) {
  question = (question || '').trim();
  if (!question || chat.asking) return;
  storeKey();
  if (!readKey()) {
    showStatus('Add your Anthropic API key on the left, then press send.', true);
    $('question').value = question; // keep the question so it isn't lost
    autoGrow();
    $('api-key').focus();
    return;
  }
  chat.asking = true;
  $('send').disabled = true;
  hideStatus();
  showThread();
  const log = $('chat-log');
  const thread = $('chat-thread');
  thread.append(el('div', { class: 'msg-user', text: question }));
  $('question').value = '';
  autoGrow();
  const live = el('div', { class: 'answer' }, el('span', { class: 'typing', text: 'Reading the handbook and master data' }));
  const bubble = botBubble(live);
  thread.append(bubble);
  bubble.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

  try {
    await loadKnowledgeBase();
    const history = chat.history.slice(-2 * settings.history_turns);
    const hits = kb.full ? kb.chunks.map((chunk) => ({ chunk, score: 1 }))
      : kb.index.search(await engine.queryVector(question, history), settings);
    const { system, messages } = buildRequest(question, hits, history);
    let text = '';
    const result = await engine.streamAnswer({
      apiKey: readKey(), workspaceId: readWorkspace(), model: model(), system, messages, settings,
      tools: [engine.CHART_TOOL, engine.CALC_TOOL, engine.NOT_FOUND_TOOL],
      onCalculate: (input) => charts.computeTable(input, kb.files),
    }, (delta) => {
      text += delta;
      live.classList.add('streaming');
      live.textContent = text;
      log.scrollTop = log.scrollHeight;
    });
    const rec = toRecord(text, hits, result);
    bubble.replaceWith(renderRecord(rec));
    chat.history.push({ role: 'user', content: question }, { role: 'assistant', content: historyEntry(rec, text) });
    chat.history = chat.history.slice(-20);
    chat.asked += 1;
    $('chat-bar-title').textContent = `Conversation · ${plural(chat.asked, 'question')}`;
  } catch (e) {
    live.classList.remove('streaming');
    live.replaceChildren(el('p', { class: 'error', text: e.message || 'Something went wrong.' }),
      el('button', { type: 'button', class: 'btn-link', text: 'Try again', onclick: () => { bubble.previousSibling.remove(); bubble.remove(); ask(question); } }));
    if (e.code === 'invalid_api_key') $('api-key').focus();
    if (e.code === 'needs_workspace' || e.code === 'bad_workspace') document.querySelector('.ws').open = true;
  } finally {
    chat.asking = false;
    $('send').disabled = false;
  }
}

function toRecord(text, hits, { notes, chart, calcs, usage, stopReason, notFound }) {
  const id = ++chat.count;
  const meta = { model: model(), mode: kb.full ? 'Both documents in full' : 'Best-matching passages', excerpts: hits.length,
    calculations: calcs.length, tokensIn: usage.input, tokensOut: usage.output, stopReason, reply: text };
  const tables = calcs.filter((c) => c.ok).map((c) => c.table);
  const source = (n) => ({ n, chunk: hits[n - 1].chunk, score: hits[n - 1].score });
  const cited = [...new Set([...text.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])))].filter((n) => n >= 1 && n <= hits.length).sort((a, b) => a - b);
  if (chart) {
    const prepared = charts.prepareChart(chart, kb.files, hits, engine.sourceLabel);
    if (prepared.ok) {
      const refs = [...new Set(prepared.chart.series.flatMap((s) => s.refs || []))];
      return { kind: 'chart', id, text, notes, tables, meta, chart: prepared.chart, status: 'proposed',
        sources: [...new Set([...cited, ...refs])].sort((a, b) => a - b).map(source) };
    }
    notes.push(`I couldn’t prepare that chart: ${prepared.error}. Try naming the sheet and column.`);
  }
  if (notFound || (engine.isNotFound(text) && !tables.length)) {
    return { kind: 'notfound', id, meta, missing: notFound && notFound.missing ? String(notFound.missing) : '',
      checks: notFound && Array.isArray(notFound.checks) ? notFound.checks.filter((c) => c && c.document) : [] };
  }
  const shown = cited.length || kb.full ? cited : hits.map((_, i) => i + 1);
  return { kind: 'answer', id, text, notes, tables, meta, sources: shown.map(source) };
}

function historyEntry(rec, text) {
  if (rec.kind === 'chart') return `${text.trim()}\n[Proposed a ${rec.chart.type} chart “${rec.chart.title}”; waiting for the user to confirm.]`;
  return rec.kind === 'notfound' ? engine.NOT_FOUND : text.trim() || '(answer)';
}

function renderRecord(rec) {
  if (rec.kind === 'notfound') {
    const body = [el('div', { class: 'answer' }, el('p', {}, el('strong', { text: 'I couldn’t find this in the handbook or the master data.' }),
      rec.missing ? el('br') : null, rec.missing ? el('span', { class: 'qa-help', text: rec.missing }) : null))];
    if (rec.checks.length) {
      body.push(el('details', { class: 'qa-calc' }, el('summary', { text: 'How I checked' }), el('div', { class: 'qa-table-wrap' }, el('table', { class: 'qa-table' },
        el('tbody', {}, rec.checks.map((c) => el('tr', {}, el('th', { text: String(c.document) }), el('td', { text: String(c.reason || '') }))))))));
    }
    const b = botBubble(...body, meta(rec));
    b.querySelector('.msg-bot-body').classList.add('notfound');
    return b;
  }
  const count = rec.sources.length ? Math.max(...rec.sources.map((s) => s.n)) : 0;
  return botBubble(
    rec.text && rec.text.trim() ? el('div', { class: 'answer' }, formatAnswer(rec.text, rec.id, count)) : null,
    (rec.notes || []).filter((n) => !/whole-documents|temperature/.test(n)).map((n) => el('p', { class: 'note' }, icon('info'), n)),
    rec.kind === 'chart' ? chartBlock(rec) : null,
    rec.tables.length ? calcTables(rec.tables) : null,
    rec.sources.length ? sources(rec.sources, rec.id) : null,
    meta(rec));
}

function meta(rec) {
  const m = rec.meta;
  const rows = [['Model', m.model], ['Read', `${m.mode} (${plural(m.excerpts, 'excerpt')})`],
    ['Calculations', m.calculations ? `${m.calculations} run by the page` : 'None'],
    ['Tokens', `${(m.tokensIn || 0).toLocaleString()} in · ${(m.tokensOut || 0).toLocaleString()} out`], ['Finished because', m.stopReason || '-']];
  return el('details', { class: 'qa-meta' }, el('summary', { text: 'About this answer' }),
    el('table', { class: 'qa-table qa-table-settings' }, el('tbody', {}, rows.map(([k, v]) => el('tr', {}, el('th', { text: k }), el('td', { text: v }))))),
    el('pre', { class: 'qa-raw', text: m.reply || '(no text)' }));
}

function calcTables(tables) {
  const d = el('details', { class: 'qa-calc' }, el('summary', { text: `Exact figures calculated by the page (${tables.length})` }));
  for (const t of tables) { const { settings: s, data: rows } = charts.renderTables(t, { limit: 100 }); d.append(s, rows); }
  return d;
}

function chartBlock(rec) {
  const box = el('div', { class: 'qa-chart-block' });
  const { settings: s, data: rows } = charts.renderTables(rec.chart);
  const redraw = () => box.replaceWith(chartBlock(rec));
  if (rec.status === 'proposed') {
    box.append(el('p', { class: 'qa-chart-ask' }, el('strong', { text: 'Here’s what I’d plot. ' }), 'Check the data, then confirm.'), s, rows,
      el('div', { class: 'qa-row qa-chart-confirm' },
        el('button', { type: 'button', class: 'btn btn-primary btn-sm', onclick: () => { rec.status = 'plotted'; redraw(); } }, 'Plot chart'),
        el('button', { type: 'button', class: 'btn btn-outline btn-sm', onclick: () => { rec.status = 'cancelled'; redraw(); } }, 'Cancel')));
  } else if (rec.status === 'plotted') {
    box.append(charts.renderChart(rec.chart), el('details', { class: 'qa-chart-data' }, el('summary', { text: 'Show data table' }), s, rows));
  } else box.append(el('p', { class: 'qa-help', text: `Chart “${rec.chart.title}” cancelled.` }));
  return box;
}

/** Safe minimal formatting: paragraphs, bullets, Markdown tables, **bold**, and [n] citation chips. */
function formatAnswer(text, msgId, sourceCount) {
  const inline = (line) => {
    const out = [];
    const re = /\*\*(.+?)\*\*|\[(\d+)\]/g;
    let last = 0;
    let m;
    while ((m = re.exec(line))) {
      if (m.index > last) out.push(line.slice(last, m.index));
      if (m[1]) out.push(el('strong', { text: m[1] }));
      else if (Number(m[2]) >= 1 && Number(m[2]) <= sourceCount) out.push(el('a', { class: 'cite', href: `#src-${msgId}-${m[2]}`, text: m[2], 'aria-label': `Source ${m[2]}`, onclick: jumpToSource }));
      else out.push(m[0]);
      last = re.lastIndex;
    }
    if (last < line.length) out.push(line.slice(last));
    return out;
  };
  const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  const isRule = (line) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line);
  return text.trim().split(/\n\s*\n/).flatMap((para) => {
    const lines = para.split('\n');
    const ruleAt = lines.findIndex((l, i) => i > 0 && isRule(l) && lines[i - 1].includes('|'));
    if (ruleAt > 0) {
      const head = cells(lines[ruleAt - 1]);
      const rows = lines.slice(ruleAt + 1).filter((l) => l.includes('|')).map(cells);
      const before = lines.slice(0, ruleAt - 1).join('\n').trim();
      const table = el('div', { class: 'qa-table-wrap qa-answer-table' }, el('table', { class: 'qa-table' },
        el('thead', {}, el('tr', {}, head.map((c) => el('th', {}, inline(c))))),
        el('tbody', {}, rows.map((r) => el('tr', {}, head.map((_, i) => el('td', {}, inline(r[i] || ''))))))));
      return before ? [el('p', {}, ...inline(before)), table] : [table];
    }
    if (lines.every((l) => /^\s*([-*•]|\d+\.)\s+/.test(l))) return el('ul', {}, lines.map((l) => el('li', {}, inline(l.replace(/^\s*([-*•]|\d+\.)\s+/, '')))));
    const p = el('p');
    lines.forEach((l, i) => { if (i) p.append(el('br')); p.append(...inline(l.replace(/^#{1,4}\s+/, ''))); });
    return p;
  });
}

// Citation links must not trigger the hash router, so scroll to the source by hand.
function jumpToSource(e) {
  e.preventDefault();
  const target = document.getElementById(e.currentTarget.getAttribute('href').slice(1));
  if (!target) return;
  const list = target.closest('ol');
  if (list && list.hidden) list.previousSibling.click();
  target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  target.animate([{ background: 'var(--orange-soft)' }, { background: 'transparent' }], { duration: 1600 });
}

function where(c) {
  if (c.sheet != null) return `sheet “${c.sheet}” · ${c.rowStart === c.rowEnd ? `row ${c.rowStart}` : `rows ${c.rowStart}–${c.rowEnd}`}`;
  if (c.page) return `page ${c.page}`;
  return '';
}

function sources(list, msgId) {
  const ol = el('ol', { hidden: true }, list.map(({ n, chunk, score }) => el('li', { id: `src-${msgId}-${n}` },
    el('span', { class: 'cite', text: String(n) }),
    el('div', {}, el('div', { class: 'where' }, chunk.fileName, where(chunk) ? ` · ${where(chunk)}` : '',
      kb.full ? null : el('span', { class: 'score', text: ` · match ${score.toFixed(2)}` })),
    el('blockquote', { text: chunk.text })))));
  const toggle = el('button', { type: 'button', class: 'btn-link', 'aria-expanded': 'false',
    onclick: () => { ol.hidden = !ol.hidden; toggle.setAttribute('aria-expanded', String(!ol.hidden)); } },
  `Sources (${list.length})`, icon('down', 'chev-sm'));
  return el('div', { class: 'sources' }, toggle, ol);
}

/** The conversation view: messages, with a bar to go back to the suggested questions or start over. */
function showThread() {
  $('chat-welcome').hidden = true;
  $('chat-thread').hidden = false;
  $('chat-bar').hidden = false;
  $('chat-bar-title').textContent = chat.asked ? `Conversation · ${plural(chat.asked, 'question')}` : 'Conversation';
  $('chat-log').scrollTop = $('chat-log').scrollHeight;
}

/** Back to the start screen. The conversation is kept, and can be resumed or continued. */
function showStart() {
  const has = $('chat-thread').children.length > 0;
  $('chat-thread').hidden = true;
  $('chat-bar').hidden = true;
  $('chat-welcome').hidden = false;
  $('resume-chat').hidden = !has;
  $('resume-count').textContent = has ? `${plural(chat.asked, 'question')} so far · new questions continue it` : '';
  $('chat-log').scrollTop = 0;
}

function autoGrow() {
  const t = $('question');
  t.style.height = 'auto';
  t.style.height = `${Math.min(t.scrollHeight, 180)}px`;
}

function wireChat() {
  $('composer').addEventListener('submit', (e) => { e.preventDefault(); ask($('question').value); });
  $('question').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); ask($('question').value); }
  });
  $('question').addEventListener('input', autoGrow);
  $('chat-back').addEventListener('click', showStart);
  $('resume-chat').addEventListener('click', showThread);
  $('new-chat').addEventListener('click', () => {
    if (chat.asking) return;
    chat.history = [];
    chat.asked = 0;
    $('chat-thread').replaceChildren();
    showStart();
  });
}

// ================================================================== start

function wireChrome() {
  const toggle = $('nav-toggle');
  toggle.addEventListener('click', () => {
    const open = $('primary-nav').classList.toggle('is-open');
    toggle.setAttribute('aria-expanded', String(open));
  });
  const head = $('masthead');
  addEventListener('scroll', () => head.classList.toggle('is-scrolled', scrollY > 10), { passive: true });
}

async function start() {
  wireChrome();
  heroCarousel();
  wireKey();
  wireChat();
  try {
    data = await (await fetch('site-data.json')).json();
  } catch (e) {
    document.querySelector('main').prepend(el('p', { class: 'chat-status is-error', text: 'Couldn’t load site-data.json. Serve this folder over HTTP (python3 -m http.server) rather than opening the file directly.' }));
    return;
  }
  renderHome();
  renderStructure();
  renderCurriculum();
  renderFaculty();
  renderStudents();
  renderStarters();
  addEventListener('hashchange', route);
  route();
}

start();
