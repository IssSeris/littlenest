import { writeFileSync } from 'node:fs';
import type { FullConfig, Reporter, Suite } from '@playwright/test/reporter';

type Scope = { project: string; testId: string };

export default class RecoveryScopeReporter implements Reporter {
  onBegin(_config: FullConfig, suite: Suite) {
    const scopes: Scope[] = suite.allTests().map((test) => {
      const project = test.parent.project()?.name;
      if (!project) throw new Error('A browser recovery test has no Playwright project.');
      return { project, testId: test.id };
    });
    const unique = new Map(scopes.map((scope) => [`${scope.project}\0${scope.testId}`, scope]));
    const destination = process.env.BROWSER_TEST_RECOVERY_SCOPES_FILE;
    if (!destination) throw new Error('The private browser recovery scope file path is required.');
    writeFileSync(destination, JSON.stringify([...unique.values()]), { mode: 0o600, flag: 'wx' });
  }
}