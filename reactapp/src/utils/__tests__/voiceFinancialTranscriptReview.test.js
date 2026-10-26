import { describe, expect, it } from 'vitest';
import { needsFinancialTranscriptReview } from '../voiceFinancialTranscriptReview';

describe('Financial voice ASR value-confirmation boundary', () => {
  it('requires review for spoken financial amounts and percentages', () => {
    for (const question of [
      'What if I invest ₹15000 in SIP every month at 8% annual return?',
      'If my portfolio loses twenty percent what happens?',
      'How much will my retirement fund be worth in ten years?',
      'मेरा सिप ₹१५,००० और ८% रिटर्न हो तो?',
      'ಒಂದು ವೇಳೆ ₹೧೫೦೦೦ ಎಸ್‌ಐಪಿ ೧೦ ವರ್ಷ ಆಗಿದ್ದರೆ?',
      'What is my tax for INR 50,000?',
      'Can we project savings after 5 years?',
      'Should I invest forty percent of my salary?',
      'How much will my EMI be at seventy percent interest?',
      'What if I deposit twenty five rupees?',
      'What if I invest seventy-five?',
      'क्या मैं पचास प्रतिशत बचत करूं?',
      'ನಾನು ನಲವತ್ತು ರೂಪಾಯಿ ಉಳಿಸಿದರೆ ಏನು?',
      'Tell me whether ₹50000 is more than ₹15000?',
      'Can you explain 50000 versus 15000?',

      'What if I save ₹15000 every month?',
    ]) expect(needsFinancialTranscriptReview(question), question).toBe(true);
  });
  it('keeps low-risk conversational questions fast, without confirmation friction', () => {
    for (const question of [
      'Explain SIP', 'What is diversification?', 'Hello Genie',
      'सिप क्या है?', 'ಸಿಪ್ ಎಂದರೇನು?', 'Tell me a joke',
    ]) expect(needsFinancialTranscriptReview(question), question).toBe(false);
  });
  it('never authorizes malformed or invisible transcripts', () => {
    for (const question of [null, {}, [], '', 'x'.repeat(1001),
      '₹5000 SIP\nfor 10 years', 'open\u200C goals for ₹5000 SIP']) {
      expect(needsFinancialTranscriptReview(question)).toBe(false);
    }
  });
});
