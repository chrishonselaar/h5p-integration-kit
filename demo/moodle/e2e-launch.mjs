// End-to-end check: the student opens the H5P activity in Moodle, answers the
// multiple-choice question, and the tool sends the score to Moodle's gradebook.
//
//   npm i playwright && npx playwright install chromium   (once, in any folder)
//   node demo/moodle/e2e-launch.mjs [answer-index]
//
// Then check the grade: Moodle → H5P via LTI demo → Grades.
import { chromium } from 'playwright';

const MOODLE = process.env.MOODLE_URL || 'http://localhost:8080';
const answer = Number(process.argv[2] || 0);

const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined });
const page = await browser.newPage();

// Moodle (bitnami image) rejects the first login of a fresh browser session; retry once.
for (let i = 0; i < 2 && !page.url().includes('/my/'); i++) {
  await page.goto(`${MOODLE}/login/index.php`);
  await page.fill('#username', 'student');
  await page.fill('#password', 'Demo123!');
  await Promise.all([page.waitForNavigation(), page.click('#loginbtn')]);
}
if (!page.url().includes('/my/')) throw new Error('Student login failed');

await page.goto(`${MOODLE}/course/search.php?search=H5PDEMO`);
const courseUrl = await page.locator('a[href*="course/view.php"]').first().getAttribute('href');
await page.goto(courseUrl);
const activityUrl = await page.locator('a[href*="mod/lti/view.php"]').first().getAttribute('href');
await page.goto(activityUrl);

// Moodle → tool (OIDC login + launch) → H5P player, each in its own iframe
const player = await waitForFrame(page, f => f.url().includes('/play/'));
console.log('Launched:', player.url());

const answers = player.locator('.h5p-answer');
await answers.first().waitFor();
await answers.nth(answer).click();
const webhook = page.waitForResponse(r => r.url().includes('/lti/webhook'));
await player.locator('.h5p-question-check-answer').click();
const result = await (await webhook).json();
console.log('Tool response:', result);

await browser.close();
if (!result.sent_to_lms) process.exit(1);

async function waitForFrame(page, test, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const frame = page.frames().find(test);
    if (frame) return frame;
    await page.waitForTimeout(250);
  }
  throw new Error('Frame did not load');
}
