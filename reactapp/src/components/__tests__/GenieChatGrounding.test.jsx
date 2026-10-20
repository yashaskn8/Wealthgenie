/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MessageBubble } from '../GenieChatSubcomponents';

afterEach(cleanup);

describe('GenieChat grounded explanation metadata', () => {
  it('adds provenance in optional details without changing the existing message body', () => {
    render(<MessageBubble
      msg={{
        role: 'assistant',
        content: 'Existing answer body [E_PROFILE_RISK].',
        timestamp: '2026-09-09T00:00:00.000Z',
        _streamed: true,
        grounded: true,
        provider: 'NVIDIA_NIM',
        model: 'nvidia/nemotron-3.5-lightning-30b-a3b',
        grounding_version: 'grounded-financial-evidence-1.0.0',
        unavailable_facts: ['POST_TAX_RETURN_UNAVAILABLE_MISSING_TAX_INPUTS'],
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

    expect(screen.getByText(/Existing answer body/)).toBeTruthy();
    const summary = screen.getByText('Answer evidence and provenance');
    expect(summary).toBeTruthy();
    fireEvent.click(summary);
    expect(screen.getByText(/Provider: NVIDIA_NIM/)).toBeTruthy();
    expect(screen.getByText(/POST_TAX_RETURN_UNAVAILABLE/)).toBeTruthy();
  });

  it('renders only backend-supplied source URLs as links', () => {
    render(<MessageBubble
      msg={{
        role: 'assistant', content: 'Source-backed answer.', timestamp: '2026-09-09T00:00:00.000Z', _streamed: true,
        citations: [{ citation_id: 'E_RATE', document_title: 'Official rate', source: 'GOVERNMENT_OF_INDIA', source_url: 'https://www.indiapost.gov.in/' }],
      }}
      isLatest={false}
    />);
    fireEvent.click(screen.getByRole('button', { name: /Sources/ }));
    const link = screen.getByRole('link', { name: 'Official rate' });
    expect(link.getAttribute('href')).toBe('https://www.indiapost.gov.in/');
  });
});
