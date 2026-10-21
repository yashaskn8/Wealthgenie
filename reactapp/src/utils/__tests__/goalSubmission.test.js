import { describe, it, expect, vi } from 'vitest';
import { buildGoalPayload, submitGoal } from '../goalSubmission';

describe('goalSubmission Utility (WG-033)', () => {
  it('a. buildGoalPayload correctly maps all 5 fields for a typical GoalForm input and normalizes targetDate (string and Date)', () => {
    // Test string targetDate (from GoalForm / GoalPlanner)
    const payloadFromString = buildGoalPayload({
      goalName: 'Retirement',
      targetAmount: 15000000,
      targetDate: '2045-06-30',
      currentSavings: 100000,
      priority: 'High',
      profileId: 'profile_123',
    });

    expect(payloadFromString).toEqual({
      goal_name: 'Retirement',
      target_amount: 15000000,
      target_date: '2045-06-30',
      current_savings: 100000,
      priority: 'High',
      profileId: 'profile_123',
    });

    // Test Date instance targetDate (from a saved goal target Date)
    const dateObj = new Date('2040-01-15T00:00:00.000Z');
    const payloadFromDate = buildGoalPayload({
      goalName: 'Emergency Fund',
      targetAmount: 240000,
      targetDate: dateObj,
      currentSavings: 50000,
      priority: 'Critical',
      profileId: 'profile_123',
    });

    expect(payloadFromDate.target_date).toBe('2040-01-15');
  });

  it('b. buildGoalPayload fails closed when the canonical profile ID is absent', () => {
    expect(() => buildGoalPayload({
      goalName: 'Vehicle',
      targetAmount: 500000,
      targetDate: '2027-12-31',
      currentSavings: 0,
      priority: 'Medium',
    })).toThrow('canonical Financial Profile ID');

    const payloadWithProfile = buildGoalPayload({
      goalName: 'Vehicle',
      targetAmount: 500000,
      targetDate: '2027-12-31',
      currentSavings: 0,
      priority: 'Medium',
      profileId: 'profile_999',
    });

    expect(payloadWithProfile.profileId).toBe('profile_999');
  });

  it('c. submitGoal returns { success: true, goal } when the mocked api call resolves', async () => {
    const mockGoal = { _id: 'g_123', goal_name: 'Tax Saving', target_amount: 150000 };
    const mockApi = {
      createGoal: vi.fn().mockResolvedValue({ success: true, goal: mockGoal }),
    };

    const res = await submitGoal(mockApi, {
      goalName: 'Tax Saving',
      targetAmount: 150000,
      targetDate: '2027-03-31',
      currentSavings: 0,
      priority: 'Low',
      profileId: 'profile_123',
    });

    expect(mockApi.createGoal).toHaveBeenCalledWith({
      goal_name: 'Tax Saving',
      target_amount: 150000,
      target_date: '2027-03-31',
      current_savings: 0,
      priority: 'Low',
      profileId: 'profile_123',
    });
    expect(res).toEqual({
      success: true,
      goal: mockGoal,
      raw: { success: true, goal: mockGoal },
    });
  });

  it('d. submitGoal returns { success: false, error } with real message when api call rejects, without throwing', async () => {
    const errorMsg = 'A goal named "Retirement" already exists. Use a different name.';
    const mockApi = {
      createGoal: vi.fn().mockRejectedValue(new Error(errorMsg)),
    };

    // Assert that calling submitGoal resolves to the error shape rather than rejecting/throwing
    const resPromise = submitGoal(mockApi, {
      goalName: 'Retirement',
      targetAmount: 10000000,
      targetDate: '2050-01-01',
      currentSavings: 0,
      profileId: 'profile_123',
    });

    await expect(resPromise).resolves.toEqual({
      success: false,
      error: errorMsg,
    });
  });
});
