import { expect, test } from '@playwright/test';

test('temporary merge-gate failure probe', () => {
  expect(0, 'Intentional failure probe for the temporary PR verification').toBe(1);
});