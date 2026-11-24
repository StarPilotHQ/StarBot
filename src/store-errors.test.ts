import { describe, expect, it, vi } from 'vitest';

vi.mock('@keyv/sqlite', () => ({
  default: class {
    opts = {};
    on() { return this; }
    async get() { throw new Error('read failed'); }
    async set() { throw new Error('write failed'); }
    async clear() {}
    async has() { return false; }
    async getMany() { return []; }
    async setMany() {}
    async deleteMany() { return false; }
    async hasMany() { return []; }
    async delete() { throw new Error('delete failed'); }
  },
}));
vi.mock('./logger.js', () => ({
  createLogger: () => ({ warn: () => {}, error: () => {}, info: () => {}, debug: () => {} }),
}));

import { createStore } from './store.js';
import { strictConfigStore } from './runtime-config.js';
import { clearDefaultAssignee, getDefaultAssigneeId, setDefaultAssigneeId } from './handlers/report/default-assignee.js';

describe('store failures', () => {
  it('stay quiet by default', async () => {
    const store = createStore<string>('quiet');
    expect(await store.get('k')).toBeUndefined();
    await expect(store.set('k', 'v')).resolves.toBe(false);
    await expect(store.delete('k')).resolves.toBe(false);
  });

  it('reject on the strict config store', async () => {
    await expect(strictConfigStore.get('k')).rejects.toThrow('read failed');
    await expect(strictConfigStore.set('k', 'v')).rejects.toThrow('write failed');
    await expect(strictConfigStore.delete('k')).rejects.toThrow('delete failed');
  });

  it('are not mistaken for an unset default assignee', async () => {
    await expect(getDefaultAssigneeId()).rejects.toThrow();
    await expect(setDefaultAssigneeId('42')).rejects.toThrow();
    await expect(clearDefaultAssignee()).rejects.toThrow();
  });
});
