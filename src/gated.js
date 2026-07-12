// src/gated.js — Worker 진입점(게이트 래퍼)
//
// 1) 들어오는 요청: 모든 경로 앞단에 사이트 비밀번호 게이트(포탈과 SSO 세션 공유)를
//    적용하고, 통과한 요청만 기존 아이디어 자판기 Worker(src/index.js)로 위임한다.
// 2) 나가는 요청: 소스 수집 단계에서 이 Worker가 서버-측으로 부르는 내부 도구
//    (2030·MI·CI 등 *.samsungda.net)는 이제 SSO 게이트 뒤에 있어 쿠키 없이는 401이다.
//    그래서 내부 호스트로 나가는 subrequest에는 SITE_PASSWORD에서 파생한 세션 쿠키를
//    자동으로 붙인다(포탈과 동일한 토큰 — 서비스 간 인증).
//
// 기존 라우팅·핸들러(src/index.js)는 그대로 두고 인증만 얹기 위한 얇은 레이어다.
//
// wrangler.jsonc:
//   "main": "src/gated.js"
//   "assets": { ..., "run_worker_first": true }   ← 정적 자산(public/)도 게이트 뒤에 두려면 필수
//
// secret:
//   npx wrangler secret put SITE_PASSWORD   # 포탈과 "같은 값"
//   (미설정 시 게이트는 자동 비활성 = 사이트 공개, 쿠키 첨부도 생략)

import { guard, internalSessionCookie } from "./gate.js";
import inner from "./index.js";

// 서버-측 호출 시 SSO 세션 쿠키를 붙일 내부 도구 호스트
const INTERNAL_HOSTS = new Set([
  "2030.samsungda.net",
  "mi.samsungda.net",
  "ci.samsungda.net",
  "samsungda.net",
]);

let patched = false;

// globalThis.fetch 를 한 번만 감싸, 내부 호스트로 나가는 요청에 쿠키를 덧붙인다.
// 실패해도(런타임이 재정의를 막는 경우 등) 원래 동작을 그대로 유지한다 — 각 소스 수집
// 함수에는 이미 폴백이 있어 최악의 경우 해당 소스만 빠진다.
function patchInternalFetch(env) {
  if (patched || !env.SITE_PASSWORD) return;
  patched = true;
  try {
    const origFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = async (input, init) => {
      let host = "";
      try {
        host = new URL(typeof input === "string" ? input : input.url).hostname;
      } catch {
        host = "";
      }
      if (!INTERNAL_HOSTS.has(host)) return origFetch(input, init);

      const cookie = await internalSessionCookie(env);
      const req = new Request(input, init);
      req.headers.set("cookie", cookie);
      return origFetch(req);
    };
  } catch {
    patched = true; // 재정의 불가 환경 — 원래 fetch 유지
  }
}

export default {
  async fetch(request, env, ctx) {
    patchInternalFetch(env);

    const url = new URL(request.url);
    const blocked = await guard(request, env, url, { title: "아이디어 자판기" });
    if (blocked) return blocked;

    return inner.fetch(request, env, ctx);
  },
};
