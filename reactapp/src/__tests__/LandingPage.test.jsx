import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import LandingPage from '../LandingPage';

let originalConnectionDescriptor;

function renderLanding() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/login" element={<h1>Existing login destination</h1>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  originalConnectionDescriptor = Object.getOwnPropertyDescriptor(navigator, 'connection');
  vi.stubGlobal('matchMedia', vi.fn().mockImplementation(() => ({ matches: false })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();

  if (originalConnectionDescriptor) {
    Object.defineProperty(navigator, 'connection', originalConnectionDescriptor);
  } else {
    Reflect.deleteProperty(navigator, 'connection');
  }
});

describe('LandingPage', () => {
  it('renders the reference headline, brand, and supplied video assets', () => {
    const { container } = renderLanding();
    const video = container.querySelector('video');

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/Smarter Investments,\s*A Brighter Tomorrow/);
    expect(screen.getByText('AI-ASSISTED FINANCIAL GUIDANCE')).toBeVisible();
    expect(screen.getByText('Get personalized investment recommendations for your goals, plus tax analysis where the available inputs support it.')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Log In' })).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Get Started' })).not.toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Primary navigation' })).not.toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'WealthGenie golden genie lamp emblem' })).toBeInTheDocument();
    expect(video).toHaveAttribute('autoplay');
    expect(video).toHaveAttribute('loop');
    expect(video).toHaveAttribute('playsinline');
    expect(video.muted).toBe(true);
    expect(video).toHaveAttribute('poster', '/media/wealthgenie-hero-poster.jpg');
    expect(video.querySelector('source')).toHaveAttribute('src', '/media/wealthgenie-hero.mp4');
    expect(screen.queryByRole('button', { name: /background video/i })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Summon Genie' })).toHaveAttribute('href', '/login');
    expect(screen.queryByRole('link', { name: 'See How It Works' })).not.toBeInTheDocument();
    expect(container.querySelectorAll('#features .wg-landing__feature')).toHaveLength(3);
    expect(screen.getByText('Tax Analysis Tools')).toBeVisible();
    expect(container.querySelector('#features')).not.toHaveTextContent('Built for India');
    expect(container.querySelector('.wg-landing__video-emblem')).not.toBeInTheDocument();
    expect(container.querySelector('.wg-landing__cta-arrow')).toHaveAttribute('aria-hidden', 'true');
    expect(container.querySelector('.wg-landing__how-icon')).not.toBeInTheDocument();
  });

  it('routes Summon Genie through React Router to the existing login path', () => {
    renderLanding();

    fireEvent.click(screen.getByRole('link', { name: 'Summon Genie' }));

    expect(screen.getByRole('heading', { name: 'Existing login destination' })).toBeInTheDocument();
  });

  it('keeps the video poster and login action when the video fails', async () => {
    const { container } = renderLanding();

    fireEvent.error(container.querySelector('video'));

    await waitFor(() => expect(container.querySelector('video')).not.toBeInTheDocument());
    expect(container.querySelector('.wg-landing__poster')).toBeVisible();
    expect(screen.queryByRole('button', { name: /background video/i })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Summon Genie' })).toBeVisible();

    fireEvent.click(screen.getByRole('link', { name: 'Summon Genie' }));
    expect(screen.getByRole('heading', { name: 'Existing login destination' })).toBeInTheDocument();
  });

  it('uses the static poster and removes video under reduced motion', () => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }));

    const { container } = renderLanding();

    expect(container.querySelector('video')).not.toBeInTheDocument();
    expect(container.querySelector('.wg-landing__poster')).toBeVisible();
    expect(screen.queryByRole('button', { name: /background video/i })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Summon Genie' })).toBeVisible();
    expect(container.querySelector('.wg-landing__hero')).toHaveAttribute('data-motion', 'reduced');
  });

  it('removes the video for reduced motion and ignores errors from the replaced video', async () => {
    const motionListeners = new Set();
    const motionQuery = {
      matches: false,
      addEventListener: (_type, listener) => motionListeners.add(listener),
      removeEventListener: (_type, listener) => motionListeners.delete(listener),
    };
    vi.stubGlobal('matchMedia', vi.fn(() => motionQuery));

    const { container } = renderLanding();
    const video = container.querySelector('video');
    const pause = vi.spyOn(video, 'pause').mockImplementation(() => fireEvent.pause(video));
    fireEvent.play(video);
    expect(screen.queryByRole('button', { name: /background video/i })).not.toBeInTheDocument();

    motionQuery.matches = true;
    for (const listener of motionListeners) listener({ matches: true });
    await waitFor(() => expect(container.querySelector('video')).not.toBeInTheDocument());
    expect(pause).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: /background video/i })).not.toBeInTheDocument();
    expect(container.querySelector('.wg-landing__poster')).toBeVisible();

    motionQuery.matches = false;
    for (const listener of motionListeners) listener({ matches: false });
    await waitFor(() => expect(container.querySelector('video')).toBeInTheDocument());
    const remountedVideo = container.querySelector('video');
    expect(remountedVideo).not.toBe(video);
    fireEvent.error(video);
    expect(container.querySelector('video')).toBe(remountedVideo);
    expect(screen.queryByRole('button', { name: /background video/i })).not.toBeInTheDocument();
  });

  it('uses the poster instead of downloading video when data saving is enabled', () => {
    Object.defineProperty(navigator, 'connection', {
      configurable: true,
      value: { saveData: true },
    });

    const { container } = renderLanding();

    expect(container.querySelector('video')).not.toBeInTheDocument();
    expect(container.querySelector('.wg-landing__poster')).toBeVisible();
    expect(screen.queryByRole('button', { name: /background video/i })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Summon Genie' })).toBeVisible();
  });

  it('keeps the approved autoplaying background video free of visible playback controls', () => {
    const { container } = renderLanding();
    const video = container.querySelector('video');

    expect(video).toHaveAttribute('autoplay');
    expect(video).toHaveAttribute('loop');
    expect(video).not.toHaveAttribute('controls');
    expect(screen.queryByRole('button', { name: /background video/i })).not.toBeInTheDocument();
  });

  it('omits the top Features label while keeping the feature strip and removed sections absent', () => {
    renderLanding();

    expect(screen.queryByRole('link', { name: 'Features' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'How It Works' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Investment Plans' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'About' })).not.toBeInTheDocument();
    expect(document.getElementById('how-it-works')).not.toBeInTheDocument();
    expect(document.getElementById('investment-plans')).not.toBeInTheDocument();
    expect(document.getElementById('about')).not.toBeInTheDocument();
    expect(screen.queryByText('A considered process')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Choices shaped around your profile.' })).not.toBeInTheDocument();
    expect(screen.queryByText('Clearer financial decisions, grounded in your goals and the facts available.')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /navigation/i })).not.toBeInTheDocument();
  });

});
