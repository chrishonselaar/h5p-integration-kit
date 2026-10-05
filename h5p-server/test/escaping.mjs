// Request values (user name/email/id, webhookUrl, returnUrl, content id) must not break out of
// the inline <script> blocks of the player and editor pages. Run against an open (development)
// server, where these values come from the query string.
// Usage: node test/escaping.mjs <baseUrl> <existingContentId>
const [BASE, ID] = process.argv.slice(2);
if (!ID) { console.error('usage: node test/escaping.mjs <baseUrl> <existingContentId>'); process.exit(2); }
const evil = encodeURIComponent(`';</script><script>window.__pwned=1</script>`);
const pages = [
  `/play/${ID}?userName=${evil}&userEmail=${evil}&userId=${evil}&webhookUrl=https://x.example/${evil}`,
  `/edit/${ID}?userName=${evil}&userEmail=${evil}&returnUrl=https://lms.example/${evil}`,
  `/new?userName=${evil}&userEmail=${evil}`,
  `/edit/${evil}`,
];
let failed = 0;
for (const path of pages) {
  const html = await (await fetch(BASE + path)).text();
  const ok = !html.includes('</script><script>window.__pwned');
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${path.slice(0, 60)}`);
}
for (const [path, re] of [[`/play/${ID}?webhookUrl=javascript:alert(1)`, /const webhookUrl = "";/],
  [`/edit/${ID}?returnUrl=javascript:alert(1)`, /const h5pReturnUrl = null;/]]) {
  const ok = re.test(await (await fetch(BASE + path)).text());
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} non-http URL dropped: ${path}`);
}
console.log(`\n${pages.length + 2} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
