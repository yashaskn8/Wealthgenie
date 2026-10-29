import React from 'react';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const api=vi.hoisted(()=>({
 getCurrentProfile:vi.fn(),getFinancialDiscoveryDirectory:vi.fn(),
 getQualifiedFamilyTopProducts:vi.fn(),getThreeProductReadyFamilies:vi.fn(),
}));
vi.mock('../../services/api',()=>api);
let Explorer;
beforeAll(async()=>{
 vi.stubEnv('VITE_FINANCIAL_POSTGRES_ENABLED','false');
 ({default:Explorer}=await import('../InvestmentUniverseExplorer.jsx'));
 api.getFinancialDiscoveryDirectory.mockResolvedValue({
  status:'DISCOVERY_ONLY',source:'WEALTHGENIE_CATALOG_155_PLUS_95',totalCount:250,
  items:Array.from({length:250},(_,i)=>({
    id:'family_'+i,name:'Investment family '+(i+1),
    category:i<155?'Legacy':'Expanded',origin:i<155?'LEGACY_155':'EXTENDED_95',
    record_kind:'ARCHETYPE',recommendationEligible:false,
    productAvailability:'NOT_VERIFIED',dataRights:'NOT_VERIFIED',
    productData:{currentPrice:null,latestNav:null,currentInterestRate:null},
  })),
 });
});
afterAll(()=>vi.unstubAllEnvs());

it('shows all 250 educational families while PostgreSQL recommendation feature is off',async()=>{
 render(<Explorer/>);
 await waitFor(()=>expect(screen.getByText('Investment family 250')).toBeTruthy());
 expect(screen.getByText('250 matching options')).toBeTruthy();
 fireEvent.change(screen.getByLabelText('Filter catalog research group'),{
   target:{value:'EXTENDED_95'},
 });
 expect(screen.getByText('95 matching options')).toBeTruthy();
 expect(screen.getByText('Investment family 250')).toBeTruthy();
 expect(screen.queryByText('Investment family 1')).toBeNull();
 expect(screen.getByText(/Financial-profile category screening is currently unavailable/)).toBeTruthy();
 fireEvent.change(screen.getByLabelText('Filter catalog research group'),{
   target:{value:'ALL'},
 });
 fireEvent.click(screen.getByRole('button',{name:'Check tailored top 3 for Investment family 1'}));
 expect(screen.getByText(/Current market price \/ NAV \/ interest rate/)).toBeTruthy();
 expect(screen.getByText(/CURRENT_PRODUCT_COMPARISON_SOURCE_UNAVAILABLE/)).toBeTruthy();
 expect(api.getThreeProductReadyFamilies).not.toHaveBeenCalled();
 expect(api.getQualifiedFamilyTopProducts).not.toHaveBeenCalled();
 expect(api.getCurrentProfile).not.toHaveBeenCalled();
});
