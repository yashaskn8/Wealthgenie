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
    'What is diversification?', 'How does rebalancing work?',
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

test('safety refusals and nonretryable client failures never cause NVIDIA failover', async () => {
  for (const failure of ['PROVIDER_SAFETY_REJECTION', 'PROVIDER_BAD_REQUEST']) {
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


test('red-team: rate-limit and expired Groq credential switch to NVIDIA but safety refusal never does', async () => {
  for (const failure of ['PROVIDER_RATE_LIMITED', 'PROVIDER_AUTHENTICATION_FAILED']) {
    let secondaryCalls = 0;
    const answer = await generateGeneralChatAnswer({ question: 'Explain Python decorators.' }, {
      providers: [
        { name: 'groq', isConfigured: () => true, lastFailureReason: failure,
          async generate() { return null; } },
        { name: 'nvidia_nim', isConfigured: () => true,
          async generate() { secondaryCalls += 1; return {
            provider: 'nvidia_nim', text: 'A decorator wraps a callable.',
            tokensUsed: 17, wasCompleted: true,
          }; } },
      ],
    });
    assert.equal(secondaryCalls, 1, failure);
    assert.equal(answer.provider, 'NVIDIA_NIM', failure);
    assert.equal(answer.fallback, true, failure);
    assert.deepEqual(answer.validation.reasonCodes, ['PRIMARY_PROVIDER_UNAVAILABLE']);
    assert.deepEqual(answer.citations, [], failure);
    assert.equal(answer.providerAttemptCount, 2, failure);
    assert.equal(answer.providerAttemptFailureCount, 1, failure);
  }
});

test('red-team: an unconfigured primary is recorded as a fallback when the second provider succeeds', async () => {
  const answer = await generateGeneralChatAnswer({ question: 'Explain Python decorators.' }, {
    providers: [
      { name: 'groq', isConfigured: () => false },
      { name: 'nvidia_nim', isConfigured: () => true,
        async generate() { return { provider: 'nvidia_nim',
          text: 'A decorator wraps a function.', tokensUsed: 12, wasCompleted: true }; } },
    ],
  });
  assert.equal(answer.provider, 'NVIDIA_NIM');
  assert.equal(answer.fallback, true);
  assert.deepEqual(answer.validation.reasonCodes, ['PRIMARY_PROVIDER_UNAVAILABLE']);
  assert.deepEqual(answer.citations, []);
  assert.equal(answer.providerAttemptCount, 1);
  assert.equal(answer.providerAttemptFailureCount, 0);
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


test('red-team: unsourced general routing refuses digital gold and Indian financial products', () => {
  for (const question of [
    'Should I buy digital gold?', 'What is XIRR?', 'Explain CAGR on my corpus',
    'How do POMIS and KVP work?', 'PMS vs AIF for HNIs?',
    'What are REITs and InvITs?', 'What is a ULIP?',
    'How does SWP work?', 'What is P/E ratio?',
    'Should I hold sovereign gold?', 'Does KYC require PAN?',
  ]) assert.equal(isGeneralChatQuestion(question), false, question);
  for (const question of [
    'What is gold used for in electronics?', 'How to bake a wedding cake?',
    'Explain Python decorators.', 'Write a job application email.',
  ]) assert.equal(isGeneralChatQuestion(question), true, question);
});


test('red-team: general provider-issued tool/function calls are discarded, never shown as answers', async () => {
  let secondProviderCalls = 0;
  for (const toolFixture of [
    { tool_calls: [{ function: { name: 'transfer_funds' } }] },
    { toolCalls: [{ function: { name: 'get_profile' } }] },
    { function_call: { name: 'steal_token' } },
  ]) {
    const answer = await generateGeneralChatAnswer({ question: 'Explain Python arrays' }, {
      providers: [
        { name: 'groq', isConfigured: () => true, async generate() {
          return { text: 'Use this unverified instruction.', wasCompleted: true,
            tokensUsed: 5, ...toolFixture };
        } },
        { name: 'nvidia_nim', isConfigured: () => true, async generate() {
          secondProviderCalls += 1; return { text: 'never called' };
        } },
      ],
    });
    assert.equal(answer.provider, 'SYSTEM');
    assert.equal(answer.fallback, true);
    assert.ok(answer.validation.reasonCodes.includes('GENERAL_UNEXPECTED_TOOL_CALL'));
    assert.deepEqual(answer.citations, []);
  }
  assert.equal(secondProviderCalls, 0);
});

test('red-team: general model never receives injected financial prior-history rows', async () => {
  let history = null;
  const answer = await generateGeneralChatAnswer({
    question: 'Explain recursion',
    priorTurns: [
      { role: 'user', content: 'Tell me about Python arrays' },
      { role: 'model', content: 'Arrays are collections of elements.' },
      { role: 'user', content: 'My portfolio return is 10%' },
      { role: 'model', content: 'Your bank account has 5 lakh' },
    ],
  }, {
    providers: [{ name: 'groq', isConfigured: () => true, async generate(request) {
      history = request.recentHistory;
      return { provider: 'groq', text: 'Recursion means self-reference.',
        wasCompleted: true, tokensUsed: 8 };
    } }],
  });
  assert.equal(answer.provider, 'GROQ');
  assert.equal(answer.validation.status, 'UNVERIFIED_GENERAL_CHAT');
  assert.equal(history.length, 3);
  assert.equal(JSON.stringify(history).includes('portfolio return'), false);
  assert.equal(JSON.stringify(history).includes('bank account'), false);
});


test('red-team: uncited direct provider calls cannot bypass finance evidence requirements', async () => {
  let providerCalls = 0;
  for (const question of [
    'Should I buy digital gold?', 'What is my XIRR?',
    'Suggest a REIT for my portfolio', 'How does POMIS work?',
  ]) {
    await assert.rejects(generateGeneralChatAnswer({ question }, {
      providers: [{ name: 'groq', isConfigured: () => true, async generate() {
        providerCalls += 1; return { text: 'Unverified recommendation', wasCompleted: true };
      } }],
    }), error => error.code === 'GENERAL_CHAT_FINANCIAL_ROUTE_DENIED', question);
  }
  assert.equal(providerCalls, 0);
});
