const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile, spawn } = require('child_process');
const multer = require('multer');
const sharp = require('sharp');
const XLSX = require('xlsx');

// ── 동영상 자동 압축 함수 (ffmpeg 사용) ──────────────────────
// 목표: 50MB 이하 → 그대로 저장 / 50MB 초과 → ffmpeg으로 압축
// 압축 기준: 해상도 최대 1280x720, 비디오 비트레이트 1500k, 오디오 128k
async function compressVideo(inputBuffer, originalName) {
  return new Promise((resolve, reject) => {
    // 임시 파일 경로 생성
    const tmpId = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const ext = path.extname(originalName).toLowerCase() || '.mp4';
    const inputPath  = path.join(os.tmpdir(), `vid_in_${tmpId}${ext}`);
    const outputPath = path.join(os.tmpdir(), `vid_out_${tmpId}.mp4`);

    try {
      fs.writeFileSync(inputPath, inputBuffer);
    } catch (e) {
      return reject(new Error('임시 파일 쓰기 실패: ' + e.message));
    }

    const originalMB = (inputBuffer.length / 1024 / 1024).toFixed(1);
    console.log(`[video compress] 시작: ${originalName} (${originalMB}MB)`);

    // ffmpeg 압축 명령
    // -vf scale: 가로/세로 중 큰 쪽을 1280으로 축소 (비율 유지)
    // -b:v 1500k: 비디오 비트레이트
    // -b:a 128k: 오디오 비트레이트
    // -crf 28: 품질 (낮을수록 화질 좋음, 18~28 권장)
    // -preset fast: 인코딩 속도/품질 균형
    // -movflags +faststart: 웹 스트리밍 최적화
    const args = [
      '-y',                           // 덮어쓰기
      '-i', inputPath,
      '-c:v', 'libx264',
      '-crf', '28',
      '-preset', 'fast',
      '-vf', 'scale=\'min(1280,iw)\':\'min(720,ih)\':force_original_aspect_ratio=decrease',
      '-b:v', '1500k',
      '-maxrate', '2000k',
      '-bufsize', '4000k',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-movflags', '+faststart',
      outputPath,
    ];

    const proc = spawn('ffmpeg', args, { timeout: 300000 }); // 5분 타임아웃
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });

    proc.on('close', (code) => {
      try { fs.unlinkSync(inputPath); } catch (_) {}
      if (code === 0 && fs.existsSync(outputPath)) {
        try {
          const compressed = fs.readFileSync(outputPath);
          fs.unlinkSync(outputPath);
          const compressedMB = (compressed.length / 1024 / 1024).toFixed(1);
          console.log(`[video compress] 완료: ${originalName} ${originalMB}MB → ${compressedMB}MB`);
          resolve(compressed);
        } catch (e) {
          reject(new Error('압축 파일 읽기 실패: ' + e.message));
        }
      } else {
        try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (_) {}
        console.error(`[video compress] 실패 (코드 ${code}):`, stderr.slice(-500));
        reject(new Error('동영상 압축 실패 (ffmpeg 오류)'));
      }
    });

    proc.on('error', (e) => {
      try { fs.unlinkSync(inputPath); } catch (_) {}
      try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (_) {}
      reject(new Error('ffmpeg 실행 오류: ' + e.message));
    });
  });
}

// 파일 업로드 설정 (메모리 저장, 최대 100MB) - PDF, 이미지, 동영상 모두 허용
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf' ||
        file.originalname.toLowerCase().endsWith('.pdf') ||
        file.mimetype.startsWith('image/') ||
        file.mimetype.startsWith('video/') ||
        /\.(jpg|jpeg|png|gif|bmp|webp|tiff?|mp4|mov|avi|webm|3gp)$/i.test(file.originalname)) {
      cb(null, true);
    } else {
      cb(new Error('PDF, 이미지, 동영상 파일만 업로드 가능합니다'));
    }
  }
});

// Excel/CSV 전용 업로드 설정
const uploadExcel = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const name = file.originalname.toLowerCase();
    if (name.endsWith('.xlsx') || name.endsWith('.xls') || name.endsWith('.csv') ||
        file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
        file.mimetype === 'application/vnd.ms-excel' ||
        file.mimetype === 'text/csv' ||
        file.mimetype === 'application/octet-stream') {
      cb(null, true);
    } else {
      cb(new Error('.xlsx, .xls, .csv 파일만 업로드 가능합니다'));
    }
  }
});

const app = express();
const PORT = process.env.PORT || 8787;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'elevator.db');

app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// 업로드 요청 타임아웃: 10분 (동영상 압축 고려)
app.use((req, res, next) => {
  if (req.path === '/api/upload') {
    req.setTimeout(600000); // 10분
    res.setTimeout(600000);
  }
  next();
});

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

// ── users 테이블 (별도 exec - 기존 DB에 추가) ─────────────────
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  pin TEXT NOT NULL,
  role TEXT DEFAULT 'user' CHECK(role IN ('admin','user')),
  is_active INTEGER DEFAULT 1,
  tab_permissions TEXT DEFAULT NULL,
  last_login DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`);

// ── DB 마이그레이션 (컬럼 자동 추가) ─────────────────────────
const sitesColumns = db.prepare("PRAGMA table_info(sites)").all().map(c => c.name);
if (!sitesColumns.includes('team')) {
  db.exec("ALTER TABLE sites ADD COLUMN team TEXT DEFAULT NULL");
  console.log('[migration] sites 테이블에 team 컬럼 추가됨');
}
if (!sitesColumns.includes('elevator_count')) {
  // elevator_count는 뷰/쿼리로 계산하므로 컬럼 추가 불필요 (s.team 오류 방지용)
}

// elevators 테이블 마이그레이션
const elevatorsColumns = db.prepare("PRAGMA table_info(elevators)").all().map(c => c.name);
const elevColsToAdd = [
  { name: 'load_capacity', type: 'INTEGER DEFAULT NULL' },
  { name: 'speed', type: 'REAL DEFAULT NULL' },
];
for (const col of elevColsToAdd) {
  if (!elevatorsColumns.includes(col.name)) {
    db.exec(`ALTER TABLE elevators ADD COLUMN ${col.name} ${col.type}`);
    console.log(`[migration] elevators 테이블에 ${col.name} 컬럼 추가됨`);
  }
}

// 관리자 계정 초기화 (우경주 / 관리자 / 없으면 생성)
const adminExists = db.prepare("SELECT id FROM users WHERE name=?").get('우경주');
if (!adminExists) {
  db.prepare(`INSERT INTO users (name, pin, role) VALUES (?, ?, 'admin')`).run('우경주', '1234');
  console.log('[init] 관리자 계정 생성: 우경주 (PIN: 1234) - 로그인 후 PIN 변경 권장');
}

// 샘플 데이터 삽입 (DB가 비어있을 경우)
const siteCount = db.prepare('SELECT COUNT(*) as cnt FROM sites').get();
if (siteCount.cnt === 0) {
  db.exec(`
    INSERT INTO sites (site_code, site_name, address, owner_name, owner_phone, manager_name, total_elevators, status) VALUES
    ('S-2024-001', '강남 현대빌딩', '서울시 강남구 테헤란로 123', '김철수', '010-1234-5678', '박영희', 3, 'active'),
    ('S-2024-002', '서초 오피스타워', '서울시 서초구 서초대로 456', '이민준', '010-9876-5432', '최수진', 2, 'active'),
    ('S-2024-003', '마포 주상복합', '서울시 마포구 합정로 789', '정하늘', '010-5555-7777', '윤대호', 4, 'active');

    INSERT INTO elevators (site_id, elevator_no, elevator_name, elevator_type, manufacturer, manufacture_year, install_date, floors_served, capacity, status) VALUES
    (1, 'EL-2020-0001', 'A동 1호기', '승객용', '현대엘리베이터', 2020, '2020-03-15', 'B2~15F', 13, 'normal'),
    (1, 'EL-2020-0002', 'A동 2호기', '승객용', '현대엘리베이터', 2020, '2020-03-15', 'B2~15F', 13, 'warning'),
    (1, 'EL-2021-0003', '화물용 1호기', '화물용', '오티스', 2021, '2021-06-01', 'B1~15F', 0, 'normal'),
    (2, 'EL-2019-0004', '1호기', '승객용', '티센크루프', 2019, '2019-11-20', '1F~20F', 15, 'normal'),
    (2, 'EL-2019-0005', '2호기', '승객용', '티센크루프', 2019, '2019-11-20', '1F~20F', 15, 'fault'),
    (3, 'EL-2022-0006', '101동 1호기', '승객용', '미쓰비시', 2022, '2022-01-10', 'B1~25F', 13, 'normal'),
    (3, 'EL-2022-0007', '101동 2호기', '승객용', '미쓰비시', 2022, '2022-01-10', 'B1~25F', 13, 'normal'),
    (3, 'EL-2022-0008', '102동 1호기', '승객용', '미쓰비시', 2022, '2022-02-15', 'B1~25F', 13, 'normal'),
    (3, 'EL-2022-0009', '장애인용', '장애인용', '쉰들러', 2022, '2022-02-15', '1F~3F', 3, 'normal');

    INSERT INTO inspections (elevator_id, site_id, inspection_type, inspection_date, next_inspection_date, inspector_name, inspection_agency, result) VALUES
    (1, 1, '정기검사', '2024-03-10', '2025-03-10', '홍길동', '한국승강기안전공단', '합격'),
    (2, 1, '정기검사', '2024-03-10', '2025-03-10', '홍길동', '한국승강기안전공단', '조건부합격'),
    (4, 2, '정기검사', '2024-01-15', '2025-01-15', '이순신', '한국승강기안전공단', '합격'),
    (5, 2, '정기검사', '2024-01-15', '2025-01-15', '이순신', '한국승강기안전공단', '불합격');

    INSERT INTO inspection_issues (inspection_id, elevator_id, site_id, issue_no, issue_category, issue_description, severity, status, deadline) VALUES
    (2, 2, 1, 1, '카 내부', '카 내부 조명 불량 - 형광등 2개 미점등', '경결함', '미조치', '2024-06-30'),
    (2, 2, 1, 2, '승강로', '승강로 방화문 틈새 기준 초과 (15mm)', '중결함', '조치중', '2024-05-31'),
    (4, 5, 2, 1, '기계실', '기계실 환기 불량으로 내부 온도 초과', '중결함', '미조치', '2024-05-15'),
    (4, 5, 2, 2, '피트', '피트 침수 흔적 및 녹 발생', '경결함', '미조치', '2024-06-15');
  `);
  console.log('✅ 샘플 데이터 삽입 완료');
}

// ── DB 마이그레이션 (기존 DB에 컬럼 추가) ─────────────────────
const migrateDb = () => {
  const migrations = [
    // inspection_issues: comment, media_urls, elevator_no 추가
    `ALTER TABLE inspection_issues ADD COLUMN comment TEXT`,
    `ALTER TABLE inspection_issues ADD COLUMN media_urls TEXT`,
    `ALTER TABLE inspection_issues ADD COLUMN elevator_no TEXT`,
  ];
  for (const sql of migrations) {
    try { db.exec(sql); } catch (e) { /* 이미 존재하면 무시 */ }
  }
};
migrateDb();

// ── 파일 저장 디렉토리 설정 ───────────────────────────────────
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
app.use('/uploads', express.static(UPLOADS_DIR));

// ── 헬퍼 함수 ─────────────────────────────────────────────────
const wrap = (fn) => async (req, res, next) => {
  try { await fn(req, res, next); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
};

// ── 인증 (Auth) ────────────────────────────────────────────────

// 로그인
app.post('/api/auth/login', wrap((req, res) => {
  const { name, pin } = req.body;
  if (!name || !pin) return res.status(400).json({ success: false, error: '이름과 PIN을 입력해주세요' });

  // tab_permissions 컬럼이 없는 구 DB 대응
  try { db.exec("ALTER TABLE users ADD COLUMN tab_permissions TEXT DEFAULT NULL"); } catch(e) {}

  const user = db.prepare("SELECT * FROM users WHERE name=? AND is_active=1").get(name);
  if (!user) return res.status(401).json({ success: false, error: '등록되지 않은 사용자입니다' });
  if (user.pin !== String(pin)) return res.status(401).json({ success: false, error: 'PIN이 올바르지 않습니다' });

  // 마지막 로그인 시간 업데이트
  db.prepare("UPDATE users SET last_login=CURRENT_TIMESTAMP WHERE id=?").run(user.id);

  res.json({
    success: true,
    user: { id: user.id, name: user.name, role: user.role, tab_permissions: user.tab_permissions || null, last_login: user.last_login }
  });
}));

// 사용자 목록 (관리자용)
app.get('/api/users', wrap((req, res) => {
  // tab_permissions 컬럼이 없는 구 DB 대응: ALTER TABLE로 추가 시도
  try { db.exec("ALTER TABLE users ADD COLUMN tab_permissions TEXT DEFAULT NULL"); } catch(e) {}
  const users = db.prepare("SELECT id, name, role, is_active, tab_permissions, last_login, created_at FROM users ORDER BY role DESC, name ASC").all();
  res.json({ success: true, results: users });
}));

// 사용자 추가 (관리자용)
app.post('/api/users', wrap((req, res) => {
  const { name, pin, role } = req.body;
  if (!name || !pin) return res.status(400).json({ success: false, error: '이름과 PIN을 입력해주세요' });
  if (String(pin).length < 4 || String(pin).length > 6) {
    return res.status(400).json({ success: false, error: 'PIN은 4~6자리여야 합니다' });
  }
  const exists = db.prepare("SELECT id FROM users WHERE name=?").get(name);
  if (exists) return res.status(400).json({ success: false, error: '이미 등록된 이름입니다' });

  const result = db.prepare(
    "INSERT INTO users (name, pin, role) VALUES (?, ?, ?)"
  ).run(name, String(pin), role === 'admin' ? 'admin' : 'user');

  res.json({ success: true, id: result.lastInsertRowid });
}));

// 사용자 수정 (PIN 변경 / 역할 변경 / 활성화 / 탭 권한)
app.put('/api/users/:id', wrap((req, res) => {
  const { pin, role, is_active, tab_permissions } = req.body;
  const user = db.prepare("SELECT * FROM users WHERE id=?").get(req.params.id);
  if (!user) return res.status(404).json({ success: false, error: '사용자를 찾을 수 없습니다' });

  if (pin !== undefined && (String(pin).length < 4 || String(pin).length > 6)) {
    return res.status(400).json({ success: false, error: 'PIN은 4~6자리여야 합니다' });
  }

  db.prepare(`UPDATE users SET
    pin = COALESCE(?, pin),
    role = COALESCE(?, role),
    is_active = COALESCE(?, is_active),
    tab_permissions = CASE WHEN ? IS NOT NULL THEN ? ELSE tab_permissions END,
    updated_at = CURRENT_TIMESTAMP
    WHERE id=?`
  ).run(
    pin !== undefined ? String(pin) : null,
    role || null,
    is_active !== undefined ? (is_active ? 1 : 0) : null,
    tab_permissions !== undefined ? 1 : null,
    tab_permissions !== undefined ? tab_permissions : null,
    req.params.id
  );
  res.json({ success: true });
}));

// 사용자 삭제
app.delete('/api/users/:id', wrap((req, res) => {
  const user = db.prepare("SELECT * FROM users WHERE id=?").get(req.params.id);
  if (!user) return res.status(404).json({ success: false, error: '사용자를 찾을 수 없습니다' });
  if (user.role === 'admin' && user.name === '우경주') {
    return res.status(403).json({ success: false, error: '최고 관리자는 삭제할 수 없습니다' });
  }
  db.prepare("DELETE FROM users WHERE id=?").run(req.params.id);
  res.json({ success: true });
}));

// PIN 변경 (본인)
app.post('/api/auth/change-pin', wrap((req, res) => {
  const { name, current_pin, new_pin } = req.body;
  if (!name || !current_pin || !new_pin) {
    return res.status(400).json({ success: false, error: '필수 정보가 부족합니다' });
  }
  if (String(new_pin).length < 4 || String(new_pin).length > 6) {
    return res.status(400).json({ success: false, error: '새 PIN은 4~6자리여야 합니다' });
  }
  const user = db.prepare("SELECT * FROM users WHERE name=?").get(name);
  if (!user || user.pin !== String(current_pin)) {
    return res.status(401).json({ success: false, error: '현재 PIN이 올바르지 않습니다' });
  }
  db.prepare("UPDATE users SET pin=?, updated_at=CURRENT_TIMESTAMP WHERE name=?").run(String(new_pin), name);
  res.json({ success: true });
}));


app.get('/api/dashboard', wrap((req, res) => {
  const teamFilter = req.query.team || null;  // 팀 필터 파라미터
  const teamWhere = teamFilter ? " AND s.team=?" : "";
  const teamParam = teamFilter ? [teamFilter] : [];
  const teamWhereOnly = teamFilter ? " WHERE s.team=?" : "";

  const sitesCount = teamFilter
    ? db.prepare(`SELECT COUNT(*) as count FROM sites s WHERE s.status='active' AND s.team=?`).get(teamFilter)
    : db.prepare("SELECT COUNT(*) as count FROM sites WHERE status='active'").get();

  const elevatorsCount = teamFilter
    ? db.prepare(`
        SELECT COUNT(*) as count,
        SUM(CASE WHEN e.status='warning' THEN 1 ELSE 0 END) as warning,
        SUM(CASE WHEN e.status='fault' THEN 1 ELSE 0 END) as fault
        FROM elevators e JOIN sites s ON s.id=e.site_id WHERE s.team=?
      `).get(teamFilter)
    : db.prepare(`
    SELECT COUNT(*) as count,
    SUM(CASE WHEN status='warning' THEN 1 ELSE 0 END) as warning,
    SUM(CASE WHEN status='fault' THEN 1 ELSE 0 END) as fault
    FROM elevators
  `).get();
  const pendingIssues = teamFilter
    ? db.prepare(`
        SELECT COUNT(*) as total,
        SUM(CASE WHEN ii.severity='중결함' THEN 1 ELSE 0 END) as critical,
        SUM(CASE WHEN ii.severity='경결함' THEN 1 ELSE 0 END) as minor
        FROM inspection_issues ii JOIN sites s ON s.id=ii.site_id
        WHERE ii.status != '조치완료' AND s.team=?
      `).get(teamFilter)
    : db.prepare(`
    SELECT COUNT(*) as total,
    SUM(CASE WHEN severity='중결함' THEN 1 ELSE 0 END) as critical,
    SUM(CASE WHEN severity='경결함' THEN 1 ELSE 0 END) as minor
    FROM inspection_issues WHERE status != '조치완료'
  `).get();
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const quarter = Math.ceil((now.getMonth() + 1) / 3);

  const monthlyStats = teamFilter
    ? db.prepare(`SELECT COUNT(*) as total, SUM(CASE WHEN mc.status='완료' THEN 1 ELSE 0 END) as done
        FROM monthly_checks mc JOIN sites s ON s.id=mc.site_id
        WHERE mc.check_year=? AND mc.check_month=? AND s.team=?`).get(yyyy, parseInt(mm), teamFilter)
    : db.prepare(
    "SELECT COUNT(*) as total, SUM(CASE WHEN status='완료' THEN 1 ELSE 0 END) as done FROM monthly_checks WHERE check_year=? AND check_month=?"
  ).get(yyyy, parseInt(mm));
  const quarterlyStats = teamFilter
    ? db.prepare(`SELECT COUNT(*) as total, SUM(CASE WHEN qc.status='완료' THEN 1 ELSE 0 END) as done
        FROM quarterly_checks qc JOIN sites s ON s.id=qc.site_id
        WHERE qc.check_year=? AND qc.quarter=? AND s.team=?`).get(yyyy, quarter, teamFilter)
    : db.prepare(
    "SELECT COUNT(*) as total, SUM(CASE WHEN status='완료' THEN 1 ELSE 0 END) as done FROM quarterly_checks WHERE check_year=? AND quarter=?"
  ).get(yyyy, quarter);
  const recentIssues = teamFilter
    ? db.prepare(`
        SELECT ii.id, ii.issue_description, ii.severity, ii.status, ii.deadline,
               s.site_name, e.elevator_name
        FROM inspection_issues ii
        JOIN sites s ON s.id=ii.site_id
        JOIN elevators e ON e.id=ii.elevator_id
        WHERE ii.status != '조치완료' AND s.team=?
        ORDER BY CASE ii.severity WHEN '중결함' THEN 1 WHEN '경결함' THEN 2 ELSE 3 END,
                 ii.deadline ASC LIMIT 5
      `).all(teamFilter)
    : db.prepare(`
    SELECT ii.id, ii.issue_description, ii.severity, ii.status, ii.deadline,
           s.site_name, e.elevator_name
    FROM inspection_issues ii
    JOIN sites s ON s.id=ii.site_id
    JOIN elevators e ON e.id=ii.elevator_id
    WHERE ii.status != '조치완료'
    ORDER BY CASE ii.severity WHEN '중결함' THEN 1 WHEN '경결함' THEN 2 ELSE 3 END,
             ii.deadline ASC LIMIT 5
  `).all();

  // 30일 이내 next_inspection_date 기준 검사 예정 건수
  const today = now.toISOString().slice(0, 10);
  const future30 = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const upcomingInspRow = teamFilter
    ? db.prepare(`
        SELECT COUNT(*) as count FROM inspections i
        LEFT JOIN sites s ON s.id=i.site_id
        WHERE i.next_inspection_date IS NOT NULL
        AND i.next_inspection_date >= ? AND i.next_inspection_date <= ? AND s.team=?
      `).get(today, future30, teamFilter)
    : db.prepare(`
    SELECT COUNT(*) as count FROM inspections
    WHERE next_inspection_date IS NOT NULL
    AND next_inspection_date >= ? AND next_inspection_date <= ?
  `).get(today, future30);
  const upcomingInspections = upcomingInspRow?.count || 0;

  // 다가오는 검사 목록 (30일 이내, 최대 10건)
  const upcomingInspectionList = teamFilter
    ? db.prepare(`
        SELECT i.id, i.inspection_type, i.next_inspection_date,
               i.inspector_name, i.inspection_agency,
               s.site_name, s.id as site_id,
               e.elevator_name, e.elevator_no, e.id as elevator_id,
               CAST(julianday(i.next_inspection_date) - julianday(?) AS INTEGER) as days_remaining
        FROM inspections i
        LEFT JOIN sites s ON s.id = i.site_id
        LEFT JOIN elevators e ON e.id = i.elevator_id
        WHERE i.next_inspection_date IS NOT NULL
        AND i.next_inspection_date >= ? AND i.next_inspection_date <= ? AND s.team=?
        ORDER BY i.next_inspection_date ASC LIMIT 10
      `).all(today, today, future30, teamFilter)
    : db.prepare(`
    SELECT i.id, i.inspection_type, i.next_inspection_date,
           i.inspector_name, i.inspection_agency,
           s.site_name, s.id as site_id,
           e.elevator_name, e.elevator_no, e.id as elevator_id,
           CAST(julianday(i.next_inspection_date) - julianday(?) AS INTEGER) as days_remaining
    FROM inspections i
    LEFT JOIN sites s ON s.id = i.site_id
    LEFT JOIN elevators e ON e.id = i.elevator_id
    WHERE i.next_inspection_date IS NOT NULL
    AND i.next_inspection_date >= ? AND i.next_inspection_date <= ?
    ORDER BY i.next_inspection_date ASC
    LIMIT 10
  `).all(today, today, future30);

  // 팀별 통계
  const teamStats = db.prepare(`
    SELECT s.team,
      COUNT(DISTINCT s.id) as site_count,
      COUNT(DISTINCT e.id) as elevator_count,
      SUM(CASE WHEN e.status='fault' THEN 1 ELSE 0 END) as fault_count,
      SUM(CASE WHEN e.status='warning' THEN 1 ELSE 0 END) as warning_count,
      SUM(CASE WHEN ii.status != '조치완료' THEN 1 ELSE 0 END) as pending_issues,
      SUM(CASE WHEN ii.severity='중결함' AND ii.status != '조치완료' THEN 1 ELSE 0 END) as critical_issues
    FROM sites s
    LEFT JOIN elevators e ON e.site_id = s.id
    LEFT JOIN inspection_issues ii ON ii.site_id = s.id AND ii.status != '조치완료'
    WHERE s.status = 'active' AND s.team IS NOT NULL
    GROUP BY s.team
    ORDER BY s.team
  `).all();

  res.json({ success: true, data: { sites: sitesCount?.count || 0, elevators: elevatorsCount, pendingIssues, monthlyStats, quarterlyStats, recentIssues, upcomingInspections, upcomingInspectionList, teamStats } });
}));

// ── 현장(Sites) ───────────────────────────────────────────────
app.get('/api/sites', wrap((req, res) => {
  const { search, status, team } = req.query;
  let sql = `SELECT s.*, COUNT(e.id) as elevator_count FROM sites s LEFT JOIN elevators e ON e.site_id=s.id`;
  const params = [];
  const where = [];
  if (search) { where.push("(s.site_name LIKE ? OR s.site_code LIKE ? OR s.address LIKE ?)"); params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
  if (status) { where.push("s.status=?"); params.push(status); }
  if (team) { where.push("s.team=?"); params.push(team); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' GROUP BY s.id ORDER BY s.id ASC';
  res.json({ success: true, results: db.prepare(sql).all(...params) });
}));

// 팀 목록 조회
app.get('/api/teams', wrap((req, res) => {
  // sites 테이블의 팀 + 별도 teams 테이블 팀을 합쳐서 반환
  const fromSites = db.prepare("SELECT DISTINCT team FROM sites WHERE team IS NOT NULL").all().map(r => r.team);
  let fromTeamsTable = [];
  try {
    fromTeamsTable = db.prepare("SELECT name FROM teams").all().map(r => r.name);
  } catch(_) {}
  const merged = [...new Set([...fromSites, ...fromTeamsTable])].sort();
  res.json({ success: true, teams: merged });
}));

// 새 팀 이름 등록 (해당 팀이 없으면 추가만 기록 - 실제 사이트 없어도 팀 목록에 표시)
app.post('/api/teams', wrap((req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ success: false, error: '팀 이름이 없습니다' });
  const teamName = name.trim();
  // 이미 존재하는지 확인
  const existing = db.prepare("SELECT DISTINCT team FROM sites WHERE team=?").get(teamName);
  if (existing) return res.json({ success: true, message: '이미 존재하는 팀입니다', team: teamName });
  // teams 테이블이 없으면 sites 기반으로만 관리 → 빈 팀을 sites에 placeholder로 넣지 않고
  // 별도 teams 테이블 생성
  db.prepare(`CREATE TABLE IF NOT EXISTS teams (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`).run();
  db.prepare(`INSERT OR IGNORE INTO teams (name) VALUES (?)`).run(teamName);
  res.json({ success: true, team: teamName });
}));

app.get('/api/sites/:id', wrap((req, res) => {
  const site = db.prepare('SELECT * FROM sites WHERE id=?').get(req.params.id);
  if (!site) return res.status(404).json({ success: false, error: '현장을 찾을 수 없습니다' });
  res.json({ success: true, result: site });
}));

app.post('/api/sites', wrap((req, res) => {
  const { site_code, site_name, address, owner_name, owner_phone, manager_name, total_elevators, status, contract_start, contract_end, notes, team } = req.body;
  const r = db.prepare(`INSERT INTO sites (site_code, site_name, address, owner_name, owner_phone, manager_name, total_elevators, status, contract_start, contract_end, notes, team) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(site_code, site_name, address, owner_name || null, owner_phone || null, manager_name || null, total_elevators || 0, status || 'active', contract_start || null, contract_end || null, notes || null, team || '파주1팀');
  res.json({ success: true, id: r.lastInsertRowid });
}));

app.put('/api/sites/:id', wrap((req, res) => {
  const { site_code, site_name, address, owner_name, owner_phone, manager_name, total_elevators, status, contract_start, contract_end, notes, team } = req.body;
  db.prepare(`UPDATE sites SET site_code=?, site_name=?, address=?, owner_name=?, owner_phone=?, manager_name=?, total_elevators=?, status=?, contract_start=?, contract_end=?, notes=?, team=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(site_code, site_name, address, owner_name || null, owner_phone || null, manager_name || null, total_elevators || 0, status || 'active', contract_start || null, contract_end || null, notes || null, team || '파주1팀', req.params.id);
  res.json({ success: true });
}));

// ── 현장 대량 등록 (엑셀/텍스트) ─────────────────────────────
app.post('/api/sites/import', wrap((req, res) => {
  const { sites, team } = req.body;
  if (!Array.isArray(sites) || sites.length === 0) {
    return res.status(400).json({ success: false, error: '등록할 현장 데이터가 없습니다' });
  }
  const insertStmt = db.prepare(
    `INSERT INTO sites (site_code, site_name, address, owner_name, owner_phone, manager_name, total_elevators, status, contract_start, notes, team)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`
  );
  const inserted = [];
  const errors = [];
  const importTeam = team || '파주1팀';
  const importMany = db.transaction((rows) => {
    for (const row of rows) {
      try {
        // site_code 자동 생성
        const code = row.site_code || `S-${Date.now()}-${Math.floor(Math.random()*9000+1000)}`;
        const r = insertStmt.run(
          code,
          row.site_name || '',
          row.address || '',
          row.owner_name || null,
          row.owner_phone || null,
          row.manager_name || null,
          parseInt(row.total_elevators) || 1,
          row.contract_start || null,
          row.notes || null,
          importTeam
        );
        inserted.push({ id: r.lastInsertRowid, site_name: row.site_name, site_code: code });
      } catch (e) {
        errors.push({ site_name: row.site_name, error: e.message });
      }
    }
  });
  importMany(sites);
  res.json({
    success: true,
    inserted: inserted.length,
    errors: errors.length,
    insertedList: inserted,
    errorList: errors
  });
}));

app.delete('/api/sites/:id', wrap((req, res) => {
  db.prepare('DELETE FROM sites WHERE id=?').run(req.params.id);
  res.json({ success: true });
}));

// ── 승강기(Elevators) ─────────────────────────────────────────

// 엑셀 파일 파싱 → 현장 데이터 미리보기 (저장 안 함)
app.post('/api/sites/parse-excel', uploadExcel.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: '파일이 없습니다' });
    const ext = path.extname(req.file.originalname).toLowerCase();
    let sites = [];

    if (ext === '.xlsx' || ext === '.xls') {
      // 엑셀 파싱
      const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
      if (rows.length < 2) return res.json({ success: true, sites: [] });

      // 헤더 행 감지 (첫 번째 행)
      const header = rows[0].map(h => String(h).trim().toLowerCase());
      const colMap = {
        site_name: header.findIndex(h => h.includes('현장') || h.includes('사이트') || h.includes('건물') || h.includes('명칭') || h === 'name'),
        address: header.findIndex(h => h.includes('주소') || h.includes('address')),
        owner_name: header.findIndex(h => h.includes('소유') || h.includes('건물주') || h.includes('owner')),
        owner_phone: header.findIndex(h => (h.includes('소유') && h.includes('전화')) || h.includes('연락처') || h.includes('phone')),
        manager_name: header.findIndex(h => h.includes('담당') || h.includes('관리자') || h.includes('manager')),
        total_elevators: header.findIndex(h => h.includes('대수') || h.includes('승강기') || h.includes('elevator')),
        contract_start: header.findIndex(h => h.includes('계약') || h.includes('contract')),
        notes: header.findIndex(h => h.includes('비고') || h.includes('메모') || h.includes('note')),
      };

      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const siteName = colMap.site_name >= 0 ? String(row[colMap.site_name] || '').trim() : String(row[0] || '').trim();
        if (!siteName) continue;
        sites.push({
          site_name: siteName,
          address: colMap.address >= 0 ? String(row[colMap.address] || '').trim() : (String(row[1] || '').trim()),
          owner_name: colMap.owner_name >= 0 ? String(row[colMap.owner_name] || '').trim() : '',
          owner_phone: colMap.owner_phone >= 0 ? String(row[colMap.owner_phone] || '').trim() : '',
          manager_name: colMap.manager_name >= 0 ? String(row[colMap.manager_name] || '').trim() : '',
          total_elevators: colMap.total_elevators >= 0 ? parseInt(row[colMap.total_elevators]) || 1 : 1,
          contract_start: colMap.contract_start >= 0 ? String(row[colMap.contract_start] || '').trim() : '',
          notes: colMap.notes >= 0 ? String(row[colMap.notes] || '').trim() : '',
        });
      }
    } else if (ext === '.csv') {
      // CSV 파싱 (XLSX 라이브러리로도 가능)
      const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
      if (rows.length < 2) return res.json({ success: true, sites: [] });
      const header = rows[0].map(h => String(h).trim().toLowerCase());
      const colSiteName = header.findIndex(h => h.includes('현장') || h.includes('건물') || h === 'name');
      const colAddr = header.findIndex(h => h.includes('주소'));
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const siteName = colSiteName >= 0 ? String(row[colSiteName] || '').trim() : String(row[0] || '').trim();
        if (!siteName) continue;
        sites.push({
          site_name: siteName,
          address: colAddr >= 0 ? String(row[colAddr] || '').trim() : (String(row[1] || '').trim()),
          owner_name: '', owner_phone: '', manager_name: '',
          total_elevators: 1, contract_start: '', notes: '',
        });
      }
    } else {
      return res.status(400).json({ success: false, error: '.xlsx, .xls, .csv 파일만 지원합니다' });
    }

    res.json({ success: true, sites, count: sites.length });
  } catch (e) {
    console.error('엑셀 파싱 오류:', e);
    res.status(500).json({ success: false, error: '파일 파싱 실패: ' + e.message });
  }
});

// 텍스트 파싱 → 현장 데이터 미리보기
app.post('/api/sites/parse-text', wrap((req, res) => {
  const { text, team } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ success: false, error: '텍스트가 없습니다' });

  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const sites = [];

  for (const line of lines) {
    // 탭 또는 쉼표로 구분된 형식 처리
    // 형식1: 현장명\t주소\t담당자\t대수
    // 형식2: 현장명,주소,담당자,대수
    // 형식3: 현장명만
    const parts = line.includes('\t') ? line.split('\t') : line.split(',');
    const siteName = parts[0]?.trim();
    if (!siteName || siteName.startsWith('#') || siteName.startsWith('//')) continue;

    sites.push({
      site_name: siteName,
      address: parts[1]?.trim() || '',
      manager_name: parts[2]?.trim() || '',
      total_elevators: parseInt(parts[3]) || 1,
      owner_name: parts[4]?.trim() || '',
      owner_phone: parts[5]?.trim() || '',
      contract_start: parts[6]?.trim() || '',
      notes: parts[7]?.trim() || '',
    });
  }

  res.json({ success: true, sites, count: sites.length });
}));

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
}));

app.put('/api/elevators/:id', wrap((req, res) => {
  const { site_id, elevator_no, elevator_name, elevator_type, manufacturer, manufacture_year, install_date, floors_served, capacity, load_capacity, speed, status, notes } = req.body;
  db.prepare(`UPDATE elevators SET site_id=?, elevator_no=?, elevator_name=?, elevator_type=?, manufacturer=?, manufacture_year=?, install_date=?, floors_served=?, capacity=?, load_capacity=?, speed=?, status=?, notes=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(site_id, elevator_no, elevator_name || null, elevator_type || '승객용', manufacturer || null, manufacture_year || null, install_date || null, floors_served || null, capacity || null, load_capacity || null, speed || null, status || 'normal', notes || null, req.params.id);
  res.json({ success: true });
}));

app.delete('/api/elevators/:id', wrap((req, res) => {
  db.prepare('DELETE FROM elevators WHERE id=?').run(req.params.id);
  res.json({ success: true });
}));

// ── 검사(Inspections) ─────────────────────────────────────────
app.get('/api/inspections', wrap((req, res) => {
  const { site_id, elevator_id, result, inspection_type } = req.query;
  let sql = `SELECT i.*, s.site_name, s.team, e.elevator_name, e.elevator_no FROM inspections i LEFT JOIN sites s ON s.id=i.site_id LEFT JOIN elevators e ON e.id=i.elevator_id`;
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
  const item = db.prepare('SELECT i.*, s.site_name, s.team, e.elevator_name FROM inspections i LEFT JOIN sites s ON s.id=i.site_id LEFT JOIN elevators e ON e.id=i.elevator_id WHERE i.id=?').get(req.params.id);
  if (!item) return res.status(404).json({ success: false, error: '검사를 찾을 수 없습니다' });
  res.json({ success: true, result: item });
}));

app.post('/api/inspections', wrap((req, res) => {
  const { elevator_id, site_id, inspection_type, inspection_date, next_inspection_date, inspector_name, inspection_agency, result, report_no, notes } = req.body;
  const r = db.prepare(`INSERT INTO inspections (elevator_id, site_id, inspection_type, inspection_date, next_inspection_date, inspector_name, inspection_agency, result, report_no, notes) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(elevator_id, site_id, inspection_type, inspection_date, next_inspection_date || null, inspector_name || null, inspection_agency || null, result || '합격', report_no || null, notes || null);
  res.json({ success: true, id: r.lastInsertRowid });
}));

app.put('/api/inspections/:id', wrap((req, res) => {
  const { elevator_id, site_id, inspection_type, inspection_date, next_inspection_date, inspector_name, inspection_agency, result, report_no, notes } = req.body;
  db.prepare(`UPDATE inspections SET elevator_id=?, site_id=?, inspection_type=?, inspection_date=?, next_inspection_date=?, inspector_name=?, inspection_agency=?, result=?, report_no=?, notes=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(elevator_id, site_id, inspection_type, inspection_date, next_inspection_date || null, inspector_name || null, inspection_agency || null, result || '합격', report_no || null, notes || null, req.params.id);
  res.json({ success: true });
}));

app.delete('/api/inspections/:id', wrap((req, res) => {
  db.prepare('DELETE FROM inspections WHERE id=?').run(req.params.id);
  res.json({ success: true });
}));

// ── 지적사항(Issues) ──────────────────────────────────────────
app.get('/api/issues', wrap((req, res) => {
  const { site_id, elevator_id, status, severity, inspection_id } = req.query;
  let sql = `SELECT ii.*, s.site_name, s.team, e.elevator_name FROM inspection_issues ii LEFT JOIN sites s ON s.id=ii.site_id LEFT JOIN elevators e ON e.id=ii.elevator_id`;
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
  const item = db.prepare('SELECT ii.*, s.site_name, s.team, e.elevator_name FROM inspection_issues ii LEFT JOIN sites s ON s.id=ii.site_id LEFT JOIN elevators e ON e.id=ii.elevator_id WHERE ii.id=?').get(req.params.id);
  if (!item) return res.status(404).json({ success: false, error: '지적사항을 찾을 수 없습니다' });
  res.json({ success: true, result: item });
}));

app.post('/api/issues', wrap((req, res) => {
  const { inspection_id, elevator_id, site_id, issue_no, issue_category, issue_description, legal_basis, severity, status, action_required, deadline, inspection_date, inspector_name, comment, media_urls, elevator_no } = req.body;
  const r = db.prepare(`INSERT INTO inspection_issues (inspection_id, elevator_id, site_id, issue_no, issue_category, issue_description, legal_basis, severity, status, action_required, deadline, inspection_date, inspector_name, comment, media_urls, elevator_no) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(inspection_id || null, elevator_id, site_id, issue_no || 1, issue_category || null, issue_description, legal_basis || null, severity || '경결함', status || '미조치', action_required || null, deadline || null, inspection_date || null, inspector_name || null, comment || null, media_urls || null, elevator_no || null);
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
}));

app.patch('/api/issues/:id/action', wrap((req, res) => {
  const { status, action_taken, action_date, action_by, photo_before, photo_after } = req.body;
  db.prepare(`UPDATE inspection_issues SET status=?, action_taken=?, action_date=?, action_by=?, photo_before=?, photo_after=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(status || '조치완료', action_taken || null, action_date || null, action_by || null, photo_before || null, photo_after || null, req.params.id);
  res.json({ success: true });
}));

app.put('/api/issues/:id', wrap((req, res) => {
  const { issue_category, issue_description, legal_basis, severity, status, action_required, action_taken, action_date, action_by, deadline, inspection_date, inspector_name, comment, media_urls, elevator_no } = req.body;
  db.prepare(`UPDATE inspection_issues SET issue_category=?, issue_description=?, legal_basis=?, severity=?, status=?, action_required=?, action_taken=?, action_date=?, action_by=?, deadline=?, inspection_date=?, inspector_name=?, comment=?, media_urls=?, elevator_no=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(issue_category || null, issue_description, legal_basis || null, severity || '경결함', status || '미조치', action_required || null, action_taken || null, action_date || null, action_by || null, deadline || null, inspection_date || null, inspector_name || null, comment || null, media_urls || null, elevator_no || null, req.params.id);
  res.json({ success: true });
}));

app.delete('/api/issues/:id', wrap((req, res) => {
  db.prepare('DELETE FROM inspection_issues WHERE id=?').run(req.params.id);
  res.json({ success: true });
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

// ── 파일 업로드 (이미지/동영상) ──────────────────────────────
app.post('/api/upload', upload.array('files', 20), async (req, res) => {
  try {
    const files = req.files;
    if (!files || files.length === 0) {
      return res.status(400).json({ success: false, error: '파일이 없습니다' });
    }
    const urls = [];
    for (const file of files) {
      const ext = path.extname(file.originalname).toLowerCase() || '.bin';
      const baseName = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const isImage = /\.(jpg|jpeg|png|gif|webp|bmp|tiff?)$/i.test(file.originalname) ||
                      file.mimetype.startsWith('image/');
      const isVideo = /\.(mp4|mov|avi|webm|3gp)$/i.test(file.originalname) ||
                      file.mimetype.startsWith('video/');

      let saveBuffer = file.buffer;
      let saveExt = ext;

      // 이미지 자동 압축: 10MB 초과 시 JPEG로 재압축 (최대 1920px, 품질 82)
      if (isImage && file.buffer.length > 10 * 1024 * 1024) {
        try {
          const originalKB = (file.buffer.length / 1024 / 1024).toFixed(1);
          let quality = 82;
          let compressed = await sharp(file.buffer)
            .rotate() // EXIF 방향 자동 보정
            .resize({ width: 1920, height: 1920, fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality })
            .toBuffer();

          // 여전히 크면 품질 추가 감소
          if (compressed.length > 5 * 1024 * 1024) {
            compressed = await sharp(file.buffer)
              .rotate()
              .resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true })
              .jpeg({ quality: 70 })
              .toBuffer();
          }
          const compressedMB = (compressed.length / 1024 / 1024).toFixed(1);
          console.log(`[compress] ${file.originalname}: ${originalKB}MB → ${compressedMB}MB`);
          saveBuffer = compressed;
          saveExt = '.jpg';
        } catch (compErr) {
          console.warn('[compress] 압축 실패, 원본 저장:', compErr.message);
          // 압축 실패 시 원본 사용
        }
      }

      // 동영상 자동 압축: 50MB 초과 시만 ffmpeg으로 재압축 (최대 1280x720, 비트레이트 1500k)
      // 50MB 이하는 압축 없이 그대로 저장 (속도 우선)
      if (isVideo && file.buffer.length > 50 * 1024 * 1024) {
        try {
          const compressed = await compressVideo(file.buffer, file.originalname);
          // 압축 후 크기가 원본보다 작을 때만 적용
          if (compressed.length < file.buffer.length) {
            saveBuffer = compressed;
            saveExt = '.mp4';
          }
        } catch (compErr) {
          console.warn('[video compress] 압축 실패, 원본 저장:', compErr.message);
          // 압축 실패 시 원본 사용
        }
      }

      const filename = `${baseName}${saveExt}`;
      const savePath = path.join(UPLOADS_DIR, filename);
      fs.writeFileSync(savePath, saveBuffer);
      urls.push(`/uploads/${filename}`);
    }
    res.json({ success: true, urls });
  } catch (err) {
    console.error('[upload] error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── 월 점검(Monthly) ──────────────────────────────────────────
app.get('/api/monthly', wrap((req, res) => {
  const { site_id, elevator_id, check_year, check_month, status, team } = req.query;
  let sql = `SELECT mc.*, s.site_name, s.team, e.elevator_name, e.elevator_no FROM monthly_checks mc LEFT JOIN sites s ON s.id=mc.site_id LEFT JOIN elevators e ON e.id=mc.elevator_id`;
  const params = [];
  const where = [];
  if (site_id) { where.push('mc.site_id=?'); params.push(site_id); }
  if (elevator_id) { where.push('mc.elevator_id=?'); params.push(elevator_id); }
  if (check_year) { where.push('mc.check_year=?'); params.push(check_year); }
  if (check_month) { where.push('mc.check_month=?'); params.push(check_month); }
  if (status) { where.push('mc.status=?'); params.push(status); }
  if (team) { where.push('s.team=?'); params.push(team); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY s.site_name ASC, e.elevator_no ASC, mc.created_at DESC';
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
}));

app.put('/api/monthly/:id', wrap((req, res) => {
  const { check_date, checker_name, status, door_check, motor_check, brake_check, rope_check, safety_device_check, lighting_check, emergency_check, overall_result, issues_found, actions_taken, next_action, notes } = req.body;
  db.prepare(`UPDATE monthly_checks SET check_date=?, checker_name=?, status=?, door_check=?, motor_check=?, brake_check=?, rope_check=?, safety_device_check=?, lighting_check=?, emergency_check=?, overall_result=?, issues_found=?, actions_taken=?, next_action=?, notes=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(check_date || null, checker_name || null, status || '예정', door_check || '양호', motor_check || '양호', brake_check || '양호', rope_check || '양호', safety_device_check || '양호', lighting_check || '양호', emergency_check || '양호', overall_result || '양호', issues_found || null, actions_taken || null, next_action || null, notes || null, req.params.id);
  res.json({ success: true });
}));

app.delete('/api/monthly/:id', wrap((req, res) => {
  db.prepare('DELETE FROM monthly_checks WHERE id=?').run(req.params.id);
  res.json({ success: true });
}));

// ── 분기 점검(Quarterly) ──────────────────────────────────────
app.get('/api/quarterly', wrap((req, res) => {
  const { site_id, elevator_id, check_year, quarter, status } = req.query;
  let sql = `SELECT qc.*, s.site_name, s.team, e.elevator_name FROM quarterly_checks qc LEFT JOIN sites s ON s.id=qc.site_id LEFT JOIN elevators e ON e.id=qc.elevator_id`;
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
  const item = db.prepare('SELECT qc.*, s.site_name, s.team, e.elevator_name FROM quarterly_checks qc LEFT JOIN sites s ON s.id=qc.site_id LEFT JOIN elevators e ON e.id=qc.elevator_id WHERE qc.id=?').get(req.params.id);
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

// ── 서버 시작 ──────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ API 서버 시작: http://0.0.0.0:${PORT}`);
});
