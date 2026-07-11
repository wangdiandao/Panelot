import { describe, expect, it } from 'vitest';
import { threadIdFromNotification, threadNotificationId } from '../../src/ui/threadNotification';

describe('thread notifications', () => {
  it('round-trips a thread id without accepting unrelated notifications', () => {
    const id = threadNotificationId('thread:with spaces', 'approval', 'approval-1');
    expect(threadIdFromNotification(id)).toBe('thread:with spaces');
    expect(threadIdFromNotification('other-extension:event')).toBeNull();
  });
});
