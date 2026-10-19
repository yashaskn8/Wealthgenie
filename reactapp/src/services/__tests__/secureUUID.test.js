import { describe, expect, it, vi } from 'vitest';
import { generateUUID } from '../api';

describe('secure API request identity generation', () => {
  it('uses native crypto.randomUUID when available', () => {
    const native = vi.fn(() => 'c034792a-1ac8-45f7-93ec-b64050991e78');
    const fallback = vi.fn();
    expect(generateUUID({ randomUUID: native, getRandomValues: fallback }))
      .toBe('c034792a-1ac8-45f7-93ec-b64050991e78');
    expect(native).toHaveBeenCalledOnce();
    expect(fallback).not.toHaveBeenCalled();
  });

  it('constructs an RFC 4122 version-4 UUID with secure getRandomValues when randomUUID is unavailable', () => {
    const getRandomValues = vi.fn(bytes => { bytes.fill(0xab); return bytes; });
    const identity = generateUUID({ getRandomValues });
    expect(getRandomValues).toHaveBeenCalledOnce();
    expect(identity).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(identity).toBe('abababab-abab-4bab-abab-abababababab');
  });

  it('fails closed instead of using Math.random if both browser cryptographic APIs are unavailable', () => {
    const random = vi.spyOn(Math, 'random');
    expect(() => generateUUID({})).toThrow(/Secure request identification is unavailable/);
    expect(random).not.toHaveBeenCalled();
    random.mockRestore();
  });
});
