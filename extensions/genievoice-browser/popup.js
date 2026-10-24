import {isApprovedPublicResearchUrl} from './publicSourcePolicy.mjs';
const status=document.querySelector('#status');
const content=document.querySelector('#content');
const btn=document.querySelector('#inspect');
const setStatus=(message)=>{status.textContent=message;};
btn.addEventListener('click',async()=>{
  btn.disabled=true;
  content.textContent='';
  setStatus('Checking the selected tab…');
  try{
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
    if(!tab?.id||!isApprovedPublicResearchUrl(tab.url)){
      setStatus('Only specifically allowlisted, public HTTPS financial-authority pages can be inspected.');
      return;
    }
    // The injected function independently rechecks the origin after navigation.
    // Page text is untrusted DATA and is displayed locally, never sent to a model.
    const [{result}]=await chrome.scripting.executeScript({
      target:{tabId:tab.id},func:()=>{
        const host=location.hostname.toLowerCase();
        const allowed=['rbi.org.in','www.rbi.org.in','sebi.gov.in',
          'www.sebi.gov.in','indiapost.gov.in','www.indiapost.gov.in'];
        const blocked=/(?:^|\/)(?:login|signin|sign-in|auth|account|accounts|myaccount|profile|dashboard|payment|payments|kyc|transaction|transactions|portfolio|admin)(?:\/|$)/i;
        if(location.protocol!=='https:'||!allowed.includes(host) ||
           blocked.test(decodeURIComponent(location.pathname)))return null;
        const text=String(document.body?.innerText||'').slice(0,3000);
        return {url:location.origin+location.pathname,title:document.title.slice(0,160),text};
      }
    });
    if(!result||!isApprovedPublicResearchUrl(result.url)){
      setStatus('Page changed or is not approved. No content was inspected.');
      return;
    }
    setStatus('Local read-only preview; verify source dates and usage rights.');
    content.textContent=result.title+'\n'+result.url+'\n\n'+result.text;
  }catch{
    setStatus('Inspection failed or tab access expired. Reopen the extension on an approved tab.');
  }finally{btn.disabled=false;}
});
