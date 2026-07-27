#!/usr/bin/env node
/**
 * @r3lab/web-review — README screenshot generator (WP23).
 *
 * Plain Playwright (no test runner) driving a real browser against a real,
 * disposable Postgres — same discipline as `examples/next-demo/e2e/`, whose
 * gesture helpers (`helpers.ts`) this mirrors: real keyboard shortcut, real
 * clicks, real drag-selects, never `page.evaluate`-ing overlay state
 * directly. Run via `pnpm screenshots` (`scripts/screenshots.sh`), which
 * brings up the container/app this script talks to and tears them down.
 *
 * What this produces, and why each is deterministic:
 *
 *   - Content: every reviewer name/comment below is fixed, plausible design-
 *     review copy — no "test"/"asdf"/lorem ipsum.
 *   - Timestamps: `formatTime` (overlay/helpers.ts) renders an ABSOLUTE
 *     "month day, HH:MM" string (not a relative "2 minutes ago"), but that
 *     string still bakes in the real second a thread/comment was created —
 *     which drifts on every run. So every thread/comment this script
 *     creates through the real UI gets its `created_at`/`resolved_at`
 *     overwritten straight in Postgres afterward, to FIXED, arbitrary-but-
 *     plausible past timestamps (see `SEED_TIMESTAMPS` below) — same text,
 *     every run. Every browser context is also pinned to `timezoneId: "UTC"`
 *     / `locale: "en-US"` so that rendering doesn't additionally depend on
 *     the machine running this script.
 *   - Anchors/highlights: computed for real by the browser from real
 *     clicks/drags against the real DOM — never hand-authored geometry —
 *     so pins and highlights land exactly where the real overlay would put
 *     them.
 *
 * Crops are computed from live `boundingBox()`/`scrollHeight` reads, not
 * hard-coded pixel guesses, so a future copy/layout tweak in the demo page
 * or the package's own components re-crops correctly rather than silently
 * cutting something off.
 */

import { chromium } from "@playwright/test";
import pg from "pg";
import { mkdir, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(REPO_ROOT, "docs", "images");

const BASE_URL = process.env.SHOTS_BASE_URL ?? "http://localhost:32130";
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://r3wr:r3wr@localhost:55510/r3wr_shots";
const REVIEW_PASSWORD = process.env.REVIEW_PASSWORD ?? "shots-review-password";

const VIEWPORT = { width: 1800, height: 2000 };
const DEVICE_SCALE_FACTOR = 2;
const CONTEXT_OPTS = {
  viewport: VIEWPORT,
  deviceScaleFactor: DEVICE_SCALE_FACTOR,
  timezoneId: "UTC",
  locale: "en-US",
};

// ─── seed content — realistic design-review copy, three distinct reviewers ─

const THREAD_A = {
  testId: "cta-secondary",
  category: "Design",
  title: "Secondary CTA competes with primary",
  body: 'This button is almost the same visual weight as "Get started" — can we drop it to a ghost/link style so there\'s no ambiguity about which action we want people to take?',
  name: "Priya Kapoor",
};

const THREAD_B = {
  testId: "feature-storage",
  category: "Copy",
  title: "Tone mismatch on this card",
  body: '"Nothing more" reads a bit flat next to the other two cards, which both end on something reassuring. Maybe close with why that\'s a good thing?',
  name: "Jonas Weber",
  reply: {
    name: "Mateo Rossi",
    body: 'Agreed — updated to end on "so you\'re never locked into our infra." Ship it?',
  },
};

const THREAD_C = {
  testId: "testimonial-quote",
  phrase: "unlimited",
  category: "Copy",
  title: "Double-check this word",
  body: 'Legal flagged "unlimited" claims in the last review — do we actually mean no cap, or just no seat limit? Want to make sure the testimonial doesn\'t overpromise.',
  name: "Priya Kapoor",
};

const THREAD_D = {
  testId: "hero-image",
  category: "Bug",
  title: "Placeholder image shipping to prod?",
  body: "Is this still the placeholder gradient, or is it a real illustration now? Just making sure this isn't the demo asset making it into the README.",
  name: "Sara Lindqvist",
};

const COMPOSER_DRAFT = {
  testId: "cta-primary",
  category: "Bug",
  title: "Button label unclear on mobile",
  body: 'On a narrow viewport this wraps to two lines and the padding looks cramped — can we shorten to just "Start" below 480px?',
  name: "Mateo Rossi",
};

// Fixed, arbitrary-but-plausible past timestamps (UTC) — never "now" at run
// time — so `formatTime`'s rendered text is byte-identical on every run.
// Ordered so the panel's newest-first list reads A, D, B, C top to bottom.
const SEED_TIMESTAMPS = {
  threadC: { created: "2026-01-08T17:14:00.000Z" },
  threadB: {
    created: "2026-01-10T19:05:00.000Z",
    reply: "2026-01-10T23:30:00.000Z",
    resolved: "2026-01-10T23:31:00.000Z",
  },
  threadD: { created: "2026-01-11T20:50:00.000Z" },
  threadA: { created: "2026-01-13T00:42:00.000Z" },
};

// ─── gesture helpers — mirror examples/next-demo/e2e/helpers.ts exactly ───

function lockedToggle(page) {
  return page.locator(".r3wr-toggle[data-locked='true']");
}
function unlockedToggle(page) {
  return page.locator(".r3wr-toggle:not([data-locked])");
}

/**
 * Zeroes every CSS animation/transition duration and delay on the page.
 * `.r3wr-composer` (shared by `Composer` AND `UnlockDialog`) and `.r3wr-panel`
 * mount with a 200ms `opacity: 0 → 1` (or slide/pop) entrance animation
 * (overlay.css's `r3wr-pop`/`r3wr-slide-in`, both `animation-fill-mode:
 * both`). `waitFor({ state: "visible" })` only waits for the element to have
 * a non-zero box and be attached — it does NOT wait for CSS animations to
 * finish, so a screenshot taken right after can land mid-fade (a washed-out,
 * translucent-looking capture). Zeroing durations (not `animation: none`,
 * which can skip a `both`-fill-mode animation's END state entirely) jumps
 * straight to the settled final frame. Applied to every capture context, not
 * just the ones that were visibly affected — a half-transitioned frame is
 * exactly the kind of thing that can differ between runs even when it isn't
 * obviously wrong to the eye.
 */
async function disableAnimations(page) {
  await page.addStyleTag({
    content:
      "*, *::before, *::after { animation-duration: 0s !important; animation-delay: 0s !important; transition-duration: 0s !important; transition-delay: 0s !important; }",
  });
}

async function unlock(page, password = REVIEW_PASSWORD) {
  await lockedToggle(page).click();
  const dialog = page.getByRole("dialog", { name: "Unlock review" });
  await dialog.waitFor({ state: "visible" });
  await dialog.getByPlaceholder("Review password").fill(password);
  await dialog.getByRole("button", { name: "Unlock", exact: true }).click();
  await unlockedToggle(page).waitFor({ state: "visible" });
}

async function fillComposer(page, fields) {
  const composer = page.locator(".r3wr-composer");
  await composer.waitFor({ state: "visible" });
  if (fields.category) {
    await composer.getByRole("radio", { name: fields.category }).click();
  }
  if (fields.title !== undefined) {
    await composer.getByLabel("Title (optional)").fill(fields.title);
  }
  await composer.getByLabel("Comment").fill(fields.body);
  const nameField = composer.getByLabel("Your name");
  if (fields.name !== undefined && (await nameField.count()) > 0) {
    await nameField.fill(fields.name);
  }
  return composer;
}

async function submitComposer(page) {
  const composer = page.locator(".r3wr-composer");
  await composer.getByRole("button", { name: "Add feedback" }).click();
  await composer.waitFor({ state: "detached" });
}

async function dropElementPin(page, locator, fields) {
  await page.keyboard.press("c");
  await page.locator(".r3wr-capture-hint").waitFor({ state: "visible" });
  await locator.click();
  await fillComposer(page, fields);
  await submitComposer(page);
}

/** Finds `substring`'s bounding client rect inside `container` via a throwaway Range — never mutates the live selection. */
async function rectOfSubstring(container, substring) {
  const rect = await container.evaluate((el, needle) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const text = node.textContent ?? "";
      const idx = text.indexOf(needle);
      if (idx !== -1) {
        const range = document.createRange();
        range.setStart(node, idx);
        range.setEnd(node, idx + needle.length);
        const r = range.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
      }
    }
    return null;
  }, substring);
  if (!rect) throw new Error(`Substring "${substring}" not found as a single text node`);
  return rect;
}

async function dropTextPin(page, container, phrase, fields) {
  const rect = await rectOfSubstring(container, phrase);
  const y = rect.top + rect.height / 2;
  await page.mouse.move(rect.left + 1, y);
  await page.mouse.down();
  await page.mouse.move(rect.right - 1, y, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.press("c");
  await page.locator(".r3wr-capture-hint").waitFor({ state: "visible" });
  await page.mouse.click(rect.left + rect.width / 2, y);
  await fillComposer(page, fields);
  await submitComposer(page);
}

// ─── seeding ────────────────────────────────────────────────────────────

async function seed(browser) {
  console.log("==> Seeding Thread A (Priya Kapoor, Design, cta-secondary)");
  {
    const ctx = await browser.newContext(CONTEXT_OPTS);
    const page = await ctx.newPage();
    await page.goto(BASE_URL);
    await disableAnimations(page);
    await unlock(page);
    await dropElementPin(page, page.getByTestId(THREAD_A.testId), THREAD_A);
    await ctx.close();
  }

  console.log("==> Seeding Thread B (Jonas Weber, Copy, feature-storage)");
  {
    const ctx = await browser.newContext(CONTEXT_OPTS);
    const page = await ctx.newPage();
    await page.goto(BASE_URL);
    await disableAnimations(page);
    await unlock(page);
    await dropElementPin(page, page.getByTestId(THREAD_B.testId), THREAD_B);
    await ctx.close();
  }

  console.log("==> Seeding Thread C (Priya Kapoor, Copy, testimonial text anchor)");
  {
    const ctx = await browser.newContext(CONTEXT_OPTS);
    const page = await ctx.newPage();
    await page.goto(BASE_URL);
    await disableAnimations(page);
    await unlock(page);
    await dropTextPin(page, page.getByTestId(THREAD_C.testId), THREAD_C.phrase, THREAD_C);
    await ctx.close();
  }

  console.log("==> Mateo Rossi replies to and resolves Thread B");
  {
    const ctx = await browser.newContext(CONTEXT_OPTS);
    const page = await ctx.newPage();
    await page.goto(BASE_URL);
    await disableAnimations(page);
    await unlock(page);
    // Open the list (not the just-created thread) the same way
    // reply-resolve.spec.ts does: enter pin-drop mode, then Escape out of
    // it — that leaves the panel open on the thread LIST, genuinely
    // exercising "find it from the list" rather than any auto-open.
    await page.keyboard.press("c");
    await page.keyboard.press("Escape");
    const list = page.getByRole("dialog", { name: "Feedback on this page" });
    await list.waitFor({ state: "visible" });
    await list.locator(".r3wr-thread", { hasText: THREAD_B.title }).click();

    const detail = page.getByRole("dialog", { name: "Thread" });
    await detail.waitFor({ state: "visible" });
    await detail.getByLabel("Your name").fill(THREAD_B.reply.name);
    await detail.getByLabel("Reply").fill(THREAD_B.reply.body);
    await detail.getByRole("button", { name: "Reply", exact: true }).click();
    await detail.getByText(THREAD_B.reply.body).waitFor({ state: "visible" });

    await detail.getByRole("button", { name: "Resolve", exact: true }).click();
    await detail.locator(".r3wr-status").waitFor({ state: "visible" });
    await ctx.close();
  }

  console.log("==> Seeding Thread D (Sara Lindqvist, Bug, hero-image)");
  {
    const ctx = await browser.newContext(CONTEXT_OPTS);
    const page = await ctx.newPage();
    await page.goto(BASE_URL);
    await disableAnimations(page);
    await unlock(page);
    await dropElementPin(page, page.getByTestId(THREAD_D.testId), THREAD_D);
    await ctx.close();
  }
}

// ─── backdate timestamps in Postgres for deterministic rendering ─────────

async function backdate() {
  console.log("==> Backdating created_at/resolved_at to fixed timestamps");
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    await client.query(
      `update review_thread set created_at = $1, updated_at = $1 where title = $2`,
      [SEED_TIMESTAMPS.threadA.created, THREAD_A.title],
    );
    await client.query(
      `update review_comment set created_at = $1
         where thread_id = (select id from review_thread where title = $2) and author_name = $3`,
      [SEED_TIMESTAMPS.threadA.created, THREAD_A.title, THREAD_A.name],
    );

    await client.query(
      `update review_thread set created_at = $1, updated_at = $2, resolved_at = $2, resolved_by = $3
         where title = $4`,
      [SEED_TIMESTAMPS.threadB.created, SEED_TIMESTAMPS.threadB.resolved, THREAD_B.reply.name, THREAD_B.title],
    );
    await client.query(
      `update review_comment set created_at = $1
         where thread_id = (select id from review_thread where title = $2) and author_name = $3`,
      [SEED_TIMESTAMPS.threadB.created, THREAD_B.title, THREAD_B.name],
    );
    await client.query(
      `update review_comment set created_at = $1
         where thread_id = (select id from review_thread where title = $2) and author_name = $3`,
      [SEED_TIMESTAMPS.threadB.reply, THREAD_B.title, THREAD_B.reply.name],
    );

    await client.query(
      `update review_thread set created_at = $1, updated_at = $1 where title = $2`,
      [SEED_TIMESTAMPS.threadC.created, THREAD_C.title],
    );
    await client.query(
      `update review_comment set created_at = $1
         where thread_id = (select id from review_thread where title = $2) and author_name = $3`,
      [SEED_TIMESTAMPS.threadC.created, THREAD_C.title, THREAD_C.name],
    );

    await client.query(
      `update review_thread set created_at = $1, updated_at = $1 where title = $2`,
      [SEED_TIMESTAMPS.threadD.created, THREAD_D.title],
    );
    await client.query(
      `update review_comment set created_at = $1
         where thread_id = (select id from review_thread where title = $2) and author_name = $3`,
      [SEED_TIMESTAMPS.threadD.created, THREAD_D.title, THREAD_D.name],
    );
  } finally {
    await client.end();
  }
}

// ─── capture ────────────────────────────────────────────────────────────

const shots = [];

async function capture(name, clip, page) {
  const file = path.join(OUT_DIR, `${name}.png`);
  await page.screenshot({ path: file, clip });
  shots.push({
    name,
    file,
    cssWidth: Math.round(clip.width),
    cssHeight: Math.round(clip.height),
    pixelWidth: Math.round(clip.width * DEVICE_SCALE_FACTOR),
    pixelHeight: Math.round(clip.height * DEVICE_SCALE_FACTOR),
  });
  console.log(`==> Captured ${name}.png (${Math.round(clip.width)}x${Math.round(clip.height)} css px)`);
}

async function captureHero(browser) {
  const ctx = await browser.newContext(CONTEXT_OPTS);
  const page = await ctx.newPage();
  await page.goto(BASE_URL);
  await disableAnimations(page);
  await unlock(page);
  // List, not composing — same "c then Escape" pattern as the reply/resolve
  // seed step above.
  await page.keyboard.press("c");
  await page.keyboard.press("Escape");
  const list = page.getByRole("dialog", { name: "Feedback on this page" });
  await list.waitFor({ state: "visible" });
  // Default filter is "open" (see overlay-root.tsx) — Thread B is resolved,
  // so switch to "All" to show every thread, open and resolved alike.
  await list.getByRole("button", { name: "All", exact: true }).click();
  await list.locator(".r3wr-thread").nth(3).waitFor({ state: "visible" }); // all four threads loaded

  // Ends after the testimonial (not the CTA section further down) — still
  // shows pins (the feature-card pin, the hero-image pin, the text-anchored
  // highlight) plus the full thread list, at a noticeably smaller file size
  // than including the whole page. Height is the taller of (a) the page
  // content we want in frame and (b) the panel's actual last-thread bottom —
  // with only 3 threads the panel content fell well short of the page-content
  // height, leaving a large dead strip of empty panel below the list; a 4th
  // thread plus taking the max of both bounds keeps the list looking used
  // rather than sparse, without over- or under-cropping either side.
  const mainBox = await page.locator("main").boundingBox();
  const testimonialBox = await page.getByTestId("testimonial").boundingBox();
  const lastThreadBox = await list.locator(".r3wr-thread").last().boundingBox();
  const left = Math.max(0, mainBox.x - 40);
  const pageContentBottom = testimonialBox.y + testimonialBox.height;
  const panelContentBottom = lastThreadBox.y + lastThreadBox.height;
  const clip = {
    x: left,
    y: 0,
    width: VIEWPORT.width - left,
    height: Math.min(VIEWPORT.height, Math.max(pageContentBottom, panelContentBottom) + 40),
  };
  await capture("hero", clip, page);
  await ctx.close();
}

async function captureComposer(browser) {
  const ctx = await browser.newContext(CONTEXT_OPTS);
  const page = await ctx.newPage();
  await page.goto(BASE_URL);
  await disableAnimations(page);
  await unlock(page);
  await page.keyboard.press("c");
  await page.locator(".r3wr-capture-hint").waitFor({ state: "visible" });
  await page.getByTestId(COMPOSER_DRAFT.testId).click();
  await fillComposer(page, COMPOSER_DRAFT); // deliberately never submitted — a draft, not a persisted thread

  // The screenshot capture kicked off at pin-drop (overlay-root.tsx) starts
  // in a transient "Capturing a screenshot…" state; this demo has no
  // `putScreenshot` configured, so it always settles to the "no screenshot"
  // copy within well under a second. Wait for that settled state rather
  // than capturing mid-transition, which would freeze a real UI in a
  // loading state it only occupies for a moment.
  await page
    .locator(".r3wr-shot-note", { hasText: "Capturing a screenshot" })
    .waitFor({ state: "detached", timeout: 5000 })
    .catch(() => {});

  const composerBox = await page.locator(".r3wr-composer").boundingBox();
  // Union of the composer and the two buttons ONLY — not the `cta`
  // section (heading + instruction paragraph + buttons) or even
  // `.demo-cta` (the button row alone): both are BLOCK-level boxes that
  // stretch to the full ~860px content column width by default regardless
  // of their children's actual size, which either wasted the whole right
  // half of the frame on dead background or, when only used for the right
  // bound, truncated the instruction paragraph mid-sentence at that edge.
  // The buttons themselves are the only elements sized to their own
  // content, so bound tightly on those plus the composer and drop the
  // heading/paragraph from the frame entirely — the open composer next to
  // the buttons it's anchored to is self-explanatory without them.
  const primaryBox = await page.getByTestId("cta-primary").boundingBox();
  const secondaryBox = await page.getByTestId("cta-secondary").boundingBox();
  const left = Math.max(0, Math.min(composerBox.x, primaryBox.x, secondaryBox.x) - 40);
  // Only 16px of top padding, not 40: the buttons sit a mere 24px (`.demo-cta`'s
  // `margin-top: 1.5rem`) below the instruction paragraph's own text line —
  // 40px of padding reached back up INTO that line, showing a sliced-off
  // sliver of "click an element below to" at the very top edge.
  const top = Math.max(0, Math.min(composerBox.y, primaryBox.y, secondaryBox.y) - 16);
  const right = Math.min(
    VIEWPORT.width,
    Math.max(composerBox.x + composerBox.width, secondaryBox.x + secondaryBox.width) + 40,
  );
  const bottom = Math.min(
    VIEWPORT.height,
    Math.max(composerBox.y + composerBox.height, secondaryBox.y + secondaryBox.height) + 40,
  );
  await capture("composer", { x: left, y: top, width: right - left, height: bottom - top }, page);
  await ctx.close();
}

async function captureTextAnchor(browser) {
  const ctx = await browser.newContext(CONTEXT_OPTS);
  const page = await ctx.newPage();
  await page.goto(BASE_URL);
  await disableAnimations(page);
  await unlock(page);
  await page.locator('.r3wr-highlight[data-kind="text"]').waitFor({ state: "visible" });

  const sectionBox = await page.getByTestId("testimonial").boundingBox();
  const clip = {
    x: Math.max(0, sectionBox.x - 40),
    y: Math.max(0, sectionBox.y - 24),
    width: sectionBox.width + 80,
    height: sectionBox.height + 48,
  };
  await capture("text-anchor", clip, page);
  await ctx.close();
}

async function captureThreadDetail(browser) {
  const ctx = await browser.newContext(CONTEXT_OPTS);
  const page = await ctx.newPage();
  await page.goto(BASE_URL);
  await disableAnimations(page);
  await unlock(page);
  await page.keyboard.press("c");
  await page.keyboard.press("Escape");
  const list = page.getByRole("dialog", { name: "Feedback on this page" });
  await list.waitFor({ state: "visible" });
  // Thread B is resolved — same "All" filter switch as captureHero.
  await list.getByRole("button", { name: "All", exact: true }).click();
  await list.locator(".r3wr-thread", { hasText: THREAD_B.title }).click();
  const detail = page.getByRole("dialog", { name: "Thread" });
  await detail.waitFor({ state: "visible" });
  await detail.getByText(THREAD_B.reply.body).waitFor({ state: "visible" }); // reply rendered

  // `.r3wr-panel-body` is a `flex: 1` child of the fixed-full-height panel,
  // so its OWN boundingBox/scrollHeight is stretched to fill the leftover
  // viewport space regardless of how little content it holds — measuring
  // that gave a crop reaching almost the full 2000px viewport height, mostly
  // blank. The reply/resolve actions row is the last real content, so its
  // bottom edge is the true content boundary.
  const panelBox = await page.locator(".r3wr-panel").boundingBox();
  const actionsBox = await page.locator(".r3wr-actions").boundingBox();
  const contentHeight = Math.min(VIEWPORT.height, actionsBox.y + actionsBox.height + 24);
  await capture("thread-detail", { x: panelBox.x, y: 0, width: panelBox.width, height: contentHeight }, page);
  await ctx.close();
}

async function captureUnlock(browser) {
  const ctx = await browser.newContext(CONTEXT_OPTS);
  const page = await ctx.newPage();
  await page.goto(BASE_URL);
  await disableAnimations(page);
  await lockedToggle(page).click();
  const dialog = page.getByRole("dialog", { name: "Unlock review" });
  await dialog.waitFor({ state: "visible" });

  const toggleBox = await lockedToggle(page).boundingBox();
  const dialogBox = await dialog.boundingBox();
  const left = Math.max(0, Math.min(toggleBox.x, dialogBox.x) - 24);
  const top = Math.max(0, Math.min(toggleBox.y, dialogBox.y) - 24);
  const right = Math.min(
    VIEWPORT.width,
    Math.max(toggleBox.x + toggleBox.width, dialogBox.x + dialogBox.width) + 24,
  );
  const bottom = Math.min(
    VIEWPORT.height,
    Math.max(toggleBox.y + toggleBox.height, dialogBox.y + dialogBox.height) + 24,
  );
  await capture("unlock", { x: left, y: top, width: right - left, height: bottom - top }, page);
  await ctx.close();
}

// ─── PNG post-processing ───────────────────────────────────────────────

async function toolAvailable(bin) {
  try {
    await execFileAsync(bin, ["--version"]);
    return true;
  } catch {
    return false;
  }
}

async function optimize() {
  // pngquant first (lossy palette quantization — by far the biggest win for
  // UI screenshots like these: flat colors, sharp text, a couple of large
  // gradient blocks), oxipng after (lossless, cleans up what quantization
  // leaves on the table). Both are optional — check availability, never
  // assume either is installed.
  if (await toolAvailable("pngquant")) {
    for (const shot of shots) {
      await execFileAsync("pngquant", ["--quality=80-95", "--strip", "--force", "--output", shot.file, shot.file]);
    }
    console.log("==> Quantized PNGs with pngquant --quality=80-95");
  } else {
    console.log("==> pngquant not found on PATH — skipping lossy quantization");
  }

  if (await toolAvailable("oxipng")) {
    for (const shot of shots) {
      await execFileAsync("oxipng", ["-o", "4", "--strip", "safe", shot.file]);
    }
    console.log("==> Optimized PNGs with oxipng -o4 --strip safe");
  } else {
    console.log("==> oxipng not found on PATH — skipping lossless PNG optimization");
  }
}

async function report() {
  console.log("\n==> docs/images/ summary");
  for (const shot of shots) {
    const { size } = await stat(shot.file);
    console.log(
      `    ${path.basename(shot.file)} — ${shot.pixelWidth}x${shot.pixelHeight}px (${shot.cssWidth}x${shot.cssHeight} css @${DEVICE_SCALE_FACTOR}x) — ${(size / 1024).toFixed(1)} KB`,
    );
  }
}

// ─── main ───────────────────────────────────────────────────────────────

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const browser = await chromium.launch();
  try {
    await seed(browser);
    await backdate();

    await captureHero(browser);
    await captureComposer(browser);
    await captureTextAnchor(browser);
    await captureThreadDetail(browser);
    await captureUnlock(browser);
  } finally {
    await browser.close();
  }

  await optimize();
  await report();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
