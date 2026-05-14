import test from "node:test";
import assert from "node:assert/strict";

import {
  appendGitHubWorkflowContextSection,
  normalizeWorkflowContext,
  readGitHubWorkflowContext,
} from "../scripts/ci/workflow-context-lib.mjs";

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
    repository: "CharlesMulic/equip",
    workflow: "Release",
    runId: "123",
    runAttempt: "4",
    ref: "refs/heads/main",
    sha: "abcdef123456",
    eventName: "push",
    serverUrl: "https://github.com///",
    apiUrl: "https://api.github.com",
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
  const workflowContext = readGitHubWorkflowContext({
    GITHUB_REPOSITORY: "CharlesMulic/equip",
    GITHUB_WORKFLOW: "Release",
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "7",
    GITHUB_REF: "refs/tags/v1.2.3",
    GITHUB_SHA: "abcdef123456",
    GITHUB_EVENT_NAME: "push",
    GITHUB_SERVER_URL: "https://github.com/",
    GITHUB_API_URL: "https://api.github.com",
  });

  assert.equal(workflowContext.serverUrl, "https://github.com");
  assert.equal(workflowContext.apiUrl, "https://api.github.com");
  assert.equal(workflowContext.runUrl, "https://github.com/CharlesMulic/equip/actions/runs/123");
  assert.equal(
    workflowContext.commitUrl,
    "https://github.com/CharlesMulic/equip/commit/abcdef123456",
  );
});

test("appendGitHubWorkflowContextSection renders server and api URLs from normalized context", () => {
  const lines = ["# Summary"];
  const workflowContext = appendGitHubWorkflowContextSection(lines, {
    repository: "CharlesMulic/equip",
    workflow: "Release",
    runId: "123",
    runAttempt: "2",
    ref: "refs/heads/main",
    sha: "abcdef123456",
    eventName: "push",
    serverUrl: "https://github.com/",
    apiUrl: "https://api.github.com",
  });

  assert.equal(workflowContext.serverUrl, "https://github.com");
  assert.equal(workflowContext.apiUrl, "https://api.github.com");
  assert.match(lines.join("\n"), /Server URL: `https:\/\/github\.com`/i);
  assert.match(lines.join("\n"), /API URL: `https:\/\/api\.github\.com`/i);
  assert.match(lines.join("\n"), /Run URL: `https:\/\/github\.com\/CharlesMulic\/equip\/actions\/runs\/123`/i);
  assert.match(lines.join("\n"), /Commit URL: `https:\/\/github\.com\/CharlesMulic\/equip\/commit\/abcdef123456`/i);
});
