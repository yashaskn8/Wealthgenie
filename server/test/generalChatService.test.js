import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateGeneralChatAnswer,
  isGeneralChatQuestion,
  generalChatTokenUpperBound,
} from '../services/generalChatService.js';

test('general chat routes everyday questions without relabeling finance as unsourced general advice', () => {
  for (const q of ['Hello Genie!', 'Explain Python list comprehensions', 'Write a story about a lighthouse',
    'Translate good morning into Hindi', 'Who wrote Hamlet?', 'Explain the previous code example']) {
    assert.equal(isGeneralChatQuestion(q), true, q);
  }
  for (const q of ['What is a mutual fund?', 'What is compound interest?', 'What tax do I owe?',
    'Recommend an investment for my portfolio', 'What is liquidity risk?',
    'Which banking product offers the best return?', 'Calculate my budget',
    'How should I invest in NIFTY?', 'Explain capital gains and deductions',
    'Explain my age evidence.', 'How old am I?', 'What is my email?']) {
    assert.equal(isGeneralChatQuestion(q), false, q);
  }
  assert.equal(generalChatTokenUpperBound('Hello', [{ role: 'user', content: 'Prior question' }])
    > generalChatTokenUpperBound('Hello'), true);
});

test('general questions call Groq first, NVIDIA second on a retryable outage, with no sources or financial profile', async () => {
  const calls = [];
  const reservations = [];
  const settlements = [];
  const providers = [
    {
      name: 'groq',
      isConfigured: () => true,
      lastFailureReason: null,
      async generate(request) {
        calls.push({ provider: 'groq', request });
        this.lastFailureReason = 'PROVIDER_NETWORK_ERROR';
        return null;
      },
    },
    {
      name: 'nvidia_nim',
      isConfigured: () => true,
      async generate(request) {
        calls.push({ provider: 'nvidia_nim', request });
        return { provider: 'nvidia_nim', model: 'test-nvidia-model', text: 'A Python list is mutable.',
          wasCompleted: true, tokensUsed: 42 };
      },
    },
  ];
  const answer = await generateGeneralChatAnswer({
    question: 'What is a Python list?', priorTurns: [
      { role: 'user', content: 'Explain programming' },
      { role: 'model', content: 'Programming gives computers instructions.' },
    ],
  }, {
    providers,
    beforeProviderAttempt: async () => true,
    reserveProviderAttempt: async ({ providerAttemptCount }) => {
      const reservation = { id: providerAttemptCount };
      reservations.push(reservation);
      return reservation;
    },
    settleProviderAttempt: async ({ reservation, actualTokens }) => {
      settlements.push({ reservation, actualTokens });
      return { settled: true };
    },
  });
  assert.deepEqual(calls.map(c => c.provider), ['groq', 'nvidia_nim']);
  assert.equal(answer.provider, 'NVIDIA_NIM');
  assert.equal(answer.fallback, true);
  assert.equal(answer.grounded, false);
  assert.equal(answer.validation.status, 'UNVERIFIED_GENERAL_CHAT');
  assert.deepEqual(answer.citations, []);
  assert.deepEqual(answer.evidenceIdsUsed, []);
  assert.equal(answer.providerAttemptCount, 2);
  assert.equal(answer.providerAttemptFailureCount, 1);
  assert.equal(answer.tokensUsed, 42);
  assert.equal(answer.providerUsageComplete, false);
  assert.equal(reservations.length, 2);
  assert.deepEqual(settlements.map(s => s.actualTokens), [null, 42]);
  assert.ok(calls.every(call => call.request.jsonMode === false
    && call.request.tools === null
    && !JSON.stringify(call.request).includes('riskTolerance')
    && !JSON.stringify(call.request).includes('financialProfile')
    && !JSON.stringify(call.request).includes('E_PROFILE_')));
  assert.equal(calls[1].request.recentHistory.length, 3);
});

test('rate limit, safety refusal and nonretryable failures never cause NVIDIA failover', async () => {
  for (const failure of ['PROVIDER_RATE_LIMITED', 'PROVIDER_AUTHENTICATION_FAILED',
    'PROVIDER_SAFETY_REJECTION', 'PROVIDER_BAD_REQUEST']) {
    let secondaryCalled = false;
    const result = await generateGeneralChatAnswer({ question: 'Explain a greeting.' }, {
      providers: [
        { name: 'groq', isConfigured: () => true, lastFailureReason: failure,
          async generate() { return null; } },
        { name: 'nvidia_nim', isConfigured: () => true,
          async generate() { secondaryCalled = true; return { text: 'unverified' }; } },
      ],
    });
    assert.equal(secondaryCalled, false, failure);
    assert.equal(result.provider, 'SYSTEM');
    assert.deepEqual(result.citations, []);
  }
});

test('unavailable providers or budget exhaustion return unsourced unavailability, not fabricated citations', async () => {
  const unavailable = await generateGeneralChatAnswer({ question: 'Tell me a story.' }, {
    providers: [
      { name: 'groq', isConfigured: () => false },
      { name: 'nvidia_nim', isConfigured: () => false },
    ],
  });
  assert.equal(unavailable.grounded, false);
  assert.equal(unavailable.provider, 'SYSTEM');
  assert.match(unavailable.text, /unavailable/i);
  assert.deepEqual(unavailable.citations, []);

  let called = false;
  const noBudget = await generateGeneralChatAnswer({ question: 'Tell me a story.' }, {
    providers: [{ name: 'groq', isConfigured: () => true, async generate() {
      called = true;
      return { text: 'Should not be called' };
    } }],
    beforeProviderAttempt: async () => false,
  });
  assert.equal(called, false);
  assert.equal(noBudget.provider, 'SYSTEM');
  assert.ok(noBudget.validation.reasonCodes.includes('PROVIDER_BUDGET_EXHAUSTED'));
});

test('no tools, schema bypass or invented citations are sent to general providers', async () => {
  const provider = {
    name: 'groq', isConfigured: () => true,
    async generate(request) {
      assert.equal(request.jsonMode, false);
      assert.equal(request.tools, null);
      assert.doesNotMatch(request.systemPrompt, /api[_ -]?key\s*=/i);
      return { provider: 'groq', model: 'mock-general', text: 'I can help with that.',
        wasCompleted: true, tokensUsed: 13 };
    },
  };
  const answer = await generateGeneralChatAnswer({ question: 'Hello!' }, { providers: [provider] });
  assert.equal(answer.provider, 'GROQ');
  assert.equal(answer.fallback, false);
  assert.equal(answer.validation.status, 'UNVERIFIED_GENERAL_CHAT');
  assert.deepEqual(answer.citations, []);
});


test('general red-team: coding array indices are not fabricated citations', async () => {
  const codingExample = 'Example:\nconst values = [1, 2, 3];\nconsole.log(values[0]);';
  const reply = await generateGeneralChatAnswer({ question: 'Explain JavaScript array indexing' }, {
    providers: [{
      name: 'groq', isConfigured: () => true,
      async generate() { return { provider: 'groq', text: codingExample,
        tokensUsed: 24, wasCompleted: true }; },
    }],
  });
  assert.equal(reply.provider, 'GROQ');
  assert.equal(reply.text, codingExample);
  assert.deepEqual(reply.citations, []);
  assert.equal(reply.validation.status, 'UNVERIFIED_GENERAL_CHAT');
});

test('general red-team: fabricated source reference still fails closed', async () => {
  for (const fake of ['According to source [1], this is proven.',
    'This is verified. [E_FAKE_EVIDENCE]', 'Visit https://unverified.example/a']) {
    const reply = await generateGeneralChatAnswer({ question: 'Tell me something.' }, {
      providers: [{ name: 'groq', isConfigured: () => true,
        async generate() { return { provider: 'groq', text: fake,
          tokensUsed: 20, wasCompleted: true }; } }],
    });
    assert.equal(reply.provider, 'SYSTEM', fake);
    assert.deepEqual(reply.citations, [], fake);
    assert.match(reply.text, /unavailable/i, fake);
  }
});


test('red-team: PAN, Aadhaar, UPI PIN and personal identity facts are never unsourced general chat', () => {
  for (const q of [
    'What is my PAN number?',
    'Tell me my Aadhaar number',
    'What is my UPI PIN?',
    'What is my IFSC code?',
    'What is my KYC status?',
    'What is my date of birth?',
  ]) {
    assert.equal(isGeneralChatQuestion(q), false, q);
  }
  assert.equal(isGeneralChatQuestion('Explain how a Python for loop works'), true);
});
