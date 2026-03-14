#!/usr/bin/env python3
"""
승강기 검사 지적사항 캡처 이미지 파서 v3.0
- 다중 OCR 전처리 전략으로 인식률 극대화
- 호기별 지적사항 정확 분리 (■ EL-1, 1호기, EL-1 등 다양한 형식)
- 심각도는 별도 필드로만 표시, 설명 텍스트는 훼손하지 않음
- 헤더/메타정보 라인 정밀 필터링
"""
import sys
import json
import re
import os
import tempfile
from pathlib import Path

try:
    import pytesseract
    from PIL import Image, ImageFilter, ImageEnhance, ImageOps
    import cv2
    import numpy as np
except ImportError as e:
    print(json.dumps({"success": False, "error": f"패키지 없음: {e}"}))
    sys.exit(1)


# ─────────────────────────────────────────────────────────────
# 이미지 전처리 전략
# ─────────────────────────────────────────────────────────────

def _upscale(gray: np.ndarray, min_w: int = 1600) -> np.ndarray:
    h, w = gray.shape
    if w < min_w:
        scale = min_w / w
        gray = cv2.resize(gray, None, fx=scale, fy=scale,
                          interpolation=cv2.INTER_CUBIC)
    return gray


def pp_standard(img):
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    g = _upscale(g)
    g = cv2.fastNlMeansDenoising(g, h=10)
    return cv2.adaptiveThreshold(
        g, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 11, 2)


def pp_clahe(img):
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    g = _upscale(g)
    clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))
    g = clahe.apply(g)
    _, b = cv2.threshold(g, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    return b


def pp_sharpen(img):
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    g = _upscale(g)
    k = np.array([[-1,-1,-1],[-1,9,-1],[-1,-1,-1]])
    g = cv2.filter2D(g, -1, k)
    _, b = cv2.threshold(g, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    return b


def pp_scale2x(img):
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    h, w = g.shape
    g = cv2.resize(g, (w * 2, h * 2), interpolation=cv2.INTER_CUBIC)
    g = cv2.GaussianBlur(g, (3, 3), 0)
    _, b = cv2.threshold(g, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    return b


def pp_invert(img):
    """어두운 배경 이미지 대응 (반전)"""
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    g = _upscale(g)
    _, b = cv2.threshold(g, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    return b


def ocr_from_array(arr: np.ndarray, config: str) -> str:
    fd, path = tempfile.mkstemp(suffix='.png')
    os.close(fd)
    try:
        cv2.imwrite(path, arr)
        return pytesseract.image_to_string(Image.open(path), config=config)
    except Exception:
        return ''
    finally:
        try: os.remove(path)
        except: pass


def extract_best_text(img_path: str) -> str:
    img = cv2.imread(img_path)
    if img is None:
        raise ValueError(f"이미지 읽기 실패: {img_path}")

    strategies = [
        (pp_standard,  r'--oem 3 --psm 6 -l kor+eng'),
        (pp_clahe,     r'--oem 3 --psm 6 -l kor+eng'),
        (pp_sharpen,   r'--oem 3 --psm 4 -l kor+eng'),
        (pp_scale2x,   r'--oem 3 --psm 6 -l kor'),
        (pp_invert,    r'--oem 3 --psm 6 -l kor+eng'),
    ]
    results = [ocr_from_array(fn(img), cfg) for fn, cfg in strategies]
    return max(results, key=lambda t: len(t.strip()))


# ─────────────────────────────────────────────────────────────
# 호기 인식 패턴 (우선순위 순)
# ─────────────────────────────────────────────────────────────

# 각 패턴: (정규식, 라벨 생성 함수)
HOGI_RE = [
    # "■ 1호기", "● 2호기", "▶ 3호기" 등 앞에 기호가 붙은 경우
    (re.compile(r'^[■●▶▷◆◇★☆□○•]\s*(\d+)\s*호기', re.I),
     lambda m: f"{m.group(1)}호기"),

    # "1호기", "2 호기"
    (re.compile(r'^(\d+)\s*호기', re.I),
     lambda m: f"{m.group(1)}호기"),

    # "■ EL-1", "■ EL 1", "● ES-2", "[EL-1]", "(EL-1)"
    (re.compile(r'^[■●▶▷◆□○•\[\(]?\s*'
                r'(EL|ES|EP|EV|승강기|엘리베이터|리프트)'
                r'[-_\s]*(\d+)', re.I),
     lambda m: f"{m.group(1).upper()}-{m.group(2)}"),

    # "No.1", "No 1", "#1"
    (re.compile(r'^(?:No\.?|#)\s*(\d+)', re.I),
     lambda m: f"No.{m.group(1)}"),

    # "호기: 1", "기계: 2"
    (re.compile(r'^(?:호기|기계|기번)\s*[:：]\s*(\d+)', re.I),
     lambda m: f"{m.group(1)}호기"),

    # "기1", "기2" (단독 숫자-호기 짧은 형식)
    (re.compile(r'^기\s*(\d+)\s*$'),
     lambda m: f"{m.group(1)}호기"),

    # "[1]" 단독 (줄에 숫자만 있는 경우 – 마지막 수단)
    (re.compile(r'^\[(\d+)\]\s*$'),
     lambda m: f"{m.group(1)}호기"),
]


def detect_hogi(line: str):
    """
    줄에서 호기 라벨 추출.
    반환: (호기라벨 str | None, 나머지텍스트 str)
    """
    stripped = line.strip()
    for pat, label_fn in HOGI_RE:
        m = pat.match(stripped)
        if m:
            label = label_fn(m)
            rest = stripped[m.end():].strip(' :-_')
            return label, rest
    return None, stripped


# ─────────────────────────────────────────────────────────────
# 지적사항 항목 시작 인식
# ─────────────────────────────────────────────────────────────

ISSUE_BULLET_RE = re.compile(
    r'^(?:'
    r'[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮\u2460-\u2473]'   # 원 숫자
    r'|\d{1,2}[.)]\s'                            # 1. 1) 12.
    r'|[-•·▶▷◆]\s'                               # 불릿
    r'|\[\s*\d+\s*\]\s'                          # [1]
    r'|[가나다라마바사아자차카타파하][.]\s'          # 가.
    r')',
    re.IGNORECASE
)

def strip_bullet(line: str) -> str:
    """앞의 번호/불릿 기호 제거 후 내용 반환"""
    s = line.strip()
    m = ISSUE_BULLET_RE.match(s)
    if m:
        return s[m.end():].strip()
    return s


# ─────────────────────────────────────────────────────────────
# 심각도 감지 (설명 훼손 없이 별도 필드만)
# ─────────────────────────────────────────────────────────────

# (우선순위 높은 순)
SEVERITY_RULES = [
    ('중결함',   re.compile(r'중결함|重缺陷|중대\s*결함|위험|고장|파손|단락|누전|추락|무력화|인명')),
    ('경결함',   re.compile(r'경결함|輕缺陷|마모|이완|변형|열화|오염|변색|파열|균열|노후')),
    ('권고사항', re.compile(r'권고사항|권고|권장|주의\s*요망|개선\s*권장|보완')),
]
# 심각도 추가 단서 – 괄호 안 표기 "(중결함)", "(경결함)" 등
SEV_BRACKET_RE = re.compile(r'[(\[（\[]?\s*(중결함|경결함|권고사항|권고)\s*[)\]）\]]?')


def detect_severity(text: str) -> tuple:
    """
    심각도 감지.
    반환: (severity str, 심각도_표기_제거된_설명 str)
    심각도가 괄호 형태로 명시된 경우 그 부분을 설명에서 제거.
    그 외 키워드는 설명에 그대로 유지.
    """
    # 1순위: 괄호 안 명시적 표기 제거
    m = SEV_BRACKET_RE.search(text)
    if m:
        sev_raw = m.group(1)
        sev = '권고사항' if sev_raw in ('권고', '권고사항') else sev_raw
        cleaned = (text[:m.start()] + text[m.end():]).strip(' /-_')
        cleaned = re.sub(r'\s{2,}', ' ', cleaned).strip()
        return sev, cleaned if len(cleaned) > 2 else text.strip()

    # 2순위: 내용 키워드로 추정 (설명 유지)
    for sev, pat in SEVERITY_RULES:
        if pat.search(text):
            return sev, text.strip()

    return '경결함', text.strip()


# ─────────────────────────────────────────────────────────────
# 무시할 라인 패턴 (헤더/메타/서명/페이지)
# ─────────────────────────────────────────────────────────────

SKIP_RE = re.compile(
    r'^(?:'
    r'검사기관|검사원|검사일|검사번호|검사종류|검사구분'
    r'|현장명?|건물명?|주소|사업장명?|소유자|관리주체'
    r'|승강기\s*번호|설치\s*위치|관리\s*번호|제조\s*사|제조\s*번호|형식승인'
    r'|성명|서명|자격\s*번호|인감|도장|확인자'
    r'|페이지|page|\d+\s*/\s*\d+'
    r'|총\s*\d+\s*건|합\s*계'
    r'|지적사항\s*없음|이상\s*없음|합격|적합'
    r'|기타\s*사항|참고|비고'
    r')',
    re.IGNORECASE
)

# 섹션 구분자 (이 라인 이후부터 파싱 집중)
SECTION_START_RE = re.compile(
    r'지적\s*사항|결함\s*내용|불합격\s*항목|주요\s*지적|개선\s*사항|검사\s*결과',
    re.IGNORECASE
)

# 날짜 패턴
DATE_RE = re.compile(r'(\d{4})\s*[.\-년]\s*(\d{1,2})\s*[.\-월]\s*(\d{1,2})')

# 검사코드 패턴 (A-1, B-2, 1.2.3 등)
CODE_RE = re.compile(r'\b([A-Z]{1,2}-\d{1,3}[a-z]?|\d{1,2}\.\d{1,2}\.\d{0,2})\b')


# ─────────────────────────────────────────────────────────────
# 텍스트 정규화
# ─────────────────────────────────────────────────────────────

def normalize(text: str) -> str:
    """전각 → 반각 변환 (줄바꿈 보존, 줄 내 공백만 정리)"""
    result = []
    for ch in text:
        code = ord(ch)
        if 0xFF01 <= code <= 0xFF5E:
            result.append(chr(code - 0xFEE0))
        elif ch == '\u3000':
            result.append(' ')
        else:
            result.append(ch)
    # 줄 단위로 공백 정리 (줄바꿈은 유지)
    lines = ''.join(result).split('\n')
    return '\n'.join(re.sub(r'[ \t]+', ' ', l).strip() for l in lines)


def clean_noise(line: str) -> str:
    """OCR 잡음 제거"""
    # 반복 특수문자 (---, ===, ...)
    line = re.sub(r'[-=_\.~]{3,}', '', line)
    # 외톨이 파이프/슬래시
    line = re.sub(r'(?<!\S)[|/\\](?!\S)', '', line)
    return line.strip()


# ─────────────────────────────────────────────────────────────
# 메인 파싱 로직
# ─────────────────────────────────────────────────────────────

def parse_inspection_text(raw_text: str) -> dict:
    normalized = normalize(raw_text)
    raw_lines = normalized.split('\n')
    lines = [clean_noise(l) for l in raw_lines]
    lines = [l for l in lines if l]

    # ── 날짜 추출
    detected_date = None
    for line in lines:
        m = DATE_RE.search(line)
        if m:
            y, mo, d = m.group(1), m.group(2).zfill(2), m.group(3).zfill(2)
            if 2015 <= int(y) <= 2035:
                detected_date = f"{y}-{mo}-{d}"
                break

    # ── 현장명 추출
    detected_site = None
    for i, line in enumerate(lines):
        for kw in ['건물명', '현장명', '건물', '현장', '사업장']:
            if kw in line and len(line) < 60:
                rest = re.split(rf'{kw}\s*[:：]?\s*', line, maxsplit=1)[-1].strip()
                rest = re.sub(r'\(.*?\)', '', rest).strip()
                rest = DATE_RE.sub('', rest).strip()
                candidate = rest.split()[0] if rest.split() else ''
                if 2 <= len(candidate) <= 30:
                    detected_site = candidate
                    break
        if detected_site:
            break

    # ── 지적사항 파싱 (상태 머신)
    issues = []
    current_hogi = '(호기 미지정)'
    buf_desc = None          # 현재 쌓고 있는 설명
    buf_hogi = current_hogi
    in_section = False       # 지적사항 섹션 안에 있는가

    # "이상 없음", "지적사항 없음" 류 - 내용 없음을 나타내는 패턴
    NO_ISSUE_RE = re.compile(
        r'^(?:이상\s*없음|지적\s*사항\s*없음|합격|적합|정상|해당\s*없음|없음)$',
        re.IGNORECASE
    )
    # 괄호 안 부가설명만 남은 경우 제거 (예: "(승객용 엘리베이터)")
    BRACKET_ONLY_RE = re.compile(r'^[(\[（].*[)\]）]$')

    def flush():
        nonlocal buf_desc, buf_hogi
        if not buf_desc:
            return
        text = buf_desc.strip()
        if len(text) <= 3:
            buf_desc = None
            return

        # "이상 없음" 류 필터
        if NO_ISSUE_RE.match(text):
            buf_desc = None
            return

        # 괄호 안 부가 설명만 있는 경우 필터
        if BRACKET_ONLY_RE.match(text):
            buf_desc = None
            return

        # 검사코드 추출 (설명에서 분리)
        code_match = CODE_RE.search(text)
        check_code = code_match.group(0) if code_match else ''
        if code_match:
            text = (text[:code_match.start()] + text[code_match.end():]).strip(' -_/:')

        # 심각도 감지 (괄호 표기는 제거, 키워드는 유지)
        severity, text = detect_severity(text)

        text = re.sub(r'\s{2,}', ' ', text).strip()
        if len(text) > 3:
            issues.append({
                'elevatorLabel': buf_hogi,
                'description': text,
                'severity': severity,
                'checkCode': check_code,
                'issueNo': sum(1 for x in issues if x['elevatorLabel'] == buf_hogi) + 1,
                'include': True,
            })
        buf_desc = None

    for line in lines:

        # 섹션 헤더 감지
        if SECTION_START_RE.search(line) and len(line) < 40:
            in_section = True
            flush()
            continue

        # 호기 라벨 감지
        hogi_label, rest = detect_hogi(line)
        if hogi_label:
            flush()
            current_hogi = hogi_label
            in_section = True
            # 호기 라인에 내용이 이어질 경우 (예: "1호기 - 도어 불량")
            if rest and len(rest) > 3 and not SKIP_RE.match(rest):
                content = strip_bullet(rest)
                if len(content) > 3:
                    buf_desc = content
                    buf_hogi = current_hogi
            continue

        # 헤더/메타 라인 스킵
        if SKIP_RE.match(line):
            continue

        # 날짜만 있는 라인 스킵
        if DATE_RE.fullmatch(line.replace(' ', '')):
            continue

        # 지적사항 항목 시작 감지
        if ISSUE_BULLET_RE.match(line.strip()):
            flush()
            in_section = True
            content = strip_bullet(line)
            if len(content) > 3:
                buf_desc = content
                buf_hogi = current_hogi
            continue

        # 이전 항목 연속 텍스트 (들여쓰기 있거나 짧은 연결 문장)
        if buf_desc is not None and len(line) > 3:
            # 새로운 호기/항목 시작이 아니면 이어 붙임
            if not SKIP_RE.match(line) and not detect_hogi(line)[0]:
                buf_desc += ' ' + line
            continue

        # 섹션 안에서 번호 없는 일반 텍스트도 수집
        if in_section and len(line) > 8 and not SKIP_RE.match(line):
            # 단독 숫자 페이지번호 제외
            if re.match(r'^\d{1,3}$', line):
                continue
            flush()
            buf_desc = line
            buf_hogi = current_hogi

    flush()  # 마지막 버퍼 처리

    # ── 폴백: 섹션 감지 실패 시 전체 텍스트 줄별 파싱
    if not issues:
        for line in lines:
            if len(line) < 8:
                continue
            if SKIP_RE.match(line):
                continue
            if detect_hogi(line)[0]:
                continue
            if ISSUE_BULLET_RE.match(line.strip()):
                content = strip_bullet(line)
            else:
                content = line
            severity, desc = detect_severity(content)
            code_m = CODE_RE.search(desc)
            code = code_m.group(0) if code_m else ''
            if code_m:
                desc = (desc[:code_m.start()] + desc[code_m.end():]).strip(' -_/:')
            if len(desc) > 5:
                issues.append({
                    'elevatorLabel': '(호기 미지정)',
                    'description': desc,
                    'severity': severity,
                    'checkCode': code,
                    'issueNo': len(issues) + 1,
                    'include': True,
                })

    # ── 중복 제거
    seen, unique = set(), []
    for iss in issues:
        key = re.sub(r'\s+', '', iss['description'])[:25] + iss['elevatorLabel']
        if key not in seen:
            seen.add(key)
            unique.append(iss)

    # ── issueNo 재정렬 (호기별)
    hogi_cnt: dict = {}
    for iss in unique:
        hogi_cnt.setdefault(iss['elevatorLabel'], 0)
        hogi_cnt[iss['elevatorLabel']] += 1
        iss['issueNo'] = hogi_cnt[iss['elevatorLabel']]

    return {
        'success': True,
        'detectedDate': detected_date,
        'detectedSite': detected_site,
        'parsedIssues': unique,
        'totalCount': len(unique),
        'rawText': normalized[:3000],
    }


# ─────────────────────────────────────────────────────────────
# 메인 엔트리
# ─────────────────────────────────────────────────────────────

def parse_inspection_image(image_path: str) -> dict:
    try:
        raw_text = extract_best_text(image_path)
        if not raw_text.strip():
            return {
                'success': False,
                'error': '이미지에서 텍스트를 추출하지 못했습니다. 더 선명한 이미지를 사용해주세요.',
                'rawText': '',
                'parsedIssues': [],
                'totalCount': 0,
            }
        result = parse_inspection_text(raw_text)
        result['filename'] = os.path.basename(image_path)
        return result
    except Exception as e:
        import traceback
        return {
            'success': False,
            'error': str(e),
            'detail': traceback.format_exc(),
            'parsedIssues': [],
            'totalCount': 0,
        }


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(json.dumps({'success': False, 'error': '이미지 경로 인수가 없습니다'}))
        sys.exit(1)
    result = parse_inspection_image(sys.argv[1])
    print(json.dumps(result, ensure_ascii=False))
