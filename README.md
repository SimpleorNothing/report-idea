# 아이디어 자판기 (report-idea)

사업부장 보고용 **보고서 주제(아이디어)** 를 빠르게 발굴하는 도구.
보고서 자판기(`report.samsungda.net`)와 **패밀리룩**을 공유한다.

- **URL** : https://idea.samsungda.net
- **배포** : Cloudflare Pages (`main` push 시 자동 배포)
- **스택** : 정적 HTML + Pages Functions + Claude API (Sonnet)

## 동작

1. **주제 선택** — 소비자 / 기술 / 경쟁사 (복수 선택)
2. **아이디어 갯수** — 기본 3개 (`− / +`, 1~8)
3. **개요 수준** — SPEED(제목+핵심 3줄) / QUALITY(제목+3줄+개략 내용)
4. **소스** — 도구모음 · Market Insight · 2030 · 업로드 보고서 · 🔎 신규 검색
   - `신규 검색` 선택 시 Claude `web_search` 툴로 최신 자료 반영
5. **아이디어 생성** → 카드형 결과 + 전체 복사

## 구조

```
index.html               프런트 (보고서 자판기 패밀리룩)
functions/api/generate.js  보고 주제 생성 (Claude API 호출)
functions/api/version.js   배포 시각 배지 (CF_VERSION_METADATA)
```

## 배포 설정 (Cloudflare Pages)

1. Pages 프로젝트를 이 repo(`SimpleorNothing/report-idea`)에 연결, Production 브랜치 `main`
   - Framework preset: **None**, Build command: 없음, Output dir: `/` (루트)
2. **환경변수** : `ANTHROPIC_API_KEY` 설정 (Production)
3. **Custom domain** : `idea.samsungda.net` 연결
4. (선택) **Version metadata 바인딩** : `CF_VERSION_METADATA` 추가 시 하단 update 배지 표시

## DA 생태계

| 도구 | URL | repo |
| --- | --- | --- |
| 도구모음 (포털) | samsungda.net | samsungda-portal |
| 보고서 자판기 | report.samsungda.net | report-site |
| **아이디어 자판기** | **idea.samsungda.net** | **report-idea** |
| Market Insight | mi.samsungda.net | market-insight |
| 2030 미래 트렌드 | 2030.samsungda.net | 2030-insight |
| Quick Share | quickshare.samsungda.net | QuickShare |
| My Space | space.samsungda.net | samsungda-space |

## 다음 단계 (예정)

- 소스 실데이터 주입 : MI/2030/업로드 보고서 본문을 실제로 가져와 근거에 반영
- 도구모음(`samsungda-portal`) 카드 추가
- 뽑은 주제 → 보고서 자판기로 원클릭 전달
