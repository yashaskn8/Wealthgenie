/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MessageBubble } from '../GenieChatSubcomponents';

afterEach(cleanup);

describe('GenieChat grounded explanation metadata', () => {
  it('keeps provenance in optional details and renders cited IDs as source numbers', () => {
    render(<MessageBubble
      msg={{
        role: 'assistant',
        content: 'Existing answer body [E_PROFILE_RISK].',
        timestamp: '2026-09-09T00:00:00.000Z',
        _streamed: true,
        grounded: true,
        fallback: true,
        provider: 'DETERMINISTIC_TEMPLATE',
        grounding_version: 'grounded-financial-evidence-1.0.0',
        unavailable_facts: ['POST_TAX_RETURN_UNAVAILABLE_MISSING_TAX_INPUTS'],
        fallback_reason_codes: ['LLM_GROUNDING_VALIDATION_FAILED', 'UNSUPPORTED_FINANCIAL_NUMBER'],
        citations: [{
          citation_id: 'E_PROFILE_RISK',
          document_title: 'suitability',
          source: 'WEALTHGENIE_BACKEND',
          excerpt: 'Moderate final suitability ceiling',
          source_url: null,
        }],
      }}
      isLatest={false}
    />);

    expect(screen.getByText('Existing answer body [1].')).toBeTruthy();
    expect(screen.queryByText(/Genie used a source-backed (?:fallback|answer)/)).toBeNull();
    expect(screen.queryByText(/\[E_PROFILE_RISK\]/)).toBeNull();
    const summary = screen.getByText('Answer evidence and provenance');
    expect(summary).toBeTruthy();
    fireEvent.click(summary);
    expect(screen.getByText(/Provider: DETERMINISTIC_TEMPLATE/)).toBeTruthy();
    expect(screen.getByText(/POST_TAX_RETURN_UNAVAILABLE/)).toBeTruthy();
    expect(screen.getByText(/Fallback diagnostics: LLM_GROUNDING_VALIDATION_FAILED, UNSUPPORTED_FINANCIAL_NUMBER/)).toBeTruthy();
  });

  it('does not mislabel a financial abstention as an unverified general AI answer', () => {
    render(<MessageBubble
      msg={{
        role: 'assistant',
        content: 'A personal post-tax return cannot be calculated without the tax inputs.',
        timestamp: '2026-10-23T00:00:00.000Z',
        _streamed: true,
        grounded: false,
        fallback: true,
        provider: 'DETERMINISTIC_TEMPLATE',
        validation_status: 'PASS',
        citations: [],
      }}
      isLatest={false}
    />);
    expect(screen.queryByText(/General AI answer/)).toBeNull();
    expect(screen.queryByText(/Genie used a source-backed fallback/)).toBeNull();
    expect(screen.getByText(/personal post-tax return cannot be calculated/)).toBeTruthy();
  });

  it('labels only truly unverified general-model responses', () => {
    render(<MessageBubble
      msg={{
        role: 'assistant', content: 'Python generators are lazy.',
        timestamp: '2026-10-23T00:00:00.000Z', _streamed: true,
        grounded: false, fallback: false, provider: 'GROQ',
        validation_status: 'UNVERIFIED_GENERAL_CHAT', citations: [],
      }}
      isLatest={false}
    />);
    expect(screen.getByText(/General AI answer/)).toBeTruthy();
  });

  it('renders only backend-supplied source URLs as links', () => {
    render(<MessageBubble
      msg={{
        role: 'assistant', content: 'Source-backed answer.', timestamp: '2026-09-09T00:00:00.000Z', _streamed: true,
        citations: [{ citation_id: 'E_RATE', document_title: 'Official rate', source: 'GOVERNMENT_OF_INDIA', source_url: 'https://www.indiapost.gov.in/' }],
      }}
      isLatest={false}
    />);
    fireEvent.click(screen.getByRole('button', { name: /Evidence/ }));
    const link = screen.getByRole('link', { name: 'Official rate' });
    expect(link.getAttribute('href')).toBe('https://www.indiapost.gov.in/');
  });

  it('does not hide an evidence marker that has no matching backend citation', () => {
    render(<MessageBubble
      msg={{
        role: 'assistant', content: 'Known [E_RATE]; unknown [E_MISSING].',
        timestamp: '2026-09-09T00:00:00.000Z', _streamed: true,
        citations: [{ citation_id: 'E_RATE', document_title: 'Official rate' }],
      }}
      isLatest={false}
    />);
    expect(screen.getByText('Known [1]; unknown [E_MISSING].')).toBeTruthy();
  });

  it('shows one copy of an exact duplicated disclosure from older stored replies', () => {
    const notice = 'For informational purposes only. Not registered investment advice under SEBI (IA) Regulations, 2013. Consult a SEBI-registered adviser before investing. Mutual fund investments are subject to market risks. [E_REGULATORY_NOTICE]';
    render(<MessageBubble
      msg={{
        role: 'assistant',
        content: `A useful fact [E_EDU]. ${notice}\n\n${notice}`,
        timestamp: '2026-09-09T00:00:00.000Z', _streamed: true,
        citations: [
          { citation_id: 'E_EDU', document_title: 'Education' },
          { citation_id: 'E_REGULATORY_NOTICE', document_title: 'Disclosure' },
        ],
      }}
      isLatest={false}
    />);
    expect(screen.getByText('A useful fact [1].')).toBeTruthy();
    expect(screen.queryByText(/For informational purposes only/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Evidence (1)' })).toBeTruthy();
  });
});
