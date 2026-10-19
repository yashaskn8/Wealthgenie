/** @vitest-environment jsdom */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import AuthPage from '../AuthPage';

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ login: vi.fn(), register: vi.fn() }),
}));

describe('login does not wait for background-video playback', () => {
  it('shows the existing username login without media events', () => {
    render(<MemoryRouter initialEntries={['/login']}><AuthPage /></MemoryRouter>);
    expect(document.getElementById('login-container')).toHaveClass('visible');
    expect(document.getElementById('bg-video')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByLabelText('Username')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Login', exact: true })).toBeInTheDocument();
    // Deliberately trigger no video ended/error/loadedmetadata events.
  });
});
