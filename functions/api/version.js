// functions/api/version.js
// 배포 시각 배지 (CF_VERSION_METADATA 바인딩 사용)
export async function onRequestGet(context) {
  const meta = context.env.CF_VERSION_METADATA;
  let version = "";
  if (meta && meta.timestamp) {
    const d = new Date(meta.timestamp);
    // KST 표기
    const kst = new Date(d.getTime() + 9 * 3600 * 1000);
    const p = n => String(n).padStart(2, "0");
    version = `${kst.getUTCFullYear()}-${p(kst.getUTCMonth()+1)}-${p(kst.getUTCDate())} ${p(kst.getUTCHours())}:${p(kst.getUTCMinutes())} KST`;
  }
  return new Response(JSON.stringify({ version, id: meta ? meta.id : null }), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
