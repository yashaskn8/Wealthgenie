/** @vitest-environment jsdom */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import AuthPage from '../AuthPage';

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ login: vi.fn(), register: vi.fn() }),
}));

describe('login follows the genie intro video', () => {
  it('reveals the form only after the video ends', () => {
    render(<MemoryRouter initialEntries={['/login']}><AuthPage /></MemoryRouter>);
    const card = document.getElementById('login-container');
    const video = document.getElementById('bg-video');
    expect(card).not.toHaveClass('visible');
    expect(card).toHaveAttribute('inert');
    expect(video).toHaveAttribute('aria-hidden', 'true');
    fireEvent.ended(video);
    expect(card).toHaveClass('visible');
    expect(card).not.toHaveAttribute('inert');
    expect(screen.getByLabelText('Email address')).toHaveAttribute('type', 'email');
    expect(screen.getByRole('button', { name: 'Login', exact: true })).toBeInTheDocument();
  });

  it('reveals login if playback fails, without inert recovery or session-persistence controls', () => {
    render(<MemoryRouter initialEntries={['/login']}><AuthPage /></MemoryRouter>);
    fireEvent.error(document.getElementById('bg-video'));
    expect(screen.getByText(/Password recovery is not available in this version/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Forgot Password/i })).toBeNull();
    expect(screen.queryByText('Remember me')).toBeNull();
  });
});
