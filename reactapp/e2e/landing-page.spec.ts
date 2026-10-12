import { expect, test } from '@playwright/test';

const viewports = [
  { name: 'desktop-1920x1080', width: 1920, height: 1080 },
  { name: 'laptop-1440x900', width: 1440, height: 900 },
  { name: 'tablet-landscape-1024x768', width: 1024, height: 768 },
  { name: 'tablet-portrait-768x1024', width: 768, height: 1024 },
  { name: 'mobile-390x844', width: 390, height: 844 },
  { name: 'small-mobile-360x800', width: 360, height: 800 },
  { name: 'short-mobile-360x640', width: 360, height: 640 },
];

test('matches the reference hierarchy and stays within each required viewport', async ({ page }, testInfo) => {
  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    await expect(page.getByRole('heading', { level: 1 })).toContainText(/Smarter Investments,\s*A Brighter Tomorrow/);
    await expect(page.getByRole('link', { name: 'Summon Genie' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'See How It Works' })).toHaveCount(0);
    await expect(page.getByText('A considered process')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Choices shaped around your profile.' })).toHaveCount(0);
    await expect(page.locator('#features .wg-landing__feature')).toHaveCount(3);
    await expect(page.locator('#features')).not.toContainText('Built for India');
    await expect(page.locator('.wg-landing__video-emblem')).toHaveCount(0);
    await expect(page.locator('.wg-landing__cta-arrow')).toHaveAttribute('aria-hidden', 'true');
    await expect(page.locator('.wg-landing__how-icon')).toHaveCount(0);
    await expect(page.locator('.wg-landing__menu-toggle')).toHaveCount(0);
    await page.waitForFunction(() => document.querySelector<HTMLVideoElement>('.wg-landing__video')?.videoWidth === 1920);

    await page.screenshot({ path: testInfo.outputPath(viewport.name + '.png'), animations: 'allow' });

    const layout = await page.evaluate(() => {
      const hero = document.querySelector<HTMLElement>('.wg-landing__hero')!;
      const copy = document.querySelector<HTMLElement>('.wg-landing__copy')!;
      const primary = document.querySelector<HTMLAnchorElement>('.wg-landing__summon')!;
      const features = document.querySelector<HTMLElement>('.wg-landing__feature-strip')!;
      const video = document.querySelector<HTMLVideoElement>('.wg-landing__video')!;
      const brand = document.querySelector<HTMLElement>('.wg-landing__brand')!;
      const headerActions = document.querySelector<HTMLElement>('.wg-landing__header-actions')!;
      const bounds = (element: Element) => {
        const rect = element.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, bottom: rect.bottom };
      };
      const objectPosition = getComputedStyle(video).objectPosition;
      return {
        viewport: { width: innerWidth, height: innerHeight },
        documentWidth: document.documentElement.scrollWidth,
        documentHeight: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
        brand: bounds(brand),
        headerActions: bounds(headerActions),
        videoObjectPosition: objectPosition,
        hero: bounds(hero),
        copy: bounds(copy),
        primary: bounds(primary),
        features: bounds(features),
        videoFilters: getComputedStyle(document.querySelector('.wg-landing__video')!).filter,
      };
    });

    expect(layout.documentWidth).toBeLessThanOrEqual(viewport.width);
    expect(layout.documentHeight).toBeLessThanOrEqual(viewport.height);
    expect(layout.hero.width).toBe(viewport.width);
    expect(layout.brand.x + layout.brand.width).toBeLessThanOrEqual(layout.headerActions.x);
    expect(layout.videoObjectPosition).toBe('100% 50%');
    expect(Math.abs(layout.primary.x + layout.primary.width / 2 - viewport.width / 2)).toBeLessThanOrEqual(1);
    expect(layout.primary.bottom).toBeLessThan(layout.features.y);
    expect(layout.videoFilters).toBe('none');
  }
});

test('loads and plays the supplied unmodified 10-second video, advances, and loops', async ({ page }, testInfo) => {
  const mediaResponses: number[] = [];
  page.on('response', (response) => {
    if (response.url().endsWith('/media/wealthgenie-hero.mp4')) mediaResponses.push(response.status());
  });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  const video = page.locator('.wg-landing__video');
  await expect(video).toHaveAttribute('loop', '');
  await expect(video).toHaveAttribute('playsinline', '');
  await expect(video).toHaveAttribute('poster', '/media/wealthgenie-hero-poster.jpg');
  await expect(video.locator('source')).toHaveAttribute('src', '/media/wealthgenie-hero.mp4');
  expect(await video.evaluate((element: HTMLVideoElement) => element.muted)).toBe(true);

  await page.waitForFunction(() => {
    const element = document.querySelector<HTMLVideoElement>('.wg-landing__video');
    return Boolean(element && element.readyState >= 2 && element.videoWidth === 1920 && !element.paused && element.currentTime > 0.5);
  }, null, { timeout: 20000 });

  const proof = await video.evaluate((element: HTMLVideoElement) => ({
    src: new URL(element.currentSrc).pathname,
    currentTime: Number(element.currentTime.toFixed(2)),
    duration: Number(element.duration.toFixed(2)),
    width: element.videoWidth,
    height: element.videoHeight,
    paused: element.paused,
    loop: element.loop,
    filter: getComputedStyle(element).filter,
  }));
  console.log('LANDING_VIDEO_PLAYBACK ' + JSON.stringify(proof));
  console.log('LANDING_VIDEO_HTTP ' + JSON.stringify(mediaResponses));
  expect(proof.src).toBe('/media/wealthgenie-hero.mp4');
  expect(proof.duration).toBeGreaterThanOrEqual(9);
  expect(proof.duration).toBeLessThanOrEqual(11);
  expect(proof.width).toBe(1920);
  expect(proof.height).toBe(1080);
  expect(proof.paused).toBe(false);
  expect(proof.loop).toBe(true);
  expect(proof.filter).toBe('none');
  expect(mediaResponses.some((status) => status === 200 || status === 206)).toBe(true);
  await expect(page.getByRole('button', { name: 'Background video playback' })).toHaveCount(0);

  await page.mouse.move(90, 140);
  await expect.poll(() => page.locator('.wg-landing__hero').evaluate((hero) => (hero as HTMLElement).style.getPropertyValue('--scene-tilt-x'))).not.toBe('0deg');

  await page.screenshot({ path: testInfo.outputPath('reference-layout-video-playing.png'), animations: 'allow' });

  await video.evaluate((element: HTMLVideoElement) => element.pause());
  for (const frame of [
    { name: 'video-frame-00', time: 0.05 },
    { name: 'video-frame-02', time: 2 },
    { name: 'video-frame-05', time: 5 },
    { name: 'video-frame-08', time: 8 },
    { name: 'video-frame-99', time: 9.9 },
  ]) {
    await video.evaluate((element: HTMLVideoElement, time: number) => new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error('Video seek did not complete')), 4000);
      const onSeeked = () => { window.clearTimeout(timeout); resolve(); };
      element.addEventListener('seeked', onSeeked, { once: true });
      element.currentTime = time;
      if (Math.abs(element.currentTime - time) < 0.01) {
        window.clearTimeout(timeout);
        resolve();
      }
    }), frame.time);
    const capturedTime = await video.evaluate((element: HTMLVideoElement) => element.currentTime);
    expect(Math.abs(capturedTime - frame.time)).toBeLessThan(0.12);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(/Smarter Investments,\s*A Brighter Tomorrow/);
    await expect(page.getByRole('link', { name: 'Summon Genie' })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(frame.name + '.png'), animations: 'allow' });
  }

  await video.evaluate(async (element: HTMLVideoElement) => {
    element.currentTime = Math.max(0, element.duration - 0.2);
    await element.play();
  });
  await page.waitForFunction(() => {
    const element = document.querySelector<HTMLVideoElement>('.wg-landing__video');
    return Boolean(element && element.currentTime < 0.25 && !element.paused);
  }, null, { timeout: 5000 });
});

test('routes authentication actions and omits the removed landing sections', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.getByRole('link', { name: 'Summon Genie' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByLabel('Username')).toBeVisible({ timeout: 20000 });

  await page.goto('/');
  await page.getByRole('link', { name: 'Log In' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'Get Started' })).toHaveCount(0);

  await page.goto('/');
  await expect(page.getByRole('link', { name: 'See How It Works' })).toHaveCount(0);
  await expect(page.getByText('A considered process')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Clarity for the decisions ahead.' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Choices shaped around your profile.' })).toHaveCount(0);
  await expect(page.getByText('Clearer financial decisions, grounded in your goals and the facts available.')).toHaveCount(0);
});

test('keeps the remaining navigation and skip link keyboard accessible without a mobile menu', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.locator('.wg-landing__menu-toggle')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Summon Genie' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Log In' })).toBeVisible();

  await page.goto('/');
  const skipLink = page.getByRole('link', { name: 'Skip to main content' });
  await skipLink.focus();
  await expect(skipLink).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#wg-landing-main')).toBeFocused();
  await expect(page.locator('#wg-landing-main')).toHaveCSS('outline-style', 'solid');
});

test('uses the poster without motion under reduced-motion settings', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');

  await expect(page.locator('.wg-landing__video')).toHaveCount(0);
  await expect(page.locator('.wg-landing__poster')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Summon Genie' })).toBeVisible();
  await page.getByRole('link', { name: 'Summon Genie' }).click();
  await expect(page).toHaveURL(/\/login$/);
});

test('keeps the playback control removed as reduced-motion preference changes', async ({ page }) => {
  await page.goto('/');
  const hero = page.locator('.wg-landing__hero');
  await expect(hero).toHaveAttribute('data-motion', 'full');
  await expect(page.getByRole('button', { name: 'Background video playback' })).toHaveCount(0);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(hero).toHaveAttribute('data-motion', 'reduced');
  await expect(page.locator('.wg-landing__video')).toHaveCount(0);

  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(hero).toHaveAttribute('data-motion', 'full');
  await expect(page.locator('.wg-landing__video')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Background video playback' })).toHaveCount(0);
});

test('uses the poster and preserves the CTAs when the video request fails', async ({ page }) => {
  await page.route('**/media/wealthgenie-hero.mp4', (route) => route.abort());
  await page.goto('/');

  await expect(page.locator('.wg-landing__video')).toHaveCount(0);
  await expect(page.locator('.wg-landing__poster')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Summon Genie' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'See How It Works' })).toHaveCount(0);
});
