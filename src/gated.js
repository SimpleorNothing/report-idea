// src/gated.js — Worker 진입점(게이트 래퍼)
//
// 모든 요청 앞단에 사이트 비밀번호 게이트(포탈과 SSO 세션 공유)를 적용하고,
// 통과한 요청만 기존 아이디어 자판기 Worker(src/index.js)로 위임한다.
// 기존 라우팅·핸들러 코드는 그대로 두고 인증만 얹기 위한 얇은 레이어다.
//
// wrangler.jsonc:
//   "main": "src/gated.js"
//   "assets": { ..., "run_worker_first": true }   ← 정적 자산(public/)도 게이트 뒤에 두려면 필수
//
// secret:
//   npx wrangler secret put SITE_PASSWORD   # 포탈과 "같은 값"
//   (미설정 시 게이트는 자동 비활성 = 사이트 공개)

import { guard } from "./gate.js";
import inner from "./index.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    const blocked = await guard(request, env, url, { title: "아이디어 자판기" });
    if (blocked) return blocked;

    return inner.fetch(request, env, ctx);
  },
};
