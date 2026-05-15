export function createWorkflowEnv(overrides = {}) {
  return {
    GITHUB_REPOSITORY: "CharlesMulic/equip",
    GITHUB_WORKFLOW: "Release",
    GITHUB_RUN_ID: "1234567890",
    GITHUB_RUN_ATTEMPT: "2",
    GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: "abcdef1234567890",
    GITHUB_EVENT_NAME: "push",
    GITHUB_SERVER_URL: "https://github.com/",
    GITHUB_API_URL: "https://api.github.com",
    ...overrides,
  };
}

export function createWorkflowContext(overrides = {}) {
  return {
    repository: "CharlesMulic/equip",
    workflow: "Release",
    runId: "1234567890",
    runAttempt: "2",
    ref: "refs/heads/main",
    sha: "abcdef1234567890",
    eventName: "push",
    serverUrl: "https://github.com",
    apiUrl: "https://api.github.com",
    ...overrides,
  };
}
