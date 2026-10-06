// End-to-end demo check in a real browser (Playwright), against demo/moodle after setup.sh:
//   1. The teacher adds an activity with the H5P tool: "Select content" (LTI Deep Linking) opens
//      the tool, the teacher creates a multiple-choice question in the H5P editor and chooses it.
//   2. The student opens the activity and answers; the score goes to the Moodle gradebook (AGS).
//
//   npm i playwright && npx playwright install chromium   (once, in any folder)
//   node demo/moodle/e2e.mjs [right|wrong]                (the student's answer; default right)
//
// CHROME=/path/to/chrome uses an existing Chromium instead of Playwright's download.
import { chromium } from 'playwright';

const MOODLE = process.env.MOODLE_URL || 'http://localhost:8080';
// H5P shuffles the answers, so the student picks one by its text
const ANSWER = process.argv[2] === 'wrong' ? 'Rotterdam' : 'Amsterdam';
const TITLE = `Capital of the Netherlands ${new Date().toISOString().slice(11, 19)}`;

const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined });

async function login(username) {
  const context = await browser.newContext({ viewport: { width: 1300, height: 950 } });
  const page = await context.newPage();
  // Moodle (bitnami image) rejects the first login of a fresh browser session; retry once.
  for (let i = 0; i < 2 && !page.url().includes('/my/'); i++) {
    await page.goto(`${MOODLE}/login/index.php`);
    await page.fill('#username', username);
    await page.fill('#password', 'Demo123!');
    await Promise.all([page.waitForNavigation(), page.click('#loginbtn')]);
  }
  if (!page.url().includes('/my/')) throw new Error(`${username} could not log in`);
  return page;
}

async function frameWith(page, test, what) {
  for (let i = 0; i < 120; i++) {
    for (const frame of page.frames()) if (await test(frame).catch(() => false)) return frame;
    await page.waitForTimeout(250);
  }
  throw new Error(`${what} did not load`);
}

async function courseUrl(page) {
  await page.goto(`${MOODLE}/course/search.php?search=H5PDEMO`);
  return page.locator('a[href*="course/view.php"]').first().getAttribute('href');
}

// --- 1. Teacher ---------------------------------------------------------------
const teacher = await login('teacher');
const course = new URL(await courseUrl(teacher));
const typeId = process.env.TOOL_TYPE_ID || '1';
await teacher.goto(`${MOODLE}/course/modedit.php?add=lti&typeid=${typeId}&course=${course.searchParams.get('id')}&section=1&return=0`);
await teacher.click('#id_selectcontent');
const picker = await frameWith(teacher, async (f) => f.url().includes('/lti/picker'), 'Tool content picker');
console.log('Teacher: Select content opened the tool');

const [editor] = await Promise.all([
  teacher.waitForEvent('popup'),
  picker.getByRole('link', { name: 'Create new content' }).click(),
]);
const form = await frameWith(editor, (f) => f.locator('.h5p-hub').count(), 'H5P editor');
await form.locator('li', { hasText: 'Multiple Choice' }).first().click();
await form.locator('.field-name-extraTitle input').fill(TITLE);
const typeInto = async (locator, text) => { await locator.click(); await editor.keyboard.type(text); };
await typeInto(form.locator('.field-name-question .ckeditor'), 'What is the capital of the Netherlands?');
await typeInto(form.locator('.field-name-text .ckeditor').nth(0), 'Amsterdam');
await form.locator('.field-name-correct input').nth(0).check();
await typeInto(form.locator('.field-name-text .ckeditor').nth(1), 'Rotterdam');
await Promise.all([editor.waitForEvent('close', { timeout: 30000 }), editor.click('#save-h5p-clone')]);
console.log(`Teacher: created "${TITLE}" in the H5P editor`);

const picker2 = await frameWith(teacher, async (f) => f.url().includes('/lti/picker') && f.url().includes('new='), 'Picker after save');
await picker2.locator('li.new').getByRole('button', { name: 'Use this' }).click();
await teacher.waitForFunction((title) => document.querySelector('#id_name')?.value === title, TITLE, { timeout: 20000 });
console.log('Teacher: Moodle received the content (Deep Linking response)');
await Promise.all([teacher.waitForNavigation(), teacher.click('#id_submitbutton2')]);
const activity = await teacher.locator('a[href*="mod/lti/view.php"]', { hasText: TITLE }).first().getAttribute('href');
console.log('Teacher: activity saved:', activity);

// --- 2. Student ---------------------------------------------------------------
const student = await login('student');
await student.goto(activity);
const player = await frameWith(student, async (f) => f.url().includes('/play/'), 'H5P player');
const answers = player.locator('.h5p-answer');
await answers.first().waitFor();
await answers.filter({ hasText: ANSWER }).click();
const scored = student.waitForResponse((r) => r.url().includes('/lti/score'));
await player.locator('.h5p-question-check-answer').click();
const result = await (await scored).json();
console.log(`Student: answered ${ANSWER}; tool response:`, JSON.stringify(result));

// The grade as the teacher sees it in the Moodle gradebook
await teacher.goto(`${MOODLE}/grade/report/grader/index.php?id=${course.searchParams.get('id')}`);
const row = teacher.locator('tr', { hasText: 'Student Demo' });
console.log('Gradebook row:', (await row.first().innerText()).replace(/\s+/g, ' ').trim());

await browser.close();
if (!result.sent_to_lms) process.exit(1);
