const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const multer = require('multer');
const crypto = require('crypto');

// 파일 업로드 설정 (메모리 저장, 최대 20MB) - PDF 및 이미지 모두 허용
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf' ||
        file.originalname.toLowerCase().endsWith('.pdf') ||
        file.mimetype.startsWith('image/') ||
        /\.(jpg|jpeg|png|gif|bmp|webp|tiff?)$/i.test(file.originalname)) {
      cb(null, true);
    } else {
      cb(new Error('PDF 또는 이미지 파일만 업로드 가능합니다'));
    }
  }
});

const app = express();
const PORT = 8787;

// ── DB 경로: Render Persistent Disk → /var/data/, 로컬은 __dirname ──
// Render에서 Persistent Disk를 /var/data 마운트포인트로 설정하면 재배포 후에도 유지됨
const DATA_DIR = process.env.DATA_DIR ||
  (fs.existsSync('/var/data') ? '/var/data' : __dirname);
const DB_PATH = path.join(DATA_DIR, 'elevator.db');
console.log(`📁 DB 경로: ${DB_PATH}`);

app.use(cors());
app.use(express.json());

// ── DB 초기화 ─────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');

// 스키마 생성
db.exec(`
CREATE TABLE IF NOT EXISTS sites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_code TEXT UNIQUE NOT NULL,
  site_name TEXT NOT NULL,
  address TEXT NOT NULL,
  owner_name TEXT,
  owner_phone TEXT,
  manager_name TEXT,
  team TEXT DEFAULT '',
  total_elevators INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active' CHECK(status IN ('active','inactive','suspended')),
  contract_start DATE,
  contract_end DATE,
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS elevators (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER NOT NULL,
  elevator_no TEXT NOT NULL,
  elevator_name TEXT,
  elevator_type TEXT DEFAULT '승객용',
  manufacturer TEXT,
  manufacture_year INTEGER,
  install_date DATE,
  floors_served TEXT,
  capacity INTEGER,
  load_capacity INTEGER,
  speed REAL,
  status TEXT DEFAULT 'normal' CHECK(status IN ('normal','warning','fault','stopped')),
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS inspections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  elevator_id INTEGER NOT NULL,
  site_id INTEGER NOT NULL,
  inspection_type TEXT NOT NULL,
  inspection_date DATE NOT NULL,
  next_inspection_date DATE,
  inspector_name TEXT,
  inspection_agency TEXT,
  result TEXT DEFAULT '합격',
  report_no TEXT,
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (elevator_id) REFERENCES elevators(id) ON DELETE CASCADE,
  FOREIGN KEY (site_id) REFERENCES sites(id)
);

CREATE TABLE IF NOT EXISTS inspection_issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  inspection_id INTEGER,
  elevator_id INTEGER NOT NULL,
  site_id INTEGER NOT NULL,
  issue_no INTEGER DEFAULT 1,
  issue_category TEXT,
  issue_description TEXT NOT NULL,
  legal_basis TEXT,
  severity TEXT DEFAULT '경결함',
  status TEXT DEFAULT '미조치',
  action_required TEXT,
  action_taken TEXT,
  action_date DATE,
  action_by TEXT,
  photo_before TEXT,
  photo_after TEXT,
  deadline DATE,
  inspection_date DATE,
  inspector_name TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (elevator_id) REFERENCES elevators(id),
  FOREIGN KEY (site_id) REFERENCES sites(id)
);

CREATE TABLE IF NOT EXISTS monthly_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  elevator_id INTEGER NOT NULL,
  site_id INTEGER NOT NULL,
  check_year INTEGER NOT NULL,
  check_month INTEGER NOT NULL,
  check_date DATE,
  checker_name TEXT,
  status TEXT DEFAULT '예정',
  door_check TEXT DEFAULT '양호',
  motor_check TEXT DEFAULT '양호',
  brake_check TEXT DEFAULT '양호',
  rope_check TEXT DEFAULT '양호',
  safety_device_check TEXT DEFAULT '양호',
  lighting_check TEXT DEFAULT '양호',
  emergency_check TEXT DEFAULT '양호',
  overall_result TEXT DEFAULT '양호',
  issues_found TEXT,
  actions_taken TEXT,
  next_action TEXT,
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (elevator_id) REFERENCES elevators(id) ON DELETE CASCADE,
  FOREIGN KEY (site_id) REFERENCES sites(id)
);

CREATE TABLE IF NOT EXISTS app_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  pin_hash TEXT NOT NULL,
  role TEXT DEFAULT 'user' CHECK(role IN ('admin','user')),
  is_active INTEGER DEFAULT 1,
  tab_permissions TEXT DEFAULT '',
  last_login DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS quarterly_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  elevator_id INTEGER NOT NULL,
  site_id INTEGER NOT NULL,
  check_year INTEGER NOT NULL,
  quarter INTEGER NOT NULL,
  check_date DATE,
  checker_name TEXT,
  status TEXT DEFAULT '예정',
  mechanical_room TEXT DEFAULT '양호',
  hoistway TEXT DEFAULT '양호',
  car_interior TEXT DEFAULT '양호',
  pit TEXT DEFAULT '양호',
  landing_doors TEXT DEFAULT '양호',
  safety_gear TEXT DEFAULT '양호',
  ropes_chains TEXT DEFAULT '양호',
  buffers TEXT DEFAULT '양호',
  electrical TEXT DEFAULT '양호',
  overall_score INTEGER,
  overall_result TEXT DEFAULT '양호',
  smart_diagnosis TEXT,
  vibration_data TEXT,
  noise_level REAL,
  speed_test REAL,
  issues_found TEXT,
  actions_taken TEXT,
  next_action TEXT,
  report_url TEXT,
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (elevator_id) REFERENCES elevators(id) ON DELETE CASCADE,
  FOREIGN KEY (site_id) REFERENCES sites(id)
);
`);

// ── DB 마이그레이션: team 컬럼 (강화 버전) ────────────────────
(function ensureTeamColumn() {
  try {
    const cols = db.prepare("PRAGMA table_info(sites)").all().map(c => c.name);
    if (!cols.includes('team')) {
      db.exec(`ALTER TABLE sites ADD COLUMN team TEXT DEFAULT ''`);
      console.log('✅ sites.team 컬럼 추가 완료');
    } else {
      console.log('ℹ️ sites.team 컬럼 이미 존재');
    }
  } catch(e) { console.log('team 컬럼 마이그레이션 오류:', e.message); }
})();

// 기존 데이터 team 빈값 처리
try {
  const empty = db.prepare("SELECT COUNT(*) as cnt FROM sites WHERE team='' OR team IS NULL").get();
  if (empty.cnt > 0) {
    db.prepare("UPDATE sites SET team='파주1팀' WHERE team='' OR team IS NULL").run();
    console.log(`✅ 기존 현장 ${empty.cnt}개 team='파주1팀' 기본값 설정 완료`);
  }
} catch(e) { console.log('팀 마이그레이션 오류(무시):', e.message); }

// ════════════════════════════════════════════════════════════════
// seed_data.json 기반 자동복구 (Render 재배포 후 데이터 복원)
// ════════════════════════════════════════════════════════════════

// seed_data.json 로드 (없으면 빈 배열)
const SEED_FILE = path.join(__dirname, 'seed_data.json');
let SEED_DATA = { sites: [], elevators: [] };
try {
  if (fs.existsSync(SEED_FILE)) {
    SEED_DATA = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
    console.log(`📦 seed_data.json 로드: 현장 ${SEED_DATA.sites.length}개, 승강기 ${SEED_DATA.elevators.length}개`);
  } else {
    console.log('⚠️  seed_data.json 없음 - 자동복구 건너뜀');
  }
} catch(e) {
  console.error('seed_data.json 로드 실패:', e.message);
}

// ── 사이트코드 생성 ───────────────────────────────────────────
function makeSiteCode(prefix) {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2,5).toUpperCase()}`;
}

// ── seed_data.json → DB 자동복원 ─────────────────────────────
// 규칙: site_name이 동일한 현장이 이미 있으면 절대 건드리지 않음
//       없는 현장만 추가 (사용자 추가/수정 데이터 100% 보호)
function autoRestoreFromSeed() {
  try {
    const insertSite = db.prepare(`
      INSERT INTO sites
        (site_code, site_name, address, owner_name, owner_phone, manager_name,
         team, total_elevators, status, contract_start, contract_end, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
    `);
    const insertElev = db.prepare(`
      INSERT INTO elevators
        (site_id, elevator_no, elevator_name, elevator_type,
         manufacturer, manufacture_year, install_date, floors_served,
         capacity, load_capacity, speed, status, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertInsp = db.prepare(`
      INSERT INTO inspections
        (elevator_id, site_id, inspection_type, inspection_date, next_inspection_date,
         inspector_name, inspection_agency, result, report_no, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertIssue = db.prepare(`
      INSERT INTO inspection_issues
        (inspection_id, issue_no, location, issue_content, action_required,
         action_deadline, status, resolved_date, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertMonthly = db.prepare(`
      INSERT INTO monthly_checks
        (site_id, elevator_id, check_year, check_month, check_date, checker_name, status, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const restoreTx = db.transaction(() => {
      let siteAdded = 0, elevAdded = 0, inspAdded = 0, issueAdded = 0, monthlyAdded = 0;

      // ① 현장 복원
      for (const s of SEED_DATA.sites || []) {
        if (!s.site_name) continue;
        const exists = db.prepare('SELECT id FROM sites WHERE site_name=?').get(s.site_name);
        if (exists) continue;

        const prefix = s.team === '파주2팀' ? 'P2' : 'P1';
        const code = makeSiteCode(prefix);
        const r = insertSite.run(
          code, s.site_name, s.address||'',
          s.owner_name||null, s.owner_phone||null, s.manager_name||null,
          s.team||'', s.total_elevators||0,
          s.contract_start||null, s.contract_end||null, s.notes||null
        );
        siteAdded++;

        const newSiteId = r.lastInsertRowid;
        const siteElevs = (SEED_DATA.elevators||[]).filter(e => e.site_name === s.site_name);
        for (const e of siteElevs) {
          const elevExists = db.prepare('SELECT id FROM elevators WHERE site_id=? AND elevator_no=?').get(newSiteId, e.elevator_no);
          if (elevExists) continue;
          insertElev.run(
            newSiteId, e.elevator_no, e.elevator_name||'',
            e.elevator_type||'승객용', e.manufacturer||null,
            e.manufacture_year||null, e.install_date||null, e.floors_served||null,
            e.capacity||null, e.load_capacity||null, e.speed||null,
            e.status||'normal', e.notes||null
          );
          elevAdded++;
        }
      }

      // ② 기존 현장의 누락된 승강기 복원
      for (const e of (SEED_DATA.elevators||[])) {
        if (!e.site_name || !e.elevator_no) continue;
        const site = db.prepare('SELECT id FROM sites WHERE site_name=?').get(e.site_name);
        if (!site) continue;
        const exists = db.prepare('SELECT id FROM elevators WHERE site_id=? AND elevator_no=?').get(site.id, e.elevator_no);
        if (exists) continue;
        insertElev.run(
          site.id, e.elevator_no, e.elevator_name||'',
          e.elevator_type||'승객용', e.manufacturer||null,
          e.manufacture_year||null, e.install_date||null, e.floors_served||null,
          e.capacity||null, e.load_capacity||null, e.speed||null,
          e.status||'normal', e.notes||null
        );
        elevAdded++;
      }

      // ③ 검사 데이터 복원
      for (const i of (SEED_DATA.inspections||[])) {
        if (!i.site_name || !i.inspection_date) continue;
        const site = db.prepare('SELECT id FROM sites WHERE site_name=?').get(i.site_name);
        if (!site) continue;
        const elev = i.elevator_no ? db.prepare('SELECT id FROM elevators WHERE site_id=? AND elevator_no=?').get(site.id, i.elevator_no) : null;
        if (!elev) continue;
        const exists = db.prepare('SELECT id FROM inspections WHERE elevator_id=? AND inspection_date=? AND inspection_type=?').get(elev.id, i.inspection_date, i.inspection_type);
        if (exists) continue;
        insertInsp.run(
          elev.id, site.id, i.inspection_type||'', i.inspection_date,
          i.next_inspection_date||null, i.inspector_name||null,
          i.inspection_agency||null, i.result||'합격', i.report_no||null, i.notes||null
        );
        inspAdded++;
      }

      // ④ 지적사항 복원
      for (const iss of (SEED_DATA.issues||[])) {
        if (!iss.site_name || !iss.inspection_date) continue;
        const site = db.prepare('SELECT id FROM sites WHERE site_name=?').get(iss.site_name);
        if (!site) continue;
        const elev = iss.elevator_no ? db.prepare('SELECT id FROM elevators WHERE site_id=? AND elevator_no=?').get(site.id, iss.elevator_no) : null;
        if (!elev) continue;
        const insp = db.prepare('SELECT id FROM inspections WHERE elevator_id=? AND inspection_date=?').get(elev.id, iss.inspection_date);
        if (!insp) continue;
        const exists = db.prepare('SELECT id FROM inspection_issues WHERE inspection_id=? AND issue_content=?').get(insp.id, iss.issue_content);
        if (exists) continue;
        insertIssue.run(
          insp.id, iss.issue_no||null, iss.location||null, iss.issue_content||null,
          iss.action_required||null, iss.action_deadline||null,
          iss.status||'미조치', iss.resolved_date||null, iss.notes||null
        );
        issueAdded++;
      }

      // ⑤ 월간점검 복원
      for (const m of (SEED_DATA.monthly||[])) {
        if (!m.site_name || !m.check_year || !m.check_month) continue;
        const site = db.prepare('SELECT id FROM sites WHERE site_name=?').get(m.site_name);
        if (!site) continue;
        const elev = m.elevator_no ? db.prepare('SELECT id FROM elevators WHERE site_id=? AND elevator_no=?').get(site.id, m.elevator_no) : null;
        if (!elev) continue;
        const exists = db.prepare('SELECT id FROM monthly_checks WHERE elevator_id=? AND check_year=? AND check_month=?').get(elev.id, m.check_year, m.check_month);
        if (exists) continue;
        insertMonthly.run(
          site.id, elev.id, m.check_year, m.check_month,
          m.check_date||null, m.checker_name||null, m.status||'예정', m.notes||null
        );
        monthlyAdded++;
      }

      return { siteAdded, elevAdded, inspAdded, issueAdded, monthlyAdded };
    });

    const result = restoreTx();
    const total = db.prepare('SELECT COUNT(*) as c FROM sites').get().c;
    const elevTotal = db.prepare('SELECT COUNT(*) as c FROM elevators').get().c;
    if (result.siteAdded > 0 || result.elevAdded > 0 || result.inspAdded > 0) {
      console.log(`✅ 자동복구: 현장+${result.siteAdded} 승강기+${result.elevAdded} 검사+${result.inspAdded} 지적+${result.issueAdded} 월간+${result.monthlyAdded}`);
    }
    console.log(`✅ 복구완료 → 현장: ${total}개, 승강기: ${elevTotal}대`);
  } catch(err) {
    console.error('❌ 자동복구 실패:', err.message);
  }
}

// ── seed_data.json 실시간 갱신 (현장/승강기/검사/지적사항 변경 시 호출) ──────
// DB 전체 데이터를 seed_data.json에 즉시 저장 → 다음 재배포 때 복원
function updateSeedFile() {
  try {
    const sites = db.prepare('SELECT * FROM sites').all();
    const elevators = db.prepare('SELECT * FROM elevators').all();
    const inspections = db.prepare('SELECT * FROM inspections').all();
    const issues = db.prepare('SELECT * FROM inspection_issues').all();
    const monthly = db.prepare('SELECT * FROM monthly_checks').all();

    const siteIdToName = {};
    for (const s of sites) siteIdToName[s.id] = s.site_name;
    const elevIdToNo = {};
    for (const e of elevators) elevIdToNo[e.id] = e.elevator_no;

    const sitesClean = sites.map(s => ({
      site_name: s.site_name,
      address: s.address||'',
      owner_name: s.owner_name||null,
      owner_phone: s.owner_phone||null,
      manager_name: s.manager_name||null,
      team: s.team||'',
      total_elevators: s.total_elevators||0,
      status: s.status||'active',
      contract_start: s.contract_start||null,
      contract_end: s.contract_end||null,
      notes: s.notes||null,
    }));

    const elevsClean = elevators.map(e => ({
      site_name: siteIdToName[e.site_id]||'',
      elevator_no: e.elevator_no||'',
      elevator_name: e.elevator_name||'',
      elevator_type: e.elevator_type||'승객용',
      manufacturer: e.manufacturer||null,
      manufacture_year: e.manufacture_year||null,
      install_date: e.install_date||null,
      floors_served: e.floors_served||null,
      capacity: e.capacity||null,
      load_capacity: e.load_capacity||null,
      speed: e.speed||null,
      status: e.status||'normal',
      notes: e.notes||null,
    })).filter(e => e.site_name);

    // 검사 데이터 (site_name, elevator_no로 매핑)
    const inspsClean = inspections.map(i => ({
      site_name: siteIdToName[i.site_id]||'',
      elevator_no: elevIdToNo[i.elevator_id]||'',
      inspection_type: i.inspection_type||'',
      inspection_date: i.inspection_date||null,
      next_inspection_date: i.next_inspection_date||null,
      inspector_name: i.inspector_name||null,
      inspection_agency: i.inspection_agency||null,
      result: i.result||'합격',
      report_no: i.report_no||null,
      notes: i.notes||null,
    })).filter(i => i.site_name);

    // 지적사항 데이터
    const issuesClean = issues.map(iss => {
      const insp = inspections.find(i => i.id === iss.inspection_id);
      return {
        site_name: insp ? (siteIdToName[insp.site_id]||'') : '',
        elevator_no: insp ? (elevIdToNo[insp.elevator_id]||'') : '',
        inspection_date: insp ? insp.inspection_date : null,
        issue_no: iss.issue_no||null,
        location: iss.location||null,
        issue_content: iss.issue_content||null,
        action_required: iss.action_required||null,
        action_deadline: iss.action_deadline||null,
        status: iss.status||'미조치',
        resolved_date: iss.resolved_date||null,
        notes: iss.notes||null,
      };
    }).filter(i => i.site_name);

    // 월간점검 데이터
    const monthlyClean = monthly.map(m => ({
      site_name: siteIdToName[m.site_id]||'',
      elevator_no: elevIdToNo[m.elevator_id]||'',
      check_year: m.check_year||null,
      check_month: m.check_month||null,
      check_date: m.check_date||null,
      checker_name: m.checker_name||null,
      status: m.status||'예정',
      notes: m.notes||null,
    })).filter(m => m.site_name);

    const seed = {
      version: '2.7.0',
      updated_at: new Date().toISOString(),
      sites: sitesClean,
      elevators: elevsClean,
      inspections: inspsClean,
      issues: issuesClean,
      monthly: monthlyClean,
    };
    fs.writeFileSync(SEED_FILE, JSON.stringify(seed, null, 2), 'utf8');
    SEED_DATA = seed; // 메모리도 갱신
    console.log(`💾 seed 저장: 현장${sitesClean.length} 승강기${elevsClean.length} 검사${inspsClean.length} 지적${issuesClean.length}`);
  } catch(e) {
    console.error('seed_data.json 갱신 실패:', e.message);
  }
}

// 서버 시작 시 자동복구 실행
autoRestoreFromSeed();


// ── 기본 관리자 계정 초기화 ──────────────────────────────────
function hashPin(pin) {
  return crypto.createHash('sha256').update(pin).digest('hex');
}

// 기본 사용자 목록 (서버 재시작 시 없으면 자동 생성)
const defaultUsers = [
  { name: '우경주', pin: '1234', role: 'admin' },
  { name: '강주은', pin: '1234', role: 'user' },
  { name: '권순흠', pin: '1234', role: 'user' },
  { name: '문활영', pin: '1234', role: 'user' },
];

// INSERT OR IGNORE: 기존 계정은 그대로 유지, 없는 계정만 추가
const insertUser = db.prepare(`INSERT OR IGNORE INTO app_users (name, pin_hash, role, is_active, tab_permissions) VALUES (?, ?, ?, 1, '')`);
for (const u of defaultUsers) {
  const r = insertUser.run(u.name, hashPin(u.pin), u.role);
  if (r.changes > 0) console.log(`✅ 기본 계정 생성: ${u.name} (${u.role}) / PIN: ${u.pin}`);
  else console.log(`ℹ️ 기존 계정 유지: ${u.name}`);
}
console.log(`✅ 사용자 초기화 완료 - 현재 ${db.prepare('SELECT COUNT(*) as c FROM app_users').get().c}명`);

// ── 헬퍼 함수 ─────────────────────────────────────────────────
const wrap = (fn) => async (req, res, next) => {
  try { await fn(req, res, next); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
};

// ── 인증(Auth) ────────────────────────────────────────────────
// POST /api/auth/login
app.post('/api/auth/login', wrap((req, res) => {
  const { name, pin } = req.body;
  if (!name || !pin) return res.status(400).json({ success: false, error: '이름과 PIN이 필요합니다' });
  const user = db.prepare('SELECT * FROM app_users WHERE name=? AND is_active=1').get(name.trim());
  if (!user) return res.status(401).json({ success: false, error: '등록되지 않은 사용자이거나 비활성 계정입니다' });
  if (user.pin_hash !== hashPin(pin.trim())) return res.status(401).json({ success: false, error: 'PIN이 올바르지 않습니다' });
  db.prepare('UPDATE app_users SET last_login=CURRENT_TIMESTAMP WHERE id=?').run(user.id);
  res.json({ success: true, user: { id: user.id, name: user.name, role: user.role, tab_permissions: user.tab_permissions || '', last_login: user.last_login } });
}));

// POST /api/auth/change-pin
app.post('/api/auth/change-pin', wrap((req, res) => {
  const { name, current_pin, new_pin } = req.body;
  if (!name || !current_pin || !new_pin) return res.status(400).json({ success: false, error: '필수값 누락' });
  const user = db.prepare('SELECT * FROM app_users WHERE name=?').get(name.trim());
  if (!user) return res.status(404).json({ success: false, error: '사용자를 찾을 수 없습니다' });
  if (user.pin_hash !== hashPin(current_pin.trim())) return res.status(401).json({ success: false, error: '현재 PIN이 올바르지 않습니다' });
  if (new_pin.trim().length < 4) return res.status(400).json({ success: false, error: 'PIN은 4자리 이상이어야 합니다' });
  db.prepare('UPDATE app_users SET pin_hash=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(hashPin(new_pin.trim()), user.id);
  res.json({ success: true });
}));

// ── 사용자 관리 API ───────────────────────────────────────────
// GET /api/users
app.get('/api/users', wrap((req, res) => {
  const rows = db.prepare('SELECT id, name, role, is_active, COALESCE(tab_permissions,\'\') as tab_permissions, last_login, created_at FROM app_users ORDER BY created_at ASC').all();
  res.json({ success: true, results: rows });
}));

// POST /api/users
app.post('/api/users', wrap((req, res) => {
  const { name, pin, role } = req.body;
  if (!name || !pin) return res.status(400).json({ success: false, error: '이름과 PIN이 필요합니다' });
  if (pin.trim().length < 4) return res.status(400).json({ success: false, error: 'PIN은 4자리 이상이어야 합니다' });
  const exists = db.prepare('SELECT id FROM app_users WHERE name=?').get(name.trim());
  if (exists) return res.status(409).json({ success: false, error: '이미 존재하는 이름입니다' });
  const r = db.prepare(`INSERT INTO app_users (name, pin_hash, role, is_active, tab_permissions) VALUES (?,?,?,1,'')`)
    .run(name.trim(), hashPin(pin.trim()), role === 'admin' ? 'admin' : 'user');
  res.json({ success: true, id: r.lastInsertRowid });
}));

// PUT /api/users/:id
app.put('/api/users/:id', wrap((req, res) => {
  const { pin, role, is_active, tab_permissions } = req.body;
  const user = db.prepare('SELECT * FROM app_users WHERE id=?').get(req.params.id);
  if (!user) return res.status(404).json({ success: false, error: '사용자를 찾을 수 없습니다' });
  const newPinHash = (pin && pin.trim().length >= 4) ? hashPin(pin.trim()) : user.pin_hash;
  const newRole = role !== undefined ? (role === 'admin' ? 'admin' : 'user') : user.role;
  const newActive = is_active !== undefined ? (is_active ? 1 : 0) : user.is_active;
  const newPerms = tab_permissions !== undefined ? tab_permissions : user.tab_permissions;
  db.prepare(`UPDATE app_users SET pin_hash=?, role=?, is_active=?, tab_permissions=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(newPinHash, newRole, newActive, newPerms, req.params.id);
  res.json({ success: true });
}));

// DELETE /api/users/:id
app.delete('/api/users/:id', wrap((req, res) => {
  const user = db.prepare('SELECT * FROM app_users WHERE id=?').get(req.params.id);
  if (!user) return res.status(404).json({ success: false, error: '사용자를 찾을 수 없습니다' });
  if (user.role === 'admin') {
    const adminCount = db.prepare("SELECT COUNT(*) as cnt FROM app_users WHERE role='admin'").get();
    if (adminCount.cnt <= 1) return res.status(400).json({ success: false, error: '마지막 관리자 계정은 삭제할 수 없습니다' });
  }
  db.prepare('DELETE FROM app_users WHERE id=?').run(req.params.id);
  res.json({ success: true });
}));

// POST /api/users/restore  ← 앱 캐시 → 서버 복원용 (PIN 없이 계정만 복원)
app.post('/api/users/restore', wrap((req, res) => {
  const { name, role, tab_permissions, is_active } = req.body;
  if (!name) return res.status(400).json({ success: false, error: 'name 필요' });
  const exists = db.prepare('SELECT id FROM app_users WHERE name=?').get(name.trim());
  if (exists) {
    // 이미 있으면 tab_permissions, is_active만 업데이트
    db.prepare(`UPDATE app_users SET role=?, tab_permissions=?, is_active=?, updated_at=CURRENT_TIMESTAMP WHERE name=?`)
      .run(role || 'user', tab_permissions || '', is_active ?? 1, name.trim());
    return res.json({ success: true, restored: false, id: exists.id });
  }
  // 없으면 PIN 없이 추가 (PIN은 '0000' 임시값 - 나중에 관리자가 재설정)
  const r = db.prepare(`INSERT INTO app_users (name, pin_hash, role, is_active, tab_permissions) VALUES (?,?,?,?,?)`)
    .run(name.trim(), crypto.createHash('sha256').update('0000').digest('hex'),
         role || 'user', is_active ?? 1, tab_permissions || '');
  res.json({ success: true, restored: true, id: r.lastInsertRowid });
}));

// ── 대시보드 ──────────────────────────────────────────────────
app.get('/api/dashboard', wrap((req, res) => {
  const { team } = req.query;
  const teamFilter = (team && team.trim() !== '' && team.trim() !== '전체') ? team.trim() : null;

  // team 컬럼 존재 여부 확인 (안전하게 처리)
  const siteTableCols = db.prepare("PRAGMA table_info(sites)").all().map(c => c.name);
  const hasTeamCol = siteTableCols.includes('team');

  // team 컬럼 없으면 teamFilter 무효화
  const effectiveTeamFilter = hasTeamCol ? teamFilter : null;
  const effectiveSiteWhere = effectiveTeamFilter ? `WHERE status='active' AND team=?` : `WHERE status='active'`;
  const effectiveSiteParams = effectiveTeamFilter ? [effectiveTeamFilter] : [];

  const sitesCount = db.prepare(`SELECT COUNT(*) as count FROM sites ${effectiveSiteWhere}`).get(...effectiveSiteParams);

  // 팀에 속한 사이트 ID 목록
  let siteIds = [];
  if (effectiveTeamFilter && hasTeamCol) {
    const teamSites = db.prepare(`SELECT id FROM sites WHERE team=? AND status='active'`).all(effectiveTeamFilter);
    siteIds = teamSites.map(s => s.id);
  }

  const siteIdIn = siteIds.length > 0 ? `IN (${siteIds.join(',')})` : null;

  // 승강기 대수: elevators 테이블 실제 COUNT만 사용
  let elevatorsCount;
  if (siteIdIn) {
    elevatorsCount = db.prepare(`SELECT COUNT(*) as count, SUM(CASE WHEN status='warning' THEN 1 ELSE 0 END) as warning, SUM(CASE WHEN status='fault' THEN 1 ELSE 0 END) as fault FROM elevators WHERE site_id ${siteIdIn}`).get();
    elevatorsCount = { count: elevatorsCount.count || 0, warning: elevatorsCount.warning || 0, fault: elevatorsCount.fault || 0 };
  } else if (effectiveTeamFilter && !siteIdIn) {
    elevatorsCount = { count: 0, warning: 0, fault: 0 };
  } else {
    elevatorsCount = db.prepare(`SELECT COUNT(*) as count, SUM(CASE WHEN status='warning' THEN 1 ELSE 0 END) as warning, SUM(CASE WHEN status='fault' THEN 1 ELSE 0 END) as fault FROM elevators`).get();
    elevatorsCount = { count: elevatorsCount.count || 0, warning: elevatorsCount.warning || 0, fault: elevatorsCount.fault || 0 };
  }

  const issueWhere = siteIdIn ? `WHERE status != '조치완료' AND site_id ${siteIdIn}` : `WHERE status != '조치완료'`;
  const pendingIssues = db.prepare(`SELECT COUNT(*) as total, SUM(CASE WHEN severity='중결함' THEN 1 ELSE 0 END) as critical, SUM(CASE WHEN severity='경결함' THEN 1 ELSE 0 END) as minor FROM inspection_issues ${issueWhere}`).get();

  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const quarter = Math.ceil((now.getMonth() + 1) / 3);

  const mcWhere = siteIdIn ? `WHERE check_year=? AND check_month=? AND site_id ${siteIdIn}` : `WHERE check_year=? AND check_month=?`;
  const qcWhere = siteIdIn ? `WHERE check_year=? AND quarter=? AND site_id ${siteIdIn}` : `WHERE check_year=? AND quarter=?`;

  const monthlyStats = db.prepare(`SELECT COUNT(*) as total, SUM(CASE WHEN status='완료' THEN 1 ELSE 0 END) as done FROM monthly_checks ${mcWhere}`).get(yyyy, parseInt(mm));
  const quarterlyStats = db.prepare(`SELECT COUNT(*) as total, SUM(CASE WHEN status='완료' THEN 1 ELSE 0 END) as done FROM quarterly_checks ${qcWhere}`).get(yyyy, quarter);

  const riWhere = siteIdIn ? `WHERE ii.status != '조치완료' AND ii.site_id ${siteIdIn}` : `WHERE ii.status != '조치완료'`;
  const recentIssues = db.prepare(`
    SELECT ii.id, ii.issue_description, ii.severity, ii.status, ii.deadline,
           s.site_name, e.elevator_name
    FROM inspection_issues ii
    JOIN sites s ON s.id=ii.site_id
    JOIN elevators e ON e.id=ii.elevator_id
    ${riWhere}
    ORDER BY CASE ii.severity WHEN '중결함' THEN 1 WHEN '경결함' THEN 2 ELSE 3 END,
             ii.deadline ASC LIMIT 5
  `).all();

  // 팀별 통계 (team 컬럼 있을 때만) - elevators 실제 COUNT 사용
  let teamStats = [];
  if (hasTeamCol) {
    teamStats = db.prepare(`
      SELECT s.team,
        COUNT(DISTINCT s.id) as sites,
        COUNT(DISTINCT e.id) as elevators,
        COUNT(CASE WHEN e.status='fault' THEN 1 END) as fault,
        COUNT(CASE WHEN e.status='warning' THEN 1 END) as warning,
        (SELECT COUNT(*) FROM inspection_issues ii2
          WHERE ii2.site_id IN (SELECT id FROM sites s3 WHERE s3.team=s.team AND s3.status='active')
          AND ii2.status != '조치완료') as pending_issues,
        (SELECT COUNT(*) FROM inspection_issues ii3
          WHERE ii3.site_id IN (SELECT id FROM sites s4 WHERE s4.team=s.team AND s4.status='active')
          AND ii3.status != '조치완료' AND ii3.severity='중결함') as critical_issues
      FROM sites s
      LEFT JOIN elevators e ON e.site_id=s.id
      WHERE s.team != '' AND s.team IS NOT NULL AND s.status='active'
      GROUP BY s.team
      ORDER BY s.team
    `).all();
  }

  // 30일 이내 검사 예정
  const today = new Date().toISOString().split('T')[0];
  const future = new Date(Date.now() + 30*24*60*60*1000).toISOString().split('T')[0];
  const inspecWhere = siteIdIn
    ? `WHERE i.next_inspection_date BETWEEN ? AND ? AND i.site_id ${siteIdIn}`
    : `WHERE i.next_inspection_date BETWEEN ? AND ?`;
  const upcomingInspections = db.prepare(`SELECT COUNT(*) as count FROM inspections i ${inspecWhere}`).get(today, future);
  const upcomingInspectionList = db.prepare(`
    SELECT i.*, s.site_name, e.elevator_name FROM inspections i
    JOIN sites s ON s.id=i.site_id
    JOIN elevators e ON e.id=i.elevator_id
    ${inspecWhere}
    ORDER BY i.next_inspection_date ASC LIMIT 10
  `).all(today, future);

  res.json({ success: true, data: {
    sites: sitesCount?.count || 0,
    elevators: elevatorsCount,
    pendingIssues,
    monthlyStats,
    quarterlyStats,
    recentIssues,
    teamStats,
    upcomingInspections: upcomingInspections?.count || 0,
    upcomingInspectionList
  }});
}));

// ── 팀(Teams) ─────────────────────────────────────────────────
// GET /api/teams - 현장에 사용된 팀 + 추가된 팀 모두 반환
app.get('/api/teams', wrap((req, res) => {
  const hasTCol = db.prepare("PRAGMA table_info(sites)").all().map(c=>c.name).includes('team');
  let teams = [];
  if (hasTCol) {
    const rows = db.prepare(`SELECT DISTINCT team FROM sites WHERE team IS NOT NULL AND team != '' ORDER BY team ASC`).all();
    teams = rows.map(r => r.team);
  }
  // 메모리에 추가된 커스텀 팀도 포함
  for (const t of _customTeams) {
    if (!teams.includes(t)) teams.push(t);
  }
  teams.sort();
  res.json({ success: true, results: teams });
}));

// POST /api/teams - 새 팀 이름 등록 (teams 전용 테이블 없이 별도 관리 테이블 사용)
// teams 테이블이 없으므로 메모리 Set으로 관리 + sites에서 사용된 팀 자동 포함
const _customTeams = new Set(); // 서버 재시작 시 초기화 (sites 테이블에서 복원)
try {
  const existing = db.prepare(`SELECT DISTINCT team FROM sites WHERE team IS NOT NULL AND team != ''`).all();
  existing.forEach(r => _customTeams.add(r.team));
} catch(e) {}

app.post('/api/teams', wrap((req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ success: false, error: '팀 이름이 필요합니다' });
  const trimmed = name.trim();
  _customTeams.add(trimmed);
  res.json({ success: true, name: trimmed });
}));

// DELETE /api/teams/:name - 팀 삭제 (해당 팀 현장이 없을 때만)
app.delete('/api/teams/:name', wrap((req, res) => {
  const teamName = decodeURIComponent(req.params.name);
  const hasTCol = db.prepare("PRAGMA table_info(sites)").all().map(c=>c.name).includes('team');
  if (hasTCol) {
    const inUse = db.prepare(`SELECT COUNT(*) as cnt FROM sites WHERE team=?`).get(teamName);
    if (inUse.cnt > 0) return res.status(400).json({ success: false, error: `해당 팀을 사용 중인 현장이 ${inUse.cnt}개 있습니다` });
  }
  _customTeams.delete(teamName);
  res.json({ success: true });
}));

// ── 현장(Sites) ───────────────────────────────────────────────
app.get('/api/sites', wrap((req, res) => {
  const { search, status, team } = req.query;
  const hasTCol = db.prepare("PRAGMA table_info(sites)").all().map(c=>c.name).includes('team');
  let sql = `SELECT s.*, COUNT(e.id) as elevator_count FROM sites s LEFT JOIN elevators e ON e.site_id=s.id`;
  const params = [];
  const where = [];
  if (search) { where.push("(s.site_name LIKE ? OR s.site_code LIKE ? OR s.address LIKE ?)"); params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
  if (status) { where.push("s.status=?"); params.push(status); }
  if (hasTCol && team && team !== '전체') { where.push("s.team=?"); params.push(team); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' GROUP BY s.id ORDER BY s.created_at DESC';
  res.json({ success: true, results: db.prepare(sql).all(...params) });
}));

app.get('/api/sites/:id', wrap((req, res) => {
  const site = db.prepare('SELECT * FROM sites WHERE id=?').get(req.params.id);
  if (!site) return res.status(404).json({ success: false, error: '현장을 찾을 수 없습니다' });
  res.json({ success: true, result: site });
}));

app.post('/api/sites', wrap((req, res) => {
  const { site_code, site_name, address, owner_name, owner_phone, manager_name, team, total_elevators, status, contract_start, contract_end, notes } = req.body;
  const hasTCol2 = db.prepare("PRAGMA table_info(sites)").all().map(c=>c.name).includes('team');
  let r;
  if (hasTCol2) {
    r = db.prepare(`INSERT INTO sites (site_code, site_name, address, owner_name, owner_phone, manager_name, team, total_elevators, status, contract_start, contract_end, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(site_code, site_name, address, owner_name||null, owner_phone||null, manager_name||null, team||'', total_elevators||0, status||'active', contract_start||null, contract_end||null, notes||null);
  } else {
    r = db.prepare(`INSERT INTO sites (site_code, site_name, address, owner_name, owner_phone, manager_name, total_elevators, status, contract_start, contract_end, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(site_code, site_name, address, owner_name||null, owner_phone||null, manager_name||null, total_elevators||0, status||'active', contract_start||null, contract_end||null, notes||null);
  }
  res.json({ success: true, id: r.lastInsertRowid });
  setImmediate(() => updateSeedFile()); // 비동기로 seed 갱신
}));

app.put('/api/sites/:id', wrap((req, res) => {
  const { site_code, site_name, address, owner_name, owner_phone, manager_name, team, total_elevators, status, contract_start, contract_end, notes } = req.body;
  const hasTCol3 = db.prepare("PRAGMA table_info(sites)").all().map(c=>c.name).includes('team');
  if (hasTCol3) {
    db.prepare(`UPDATE sites SET site_code=?, site_name=?, address=?, owner_name=?, owner_phone=?, manager_name=?, team=?, total_elevators=?, status=?, contract_start=?, contract_end=?, notes=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(site_code, site_name, address, owner_name||null, owner_phone||null, manager_name||null, team||'', total_elevators||0, status||'active', contract_start||null, contract_end||null, notes||null, req.params.id);
  } else {
    db.prepare(`UPDATE sites SET site_code=?, site_name=?, address=?, owner_name=?, owner_phone=?, manager_name=?, total_elevators=?, status=?, contract_start=?, contract_end=?, notes=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(site_code, site_name, address, owner_name||null, owner_phone||null, manager_name||null, total_elevators||0, status||'active', contract_start||null, contract_end||null, notes||null, req.params.id);
  }
  res.json({ success: true });
  setImmediate(() => updateSeedFile()); // 비동기로 seed 갱신
}));

app.delete('/api/sites/:id', wrap((req, res) => {
  db.prepare('DELETE FROM sites WHERE id=?').run(req.params.id);
  res.json({ success: true });
  setImmediate(() => updateSeedFile()); // 비동기로 seed 갱신
}));

// ── 승강기(Elevators) ─────────────────────────────────────────
app.get('/api/elevators', wrap((req, res) => {
  const { site_id, status, search } = req.query;
  let sql = `SELECT e.*, s.site_name, s.site_code FROM elevators e LEFT JOIN sites s ON s.id=e.site_id`;
  const params = [];
  const where = [];
  if (site_id) { where.push('e.site_id=?'); params.push(site_id); }
  if (status) { where.push('e.status=?'); params.push(status); }
  if (search) { where.push('(e.elevator_name LIKE ? OR e.elevator_no LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY e.created_at DESC';
  res.json({ success: true, results: db.prepare(sql).all(...params) });
}));

app.get('/api/elevators/:id', wrap((req, res) => {
  const elev = db.prepare('SELECT e.*, s.site_name FROM elevators e LEFT JOIN sites s ON s.id=e.site_id WHERE e.id=?').get(req.params.id);
  if (!elev) return res.status(404).json({ success: false, error: '승강기를 찾을 수 없습니다' });
  res.json({ success: true, result: elev });
}));

app.post('/api/elevators', wrap((req, res) => {
  const { site_id, elevator_no, elevator_name, elevator_type, manufacturer, manufacture_year, install_date, floors_served, capacity, load_capacity, speed, status, notes } = req.body;
  const r = db.prepare(`INSERT INTO elevators (site_id, elevator_no, elevator_name, elevator_type, manufacturer, manufacture_year, install_date, floors_served, capacity, load_capacity, speed, status, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(site_id, elevator_no, elevator_name || null, elevator_type || '승객용', manufacturer || null, manufacture_year || null, install_date || null, floors_served || null, capacity || null, load_capacity || null, speed || null, status || 'normal', notes || null);
  res.json({ success: true, id: r.lastInsertRowid });
  setImmediate(() => updateSeedFile()); // 비동기로 seed 갱신
}));

app.put('/api/elevators/:id', wrap((req, res) => {
  const { site_id, elevator_no, elevator_name, elevator_type, manufacturer, manufacture_year, install_date, floors_served, capacity, load_capacity, speed, status, notes } = req.body;
  db.prepare(`UPDATE elevators SET site_id=?, elevator_no=?, elevator_name=?, elevator_type=?, manufacturer=?, manufacture_year=?, install_date=?, floors_served=?, capacity=?, load_capacity=?, speed=?, status=?, notes=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(site_id, elevator_no, elevator_name || null, elevator_type || '승객용', manufacturer || null, manufacture_year || null, install_date || null, floors_served || null, capacity || null, load_capacity || null, speed || null, status || 'normal', notes || null, req.params.id);
  res.json({ success: true });
  setImmediate(() => updateSeedFile()); // 비동기로 seed 갱신
}));

app.delete('/api/elevators/:id', wrap((req, res) => {
  db.prepare('DELETE FROM elevators WHERE id=?').run(req.params.id);
  res.json({ success: true });
  setImmediate(() => updateSeedFile()); // 비동기로 seed 갱신
}));

// ── 검사(Inspections) ─────────────────────────────────────────
app.get('/api/inspections', wrap((req, res) => {
  const { site_id, elevator_id, result, inspection_type } = req.query;
  let sql = `SELECT i.*, s.site_name, e.elevator_name, e.elevator_no FROM inspections i LEFT JOIN sites s ON s.id=i.site_id LEFT JOIN elevators e ON e.id=i.elevator_id`;
  const params = [];
  const where = [];
  if (site_id) { where.push('i.site_id=?'); params.push(site_id); }
  if (elevator_id) { where.push('i.elevator_id=?'); params.push(elevator_id); }
  if (result) { where.push('i.result=?'); params.push(result); }
  if (inspection_type) { where.push('i.inspection_type=?'); params.push(inspection_type); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY i.inspection_date DESC';
  res.json({ success: true, results: db.prepare(sql).all(...params) });
}));

app.get('/api/inspections/:id', wrap((req, res) => {
  const item = db.prepare('SELECT i.*, s.site_name, e.elevator_name FROM inspections i LEFT JOIN sites s ON s.id=i.site_id LEFT JOIN elevators e ON e.id=i.elevator_id WHERE i.id=?').get(req.params.id);
  if (!item) return res.status(404).json({ success: false, error: '검사를 찾을 수 없습니다' });
  res.json({ success: true, result: item });
}));

app.post('/api/inspections', wrap((req, res) => {
  const { elevator_id, site_id, inspection_type, inspection_date, next_inspection_date, inspector_name, inspection_agency, result, report_no, notes } = req.body;
  const r = db.prepare(`INSERT INTO inspections (elevator_id, site_id, inspection_type, inspection_date, next_inspection_date, inspector_name, inspection_agency, result, report_no, notes) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(elevator_id, site_id, inspection_type, inspection_date, next_inspection_date || null, inspector_name || null, inspection_agency || null, result || '합격', report_no || null, notes || null);
  res.json({ success: true, id: r.lastInsertRowid });
  setImmediate(() => updateSeedFile()); // 비동기로 seed 갱신
}));

app.put('/api/inspections/:id', wrap((req, res) => {
  const { elevator_id, site_id, inspection_type, inspection_date, next_inspection_date, inspector_name, inspection_agency, result, report_no, notes } = req.body;
  db.prepare(`UPDATE inspections SET elevator_id=?, site_id=?, inspection_type=?, inspection_date=?, next_inspection_date=?, inspector_name=?, inspection_agency=?, result=?, report_no=?, notes=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(elevator_id, site_id, inspection_type, inspection_date, next_inspection_date || null, inspector_name || null, inspection_agency || null, result || '합격', report_no || null, notes || null, req.params.id);
  res.json({ success: true });
  setImmediate(() => updateSeedFile()); // 비동기로 seed 갱신
}));

app.delete('/api/inspections/:id', wrap((req, res) => {
  db.prepare('DELETE FROM inspections WHERE id=?').run(req.params.id);
  res.json({ success: true });
  setImmediate(() => updateSeedFile()); // 비동기로 seed 갱신
}));

// ── 지적사항(Issues) ──────────────────────────────────────────
app.get('/api/issues', wrap((req, res) => {
  const { site_id, elevator_id, status, severity, inspection_id } = req.query;
  let sql = `SELECT ii.*, s.site_name, e.elevator_name FROM inspection_issues ii LEFT JOIN sites s ON s.id=ii.site_id LEFT JOIN elevators e ON e.id=ii.elevator_id`;
  const params = [];
  const where = [];
  if (site_id) { where.push('ii.site_id=?'); params.push(site_id); }
  if (elevator_id) { where.push('ii.elevator_id=?'); params.push(elevator_id); }
  if (status) { where.push('ii.status=?'); params.push(status); }
  if (severity) { where.push('ii.severity=?'); params.push(severity); }
  if (inspection_id) { where.push('ii.inspection_id=?'); params.push(inspection_id); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY ii.created_at DESC';
  res.json({ success: true, results: db.prepare(sql).all(...params) });
}));

app.get('/api/issues/:id', wrap((req, res) => {
  const item = db.prepare('SELECT ii.*, s.site_name, e.elevator_name FROM inspection_issues ii LEFT JOIN sites s ON s.id=ii.site_id LEFT JOIN elevators e ON e.id=ii.elevator_id WHERE ii.id=?').get(req.params.id);
  if (!item) return res.status(404).json({ success: false, error: '지적사항을 찾을 수 없습니다' });
  res.json({ success: true, result: item });
}));

app.post('/api/issues', wrap((req, res) => {
  const { inspection_id, elevator_id, site_id, issue_no, issue_category, issue_description, legal_basis, severity, status, action_required, deadline, inspection_date, inspector_name } = req.body;
  const r = db.prepare(`INSERT INTO inspection_issues (inspection_id, elevator_id, site_id, issue_no, issue_category, issue_description, legal_basis, severity, status, action_required, deadline, inspection_date, inspector_name) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(inspection_id || null, elevator_id, site_id, issue_no || 1, issue_category || null, issue_description, legal_basis || null, severity || '경결함', status || '미조치', action_required || null, deadline || null, inspection_date || null, inspector_name || null);
  res.json({ success: true, id: r.lastInsertRowid });
}));

// 일괄 등록 (문자/파일 파싱 결과)
app.post('/api/issues/bulk', wrap((req, res) => {
  const { issues } = req.body;
  if (!Array.isArray(issues) || issues.length === 0) {
    return res.status(400).json({ success: false, error: '등록할 지적사항이 없습니다' });
  }
  const stmt = db.prepare(`INSERT INTO inspection_issues (inspection_id, elevator_id, site_id, issue_no, issue_category, issue_description, legal_basis, severity, status, action_required, deadline, inspection_date, inspector_name) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insertMany = db.transaction((items) => {
    const ids = [];
    for (const it of items) {
      const r = stmt.run(
        it.inspection_id || null, it.elevator_id, it.site_id,
        it.issue_no || 1, it.issue_category || null, it.issue_description,
        it.legal_basis || null, it.severity || '경결함', it.status || '미조치',
        it.action_required || null, it.deadline || null,
        it.inspection_date || null, it.inspector_name || null
      );
      ids.push(r.lastInsertRowid);
    }
    return ids;
  });
  const ids = insertMany(issues);
  res.json({ success: true, ids, count: ids.length });
  setImmediate(() => updateSeedFile());
}));

app.patch('/api/issues/:id/action', wrap((req, res) => {
  const { status, action_taken, action_date, action_by, photo_before, photo_after } = req.body;
  db.prepare(`UPDATE inspection_issues SET status=?, action_taken=?, action_date=?, action_by=?, photo_before=?, photo_after=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(status || '조치완료', action_taken || null, action_date || null, action_by || null, photo_before || null, photo_after || null, req.params.id);
  res.json({ success: true });
  setImmediate(() => updateSeedFile());
}));

app.put('/api/issues/:id', wrap((req, res) => {
  const { issue_category, issue_description, legal_basis, severity, status, action_required, action_taken, action_date, action_by, deadline, inspection_date, inspector_name } = req.body;
  db.prepare(`UPDATE inspection_issues SET issue_category=?, issue_description=?, legal_basis=?, severity=?, status=?, action_required=?, action_taken=?, action_date=?, action_by=?, deadline=?, inspection_date=?, inspector_name=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(issue_category || null, issue_description, legal_basis || null, severity || '경결함', status || '미조치', action_required || null, action_taken || null, action_date || null, action_by || null, deadline || null, inspection_date || null, inspector_name || null, req.params.id);
  res.json({ success: true });
  setImmediate(() => updateSeedFile());
}));

app.delete('/api/issues/:id', wrap((req, res) => {
  db.prepare('DELETE FROM inspection_issues WHERE id=?').run(req.params.id);
  res.json({ success: true });
  setImmediate(() => updateSeedFile());
}));

app.get('/api/issues/stats/pending', wrap((req, res) => {
  const results = db.prepare(`
    SELECT s.id as site_id, s.site_name,
    COUNT(*) as total,
    SUM(CASE WHEN ii.severity='중결함' THEN 1 ELSE 0 END) as critical,
    SUM(CASE WHEN ii.severity='경결함' THEN 1 ELSE 0 END) as minor
    FROM inspection_issues ii JOIN sites s ON s.id=ii.site_id
    WHERE ii.status != '조치완료'
    GROUP BY s.id ORDER BY critical DESC
  `).all();
  res.json({ success: true, results });
}));

// ── 월 점검(Monthly) ──────────────────────────────────────────
app.get('/api/monthly', wrap((req, res) => {
  const { site_id, elevator_id, check_year, check_month, status } = req.query;
  let sql = `SELECT mc.*, s.site_name, e.elevator_name FROM monthly_checks mc LEFT JOIN sites s ON s.id=mc.site_id LEFT JOIN elevators e ON e.id=mc.elevator_id`;
  const params = [];
  const where = [];
  if (site_id) { where.push('mc.site_id=?'); params.push(site_id); }
  if (elevator_id) { where.push('mc.elevator_id=?'); params.push(elevator_id); }
  if (check_year) { where.push('mc.check_year=?'); params.push(check_year); }
  if (check_month) { where.push('mc.check_month=?'); params.push(check_month); }
  if (status) { where.push('mc.status=?'); params.push(status); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY mc.check_year DESC, mc.check_month DESC, mc.created_at DESC';
  res.json({ success: true, results: db.prepare(sql).all(...params) });
}));

app.get('/api/monthly/:id', wrap((req, res) => {
  const item = db.prepare('SELECT mc.*, s.site_name, e.elevator_name FROM monthly_checks mc LEFT JOIN sites s ON s.id=mc.site_id LEFT JOIN elevators e ON e.id=mc.elevator_id WHERE mc.id=?').get(req.params.id);
  if (!item) return res.status(404).json({ success: false, error: '월 점검을 찾을 수 없습니다' });
  res.json({ success: true, result: item });
}));

app.post('/api/monthly', wrap((req, res) => {
  const { elevator_id, site_id, check_year, check_month, check_date, checker_name, status, door_check, motor_check, brake_check, rope_check, safety_device_check, lighting_check, emergency_check, overall_result, issues_found, actions_taken, next_action, notes } = req.body;
  const r = db.prepare(`INSERT INTO monthly_checks (elevator_id, site_id, check_year, check_month, check_date, checker_name, status, door_check, motor_check, brake_check, rope_check, safety_device_check, lighting_check, emergency_check, overall_result, issues_found, actions_taken, next_action, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(elevator_id, site_id, check_year, check_month, check_date || null, checker_name || null, status || '예정', door_check || '양호', motor_check || '양호', brake_check || '양호', rope_check || '양호', safety_device_check || '양호', lighting_check || '양호', emergency_check || '양호', overall_result || '양호', issues_found || null, actions_taken || null, next_action || null, notes || null);
  res.json({ success: true, id: r.lastInsertRowid });
  setImmediate(() => updateSeedFile());
}));

app.put('/api/monthly/:id', wrap((req, res) => {
  const { check_date, checker_name, status, door_check, motor_check, brake_check, rope_check, safety_device_check, lighting_check, emergency_check, overall_result, issues_found, actions_taken, next_action, notes } = req.body;
  db.prepare(`UPDATE monthly_checks SET check_date=?, checker_name=?, status=?, door_check=?, motor_check=?, brake_check=?, rope_check=?, safety_device_check=?, lighting_check=?, emergency_check=?, overall_result=?, issues_found=?, actions_taken=?, next_action=?, notes=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(check_date || null, checker_name || null, status || '예정', door_check || '양호', motor_check || '양호', brake_check || '양호', rope_check || '양호', safety_device_check || '양호', lighting_check || '양호', emergency_check || '양호', overall_result || '양호', issues_found || null, actions_taken || null, next_action || null, notes || null, req.params.id);
  res.json({ success: true });
  setImmediate(() => updateSeedFile());
}));

app.delete('/api/monthly/:id', wrap((req, res) => {
  db.prepare('DELETE FROM monthly_checks WHERE id=?').run(req.params.id);
  res.json({ success: true });
  setImmediate(() => updateSeedFile());
}));

// ── 분기 점검(Quarterly) ──────────────────────────────────────
app.get('/api/quarterly', wrap((req, res) => {
  const { site_id, elevator_id, check_year, quarter, status } = req.query;
  let sql = `SELECT qc.*, s.site_name, e.elevator_name FROM quarterly_checks qc LEFT JOIN sites s ON s.id=qc.site_id LEFT JOIN elevators e ON e.id=qc.elevator_id`;
  const params = [];
  const where = [];
  if (site_id) { where.push('qc.site_id=?'); params.push(site_id); }
  if (elevator_id) { where.push('qc.elevator_id=?'); params.push(elevator_id); }
  if (check_year) { where.push('qc.check_year=?'); params.push(check_year); }
  if (quarter) { where.push('qc.quarter=?'); params.push(quarter); }
  if (status) { where.push('qc.status=?'); params.push(status); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY qc.check_year DESC, qc.quarter DESC, qc.created_at DESC';
  res.json({ success: true, results: db.prepare(sql).all(...params) });
}));

app.get('/api/quarterly/:id', wrap((req, res) => {
  const item = db.prepare('SELECT qc.*, s.site_name, e.elevator_name FROM quarterly_checks qc LEFT JOIN sites s ON s.id=qc.site_id LEFT JOIN elevators e ON e.id=qc.elevator_id WHERE qc.id=?').get(req.params.id);
  if (!item) return res.status(404).json({ success: false, error: '분기 점검을 찾을 수 없습니다' });
  res.json({ success: true, result: item });
}));

app.post('/api/quarterly', wrap((req, res) => {
  const { elevator_id, site_id, check_year, quarter, check_date, checker_name, status, mechanical_room, hoistway, car_interior, pit, landing_doors, safety_gear, ropes_chains, buffers, electrical, overall_score, overall_result, smart_diagnosis, noise_level, speed_test, issues_found, actions_taken, next_action, notes } = req.body;
  const r = db.prepare(`INSERT INTO quarterly_checks (elevator_id, site_id, check_year, quarter, check_date, checker_name, status, mechanical_room, hoistway, car_interior, pit, landing_doors, safety_gear, ropes_chains, buffers, electrical, overall_score, overall_result, smart_diagnosis, noise_level, speed_test, issues_found, actions_taken, next_action, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(elevator_id, site_id, check_year, quarter, check_date || null, checker_name || null, status || '예정', mechanical_room || '양호', hoistway || '양호', car_interior || '양호', pit || '양호', landing_doors || '양호', safety_gear || '양호', ropes_chains || '양호', buffers || '양호', electrical || '양호', overall_score || null, overall_result || '양호', smart_diagnosis || null, noise_level || null, speed_test || null, issues_found || null, actions_taken || null, next_action || null, notes || null);
  res.json({ success: true, id: r.lastInsertRowid });
}));

app.put('/api/quarterly/:id', wrap((req, res) => {
  const { check_date, checker_name, status, mechanical_room, hoistway, car_interior, pit, landing_doors, safety_gear, ropes_chains, buffers, electrical, overall_score, overall_result, smart_diagnosis, noise_level, speed_test, issues_found, actions_taken, next_action, notes } = req.body;
  db.prepare(`UPDATE quarterly_checks SET check_date=?, checker_name=?, status=?, mechanical_room=?, hoistway=?, car_interior=?, pit=?, landing_doors=?, safety_gear=?, ropes_chains=?, buffers=?, electrical=?, overall_score=?, overall_result=?, smart_diagnosis=?, noise_level=?, speed_test=?, issues_found=?, actions_taken=?, next_action=?, notes=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(check_date || null, checker_name || null, status || '예정', mechanical_room || '양호', hoistway || '양호', car_interior || '양호', pit || '양호', landing_doors || '양호', safety_gear || '양호', ropes_chains || '양호', buffers || '양호', electrical || '양호', overall_score || null, overall_result || '양호', smart_diagnosis || null, noise_level || null, speed_test || null, issues_found || null, actions_taken || null, next_action || null, notes || null, req.params.id);
  res.json({ success: true });
}));

app.delete('/api/quarterly/:id', wrap((req, res) => {
  db.prepare('DELETE FROM quarterly_checks WHERE id=?').run(req.params.id);
  res.json({ success: true });
}));

// ══════════════════════════════════════════════════════════════
// PDF 파싱 엔드포인트 (PyMuPDF 기반 - 한국승강기안전공단 보고서 최적화)
// ══════════════════════════════════════════════════════════════
const PDF_PARSER_SCRIPT = path.join(__dirname, 'parse_pdf.py');

app.post('/api/pdf/parse', upload.single('pdf'), async (req, res) => {
  let tempPath = null;
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'PDF 파일이 없습니다' });
    }

    // 임시 파일에 저장
    tempPath = path.join(os.tmpdir(), `pdf_${Date.now()}_${req.file.originalname}`);
    fs.writeFileSync(tempPath, req.file.buffer);

    // Python 스크립트로 파싱
    const result = await new Promise((resolve, reject) => {
      execFile('python3', [PDF_PARSER_SCRIPT, tempPath], { timeout: 30000 }, (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message));
        try {
          resolve(JSON.parse(stdout));
        } catch (e) {
          reject(new Error('파싱 결과 파싱 실패: ' + stdout.substring(0, 200)));
        }
      });
    });

    // 임시 파일 삭제
    try { fs.unlinkSync(tempPath); } catch (_) {}

    if (!result.success) {
      return res.status(500).json(result);
    }

    return res.json({
      ...result,
      filename: req.file.originalname,
    });

  } catch (err) {
    if (tempPath) try { fs.unlinkSync(tempPath); } catch (_) {}
    console.error('PDF 파싱 오류:', err);
    res.status(500).json({ success: false, error: `PDF 파싱 실패: ${err.message}` });
  }
});

// ── 이미지 파싱 엔드포인트 (캡처/스크린샷 기반) ─────────────────
const IMAGE_PARSER_SCRIPT = path.join(__dirname, 'parse_image.py');

app.post('/api/image/parse', upload.array('images', 10), async (req, res) => {
  const files = req.files;
  if (!files || files.length === 0) {
    return res.status(400).json({ success: false, error: '이미지 파일이 없습니다' });
  }

  const allIssues = [];
  let detectedSite = null;
  let detectedDate = null;
  let rawTextAll = '';
  let errorCount = 0;

  for (const file of files) {
    let tempPath = null;
    try {
      const ext = path.extname(file.originalname) || '.png';
      tempPath = path.join(os.tmpdir(), `img_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);
      fs.writeFileSync(tempPath, file.buffer);

      const result = await new Promise((resolve, reject) => {
        execFile('python3', [IMAGE_PARSER_SCRIPT, tempPath], { timeout: 60000 }, (err, stdout, stderr) => {
          if (tempPath) try { fs.unlinkSync(tempPath); } catch (_) {}
          if (err) return reject(new Error(stderr || err.message));
          try {
            resolve(JSON.parse(stdout));
          } catch (e) {
            reject(new Error('파싱 결과 파싱 실패: ' + stdout.substring(0, 200)));
          }
        });
      });

      if (result.success) {
        if (!detectedSite && result.detectedSite) detectedSite = result.detectedSite;
        if (!detectedDate && result.detectedDate) detectedDate = result.detectedDate;
        if (result.rawText) rawTextAll += result.rawText + '\n---\n';
        for (const issue of (result.parsedIssues || [])) {
          issue.sourceFile = file.originalname;
          allIssues.push(issue);
        }
      } else {
        errorCount++;
      }
    } catch (err) {
      if (tempPath) try { fs.unlinkSync(tempPath); } catch (_) {}
      errorCount++;
      console.error('이미지 파싱 오류:', err);
    }
  }

  return res.json({
    success: true,
    fileCount: files.length,
    errorCount,
    detectedSite,
    detectedDate,
    parsedIssues: allIssues,
    totalCount: allIssues.length,
    rawText: rawTextAll.substring(0, 3000),
  });
});

// ── 서버 버전 확인 ─────────────────────────────────────────────
app.get('/api/version', (req, res) => {
  const users = db.prepare('SELECT COUNT(*) as cnt FROM app_users').get();
  const teams = db.prepare("SELECT COUNT(DISTINCT team) as cnt FROM sites WHERE team != '' AND team IS NOT NULL").get();
  const sites = db.prepare('SELECT COUNT(*) as cnt FROM sites').get();
  const elevators = db.prepare('SELECT COUNT(*) as cnt FROM elevators').get();
  res.json({ version: '2.6.0', users: users.cnt, teams: teams.cnt, sites: sites.cnt, elevators: elevators.cnt, status: 'ok' });
});

// ── DB 전체 백업 (JSON) ─────────────────────────────────────────
// GET /api/backup → 전체 DB를 JSON으로 반환 (앱에서 로컬 저장 가능)
app.get('/api/backup', wrap((req, res) => {
  const data = {
    version: '2.6.0',
    timestamp: new Date().toISOString(),
    sites: db.prepare('SELECT * FROM sites').all(),
    elevators: db.prepare('SELECT * FROM elevators').all(),
    inspections: db.prepare('SELECT * FROM inspections').all(),
    inspection_issues: db.prepare('SELECT * FROM inspection_issues').all(),
    monthly_checks: db.prepare('SELECT * FROM monthly_checks').all(),
    quarterly_checks: db.prepare('SELECT * FROM quarterly_checks').all(),
  };
  res.json({ success: true, data });
}));

// ── DB 복원 (JSON → DB) ────────────────────────────────────────
// POST /api/restore { data: { sites, elevators, ... } }
// 기존 SEED 데이터는 유지하고 백업 데이터를 병합 (site_name 기준 중복 방지)
app.post('/api/restore', wrap((req, res) => {
  const { data } = req.body;
  if (!data) return res.status(400).json({ success: false, error: '백업 데이터가 없습니다' });

  const result = { sites: 0, elevators: 0, inspections: 0, issues: 0, monthly: 0, quarterly: 0 };

  const restoreTx = db.transaction(() => {
    // 현장 복원 (site_name 중복이면 업데이트, 없으면 삽입)
    if (data.sites) {
      const insertSite = db.prepare(`INSERT OR IGNORE INTO sites
        (site_code, site_name, address, owner_name, owner_phone, manager_name, team,
         total_elevators, status, contract_start, contract_end, notes, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const s of data.sites) {
        const exists = db.prepare('SELECT id FROM sites WHERE site_name=? AND (team=? OR (team IS NULL AND ? IS NULL))').get(s.site_name, s.team, s.team);
        if (!exists) {
          insertSite.run(s.site_code, s.site_name, s.address, s.owner_name, s.owner_phone,
            s.manager_name, s.team||'', s.total_elevators||0, s.status||'active',
            s.contract_start, s.contract_end, s.notes, s.created_at, s.updated_at);
          result.sites++;
        }
      }
    }

    // 승강기 복원 (elevator_no + site_id 조합으로 중복 방지)
    if (data.elevators) {
      const insertElev = db.prepare(`INSERT OR IGNORE INTO elevators
        (site_id, elevator_no, elevator_name, elevator_type, manufacturer, install_date,
         floors_served, capacity, status, notes, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const e of data.elevators) {
        // site_id는 복원된 현장의 새 id로 매핑 필요 - 일단 site_name으로 찾기
        const site = data.sites?.find(s => s.id === e.site_id);
        if (!site) continue;
        const newSite = db.prepare('SELECT id FROM sites WHERE site_name=?').get(site.site_name);
        if (!newSite) continue;
        const exists = db.prepare('SELECT id FROM elevators WHERE site_id=? AND elevator_no=?').get(newSite.id, e.elevator_no);
        if (!exists) {
          insertElev.run(newSite.id, e.elevator_no, e.elevator_name, e.elevator_type||'승객용',
            e.manufacturer, e.install_date, e.floors_served, e.capacity,
            e.status||'normal', e.notes, e.created_at, e.updated_at);
          result.elevators++;
        }
      }
    }

    // 지적사항 복원
    if (data.inspection_issues) {
      const insertIssue = db.prepare(`INSERT OR IGNORE INTO inspection_issues
        (inspection_id, elevator_id, site_id, issue_type, severity, description,
         photo_path, status, notes, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
      for (const i of data.inspection_issues) {
        const exists = db.prepare('SELECT id FROM inspection_issues WHERE site_id=? AND elevator_id=? AND created_at=?')
          .get(i.site_id, i.elevator_id, i.created_at);
        if (!exists) {
          insertIssue.run(i.inspection_id, i.elevator_id, i.site_id, i.issue_type,
            i.severity, i.description, i.photo_path, i.status||'미조치', i.notes,
            i.created_at, i.updated_at);
          result.issues++;
        }
      }
    }

    // 월간점검 복원
    if (data.monthly_checks) {
      const insertMC = db.prepare(`INSERT OR IGNORE INTO monthly_checks
        (site_id, elevator_id, check_year, check_month, status, checker_name,
         check_date, notes, created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`);
      for (const m of data.monthly_checks) {
        const exists = db.prepare('SELECT id FROM monthly_checks WHERE site_id=? AND elevator_id=? AND check_year=? AND check_month=?')
          .get(m.site_id, m.elevator_id, m.check_year, m.check_month);
        if (!exists) {
          insertMC.run(m.site_id, m.elevator_id, m.check_year, m.check_month,
            m.status, m.checker_name, m.check_date, m.notes, m.created_at);
          result.monthly++;
        }
      }
    }

    // 분기점검 복원
    if (data.quarterly_checks) {
      const insertQC = db.prepare(`INSERT OR IGNORE INTO quarterly_checks
        (site_id, elevator_id, check_year, check_quarter, status, checker_name,
         check_date, notes, created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`);
      for (const q of data.quarterly_checks) {
        const exists = db.prepare('SELECT id FROM quarterly_checks WHERE site_id=? AND elevator_id=? AND check_year=? AND check_quarter=?')
          .get(q.site_id, q.elevator_id, q.check_year, q.check_quarter);
        if (!exists) {
          insertQC.run(q.site_id, q.elevator_id, q.check_year, q.check_quarter,
            q.status, q.checker_name, q.check_date, q.notes, q.created_at);
          result.quarterly++;
        }
      }
    }
  });

  restoreTx();
  console.log(`✅ DB 복원 완료:`, result);
  res.json({ success: true, restored: result });
}));

// ── 서버 시작 ──────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ API 서버 시작: http://0.0.0.0:${PORT}`);
  // 시작 시 사용자 수 로그
  const cnt = db.prepare('SELECT COUNT(*) as cnt FROM app_users').get();
  console.log(`👥 등록된 사용자: ${cnt.cnt}명`);
});
