import {describe,it} from 'node:test';
import assert from 'node:assert/strict';

/**
 * Controlled MV3 API fixture. A second valid origin is still an unauthorized
 * disclosure when it was not the page selected for this inspection.
 * Not a substitute for device-level Chromium permission tests.
 */
describe('GenieVoice browser inspector selection fence',()=>{
  it('never presents content after the active tab changes during injection',async()=>{
    const originalDocument=globalThis.document;
    const originalChrome=globalThis.chrome;
    const elements={
      '#status':{textContent:''},
      '#content':{textContent:''},
      '#inspect':{disabled:false,addEventListener(_event,fn){this.click=fn;}}
    };
    let queries=0;
    globalThis.document={querySelector:selector=>elements[selector]};
    globalThis.chrome={
      tabs:{query:async()=>{
        queries++;
        return [queries===1
          ? {id:17,url:'https://rbi.org.in/public'}
          : {id:18,url:'https://sebi.gov.in/public'}];
      }},
      scripting:{executeScript:async()=>[{result:{
        url:'https://rbi.org.in/public',title:'Official page',
        text:'Should never be published after a tab switch'
      }}]}
    };
    try{
      await import('../../extensions/genievoice-browser/popup.js');
      await elements['#inspect'].click();
      assert.equal(elements['#content'].textContent,'');
      assert.match(elements['#status'].textContent,/Selected page changed/);
      assert.equal(elements['#inspect'].disabled,false);
    }finally{
      if(originalDocument===undefined)delete globalThis.document;
      else globalThis.document=originalDocument;
      if(originalChrome===undefined)delete globalThis.chrome;
      else globalThis.chrome=originalChrome;
    }
  });
});
