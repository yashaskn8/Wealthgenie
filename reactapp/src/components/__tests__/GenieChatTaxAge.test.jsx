import React from 'react';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import GenieChat from '../GenieChat';
import * as api from '../../services/api';

const BINDING_VERSION = 'wg-chat-binding-v2:';
const fiscalYears = ['FY2025-26', 'FY2026-27'];

function profileBindingFingerprint(profile) {
  const recommendationState = {
    profileId: profile?.profileId ?? profile?._id ?? null,
    profileVersion: profile?.version ?? null,
    recommendationId: null,
    allocationRevision: null,
    allocationRevisionId: null,
  };
  const fingerprint = createHash('sha256').update(JSON.stringify(recommendationState)).digest('hex');
  return `${BINDING_VERSION}${fingerprint}`;
}

function taxComparison({
  fiscalYear = 'FY2025-26', income = 300000, incomeSource = 'salary', age = 42, section80C = 0, nps80CCD1B = 0,
} = {}) {
  const newTaxableIncome = 100000;
  const oldTaxableIncome = 200000;
  const newTax = 11000;
  const oldTax = 22000;
  return {
    income,
    fiscal_year: fiscalYear,
    verified: true,
    calculation_classification: 'SEPARATE_TAX_WHAT_IF',
    inputsUsed: {
      annualIncome: income,
      incomeSource,
      fiscalYear,
      deductions: { section80C, nps80CCD1B, age },
    },
    new_regime: {
      tax: newTax,
      taxable_income: newTaxableIncome,
      effective_rate: 0.11,
      standard_deduction: 75000,
      cess: 0,
      nps80CCD2: 0,
      allowed80D: 0,
      rebate_applied: false,
      marginal_relief_applied: false,
      marginal_relief_amount: 0,
      slab_breakdown: [{ label: 'Your Total Tax', rate: '', taxableInSlab: newTaxableIncome, taxInSlab: newTax, isTotalRow: true }],
    },
    old_regime: {
      tax: oldTax,
      taxable_income: oldTaxableIncome,
      effective_rate: 0.11,
      standard_deduction: 50000,
      cess: 0,
      nps80CCD2: 0,
      allowed80D: 0,
      old_regime_deductions: 150000,
      rebate_applied: false,
      marginal_relief_applied: false,
      marginal_relief_amount: 0,
      slab_breakdown: [{ label: 'Your Total Tax', rate: '', taxableInSlab: oldTaxableIncome, taxInSlab: oldTax, isTotalRow: true }],
    },
    saving: oldTax - newTax,
    saving_pct: 50,
    saving_with: 'new',
    recommended_regime: 'new',
    deduction_limits: { section80C: 150000, section80CCD1B: 50000 },
    remaining_deductions: { section80C: 0, section80CCD1B: 0 },
    optimized_old_regime_tax: oldTax,
    potential_tax_saving: 0,
    crossover_breakpoint: null,
    policyVersion: 'test-tax-policy',
  };
}

function taxComparisonForCall([income, inputs]) {
  return taxComparison({
    income,
    fiscalYear: inputs.fiscalYear,
    incomeSource: inputs.incomeSource,
    age: inputs.age,
    section80C: inputs.section80C,
    nps80CCD1B: inputs.nps80CCD1B,
  });
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function openTaxOptimizer(profile = null, policyLoader = () => Promise.resolve({ verifiedFiscalYears: fiscalYears })) {
  sessionStorage.setItem('genie_session_id', 'tax-age-session');
  sessionStorage.setItem('genie_session_binding_fingerprint', profileBindingFingerprint(profile));
  vi.spyOn(api, 'getChatHistory').mockResolvedValue({ conversations: [] });
  vi.spyOn(api, 'getTaxPolicyMetadata').mockImplementation(policyLoader);
  const actionCard = [
    '<<<ACTION_CARD>>>',
    JSON.stringify({
      type: 'tax_save',
      title: 'Open tax helper',
      subtitle: 'Open the isolated tax workspace',
      actions: [{ label: 'Open tax helper', target: '/tax' }],
    }),
    '<<<END_ACTION_CARD>>>',
  ].join('\n');
  vi.spyOn(api, 'sendChatMessage').mockResolvedValue({ response: actionCard, rate_limit_remaining: 29 });

  const view = render(<GenieChat profile={profile} onNavigate={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Genie AI' }));
  const chatInput = await screen.findByRole('textbox', { name: /ask genie/i });
  await waitFor(() => expect(chatInput).toBeEnabled());
  fireEvent.change(chatInput, { target: { value: 'Open the tax helper' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
  fireEvent.click(await screen.findByRole('button', { name: /open tax helper/i }, { timeout: 10000 }));
  const ageInput = await screen.findByRole('spinbutton', { name: 'Age on March 31 of selected fiscal year' });
  return { view, ageInput };
}

function confirmTaxScenario() {
  fireEvent.click(screen.getByRole('checkbox', {
    name: /i confirm these income and deduction amounts for this comparison/i,
  }));
}

function chooseIncomeAndYear(fiscalYear = 'FY2025-26') {
  fireEvent.change(screen.getByLabelText('Tax income source'), { target: { value: 'salary' } });
  fireEvent.change(screen.getByLabelText('Tax fiscal year'), { target: { value: fiscalYear } });
}

beforeEach(() => {
  sessionStorage.clear();
  sessionStorage.setItem('genie_session_id', 'fixture-session');
  sessionStorage.setItem('genie_session_binding_fingerprint', profileBindingFingerprint(null));
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.restoreAllMocks();
});

describe('GenieChat Tax Optimizer fiscal-year age binding', () => {
  it('offers a retry when verified fiscal-year metadata cannot be loaded', async () => {
    const policyLoader = vi.fn()
      .mockRejectedValueOnce(new Error('private provider details'))
      .mockResolvedValueOnce({ verifiedFiscalYears: fiscalYears });
    await openTaxOptimizer(null, policyLoader);

    expect(await screen.findByRole('alert')).toHaveTextContent(/verified tax years are unavailable/i);
    expect(screen.getByLabelText('Tax fiscal year').querySelectorAll('option')).toHaveLength(1);
    expect(screen.queryByText('private provider details')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() => expect(screen.getByLabelText('Tax fiscal year').querySelectorAll('option')).toHaveLength(3));
    expect(policyLoader).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('offers a retry when an active tax-policy request is aborted during an auth change', async () => {
    const policyLoader = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('session changed'), { code: 'REQUEST_ABORTED' }))
      .mockResolvedValueOnce({ verifiedFiscalYears: fiscalYears });
    await openTaxOptimizer(null, policyLoader);

    expect(await screen.findByRole('alert')).toHaveTextContent(/verified tax years are unavailable/i);
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() => expect(screen.getByLabelText('Tax fiscal year').querySelectorAll('option')).toHaveLength(3));
    expect(policyLoader).toHaveBeenCalledTimes(2);
  });

  it('does not substitute the saved profile age when the selected fiscal year has no entered age', async () => {
    const profile = { profileId: 'profile-tax-age-1', version: 4, age: 37, name: 'Test User' };
    const compare = vi.spyOn(api, 'compareTax');
    await openTaxOptimizer(profile);
    chooseIncomeAndYear();

    await new Promise(resolve => setTimeout(resolve, 350));

    expect(compare).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent(/enter a whole-number age from 18 to 120/i);
    expect(screen.getByRole('spinbutton', { name: 'Age on March 31 of selected fiscal year' })).toHaveValue(null);
  });

  it('does not calculate with example income or zero deductions until the user confirms the scenario', async () => {
    const compare = vi.spyOn(api, 'compareTax').mockImplementation((income, inputs) => (
      Promise.resolve(taxComparison({
        income,
        fiscalYear: inputs.fiscalYear,
        incomeSource: inputs.incomeSource,
        age: inputs.age,
        section80C: inputs.section80C,
        nps80CCD1B: inputs.nps80CCD1B,
      }))
    ));
    await openTaxOptimizer();
    chooseIncomeAndYear();
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Age on March 31 of selected fiscal year' }), { target: { value: '42' } });

    expect(screen.getByText(/starting amounts are examples/i)).toBeInTheDocument();
    await new Promise(resolve => setTimeout(resolve, 350));
    expect(compare).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent(/review the income and deduction amounts/i);

    confirmTaxScenario();
    await waitFor(() => expect(compare).toHaveBeenCalledTimes(1));
    expect(compare).toHaveBeenCalledWith(
      300000,
      expect.objectContaining({ section80C: 0, nps80CCD1B: 0 }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('sends only an explicitly entered whole-number age for March 31 of the selected year', async () => {
    await openTaxOptimizer({ profileId: 'profile-tax-age-2', version: 1, age: 29, name: 'Test User' });
    vi.spyOn(api, 'compareTax').mockImplementation((income, inputs) => Promise.resolve(taxComparison({
      income,
      fiscalYear: inputs.fiscalYear,
      incomeSource: inputs.incomeSource,
      age: inputs.age,
      section80C: inputs.section80C,
      nps80CCD1B: inputs.nps80CCD1B,
    })));
    chooseIncomeAndYear('FY2025-26');
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Age on March 31 of selected fiscal year' }), { target: { value: '42' } });
    confirmTaxScenario();

    await waitFor(() => expect(api.compareTax).toHaveBeenCalledTimes(1));
    expect(api.compareTax).toHaveBeenCalledWith(
      300000,
      expect.objectContaining({ age: 42, incomeSource: 'salary', fiscalYear: 'FY2025-26' }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it.each([
    [17, false],
    [18, true],
    [120, true],
    [121, false],
    [18.5, false],
  ])('accepts only whole-number tax ages from 18 through 120 (%s)', async (age, isValid) => {
    await openTaxOptimizer();
    const compare = vi.spyOn(api, 'compareTax').mockImplementation((income, inputs) => (
      Promise.resolve(taxComparison({
        income,
        fiscalYear: inputs.fiscalYear,
        incomeSource: inputs.incomeSource,
        age: inputs.age,
        section80C: inputs.section80C,
        nps80CCD1B: inputs.nps80CCD1B,
      }))
    ));
    chooseIncomeAndYear();
    const ageInput = screen.getByRole('spinbutton', { name: 'Age on March 31 of selected fiscal year' });
    fireEvent.change(ageInput, { target: { value: String(age) } });

    if (isValid) {
      confirmTaxScenario();
      await waitFor(() => expect(compare).toHaveBeenCalledTimes(1));
      expect(compare.mock.calls[0][1].age).toBe(age);
    } else {
      await new Promise(resolve => setTimeout(resolve, 300));
      expect(compare).not.toHaveBeenCalled();
      expect(ageInput).toHaveAttribute('aria-invalid', 'true');
    }
  });

  it('clears the entered age when the selected fiscal year changes and requires it again', async () => {
    await openTaxOptimizer();
    const compare = vi.spyOn(api, 'compareTax').mockImplementation((income, inputs) => Promise.resolve(taxComparison({
      income,
      fiscalYear: inputs.fiscalYear,
      incomeSource: inputs.incomeSource,
      age: inputs.age,
      section80C: inputs.section80C,
      nps80CCD1B: inputs.nps80CCD1B,
    })));
    chooseIncomeAndYear('FY2025-26');
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Age on March 31 of selected fiscal year' }), { target: { value: '42' } });
    confirmTaxScenario();
    await waitFor(() => expect(compare).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText('Tax fiscal year'), { target: { value: 'FY2026-27' } });
    expect(screen.getByRole('spinbutton', { name: 'Age on March 31 of selected fiscal year' })).toHaveValue(null);
    expect(screen.getByRole('status')).toHaveTextContent(/enter a whole-number age/i);

    await new Promise(resolve => setTimeout(resolve, 350));
    expect(compare).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByRole('spinbutton', { name: 'Age on March 31 of selected fiscal year' }), { target: { value: '43' } });
    confirmTaxScenario();
    await waitFor(() => expect(compare).toHaveBeenCalledTimes(2));
    expect(compare).toHaveBeenLastCalledWith(
      300000,
      expect.objectContaining({ age: 43, fiscalYear: 'FY2026-27' }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('clears the age after profile identity or version changes', async () => {
    const firstProfile = { profileId: 'profile-tax-age-4', version: 1, age: 33, name: 'Test User' };
    sessionStorage.setItem('genie_session_binding_fingerprint', profileBindingFingerprint(firstProfile));
    vi.spyOn(api, 'getChatHistory').mockResolvedValue({ conversations: [] });
    vi.spyOn(api, 'getTaxPolicyMetadata').mockResolvedValue({ verifiedFiscalYears: fiscalYears });
    const actionCard = `<<<ACTION_CARD>>>\n${JSON.stringify({ type: 'tax_save', title: 'Open tax helper', subtitle: 'Open', actions: [{ label: 'Open tax helper', target: '/tax' }] })}\n<<<END_ACTION_CARD>>>`;
    vi.spyOn(api, 'sendChatMessage').mockResolvedValue({ response: actionCard, rate_limit_remaining: 29 });
    const view = render(<GenieChat profile={firstProfile} onNavigate={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Genie AI' }));
    const chatInput = await screen.findByRole('textbox', { name: /ask genie/i });
    await waitFor(() => expect(chatInput).toBeEnabled());
    fireEvent.change(chatInput, { target: { value: 'Open the tax helper' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    fireEvent.click(await screen.findByRole('button', { name: /open tax helper/i }, { timeout: 5000 }));
    const ageInput = await screen.findByRole('spinbutton', { name: 'Age on March 31 of selected fiscal year' });
    fireEvent.change(screen.getByLabelText('Tax fiscal year'), { target: { value: 'FY2025-26' } });
    fireEvent.change(ageInput, { target: { value: '45' } });
    expect(ageInput).toHaveValue(45);

    view.rerender(<GenieChat profile={{ ...firstProfile, version: 2 }} onNavigate={vi.fn()} />);
    await waitFor(() => expect(screen.queryByRole('spinbutton', { name: 'Age on March 31 of selected fiscal year' })).not.toBeInTheDocument());
    fireEvent.change(screen.getByRole('textbox', { name: /ask genie/i }), { target: { value: 'Open the tax helper again' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    fireEvent.click(await screen.findByRole('button', { name: /open tax helper/i }, { timeout: 5000 }));
    expect(await screen.findByRole('spinbutton', { name: 'Age on March 31 of selected fiscal year' })).toHaveValue(null);
  });

  it('hides an already resolved comparison immediately when the profile version changes', async () => {
    const profile = { profileId: 'profile-tax-age-resolved', version: 1, age: 37, name: 'Test User' };
    const { view } = await openTaxOptimizer(profile);
    vi.spyOn(api, 'compareTax').mockImplementation((income, inputs) => (
      Promise.resolve(taxComparison({
        income,
        fiscalYear: inputs.fiscalYear,
        incomeSource: inputs.incomeSource,
        age: inputs.age,
        section80C: inputs.section80C,
        nps80CCD1B: inputs.nps80CCD1B,
      }))
    ));
    chooseIncomeAndYear();
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Age on March 31 of selected fiscal year' }), { target: { value: '42' } });
    confirmTaxScenario();
    expect(await screen.findByText('Policy evidence')).toBeInTheDocument();

    view.rerender(<GenieChat profile={{ ...profile, version: 2 }} onNavigate={vi.fn()} />);

    expect(screen.queryByText('Policy evidence')).not.toBeInTheDocument();
  });

  it.each(['income', 'fiscal year', 'age'])('hides a resolved comparison immediately after %s changes', async change => {
    await openTaxOptimizer();
    vi.spyOn(api, 'compareTax').mockImplementation((income, inputs) => (
      Promise.resolve(taxComparison({
        income,
        fiscalYear: inputs.fiscalYear,
        incomeSource: inputs.incomeSource,
        age: inputs.age,
        section80C: inputs.section80C,
        nps80CCD1B: inputs.nps80CCD1B,
      }))
    ));
    chooseIncomeAndYear();
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Age on March 31 of selected fiscal year' }), { target: { value: '42' } });
    confirmTaxScenario();
    expect(await screen.findByText('Policy evidence')).toBeInTheDocument();

    if (change === 'income') {
      fireEvent.change(screen.getAllByRole('slider')[0], { target: { value: '350000' } });
    } else if (change === 'fiscal year') {
      fireEvent.change(screen.getByLabelText('Tax fiscal year'), { target: { value: 'FY2026-27' } });
    } else {
      fireEvent.change(screen.getByRole('spinbutton', { name: 'Age on March 31 of selected fiscal year' }), { target: { value: '43' } });
    }

    expect(screen.queryByText('Policy evidence')).not.toBeInTheDocument();
  });

  it.each([
    ['fiscal year', result => ({ ...result, fiscal_year: 'FY2026-27' })],
    ['income', result => ({ ...result, income: result.income + 1 })],
    ['income source', result => ({ ...result, inputsUsed: { ...result.inputsUsed, incomeSource: 'business' } })],
    ['deduction age', result => ({
      ...result,
      inputsUsed: { ...result.inputsUsed, deductions: { ...result.inputsUsed.deductions, age: 41 } },
    })],
  ])('does not display a tax comparison with a mismatched echoed %s', async (_field, mismatch) => {
    await openTaxOptimizer();
    vi.spyOn(api, 'compareTax').mockImplementation((income, inputs) => (
      Promise.resolve(mismatch(taxComparison({
        income,
        fiscalYear: inputs.fiscalYear,
        incomeSource: inputs.incomeSource,
        age: inputs.age,
        section80C: inputs.section80C,
        nps80CCD1B: inputs.nps80CCD1B,
      })))
    ));
    chooseIncomeAndYear();
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Age on March 31 of selected fiscal year' }), { target: { value: '42' } });
    confirmTaxScenario();

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/tax service unavailable/i));
    expect(screen.queryByText('Policy evidence')).not.toBeInTheDocument();
  });

  it('aborts and ignores an old comparison result after the entered age changes', async () => {
    await openTaxOptimizer();
    const first = deferred();
    const second = deferred();
    const compare = vi.spyOn(api, 'compareTax')
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    chooseIncomeAndYear();
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Age on March 31 of selected fiscal year' }), { target: { value: '41' } });
    confirmTaxScenario();
    await waitFor(() => expect(compare).toHaveBeenCalledTimes(1));
    const oldSignal = compare.mock.calls[0][2].signal;

    fireEvent.change(screen.getByRole('spinbutton', { name: 'Age on March 31 of selected fiscal year' }), { target: { value: '42' } });
    confirmTaxScenario();
    await waitFor(() => expect(compare).toHaveBeenCalledTimes(2));
    expect(oldSignal.aborted).toBe(true);
    await act(async () => { first.resolve(taxComparisonForCall(compare.mock.calls[0])); await first.promise; });
    expect(screen.queryByText('Policy evidence')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/calculating with the authoritative tax service/i);

    await act(async () => { second.resolve(taxComparisonForCall(compare.mock.calls[1])); await second.promise; });
    expect(await screen.findByText('Policy evidence')).toBeInTheDocument();
  });
});
