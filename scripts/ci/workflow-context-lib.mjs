function blankWorkflowContext() {
  return {
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
  };
}

export function normalizeWorkflowContext(workflowContext) {
  if (!workflowContext || typeof workflowContext !== "object") {
    return blankWorkflowContext();
  }

  const repository = workflowContext.repository || "";
  const runId = workflowContext.runId || "";
  const sha = workflowContext.sha || "";
  const serverUrl = workflowContext.serverUrl || "";
  const normalizedServerUrl = serverUrl.replace(/\/+$/, "");
  const runUrl =
    workflowContext.runUrl ||
    (normalizedServerUrl && repository && runId
      ? `${normalizedServerUrl}/${repository}/actions/runs/${runId}`
      : "");
  const commitUrl =
    workflowContext.commitUrl ||
    (normalizedServerUrl && repository && sha
      ? `${normalizedServerUrl}/${repository}/commit/${sha}`
      : "");

  return {
    repository,
    workflow: workflowContext.workflow || "",
    runId,
    runAttempt: workflowContext.runAttempt || "",
    ref: workflowContext.ref || "",
    sha,
    eventName: workflowContext.eventName || "",
    serverUrl,
    apiUrl: workflowContext.apiUrl || "",
    runUrl,
    commitUrl,
  };
}

export function readGitHubWorkflowContext(env = process.env) {
  return normalizeWorkflowContext({
    repository: env.GITHUB_REPOSITORY || "",
    workflow: env.GITHUB_WORKFLOW || "",
    runId: env.GITHUB_RUN_ID || "",
    runAttempt: env.GITHUB_RUN_ATTEMPT || "",
    ref: env.GITHUB_REF || "",
    sha: env.GITHUB_SHA || "",
    eventName: env.GITHUB_EVENT_NAME || "",
    serverUrl: env.GITHUB_SERVER_URL || "",
    apiUrl: env.GITHUB_API_URL || "",
  });
}

export function appendGitHubWorkflowContextSection(
  lines,
  workflowContext,
  heading = "## GitHub workflow context",
) {
  const normalized = normalizeWorkflowContext(workflowContext);

  if (
    !normalized.repository &&
    !normalized.workflow &&
    !normalized.runId &&
    !normalized.runAttempt &&
    !normalized.ref &&
    !normalized.sha &&
    !normalized.eventName &&
    !normalized.runUrl &&
    !normalized.commitUrl
  ) {
    return normalized;
  }

  lines.push("", heading, "");

  if (normalized.repository) {
    lines.push(`- Repository: \`${normalized.repository}\``);
  }

  if (normalized.workflow) {
    lines.push(`- Workflow: \`${normalized.workflow}\``);
  }

  if (normalized.runId) {
    lines.push(`- Run ID: \`${normalized.runId}\``);
  }

  if (normalized.runAttempt) {
    lines.push(`- Run attempt: \`${normalized.runAttempt}\``);
  }

  if (normalized.eventName) {
    lines.push(`- Event: \`${normalized.eventName}\``);
  }

  if (normalized.ref) {
    lines.push(`- Ref: \`${normalized.ref}\``);
  }

  if (normalized.sha) {
    lines.push(`- SHA: \`${normalized.sha}\``);
  }

  if (normalized.runUrl) {
    lines.push(`- Run URL: \`${normalized.runUrl}\``);
  }

  if (normalized.commitUrl) {
    lines.push(`- Commit URL: \`${normalized.commitUrl}\``);
  }

  return normalized;
}
