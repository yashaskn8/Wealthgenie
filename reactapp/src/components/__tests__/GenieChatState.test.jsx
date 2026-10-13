import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import GenieChat from '../GenieChat';
import * as api from '../../services/api';

beforeEach(() => {
  sessionStorage.clear();
  sessionStorage.setItem('genie_session_id', 'fixture-session');
  Element.prototype.scrollIntoView = vi.fn();
  vi.spyOn(api, 'getTaxPolicyMetadata').mockResolvedValue({ verifiedFiscalYears: [] });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function openChat() {
  render(<GenieChat profile={null} onNavigate={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Genie AI' }));
}

describe('GenieChat persisted conversation state', () => {
  it('shows a retryable error when history cannot be loaded', async () => {
    const history = vi.spyOn(api, 'getChatHistory')
      .mockRejectedValueOnce(new Error('Network unavailable'))
      .mockResolvedValueOnce({ conversations: [] });
    openChat();

    expect(await screen.findByRole('alert')).toHaveTextContent(/saved chat history could not be loaded/i);
    fireEvent.click(screen.getByRole('button', { name: /retry loading history/i }));

    await waitFor(() => expect(history).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/your personal money guide/i)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('preserves the conversation and session when server deletion fails', async () => {
    vi.spyOn(api, 'getChatHistory').mockResolvedValue({
      conversations: [{
        messages: [
          { role: 'user', content: 'Saved question' },
          { role: 'model', content: 'Saved answer' },
        ],
      }],
    });
    vi.spyOn(api, 'clearChatSession').mockRejectedValue(new Error('Server unavailable'));
    openChat();

    expect(await screen.findByText('Saved question')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear chat conversation' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/conversation could not be cleared.*saved messages are still available/i);
    expect(screen.getByText('Saved question')).toBeInTheDocument();
    expect(sessionStorage.getItem('genie_session_id')).toBe('fixture-session');
  });
});
