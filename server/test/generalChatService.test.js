import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyGenieChatQuestion,
} from '../services/chatQuestionRouting.js';
import {
  generateGeneralChat, getGeneralChatTokenUpperBound,
} from '../services/generalChatService.js';

test('everyday questions route to the uncited model lane; finance and account facts stay grounded', () => {
  const general = [
    'Explain Python decorators with a short example.',
    'Write a professional email.',
    'Translate hello to Kannada.',
    'What is the capital of France?',
    'Can you help me prepare for an interview?',
  ];
  for (const q of general) assert.equal(classifyGenieChatQuestion(q), 'GENERAL_UNCITED', q);
  const financial = [
    'What is my portfolio return?',
    'Which fixed deposit should I buy?',
    'What is the current NAV?',
    'Is NIFTY going up tomorrow?',
    'Calculate income tax on my salary.',
    'How should I rebalance my investments?',
    'Explain WealthGenie tax optimizer.',
    'What is my account balance?',
    'What are the top three mutual funds?',
    'What does SEBI say about these investments?',
  ];
  for (const q of financial) assert.equal(classifyGenieChatQuestion(q), 'FINANCIAL_GROUNDED', q);
});

test('a normal question uses Groq without claiming RAG evidence or passing profile data', async () => {
  let received;
  const answer = await generateGeneralChat({
    question: 'Explain JavaScript closures in simple terms.',
    priorTurns: [
      { role: 'user', content: 'What is my portfolio return?' },
      { role: 'model', content: 'My savings are INR 50000 per month' },
      { role: 'user', content: 'What is lexical scope?' },
    ],
  }, {
    providers: [{
      name: 'groq',
      isConfigured: () => true,
      async generate(input) {
        received = input;
        return {
          provider: 'groq', model: 'test-groq', wasCompleted: true,
          text: 'A closure retains access to variables from its enclosing scope.',
          tokensUsed: 35, tool_calls: [],
        };
      },
    }],
  });
  assert.equal(answer.provider, 'GROQ');
  assert.equal(answer.validation.status, 'GENERAL_UNCITED');
  assert.equal(answer.evidenceHash, null);
  assert.deepEqual(answer.evidenceIdsUsed, []);
  assert.deepEqual(answer.citations, []);
  assert.equal(answer.fallback, false);
  assert.equal(answer.tokensUsed, 35);
  assert.equal(received.tools, null);
  assert.equal(received.jsonMode, false);
  assert.equal(received.recentHistory.at(-1).parts[0].text, 'Explain JavaScript closures in simple terms.');
  assert.equal(JSON.stringify(received).includes('INR 50000'), false);
  assert.equal(JSON.stringify(received).includes('portfolio return'), false);
  assert.ok(getGeneralChatTokenUpperBound({ question: 'Explain closures' }) > 1200);
});

test('Groq transient failure fails over to NVIDIA with explicit quota admission and settlement', async () => {
  const calls = [];
  const settlements = [];
  const result = await generateGeneralChat({ question: 'What is recursion?' }, {
    providers: [
      {
        name: 'groq', isConfigured: () => true,
        async generate() {
          calls.push('groq');
          return { text: '', wasCompleted: false, tokensUsed: 9 };
        },
      },
      {
        name: 'nvidia_nim', isConfigured: () => true,
        async generate() {
          calls.push('nvidia_nim');
          return { text: 'Recursion is when a function calls itself.', wasCompleted: true,
            tokensUsed: 14, model: 'test-nim', tool_calls: [] };
        },
      },
    ],
    beforeProviderAttempt: async () => true,
    reserveProviderAttempt: async ({ providerAttemptCount }) => ({ id: providerAttemptCount }),
    settleProviderAttempt: async ({ reservation, actualTokens }) => {
      settlements.push({ reservation, actualTokens });
      return { settled: true };
    },
  });
  assert.deepEqual(calls, ['groq', 'nvidia_nim']);
  assert.deepEqual(settlements.map(x => x.actualTokens), [9, 14]);
  assert.equal(result.provider, 'NVIDIA_NIM');
  assert.equal(result.providerAttemptCount, 2);
  assert.equal(result.providerAttemptFailureCount, 1);
  assert.equal(result.fallback, true);
  assert.equal(result.tokensUsed, 23);
  assert.equal(result.providerUsageComplete, true);
});

test('a second provider call cannot bypass durable quota reservations', async () => {
  let attempts = 0;
  const result = await generateGeneralChat({ question: 'Explain recursion.' }, {
    providers: [
      { name: 'groq', isConfigured: () => true, async generate() { attempts += 1; return null; } },
      { name: 'nvidia_nim', isConfigured: () => true, async generate() { attempts += 1; throw Error('should not call'); } },
    ],
    beforeProviderAttempt: async () => true,
  });
  assert.equal(attempts, 1);
  assert.equal(result.provider, 'SYSTEM');
  assert.equal(result.fallback, true);
  assert.deepEqual(result.citations, []);
});

test('finance is denied in general chat even when called directly', async () => {
  let calls = 0;
  await assert.rejects(generateGeneralChat({ question: 'Recommend an equity investment for my profile' }, {
    providers: [{ name: 'groq', isConfigured: () => true, async generate() { calls += 1; } }],
  }), error => error.code === 'GENERAL_CHAT_FINANCIAL_ROUTE_DENIED');
  assert.equal(calls, 0);
});

test('general chatbot refuses to treat tool calls as conversational answers', async () => {
  const result = await generateGeneralChat({ question: 'Explain recursion.' }, {
    providers: [{
      name: 'groq', isConfigured: () => true,
      async generate() {
        return { text: 'Calling tool.', tool_calls: [{ tool: 'run_code', arguments: {} }],
          wasCompleted: true, tokensUsed: 12 };
      },
    }],
  });
  assert.equal(result.provider, 'SYSTEM');
  assert.equal(result.validation.status, 'GENERAL_UNCITED');
  assert.deepEqual(result.citations, []);
});

test('unknown or absent credentials never cause a network request', async () => {
  let calls = 0;
  const result = await generateGeneralChat({ question: 'Hello!' }, {
    providers: [{
      name: 'groq', isConfigured: () => false,
      async generate() { calls += 1; },
    }],
  });
  assert.equal(calls, 0);
  assert.equal(result.provider, 'SYSTEM');
  assert.deepEqual(result.citations, []);
});


test('NVIDIA is correctly identified as fallback when Groq has no credentials', async () => {
  let nvidiaCalls = 0;
  const result = await generateGeneralChat({ question: 'Explain binary search.' }, {
    providers: [
      { name: 'groq', isConfigured: () => false, async generate() { throw Error('must not call'); } },
      { name: 'nvidia_nim', isConfigured: () => true, async generate() {
        nvidiaCalls += 1;
        return { text: 'Binary search repeatedly halves a sorted search interval.',
          provider: 'nvidia_nim', model: 'test-nim', tokensUsed: 16, wasCompleted: true, tool_calls: [] };
      } },
    ],
  });
  assert.equal(nvidiaCalls, 1);
  assert.equal(result.provider, 'NVIDIA_NIM');
  assert.equal(result.fallback, true);
  assert.equal(result.providerAttemptCount, 1);
  assert.deepEqual(result.citations, []);
});
