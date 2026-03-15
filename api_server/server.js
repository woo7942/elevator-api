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
// 파주1팀 / 파주2팀 완전 시드 데이터 (서버 재시작 시 자동복구)
// ════════════════════════════════════════════════════════════════
const PAJU1_SEED = [
  {name:'교하대원효성아파트',address:'경기도 파주시 청석로 300',phone:null,elevators:45},
  {name:'교하토우프라자',address:'경기도 파주시 숲속노을로 265',phone:'010-5345-4832',elevators:1},
  {name:'진원빌딩',address:'경기도 파주시 숲속노을로 275',phone:'010-8708-4034',elevators:2},
  {name:'대경주차빌딩',address:'경기도 파주시 청석로 307',phone:'010-9140-5450',elevators:1},
  {name:'물푸레도서관',address:'경기도 파주시 청석로 360',phone:'010-6623-5351',elevators:1},
  {name:'엘엠시트',address:'경기도 파주시 돌단풍길64',phone:'010-9168-3310',elevators:1},
  {name:'새중앙교회',address:'경기도 파주시 노을빛로38',phone:'010-4157-8807',elevators:1},
  {name:'린타워',address:'경기도 파주시 책향기로277',phone:'010-5730-5382',elevators:1},
  {name:'교하동산14-1',address:'경기도 파주시 천정구로201',phone:'010-5352-1440',elevators:1},
  {name:'문발동573-3',address:'경기도 파주시 꽃창포길49',phone:'010-8776-9196',elevators:1},
  {name:'보성팰리스',address:'경기도 파주시 동편길3',phone:'010-5670-2021',elevators:1},
  {name:'에코빌101동',address:'경기도 파주시 교하로 933',phone:'010-9796-8886',elevators:1},
  {name:'에코빌 102동',address:'경기도 파주시 교하로 933',phone:'010-7768-1126',elevators:1},
  {name:'에코빌 103동',address:'경기도 파주시 교하로 933',phone:'010-9922-3274',elevators:1},
  {name:'현장명',address:'주소',phone:'연락처',elevators:3},
  {name:'시그네틱스(주)파주공장',address:'경기도 파주시 탄현면 평화로 711',phone:null,elevators:5},
  {name:'정원갤러리',address:'경기도 파주시 탄현면 헤이리마을길 32',phone:'010-5259-8100',elevators:1},
  {name:'촬영아카데미',address:'경기도 파주시 탄현면 헤이리마을길 26',phone:'010-5328-9019',elevators:1},
  {name:'파주개성요양병원',address:'경기도 파주시 하지석길 45',phone:'070-8685-6600',elevators:1},
  {name:'하이디하우스',address:'경기도 파주시 탄현면 헤이리마을길 76-95',phone:'010-7937-1789',elevators:1},
  {name:'한향림도자미술관',address:'경기도 파주시 탄현면 헤이리마을길 82-37',phone:'010-3626-6676',elevators:1},
  {name:'호텔 U&I',address:'경기도 파주시 탄현면 성동리 124-19',phone:'010-8926-8919',elevators:1},
  {name:'화이트블록',address:'경기도 파주시 탄현면 헤이리마을길 72',phone:'031-992-4400',elevators:1},
  {name:'(주)류재은베이커리',address:'경기도 파주시 탄현면 요풍길 265',phone:'010-9763-5014',elevators:1},
  {name:'느림보출판사',address:'경기도 파주시 탄현면 헤이리마을길 48-45',phone:'010-3061-5986',elevators:1},
  {name:'법흥리497-105외1',address:'경기도 파주시 법흥로88',phone:'010-8304-4936',elevators:1},
  {name:'창비창고시설',address:'파주시 헤이리로133번길63',phone:'010-4136-5975',elevators:1},
  {name:'덕이동',address:'주소 미입력',phone:null,elevators:1},
  {name:'아이산 산부인과',address:'경기도 고양시 일산서구 덕이로 10',phone:'010-5217-8182',elevators:2},
  {name:'아이산 산후조리원',address:'경기도 고양시 일산서구 덕이로 8',phone:'010-5217-8182',elevators:1},
  {name:'(주)까사미아파주사옥',address:'경기도 파주시 문발로 127',phone:'010-3016-9102',elevators:1},
  {name:'세종출판벤쳐타운',address:'경기도 파주시 문발로 115',phone:'010-8025-6173',elevators:1},
  {name:'스튜디오5274',address:'경기도 파주시 회동길 57-23',phone:'010-3681-6270',elevators:1},
  {name:'효남빌딩',address:'경기도 파주시 회동길 77-3',phone:'010-2369-8627',elevators:1},
  {name:'작가세계',address:'경기도 파주시 회동길 37-14',phone:'010-2369-8627(키움빌딩관리)',elevators:1},
  {name:'고래곰나비',address:'경기도 파주시 문발로 139 (문발동)',phone:'010-2369-8627(키움빌딩관리)',elevators:1},
  {name:'베네피아',address:'경기도 파주시 문발로 129',phone:'010-5899-1516',elevators:2},
  {name:'(주)다락원',address:'경기도 파주시 문발로 211',phone:null,elevators:1},
  {name:'(주)도서출판보리',address:'경기도 파주시 직지길 492',phone:'010-3579-3328',elevators:1},
  {name:'(주)도서출판한길사',address:'경기도 파주시 광인사길 37',phone:'031-955-2001',elevators:1},
  {name:'논장사옥',address:'경기도 파주시 회동길 329',phone:'010-8834-3888',elevators:1},
  {name:'도서출판흙마당',address:'경기도 파주시 회동길 373',phone:'010-2276-5190',elevators:1},
  {name:'레인보우 사옥',address:'경기도 파주시 회동길 363-21',phone:'010-8870-0321',elevators:1},
  {name:'성지문화사',address:'경기도 파주시 광인사길 68',phone:'010-2369-8627(키움빌딩관리)',elevators:1},
  {name:'아시아출판문화정보센타',address:'경기도 파주시 회동길 145',phone:'010-9162-0494',elevators:1},
  {name:'열화당사옥',address:'경기도 파주시 광인사길 25',phone:'010-4571-0135',elevators:2},
  {name:'썸북스',address:'경기도 파주시 서패동472-4',phone:'010-5844-3509',elevators:1},
  {name:'타이포그라피',address:'경기도 파주시 회동길 330',phone:'010-3993-3437',elevators:1},
  {name:'토마토하우스',address:'경기도 파주시 회동길 325-6',phone:'010-2369-8627(키움빌딩관리)',elevators:1},
  {name:'파주2단지푸른사상사옥',address:'경기도 파주시 회동길 337-16',phone:'010-2369-8627(키움빌딩관리)',elevators:1},
  {name:'뜨인돌출판사사옥',address:'경기도 파주시 회동길 337-9',phone:'010-2369-5627(키움빌딩관리)',elevators:1},
  {name:'날마다 출판사',address:'경기도 파주시 회동길 513',phone:'010-2369-8627(키움빌딩관리)',elevators:1},
  {name:'리버인더로스팅',address:'경기도 파주시 지목로 9',phone:'010-2330-0197',elevators:1},
  {name:'아카넷사옥',address:'경기도 파주시 회동길 445-3',phone:'010-3282-8981',elevators:1},
  {name:'신촌동168-4',address:'경기도 파주시 168-4',phone:'010-6363-3616',elevators:1},
  {name:'(주)예인미술',address:'경기도 파주시 문발로 459',phone:'010-9900-9356',elevators:1},
  {name:'RH스튜디오',address:'경기도 파주시 회동길 503-3',phone:'010-2369-8627키움빌딩관리',elevators:1},
  {name:'싱크피쉬',address:'경기도 파주시 회동길 530-19',phone:'010-3640-5220',elevators:1},
  {name:'문학수첩',address:'경기도 파주시 문발동 633-4',phone:'031-955-9088',elevators:1},
  {name:'동양미디어사옥',address:'경기도 파주시 회동길 512',phone:'010-2369-8627(키움빌딩관리)',elevators:2},
  {name:'디자인비따사옥',address:'경기도 파주시 회동길 446',phone:'010-9357-6791',elevators:1},
  {name:'문발동75-32(아이빅테크)',address:'경기도 파주시 지목로 112-1',phone:'010-5265-5946',elevators:1},
  {name:'(주)코바스',address:'경기도 파주시 신촌로 43',phone:'010-6657-7911',elevators:1},
  {name:'그린빌원룸',address:'경기도 파주시 지목로 25-28',phone:'010-5340-5571',elevators:1},
  {name:'문발동 73-18 근생',address:'경기도 파주시 교하로 891-2',phone:'010-8428-8288',elevators:1},
  {name:'신촌동60-8근생',address:'경기도 파주시 지목로 89-24',phone:'010-9012-1165',elevators:1},
  {name:'은진빌리지(문발동 73-17)',address:'경기도 파주시 교하로 891-10',phone:'010-5276-1472',elevators:1},
  {name:'서패동188-1(언글래마우스)',address:'경기 파주시 서패동 188-1',phone:'010-4743-3155',elevators:1},
  {name:'서패동178-7',address:'경기도 파주시 서패동178-7',phone:'010-5355-4588',elevators:1},
  {name:'서패동240-6',address:'경기도 파주시 서패동240-6',phone:null,elevators:1},
  {name:'서패동245',address:'경기도 파주시 서패동245',phone:null,elevators:1},
  {name:'그룹에이치컴퍼니',address:'경기도 파주시 회동길 521-1',phone:'010-4024-3503',elevators:1},
  {name:'비주프린팅사옥',address:'경기도 파주시 재두루미길 90',phone:'010-5440-1557',elevators:1},
  {name:'씨앤톡사옥',address:'경기도 파주시 문발로 405',phone:'010-3752-1738',elevators:1},
  {name:'예림인쇄사옥',address:'경기도 파주시 문발로 435-1',phone:'010-2102-0824',elevators:1},
  {name:'신촌동40-19',address:'경기도 파주시 지목로139-18',phone:null,elevators:1},
  {name:'송촌동618-12',address:'파주시 소라지로 299-9',phone:'010-6203-5099',elevators:1},
  {name:'MAXCIO',address:'파주시 소라지로 263번길 23-15',phone:'010-4860-2986',elevators:1},
  {name:'MAXCIO G.spce',address:'파주시 소라지로 263번길 23-11',phone:'010-4860-2986',elevators:1},
  {name:'톡사옥',address:'경기도 파주시 심학산로8',phone:'010-2369-8627',elevators:1},
  {name:'송촌동 578-49',address:'경기 파주시 소라지로 235',phone:'010-9492-4535',elevators:1},
  {name:'목동동1019-2(2.5.8.11)',address:'산내로123번길6-20',phone:'010-8920-7128',elevators:1},
  {name:'목동동1031-4',address:'교하로133번길39',phone:'010-3723-6632',elevators:1},
  {name:'목동동 1065-2',address:'산내로7번길25-17',phone:'010-5347-0321',elevators:1},
  {name:'목동동1065-3(2,4,6,8,10,12)',address:'산내로7번길25-19',phone:'010-5904-5129',elevators:1},
  {name:'목동동1067-4',address:'산내로7번길7',phone:'010-5592-5622',elevators:1},
  {name:'목동동1067-8',address:'산내로7번길7-4',phone:'010-5818-3139',elevators:1},
  {name:'목동동1067-9(2,5,8,11)전화후',address:'산내로7번길7-5',phone:'010-5169-6093',elevators:1},
  {name:'목동동1069(2,5,8,11)',address:'산내로7번길25-7',phone:'010-8706-8500',elevators:1},
  {name:'목동동1069-2 보통식당',address:'산내로7번길 25-1',phone:'010-9947-0575',elevators:1},
  {name:'대웅주택',address:'와석순환로252번길7-9',phone:'01042548866',elevators:1},
  {name:'프랑프랑',address:'와석순환로252번길7-1',phone:'010-4231-6009',elevators:1},
  {name:'목동동1105-5(2,5,8,11)',address:'와석순환로252번길7-23',phone:'010-6794-8522',elevators:1},
  {name:'목동동1107-2(1,4,7,10)',address:'와석순환로252번길7-31',phone:'010-3676-9931',elevators:1},
  {name:'목동동1107-7',address:'와석순환로252번길7-41',phone:'010-6559-1378',elevators:1},
  {name:'목동동1109-3',address:'심학산로423번길12-12',phone:'010-2124-0616',elevators:1},
  {name:'목동동1115-1',address:'심학산로423번길12-4',phone:'010-9277-7461',elevators:1},
  {name:'캔빌(3,6,9,12)',address:'심학산로423번길12-8',phone:'010-3357-2885',elevators:1},
  {name:'목동동1115-4(1,4,7,10)',address:'심학산로423번길12-10',phone:'010-7235-6933',elevators:1},
  {name:'목동동1112-5',address:'심학산로423번길 12-1',phone:'010-6234-1705',elevators:1},
  {name:'목동동1122-1',address:'와석순환로252번길14',phone:'010-4313-6009',elevators:1},
  {name:'목동동1127-6',address:'심학산로423번길 13-8',phone:'010-5818-3139',elevators:1},
  {name:'목동동1127-7(3,6,9,12)',address:'심학산로423번길13-10',phone:'010-8863-0536',elevators:1},
  {name:'윤&리하우스(1,4,7,10)',address:'심학산로423번길21-20',phone:'010-9036-1132',elevators:1},
  {name:'진양빌딩',address:'심학산로423번길7-14',phone:'010-7710-3554',elevators:1},
  {name:'목동동1131-2',address:'심학산로423번길7-8',phone:'010-7518-0503',elevators:1},
  {name:'힐링플러스2',address:'심학산로415',phone:'010-4400-6420',elevators:1},
  {name:'파주프리미엄아울렛',address:'경기도 파주시 탄현면 필승로 200',phone:null,elevators:21},
  {name:'서패동235-12외2',address:'경기도 파주시 돌곶이길133',phone:null,elevators:0},
  {name:'다율근린생활시설1동',address:'경기도 파주시 다율동528',phone:null,elevators:0},
  {name:'다율동근린생활시설 2동',address:'경기도 파주시 다율동528',phone:null,elevators:0},
  {name:'두영빌딩',address:'경기도 파주시 신촌동740-5',phone:null,elevators:0},
];

const PAJU2_SEED = [
  {name:'운정물재생센터(매달거래명세표같이보내기)',address:'경기도 파주시 운정',elevators:1,contract_start:'2021-01-01',contract_end:'2024-12-31',notes:'FM',phone:'031-949-5645',owner:'㈜에코비트워터'},
  {name:'최성만빌딩(분담)CMS',address:'경기도 파주시 운정',elevators:1,contract_start:'2022-08-01',contract_end:'2027-07-31',notes:'FM',phone:'010-9079-6252',owner:'최성만'},
  {name:'운정월드타워(분담) CMS',address:'경기도 파주시 운정',elevators:2,contract_start:'2022-07-01',contract_end:'2027-06-30',notes:'FM',phone:'031-955-1331',owner:'유원종합관리'},
  {name:'운정와이즈병원(분담)CMS',address:'경기도 파주시 운정',elevators:4,contract_start:'2024-01-01',contract_end:'2028-12-31',notes:'FM',phone:'031-937-8888',owner:'엔씨에스'},
  {name:'운정법조타운(분담) CMS',address:'경기도 파주시 운정',elevators:4,contract_start:'2023-01-01',contract_end:'2027-12-31',notes:'FM',phone:'031-839-3920',owner:'플러스탑'},
  {name:'와동동1640-2(분담)',address:'경기도 파주시 와동동',elevators:1,contract_start:'2024-08-01',contract_end:'2029-07-31',notes:'FM',phone:'952-5454',owner:'엄일성'},
  {name:'와동동1638-4(분담)CMS',address:'경기도 파주시 와동동',elevators:1,contract_start:'2023-04-01',contract_end:'2028-03-31',notes:'FM',phone:'010-7120-4704',owner:'김은희'},
  {name:'와동동1630-2(분담)CMS',address:'경기도 파주시 와동동',elevators:1,contract_start:'2024-02-01',contract_end:'2029-01-31',notes:'FM',phone:'010-8629-8222',owner:'㈜디에스건설'},
  {name:'와동동1622-4(분담) 나래빌 CMS',address:'경기도 파주시 와동동',elevators:1,contract_start:'2021-09-01',contract_end:'2026-08-30',notes:'FM',phone:'010-5328-9947',owner:'유영숙'},
  {name:'와동동1606-1(분담) CMS',address:'경기도 파주시 와동동',elevators:1,contract_start:'2020-10-01',contract_end:'2025-09-30',notes:'FM',phone:'010-7737-8777',owner:'전상순(광장)'},
  {name:'와동동1569-1(분담) CMS',address:'경기도 파주시 와동동',elevators:1,contract_start:'2023-11-01',contract_end:'2028-10-31',notes:'FM',phone:'010-8706-8500',owner:'에스와이'},
  {name:'순복음큰기적교회(분담)',address:'경기도 파주시 운정',elevators:1,contract_start:'2022-02-01',contract_end:'2027-01-31',notes:'FM',phone:'031-942-0109',owner:'이용우'},
  {name:'트윈프라자1(분담)',address:'경기도 파주시 운정',elevators:1,contract_start:'2021-02-01',contract_end:'2026-01-31',notes:'FM',phone:'031-953-8800',owner:'신우이엔씨'},
  {name:'트윈프라자2(분담)',address:'경기도 파주시 운정',elevators:1,contract_start:'2021-02-01',contract_end:'2026-01-31',notes:'FM',phone:'031-953-8800',owner:'신우이엔씨'},
  {name:'메디스타워(와동동1303-4) (분담)CMS',address:'경기도 파주시 와동동',elevators:2,contract_start:'2022-07-01',contract_end:'2027-06-30',notes:'FM',phone:'947-6961',owner:'메디스타워관리단'},
  {name:'와동동1572-8(분담)3h 빌',address:'경기도 파주시 와동동',elevators:1,contract_start:'2022-12-01',contract_end:'2027-11-30',notes:'FM',phone:'010-3243-2724',owner:'송병일'},
  {name:'J 프라자(와동동)(매월 우편발송)분담',address:'경기도 파주시 와동동',elevators:1,contract_start:'2022-08-22',contract_end:'2027-08-31',notes:'FM',phone:'010-3271-5445',owner:'전성호'},
  {name:'블루앤레드  분담(CMS)와동동1652-2',address:'경기도 파주시 와동동',elevators:1,contract_start:'2020-10-01',contract_end:'2025-09-30',notes:'FM',phone:'010-8700-2786',owner:'이용수'},
  {name:'지산프라자(C2M계산서발행 주소)',address:'경기도 파주시 운정',elevators:1,contract_start:'2023-02-01',contract_end:'2025-01-31',notes:'FM',phone:'010-3129-1933',owner:'신양옥'},
  {name:'운정행복센터',address:'경기도 파주시 운정',elevators:1,contract_start:'2022-01-01',contract_end:'2024-12-31',notes:'FM',phone:'950-1865',owner:'파주도시관광공사'},
  {name:'센타프라자 지로입금',address:'경기도 파주시 운정',elevators:1,contract_start:'2021-11-01',contract_end:'2026-10-31',notes:'FM',phone:'943-5859',owner:'㈜월드베스트'},
  {name:'형원',address:'경기도 파주시 운정',elevators:1,contract_start:'2025-01-01',contract_end:'2029-12-31',notes:'FM',phone:'010-3233-0681',owner:'에덴복지재단'},
  {name:'명품프라자 (계산서X)',address:'경기도 파주시 운정',elevators:1,contract_start:'2020-04-01',contract_end:'2025-03-31',notes:'FM',phone:'010-9470-4725',owner:'윤기환'},
  {name:'와동동1615-1(분담) 더블루',address:'경기도 파주시 와동동',elevators:1,contract_start:'2023-05-01',contract_end:'2027-04-30',notes:'POG',phone:'010-5488-6337',owner:'문춘희'},
  {name:'운정지구C3-1-5 CMS',address:'경기도 파주시 운정',elevators:1,contract_start:'2025-09-01',contract_end:'2027-08-31',notes:'POG',phone:'010-5818-3139',owner:'관리자 이주현'},
  {name:'와동동1603-4(분담)CMS',address:'경기도 파주시 와동동',elevators:1,contract_start:'2024-09-01',contract_end:'2026-08-31',notes:'POG',phone:'010-4947-6863',owner:'신대호'},
  {name:'와동동1608(분담)광장부동산 CMS',address:'경기도 파주시 와동동',elevators:1,contract_start:'2020-11-01',contract_end:'2026-11-30',notes:'POG',phone:'010-5402-5898',owner:'이태주'},
  {name:'와동동1572-3(분담) CMS',address:'경기도 파주시 와동동',elevators:1,contract_start:'2021-12-01',contract_end:'2025-11-30',notes:'POG',phone:'010-8880-7668',owner:'이형국'},
  {name:'와동동1642-3(분담) CMS',address:'경기도 파주시 와동동',elevators:1,contract_start:'2025-05-01',contract_end:'2027-04-30',notes:'POG',phone:'010-9311-1672',owner:'육현임'},
  {name:'와동동1658-1(분담)CMS',address:'경기도 파주시 와동동',elevators:1,contract_start:'2023-04-01',contract_end:'2027-03-31',notes:'POG',phone:'010-5314-9616',owner:'김한규'},
  {name:'제파크37차(분담)당하동250-1 CMS',address:'경기도 파주시 당하동',elevators:1,contract_start:'2021-06-01',contract_end:'2026-05-31',notes:'POG',phone:'010-7365-3131',owner:'이아람'},
  {name:'제파크38차(분담)당하동250-7 CMS',address:'경기도 파주시 당하동',elevators:1,contract_start:'2023-06-01',contract_end:'2026-05-31',notes:'POG',phone:'010-6403-2237',owner:'조한성'},
  {name:'제파크39차(분담)당하동250-10 CMS',address:'경기도 파주시 당하동',elevators:1,contract_start:'2021-09-01',contract_end:'2024-08-31',notes:'POG',phone:'010-7365-3131',owner:'이아람(운정사랑부동산)'},
  {name:'와동동1548-2(분담) CMS진스빌',address:'경기도 파주시 와동동',elevators:1,contract_start:'2021-06-01',contract_end:'2029-05-31',notes:'POG',phone:'010-5453-7099',owner:'최효진'},
  {name:'아스트로(분담) CMS',address:'경기도 파주시 운정',elevators:1,contract_start:'2022-11-01',contract_end:'2026-10-31',notes:'POG',phone:'010-2389-9447',owner:'박양순'},
  {name:'운정지구C1-34-4(분담) CMS',address:'경기도 파주시 운정',elevators:1,contract_start:'2025-01-01',contract_end:'2026-12-31',notes:'POG',phone:'010-5540-0345',owner:'김용교'},
  {name:'당하동198-17포레스트하우스(분담)',address:'경기도 파주시 당하동',elevators:1,contract_start:'2023-06-01',contract_end:'2025-05-31',notes:'POG',phone:'010-5321-9553',owner:'이레건축'},
  {name:'홍익유치원(분담) CMS',address:'경기도 파주시 운정',elevators:1,contract_start:'2022-06-01',contract_end:'2024-12-31',notes:'POG',phone:'010-8932-0740',owner:'이혜경'},
  {name:'제일풍경채3차 그랑퍼스트(분담)',address:'경기도 파주시 운정',elevators:14,contract_start:'2024-12-01',contract_end:'2026-11-30',notes:'POG',phone:'946-7747',owner:'제일풍경재3차 그랑퍼스트'},
  {name:'제일풍경채 그랑퍼스트상가 퍼스트도장(분담)CMS',address:'경기도 파주시 운정',elevators:1,contract_start:'2024-11-01',contract_end:'2025-10-31',notes:'POG',phone:'010-5511-8182',owner:'김재훈'},
  {name:'제일풍경채 그랑퍼스트분담)',address:'경기도 파주시 운정',elevators:51,contract_start:'2024-08-16',contract_end:'2027-08-15',notes:'POG',phone:'949-8468',owner:'운정제일풍경채그랑퍼스트'},
  {name:'대광빌딩',address:'경기도 파주시 운정',elevators:1,contract_start:'2023-06-01',contract_end:'2025-05-31',notes:'POG',phone:'010-7727-9159',owner:'정혜숙'},
  {name:'지애지비리지(당하동198-7)',address:'경기도 파주시 당하동',elevators:1,contract_start:'2022-10-01',contract_end:'2023-09-31',notes:'POG',phone:'010-8020-2455',owner:'솔로몬신축'},
  {name:'와동동1642-1',address:'경기도 파주시 와동동',elevators:1,contract_start:'2023-08-01',contract_end:'2024-07-31',notes:'POG',phone:'952-5454',owner:'한주PMC'},
  {name:'와동동1636-4',address:'경기도 파주시 와동동',elevators:1,contract_start:'2022-01-01',contract_end:'2024-12-31',notes:'POG',phone:'010-7118-2834',owner:'김만호'},
  {name:'와동동1632-1(김선분부동산) CMS',address:'경기도 파주시 와동동',elevators:1,contract_start:'2020-03-01',contract_end:'2026-02-28',notes:'POG',phone:'010-7765-2988',owner:'김선분'},
  {name:'부엔디아(와동동1572-4) CMS',address:'경기도 파주시 와동동',elevators:1,contract_start:'2020-05-01',contract_end:'2027-05-31',notes:'POG',phone:'010-5453-7097',owner:'이명재'},
  {name:'소망빌딩(김송자)',address:'경기도 파주시 운정',elevators:1,contract_start:'2022-02-01',contract_end:'2025-01-31',notes:'POG',phone:'010-6663-0031',owner:'김송자'},
  {name:'에덴하우스',address:'경기도 파주시 운정',elevators:3,contract_start:null,contract_end:'2016-06-30',notes:'POG',phone:'',owner:'에덴복지재단'},
  {name:'와동동1634-1CMS 문파크',address:'경기도 파주시 와동동',elevators:1,contract_start:'2023-05-01',contract_end:'2025-04-30',notes:'POG',phone:'010-8829-7530',owner:'안이자'},
  {name:'와동동1662-4(다온하우스) CMS',address:'경기도 파주시 와동동',elevators:1,contract_start:'2024-03-01',contract_end:'2026-02-28',notes:'POG',phone:'010-9278-7114',owner:'손우기'},
  {name:'더레드 CMS',address:'경기도 파주시 운정',elevators:1,contract_start:'2022-02-01',contract_end:'2026-01-31',notes:'POG',phone:'010-9216-6347',owner:'이현민'},
];

// ── 자동복구 함수 ─────────────────────────────────────────────
function makeSiteCode(prefix) {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2,5).toUpperCase()}`;
}

function autoRestoreTeam(teamName, seedData) {
  try {
    const count = db.prepare(`SELECT COUNT(*) as cnt FROM sites WHERE team=?`).get(teamName);
    const threshold = teamName === '파주1팀' ? 100 : 45;
    if (count.cnt >= threshold) {
      console.log(`✅ ${teamName} 확인: ${count.cnt}개 (복구 불필요)`);
      return;
    }
    console.log(`⚠️  ${teamName} 부족 (현재 ${count.cnt}개) → 자동 복구 시작...`);

    const insertStmt = db.prepare(`
      INSERT OR IGNORE INTO sites
        (site_code, site_name, address, owner_name, owner_phone,
         total_elevators, status, contract_start, contract_end, notes, team)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
    `);

    const insertMany = db.transaction((seeds) => {
      let n = 0;
      const prefix = teamName === '파주1팀' ? 'P1' : 'P2';
      for (const s of seeds) {
        const code = makeSiteCode(prefix);
        insertStmt.run(
          code,
          s.name,
          s.address || '',
          s.owner || null,
          s.phone || null,
          s.elevators || 0,
          s.contract_start || null,
          s.contract_end || null,
          s.notes || null,
          teamName
        );
        n++;
      }
      return n;
    });

    const inserted = insertMany(seedData);
    console.log(`✅ ${teamName} 자동 복구 완료: ${inserted}개`);
  } catch (err) {
    console.error(`❌ ${teamName} 자동 복구 실패:`, err.message);
  }
}

// ── 승강기 자동복구 (현장 복구 후 실행) ──────────────────────
// PAJU1_SEED + PAJU2_SEED에 있는 elevators 수치를 기반으로 기본 승강기 생성
function autoRestoreElevators() {
  try {
    const elevCount = db.prepare('SELECT COUNT(*) as cnt FROM elevators').get();
    if (elevCount.cnt >= 100) {
      console.log(`✅ 승강기 확인: ${elevCount.cnt}대 (복구 불필요)`);
      return;
    }
    console.log(`⚠️  승강기 부족 (현재 ${elevCount.cnt}대) → 자동 복구 시작...`);

    const insertElev = db.prepare(`
      INSERT OR IGNORE INTO elevators
        (site_id, elevator_no, elevator_name, elevator_type, status)
      VALUES (?, ?, ?, '승객용', 'normal')
    `);

    const allSeeds = [
      ...PAJU1_SEED.map(s => ({ ...s, team: '파주1팀' })),
      ...PAJU2_SEED.map(s => ({ ...s, team: '파주2팀' })),
    ];

    const restoreMany = db.transaction((seeds) => {
      let total = 0;
      for (const s of seeds) {
        const count = s.elevators || 0;
        if (count === 0) continue;

        // 현장 ID 찾기
        const site = db.prepare('SELECT id FROM sites WHERE site_name=?').get(s.name);
        if (!site) continue;

        for (let i = 1; i <= count; i++) {
          insertElev.run(
            site.id,
            `${site.id.toString().padStart(3,'0')}-E${i.toString().padStart(2,'0')}`,
            `${s.name} ${i}호기`
          );
          total++;
        }
      }
      return total;
    });

    const inserted = restoreMany(allSeeds);
    console.log(`✅ 승강기 자동 복구 완료: ${inserted}대`);
  } catch (err) {
    console.error('❌ 승강기 자동 복구 실패:', err.message);
  }
}

// 서버 시작 직후 실행 (자동복구)
autoRestoreTeam('파주1팀', PAJU1_SEED);
autoRestoreTeam('파주2팀', PAJU2_SEED);
autoRestoreElevators();
console.log(`✅ 자동복구 완료 → 현장: ${db.prepare('SELECT COUNT(*) as c FROM sites').get().c}개, 승강기: ${db.prepare('SELECT COUNT(*) as c FROM elevators').get().c}대`);

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

  // 승강기 대수: elevators 테이블 COUNT + total_elevators 합산 중 큰 값
  let elevatorsCount;
  if (siteIdIn) {
    const realCount = db.prepare(`SELECT COUNT(*) as count, SUM(CASE WHEN status='warning' THEN 1 ELSE 0 END) as warning, SUM(CASE WHEN status='fault' THEN 1 ELSE 0 END) as fault FROM elevators WHERE site_id ${siteIdIn}`).get();
    const totalSum = db.prepare(`SELECT COALESCE(SUM(total_elevators),0) as total FROM sites WHERE id ${siteIdIn} AND status='active'`).get();
    elevatorsCount = { count: Math.max(realCount.count || 0, totalSum.total || 0), warning: realCount.warning || 0, fault: realCount.fault || 0 };
  } else if (effectiveTeamFilter && !siteIdIn) {
    elevatorsCount = { count: 0, warning: 0, fault: 0 };
  } else {
    const realCount = db.prepare(`SELECT COUNT(*) as count, SUM(CASE WHEN status='warning' THEN 1 ELSE 0 END) as warning, SUM(CASE WHEN status='fault' THEN 1 ELSE 0 END) as fault FROM elevators`).get();
    const totalSum = db.prepare(`SELECT COALESCE(SUM(total_elevators),0) as total FROM sites WHERE status='active'`).get();
    elevatorsCount = { count: Math.max(realCount.count || 0, totalSum.total || 0), warning: realCount.warning || 0, fault: realCount.fault || 0 };
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

  // 팀별 통계 (team 컬럼 있을 때만)
  let teamStats = [];
  if (hasTeamCol) {
    teamStats = db.prepare(`
      SELECT s.team,
        COUNT(DISTINCT s.id) as sites,
        COALESCE(SUM(s.total_elevators),0) as elevators,
        COUNT(DISTINCT e.id) as registered_elevators,
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
// GET /api/teams - 현장에 사용된 팀 목록 조회
app.get('/api/teams', wrap((req, res) => {
  const rows = db.prepare(`SELECT DISTINCT team FROM sites WHERE team IS NOT NULL AND team != '' ORDER BY team ASC`).all();
  const teams = rows.map(r => r.team);
  res.json({ success: true, results: teams });
}));

// POST /api/teams - 팀 추가 (현장에 팀 지정 시 사용, 별도 테이블 없이 sites에서 관리)
app.post('/api/teams', wrap((req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ success: false, error: '팀 이름이 필요합니다' });
  res.json({ success: true, name: name.trim() });
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
}));

app.delete('/api/sites/:id', wrap((req, res) => {
  db.prepare('DELETE FROM sites WHERE id=?').run(req.params.id);
  res.json({ success: true });
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
}));

app.patch('/api/issues/:id/action', wrap((req, res) => {
  const { status, action_taken, action_date, action_by, photo_before, photo_after } = req.body;
  db.prepare(`UPDATE inspection_issues SET status=?, action_taken=?, action_date=?, action_by=?, photo_before=?, photo_after=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(status || '조치완료', action_taken || null, action_date || null, action_by || null, photo_before || null, photo_after || null, req.params.id);
  res.json({ success: true });
}));

app.put('/api/issues/:id', wrap((req, res) => {
  const { issue_category, issue_description, legal_basis, severity, status, action_required, action_taken, action_date, action_by, deadline, inspection_date, inspector_name } = req.body;
  db.prepare(`UPDATE inspection_issues SET issue_category=?, issue_description=?, legal_basis=?, severity=?, status=?, action_required=?, action_taken=?, action_date=?, action_by=?, deadline=?, inspection_date=?, inspector_name=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(issue_category || null, issue_description, legal_basis || null, severity || '경결함', status || '미조치', action_required || null, action_taken || null, action_date || null, action_by || null, deadline || null, inspection_date || null, inspector_name || null, req.params.id);
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
  res.json({ version: '2.3.2', users: users.cnt, teams: teams.cnt, status: 'ok' });
});

// ── 서버 시작 ──────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ API 서버 시작: http://0.0.0.0:${PORT}`);
  // 시작 시 사용자 수 로그
  const cnt = db.prepare('SELECT COUNT(*) as cnt FROM app_users').get();
  console.log(`👥 등록된 사용자: ${cnt.cnt}명`);
});
