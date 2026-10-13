import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import CalculatorTab from './CalculatorTab';

describe('CalculatorTab financial value handling', () => {
  it('does not enable exports when the projection API explicitly returns null values', () => {
    render(
      <CalculatorTab
        inv={{ id: 'fund:test', name: 'Test Fund', category: 'Mutual Fund' }}
        calcAmount={5000}
        setCalcAmount={vi.fn()}
        calcYears={10}
        setCalcYears={vi.fn()}
        calcReturn={8}
        setCalcReturn={vi.fn()}
        calcBounds={{
          returnBoundsBasis: 'GENERIC_WHAT_IF',
          returnMin: 1,
          returnMax: 30,
          yearMin: 1,
          yearMax: 40,
          yearBoundsBasis: 'GENERIC_WHAT_IF',
        }}
        inflationRate={6}
        setInflationRate={vi.fn()}
        projection={{
          investmentMaturity: null,
          totalInvested: null,
          estimatedReturns: null,
          investmentReal: null,
          yearlyBreakdown: [],
        }}
        projectionError={null}
        projectionLoading={false}
      />,
    );

    expect(screen.getByRole('button', { name: 'Save Goal Report' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Copy Summary' })).toBeDisabled();
  });
});
