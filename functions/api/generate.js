// functions/api/generate.js
// 아이디어 자판기 — 보고 주제 생성 (Cloudflare Pages Function)
// 요청 body: { topics:[], count:int, mode:"speed"|"quality", sources:[], keyword:"" }
// 응답: { ideas: [ { title, topic, bullets[3], detail } ] }

const TOPIC_GUIDE = {
  consumer: "소비자 — 수요·라이프스타일 변화, 구매요인(KBF), 세대/가구구조, 가격민감도, 채널·구독 등 고객 관점의 보고 주제",
  tech:     "기술 — AI·연결성·에너지효율·친환경 소재/냉매·신공정 등 제품·요소기술 관점의 보고 주제",
  rival:    "경쟁사 — 주요 경쟁사(LG, 중국 브랜드 등) 전략·신제품·BM·점유율 위협 등 경쟁 대응 관점의 보고 주제",
};

const SOURCE_GUIDE = {
  tools:   "사내 도구모음(기획 도구·대시보드)에서 다뤄온 주제·관점",
  mi:      "Market Insight(시장 동향·뉴스 분류 결과)의 최신 이슈",
  "2030":  "2030 미래 트렌드 보드의 8대 메가트렌드",
  reports: "기존 사내 업로드 보고서들의 주제·분석 관점",
  search:  "웹 신규 검색으로 수집한 최신 자료",
};

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.ANTHROPIC_API_KEY) {
    return json({ error: "ANTHROPIC_API_KEY 가 설정되지 않았습니다 (Cloudflare Pages 환경변수)." }, 500);
  }

  let body;
  try { body = await request.json(); }
  catch { return text("잘못된 요청 형식입니다.", 400); }

  const topics  = Array.isArray(body.topics) && body.topics.length ? body.topics : ["consumer"];
  const count   = Math.max(1, Math.min(8, parseInt(body.count) || 3));
  const mode    = body.mode === "quality" ? "quality" : "speed";
  const sources = Array.isArray(body.sources) ? body.sources : [];
  const keyword = (body.keyword || "").trim();
  const useSearch = sources.includes("search");

  const topicLines  = topics.map(t => "- " + (TOPIC_GUIDE[t] || t)).join("\n");
  const sourceLines = sources.length
    ? sources.map(s => "- " + (SOURCE_GUIDE[s] || s)).join("\n")
    : "- 일반적인 가전 산업 지식";

  const detailRule = mode === "quality"
    ? `각 아이디어는 "title", "topic", "bullets"(정확히 3개), "detail"(2~3문장의 개략 내용) 필드를 가진다. detail에는 왜 지금 보고할 가치가 있는지와 핵심 논지를 담되, 강조할 핵심어는 <b>...</b> 로 1~2곳만 감싼다.`
    : `각 아이디어는 "title", "topic", "bullets"(정확히 3개) 필드를 가진다. detail 필드는 빈 문자열("")로 둔다.`;

  const system = `너는 삼성 생활가전(DA) 사업부의 시니어 기획 담당이다. 사업부장에게 보고할 "보고서 주제"를 발굴한다.
- 산출물은 완성된 보고서가 아니라, 보고할 가치가 있는 "주제(아이디어)"의 개요다.
- 각 아이디어의 제목은 한 줄로 구체적이고 보고서 제목처럼 쓴다.
- bullets 3개는 (1) 시장/현상 근거, (2) 시사점/기회, (3) "보고 포인트 : ..." 형식의 보고 방향, 순서를 권장한다.
- 추측성 수치는 단정하지 말고 방향성 위주로 쓴다.
- 한국어로 작성한다.
${detailRule}`;

  const userParts = [];
  userParts.push(`다음 조건으로 보고 주제 ${count}개를 생성하라.`);
  userParts.push(`\n[주제 영역]\n${topicLines}`);
  userParts.push(`\n[근거로 우선 참고할 출처]\n${sourceLines}`);
  if (useSearch && keyword) userParts.push(`\n[신규 검색 키워드] ${keyword} — 웹 검색으로 최신 동향을 반영하라.`);
  else if (useSearch)        userParts.push(`\n[신규 검색] 선택된 주제 영역의 최신 동향을 웹 검색으로 반영하라.`);
  userParts.push(`\n[topic 값] 각 아이디어의 "topic" 필드는 다음 중 선택한 주제에 해당하는 값만 사용: ${topics.map(t=>`"${t}"`).join(", ")}.`);
  userParts.push(`\n반드시 JSON 배열만 출력하라. 마크다운 코드펜스나 설명 문장 없이, [ 로 시작해 ] 로 끝나는 JSON 배열 하나만 출력한다.`);

  const reqBody = {
    model: "claude-sonnet-4-6",
    max_tokens: 3000,
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

  const ideas = parseIdeas(fullText, topics, mode);
  if (!ideas.length) {
    return json({ error: "응답 파싱에 실패했습니다. 다시 시도해주세요.", raw: fullText.slice(0, 300) }, 502);
  }
  return json({ ideas: ideas.slice(0, count) });
}

function parseIdeas(textOut, topics, mode) {
  let arr = null;
  // 코드펜스 제거
  let clean = textOut.replace(/```json/gi, "").replace(/```/g, "").trim();
  // 첫 [ ~ 마지막 ] 추출
  const s = clean.indexOf("[");
  const e = clean.lastIndexOf("]");
  if (s !== -1 && e !== -1 && e > s) clean = clean.slice(s, e + 1);
  try { arr = JSON.parse(clean); } catch { return []; }
  if (!Array.isArray(arr)) return [];

  return arr.map(it => {
    let bullets = Array.isArray(it.bullets) ? it.bullets.map(x => String(x)).filter(Boolean) : [];
    bullets = bullets.slice(0, 3);
    let topic = topics.includes(it.topic) ? it.topic : topics[0];
    return {
      title: String(it.title || "").trim(),
      topic,
      bullets,
      detail: mode === "quality" ? String(it.detail || "").trim() : "",
    };
  }).filter(it => it.title && it.bullets.length);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
function text(t, status = 200) {
  return new Response(t, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

// 비허용 메서드
export async function onRequestGet() {
  return text("POST only", 405);
}
