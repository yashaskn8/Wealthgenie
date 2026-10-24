import{describe,it}from'node:test';
import assert from'node:assert/strict';
import{isApprovedPublicResearchUrl}from'../../extensions/genievoice-browser/publicSourcePolicy.mjs';
describe('GenieVoice browser inspector URL policy',()=>{
  it('accepts only approved public authority HTTPS hosts',()=>{
    for(const url of ['https://rbi.org.in/','https://www.sebi.gov.in/','https://www.indiapost.gov.in/'])
      assert.equal(isApprovedPublicResearchUrl(url),true,url);
  });
  it('rejects credential exfiltration, host confusion and privileged schemes',()=>{
    for(const url of [
      'http://rbi.org.in','https://rbi.org.in.evil.com/',
      'https://evil.com/@rbi.org.in','https://user:pw@sebi.gov.in/',
      'https://sebi.gov.in:444/','file:///etc/passwd',
      'chrome://settings','javascript:alert(1)','https://127.0.0.1',
      'https://example.com?to=https://sebi.gov.in',
      'https://sebi.gov.in@evil.test','https://foo.sebi.gov.in',
      'https://sebi.gov.in/login','https://rbi.org.in/account/',
      'https://www.indiapost.gov.in/transactions','not a url',
      null, 'x'.repeat(2050)
    ])assert.equal(isApprovedPublicResearchUrl(url),false,String(url).slice(0,120));
  });
});
