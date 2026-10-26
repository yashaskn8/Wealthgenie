import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MessageBubble } from '../GenieChatSubcomponents';

afterEach(()=>{cleanup();vi.restoreAllMocks();});

const base={
  role:'assistant',
  content:'Here is your hypothetical savings comparison.',
  timestamp:'2026-10-26T00:00:00.000Z',
  grounded:true,
  validation_status:'PASS',
  evidence_ids_used:['E_PROFILE_RISK'],
  citations:[],
  _streamed:true,
};
const card={
  version:'genie-feature-card-v1',
  kind:'FEATURE_NAVIGATION_SUGGESTION',
  page:'goals',
  tab:null,
  label:'Source-provided label',
  description:'A description',
  requiresUserClick:true,
};

describe('Genie feature cards',()=>{
  it('shows a feature but never navigates until explicitly clicked',()=>{
    const onFeatureOpen=vi.fn();
    render(<MessageBubble msg={{...base,action_cards:[card]}}
      isLatest={false} onFeatureOpen={onFeatureOpen}/>);
    expect(screen.getByText('Suggested WealthGenie tool')).toBeInTheDocument();
    expect(onFeatureOpen).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button',{name:'Explore Goal Planner'}));
    expect(onFeatureOpen).toHaveBeenCalledTimes(1);
    expect(onFeatureOpen).toHaveBeenCalledWith({
      page:'goals',tab:null,label:'Explore Goal Planner'
    });
  });
  it('will not render a non-canonical suggestion button',()=>{
    render(<MessageBubble msg={{...base,action_cards:[{...card,page:'unknown'}]}}
      isLatest={false} onFeatureOpen={vi.fn()}/>);
    expect(screen.queryByText('Suggested WealthGenie tool')).not.toBeInTheDocument();
  });
});
