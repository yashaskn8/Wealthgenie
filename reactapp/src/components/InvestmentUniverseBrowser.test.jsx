import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { getFinancialUniverse, getFinancialUniverseSummary, getCurrentProfile, getQualifiedFamilyTopProducts, getThreeProductReadyFamilies } = vi.hoisted(() => ({
  getFinancialUniverse: vi.fn(), getFinancialUniverseSummary: vi.fn(),
  getCurrentProfile: vi.fn(), getQualifiedFamilyTopProducts: vi.fn(),
  getThreeProductReadyFamilies: vi.fn(),
}));
vi.mock('../services/api', () => ({ getFinancialUniverse, getFinancialUniverseSummary,
  getCurrentProfile, getQualifiedFamilyTopProducts, getThreeProductReadyFamilies }));
import InvestmentUniverseBrowser from './InvestmentUniverseBrowser';

const catalog = Array.from({ length: 250 }, (_, index) => ({
  id: 'family_' + String(index + 1).padStart(3, '0'),
  name: 'Investment family ' + (index + 1),
  category: index < 155 ? 'Existing catalog' : 'Expanded family',
  subcategory: 'Reference',
  record_kind: 'ARCHETYPE',
  availability: 'UNVERIFIED',
  recommendation_eligible: false,
}));

beforeEach(() => {
  getCurrentProfile.mockResolvedValue({ profileId: '0123456789abcdef01234567' });
  getThreeProductReadyFamilies.mockResolvedValue({status:'THREE_SOURCE_QUALIFIED_CANDIDATES',
    familyIds:['family_001'],count:1});
  getQualifiedFamilyTopProducts.mockResolvedValue({ status: 'NO_QUALIFIED_PRODUCTS', products: [], reasonCode: 'NO_SUITABLE_CURRENTLY_QUALIFIED_PRODUCTS' });
  getFinancialUniverseSummary.mockResolvedValue({status:'DISCOVERY_ONLY',totalCount:250,
    discoveryFamilies:250,actualProducts:0,availableRecords:0,unverifiedRecords:250,qualificationFlagged:0});
  getFinancialUniverse.mockImplementation(({ cursor }) => {
    const offset = cursor ? Number(cursor.slice('after_'.length)) : 0;
    const items = catalog.slice(offset, offset + 100);
    const next = offset + 100 < catalog.length ? 'after_' + (offset + 100) : null;
    return Promise.resolve({ items, nextCursor: next });
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('investment universe browser', () => {
  it('loads all 250 PostgreSQL pages separately from recommendations', async () => {
    render(<InvestmentUniverseBrowser />);
    expect(getFinancialUniverse).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Browse all investment options' }));
    await waitFor(() => expect(screen.getByText('250 catalog entries loaded from PostgreSQL.')).toBeTruthy());
    expect(getFinancialUniverse).toHaveBeenCalledTimes(3);
    expect(getFinancialUniverseSummary).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Discovery total: 250/)).toBeTruthy();
    expect(screen.getByText(/250 matching catalog entries/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Show unqualified discovery families'));
    expect(screen.getByText(/1 matching catalog entries/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Show unqualified discovery families'));
    expect(screen.getByText(/250 matching catalog entries/)).toBeTruthy();
    expect(screen.getByText('Investment family 1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('Investment family 26')).toBeTruthy();
  });

  it('filters categories and never claims discovery entries are recommendations', async () => {
    render(<InvestmentUniverseBrowser />);
    fireEvent.click(screen.getByRole('button', { name: 'Browse all investment options' }));
    await waitFor(() => expect(screen.getByText('250 catalog entries loaded from PostgreSQL.')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Filter investment category'), { target: { value: 'Expanded family' } });
    expect(screen.getByText(/95 matching catalog entries/)).toBeTruthy();
    expect(screen.getAllByText('Discovery family').length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText('Filter investment subcategory'), {target:{value:'Reference'}});
    expect(screen.getByText(/95 matching catalog entries/)).toBeTruthy();
  });

  it('detects a missing database page rather than claiming full catalog coverage', async () => {
    getFinancialUniverseSummary.mockResolvedValueOnce({totalCount:251});
    render(<InvestmentUniverseBrowser />);
    fireEvent.click(screen.getByRole('button', { name: 'Browse all investment options' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Unable to load'));
    expect(screen.queryByText('250 catalog entries loaded from PostgreSQL.')).toBeNull();
  });

  it('shows a visible service failure instead of fabricated 250 options', async () => {
    getFinancialUniverse.mockRejectedValueOnce(new Error('FINANCIAL_UNIVERSE_NOT_ENABLED'));
    render(<InvestmentUniverseBrowser />);
    fireEvent.click(screen.getByRole('button', { name: 'Browse all investment options' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Unable to load'));
    expect(screen.queryByText('250 catalog entries loaded from PostgreSQL.')).toBeNull();
  });
  it('checks real product evidence on demand, never pads a missing top-three list', async () => {
    render(<InvestmentUniverseBrowser />);
    fireEvent.click(screen.getByRole('button', { name: 'Browse all investment options' }));
    await waitFor(() => expect(screen.getByText('250 catalog entries loaded from PostgreSQL.')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Compare verified products for Investment family 1' }));
    await waitFor(() => expect(screen.getByText(/No currently qualified products can be ranked/)).toBeTruthy());
    expect(getQualifiedFamilyTopProducts).toHaveBeenCalledWith('family_001','0123456789abcdef01234567',expect.any(Object));
  });

  it('renders at most three source-backed products and makes issuer evidence accessible', async () => {
    getQualifiedFamilyTopProducts.mockResolvedValueOnce({ status:'AVAILABLE',
      products:[{id:'real-1',name:'Example verified product',matchScore:91,riskLevel:1,
        minimumInvestmentInr:1000,annualFeeBps:15,lockInMonths:0,
        marketFact:{type:'PUBLISHED_RATE',value:6.5,dataClass:'PUBLISHED_RATE',asOf:'2026-10-22T10:00:00Z'},
        evidence:{product:'https://issuer.example/terms',terms:'https://issuer.example/kid'}},
        {id:'real-2',name:'Example verified product two',matchScore:90,riskLevel:1,
         minimumInvestmentInr:1000,annualFeeBps:20,lockInMonths:0,
         marketFact:{type:'PUBLISHED_RATE',value:6.4,dataClass:'PUBLISHED_RATE'},
         evidence:{product:'https://issuer.example/terms2',terms:'https://issuer.example/kid2'}},
        {id:'real-3',name:'Example verified product three',matchScore:89,riskLevel:1,
         minimumInvestmentInr:1000,annualFeeBps:30,lockInMonths:0,
         marketFact:{type:'PUBLISHED_RATE',value:6.3,dataClass:'PUBLISHED_RATE'},
         evidence:{product:'https://issuer.example/terms3',terms:'https://issuer.example/kid3'}}] });
    render(<InvestmentUniverseBrowser />);
    fireEvent.click(screen.getByRole('button', { name: 'Browse all investment options' }));
    await waitFor(() => expect(screen.getByText('250 catalog entries loaded from PostgreSQL.')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Compare verified products for Investment family 1' }));
    await waitFor(() => expect(screen.getByText('Example verified product')).toBeTruthy());
    expect(screen.getAllByRole('link',{name:'Issuer evidence'})).toHaveLength(3);
    expect(screen.getAllByRole('link',{name:'Issuer evidence'})[0].getAttribute('href')).toBe('https://issuer.example/terms');
    expect(screen.getByRole('region',{name:'Verified product comparison'}).textContent).not.toContain('fit ');
  });

  it('rejects malformed or padded product responses instead of displaying unqualified offers', async () => {
    getQualifiedFamilyTopProducts.mockResolvedValueOnce({products:Array.from({length:4},(_,i)=>({id:'p'+i,name:'Unreviewed'}))});
    render(<InvestmentUniverseBrowser />);
    fireEvent.click(screen.getByRole('button', { name: 'Browse all investment options' }));
    await waitFor(() => expect(screen.getByText('250 catalog entries loaded from PostgreSQL.')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Compare verified products for Investment family 1' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('cannot be compared yet'));
    expect(screen.queryByText('Unreviewed')).toBeNull();
  });

});

describe('three-product-only catalog safety',()=>{
 it('does not display unqualified families as selectable investment choices',async()=>{
  getThreeProductReadyFamilies.mockResolvedValueOnce({
   status:'THREE_SOURCE_QUALIFIED_CANDIDATES',familyIds:[],count:0});
  render(<InvestmentUniverseBrowser />);
  fireEvent.click(screen.getByRole('button',{name:'Browse all investment options'}));
  await waitFor(()=>expect(screen.getByText(/No investment family currently has three/)).toBeTruthy());
  expect(screen.getByText('Investment family 1')).toBeTruthy();
  expect(screen.queryByRole('button',{name:'Compare verified products for Investment family 1'})).toBeNull();
  fireEvent.click(screen.getByLabelText('Show unqualified discovery families'));
  expect(screen.queryByText('Investment family 1')).toBeNull();
  fireEvent.click(screen.getByLabelText('Show unqualified discovery families'));
  expect(screen.getByText('Investment family 1')).toBeTruthy();
  expect(screen.queryByRole('button',{name:'Compare verified products for Investment family 1'})).toBeNull();
 });
 it('does not expose an incomplete three-offer API response',async()=>{
  getQualifiedFamilyTopProducts.mockResolvedValueOnce({status:'AVAILABLE',products:[
   {id:'incomplete',name:'Misleading partial recommendation'}]});
  render(<InvestmentUniverseBrowser />);
  fireEvent.click(screen.getByRole('button',{name:'Browse all investment options'}));
  await waitFor(()=>expect(screen.getByText('250 catalog entries loaded from PostgreSQL.')).toBeTruthy());
  fireEvent.click(screen.getByRole('button',{name:'Compare verified products for Investment family 1'}));
  await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('cannot be compared yet'));
  expect(screen.queryByText('Misleading partial recommendation')).toBeNull();
 });
});
