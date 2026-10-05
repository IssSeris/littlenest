import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(
  new URL("./little-nest-browser.yml", import.meta.url),
  "utf8",
);
const lines = workflow.split(/\r?\n/);
const repository = "example/little-nest";
const mergeSha = "a".repeat(40);

function section(name) {
  const start = lines.findIndex((line) => line === `  ${name}:`);
  assert.notEqual(
    start,
    -1,
    `Expected the workflow to define the ${name} job.`,
  );
  const end = lines.findIndex(
    (line, index) => index > start && /^  [a-z0-9-]+:$/.test(line),
  );
  return lines.slice(start, end === -1 ? lines.length : end).join("\n");
}

function step(job, name) {
  const jobLines = job.split("\n");
  const start = jobLines.findIndex((line) => line === `      - name: ${name}`);
  assert.notEqual(start, -1, `Expected the job to define the ${name} step.`);
  const end = jobLines.findIndex(
    (line, index) => index > start && /^      - name:/.test(line),
  );
  return jobLines.slice(start, end === -1 ? jobLines.length : end).join("\n");
}

function runScript(jobStep) {
  const stepLines = jobStep.split("\n");
  const marker = stepLines.findIndex((line) => line === "        run: |");
  assert.notEqual(marker, -1, "Expected a multiline shell script.");
  const body = [];
  for (const line of stepLines.slice(marker + 1)) {
    if (line && !line.startsWith("          ")) break;
    body.push(line.startsWith("          ") ? line.slice(10) : "");
  }
  assert.ok(body.length > 0, "Expected a non-empty shell script.");
  return body.join("\n");
}

const authorizeJob = section("authorize-pr");
const browserJob = section("browser");
const requiredBrowserCheckJob = section("required-browser-check");
const recoverJob = section("recover");

function authorizationScript() {
  const jobLines = authorizeJob.split("\n");
  const marker = jobLines.findIndex((line) => line === "          script: |");
  assert.notEqual(
    marker,
    -1,
    "Expected the authorization job to run an inline GitHub Script.",
  );
  const body = [];
  for (const line of jobLines.slice(marker + 1)) {
    if (line && !line.startsWith("            ")) break;
    body.push(line.startsWith("            ") ? line.slice(12) : "");
  }
  assert.ok(body.length > 0, "Expected a non-empty authorization script.");
  return body.join("\n");
}

function candidate(overrides = {}) {
  return {
    base: { ref: "main", repo: { full_name: repository } },
    head: { repo: { full_name: repository } },
    author_association: "MEMBER",
    draft: false,
    merge_commit_sha: mergeSha,
    ...overrides,
  };
}

function runAuthorization(pullRequest) {
  const outputs = {};
  const failures = [];
  const messages = [];
  const core = {
    setFailed: (message) => failures.push(message),
    setOutput: (name, value) => {
      outputs[name] = value;
    },
    info: (message) => messages.push(message),
  };
  const context = {
    payload: { pull_request: pullRequest },
    repo: { owner: "example", repo: "little-nest" },
  };
  new Function("context", "core", authorizationScript())(context, core);
  return { outputs, failures, messages };
}

test("forked pull requests fail the credential-free authorization job", () => {
  const result = runAuthorization(
    candidate({
      head: { repo: { full_name: "contributor/little-nest" } },
      author_association: "OWNER",
    }),
  );
  assert.equal(result.failures.length, 1);
  assert.equal(result.outputs.eligible, undefined);
});

test("same-repository pull requests from untrusted authors fail authorization", () => {
  const result = runAuthorization(
    candidate({ author_association: "CONTRIBUTOR" }),
  );
  assert.equal(result.failures.length, 1);
  assert.equal(result.outputs.eligible, undefined);
});

test("owners, members, and collaborators are eligible and export the exact merge candidate", () => {
  for (const association of ["OWNER", "MEMBER", "COLLABORATOR"]) {
    const result = runAuthorization(
      candidate({ author_association: association }),
    );
    assert.deepEqual(
      result.failures,
      [],
      `${association} should pass authorization.`,
    );
    assert.equal(result.outputs.eligible, "true");
    assert.equal(result.outputs.merge_sha, mergeSha);
  }
});

test("draft pull requests are skipped until ready for review", () => {
  const result = runAuthorization(candidate({ draft: true }));
  assert.deepEqual(result.failures, []);
  assert.equal(result.outputs.eligible, "false");
  assert.equal(result.outputs.merge_sha, undefined);
});

test("ready-for-review events are enabled and an eligible non-draft PR can proceed", () => {
  const pullRequestTypes =
    workflow.match(
      /^  pull_request_target:\n([\s\S]*?)(?=^  workflow_dispatch:)/m,
    )?.[1] ?? "";
  assert.match(pullRequestTypes, /^\s+- ready_for_review\s*$/m);

  const result = runAuthorization(candidate({ draft: false }));
  assert.deepEqual(result.failures, []);
  assert.equal(result.outputs.eligible, "true");
  assert.equal(result.outputs.merge_sha, mergeSha);
});

test("the authorization job has no checkout, protected environment, or secret access", () => {
  assert.doesNotMatch(
    authorizeJob,
    /actions\/checkout|^\s+environment:|secrets\./m,
  );
  assert.match(authorizeJob, /^\s+pull-requests: read\s*$/m);
  assert.doesNotMatch(authorizeJob, /^\s+contents:/m);
});

test("the protected PR job requires successful authorization and eligibility", () => {
  assert.match(browserJob, /^\s+needs: \[authorize-pr\]\s*$/m);
  assert.match(browserJob, /needs\.authorize-pr\.result == 'success'/);
  assert.match(browserJob, /needs\.authorize-pr\.outputs\.eligible == 'true'/);
  assert.match(browserJob, /'browser-regressions-pr'/);
  assert.ok(
    browserJob.indexOf("environment:") <
      browserJob.indexOf("- name: Check out source"),
    "The protected environment must be requested before source checkout.",
  );
});

test("browser runs use only a fresh loopback PostgreSQL service, never database secrets", () => {
  assert.match(browserJob, /^\s+services:\n\s+postgres:\s*$/m);
  assert.match(browserJob, /^\s+image: postgres:16\s*$/m);
  assert.match(browserJob, /POSTGRES_DB: little_nest_browser/);
  assert.match(browserJob, /POSTGRES_USER: browser_ci/);
  assert.match(browserJob, /POSTGRES_PASSWORD: browser-ci-ephemeral/);
  assert.match(
    browserJob,
    /DATABASE_URL: postgresql:\/\/browser_ci:browser-ci-ephemeral@127\.0\.0\.1:5432\/little_nest_browser/,
  );
  assert.match(browserJob, /BROWSER_TEST_DATABASE_MODE: ephemeral-service/);
  assert.doesNotMatch(browserJob, /secrets\.BROWSER_TEST_DATABASE_(?:URL|FINGERPRINT|ENDPOINT)/);

  const setup = step(browserJob, "Verify and initialize the ephemeral browser database");
  assert.match(setup, /initialize-browser-ci-database\.ts/);
  assert.match(setup, /cleanup-browser-household\.ts --verify-database/);
  assert.match(setup, /pnpm --filter @workspace\/db push/);
  assert.ok(
    setup.indexOf("cleanup-browser-household.ts --verify-database")
      < setup.indexOf("pnpm --filter @workspace/db push"),
    "The database must be verified before the schema is applied.",
  );
});

test("manual recovery cleans exact Clerk fixtures without requiring a persistent database", () => {
  assert.doesNotMatch(recoverJob, /DATABASE_URL|BROWSER_TEST_DATABASE_(?:URL|FINGERPRINT|ENDPOINT)/);
  assert.match(recoverJob, /recover-browser-clerk-fixtures\.ts/);
  assert.match(recoverJob, /BROWSER_TEST_RECOVERY_MODE: clerk-only-after-ephemeral-database/);
  assert.match(recoverJob, /BROWSER_TEST_RECOVERY_SOURCE_VALIDATED: "true"/);
});

test("eligible pull requests check out the exact merge SHA without persisting the token", () => {
  const checkout = step(browserJob, "Check out source");
  assert.match(
    checkout,
    /ref: \$\{\{ github\.event_name == 'pull_request_target' && needs\.authorize-pr\.outputs\.merge_sha \|\| github\.sha \}\}/,
  );
  assert.match(checkout, /persist-credentials: false/);
  assert.doesNotMatch(checkout, /github\.event\.pull_request\.head\.sha/);
});

test("every workflow checkout disables persisted credentials", () => {
  const checkoutNames = lines
    .map((line) => line.match(/^      - name: (Check out.*)$/)?.[1])
    .filter(Boolean);
  let count = 0;
  for (const name of checkoutNames) {
    count += 1;
    assert.match(
      step(browserJob + "\n" + section("recover"), name),
      /persist-credentials: false/,
    );
  }
  assert.ok(
    count >= 2,
    "Expected both browser and recovery checkouts to be covered.",
  );
});

test("the named required check always reports browser and authorization results", () => {
  assert.match(
    requiredBrowserCheckJob,
    /^\s+name: Chromium, Firefox and WebKit\s*$/m,
  );
  assert.match(
    requiredBrowserCheckJob,
    /^\s+needs: \[authorize-pr, browser\]\s*$/m,
  );
  assert.match(requiredBrowserCheckJob, /always\(\)/);
  assert.match(requiredBrowserCheckJob, /github\.event_name == 'push'/);
  assert.match(
    requiredBrowserCheckJob,
    /github\.event_name == 'pull_request_target'/,
  );
});

test("the required check fails closed for ineligible PRs and failed or skipped browser runs", () => {
  const gateScript = runScript(
    step(
      requiredBrowserCheckJob,
      "Require authorization and a successful browser run",
    ),
  );
  const runGate = ({
    eventName,
    authorizationResult,
    eligible,
    browserResult,
  }) =>
    spawnSync("bash", ["-e", "-u", "-o", "pipefail", "-c", gateScript], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        EVENT_NAME: eventName,
        AUTHORIZATION_RESULT: authorizationResult,
        PR_ELIGIBLE: eligible,
        BROWSER_RESULT: browserResult,
      },
    });

  assert.equal(
    runGate({
      eventName: "pull_request_target",
      authorizationResult: "success",
      eligible: "true",
      browserResult: "success",
    }).status,
    0,
  );
  for (const result of [
    {
      eventName: "pull_request_target",
      authorizationResult: "failure",
      eligible: "",
      browserResult: "skipped",
    },
    {
      eventName: "pull_request_target",
      authorizationResult: "success",
      eligible: "false",
      browserResult: "skipped",
    },
    {
      eventName: "pull_request_target",
      authorizationResult: "success",
      eligible: "true",
      browserResult: "failure",
    },
    {
      eventName: "pull_request_target",
      authorizationResult: "success",
      eligible: "true",
      browserResult: "cancelled",
    },
  ]) {
    assert.notEqual(runGate(result).status, 0, JSON.stringify(result));
  }
  assert.equal(
    runGate({
      eventName: "push",
      authorizationResult: "skipped",
      eligible: "",
      browserResult: "success",
    }).status,
    0,
  );
});
