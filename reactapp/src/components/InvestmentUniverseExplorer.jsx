import React, {useCallback,useEffect,useState} from 'react';
import {getFinancialUniverse,getFinancialUniverseCategories} from '../services/api';

/**
 * Read-only discovery. The source catalogue never becomes a personalized,
 * purchasable, priced, or tax-qualified recommendation by being displayed.
 */
export default function InvestmentUniverseExplorer() {
  const [open,setOpen]=useState(false);
  const [category,setCategory]=useState('');
  const [categories,setCategories]=useState([]);
  const [items,setItems]=useState([]);
  const [cursor,setCursor]=useState(null);
  const [loading,setLoading]=useState(false);
  const [status,setStatus]=useState('NOT_REQUESTED');
  const [revision,setRevision]=useState(0);

  useEffect(()=>{
    if(!open)return undefined;
    const controller=new AbortController();
    getFinancialUniverseCategories({signal:controller.signal}).then(result=>{
      if(!controller.signal.aborted && result?.status==='DISCOVERY_ONLY'){
        setCategories(Array.isArray(result.categories)?result.categories:[]);
      }
    }).catch(()=>{if(!controller.signal.aborted)setStatus('UNAVAILABLE');});
    return ()=>controller.abort();
  },[open]);

  useEffect(()=>{
    if(!open)return undefined;
    const controller=new AbortController();
    setLoading(true);
    setItems([]);
    setCursor(null);
    getFinancialUniverse({category:category||undefined,limit:20},{signal:controller.signal})
      .then(result=>{
        if(controller.signal.aborted)return;
        if(!Array.isArray(result?.items)){setStatus('UNAVAILABLE');return;}
        setItems(result.items);
        setCursor(result.nextCursor||null);
        setStatus('AVAILABLE');
      }).catch(()=>{if(!controller.signal.aborted)setStatus('UNAVAILABLE');})
      .finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return ()=>controller.abort();
  },[open,category,revision]);

  const loadMore=useCallback(async()=>{
    if(!cursor||loading)return;
    setLoading(true);
    try{
      const result=await getFinancialUniverse({category:category||undefined,cursor,limit:20});
      if(!Array.isArray(result?.items))throw new Error('Catalog unavailable');
      setItems(current=>[...current,...result.items]);
      setCursor(result.nextCursor||null);
    }catch{setStatus('UNAVAILABLE');}
    finally{setLoading(false);}
  },[cursor,loading,category]);

  return (
    <section className="wti-universe" aria-label="Independent Indian investment discovery directory">
      <button type="button" className="wti-universe-toggle" aria-expanded={open}
        onClick={()=>setOpen(value=>!value)}>
        {open?'Hide investment directory':'Explore the complete investment directory'}
      </button>
      {open && (
        <div className="wti-universe-content">
          <h2>Indian investment discovery universe</h2>
          <p>Reference categories and strategies—not 250 currently purchasable products. Exact schemes, current quotes and personalized after-tax returns require separate verification.</p>
          {categories.length>0 && (
            <label className="wti-universe-filter">
              Category
              <select value={category} onChange={event=>setCategory(event.target.value)}>
                <option value="">All categories</option>
                {categories.map(item=>(
                  <option value={item.id} key={item.id}>{item.label} ({item.archetype_count})</option>
                ))}
              </select>
            </label>
          )}
          {status==='UNAVAILABLE' && (
            <p role="status">The verified investment directory is unavailable. No example products or prices have been substituted.</p>
          )}
          {status==='AVAILABLE' && (
            <>
              <ul className="wti-universe-list">
                {items.map(item=>(
                  <li key={item.id}>
                    <div>
                      <strong>{item.name}</strong>
                      <small>{item.category}{item.subcategory?' · '+item.subcategory:''}</small>
                    </div>
                    <span className="wti-universe-status">Discovery only · {item.availability||'UNVERIFIED'}</span>
                    {item.discovery_reference_url && (
                      <a href={item.discovery_reference_url} target="_blank" rel="noopener noreferrer">
                        Official family reference
                      </a>
                    )}
                  </li>
                ))}
              </ul>
              {cursor && (
                <button type="button" onClick={loadMore} disabled={loading}
                  className="wti-universe-more">
                  {loading?'Loading…':'Load more categories'}
                </button>
              )}
              {!items.length && <p>No entries were returned for this category.</p>}
            </>
          )}
          {status!=='AVAILABLE' && (
            <button type="button" className="wti-universe-more" onClick={()=>setRevision(x=>x+1)}
              disabled={loading}>{loading?'Loading directory…':'Retry directory'}</button>
          )}
        </div>
      )}
    </section>
  );
}
