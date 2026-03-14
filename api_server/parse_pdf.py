#!/usr/bin/env python3
"""
한국승강기안전공단 검사결과 브리핑보고서 PDF 파서 v3
pymupdf(fitz)를 사용하여 좌표 기반으로 정확하게 파싱

PDF 레이아웃:
  x ≈ 57~100  : 검사항목 코드 (1.2.1.4, 1.3.3, 안전스티커 등)
  x ≈ 133~140 : 기준설명 (가)나)다) 텍스트) 또는 ▶▷ 지적내용
  x ≈ 464~480 : 호기 (1(1호기))

핵심 관찰:
  - 코드 x는 항상 100 미만
  - 지적내용(▶▷) x는 136 근처
  - 호기 x는 476 근처
  - 코드 y가 ▶ y 보다 먼저 또는 나중에 올 수 있음
  - 여러 줄 텍스트는 ▶ 이후 같은 x(136) 범위에서 연속 등장
"""
import fitz
import json
import sys
import re
import os


def parse_inspection_pdf(pdf_path):
    try:
        doc = fitz.open(pdf_path)
    except Exception as e:
        return {"success": False, "error": f"PDF 열기 실패: {str(e)}"}

    # 모든 페이지의 텍스트 블록을 좌표와 함께 수집
    all_lines = []
    for page_num, page in enumerate(doc):
        blocks = page.get_text('dict')['blocks']
        for block in blocks:
            if block['type'] == 0:
                for line in block['lines']:
                    x0 = line['bbox'][0]
                    y0 = line['bbox'][1]
                    text = ''.join(s['text'] for s in line['spans']).strip()
                    if text:
                        all_lines.append({
                            'page': page_num + 1,
                            'x': round(x0, 1),
                            'y': round(y0, 1),
                            'text': text
                        })

    page_count = len(doc)
    doc.close()

    # y 좌표로 정렬
    sorted_lines = sorted(all_lines, key=lambda l: (l['page'], l['y'], l['x']))

    # ── 날짜 추출 ─────────────────────────────────────────────────
    detected_date = None
    date_pat = re.compile(r'(\d{4})[.\-년\/](\d{1,2})[.\-월\/](\d{1,2})일?')

    for line in sorted_lines:
        if '검사실시일자' in line['text']:
            target_y = line['y']
            for other in sorted_lines:
                if other['page'] == line['page'] and abs(other['y'] - target_y) < 5 and other['x'] > line['x']:
                    m = date_pat.search(other['text'])
                    if m:
                        detected_date = f"{m.group(1)}-{m.group(2).zfill(2)}-{m.group(3).zfill(2)}"
                        break
            if detected_date:
                break

    if not detected_date:
        for line in sorted_lines:
            m = date_pat.search(line['text'])
            if m and int(m.group(1)) >= 2020:
                detected_date = f"{m.group(1)}-{m.group(2).zfill(2)}-{m.group(3).zfill(2)}"
                break

    # ── 현장명 추출 ───────────────────────────────────────────────
    detected_site = None

    for line in sorted_lines:
        if line['text'] == '건물명' or line['text'].startswith('건물명'):
            target_y = line['y']
            candidates = [l for l in sorted_lines
                          if l['page'] == line['page'] and abs(l['y'] - target_y) < 5 and l['x'] > line['x']]
            if candidates:
                detected_site = max(candidates, key=lambda l: l['x'])['text'].strip()
                break

    if not detected_site:
        site_kw = re.compile(r'([가-힣a-zA-Z0-9]{2,30}(?:아파트|빌딩|타워|플라자|센터|주택|상가|마트|병원|학교|공단|오피스텔|리\d+|동\d+|단지|APT))')
        for line in sorted_lines:
            m = site_kw.search(line['text'])
            if m:
                detected_site = m.group(1).strip()
                break

    # ── 패턴 정의 ─────────────────────────────────────────────────
    check_code_pat = re.compile(r'^\d+\.\d+(?:\.\d+)*$')
    hogi_pat = re.compile(r'^(\d+)\s*[\(\（]\s*(\d+호기)\s*[\)\）]$')
    main_issue_pat = re.compile(r'^▶')
    sub_issue_pat = re.compile(r'^▷')
    issue_any_pat = re.compile(r'^[▶▷►▸]')

    def guess_severity(desc, section_type):
        if section_type == '권고':
            return '권고사항'
        severe_kw = ['불량', '파손', '고장', '누설', '위험', '결함', '파단', '단선',
                     '이탈', '과열', '고여', '적합하지않음', '적합하지 않음', '누수',
                     '연결안됨', '미작동', '안됨', '마감안됨']
        if any(k in desc for k in severe_kw):
            return '중결함'
        return '경결함'

    # ── 섹션 경계 수집 ────────────────────────────────────────────
    section_boundaries = []  # (page, y, section_type)
    for line in sorted_lines:
        t = line['text']
        if '□검사부적합내역' in t:
            section_boundaries.append((line['page'], line['y'], 'defect'))
        elif '□시정권고내역' in t:
            section_boundaries.append((line['page'], line['y'], 'recommend'))
        elif t.startswith('□'):
            section_boundaries.append((line['page'], line['y'], None))

    def get_section_at(page, y):
        current = None
        for (bp, by, btype) in section_boundaries:
            if bp < page or (bp == page and by <= y):
                current = btype
            else:
                break
        return current

    # ── 핵심 파싱: ▶ 라인을 기준으로 수집 ───────────────────────
    # 각 ▶ 라인을 찾고, 해당 블록의 코드, 호기, 세부내용을 수집

    # 1단계: 모든 ▶ 라인 수집
    main_issue_lines = []
    for line in sorted_lines:
        sec = get_section_at(line['page'], line['y'])
        if sec not in ('defect', 'recommend'):
            continue
        if main_issue_pat.match(line['text']) and 110 <= line['x'] <= 175:
            main_issue_lines.append({
                'page': line['page'],
                'y': line['y'],
                'x': line['x'],
                'desc': re.sub(r'^▶+\s*', '', line['text']).strip(),
                'subs': [],
                'subs_raw': [],  # 이어지는 텍스트
                'section': sec,
                'hogi': None,
                'code': None,
            })

    # 2단계: 각 ▶ 이후 ▷ 및 이어지는 텍스트 수집
    # ▶ 라인의 다음 ▶ 라인 직전까지를 해당 항목의 범위로 봄
    for i, mitem in enumerate(main_issue_lines):
        mp, my = mitem['page'], mitem['y']

        # 다음 ▶ 라인 위치
        if i + 1 < len(main_issue_lines):
            nxt = main_issue_lines[i + 1]
            next_p, next_y = nxt['page'], nxt['y']
        else:
            next_p, next_y = 9999, 9999

        # ▶ 라인 주변 (범위: ▶ y 기준 -30 ~ 다음 ▶ 직전)
        range_start_y = my - 30  # 코드가 위에 있을 수 있음
        range_start_p = mp

        # 이 범위 내의 관련 라인 수집
        for line in sorted_lines:
            lp, ly, lx, lt = line['page'], line['y'], line['x'], line['text']

            # 범위 체크
            if lp < range_start_p or (lp == range_start_p and ly < range_start_y):
                continue
            if lp > next_p or (lp == next_p and ly >= next_y - 2):
                continue

            # 섹션 체크
            sec = get_section_at(lp, ly)
            if sec not in ('defect', 'recommend'):
                continue

            # 호기 컬럼 (x > 450)
            if lx > 450:
                m = hogi_pat.match(lt)
                if m and mitem['hogi'] is None:
                    mitem['hogi'] = m.group(2)
                continue

            # 코드 컬럼 (x < 110)
            if lx < 110:
                if check_code_pat.match(lt):
                    if mitem['code'] is None:
                        mitem['code'] = lt
                elif re.match(r'^[가-힣]{2,15}$', lt) and not re.match(
                        r'^(검사항목|검사기준|호기|합격|판정|승강기|건물|경기|검사대상|우편물)$', lt):
                    if mitem['code'] is None:
                        mitem['code'] = lt
                continue

            # ▷ 라인 (세부결함)
            if sub_issue_pat.match(lt) and 110 <= lx <= 175:
                desc = re.sub(r'^▷+\s*', '', lt).strip()
                if desc:
                    mitem['subs'].append(desc)
                continue

            # ▶ 본인 라인은 스킵
            if ly == my and lp == mp and issue_any_pat.match(lt):
                continue

            # 이어지는 텍스트 (▶ 이후, x 134~175 범위 - 기준설명 컬럼 133.8 제외)
            if 134 <= lx <= 175 and ly > my:
                # 기준설명 패턴 스킵
                if re.match(r'^[가-힣]\)', lt):
                    continue
                if re.search(r'확인한다|엘리베이터안전기준|에따라작동|에따라카내|기준및부적합', lt):
                    continue
                if lt in ('검사항목', '호기(설치장소)', '호기', '검사기준및부적합내용'):
                    continue
                if re.match(r'^(검사항목|호기|검사기준)', lt):
                    continue
                # ▶ ▷ 기호로 시작하면 스킵 (다른 항목)
                if issue_any_pat.match(lt):
                    continue
                # 이어지는 내용으로 추가
                mitem['subs_raw'].append(lt)

    # 3단계: 결과 조합
    parsed_issues = []
    for mitem in main_issue_lines:
        label = mitem['hogi'] or '(호기 미지정)'
        code = mitem['code'] or ''
        section_type = '권고' if mitem['section'] == 'recommend' else '부적합'

        # 설명 구성: 메인 + 세부결함
        desc_parts = [mitem['desc']] + mitem['subs']
        # subs_raw는 이어지는 긴 내용 (권고사항 등)
        if mitem['subs_raw']:
            # 권고사항: subs_raw를 이어붙여서 full_desc에 추가
            # 부적합: subs_raw는 보통 기준설명이므로 제외
            if section_type == '권고':
                raw_text = ' '.join(mitem['subs_raw'])
                desc_parts.append(raw_text)
            # 부적합의 경우 subs_raw는 기준설명으로 간주 (제외)

        full_desc = ' '.join(p for p in ' / '.join(p for p in desc_parts if p).split())
        # 중복 슬래시 정리
        full_desc = re.sub(r'\s*/\s*', ' / ', full_desc)
        full_desc = full_desc.strip(' /')
        if not full_desc:
            continue
        if not full_desc:
            continue

        severity = guess_severity(full_desc, section_type)
        same_count = sum(1 for p in parsed_issues if p['elevatorLabel'] == label)
        parsed_issues.append({
            'elevatorLabel': label,
            'description': full_desc,
            'severity': severity,
            'issueNo': same_count + 1,
            'include': True,
            'checkCode': code,
            'sectionType': section_type,
        })

    # ── 중복 제거 ─────────────────────────────────────────────────
    seen = set()
    unique_issues = []
    for issue in parsed_issues:
        key = (issue['elevatorLabel'], issue['description'])
        if key not in seen:
            seen.add(key)
            unique_issues.append(issue)

    # issueNo 재계산
    count_per_label = {}
    for issue in unique_issues:
        lbl = issue['elevatorLabel']
        count_per_label[lbl] = count_per_label.get(lbl, 0) + 1
        issue['issueNo'] = count_per_label[lbl]

    # ── 결과 반환 ─────────────────────────────────────────────────
    raw_text = '\n'.join(l['text'] for l in all_lines)

    return {
        'success': True,
        'filename': os.path.basename(pdf_path),
        'pageCount': page_count,
        'rawText': raw_text[:3000],
        'detectedDate': detected_date,
        'detectedSite': detected_site,
        'parsedIssues': unique_issues,
        'totalCount': len(unique_issues),
    }


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(json.dumps({"success": False, "error": "PDF 경로가 필요합니다"}))
        sys.exit(1)

    pdf_path = sys.argv[1]
    result = parse_inspection_pdf(pdf_path)
    print(json.dumps(result, ensure_ascii=False))
