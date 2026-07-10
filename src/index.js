// src/index.js
// 아이디어 자판기 Worker
// - 정적 자산(public/)은 ASSETS 바인딩이 자동 서빙
// - /api/generate : 보고 주제 생성 (Claude API, web_search 옵션, 업로드 보고서 R2 주입)
// - /api/version  : 배포 시각 배지 (CF_VERSION_METADATA)
// - /api/bank     : 아이디어 뱅크 CRUD (R2 samsungda-research, prefix idea-bank/)

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/generate") {
      if (request.method !== "POST") return text("POST only", 405);
      return handleGenerate(request, env);
    }
    if (url.pathname === "/api/version") {
      return handleVersion(env);
    }
    if (url.pathname === "/api/bank") {
      return handleBank(request, env);
    }
    if (url.pathname === "/changelog.json") {
      return handleChangelog(request, env, ctx);
    }
    // 그 외는 정적 자산
    return env.ASSETS.fetch(request);
  },
};

// ===== /changelog.json — GitHub main 커밋에서 최근 변경 이력을 동적 생성 =====
// 머지되면 자동 반영. 데이터 소스는 GitHub 커밋 Atom 피드(github.com, CDN 캐시·rate-limit-free).
// 정적 public/changelog.json은 제거됨 → 자산 충돌 없이 이 Worker 핸들러가 처리.
const CHANGELOG_REPO = "SimpleorNothing/report-idea";
const CHANGELOG_BRANCH = "main";

async function handleChangelog(request, env, ctx) {
  const cache = caches.default;
  const cacheKey = new Request("https://changelog.cache/report-idea");
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  try {
    // api.github.com(비인증 60/시간) 대신 커밋 Atom 피드를 사용 — CDN 캐시, rate limit 사실상 없음
    const feedUrl = `https://github.com/${CHANGELOG_REPO}/commits/${CHANGELOG_BRANCH}.atom`;
    const gh = await fetch(feedUrl, {
      headers: { "User-Agent": "report-idea-changelog" },
      cf: { cacheTtl: 300, cacheEverything: true },
    });
    if (!gh.ok) throw new Error("atom " + gh.status);
    const xml = await gh.text();

    const entries = [];
    for (const block of xml.split("<entry>").slice(1)) {
      const tm = block.match(/<title>([\s\S]*?)<\/title>/);
      const um = block.match(/<updated>([\s\S]*?)<\/updated>/);
      if (!tm || !um) continue;
      const subject = decodeXml(tm[1]).replace(/\s+/g, " ").trim();
      if (!subject || /^Merge\b/i.test(subject)) continue;       // 머지 커밋 제외
      const desc = subject.replace(/\s*\(#\d+\)\s*$/, "").trim(); // PR 번호 꼬리 제거
      const { date, time } = toKST(um[1].trim());
      if (!date) continue;
      entries.push({ date, time, desc });
      // 캡 없음 — Atom 피드가 제공하는 파악 가능한 변경 이력을 모두 포함(프런트에서 스크롤)
    }
    if (!entries.length) throw new Error("empty");

    const resp = new Response(JSON.stringify({ entries }), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=300",
      },
    });
    ctx.waitUntil(cache.put(cacheKey, resp.clone()));
    return resp;
  } catch (e) {
    // Atom 피드 일시 실패 → 502. 프런트가 /api/version(배포 시각)으로 폴백한다.
    return json({ error: "changelog feed unavailable" }, 502);
  }
}

// XML 엔티티 디코드 (&amp; 는 마지막에)
function decodeXml(s) {
  return String(s)
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

// ISO(UTC) → KST(UTC+9) date/time
function toKST(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return { date: "", time: "" };
  const k = new Date(d.getTime() + 9 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return {
    date: `${k.getUTCFullYear()}-${p(k.getUTCMonth() + 1)}-${p(k.getUTCDate())}`,
    time: `${p(k.getUTCHours())}:${p(k.getUTCMinutes())}`,
  };
}

const TOPIC_GUIDE = {
  consumer: "소비자 — 수요·라이프스타일 변화, 구매요인(KBF), 세대/가구구조, 가격민감도, 채널·구독 등 고객 관점의 보고 주제",
  tech:     "기술 — AI·연결성·에너지효율·친환경 소재/냉매·신공정 등 제품·요소기술 관점의 보고 주제",
  rival:    "경쟁사 — 주요 경쟁사(LG, 중국 브랜드 등) 전략·신제품·BM·점유율 위협 등 경쟁 대응 관점의 보고 주제",
};

const SOURCE_GUIDE = {
  mi:      "Market Insight(시장 동향·뉴스 분류 결과)의 최신 이슈",
  ci:      "경쟁사 전략 추적(CI) 보드의 경쟁사 전략 프레임·전략축·실행 증거",
  "2030":  "2030 미래 트렌드 보드의 8대 메가트렌드",
  reports: "사내에 축적된 업로드 보고서(실제 목록·본문이 아래에 제공됨)",
  search:  "웹 신규 검색으로 수집한 최신 자료",
};

// 아이디어 방향 — 매출 확대(sales) / 수익성 강화(profit)
const DIRECTION_GUIDE = {
  sales:  `매출 확대 — 톱라인(매출) 성장 관점. 신사업 진출, 신규 제품·카테고리, 새로운 비즈니스 모델(구독·서비스·플랫폼·솔루션), 신규 고객층·신시장·신채널 발굴 등 "새로운 매출원"을 만드는 보고 주제만 도출한다. 단순 원가절감·운영효율 주제는 배제한다.`,
  profit: `수익성 강화 — 보텀라인(이익) 개선 관점. 운영효율 증대, 원가구조 개선, 생산성·SCM·물류 최적화, 프로세스 자동화, 품질비용(COPQ) 절감, 제품·채널 믹스 개선 등 "이익률을 끌어올리는" 보고 주제만 도출한다. 신규 매출 창출 주제는 배제한다.`,
};

async function handleGenerate(request, env) {
  if (!env.ANTHROPIC_API_KEY) {
    return json({ error: "ANTHROPIC_API_KEY 가 설정되지 않았습니다 (Worker Settings → Variables and Secrets)." }, 500);
  }

  let body;
  try { body = await request.json(); }
  catch { return text("잘못된 요청 형식입니다.", 400); }

  const topics  = Array.isArray(body.topics) && body.topics.length ? body.topics : ["consumer"];
  const count   = Math.max(1, Math.min(8, parseInt(body.count) || 3));
  let directions = Array.isArray(body.directions)
    ? body.directions.filter(d => d === "sales" || d === "profit")
    : [];
  if (!directions.length) directions = [body.direction === "profit" ? "profit" : "sales"];
  const sources = Array.isArray(body.sources) ? body.sources : [];
  const keyword = (body.keyword || "").trim();
  const useSearch = sources.includes("search");
  const useReports = sources.includes("reports");
  const useMi = sources.includes("mi");
  const useCi = sources.includes("ci");
  const use2030 = sources.includes("2030");

  const topicLines  = topics.map(t => "- " + (TOPIC_GUIDE[t] || t)).join("\n");
  const sourceLines = sources.length
    ? sources.map(s => "- " + (SOURCE_GUIDE[s] || s)).join("\n")
    : "- 일반적인 가전 산업 지식";

  // 업로드 보고서 실데이터 주입 (R2: samsungda-research)
  let reportBlock = "";
  let reportSources = null;
  if (useReports) {
    try {
      const rc = await gatherReportContext(env, { topics, keyword });
      reportBlock = rc.block;
      reportSources = { total: rc.total, catalog: rc.catalog, excerpted: rc.excerpted, related: rc.related, items: rc.items };
    } catch (e) { reportBlock = ""; }
  }

  // Market Insight 실데이터 주입 (mi.samsungda.net/data/news.json)
  let miBlock = "", miSources = [];
  if (useMi) {
    try { const r = await gatherMarketInsight(topics, keyword); miBlock = r.block; miSources = r.sources; }
    catch (e) { miBlock = ""; }
  }

  // 경쟁사 전략 추적(CI) 실데이터 주입 (competitor_intelligence 공개 저장소 raw)
  let ciBlock = "", ciSources = [];
  if (useCi) {
    try { const r = await gatherCI(topics, keyword); ciBlock = r.block; ciSources = r.sources; }
    catch (e) { ciBlock = ""; }
  }

  // 2030 미래 트렌드 주입 (실사이트 fetch + 선택 주제 관련성 필터)
  let trendBlock = "", trendSources = [];
  if (use2030) {
    try { const r = await gather2030(topics, keyword, env); trendBlock = r.block; trendSources = r.sources; }
    catch (e) { trendBlock = ""; }
  }

  const detailRule = `각 아이디어는 "title"(문자열), "topic"(문자열), "content", "opportunity", "threat", "angle", "sources"(문자열 배열) 필드를 가진다.
content·opportunity·threat·angle 네 필드는 모두 "문자열 배열"이며, 각 배열은 핵심만 담은 1~3개의 짧은 항목(bullet)으로 구성한다.
- 각 bullet은 개조식 명사형으로 끝낸다. "~했다·~한다·~이다·~된다·~중" 같은 서술형 종결을 쓰지 말고, 명사·명사구로 압축해 마침표 없이 끝낸다(한국어 약 15~40자).
- 한 bullet에 한 메시지만 담고, 조사·서술어·군더더기·중복은 최대한 덜어내 핵심 정보 밀도를 높인다.
- content : 무엇에 관한 주제인지 — 시장·현상 근거를 1~3개 bullet로.
- opportunity : 이 주제에서 "당사(삼성 DA)"가 잡을 기회를 1~3개 bullet로.
- threat : 이 주제가 당사에 주는 위협·리스크를 1~3개 bullet로.
- angle : "보고서 방향" — (1) 왜 지금 보고해야 하는지(타이밍·분기점), (2) 사업부에 줄 메시지·의사결정을 1~3개 bullet로.
- 각 bullet에서 강조할 핵심어는 <b>...</b> 로 최대 1곳만 감싼다.
- "sources" : 이 아이디어를 도출할 때 "실제 근거로 삼은" 소스의 ID만 배열로 나열한다. 위 [Market Insight]·[경쟁사 전략 추적(CI)]·[2030 미래 트렌드]·[업로드 보고서] 블록에서 각 항목 앞에 붙은 [M#]·[C#]·[T#]·[R#] 형식 ID를 대괄호 없이 그대로 쓴다(예: ["M3","C2","T5","R2"]). 실제로 근거가 된 소스만 넣고, 내용과 무관한 소스는 절대 넣지 마라. 근거가 없으면 빈 배열 []. 자신의 아이디어 내용과 직접 연결되는 소스만 신중히 고른다.
예(명사형 종결): "content": ["월풀 CEO, 소비지출 <b>2008년 위기 수준</b> 경고", "북미 가전 수요 구조적 저점 진입"], "sources": ["M1","C2","T5"]`;

  const system = `너는 삼성 생활가전(DA) 사업부의 시니어 기획 담당이다. 사업부장에게 보고할 "보고서 주제"를 발굴한다.
- 산출물은 완성된 보고서가 아니라, 보고할 가치가 있는 "주제(아이디어)"의 개요다.
- 각 아이디어의 제목은 한 줄로 구체적이고 보고서 제목처럼 쓴다.
- 각 아이디어는 "내용 · 당사 기회 · 당사 위협 · 보고서 방향" 네 관점으로 구성한다.
- 내용·당사 기회·당사 위협·보고서 방향은 각각 1~3개의 짧은 bullet로 쓴다(한 bullet = 명사형 한 구절, 서술형 종결·군더더기·중복 금지).
- 기회와 위협은 막연한 일반론이 아니라 "당사(삼성 DA)" 입장에서 구체적으로 쓴다.
- 추측성 수치는 단정하지 말고 방향성 위주로 쓴다.
- 모든 아이디어는 아래 지정된 "아이디어 방향"에 부합해야 한다. 방향과 어긋나는 주제는 절대 포함하지 않는다.
- 한국어로 작성한다.
${detailRule}`;

  const userParts = [];
  userParts.push(`다음 조건으로 보고 주제 ${count}개를 생성하라.`);
  userParts.push(`\n[아이디어 방향 — 최우선 기준]\n- ${directions.map(d => DIRECTION_GUIDE[d]).join("\n- ")}`);
  userParts.push(`\n[주제 영역]\n${topicLines}`);
  userParts.push(`\n[근거로 우선 참고할 출처]\n${sourceLines}`);
  if (miBlock) userParts.push(`\n${miBlock}`);
  if (ciBlock) userParts.push(`\n${ciBlock}`);
  if (trendBlock) userParts.push(`\n${trendBlock}`);
  if (reportBlock) userParts.push(`\n${reportBlock}`);
  if (keyword) userParts.push(`\n[지정 주제 — 반영 필수] "${keyword}" — 생성하는 모든 아이디어는 이 주제와 직접 연관되어야 한다.`);
  if (useSearch && keyword) userParts.push(`\n[신규 검색 키워드] ${keyword} — 웹 검색으로 최신 동향을 반영하라.`);
  else if (useSearch)        userParts.push(`\n[신규 검색] 선택된 주제 영역의 최신 동향을 웹 검색으로 반영하라.`);
  userParts.push(`\n[topic 값] 각 아이디어의 "topic" 필드는 다음 중 선택한 주제에 해당하는 값만 사용: ${topics.map(t=>`"${t}"`).join(", ")}.`);
  userParts.push(`\n반드시 JSON 배열만 출력하라. 마크다운 코드펜스나 설명 문장 없이, [ 로 시작해 ] 로 끝나는 JSON 배열 하나만 출력한다.`);

  // 아이디어 1건은 title/topic/sources + content·opportunity·threat·angle(각 최대 3 bullet)로
  // 한국어 기준 대략 700~900 토큰. count가 크면 4096으로는 JSON이 중간에 잘려(max_tokens)
  // 파싱이 실패한다 → 개수에 비례해 넉넉히 잡고, sonnet 한도 내에서 상한을 둔다.
  const maxTokens = Math.min(16000, 3000 + count * 1600);
  const reqBody = {
    model: "claude-sonnet-4-6",
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: userParts.join("\n") }],
  };
  if (useSearch) {
    reqBody.tools = [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }];
  }

  // 일시적 게이트웨이 장애(502/503/504/529)·429·네트워크 오류는 지수 백오프로 재시도
  const call = await callAnthropicWithRetry(reqBody, env);
  if (!call.ok) {
    return json({ error: call.error }, 502);
  }

  const data = await call.res.json();
  const fullText = (data.content || [])
    .filter(b => b.type === "text")
    .map(b => b.text)
    .join("\n")
    .trim();

  const ideas = parseIdeas(fullText, topics);
  if (!ideas.length) {
    return json({ error: "응답 파싱에 실패했습니다. 다시 시도해주세요.", raw: fullText.slice(0, 300) }, 502);
  }
  const searchSources = useSearch ? collectSearchSources(data.content) : [];
  return json({ ideas: ideas.slice(0, count), reportsUsed: useReports && !!reportBlock, reportSources, searchSources, miSources, ciSources, trendSources });
}

// ===== 업로드 보고서(R2) 컨텍스트 수집 =====
// 반환: { block, total, catalog:[제목...], excerpted:[본문까지 읽은 제목...], related:[키워드 관련 제목...], items:[{id,title}...] }
async function gatherReportContext(env, opts = {}) {
  const maxExtract  = opts.maxExtract  ?? 10;    // 본문 추출할 docx 최대 개수
  const perFileChars = opts.perFileChars ?? 2200; // 파일당 발췌 글자수
  const totalCap    = opts.totalCap    ?? 22000;  // 발췌 총량 상한
  const keyword     = (opts.keyword || "").trim();
  const empty = { block: "", total: 0, catalog: [], excerpted: [], related: [] };
  if (!env.RESEARCH) return empty;

  let listed;
  try { listed = await env.RESEARCH.list({ include: ["customMetadata", "httpMetadata"] }); }
  catch (e) { return empty; }

  const objs = (listed.objects || []).map(o => ({
    key: o.key,
    title: o.customMetadata?.title ? safeDecode(o.customMetadata.title) : o.key,
    name:  o.customMetadata?.name  ? safeDecode(o.customMetadata.name)  : o.key,
    type:  o.httpMetadata?.contentType || "",
    uploaded: o.uploaded,
  }));
  if (!objs.length) return empty;
  objs.sort((a, b) => new Date(b.uploaded) - new Date(a.uploaded));

  const catalogTitles = objs.map(o => o.title);
  const catalog = catalogTitles.map((t, i) => `${i + 1}. ${t}`).join("\n");

  // 키워드 관련성 스코어 (제목·파일명 기준)
  const kwTokens = keyword ? keyword.split(/[\s,·/]+/).filter(t => t.length >= 2) : [];
  const relScore = (o) => {
    if (!kwTokens.length) return 0;
    const hay = `${o.title} ${o.name}`;
    let n = 0;
    for (const tok of kwTokens) if (hay.includes(tok)) n++;
    return n;
  };
  const relatedTitles = kwTokens.length ? objs.filter(o => relScore(o) > 0).map(o => o.title) : [];

  // 본문 발췌 대상: 키워드 관련 보고서 우선, 동점은 최신순
  let docxObjs = objs.filter(o => /\.docx$/i.test(o.name) || /wordprocessingml/i.test(o.type));
  docxObjs = docxObjs.slice().sort((a, b) => {
    const r = relScore(b) - relScore(a);
    if (r) return r;
    return new Date(b.uploaded) - new Date(a.uploaded);
  });
  const excerpts = [];
  const excerptedTitles = [];
  const reportItems = [];
  let total = 0;
  for (const o of docxObjs) {
    if (excerpts.length >= maxExtract || total >= totalCap) break;
    try {
      const obj = await env.RESEARCH.get(o.key);
      if (!obj) continue;
      const ab = await obj.arrayBuffer();
      let t = await extractDocxText(ab, perFileChars);
      if (!t) continue;
      const remain = totalCap - total;
      if (t.length > remain) t = t.slice(0, remain) + " …";
      total += t.length;
      const rid = "R" + (reportItems.length + 1);
      excerpts.push(`### [${rid}] ${o.title}\n${t}`);
      excerptedTitles.push(o.title);
      reportItems.push({ id: rid, title: o.title });
    } catch (e) { /* skip this file */ }
  }

  let block = `[업로드 보고서 — 실제 사내 보고서]\n`
    + `· 전체 ${objs.length}건. 아래 목록과 본문 발췌는 사내에 실제로 축적된 보고서다.\n`
    + (kwTokens.length ? `· 이번 주제·키워드와 관련된 보고서 본문을 우선 발췌했다. 무관한 보고서는 근거로 끌어오지 마라.\n` : ``)
    + `· 본문 발췌가 제공된 보고서 제목 앞 [R#]는 인용용 소스 ID다.\n`
    + `· 이미 다룬 주제는 그대로 반복하지 말고, 빈틈·후속·심화·교차 주제를 우선 발굴하라.\n\n`
    + `[보고서 목록]\n${catalog}`;
  if (excerpts.length) {
    block += `\n\n[주요 보고서 본문 발췌]\n${excerpts.join("\n\n")}`;
  }
  return { block, total: objs.length, catalog: catalogTitles, excerpted: excerptedTitles, related: relatedTitles, items: reportItems };
}

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

// ===== docx 텍스트 추출 (ZIP local header 스캔 + DecompressionStream) =====
async function extractDocxText(arrayBuffer, maxChars = 0) {
  const buf = new Uint8Array(arrayBuffer);
  const dv = new DataView(arrayBuffer);
  const dec = new TextDecoder();
  let i = 0;
  while (i + 30 <= buf.length) {
    if (dv.getUint32(i, true) !== 0x04034b50) break;
    const gpflag   = dv.getUint16(i + 6, true);
    const method   = dv.getUint16(i + 8, true);
    const compSize = dv.getUint32(i + 18, true);
    const nameLen  = dv.getUint16(i + 26, true);
    const extraLen = dv.getUint16(i + 28, true);
    const nameStart = i + 30;
    const name = dec.decode(buf.subarray(nameStart, nameStart + nameLen));
    const dataStart = nameStart + nameLen + extraLen;
    if ((gpflag & 0x08) && compSize === 0) break; // 데이터 디스크립터 → 순차 스캔 불가
    if (name === "word/document.xml") {
      const data = buf.subarray(dataStart, dataStart + compSize);
      let xmlBytes;
      if (method === 0) xmlBytes = data;
      else if (method === 8) xmlBytes = await inflateRaw(data);
      else return "";
      return xmlToText(dec.decode(xmlBytes), maxChars);
    }
    i = dataStart + compSize;
  }
  return "";
}

async function inflateRaw(bytes) {
  const ds = new DecompressionStream("deflate-raw");
  const stream = new Response(bytes).body.pipeThrough(ds);
  const ab = await new Response(stream).arrayBuffer();
  return new Uint8Array(ab);
}

function xmlToText(xml, maxChars) {
  let t = xml
    .replace(/<\/w:p>/g, "\n")
    .replace(/<w:tab\b[^>]*\/>/g, "\t")
    .replace(/<[^>]+>/g, "");
  t = t.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
       .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
  t = t.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+\n/g, "\n").trim();
  if (maxChars && t.length > maxChars) t = t.slice(0, maxChars) + " …(이하 생략)";
  return t;
}

// ===== Market Insight 실데이터 (news.json) =====
// topic(consumer/tech/rival) → lens(소비자/기술/경쟁사) 매핑
const LENS_MAP = { consumer: "소비자", tech: "기술", rival: "경쟁사" };
const GRADE_RANK = { "긴급": 4, "주요": 3, "주시": 2, "참고": 1 };

async function gatherMarketInsight(topics, keyword, opts = {}) {
  const perLens = opts.perLens ?? 6;   // 렌즈별 최대 항목
  const cap     = opts.cap ?? 18;      // 총 상한
  const empty = { block: "", sources: [] };
  const wantLens = new Set((topics || []).map(t => LENS_MAP[t]).filter(Boolean));
  if (!wantLens.size) return empty;

  let data;
  try {
    const res = await fetch("https://mi.samsungda.net/data/news.json", {
      cf: { cacheTtl: 600, cacheEverything: true },
    });
    if (!res.ok) return empty;
    data = await res.json();
  } catch (e) { return empty; }

  const items = Array.isArray(data.items) ? data.items : [];

  // 키워드 관련성: headline·summary·products·competitors 매칭 수
  const kwTokens = (keyword || "").trim()
    ? keyword.split(/[\s,·/]+/).filter(t => t.length >= 2)
    : [];
  const kwHit = (it) => {
    if (!kwTokens.length) return 0;
    const hay = [
      it.headline, it.summary,
      Array.isArray(it.products) ? it.products.join(" ") : it.products,
      Array.isArray(it.competitors) ? it.competitors.join(" ") : it.competitors,
    ].map(x => String(x || "")).join(" ");
    let n = 0;
    for (const tok of kwTokens) if (hay.includes(tok)) n++;
    return n;
  };
  const sortFn = (a, b) => {
    const kw = kwHit(b) - kwHit(a);   // 키워드 관련성 최우선
    if (kw) return kw;
    const gr = (GRADE_RANK[b.grade] || 0) - (GRADE_RANK[a.grade] || 0);
    if (gr) return gr;
    const im = (b.impact || 0) - (a.impact || 0);
    if (im) return im;
    return new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0);
  };

  const byLens = {};
  for (const it of items) {
    if (it && wantLens.has(it.lens)) (byLens[it.lens] = byLens[it.lens] || []).push(it);
  }
  const picked = [];
  for (const lens of wantLens) {
    let arr = (byLens[lens] || []).slice();
    // 키워드가 있고 그 렌즈에 매칭 항목이 있으면 매칭된 것만 남긴다
    if (kwTokens.length) {
      const matched = arr.filter(it => kwHit(it) > 0);
      if (matched.length) arr = matched;
    }
    arr = arr.sort(sortFn).slice(0, perLens);
    picked.push(...arr);
  }
  if (!picked.length) return empty;

  const top = picked.sort(sortFn).slice(0, cap).map((it, i) => ({ ...it, _id: "M" + (i + 1) }));
  const sources = top.map(it => ({
    id: it._id,
    title: it.headline || "",
    url: it.url || "",
    lens: it.lens || "",
    grade: it.grade || "",
  })).filter(s => s.title);

  const lines = top.map(it =>
    `- [${it._id}] [${it.lens}] ${it.headline}` + (it.summary ? ` — ${String(it.summary).slice(0, 90)}` : "")
  ).join("\n");
  const block = `[Market Insight — 실시간 수집·분류된 시장 신호]\n`
    + `· mi.samsungda.net 파이프라인이 분류한 실데이터다. 각 신호 앞 [M#]는 인용용 소스 ID, 뒤 (렌즈)는 분류 라벨이다.\n`
    + (kwTokens.length ? `· 이번 키워드와 관련된 신호를 우선 정렬했다. 무관한 신호는 근거로 끌어오지 마라.\n` : ``)
    + `· 아래 신호를 근거로 보고 주제를 도출하라.\n\n${lines}`;
  return { block, sources };
}

// ===== 경쟁사 전략 추적(CI) 실데이터 =====
// ci.samsungda.net 은 SSO(SITE_PASSWORD·세션 쿠키)로 게이트되어 Worker에서 직접 fetch가 막힐 수 있어,
// 공개 저장소(competitor_intelligence) main 브랜치의 raw JSON을 읽는다(CI는 main push 자동배포 → 배포본과 동일 최신).
const CI_STRATEGIES_URL = "https://raw.githubusercontent.com/SimpleorNothing/competitor_intelligence/main/public/data/strategies.json";
const CI_EVIDENCE_URL   = "https://raw.githubusercontent.com/SimpleorNothing/competitor_intelligence/main/public/data/evidence.json";
const CI_SIGNAL_RANK = { Insight: 3, Deep: 2, New: 1 };

async function gatherCI(topics, keyword, opts = {}) {
  const cap = opts.cap ?? 14;      // 총 증거 상한
  const empty = { block: "", sources: [] };

  let strategies, evidence;
  try {
    const [rs, re] = await Promise.all([
      fetch(CI_STRATEGIES_URL, { cf: { cacheTtl: 900, cacheEverything: true } }),
      fetch(CI_EVIDENCE_URL,   { cf: { cacheTtl: 600, cacheEverything: true } }),
    ]);
    if (!rs.ok || !re.ok) return empty;
    strategies = await rs.json();
    evidence   = await re.json();
  } catch (e) { return empty; }

  const companies = Array.isArray(strategies?.companies) ? strategies.companies : [];
  const items     = Array.isArray(evidence?.items) ? evidence.items : [];
  const active    = companies.filter(c => c && c.active);
  if (!active.length || !items.length) return empty;

  // 축·기업 라벨 조회 맵
  const axisMap = {}, compMap = {};
  for (const c of companies) {
    compMap[c.id] = c.shortName || c.name || c.id;
    (Array.isArray(c.axes) ? c.axes : []).forEach(a => {
      axisMap[a.id] = { title: a.title || a.code || "", status: a.execStatus || "" };
    });
  }
  const axisLabel = (axisId) => {
    if (axisId && /-frame$/.test(axisId)) return "전략 프레임";
    const a = axisMap[axisId];
    return a ? (a.title + (a.status ? ` (${a.status})` : "")) : "";
  };

  const activeIds = new Set(active.map(c => c.id));
  const kwTokens = (keyword || "").trim()
    ? keyword.split(/[\s,·/]+/).filter(t => t.length >= 2) : [];
  const kwHit = (it) => {
    if (!kwTokens.length) return 0;
    const hay = [it.event, it.interpretation, compMap[it.companyId], axisLabel(it.axisId)]
      .map(x => String(x || "")).join(" ");
    let n = 0; for (const tok of kwTokens) if (hay.includes(tok)) n++; return n;
  };
  const sortFn = (a, b) => {
    const kw = kwHit(b) - kwHit(a); if (kw) return kw;
    const sg = (CI_SIGNAL_RANK[b.signalType] || 0) - (CI_SIGNAL_RANK[a.signalType] || 0); if (sg) return sg;
    const cf = ((b.confidence === "사실") ? 1 : 0) - ((a.confidence === "사실") ? 1 : 0); if (cf) return cf;
    return new Date(b.date || 0) - new Date(a.date || 0);
  };

  let pool = items.filter(it => activeIds.has(it.companyId));
  if (kwTokens.length) {
    const matched = pool.filter(it => kwHit(it) > 0);
    if (matched.length) pool = matched;
  }
  pool = pool.sort(sortFn).slice(0, cap);
  if (!pool.length) return empty;

  const top = pool.map((it, i) => ({ ...it, _id: "C" + (i + 1) }));

  // 전략 프레임·축 요약(배경 맥락 — 인용 ID 없음)
  const frameLines = active.map(c => {
    const axes = (Array.isArray(c.axes) ? c.axes : [])
      .map(a => `${a.title}${a.execStatus ? ` (${a.execStatus})` : ""}`).join(" / ");
    const stmt = c.frame?.statement || "";
    return `· ${c.shortName || c.name}${stmt ? ` — ${stmt}` : ""}` + (axes ? `\n    축: ${axes}` : "");
  }).join("\n");

  const evLines = top.map(it => {
    const comp = compMap[it.companyId] || it.companyId;
    const ax = axisLabel(it.axisId);
    const interp = it.interpretation ? ` — ${String(it.interpretation).slice(0, 100)}` : "";
    return `- [${it._id}] [${comp}${ax ? ` · ${ax}` : ""}] ${it.event}${interp}`;
  }).join("\n");

  const block = `[경쟁사 전략 추적(CI) — 경쟁사 전략 프레임·실행 증거]\n`
    + `· ci.samsungda.net 보드가 추적하는 경쟁사 전략축과 실행 증거다. 각 증거 앞 [C#]는 인용용 소스 ID, [ ]안은 (기업 · 전략축)이다.\n`
    + (kwTokens.length ? `· 이번 키워드와 관련된 증거를 우선 정렬했다. 무관한 증거는 근거로 끌어오지 마라.\n` : ``)
    + `· 아래 경쟁사 움직임을 근거로, 당사(삼성 DA) 대응 관점의 보고 주제를 도출하라.\n\n`
    + `[전략 프레임 요약]\n${frameLines}\n\n[실행 증거]\n${evLines}`;

  const sources = top.map(it => {
    const comp = compMap[it.companyId] || it.companyId;
    const evt = String(it.event || "").replace(/\s+/g, " ");
    return {
      id: it._id,
      title: `${comp} · ${evt.length > 78 ? evt.slice(0, 78) + "…" : evt}`,
      url: it.source?.url || "",
      company: comp,
      axis: axisLabel(it.axisId),
      date: it.date || "",
    };
  }).filter(s => s.title);

  return { block, sources };
}

// ===== 2030 미래 트렌드 (실사이트 fetch + 관련성 필터) =====
// 2030.samsungda.net 보드를 직접 읽어 8대 메가트렌드의 명칭·관점축·시장근거를 파싱하고,
// 이번에 선택된 주제(topic)·키워드와 "관련 있는 트렌드"만 추려 근거로 제공한다.

// fetch/파싱 실패 시의 최소 골격 (사이트 카드 기준으로 동기화)
const MEGATRENDS_2030_FALLBACK = [
  { id: "T1", name: "AI 에이전트 가전",      chip: "Tech → 기술·소비자축",      ph: "" },
  { id: "T2", name: "AI 데이터센터 냉각",     chip: "Tech·Econ → 기술·공급망축", ph: "" },
  { id: "T3", name: "저GWP·자연냉매 전환",    chip: "Env·Pol → 규제·기술축",     ph: "" },
  { id: "T4", name: "히트펌프 전기화",        chip: "Env·Pol → 규제·기술축",     ph: "" },
  { id: "T5", name: "가전 구독·서비스화",     chip: "Econ·Social → 소비자·BM",   ph: "" },
  { id: "T6", name: "순환경제·수리권",        chip: "Env·Pol → 규제·공급망축",   ph: "" },
  { id: "T7", name: "그리드 인터랙티브 가전", chip: "Env·Tech → 기술·규제축",    ph: "" },
  { id: "T8", name: "실버·헬스케어 가전",     chip: "Social → 소비자·기술축",    ph: "" },
];

// 선택 topic → 트렌드 관점축(chip)에서 찾을 키워드
const TOPIC_AXIS_KEYS = {
  consumer: ["소비자", "BM", "Social"],
  tech:     ["기술", "Tech"],
  rival:    [], // 경쟁사는 특정 축에 매이지 않음 — 키워드/전체로 처리
};

// 2030 보드 HTML에서 8대 메가트렌드 카드(명칭·축·근거)를 파싱
async function fetch2030Trends() {
  const res = await fetch("https://2030.samsungda.net/", {
    cf: { cacheTtl: 1800, cacheEverything: true },
  });
  if (!res.ok) throw new Error("2030 fetch " + res.status);
  const html = await res.text();
  const out = [];
  const cardRe = /<div class="tag">(T\d)<\/div><h4>([^<]*)<\/h4><span class="chip">([^<]*)<\/span>(?:<div class="ph">([^<]*)<\/div>)?/g;
  let c;
  while ((c = cardRe.exec(html))) {
    out.push({ id: c[1], name: (c[2] || "").trim(), chip: (c[3] || "").trim(), ph: (c[4] || "").trim() });
  }
  const seen = new Set();
  const trends = out.filter(t => !seen.has(t.id) && seen.add(t.id)).sort((a, b) => a.id.localeCompare(b.id));
  if (trends.length < 4) throw new Error("2030 card parse insufficient: " + trends.length);
  return trends;
}

async function gather2030(topics, keyword, env) {
  let trends;
  try { trends = await fetch2030Trends(); }
  catch (e) { trends = MEGATRENDS_2030_FALLBACK; }

  const kwTokens = (keyword || "").trim()
    ? keyword.split(/[\s,·/]+/).filter(t => t.length >= 2)
    : [];
  const axisKeys = (topics || []).flatMap(t => TOPIC_AXIS_KEYS[t] || []);

  const scored = trends.map(t => {
    const hay = `${t.id} ${t.name} ${t.chip} ${t.ph}`;
    let kw = 0, ax = 0;
    for (const tok of kwTokens) if (hay.includes(tok)) kw++;
    for (const a of axisKeys) if (t.chip.includes(a)) ax++;
    return { t, kw, ax };
  });

  // 우선순위: 키워드 직접 매칭 > 주제 관점축 매칭 > 전체
  let picked, related = true;
  const kwMatched = scored.filter(s => s.kw > 0);
  if (kwTokens.length && kwMatched.length) {
    picked = kwMatched.sort((a, b) => (b.kw - a.kw) || (b.ax - a.ax)).map(s => s.t);
  } else {
    const axMatched = scored.filter(s => s.ax > 0);
    if (axMatched.length) picked = axMatched.sort((a, b) => b.ax - a.ax).map(s => s.t);
    else { picked = trends; related = false; }
  }

  const lines = picked.map(t =>
    `- [${t.id}] ${t.name}` + (t.chip ? ` (${t.chip})` : "") + (t.ph ? ` — ${t.ph}` : "")
  ).join("\n");
  const idNote = `· 각 트렌드 앞 [T#]는 인용용 소스 ID다.\n`;
  const head = related
    ? `[2030 미래 트렌드 — 선택 주제와 관련된 메가트렌드]\n`
      + `· 2030.samsungda.net 보드의 8대 메가트렌드 중 이번 주제·키워드와 연관된 트렌드만 추렸다(개별 기사 아님).\n` + idNote
    : `[2030 미래 트렌드 — DA 8대 메가트렌드 골격]\n`
      + `· 2030.samsungda.net 보드의 8대 메가트렌드 전체다(주제 특정 신호가 없어 전체 제공, 개별 기사 아님).\n` + idNote;
  const block = head
    + `· 이 메가트렌드 흐름과 연결해 중장기 보고 주제를 도출하라.\n\n${lines}`;

  const sources = picked.map(t => ({ id: t.id, title: `${t.id} ${t.name}`, related }));
  return { block, sources };
}

// ===== web_search 인용 출처 수집 =====
// Claude API 응답의 web_search_tool_result 블록에서 실제 참고한 기사(title·url)를 모은다.
function collectSearchSources(content) {
  const out = [];
  const seen = new Set();
  for (const b of (content || [])) {
    if (b && b.type === "web_search_tool_result" && Array.isArray(b.content)) {
      for (const r of b.content) {
        if (r && r.type === "web_search_result" && r.url && !seen.has(r.url)) {
          seen.add(r.url);
          out.push({ title: r.title || r.url, url: r.url });
        }
      }
    }
  }
  return out;
}

// ===== Anthropic API 호출 (지수 백오프 재시도) =====
// api.anthropic.com 앞단 게이트웨이의 일시적 502/503/504, 과부하 529, 429, 네트워크 오류는
// 대부분 재시도로 해소된다("error code: 502"는 origin 앞단 CF 엣지 일시 장애 형식).
// 4xx(인증·요청 오류 등)는 재시도해도 동일하므로 즉시 반환한다.
async function callAnthropicWithRetry(reqBody, env, { retries = 2 } = {}) {
  const RETRIABLE = new Set([408, 425, 429, 500, 502, 503, 504, 529]);
  let last = "Claude API 호출 실패";
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res;
    try {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(reqBody),
      });
    } catch (e) {
      last = "Claude API 호출 실패: " + e.message;
      if (attempt < retries) { await sleep(backoffMs(attempt)); continue; }
      return { ok: false, status: 502, error: last };
    }

    if (res.ok) return { ok: true, res };

    const errTxt = await res.text().catch(() => "");
    last = `Claude API 오류 (${res.status}): ${errTxt.slice(0, 500)}`;
    if (RETRIABLE.has(res.status) && attempt < retries) { await sleep(backoffMs(attempt)); continue; }
    return { ok: false, status: res.status, error: last };
  }
  return { ok: false, status: 502, error: last };
}

// 지수 백오프 + 지터: 0.6s, 1.2s … (상한 6s)
function backoffMs(attempt) {
  return Math.min(6000, 600 * Math.pow(2, attempt)) + Math.floor(Math.random() * 400);
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// 잘린 JSON 문자열에서 최상위 완성 객체({...})만 순차 복구한다.
// max_tokens로 배열이 중간에 끊겨도 이미 완성된 앞쪽 아이디어는 살릴 수 있다.
function salvageObjects(s) {
  const out = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; }
    else if (c === "{") { if (depth === 0) start = i; depth++; }
    else if (c === "}") {
      if (depth > 0 && --depth === 0 && start !== -1) {
        try { out.push(JSON.parse(s.slice(start, i + 1))); } catch { /* 불완전 객체 skip */ }
        start = -1;
      }
    }
  }
  return out;
}

function parseIdeas(textOut, topics) {
  let clean = textOut.replace(/```json/gi, "").replace(/```/g, "").trim();
  const s = clean.indexOf("[");
  if (s !== -1) clean = clean.slice(s);
  const e = clean.lastIndexOf("]");
  let arr = null;
  // 정상(완결) JSON 우선 시도
  if (e > 0) { try { arr = JSON.parse(clean.slice(0, e + 1)); } catch { /* 아래서 복구 */ } }
  // 잘린 응답 → 완성된 객체만이라도 복구
  if (!Array.isArray(arr)) arr = salvageObjects(clean);
  if (!Array.isArray(arr) || !arr.length) return [];

  const toBullets = v => {
    let list;
    if (Array.isArray(v)) list = v;
    else if (v == null) list = [];
    else list = String(v).split(/\n+/); // 문자열이 와도 줄 단위로 분해
    return list
      .map(s => String(s == null ? "" : s).replace(/^[\s•\-\u2013\u00b7]+/, "").trim())
      .filter(Boolean)
      .slice(0, 3);
  };

  const toIds = v => {
    const list = Array.isArray(v) ? v : (v == null || v === "" ? [] : [v]);
    return [...new Set(list
      .map(s => String(s == null ? "" : s).trim().toUpperCase().replace(/[^A-Z0-9]/g, ""))
      .filter(s => /^[MTRC]\d+$/.test(s)))];
  };

  return arr.map(it => {
    const topic = topics.includes(it.topic) ? it.topic : topics[0];
    return {
      title: String(it.title || "").trim(),
      topic,
      content: toBullets(it.content),
      opportunity: toBullets(it.opportunity),
      threat: toBullets(it.threat),
      angle: toBullets(it.angle),
      sources: toIds(it.sources),
    };
  }).filter(it => it.title && it.content.length);
}

// ===== 아이디어 뱅크 (R2: samsungda-research, prefix "idea-bank/") =====
// 자판기에서 도출한 아이디어를 항목 단위 JSON으로 저장 — 팀 공유.
// 동시 편집은 항목 단위 last-write-wins → 카드 간 충돌 영향 최소화.
const BANK_PREFIX = "idea-bank/";

async function handleBank(request, env) {
  if (!env.RESEARCH) return json({ error: "R2(RESEARCH) 바인딩이 없습니다." }, 500);
  const method = request.method;

  if (method === "GET") {
    try {
      const items = [];
      let cursor;
      do {
        const listed = await env.RESEARCH.list({ prefix: BANK_PREFIX, cursor });
        for (const o of (listed.objects || [])) {
          try {
            const obj = await env.RESEARCH.get(o.key);
            if (!obj) continue;
            const rec = await obj.json();
            if (rec && rec.id) items.push(rec);
          } catch (e) { /* 손상 항목 skip */ }
        }
        cursor = listed.truncated ? listed.cursor : null;
      } while (cursor);
      items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      return json({ items });
    } catch (e) {
      return json({ error: "목록 조회 실패: " + e.message }, 500);
    }
  }

  if (method === "POST") {
    let b;
    try { b = await request.json(); } catch { return json({ error: "잘못된 요청 형식" }, 400); }
    const rec = normalizeBankRecord(b);
    if (!rec.title) return json({ error: "title이 필요합니다." }, 400);
    rec.id = "ib_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    rec.createdAt = Date.now();
    rec.date = bankDateKST(rec.createdAt);
    try {
      await env.RESEARCH.put(BANK_PREFIX + rec.id + ".json", JSON.stringify(rec), {
        httpMetadata: { contentType: "application/json; charset=utf-8" },
      });
      return json({ ok: true, item: rec });
    } catch (e) {
      return json({ error: "저장 실패: " + e.message }, 500);
    }
  }

  if (method === "PUT") {
    let b;
    try { b = await request.json(); } catch { return json({ error: "잘못된 요청 형식" }, 400); }
    const id = String(b.id || "").trim();
    if (!/^ib_[a-z0-9]+$/.test(id)) return json({ error: "유효하지 않은 id" }, 400);
    const key = BANK_PREFIX + id + ".json";
    try {
      const obj = await env.RESEARCH.get(key);
      if (!obj) return json({ error: "대상을 찾을 수 없습니다." }, 404);
      const rec = await obj.json();
      if (typeof b.memo === "string") rec.memo = b.memo.slice(0, 2000);
      if (Array.isArray(b.tags)) rec.tags = b.tags.map(t => String(t).trim()).filter(Boolean).slice(0, 12);
      if (typeof b.starred === "boolean") rec.starred = b.starred;
      rec.updatedAt = Date.now();
      await env.RESEARCH.put(key, JSON.stringify(rec), {
        httpMetadata: { contentType: "application/json; charset=utf-8" },
      });
      return json({ ok: true, item: rec });
    } catch (e) {
      return json({ error: "수정 실패: " + e.message }, 500);
    }
  }

  if (method === "DELETE") {
    const id = String(new URL(request.url).searchParams.get("id") || "").trim();
    if (!/^ib_[a-z0-9]+$/.test(id)) return json({ error: "유효하지 않은 id" }, 400);
    try {
      await env.RESEARCH.delete(BANK_PREFIX + id + ".json");
      return json({ ok: true });
    } catch (e) {
      return json({ error: "삭제 실패: " + e.message }, 500);
    }
  }

  return json({ error: "지원하지 않는 메서드" }, 405);
}

function normalizeBankRecord(b) {
  const arr = v => Array.isArray(v)
    ? v.map(x => String(x == null ? "" : x).trim()).filter(Boolean).slice(0, 6)
    : (v == null || v === "" ? [] : [String(v).trim()].filter(Boolean));
  const dir = (b.dir === "profit" || b.dir === "sales") ? b.dir : "sales";
  return {
    dir,
    topic: String(b.topic || "").slice(0, 20),
    title: String(b.title || "").trim().slice(0, 200),
    content: arr(b.content),
    opportunity: arr(b.opportunity),
    threat: arr(b.threat),
    angle: arr(b.angle),
    sources: Array.isArray(b.sources)
      ? [...new Set(b.sources.map(s => String(s).trim().toUpperCase()).filter(s => /^[MTRC]\d+$/.test(s)))]
      : [],
    tags: Array.isArray(b.tags) ? b.tags.map(t => String(t).trim()).filter(Boolean).slice(0, 12) : [],
    memo: typeof b.memo === "string" ? b.memo.slice(0, 2000) : "",
    starred: b.starred === true,
    author: String(b.author || "").trim().slice(0, 20),
  };
}

function bankDateKST(ts) {
  const d = new Date(ts);
  const k = new Date(d.getTime() + 9 * 3600 * 1000);
  const p = n => String(n).padStart(2, "0");
  return `${k.getUTCFullYear()}.${p(k.getUTCMonth() + 1)}.${p(k.getUTCDate())}`;
}

function handleVersion(env) {
  const meta = env.CF_VERSION_METADATA;
  let version = "";
  if (meta && meta.timestamp) {
    const d = new Date(meta.timestamp);
    const kst = new Date(d.getTime() + 9 * 3600 * 1000);
    const p = n => String(n).padStart(2, "0");
    version = `${kst.getUTCFullYear()}-${p(kst.getUTCMonth()+1)}-${p(kst.getUTCDate())} ${p(kst.getUTCHours())}:${p(kst.getUTCMinutes())} KST`;
  }
  return json({ version, id: meta ? meta.id : null });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
function text(t, status = 200) {
  return new Response(t, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
