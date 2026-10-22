/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { BackendFallbackBanner } from '../RecommendationDashboard.jsx';

afterEach(cleanup);

it('stale recommendation provides an explicit, opt-in recovery button', () => {
  const onRegenerate = vi.fn();
  render(<BackendFallbackBanner
    notice={{ message: 'Recommendation stale', canRegenerate: true }}
    onDismiss={vi.fn()} onRegenerate={onRegenerate} />);
  const button = screen.getByRole('button', { name: 'Regenerate current recommendation' });
  expect(button).toBeEnabled();
  fireEvent.click(button);
  expect(onRegenerate).toHaveBeenCalledTimes(1);
});

it('in-flight generation disables the recovery action', () => {
  const onRegenerate = vi.fn();
  render(<BackendFallbackBanner
    notice={{ message: 'Recommendation stale', canRegenerate: true }}
    onDismiss={vi.fn()} onRegenerate={onRegenerate} loading />);
  const button = screen.getByRole('button', { name: 'Regenerate current recommendation' });
  expect(button).toBeDisabled();
  fireEvent.click(button);
  expect(onRegenerate).not.toHaveBeenCalled();
});

it('unverified integrity failures never offer unsafe recovery', () => {
  render(<BackendFallbackBanner
    notice={{ message: 'Integrity failure', canRegenerate: false }}
    onDismiss={vi.fn()} onRegenerate={vi.fn()} />);
  expect(screen.queryByRole('button', { name: 'Regenerate current recommendation' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Dismiss fallback notice' })).toBeInTheDocument();
});
