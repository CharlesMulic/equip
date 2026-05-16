import test from "node:test";
import assert from "node:assert/strict";

import {
  appendGitHubWorkflowContextSection,
  normalizeWorkflowContext,
  readGitHubWorkflowContext,
} from "../scripts/ci/workflow-context-lib.mjs";
import {
  createWorkflowContext,
  createWorkflowEnv,
} from "./helpers/workflow-context.mjs";

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
  const workflowContext = normalizeWorkflowContext(createWorkflowContext({
    runId: "123",
    runAttempt: "4",
    sha: "abcdef123456",
    serverUrl: "https://github.com///",
    apiUrl: "https://api.github.com/",
  }));

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
    createWorkflowEnv({
      GITHUB_RUN_ID: "123",
      GITHUB_RUN_ATTEMPT: "7",
      GITHUB_REF: "refs/tags/v1.2.3",
      GITHUB_SHA: "abcdef123456",
      GITHUB_API_URL: "https://api.github.com/",
    }),
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
    createWorkflowEnv({
      GITHUB_REPOSITORY: "",
      GITHUB_RUN_ID: "",
      GITHUB_REF: "",
      GITHUB_SHA: "",
      GITHUB_RUN_ATTEMPT: "7",
      GITHUB_API_URL: "https://api.github.com/",
    }),
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
    createWorkflowContext({
      runId: "123",
      runAttempt: "2",
      sha: "abcdef123456",
      serverUrl: "https://github.com/",
      apiUrl: "https://api.github.com/",
    }),
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
  const workflowContext = normalizeWorkflowContext(createWorkflowContext({
    runId: "123",
    sha: "abcdef123456",
    serverUrl: "https://github.com///",
    runUrl: "https://ci.example.test/runs/123",
    commitUrl: "https://git.example.test/commit/abcdef123456",
  }));

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
    createWorkflowContext({
      repository: "",
      workflow: "Release",
      runId: "",
      runAttempt: "",
      ref: "",
      sha: "",
      eventName: "workflow_dispatch",
      serverUrl: "https://github.com/",
      apiUrl: "https://api.github.com/",
    }),
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
