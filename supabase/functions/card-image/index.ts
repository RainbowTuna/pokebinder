// PokéBinder picture relay.
// TCGplayer's image server doesn't let web pages read picture pixels, which the scanner
// needs to compare a scan with candidate cards. This passes one card picture through with
// the header that allows it. It only relays TCGplayer card pictures, nothing else.
//
// Deploy: Supabase → Edge Functions → Deploy a new function → Via editor, name it
// "card-image", paste this file, Deploy. Then turn OFF "Enforce JWT verification"
// for the function (the app calls it without logging in).

const SIZES = new Set(['200w', '400w']);
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' };

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  const url = new URL(req.url);
  const pid = url.searchParams.get('pid') ?? '';
  const size = url.searchParams.get('size') ?? '200w';
  if (!/^\d{1,9}$/.test(pid) || !SIZES.has(size)) {
    return new Response('Bad request', { status: 400, headers: CORS });
  }
  const upstream = await fetch(`https://tcgplayer-cdn.tcgplayer.com/product/${pid}_${size}.jpg`);
  if (!upstream.ok) return new Response('Not found', { status: upstream.status, headers: CORS });
  return new Response(upstream.body, {
    headers: { ...CORS, 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=604800' },
  });
});
