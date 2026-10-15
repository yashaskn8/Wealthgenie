import React from 'react';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import GenieChat from '../GenieChat';
import * as api from '../../services/api';

const CHAT_SESSION_BINDING_FINGERPRINT_VERSION = 'wg-chat-binding-v2:';

function profileBindingFingerprint(profile, recommendations = [], recommendationMeta = null) {
  void recommendations;
  const recommendationState = {
    profileId: recommendationMeta?.profileId ?? recommendationMeta?.profile_id ?? profile?.profileId ?? profile?._id ?? null,
    profileVersion: recommendationMeta?.profile_version ?? profile?.version ?? null,
    recommendationId: recommendationMeta?.recommendationId ?? recommendationMeta?.recommendation_id ?? null,
    allocationRevision: recommendationMeta?.allocation_revision ?? null,
    allocationRevisionId: recommendationMeta?.allocation_revision_id ?? null,
  };
  const fingerprint = createHash('sha256').update(JSON.stringify(recommendationState)).digest('hex');
  return `${CHAT_SESSION_BINDING_FINGERPRINT_VERSION}${fingerprint}`;
}
beforeEach(() => {
  sessionStorage.clear();
  sessionStorage.setItem('genie_session_id', 'fixture-session');
  sessionStorage.setItem('genie_session_binding_fingerprint', profileBindingFingerprint(null));
  Element.prototype.scrollIntoView = vi.fn();
  vi.spyOn(api, 'getTaxPolicyMetadata').mockResolvedValue({ verifiedFiscalYears: [] });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function openChat() {
  render(<GenieChat profile={null} onNavigate={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Genie AI' }));
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

describe('GenieChat persisted conversation state', () => {
  it('waits for canonical recommendation context before binding or restoring the saved chat session', async () => {
    const profile = { profileId: '64b000000000000000000101', version: 3, name: 'Canonical Profile', monthly_savings: 1000 };
    const recommendations = [{ id: 'scheme-a', allocationWeight: 0.7, allocation_pct: 70 }];
    const recommendationMeta = {
      profileId: profile.profileId,
      profile_version: profile.version,
      profile_input_hash: 'a'.repeat(64),
      recommendationId: '64b000000000000000000102',
      allocation_revision: 4,
      allocation_revision_id: '64b000000000000000000103',
      recommendation_fingerprint: 'b'.repeat(64),
      portfolio_fingerprint: 'c'.repeat(64),
    };
    const savedSessionId = 'saved-canonical-context';
    sessionStorage.setItem('genie_session_id', savedSessionId);
    sessionStorage.setItem('genie_session_binding_fingerprint', profileBindingFingerprint(profile, recommendations, recommendationMeta));
    const history = vi.spyOn(api, 'getChatHistory').mockResolvedValue({
      conversations: [{ messages: [{ role: 'user', content: 'Saved canonical chat history' }] }],
    });
    const view = render(<GenieChat profile={profile} recommendations={[]} recommendationMeta={null} recommendationContextReady={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Genie AI' }));

    expect(await screen.findByText(/verifying your current financial plan/i)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /ask genie/i })).toBeDisabled();
    expect(history).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('genie_session_id')).toBe(savedSessionId);

    view.rerender(<GenieChat profile={profile} recommendations={recommendations} recommendationMeta={recommendationMeta} recommendationContextReady />);
    expect(await screen.findByText('Saved canonical chat history')).toBeInTheDocument();
    expect(history).toHaveBeenCalledWith(savedSessionId);
    expect(sessionStorage.getItem('genie_session_id')).toBe(savedSessionId);
  });

  it('preserves a legacy session ID for server-verified history and replaces the old fingerprint', async () => {
    const profile = { profileId: '64b000000000000000000105', version: 2, name: 'Legacy profile', monthly_savings: 1000 };
    const savedSessionId = 'legacy-session-id';
    sessionStorage.setItem('genie_session_id', savedSessionId);
    sessionStorage.setItem('genie_session_binding_fingerprint', 'a'.repeat(64));
    const history = vi.spyOn(api, 'getChatHistory').mockResolvedValue({ conversations: [] });

    render(<GenieChat profile={profile} recommendationContextReady />);
    fireEvent.click(screen.getByRole('button', { name: 'Genie AI' }));

    await waitFor(() => expect(history).toHaveBeenCalledWith(savedSessionId));
    expect(sessionStorage.getItem('genie_session_id')).toBe(savedSessionId);
    expect(sessionStorage.getItem('genie_session_binding_fingerprint')).toBe(profileBindingFingerprint(profile));
  });

  it('rotates stale server-bound sessions and preserves the unsent message as an editable draft', async () => {
    const profile = { profileId: '64b000000000000000000106', version: 2, name: 'Current profile', monthly_savings: 1000 };
    vi.spyOn(api, 'getChatHistory').mockResolvedValue({ conversations: [] });
    const conflict = Object.assign(new Error('The chat session is bound to a different financial source state.'), {
      code: 'CHAT_PROFILE_STATE_CHANGED',
      status: 409,
    });
    const send = vi.spyOn(api, 'sendChatMessage').mockRejectedValue(conflict);
    render(<GenieChat profile={profile} recommendationContextReady />);
    fireEvent.click(screen.getByRole('button', { name: 'Genie AI' }));
    expect(await screen.findByText(/Hi, Current!/i)).toBeInTheDocument();
    const originalSessionId = sessionStorage.getItem('genie_session_id');
    const input = screen.getByRole('textbox', { name: /ask genie/i });
    fireEvent.change(input, { target: { value: 'Keep this question for the new session' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    expect(await screen.findByRole('status')).toHaveTextContent(/this message was not sent/i);
    await waitFor(() => expect(sessionStorage.getItem('genie_session_id')).not.toBe(originalSessionId));
    expect(screen.getByRole('textbox', { name: /ask genie/i })).toHaveValue('Keep this question for the new session');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('rotates a saved chat session when canonical recommendation or allocation provenance changes', async () => {
    const profile = { profileId: '64b000000000000000000111', version: 3, name: 'Bound Profile', monthly_savings: 1000 };
    const recommendations = [{ id: 'scheme-a', allocationWeight: 1, allocation_pct: 100 }];
    const baseMeta = {
      profileId: profile.profileId,
      profile_version: profile.version,
      profile_input_hash: 'd'.repeat(64),
      recommendationId: '64b000000000000000000112',
      allocation_revision: 4,
      allocation_revision_id: '64b000000000000000000113',
      recommendation_fingerprint: 'e'.repeat(64),
      portfolio_fingerprint: 'f'.repeat(64),
    };
    const changedBindings = [
      ['recommendation identity', { recommendationId: '64b000000000000000000122' }],
      ['allocation revision', { allocation_revision: 5 }],
      ['allocation revision identity', { allocation_revision_id: '64b000000000000000000123' }],
    ];
    const history = vi.spyOn(api, 'getChatHistory').mockResolvedValue({ conversations: [] });

    for (const [label, change] of changedBindings) {
      cleanup();
      const oldSessionId = `saved-${label.replaceAll(' ', '-')}`;
      sessionStorage.setItem('genie_session_id', oldSessionId);
      sessionStorage.setItem('genie_session_binding_fingerprint', profileBindingFingerprint(profile, recommendations, baseMeta));
      render(<GenieChat profile={profile} recommendations={recommendations} recommendationMeta={{ ...baseMeta, ...change }} recommendationContextReady />);
      fireEvent.click(screen.getByRole('button', { name: 'Genie AI' }));

      await waitFor(() => expect(sessionStorage.getItem('genie_session_id')).not.toBe(oldSessionId));
      expect(history).not.toHaveBeenCalledWith(oldSessionId);
      expect(history).toHaveBeenLastCalledWith(sessionStorage.getItem('genie_session_id'));
    }
  });
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

  it('keeps the transcript and reports an unconfirmed clear until history is checked', async () => {
    const history = vi.spyOn(api, 'getChatHistory').mockResolvedValue({
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

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not confirm whether saved chat history was cleared/i);
    expect(screen.getByText('Saved question')).toBeInTheDocument();
    expect(sessionStorage.getItem('genie_session_id')).toBe('fixture-session');

    fireEvent.click(screen.getByRole('button', { name: 'Check saved history' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/saved chat history is still present/i);
    expect(screen.getByText('Saved question')).toBeInTheDocument();
    expect(history).toHaveBeenCalledTimes(2);
  });

  it('reconciles a lost clear response after server deletion before removing the local transcript', async () => {
    const history = vi.spyOn(api, 'getChatHistory')
      .mockResolvedValueOnce({
        conversations: [{ messages: [{ role: 'user', content: 'Saved before ambiguous clear' }] }],
      })
      .mockResolvedValueOnce({ conversations: [] });
    vi.spyOn(api, 'clearChatSession').mockRejectedValue(new Error('Response lost after server deletion'));
    openChat();

    expect(await screen.findByText('Saved before ambiguous clear')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear chat conversation' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/saved history status is unknown/i);
    expect(screen.getByText('Saved before ambiguous clear')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Check saved history' }));
    expect(await screen.findByText('Saved conversation cleared.')).toBeInTheDocument();
    expect(screen.queryByText('Saved before ambiguous clear')).not.toBeInTheDocument();
    expect(sessionStorage.getItem('genie_session_id')).not.toBe('fixture-session');
    expect(history).toHaveBeenCalledTimes(3);
  });

  it('restores the persisted assistant reply when clear fails after an in-flight send', async () => {
    const pendingSend = deferred();
    const savedTranscript = {
      conversations: [{
        messages: [
          { role: 'user', content: 'Question during clear', timestamp: '2026-10-14T10:00:00.000Z' },
          { role: 'model', content: 'Persisted answer restored after failed clear', timestamp: '2026-10-14T10:00:01.000Z' },
        ],
      }],
    };
    const history = vi.spyOn(api, 'getChatHistory')
      .mockResolvedValueOnce({ conversations: [] })
      .mockResolvedValueOnce(savedTranscript);
    const send = vi.spyOn(api, 'sendChatMessage').mockReturnValue(pendingSend.promise);
    vi.spyOn(api, 'clearChatSession').mockRejectedValue(new Error('Server unavailable'));
    render(<GenieChat profile={null} onNavigate={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Genie AI' }));
    expect(await screen.findByText(/your personal money guide/i)).toBeInTheDocument();

    fireEvent.change(screen.getByRole('textbox', { name: /ask genie/i }), {
      target: { value: 'Question during clear' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Clear chat conversation' }));
    expect(screen.queryByText('Persisted answer restored after failed clear')).not.toBeInTheDocument();

    await act(async () => {
      pendingSend.resolve({
        response: 'Persisted answer restored after failed clear',
        rate_limit_remaining: 29,
      });
      await pendingSend.promise;
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not confirm whether saved chat history was cleared/i);
    expect(screen.queryByText('Persisted answer restored after failed clear')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Check saved history' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/saved chat history is still present/i);
    expect(screen.getByText('Persisted answer restored after failed clear')).toBeInTheDocument();
    expect(screen.getAllByText('Question during clear')).toHaveLength(1);
    expect(sessionStorage.getItem('genie_session_id')).toBe('fixture-session');
    expect(history).toHaveBeenCalledTimes(2);
  });

  it('does not restore checked history after the profile session changes', async () => {
    const pendingCheck = deferred();
    const history = vi.spyOn(api, 'getChatHistory')
      .mockResolvedValueOnce({ conversations: [] })
      .mockReturnValueOnce(pendingCheck.promise)
      .mockResolvedValue({ conversations: [] });
    vi.spyOn(api, 'clearChatSession').mockRejectedValue(new Error('Server unavailable'));
    const firstProfile = { profileId: '64b000000000000000000131', version: 1, name: 'First profile', monthly_savings: 1000 };
    const secondProfile = { profileId: '64b000000000000000000132', version: 1, name: 'Second profile', monthly_savings: 2000 };
    const view = render(<GenieChat profile={firstProfile} onNavigate={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Genie AI' }));
    expect(await screen.findByText(/Hi, First!/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Clear chat conversation' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not confirm whether saved chat history was cleared/i);
    fireEvent.click(screen.getByRole('button', { name: 'Check saved history' }));
    await waitFor(() => expect(history).toHaveBeenCalledTimes(2));
    const oldSessionId = sessionStorage.getItem('genie_session_id');

    view.rerender(<GenieChat profile={secondProfile} onNavigate={vi.fn()} />);
    await waitFor(() => expect(sessionStorage.getItem('genie_session_id')).not.toBe(oldSessionId));
    await waitFor(() => expect(history).toHaveBeenCalledTimes(3));
    expect(await screen.findByText(/Hi, Second!/i)).toBeInTheDocument();

    await act(async () => pendingCheck.resolve({
      conversations: [{
        messages: [{ role: 'model', content: 'Private answer from the previous profile' }],
      }],
    }));
    expect(screen.queryByText('Private answer from the previous profile')).not.toBeInTheDocument();
    expect(sessionStorage.getItem('genie_session_id')).not.toBe(oldSessionId);
  });

  it('reports when browser storage cannot preserve the session', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Storage blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage blocked'); });
    vi.spyOn(api, 'getChatHistory').mockResolvedValue({ conversations: [] });
    openChat();

    expect(await screen.findByRole('status')).toHaveTextContent(/conversation is temporary on this device/i);
  });

  it('does not load a saved history response after the profile session changes', async () => {
    const oldHistory = deferred();
    const history = vi.spyOn(api, 'getChatHistory')
      .mockImplementationOnce(() => oldHistory.promise)
      .mockResolvedValue({ conversations: [] });
    const view = render(<GenieChat profile={{ profileId: '64b000000000000000000151', version: 1, name: 'First profile', monthly_savings: 1000 }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Genie AI' }));
    await waitFor(() => expect(history).toHaveBeenCalledTimes(1));

    view.rerender(<GenieChat profile={{ profileId: '64b000000000000000000152', version: 1, name: 'Second profile', monthly_savings: 2000 }} />);
    await waitFor(() => expect(history).toHaveBeenCalledTimes(2));
    await act(async () => oldHistory.resolve({
      conversations: [{ messages: [{ role: 'user', content: 'First profile private question' }] }],
    }));

    expect(screen.queryByText('First profile private question')).not.toBeInTheDocument();
    expect(await screen.findByText(/Hi, Second!/i)).toBeInTheDocument();
  });

  it('does not append a send response after the profile session changes', async () => {
    const oldSend = deferred();
    const history = vi.spyOn(api, 'getChatHistory').mockResolvedValue({ conversations: [] });
    const send = vi.spyOn(api, 'sendChatMessage').mockImplementation(() => oldSend.promise);
    const view = render(<GenieChat profile={{ profileId: '64b000000000000000000161', version: 1, name: 'First profile', monthly_savings: 1000 }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Genie AI' }));
    expect(await screen.findByText(/Hi, First!/i)).toBeInTheDocument();
    const originalSessionId = sessionStorage.getItem('genie_session_id');
    fireEvent.change(screen.getByRole('textbox', { name: /ask genie/i }), {
      target: { value: 'Question for the first profile' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(screen.getByText('Question for the first profile')).toBeInTheDocument();

    view.rerender(<GenieChat profile={{ profileId: '64b000000000000000000162', version: 1, name: 'Second profile', monthly_savings: 2000 }} />);
    await waitFor(() => expect(sessionStorage.getItem('genie_session_id')).not.toBe(originalSessionId));
    expect(screen.queryByText('Question for the first profile')).not.toBeInTheDocument();
    await waitFor(() => expect(history).toHaveBeenCalledTimes(2));

    await act(async () => oldSend.resolve({ response: 'Stale answer from the first profile', rate_limit_remaining: 29 }));
    expect(screen.queryByText('Stale answer from the first profile')).not.toBeInTheDocument();
  });

  it('aborts a deferred send when logout begins and fences its late response', async () => {
    const pendingSend = deferred();
    const cancellationRef = { current: null };
    let requestSignal;
    vi.spyOn(api, 'getChatHistory').mockResolvedValue({ conversations: [] });
    const send = vi.spyOn(api, 'sendChatMessage').mockImplementation((_message, _sessionId, { signal }) => {
      requestSignal = signal;
      return pendingSend.promise;
    });
    const view = render(<GenieChat profile={null} cancelPendingSendRef={cancellationRef} />);
    fireEvent.click(screen.getByRole('button', { name: 'Genie AI' }));
    expect(await screen.findByText(/your personal money guide/i)).toBeInTheDocument();

    fireEvent.change(screen.getByRole('textbox', { name: /ask genie/i }), {
      target: { value: 'A question interrupted by logout' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(requestSignal.aborted).toBe(false);
    expect(cancellationRef.current).toBeTypeOf('function');

    act(() => cancellationRef.current());
    expect(requestSignal.aborted).toBe(true);
    expect(await screen.findByRole('status')).toHaveTextContent(/couldn't confirm whether your message was sent before sign-out interrupted it/i);
    view.unmount();
    render(<GenieChat profile={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Genie AI' }));
    expect(await screen.findByText(/your personal money guide/i)).toBeInTheDocument();

    await act(async () => pendingSend.resolve({ response: 'Late private reply after logout', rate_limit_remaining: 29 }));
    expect(screen.queryByText('Late private reply after logout')).not.toBeInTheDocument();
  });

  it('aborts a pending request and invalidates its result when chat unmounts', async () => {
    const pendingSend = deferred();
    let requestSignal;
    vi.spyOn(api, 'getChatHistory').mockResolvedValue({ conversations: [] });
    const send = vi.spyOn(api, 'sendChatMessage').mockImplementation((_message, _sessionId, { signal }) => {
      requestSignal = signal;
      return pendingSend.promise;
    });
    const view = render(<GenieChat profile={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Genie AI' }));
    expect(await screen.findByText(/your personal money guide/i)).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: /ask genie/i }), {
      target: { value: 'A question interrupted by unmount' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));

    view.unmount();
    expect(requestSignal.aborted).toBe(true);
    await act(async () => pendingSend.resolve({ response: 'Late private reply after unmount', rate_limit_remaining: 29 }));
    expect(screen.queryByText('Late private reply after unmount')).not.toBeInTheDocument();
  });
  it('does not restore a prior profile history after remounting with a changed profile binding', async () => {
    const firstProfile = { profileId: '64b000000000000000000141', version: 1, name: 'First profile', monthly_savings: 1000 };
    const secondProfile = { profileId: '64b000000000000000000142', version: 1, name: 'Second profile', monthly_savings: 2000 };
    const oldSessionId = 'saved-first-profile-session';
    sessionStorage.setItem('genie_session_id', oldSessionId);
    sessionStorage.setItem('genie_session_binding_fingerprint', profileBindingFingerprint(firstProfile));
    const history = vi.spyOn(api, 'getChatHistory').mockImplementation(async sessionId => (
      sessionId === oldSessionId
        ? { conversations: [{ messages: [{ role: 'user', content: 'First profile private history' }] }] }
        : { conversations: [] }
    ));

    const firstMount = render(<GenieChat profile={firstProfile} />);
    fireEvent.click(screen.getByRole('button', { name: 'Genie AI' }));
    expect(await screen.findByText('First profile private history')).toBeInTheDocument();
    firstMount.unmount();

    render(<GenieChat profile={secondProfile} />);
    await waitFor(() => expect(sessionStorage.getItem('genie_session_id')).not.toBe(oldSessionId));
    const secondSessionId = sessionStorage.getItem('genie_session_id');
    fireEvent.click(screen.getByRole('button', { name: 'Genie AI' }));

    await waitFor(() => expect(history).toHaveBeenCalledTimes(2));
    expect(history).toHaveBeenLastCalledWith(secondSessionId);
    expect(screen.queryByText('First profile private history')).not.toBeInTheDocument();
    expect(sessionStorage.getItem('genie_session_binding_fingerprint')).toBe(profileBindingFingerprint(secondProfile));
  });

  it('keeps user-wide chat quota exhausted after clear and profile changes, and reports Retry-After', async () => {
    const firstProfile = { profileId: '64b000000000000000000171', version: 1, name: 'First profile', monthly_savings: 1000 };
    const secondProfile = { profileId: '64b000000000000000000172', version: 1, name: 'Second profile', monthly_savings: 2000 };
    sessionStorage.setItem('genie_session_binding_fingerprint', profileBindingFingerprint(firstProfile));
    const history = vi.spyOn(api, 'getChatHistory').mockResolvedValue({ conversations: [] });
    const clear = vi.spyOn(api, 'clearChatSession').mockResolvedValue({ success: true });
    const resetAt = Date.now() + (41 * 60 * 1000);
    const quotaError = Object.assign(new Error('The hourly chat message limit has been reached.'), {
      code: 'CHAT_RATE_LIMIT_EXCEEDED',
      status: 429,
      details: { retryAfterSeconds: 41 * 60, resetAt: new Date(resetAt).toISOString() },
    });
    const send = vi.spyOn(api, 'sendChatMessage').mockRejectedValue(quotaError);
    const view = render(<GenieChat profile={firstProfile} />);
    fireEvent.click(screen.getByRole('button', { name: 'Genie AI' }));
    expect(await screen.findByText(/Hi, First!/i)).toBeInTheDocument();
    await waitFor(() => expect(history).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByRole('textbox', { name: /ask genie/i }), {
      target: { value: 'Check current chat quota' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(await screen.findByText(/retry in about 41 minutes/i)).toBeInTheDocument();
    expect(send).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('textbox', { name: /ask genie/i })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Clear chat conversation' }));
    await waitFor(() => expect(clear).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(sessionStorage.getItem('genie_session_id')).not.toBe('fixture-session'));
    expect(screen.getByRole('textbox', { name: /ask genie/i })).toBeDisabled();

    view.rerender(<GenieChat profile={secondProfile} />);
    await waitFor(() => expect(sessionStorage.getItem('genie_session_binding_fingerprint')).toBe(profileBindingFingerprint(secondProfile)));
    expect(screen.getByRole('textbox', { name: /ask genie/i })).toBeDisabled();
  });

  it('unblocks after the exact server reset time following the final successful quota use', async () => {
    vi.spyOn(api, 'getChatHistory').mockResolvedValue({ conversations: [] });
    const start = Date.parse('2026-10-14T10:00:00.000Z');
    const resetAt = new Date(start + 30_000).toISOString();
    const send = vi.spyOn(api, 'sendChatMessage').mockResolvedValue({
      response: 'Final allowed answer',
      rate_limit_remaining: 0,
      rate_limit_reset_at: resetAt,
    });
    render(<GenieChat profile={null} onNavigate={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Genie AI' }));
    expect(await screen.findByText(/your personal money guide/i)).toBeInTheDocument();

    vi.useFakeTimers();
    vi.setSystemTime(start);
    fireEvent.change(screen.getByRole('textbox', { name: /ask genie/i }), {
      target: { value: 'Use the final available message' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
      await Promise.resolve();
    });

    expect(send).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(screen.getByText('Final allowed answer')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /ask genie/i })).toBeDisabled();
    expect(screen.getByText(/available again at/i)).toBeInTheDocument();

    await act(async () => { await vi.advanceTimersByTimeAsync(30_001); });
    expect(screen.getByRole('textbox', { name: /ask genie/i })).toBeEnabled();
  });

  it('does not invent a reset interval when the final successful quota response omits reset time', async () => {
    vi.spyOn(api, 'getChatHistory').mockResolvedValue({ conversations: [] });
    vi.spyOn(api, 'sendChatMessage').mockResolvedValue({
      response: 'Answer with missing reset metadata',
      rate_limit_remaining: 0,
    });
    render(<GenieChat profile={null} onNavigate={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Genie AI' }));
    expect(await screen.findByText(/your personal money guide/i)).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: /ask genie/i }), {
      target: { value: 'Use the final available message' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    expect(await screen.findByText('Answer with missing reset metadata')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /ask genie/i })).toBeEnabled();
    expect(screen.getByText(/check availability on your next message/i)).toBeInTheDocument();
  });
  it('waits for an active send before deleting its session and fences the send response', async () => {
    const oldSend = deferred();
    const events = [];
    const history = vi.spyOn(api, 'getChatHistory').mockResolvedValue({ conversations: [] });
    const send = vi.spyOn(api, 'sendChatMessage').mockImplementation(() => {
      events.push('send-started');
      return oldSend.promise.then(result => {
        events.push('send-settled');
        return result;
      });
    });
    const clear = vi.spyOn(api, 'clearChatSession').mockImplementation(async () => {
      events.push('session-deleted');
      return { success: true };
    });
    render(<GenieChat profile={null} onNavigate={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Genie AI' }));
    expect(await screen.findByText(/your personal money guide/i)).toBeInTheDocument();

    fireEvent.change(screen.getByRole('textbox', { name: /ask genie/i }), {
      target: { value: 'Question while clear begins' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Clear chat conversation' }));

    expect(clear).not.toHaveBeenCalled();
    expect(screen.getByText('Question while clear begins')).toBeInTheDocument();
    await act(async () => oldSend.resolve({ response: 'Reply that must be deleted', rate_limit_remaining: 29 }));
    await waitFor(() => expect(clear).toHaveBeenCalledWith('fixture-session'));
    expect(events).toEqual(['send-started', 'send-settled', 'session-deleted']);
    expect(screen.queryByText('Reply that must be deleted')).not.toBeInTheDocument();

    await waitFor(() => expect(sessionStorage.getItem('genie_session_id')).not.toBe('fixture-session'));
    await waitFor(() => expect(history).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('Question while clear begins')).not.toBeInTheDocument();
    expect(await screen.findByText(/your personal money guide/i)).toBeInTheDocument();
  });
});
