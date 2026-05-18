import test from "node:test";
import assert from "node:assert/strict";

import {
  appendGitHubWorkflowContextSection,
  normalizeWorkflowContext,
  readGitHubWorkflowContext,
} from "../scripts/ci/workflow-context-lib.mjs";
import {
  createAlignedWorkflowFixture,
  createWorkflowFixture,
} from "./helpers/workflow-context.mjs";

const {
  workflowContext: workflowContextFixture,
  workflowEnv: workflowEnvFixture,
} = createWorkflowFixture();

test("createWorkflowFixture returns matching env and context fixtures with independent overrides", () => {
  const { workflowEnv, workflowContext } = createWorkflowFixture({
    env: {
      GITHUB_RUN_ID: "987",
      GITHUB_SERVER_URL: "https://github.example.test/",
    },
    context: {
      runId: "654",
      serverUrl: "https://git.example.test",
    },
  });

  assert.equal(workflowEnv.GITHUB_REPOSITORY, "CharlesMulic/equip");
  assert.equal(workflowEnv.GITHUB_WORKFLOW, "Release");
  assert.equal(workflowEnv.GITHUB_RUN_ID, "987");
  assert.equal(workflowEnv.GITHUB_SERVER_URL, "https://github.example.test/");
  assert.equal(workflowContext.repository, "CharlesMulic/equip");
  assert.equal(workflowContext.workflow, "Release");
  assert.equal(workflowContext.runId, "654");
  assert.equal(workflowContext.serverUrl, "https://git.example.test");
});

test("createWorkflowFixture keeps default env and context fixtures aligned", () => {
  const workflowContextFromEnv = readGitHubWorkflowContext(workflowEnvFixture);

  assert.equal(workflowContextFromEnv.repository, workflowContextFixture.repository);
  assert.equal(workflowContextFromEnv.workflow, workflowContextFixture.workflow);
  assert.equal(workflowContextFromEnv.runId, workflowContextFixture.runId);
  assert.equal(workflowContextFromEnv.runAttempt, workflowContextFixture.runAttempt);
  assert.equal(workflowContextFromEnv.ref, workflowContextFixture.ref);
  assert.equal(workflowContextFromEnv.sha, workflowContextFixture.sha);
  assert.equal(workflowContextFromEnv.eventName, workflowContextFixture.eventName);
  assert.equal(workflowContextFromEnv.serverUrl, workflowContextFixture.serverUrl);
  assert.equal(workflowContextFromEnv.apiUrl, workflowContextFixture.apiUrl);
  assert.equal(
    workflowContextFromEnv.runUrl,
    "https://github.com/CharlesMulic/equip/actions/runs/1234567890",
  );
  assert.equal(
    workflowContextFromEnv.commitUrl,
    "https://github.com/CharlesMulic/equip/commit/abcdef1234567890",
  );
});

test("createAlignedWorkflowFixture derives context from env overrides", () => {
  const { workflowEnv, workflowContext } = createAlignedWorkflowFixture({
    env: {
      GITHUB_RUN_ID: "321",
      GITHUB_RUN_ATTEMPT: "9",
      GITHUB_REF: "refs/tags/v9.9.9",
      GITHUB_SHA: "9999abcdef",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_SERVER_URL: "https://github.example.test/",
      GITHUB_API_URL: "https://api.example.test/",
    },
  });

  assert.equal(workflowEnv.GITHUB_RUN_ID, "321");
  assert.equal(workflowContext.repository, "CharlesMulic/equip");
  assert.equal(workflowContext.workflow, "Release");
  assert.equal(workflowContext.runId, "321");
  assert.equal(workflowContext.runAttempt, "9");
  assert.equal(workflowContext.ref, "refs/tags/v9.9.9");
  assert.equal(workflowContext.sha, "9999abcdef");
  assert.equal(workflowContext.eventName, "workflow_dispatch");
  assert.equal(workflowContext.serverUrl, "https://github.example.test");
  assert.equal(workflowContext.apiUrl, "https://api.example.test");
  assert.equal(
    workflowContext.runUrl,
    "https://github.example.test/CharlesMulic/equip/actions/runs/321",
  );
  assert.equal(
    workflowContext.commitUrl,
    "https://github.example.test/CharlesMulic/equip/commit/9999abcdef",
  );
});

test("createAlignedWorkflowFixture leaves derived links blank when required env is missing", () => {
  const { workflowContext } = createAlignedWorkflowFixture({
    env: {
      GITHUB_REPOSITORY: "",
      GITHUB_RUN_ID: "",
      GITHUB_SHA: "",
      GITHUB_RUN_ATTEMPT: "11",
      GITHUB_SERVER_URL: "https://github.example.test/",
      GITHUB_API_URL: "https://api.example.test/",
    },
  });

  assert.equal(workflowContext.repository, "");
  assert.equal(workflowContext.workflow, "Release");
  assert.equal(workflowContext.runId, "");
  assert.equal(workflowContext.runAttempt, "11");
  assert.equal(workflowContext.ref, "refs/heads/main");
  assert.equal(workflowContext.sha, "");
  assert.equal(workflowContext.eventName, "push");
  assert.equal(workflowContext.serverUrl, "https://github.example.test");
  assert.equal(workflowContext.apiUrl, "https://api.example.test");
  assert.equal(workflowContext.runUrl, "");
  assert.equal(workflowContext.commitUrl, "");
});

test("createAlignedWorkflowFixture allows explicit context overrides after derivation", () => {
  const { workflowContext } = createAlignedWorkflowFixture({
    env: {
      GITHUB_RUN_ID: "654",
      GITHUB_SHA: "abcdef654321",
    },
    context: {
      runUrl: "https://ci.example.test/custom-run/654",
      commitUrl: "https://git.example.test/custom-commit/abcdef654321",
    },
  });

  assert.equal(workflowContext.runId, "654");
  assert.equal(workflowContext.sha, "abcdef654321");
  assert.equal(workflowContext.runUrl, "https://ci.example.test/custom-run/654");
  assert.equal(
    workflowContext.commitUrl,
    "https://git.example.test/custom-commit/abcdef654321",
  );
});

test("normalizeWorkflowContext returns blank defaults for non-objects", () => {
  assert.deepEqual(normalizeWorkflowContext(null), {
    repository: "",
    workflow: "",
    runId: "",
    runAttempt: "",
    ref: "",
    sha: "",
    eventName: "",
    serverUrl: "",
    apiUrl: "",
    runUrl: "",
    commitUrl: "",
  });
});

test("normalizeWorkflowContext trims trailing serverUrl slashes and derives links", () => {
  const workflowContext = normalizeWorkflowContext({
    ...workflowContextFixture,
    runId: "123",
    runAttempt: "4",
    sha: "abcdef123456",
    serverUrl: "https://github.com///",
    apiUrl: "https://api.github.com/",
  });

  assert.equal(workflowContext.repository, "CharlesMulic/equip");
  assert.equal(workflowContext.workflow, "Release");
  assert.equal(workflowContext.runId, "123");
  assert.equal(workflowContext.runAttempt, "4");
  assert.equal(workflowContext.ref, "refs/heads/main");
  assert.equal(workflowContext.sha, "abcdef123456");
  assert.equal(workflowContext.eventName, "push");
  assert.equal(workflowContext.serverUrl, "https://github.com");
  assert.equal(workflowContext.apiUrl, "https://api.github.com");
  assert.equal(workflowContext.runUrl, "https://github.com/CharlesMulic/equip/actions/runs/123");
  assert.equal(
    workflowContext.commitUrl,
    "https://github.com/CharlesMulic/equip/commit/abcdef123456",
  );
});

test("readGitHubWorkflowContext normalizes workflow env inputs", () => {
  const workflowContext = readGitHubWorkflowContext(
    {
      ...workflowEnvFixture,
      GITHUB_RUN_ID: "123",
      GITHUB_RUN_ATTEMPT: "7",
      GITHUB_REF: "refs/tags/v1.2.3",
      GITHUB_SHA: "abcdef123456",
      GITHUB_API_URL: "https://api.github.com/",
    },
  );

  assert.equal(workflowContext.serverUrl, "https://github.com");
  assert.equal(workflowContext.apiUrl, "https://api.github.com");
  assert.equal(workflowContext.runUrl, "https://github.com/CharlesMulic/equip/actions/runs/123");
  assert.equal(
    workflowContext.commitUrl,
    "https://github.com/CharlesMulic/equip/commit/abcdef123456",
  );
});

test("readGitHubWorkflowContext leaves derived links blank when required env is missing", () => {
  const workflowContext = readGitHubWorkflowContext(
    {
      ...workflowEnvFixture,
      GITHUB_REPOSITORY: "",
      GITHUB_RUN_ID: "",
      GITHUB_REF: "",
      GITHUB_SHA: "",
      GITHUB_RUN_ATTEMPT: "7",
      GITHUB_API_URL: "https://api.github.com/",
    },
  );

  assert.equal(workflowContext.repository, "");
  assert.equal(workflowContext.workflow, "Release");
  assert.equal(workflowContext.runId, "");
  assert.equal(workflowContext.runAttempt, "7");
  assert.equal(workflowContext.ref, "");
  assert.equal(workflowContext.sha, "");
  assert.equal(workflowContext.eventName, "push");
  assert.equal(workflowContext.serverUrl, "https://github.com");
  assert.equal(workflowContext.apiUrl, "https://api.github.com");
  assert.equal(workflowContext.runUrl, "");
  assert.equal(workflowContext.commitUrl, "");
});

test("appendGitHubWorkflowContextSection renders server and api URLs from normalized context", () => {
  const lines = ["# Summary"];
  const workflowContext = appendGitHubWorkflowContextSection(
    lines,
    {
      ...workflowContextFixture,
      runId: "123",
      runAttempt: "2",
      sha: "abcdef123456",
      serverUrl: "https://github.com/",
      apiUrl: "https://api.github.com/",
    },
  );

  assert.equal(workflowContext.serverUrl, "https://github.com");
  assert.equal(workflowContext.apiUrl, "https://api.github.com");
  assert.match(lines.join("\n"), /Server URL: `https:\/\/github\.com`/i);
  assert.match(lines.join("\n"), /API URL: `https:\/\/api\.github\.com`/i);
  assert.doesNotMatch(lines.join("\n"), /API URL: `https:\/\/api\.github\.com\/`/i);
  assert.match(lines.join("\n"), /Run URL: `https:\/\/github\.com\/CharlesMulic\/equip\/actions\/runs\/123`/i);
  assert.match(lines.join("\n"), /Commit URL: `https:\/\/github\.com\/CharlesMulic\/equip\/commit\/abcdef123456`/i);
});

test("normalizeWorkflowContext preserves explicit run and commit URLs", () => {
  const workflowContext = normalizeWorkflowContext({
    ...workflowContextFixture,
    runId: "123",
    sha: "abcdef123456",
    serverUrl: "https://github.com///",
    runUrl: "https://ci.example.test/runs/123",
    commitUrl: "https://git.example.test/commit/abcdef123456",
  });

  assert.equal(workflowContext.serverUrl, "https://github.com");
  assert.equal(workflowContext.runUrl, "https://ci.example.test/runs/123");
  assert.equal(workflowContext.commitUrl, "https://git.example.test/commit/abcdef123456");
});

test("appendGitHubWorkflowContextSection skips blank workflow context", () => {
  const lines = ["# Summary"];
  const workflowContext = appendGitHubWorkflowContextSection(lines, {});

  assert.deepEqual(workflowContext, {
    repository: "",
    workflow: "",
    runId: "",
    runAttempt: "",
    ref: "",
    sha: "",
    eventName: "",
    serverUrl: "",
    apiUrl: "",
    runUrl: "",
    commitUrl: "",
  });
  assert.deepEqual(lines, ["# Summary"]);
});

test("appendGitHubWorkflowContextSection honors a custom heading and does not invent links", () => {
  const lines = ["# Summary"];
  const workflowContext = appendGitHubWorkflowContextSection(
    lines,
    {
      ...workflowContextFixture,
      repository: "",
      runId: "",
      runAttempt: "",
      ref: "",
      sha: "",
      eventName: "workflow_dispatch",
      serverUrl: "https://github.com/",
      apiUrl: "https://api.github.com/",
    },
    "## Workflow metadata",
  );

  const rendered = lines.join("\n");
  assert.equal(workflowContext.serverUrl, "https://github.com");
  assert.equal(workflowContext.apiUrl, "https://api.github.com");
  assert.equal(workflowContext.runUrl, "");
  assert.equal(workflowContext.commitUrl, "");
  assert.match(rendered, /## Workflow metadata/i);
  assert.match(rendered, /Workflow: `Release`/i);
  assert.match(rendered, /Event: `workflow_dispatch`/i);
  assert.match(rendered, /Server URL: `https:\/\/github\.com`/i);
  assert.match(rendered, /API URL: `https:\/\/api\.github\.com`/i);
  assert.doesNotMatch(rendered, /API URL: `https:\/\/api\.github\.com\/`/i);
  assert.doesNotMatch(rendered, /Run URL:/i);
  assert.doesNotMatch(rendered, /Commit URL:/i);
});
