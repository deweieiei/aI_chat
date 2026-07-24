// ===== AI ส่วนตัว: เว็บเซิร์ฟเวอร์ (ไม่ต้องลง dependency) =====
// รันด้วย:  node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const PROFILES = path.join(ROOT, 'profiles');
const OLLAMA = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const PORT = process.env.PORT || 3005;

fs.mkdirSync(PROFILES, { recursive: true });

// ---------- session (เก็บในหน่วยความจำ พอสำหรับใช้ในบ้าน) ----------
const sessions = new Map(); // token -> profileName

// ---------- helper: รหัสผ่าน ----------
function hashPassword(pw, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(pw, salt, hash) {
  const h = crypto.scryptSync(pw, salt, 64).toString('hex');
  const a = Buffer.from(h), b = Buffer.from(hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- helper: โปรไฟล์ + ความทรงจำ ----------
function safeName(name) {
  return String(name || '').replace(/[^a-zA-Z0-9ก-๙_\- ]/g, '').trim().slice(0, 40);
}
// สำหรับชื่อไฟล์ความทรงจำ: อนุญาตจุด แต่กัน path traversal (/ \ ..)
function safeFile(name) {
  return String(name || '').replace(/[\/\\]/g, '').replace(/\.\./g, '')
    .replace(/[^a-zA-Z0-9ก-๙_\-. ]/g, '').trim().slice(0, 60);
}
const profileDir  = n => path.join(PROFILES, n);
const memoryDir   = n => path.join(profileDir(n), 'memory');
const settingsPath= n => path.join(profileDir(n), 'settings.json');

function readSettings(n) { return JSON.parse(fs.readFileSync(settingsPath(n), 'utf8')); }
function writeSettings(n, s) { fs.writeFileSync(settingsPath(n), JSON.stringify(s, null, 2), 'utf8'); }

function listProfiles() {
  if (!fs.existsSync(PROFILES)) return [];
  return fs.readdirSync(PROFILES).filter(n => fs.existsSync(settingsPath(n)));
}

// อ่านไฟล์ความทรงจำทั้งหมดในโฟลเดอร์ของโปรไฟล์ มารวมเป็นข้อความเดียว
function loadMemory(n) {
  const dir = memoryDir(n);
  if (!fs.existsSync(dir)) return '';
  const files = fs.readdirSync(dir).filter(f => /\.(md|txt)$/i.test(f)).sort();
  let out = '';
  for (const f of files) {
    const c = fs.readFileSync(path.join(dir, f), 'utf8').trim();
    if (c) out += `\n### ${f}\n${c}\n`;
  }
  return out.trim();
}

// จดความทรงจำใหม่ต่อท้ายไฟล์ notes.md
function jotMemory(n, text) {
  const dir = memoryDir(n);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  fs.appendFileSync(path.join(dir, 'notes.md'), `- (${stamp}) ${text.trim()}\n`, 'utf8');
}

// ---------- helper: ห้องแชต (แต่ละโปรไฟล์มีหลายแชต) ----------
const chatsDir = n => path.join(profileDir(n), 'chats');
function listChats(n) {
  const dir = chatsDir(n);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => {
    const c = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    return { id: c.id, title: c.title, useMemory: c.useMemory, updatedAt: c.updatedAt, count: (c.messages || []).length };
  }).sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}
function readChat(n, id) {
  const f = path.join(chatsDir(n), safeFile(id) + '.json');
  if (!f.startsWith(chatsDir(n)) || !fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}
function writeChat(n, c) {
  fs.mkdirSync(chatsDir(n), { recursive: true });
  c.updatedAt = new Date().toISOString();
  fs.writeFileSync(path.join(chatsDir(n), safeFile(c.id) + '.json'), JSON.stringify(c, null, 2), 'utf8');
}
function deleteChat(n, id) {
  const f = path.join(chatsDir(n), safeFile(id) + '.json');
  if (f.startsWith(chatsDir(n)) && fs.existsSync(f)) { fs.unlinkSync(f); return true; }
  return false;
}
function newChatId() { return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

// ---------- helper: HTTP ----------
function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', c => d += c);
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } });
  });
}
function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}
function authProfile(req) {
  const auth = req.headers['authorization'] || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  return sessions.get(token) || null;
}

const MIME = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8',
  '.js':'text/javascript; charset=utf-8', '.json':'application/json; charset=utf-8',
  '.svg':'image/svg+xml', '.ico':'image/x-icon' };

function serveStatic(res, urlPath) {
  let rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\//, '');
  if (rel === 'chat') rel = 'chat.html';
  if (rel === 'settings') rel = 'settings.html';
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('Not found'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

// ---------- เรียก Ollama ----------
async function ollamaChat({ model, messages, num_ctx }) {
  const r = await fetch(OLLAMA + '/api/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: false, think: false, options: { num_ctx } })
  });
  if (!r.ok) throw new Error('Ollama ' + r.status + ': ' + (await r.text()));
  const data = await r.json();
  return data.message ? data.message.content : '';
}

// ---------- โหลดโมเดล (pull) พร้อมติดตามความคืบหน้า ----------
const pullStatus = new Map(); // name -> { percent, status, done, error }
async function pullModel(name) {
  pullStatus.set(name, { percent: 0, status: 'กำลังเริ่ม...', done: false });
  try {
    const r = await fetch(OLLAMA + '/api/pull', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: name, stream: true })
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try {
          const j = JSON.parse(line);
          if (j.error) { pullStatus.set(name, { percent: 0, status: j.error, done: true, error: true }); return; }
          const percent = (j.total && j.completed) ? Math.round(j.completed / j.total * 100) : (pullStatus.get(name)?.percent || 0);
          pullStatus.set(name, { percent, status: j.status || '', done: false });
        } catch { /* บรรทัดไม่สมบูรณ์ ข้าม */ }
      }
    }
    pullStatus.set(name, { percent: 100, status: 'เสร็จแล้ว', done: true });
  } catch (e) {
    pullStatus.set(name, { percent: 0, status: 'ผิดพลาด: ' + e.message, done: true, error: true });
  }
}

// ประมาณจำนวน token แบบเร็ว (คำนวณในเครื่องทันที ไม่ต้องเรียกโมเดล — สำคัญมากบน CPU)
// ไทย tokenizer ซอยละเอียด ~1 token/2 อักขระ, อังกฤษ/อื่นๆ ~1 token/4 อักขระ
function estimateTokens(text) {
  if (!text) return 0;
  const thai = (text.match(/[฀-๿]/g) || []).length;
  const rest = text.length - thai;
  return Math.round(thai / 2 + rest / 4);
}

// =================== ROUTER ===================
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  try {
    // ---- API ----
    if (p.startsWith('/api/')) {

      // รายชื่อโปรไฟล์ (ไม่ส่งรหัสผ่าน)
      if (p === '/api/profiles' && req.method === 'GET') {
        const list = listProfiles().map(n => ({ name: n, displayName: readSettings(n).displayName || n }));
        return sendJSON(res, 200, { profiles: list });
      }

      // สร้างโปรไฟล์ใหม่
      if (p === '/api/profiles' && req.method === 'POST') {
        const { name, password } = await readBody(req);
        const clean = safeName(name);
        if (!clean) return sendJSON(res, 400, { error: 'ชื่อไม่ถูกต้อง' });
        if (!password || password.length < 4) return sendJSON(res, 400, { error: 'รหัสผ่านต้องยาวอย่างน้อย 4 ตัว' });
        if (fs.existsSync(profileDir(clean))) return sendJSON(res, 409, { error: 'มีโปรไฟล์นี้อยู่แล้ว' });
        fs.mkdirSync(memoryDir(clean), { recursive: true });
        writeSettings(clean, {
          displayName: clean,
          password: hashPassword(password),
          model: 'qwen3:8b',
          num_ctx: 4096,
          systemPrompt: 'คุณเป็นผู้ช่วย AI ส่วนตัว ตอบเป็นภาษาไทยเสมอ พูดสุภาพ เป็นกันเอง และกระชับ'
        });
        // ไฟล์ความทรงจำเริ่มต้น
        fs.writeFileSync(path.join(memoryDir(clean), 'notes.md'),
          `# สมุดความทรงจำของ ${clean}\n\n`, 'utf8');
        return sendJSON(res, 200, { ok: true, name: clean });
      }

      // เข้าสู่ระบบ
      if (p === '/api/login' && req.method === 'POST') {
        const { name, password } = await readBody(req);
        const clean = safeName(name);
        if (!fs.existsSync(settingsPath(clean))) return sendJSON(res, 404, { error: 'ไม่พบโปรไฟล์' });
        const s = readSettings(clean);
        if (!verifyPassword(password, s.password.salt, s.password.hash))
          return sendJSON(res, 401, { error: 'รหัสผ่านไม่ถูกต้อง' });
        const token = crypto.randomBytes(24).toString('hex');
        sessions.set(token, clean);
        return sendJSON(res, 200, { token, name: clean, displayName: s.displayName });
      }

      // ===== ต่อไปนี้ต้องล็อกอิน =====
      const me = authProfile(req);
      if (!me) return sendJSON(res, 401, { error: 'กรุณาเข้าสู่ระบบ' });

      // รายชื่อโมเดลจาก Ollama
      if (p === '/api/models' && req.method === 'GET') {
        try {
          const r = await fetch(OLLAMA + '/api/tags');
          const d = await r.json();
          const models = (d.models || []).map(m => ({ name: m.name, size: m.size || 0 }));
          return sendJSON(res, 200, { models });
        } catch {
          return sendJSON(res, 200, { models: [] });
        }
      }
      // เริ่มโหลดโมเดลใหม่ (ทำเบื้องหลัง แล้วให้ frontend ถามความคืบหน้า)
      if (p === '/api/models/pull' && req.method === 'POST') {
        const b = await readBody(req);
        const n = String(b.name || '').trim();
        if (!/^[a-zA-Z0-9._:\/-]{1,80}$/.test(n)) return sendJSON(res, 400, { error: 'ชื่อโมเดลไม่ถูกต้อง' });
        const cur = pullStatus.get(n);
        if (!cur || cur.done) pullModel(n);   // ไม่ await — คืนค่าทันที
        return sendJSON(res, 200, { ok: true });
      }
      // ถามความคืบหน้าการโหลด
      if (p === '/api/models/pull-status' && req.method === 'GET') {
        const n = String(url.searchParams.get('name') || '').trim();
        return sendJSON(res, 200, pullStatus.get(n) || { done: true, percent: 100, status: '' });
      }
      // ลบโมเดล
      if (p === '/api/models/delete' && req.method === 'POST') {
        const b = await readBody(req);
        const n = String(b.name || '').trim();
        if (!n) return sendJSON(res, 400, { error: 'ไม่ระบุชื่อโมเดล' });
        const r = await fetch(OLLAMA + '/api/delete', {
          method: 'DELETE', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: n })
        });
        if (!r.ok) return sendJSON(res, 500, { error: 'ลบไม่สำเร็จ (' + r.status + ')' });
        pullStatus.delete(n);
        return sendJSON(res, 200, { ok: true });
      }

      // อ่าน/บันทึกการตั้งค่า
      if (p === '/api/settings' && req.method === 'GET') {
        const s = readSettings(me);
        return sendJSON(res, 200, { displayName: s.displayName, model: s.model, num_ctx: s.num_ctx, systemPrompt: s.systemPrompt });
      }
      if (p === '/api/settings' && req.method === 'POST') {
        const b = await readBody(req);
        const s = readSettings(me);
        if (b.model) s.model = String(b.model);
        if (b.num_ctx) s.num_ctx = Math.max(1024, Math.min(40960, parseInt(b.num_ctx) || 4096));
        if (typeof b.systemPrompt === 'string') s.systemPrompt = b.systemPrompt;
        writeSettings(me, s);
        return sendJSON(res, 200, { ok: true });
      }

      // จัดการไฟล์ความทรงจำ
      if (p === '/api/memory' && req.method === 'GET') {
        const dir = memoryDir(me);
        const s = readSettings(me);
        const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /\.(md|txt)$/i.test(f)) : [];
        const info = [];
        let totalTokens = 0;
        for (const f of files) {
          const full = path.join(dir, f);
          const content = fs.readFileSync(full, 'utf8');
          const tokens = estimateTokens(content);
          totalTokens += tokens;
          info.push({ name: f, size: fs.statSync(full).size, tokens });
        }
        return sendJSON(res, 200, { files: info, totalTokens, num_ctx: s.num_ctx });
      }
      if (p === '/api/memory/file' && req.method === 'GET') {
        const f = safeFile(url.searchParams.get('name'));
        const file = path.join(memoryDir(me), f);
        if (!file.startsWith(memoryDir(me)) || !fs.existsSync(file)) return sendJSON(res, 404, { error: 'ไม่พบไฟล์' });
        return sendJSON(res, 200, { name: f, content: fs.readFileSync(file, 'utf8') });
      }
      if (p === '/api/memory/file' && req.method === 'POST') { // แก้ไข/บันทึกเนื้อหา
        const { name, content } = await readBody(req);
        const f = safeFile(name);
        if (!f) return sendJSON(res, 400, { error: 'ชื่อไฟล์ไม่ถูกต้อง' });
        fs.mkdirSync(memoryDir(me), { recursive: true });
        const file = path.join(memoryDir(me), /\.(md|txt)$/i.test(f) ? f : f + '.md');
        if (!file.startsWith(memoryDir(me))) return sendJSON(res, 400, { error: 'path ไม่ถูกต้อง' });
        fs.writeFileSync(file, String(content || ''), 'utf8');
        return sendJSON(res, 200, { ok: true });
      }
      if (p === '/api/memory/file' && req.method === 'DELETE') {
        const f = safeFile(url.searchParams.get('name'));
        const file = path.join(memoryDir(me), f);
        if (!file.startsWith(memoryDir(me)) || !fs.existsSync(file)) return sendJSON(res, 404, { error: 'ไม่พบไฟล์' });
        fs.unlinkSync(file);
        return sendJSON(res, 200, { ok: true });
      }

      // ===== ห้องแชต =====
      if (p === '/api/chats' && req.method === 'GET') {
        return sendJSON(res, 200, { chats: listChats(me) });
      }
      if (p === '/api/chats' && req.method === 'POST') {   // สร้างแชตใหม่
        const b = await readBody(req);
        const chat = { id: newChatId(), title: 'แชตใหม่', useMemory: b.useMemory !== false, messages: [], createdAt: new Date().toISOString() };
        writeChat(me, chat);
        return sendJSON(res, 200, { chat });
      }
      if (p === '/api/chats/get' && req.method === 'GET') {
        const c = readChat(me, url.searchParams.get('id'));
        if (!c) return sendJSON(res, 404, { error: 'ไม่พบแชต' });
        return sendJSON(res, 200, { chat: c });
      }
      if (p === '/api/chats/update' && req.method === 'POST') {  // เปลี่ยนชื่อ / สลับอ่านความทรงจำ
        const b = await readBody(req);
        const c = readChat(me, b.id);
        if (!c) return sendJSON(res, 404, { error: 'ไม่พบแชต' });
        if (typeof b.title === 'string') c.title = b.title.slice(0, 60);
        if (typeof b.useMemory === 'boolean') c.useMemory = b.useMemory;
        writeChat(me, c);
        return sendJSON(res, 200, { ok: true });
      }
      if (p === '/api/chats/delete' && req.method === 'POST') {
        const b = await readBody(req);
        deleteChat(me, b.id);
        return sendJSON(res, 200, { ok: true });
      }

      // แชท: ส่งข้อความในห้องแชตหนึ่งๆ (เก็บประวัติฝั่งเซิร์ฟเวอร์)
      if (p === '/api/chat' && req.method === 'POST') {
        const { chatId, content } = await readBody(req);
        const chat = readChat(me, chatId);
        if (!chat) return sendJSON(res, 404, { error: 'ไม่พบแชต' });
        if (!content || !String(content).trim()) return sendJSON(res, 400, { error: 'ข้อความว่าง' });
        chat.messages.push({ role: 'user', content: String(content) });

        const s = readSettings(me);
        const useMem = chat.useMemory !== false;
        const memory = useMem ? loadMemory(me) : '';
        const sys = useMem
          ? [
              s.systemPrompt,
              memory ? `\n# ความทรงจำเกี่ยวกับผู้ใช้ (จากสมุดบันทึกส่วนตัว)\n${memory}` : '',
              `\n# วิธีจดความทรงจำ\nตอบคำถามผู้ใช้ตามปกติเสมอ (ต้องมีข้อความตอบทุกครั้ง ห้ามตอบว่างเปล่า) จากนั้น ถ้าผู้ใช้บอกข้อมูลสำคัญที่ควรจำระยะยาว (ชื่อ ความชอบ เป้าหมาย เรื่องส่วนตัว) ให้เพิ่มบรรทัดรูปแบบ [[JOT: ข้อความที่ต้องจำ]] ต่อท้ายคำตอบ ระบบจะบันทึกลงสมุดให้เอง ผู้ใช้จะไม่เห็นบรรทัดนี้ อย่าจดเรื่องทั่วไปที่ไม่สำคัญ`
            ].join('\n')
          : s.systemPrompt;  // ไม่อ่านความทรงจำ = ประหยัด token

        let reply = await ollamaChat({
          model: s.model, num_ctx: s.num_ctx,
          messages: [{ role: 'system', content: sys }, ...chat.messages]
        });

        reply = reply.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<\/?think>/gi, '');
        let jots = [];
        if (useMem) {   // จดความทรงจำเฉพาะแชตที่เปิดใช้สมุด
          jots = [...reply.matchAll(/\[\[JOT:\s*([^\]]+)\]\]/gi)].map(m => m[1]);
          jots.forEach(t => jotMemory(me, t));
        }
        reply = reply.replace(/\[\[JOT:[^\]]*\]\]/gi, '').trim();
        if (!reply) reply = jots.length ? 'รับทราบครับ จดใส่สมุดความทรงจำให้แล้ว ✅' : '(ไม่มีคำตอบ ลองพิมพ์ใหม่อีกครั้งครับ)';

        chat.messages.push({ role: 'assistant', content: reply });
        // ตั้งชื่อแชตอัตโนมัติจากข้อความแรก
        if (chat.title === 'แชตใหม่') chat.title = String(content).replace(/\s+/g, ' ').trim().slice(0, 30);
        writeChat(me, chat);

        return sendJSON(res, 200, { reply, jotted: jots.length });
      }

      return sendJSON(res, 404, { error: 'ไม่พบ API นี้' });
    }

    // ---- ไฟล์หน้าเว็บ ----
    return serveStatic(res, p);

  } catch (e) {
    console.error(e);
    return sendJSON(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, () => {
  console.log(`\n  ✅ AI ส่วนตัวพร้อมใช้งาน`);
  console.log(`  🌐 เปิดเบราว์เซอร์ที่:  http://localhost:${PORT}`);
  console.log(`  📂 โปรไฟล์เก็บที่:      ${PROFILES}`);
  console.log(`  🤖 Ollama:            ${OLLAMA}\n`);
});
