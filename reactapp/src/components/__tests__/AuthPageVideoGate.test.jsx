/** @vitest-environment jsdom */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import AuthPage from '../AuthPage';

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ login: vi.fn(), register: vi.fn() }),
}));

describe('AuthPage accessibility without video playback', () => {
  it('renders the email login immediately without requiring a video ended/error event', () => {
    render(<MemoryRouter initialEntries={['/login']}><AuthPage /></MemoryRouter>);

    const card = document.getElementById('login-container');
    const backgroundVideo = document.getElementById('bg-video');
    expect(backgroundVideo).toBeInTheDocument();
    expect(card).toHaveClass('visible');
    expect(screen.getByLabelText('Email address')).toHaveAttribute('type', 'email');
    expect(screen.getByRole('button', { name: 'Login', exact: true })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Register' })).toBeInTheDocument();
    // No timers, autoplay, loadedmetadata, ended or media error events fire.
  });

  it('does not expose inert account-recovery and session-persistence controls', () => {
    render(<MemoryRouter initialEntries={['/login']}><AuthPage /></MemoryRouter>);
    expect(screen.getByText(/Password recovery is not available in this version/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Forgot Password/i })).toBeNull();
    expect(screen.queryByText('Remember me')).toBeNull();
  });
});
