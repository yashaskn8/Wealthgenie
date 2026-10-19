/**
 * @vitest-environment jsdom
 */
/* global global */
import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, it, expect, beforeAll } from 'vitest';
import HelpTourScreen from '../../HelpTourScreen';

beforeAll(() => {
  global.IntersectionObserver = class {
    constructor() {}
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

describe('HelpTourScreen Component', () => {
  it('never claims a human advisor request was submitted without a delivery backend', async () => {
    render(<HelpTourScreen />);
    fireEvent.click(screen.getByRole('button', { name: /Human Support Availability/i }));
    const dialog = await screen.findByRole('dialog', { name: 'Human support is not connected' });
    expect(within(dialog).getByText(/cannot accept or deliver advisor requests/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/No contact information has been collected or sent/i)).toBeInTheDocument();
    expect(within(dialog).queryByRole('textbox')).toBeNull();
    expect(within(dialog).queryByText(/Request Submitted!/i)).toBeNull();
    expect(within(dialog).queryByText(/will reach out within 24 hours/i)).toBeNull();
  });

  it('renders platform documentation title and strategy dashboard card', () => {
    render(<HelpTourScreen />);
    expect(screen.getByText('Guide')).toBeTruthy();
    expect(screen.getByText('Strategy Dashboard')).toBeTruthy();
  });
});
