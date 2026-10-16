import { describe, expect, it } from 'vitest';
import manifest from '../package.json' with { type: 'json' };
import * as sdk from '../src/index.js';

describe('VERSION', () => {
  // Integrators log this to report which SDK built a transaction, so it has
  // to name the release they actually installed.
  it('matches the version in package.json', () => {
    expect(sdk.VERSION).toBe(manifest.version);
  });

  it('is the only export until the first feature lands', () => {
    expect(Object.keys(sdk)).toEqual(['VERSION']);
  });
});
