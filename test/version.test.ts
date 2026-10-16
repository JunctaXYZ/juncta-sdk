import { describe, expect, it } from 'vitest';
import manifest from '../package.json' with { type: 'json' };
import * as sdk from '../src/index.js';

describe('VERSION', () => {
  // Integrators log this to report which SDK built a transaction, so it has
  // to name the release they actually installed.
  it('matches the version in package.json', () => {
    expect(sdk.VERSION).toBe(manifest.version);
  });

  // A literal type would change the public types on every release and make
  // a comparison with another version a type error for consumers.
  // tsc rejects this comparison if VERSION has a literal type.
  it('is typed as string, so comparing with another release compiles', () => {
    expect(sdk.VERSION === '0.0.0-other').toBe(false);
  });

  it('is the only export until the first feature lands', () => {
    expect(Object.keys(sdk)).toEqual(['VERSION']);
  });
});
