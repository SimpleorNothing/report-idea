// src/index.js
// 아이디어 자판기 Worker
// - 정적 자산(public/)은 ASSETS 바인딩이 자동 서빙
// - /api/generate : 보고 주제 생성 (Claude API, web_search 옵션, 업로드 보고서 R2 주입)
// - /api/version  : 배포 시각 배지 (CF_VERSION_METADATA)

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
    // 그 외는 정적 자산
    return env.ASSETS.fetch(request);
  },
};

const TOPIC_GUIDE = {
  consumer: "소비자 — 수요·라이프스타일 변화, 구매요인(KBF), 세대/가구구조, 가격민감도, 채널·구독 등 고객 관점의 보고 주제",
  tech:     "기술 — AI·연결성·에너지효율·친환경 소재/냉매·신공정 등 제품·요소기술 관점의 보고 주제",
  rival:    "경쟁사 — 주요 경쟁사(LG, 중국 브랜드 등) 전략·신제품·BM·점유율 위협 등 경쟁 대응 관점의 보고 주제",
};

const SOURCE_GUIDE = {
  mi:      "Market Insight(시장 동향·뉴스 분류 결과)의 최신 이슈",
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
      const rc = await gatherReportContext(env);
      reportBlock = rc.block;
      reportSources = { total: rc.total, catalog: rc.catalog, excerpted: rc.excerpted };
    } catch (e) { reportBlock = ""; }
  }

  // Market Insight 실데이터 주입 (mi.samsungda.net/data/news.json)
  let miBlock = "", miSources = [];
  if (useMi) {
    try { const r = await gatherMarketInsight(topics); miBlock = r.block; miSources = r.sources; }
    catch (e) { miBlock = ""; }
  }

  // 2030 미래 트렌드 골격 주입 (8대 메가트렌드)
  let trendBlock = "", trendSources = [];
  if (use2030) { const r = gather2030(); trendBlock = r.block; trendSources = r.sources; }

  const detailRule = `각 아이디어는 "title"(문자열), "topic"(문자열), "content", "opportunity", "threat", "angle" 6개 필드를 가진다.
content·opportunity·threat·angle 네 필드는 모두 "문자열 배열"이며, 각 배열은 핵심만 담은 1~3개의 짧은 항목(bullet)으로 구성한다.
- 각 bullet은 개조식 명사형으로 끝낸다. "~했다·~한다·~이다·~된다·~중" 같은 서술형 종결을 쓰지 말고, 명사·명사구로 압축해 마침표 없이 끝낸다(한국어 약 15~40자).
- 한 bullet에 한 메시지만 담고, 조사·서술어·군더더기·중복은 최대한 덜어내 핵심 정보 밀도를 높인다.
- content : 무엇에 관한 주제인지 — 시장·현상 근거를 1~3개 bullet로.
- opportunity : 이 주제에서 "당사(삼성 DA)"가 잡을 기회를 1~3개 bullet로.
- threat : 이 주제가 당사에 주는 위협·리스크를 1~3개 bullet로.
- angle : "보고서 방향" — (1) 왜 지금 보고해야 하는지(타이밍·분기점), (2) 사업부에 줄 메시지·의사결정을 1~3개 bullet로.
- 각 bullet에서 강조할 핵심어는 <b>...</b> 로 최대 1곳만 감싼다.
예(명사형 종결): "content": ["월풀 CEO, 소비지출 <b>2008년 위기 수준</b> 경고", "북미 가전 수요 구조적 저점 진입"]`;

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
  if (trendBlock) userParts.push(`\n${trendBlock}`);
  if (reportBlock) userParts.push(`\n${reportBlock}`);
  if (useSearch && keyword) userParts.push(`\n[신규 검색 키워드] ${keyword} — 웹 검색으로 최신 동향을 반영하라.`);
  else if (useSearch)        userParts.push(`\n[신규 검색] 선택된 주제 영역의 최신 동향을 웹 검색으로 반영하라.`);
  userParts.push(`\n[topic 값] 각 아이디어의 "topic" 필드는 다음 중 선택한 주제에 해당하는 값만 사용: ${topics.map(t=>`"${t}"`).join(", ")}.`);
  userParts.push(`\n반드시 JSON 배열만 출력하라. 마크다운 코드펜스나 설명 문장 없이, [ 로 시작해 ] 로 끝나는 JSON 배열 하나만 출력한다.`);

  const reqBody = {
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    system,
    messages: [{ role: "user", content: userParts.join("\n") }],
  };
  if (useSearch) {
    reqBody.tools = [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }];
  }

  let apiRes;
  try {
    apiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(reqBody),
    });
  } catch (e) {
    return json({ error: "Claude API 호출 실패: " + e.message }, 502);
  }

  if (!apiRes.ok) {
    const errTxt = await apiRes.text();
    return json({ error: `Claude API 오류 (${apiRes.status}): ${errTxt.slice(0, 500)}` }, 502);
  }

  const data = await apiRes.json();
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
  return json({ ideas: ideas.slice(0, count), reportsUsed: useReports && !!reportBlock, reportSources, searchSources, miSources, trendSources });
}

// ===== 업로드 보고서(R2) 컨텍스트 수집 =====
// 반환: { block, total, catalog:[제목...], excerpted:[본문까지 읽은 제목...] }
async function gatherReportContext(env, opts = {}) {
  const maxExtract  = opts.maxExtract  ?? 10;    // 본문 추출할 docx 최대 개수
  const perFileChars = opts.perFileChars ?? 2200; // 파일당 발췌 글자수
  const totalCap    = opts.totalCap    ?? 22000;  // 발췌 총량 상한
  const empty = { block: "", total: 0, catalog: [], excerpted: [] };
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

  const docxObjs = objs.filter(o => /\.docx$/i.test(o.name) || /wordprocessingml/i.test(o.type));
  const excerpts = [];
  const excerptedTitles = [];
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
      excerpts.push(`### ${o.title}\n${t}`);
      excerptedTitles.push(o.title);
    } catch (e) { /* skip this file */ }
  }

  let block = `[업로드 보고서 — 실제 사내 보고서]\n`
    + `· 전체 ${objs.length}건. 아래 목록과 본문 발췌는 사내에 실제로 축적된 보고서다.\n`
    + `· 이미 다룬 주제는 그대로 반복하지 말고, 빈틈·후속·심화·교차 주제를 우선 발굴하라.\n\n`
    + `[보고서 목록]\n${catalog}`;
  if (excerpts.length) {
    block += `\n\n[주요 보고서 본문 발췌]\n${excerpts.join("\n\n")}`;
  }
  return { block, total: objs.length, catalog: catalogTitles, excerpted: excerptedTitles };
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

async function gatherMarketInsight(topics, opts = {}) {
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
  const byLens = {};
  for (const it of items) {
    if (it && wantLens.has(it.lens)) (byLens[it.lens] = byLens[it.lens] || []).push(it);
  }
  const picked = [];
  for (const lens of wantLens) {
    const arr = (byLens[lens] || []).slice().sort((a, b) => {
      const gr = (GRADE_RANK[b.grade] || 0) - (GRADE_RANK[a.grade] || 0);
      if (gr) return gr;
      const im = (b.impact || 0) - (a.impact || 0);
      if (im) return im;
      return new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0);
    }).slice(0, perLens);
    picked.push(...arr);
  }
  if (!picked.length) return empty;

  const top = picked.slice(0, cap);
  const sources = top.map(it => ({
    title: it.headline || "",
    url: it.url || "",
    lens: it.lens || "",
    grade: it.grade || "",
  })).filter(s => s.title);

  const lines = top.map(it =>
    `- [${it.lens}·${it.grade}] ${it.headline}` + (it.summary ? ` — ${String(it.summary).slice(0, 90)}` : "")
  ).join("\n");
  const block = `[Market Insight — 실시간 수집·분류된 시장 신호]\n`
    + `· mi.samsungda.net 파이프라인이 분류한 실데이터다. 렌즈(소비자/기술/경쟁사)·등급(긴급>주요>주시>참고) 기준 상위 항목.\n`
    + `· 아래 신호를 근거로 보고 주제를 도출하라.\n\n${lines}`;
  return { block, sources };
}

// ===== 2030 미래 트렌드 골격 (8대 메가트렌드) =====
const MEGATRENDS_2030 = [
  "T1 AI 에이전트 가전",
  "T2 데이터센터 냉각·열관리",
  "T3 저GWP·자연냉매 전환",
  "T4 히트펌프 전기화",
  "T5 가전 구독·XaaS(서비스화)",
  "T6 순환경제·수리권",
  "T7 VPP·그리드 연계",
  "T8 실버·헬스케어 가전",
];

function gather2030() {
  const lines = MEGATRENDS_2030.map(t => "- " + t).join("\n");
  const block = `[2030 미래 트렌드 — DA 8대 메가트렌드 골격]\n`
    + `· 2030.samsungda.net 보드가 추적하는 8대 메가트렌드다(트렌드 프레임 단위, 개별 기사 아님).\n`
    + `· 이 메가트렌드 흐름과 연결해 중장기 보고 주제를 도출하라.\n\n${lines}`;
  const sources = MEGATRENDS_2030.map(t => ({ title: t }));
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

function parseIdeas(textOut, topics) {
  let clean = textOut.replace(/```json/gi, "").replace(/```/g, "").trim();
  const s = clean.indexOf("[");
  const e = clean.lastIndexOf("]");
  if (s !== -1 && e !== -1 && e > s) clean = clean.slice(s, e + 1);
  let arr;
  try { arr = JSON.parse(clean); } catch { return []; }
  if (!Array.isArray(arr)) return [];

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

  return arr.map(it => {
    const topic = topics.includes(it.topic) ? it.topic : topics[0];
    return {
      title: String(it.title || "").trim(),
      topic,
      content: toBullets(it.content),
      opportunity: toBullets(it.opportunity),
      threat: toBullets(it.threat),
      angle: toBullets(it.angle),
    };
  }).filter(it => it.title && it.content.length);
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
