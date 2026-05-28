"use strict";

const { describe, it } = require("node:test");
const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  assessMcpInstallability,
  assessMcpReadiness,
  assessMcpRuntimeReadiness,
  deriveMcpRuntimeRequirements,
  registryDefToMcpInstallTargets,
  registryDefToPreferredMcpInstallTarget,
  selectPreferredMcpInstallTarget,
  summarizeMcpInstallTarget,
} = require("../dist/lib/mcp-readiness");
const {
  buildMcpConfigForInstallTarget,
} = require("../dist/lib/mcp");

describe("registryDefToMcpInstallTargets", () => {
  it("normalizes flat remote HTTP definitions to streamable HTTP targets", () => {
    const targets = registryDefToMcpInstallTargets({
      name: "remote-demo",
      title: "Remote Demo",
      description: "",
      installMode: "direct",
      transport: "http",
      serverUrl: "https://example.com/mcp",
      requiresAuth: false,
    });

    assert.equal(targets.length, 1);
    assert.equal(targets[0].kind, "remote");
    assert.equal(targets[0].transport, "streamable-http");
    assert.equal(targets[0].url, "https://example.com/mcp");
    assert.equal(assessMcpInstallability(targets[0]).status, "installable");
  });

  it("keeps SSE visible and installable before platform-specific output", () => {
    const [target] = registryDefToMcpInstallTargets({
      name: "sse-demo",
      title: "SSE Demo",
      description: "",
      installMode: "direct",
      transport: "sse",
      serverUrl: "https://example.com/sse",
    });

    const report = assessMcpInstallability(target);

    assert.equal(target.transport, "sse");
    assert.equal(report.status, "installable");
    assert.equal(report.findings[0].code, "remote-sse-platform-dependent");
  });

  it("projects package stdio targets from registry package facts", () => {
    const [target] = registryDefToMcpInstallTargets({
      name: "npm-demo",
      title: "npm Demo",
      description: "",
      installMode: "package",
      installTargets: [{
        targetKey: "npm",
        targetKind: "stdio",
        transport: { type: "stdio" },
        registryType: "npm",
        identifier: "@example/mcp-server",
        environmentVariables: [{ name: "EXAMPLE_TOKEN", isRequired: true, isSecret: true }],
      }],
    });

    assert.equal(target.kind, "stdio");
    assert.equal(target.command, "npx");
    assert.deepEqual(target.args, ["-y", "@example/mcp-server"]);
    assert.equal(target.inputs[0].key, "EXAMPLE_TOKEN");
    assert.equal(assessMcpInstallability(target).status, "needs-input");
  });

  it("treats required plain env and multiple secrets as structured inputs", () => {
    const [target] = registryDefToMcpInstallTargets({
      name: "multi-input-demo",
      title: "Multi Input Demo",
      description: "",
      installMode: "package",
      installTargets: [{
        targetKind: "stdio",
        transport: { type: "stdio" },
        registryType: "npm",
        identifier: "@example/mcp-server",
        environmentVariables: [
          { name: "TENANT_ID", isRequired: true, isSecret: false },
          { name: "API_TOKEN", isRequired: true, isSecret: true },
          { name: "SECOND_TOKEN", isRequired: true, isSecret: true },
          { name: "REGION", isRequired: false, isSecret: false, default: "us" },
        ],
      }],
    });

    assert.equal(assessMcpInstallability(target).status, "needs-input");
    assert.deepEqual(
      assessMcpInstallability(target).requiredInputs.map((input) => input.key),
      ["TENANT_ID", "API_TOKEN", "SECOND_TOKEN"],
    );
    assert.equal(assessMcpInstallability(target, {
      inputs: {
        TENANT_ID: "tenant-1",
        API_TOKEN: "secret-1",
        SECOND_TOKEN: "secret-2",
      },
    }).status, "installable");
  });

  it("adds literal package arguments and version pins to package projections", () => {
    const [target] = registryDefToMcpInstallTargets({
      name: "package-args-demo",
      title: "Package Args Demo",
      description: "",
      installMode: "package",
      installTargets: [{
        targetKind: "stdio",
        transport: { type: "stdio" },
        registryType: "npm",
        identifier: "@example/mcp-server",
        version: "1.2.3",
        packageArguments: [
          { type: "named", name: "--mode", default: "readonly" },
        ],
      }],
    });

    assert.equal(target.kind, "stdio");
    assert.deepEqual(target.args, ["-y", "@example/mcp-server@1.2.3", "--mode", "readonly"]);
  });

  it("keeps package argument variables unsupported until substitution lands", () => {
    const [target] = registryDefToMcpInstallTargets({
      name: "package-arg-var-demo",
      title: "Package Arg Var Demo",
      description: "",
      installMode: "package",
      installTargets: [{
        targetKind: "stdio",
        transport: { type: "stdio" },
        registryType: "npm",
        identifier: "@example/mcp-server",
        packageArguments: [
          { type: "named", name: "--workspace", value: "{WORKSPACE_ID}", variables: { WORKSPACE_ID: { isRequired: true } } },
        ],
      }],
    });

    assert.equal(target.kind, "unsupported");
    assert.equal(target.reasonCode, "arg-variables-unsupported");
  });

  it("blocks unsafe literal package arguments before config output", () => {
    const [target] = registryDefToMcpInstallTargets({
      name: "unsafe-package-arg-demo",
      title: "Unsafe Package Arg Demo",
      description: "",
      installMode: "package",
      installTargets: [{
        targetKind: "stdio",
        transport: { type: "stdio" },
        registryType: "npm",
        identifier: "@example/mcp-server",
        packageArguments: [
          { type: "named", name: "--mode", value: "safe & echo unsafe" },
        ],
      }],
    });

    const report = assessMcpInstallability(target);
    const result = buildMcpConfigForInstallTarget(target, "claude-code");

    assert.equal(report.status, "unsupported");
    assert.equal(report.findings.some((finding) => finding.code === "stdio-arg-unsafe"), true);
    assert.equal(result.success, false);
    assert.equal(result.errorCode, "stdio-arg-unsafe");
  });

  it("reports package-launched HTTP as unsupported", () => {
    const [target] = registryDefToMcpInstallTargets({
      name: "http-package",
      title: "HTTP Package",
      description: "",
      installMode: "package",
      installTargets: [{
        targetKind: "package",
        transport: { type: "streamable-http" },
        registryType: "npm",
        identifier: "@example/local-http-server",
      }],
    });

    const report = assessMcpInstallability(target);

    assert.equal(target.kind, "unsupported");
    assert.equal(report.status, "unsupported");
    assert.equal(report.findings[0].code, "package-launched-http-unsupported");
  });

  it("blocks remote targets with custom headers or URL variables", () => {
    const [target] = registryDefToMcpInstallTargets({
      name: "header-demo",
      title: "Header Demo",
      description: "",
      installMode: "direct",
      installTargets: [{
        targetKind: "remote",
        transport: "streamable-http",
        url: "https://{tenant}.example.com/mcp",
        headers: {
          "X-Tenant": "example",
          Authorization: "Bearer ${TOKEN}",
        },
      }],
    });

    const report = assessMcpInstallability(target);

    assert.equal(report.status, "unsupported");
    assert.deepEqual(
      report.findings.filter((finding) => finding.severity === "blocked").map((finding) => finding.code),
      ["url-variables-unsupported", "custom-headers-unsupported", "authorization-header-variable-unsupported"],
    );
  });

  it("blocks static Authorization headers from registry metadata", () => {
    const [target] = registryDefToMcpInstallTargets({
      name: "static-auth-demo",
      title: "Static Auth Demo",
      description: "",
      installMode: "direct",
      installTargets: [{
        targetKind: "remote",
        transport: "streamable-http",
        url: "https://example.com/mcp",
        headers: {
          Authorization: "Bearer registry-secret",
        },
      }],
    });

    const report = assessMcpInstallability(target);

    assert.equal(report.status, "unsupported");
    assert.equal(report.findings.some((finding) => finding.code === "static-authorization-header-unsupported"), true);
  });

  it("keeps remote targets with unprojectable inputs unsupported even when values are supplied", () => {
    const [target] = registryDefToMcpInstallTargets({
      name: "remote-multi-input-demo",
      title: "Remote Multi Input Demo",
      description: "",
      installMode: "direct",
      installTargets: [{
        targetKind: "remote",
        transport: "streamable-http",
        url: "https://example.com/mcp",
        inputs: [
          { key: "TENANT_ID", required: true, secret: false },
          { key: "API_TOKEN", required: true, secret: true },
        ],
      }],
    });

    const report = assessMcpInstallability(target, {
      inputs: { TENANT_ID: "tenant-1", API_TOKEN: "secret" },
    });
    const result = buildMcpConfigForInstallTarget(target, "codex", {
      inputs: { TENANT_ID: "tenant-1", API_TOKEN: "secret" },
    });

    assert.equal(report.status, "unsupported");
    assert.equal(report.findings.some((finding) => finding.code === "remote-input-shape-unsupported"), true);
    assert.equal(result.success, false);
    assert.equal(result.errorCode, "remote-input-shape-unsupported");
  });

  it("blocks templated input defaults until substitution lands", () => {
    const [target] = registryDefToMcpInstallTargets({
      name: "templated-default-demo",
      title: "Templated Default Demo",
      description: "",
      installMode: "package",
      installTargets: [{
        targetKind: "stdio",
        transport: { type: "stdio" },
        registryType: "npm",
        identifier: "@example/mcp-server",
        environmentVariables: [
          { name: "TENANT_URL", isRequired: true, isSecret: false, default: "https://${TENANT}.example.com", variables: { TENANT: { required: true } } },
        ],
      }],
    });

    const report = assessMcpInstallability(target);

    assert.equal(report.status, "unsupported");
    assert.equal(report.findings.some((finding) => finding.code === "input-variables-unsupported"), true);
  });

  it("blocks credentialed non-local HTTP remote targets", () => {
    const [target] = registryDefToMcpInstallTargets({
      name: "insecure-auth-demo",
      title: "Insecure Auth Demo",
      description: "",
      installMode: "direct",
      transport: "http",
      serverUrl: "http://example.com/mcp",
      requiresAuth: true,
    });

    const report = assessMcpInstallability(target);

    assert.equal(report.status, "unsupported");
    assert.equal(report.findings.some((finding) => finding.code === "insecure-auth-url-unsupported"), true);
  });
});

describe("selectPreferredMcpInstallTarget", () => {
  it("prefers streamable HTTP over SSE when both are installable", () => {
    const targets = registryDefToMcpInstallTargets({
      name: "multi-target",
      title: "Multi Target",
      description: "",
      installMode: "direct",
      installTargets: [
        { targetKind: "remote", transport: "sse", url: "https://example.com/sse" },
        { targetKind: "remote", transport: "streamable-http", url: "https://example.com/mcp" },
      ],
    });

    const selected = selectPreferredMcpInstallTarget(targets);

    assert.equal(selected.kind, "remote");
    assert.equal(selected.transport, "streamable-http");
  });

  it("returns needs-input targets when they are the best supported option", () => {
    const selected = registryDefToPreferredMcpInstallTarget({
      name: "npm-auth-demo",
      title: "npm Auth Demo",
      description: "",
      installMode: "package",
      installTargets: [{
        targetKind: "stdio",
        transport: { type: "stdio" },
        registryType: "npm",
        identifier: "@example/mcp-server",
        environmentVariables: [{ name: "EXAMPLE_TOKEN", isRequired: true, isSecret: true }],
      }],
    });

    assert.equal(selected.kind, "stdio");
    assert.equal(assessMcpInstallability(selected).status, "needs-input");
  });

  it("considers legacy apiKey fallback while selecting a preferred target", () => {
    const selected = registryDefToPreferredMcpInstallTarget({
      name: "auth-remote-plus-stdio",
      title: "Auth Remote Plus Stdio",
      description: "",
      installMode: "direct",
      installTargets: [
        {
          targetKind: "remote",
          transport: "streamable-http",
          url: "https://example.com/mcp",
          inputs: [{ key: "API_TOKEN", kind: "credential", required: true, secret: true }],
        },
        {
          targetKind: "stdio",
          transport: { type: "stdio" },
          command: "npx",
          args: ["-y", "@example/mcp-server"],
        },
      ],
    }, { apiKey: "legacy-key" });

    assert.equal(selected.kind, "remote");
    assert.equal(selected.transport, "streamable-http");
  });
});

describe("buildMcpConfigForInstallTarget", () => {
  it("writes streamable HTTP config with platform auth shape", () => {
    const [target] = registryDefToMcpInstallTargets({
      name: "remote-auth",
      title: "Remote Auth",
      description: "",
      installMode: "direct",
      serverUrl: "https://example.com/mcp",
      requiresAuth: true,
    });

    const result = buildMcpConfigForInstallTarget(target, "codex", { apiKey: "ask_test" });

    assert.equal(result.success, true);
    assert.equal(result.entry.url, "https://example.com/mcp");
    assert.equal(result.entry.http_headers.Authorization, "Bearer ask_test");
  });

  it("prefers explicit structured remote credential over legacy apiKey fallback", () => {
    const [target] = registryDefToMcpInstallTargets({
      name: "remote-auth",
      title: "Remote Auth",
      description: "",
      installMode: "direct",
      installTargets: [{
        targetKind: "remote",
        transport: "streamable-http",
        url: "https://example.com/mcp",
        inputs: [{ key: "API_TOKEN", kind: "credential", required: true, secret: true }],
      }],
    });

    const result = buildMcpConfigForInstallTarget(target, "codex", {
      apiKey: "legacy-token",
      inputs: { API_TOKEN: "explicit-token" },
    });

    assert.equal(result.success, true);
    assert.equal(result.entry.http_headers.Authorization, "Bearer explicit-token");
  });

  it("returns structured unsupported output for SSE targets", () => {
    const [target] = registryDefToMcpInstallTargets({
      name: "sse-demo",
      title: "SSE Demo",
      description: "",
      installMode: "direct",
      transport: "sse",
      serverUrl: "https://example.com/sse",
    });

    const result = buildMcpConfigForInstallTarget(target, "codex");

    assert.equal(result.success, false);
    assert.equal(result.errorCode, "remote-sse-unsupported");
  });

  it("writes SSE config for platforms that can represent SSE directly", () => {
    const [target] = registryDefToMcpInstallTargets({
      name: "sse-demo",
      title: "SSE Demo",
      description: "",
      installMode: "direct",
      transport: "sse",
      serverUrl: "https://example.com/sse",
    });

    const claude = buildMcpConfigForInstallTarget(target, "claude-code");
    const vscode = buildMcpConfigForInstallTarget(target, "vscode");

    assert.equal(claude.success, true);
    assert.equal(claude.transport, "sse");
    assert.equal(claude.entry.url, "https://example.com/sse");
    assert.equal(claude.entry.type, "sse");
    assert.equal(vscode.success, true);
    assert.equal(vscode.entry.url, "https://example.com/sse");
    assert.equal(vscode.entry.type, "sse");
  });

  it("writes npm stdio targets with provided env input", () => {
    const [target] = registryDefToMcpInstallTargets({
      name: "npm-auth-demo",
      title: "npm Auth Demo",
      description: "",
      installMode: "package",
      installTargets: [{
        targetKind: "stdio",
        transport: { type: "stdio" },
        registryType: "npm",
        identifier: "@example/mcp-server",
        environmentVariables: [{ name: "EXAMPLE_TOKEN", isRequired: true, isSecret: true }],
      }],
    });

    const result = buildMcpConfigForInstallTarget(target, "claude-code", {
      inputs: { EXAMPLE_TOKEN: "secret" },
    });

    assert.equal(result.success, true);
    if (process.platform === "win32") {
      assert.equal(result.entry.command, "cmd");
      assert.deepEqual(result.entry.args.slice(0, 4), ["/c", "npx", "-y", "@example/mcp-server"]);
    } else {
      assert.equal(result.entry.command, "npx");
      assert.deepEqual(result.entry.args, ["-y", "@example/mcp-server"]);
    }
    assert.equal(result.entry.env.EXAMPLE_TOKEN, "secret");
  });

  it("writes PyPI and OCI stdio projections", () => {
    const [pypi] = registryDefToMcpInstallTargets({
      name: "pypi-demo",
      title: "PyPI Demo",
      description: "",
      installMode: "package",
      installTargets: [{
        targetKind: "stdio",
        transport: { type: "stdio" },
        registryType: "pypi",
        identifier: "example-mcp",
      }],
    });
    const [oci] = registryDefToMcpInstallTargets({
      name: "oci-demo",
      title: "OCI Demo",
      description: "",
      installMode: "package",
      installTargets: [{
        targetKind: "stdio",
        transport: { type: "stdio" },
        registryType: "oci",
        identifier: "ghcr.io/example/mcp:1.0.0",
      }],
    });

    const pypiResult = buildMcpConfigForInstallTarget(pypi, "claude-code");
    const ociResult = buildMcpConfigForInstallTarget(oci, "claude-code");

    assert.equal(pypiResult.success, true);
    assert.equal(ociResult.success, true);
    const pypiArgs = process.platform === "win32" ? pypiResult.entry.args.slice(1) : [pypiResult.entry.command, ...pypiResult.entry.args];
    const ociArgs = process.platform === "win32" ? ociResult.entry.args.slice(1) : [ociResult.entry.command, ...ociResult.entry.args];
    assert.deepEqual(pypiArgs, ["uvx", "example-mcp"]);
    assert.deepEqual(ociArgs, ["docker", "run", "--rm", "-i", "ghcr.io/example/mcp:1.0.0"]);
  });

  it("reports missing input before writing stdio config", () => {
    const [target] = registryDefToMcpInstallTargets({
      name: "npm-auth-demo",
      title: "npm Auth Demo",
      description: "",
      installMode: "direct",
      transport: "stdio",
      stdioCommand: "npx",
      stdioArgs: ["-y", "@example/mcp-server"],
      envKey: "EXAMPLE_TOKEN",
    });

    const result = buildMcpConfigForInstallTarget(target, "claude-code");

    assert.equal(result.success, false);
    assert.equal(result.status, "needs-input");
    assert.equal(result.requiredInputs[0].key, "EXAMPLE_TOKEN");
  });

  it("writes all provided stdio env inputs and non-secret defaults", () => {
    const [target] = registryDefToMcpInstallTargets({
      name: "multi-input-demo",
      title: "Multi Input Demo",
      description: "",
      installMode: "package",
      installTargets: [{
        targetKind: "stdio",
        transport: { type: "stdio" },
        registryType: "npm",
        identifier: "@example/mcp-server",
        environmentVariables: [
          { name: "TENANT_ID", isRequired: true, isSecret: false },
          { name: "API_TOKEN", isRequired: true, isSecret: true },
          { name: "SECOND_TOKEN", isRequired: true, isSecret: true },
          { name: "REGION", isRequired: false, isSecret: false, default: "us" },
        ],
      }],
    });

    const result = buildMcpConfigForInstallTarget(target, "claude-code", {
      inputs: {
        TENANT_ID: "tenant-1",
        API_TOKEN: "secret-1",
        SECOND_TOKEN: "secret-2",
      },
      apiKey: "legacy-single-key",
    });

    assert.equal(result.success, true);
    assert.equal(result.entry.env.TENANT_ID, "tenant-1");
    assert.equal(result.entry.env.API_TOKEN, "secret-1");
    assert.equal(result.entry.env.SECOND_TOKEN, "secret-2");
    assert.equal(result.entry.env.REGION, "us");
  });

  it("rejects unsafe stdio commands before writing config", () => {
    const [target] = registryDefToMcpInstallTargets({
      name: "unsafe-command-demo",
      title: "Unsafe Command Demo",
      description: "",
      installMode: "direct",
      transport: "stdio",
      stdioCommand: "node & echo unsafe",
      stdioArgs: ["server.js"],
    });

    const result = buildMcpConfigForInstallTarget(target, "claude-code");

    assert.equal(result.success, false);
    assert.equal(result.errorCode, "stdio-command-unsafe");
  });
});

describe("deriveMcpRuntimeRequirements", () => {
  it("derives Node and npx for npm stdio targets", () => {
    const [target] = registryDefToMcpInstallTargets({
      name: "npm-demo",
      title: "npm Demo",
      description: "",
      installMode: "direct",
      transport: "stdio",
      stdioCommand: "npx",
      stdioArgs: ["-y", "@example/mcp-server"],
    });

    const requirements = deriveMcpRuntimeRequirements(target);

    assert.deepEqual(requirements.map((req) => req.key), ["node", "npx"]);
  });

  it("derives Docker CLI and daemon separately for OCI stdio targets", () => {
    const [target] = registryDefToMcpInstallTargets({
      name: "oci-demo",
      title: "OCI Demo",
      description: "",
      installMode: "package",
      installTargets: [{
        targetKind: "stdio",
        transport: { type: "stdio" },
        registryType: "oci",
        identifier: "ghcr.io/example/mcp:1.0.0",
      }],
    });

    const requirements = deriveMcpRuntimeRequirements(target);

    assert.deepEqual(requirements.map((req) => req.key), ["docker-cli", "docker-daemon"]);
  });

  it("does not require caller input for defaulted non-secret env values", () => {
    const [target] = registryDefToMcpInstallTargets({
      name: "default-env-demo",
      title: "Default Env Demo",
      description: "",
      installMode: "package",
      installTargets: [{
        targetKind: "stdio",
        transport: { type: "stdio" },
        registryType: "npm",
        identifier: "@example/mcp-server",
        environmentVariables: [
          { name: "REGION", isRequired: true, isSecret: false, default: "us" },
        ],
      }],
    });

    const requirements = deriveMcpRuntimeRequirements(target);

    assert.equal(requirements.some((req) => req.key === "input:REGION"), false);
  });
});

describe("assessMcpRuntimeReadiness", () => {
  it("returns not-needed for remote MCP targets", async () => {
    const [target] = registryDefToMcpInstallTargets({
      name: "remote-demo",
      title: "Remote Demo",
      description: "",
      installMode: "direct",
      serverUrl: "https://example.com/mcp",
    });

    const report = await assessMcpRuntimeReadiness(target);

    assert.equal(report.status, "not-needed");
    assert.equal(report.checks.length, 0);
  });

  it("checks npm stdio runtime and required credential presence", async () => {
    const [target] = registryDefToMcpInstallTargets({
      name: "npm-auth-demo",
      title: "npm Auth Demo",
      description: "",
      installMode: "direct",
      transport: "stdio",
      stdioCommand: "npx",
      stdioArgs: ["-y", "@example/mcp-server"],
      envKey: "EXAMPLE_TOKEN",
    });

    const missing = await assessMcpRuntimeReadiness(target, {
      env: {},
      findExecutable: (cmd) => cmd === "node" || cmd === "npx" ? `/usr/bin/${cmd}` : null,
      runCommand: async () => ({ exitCode: 0, stdout: "1.0.0\n" }),
    });
    assert.equal(missing.status, "needs-input");

    const ready = await assessMcpRuntimeReadiness(target, {
      env: { EXAMPLE_TOKEN: "secret" },
      findExecutable: (cmd) => cmd === "node" || cmd === "npx" ? `/usr/bin/${cmd}` : null,
      runCommand: async () => ({ exitCode: 0, stdout: "1.0.0\n" }),
    });
    assert.equal(ready.status, "ready");
  });

  it("distinguishes missing uvx from Docker daemon unreachable", async () => {
    const [pypiTarget] = registryDefToMcpInstallTargets({
      name: "pypi-demo",
      title: "PyPI Demo",
      description: "",
      installMode: "package",
      installTargets: [{
        targetKind: "stdio",
        transport: { type: "stdio" },
        registryType: "pypi",
        identifier: "example-mcp",
      }],
    });

    const pypiReport = await assessMcpRuntimeReadiness(pypiTarget, {
      findExecutable: () => null,
    });
    assert.equal(pypiReport.status, "missing-runtime");
    assert.equal(pypiReport.checks[0].requirement.key, "uvx");

    const [dockerTarget] = registryDefToMcpInstallTargets({
      name: "oci-demo",
      title: "OCI Demo",
      description: "",
      installMode: "package",
      installTargets: [{
        targetKind: "stdio",
        transport: { type: "stdio" },
        registryType: "oci",
        identifier: "ghcr.io/example/mcp:1.0.0",
      }],
    });

    const dockerReport = await assessMcpRuntimeReadiness(dockerTarget, {
      findExecutable: (cmd) => cmd === "docker" ? "/usr/bin/docker" : null,
      allowDockerDaemonProbe: true,
      runCommand: async (_cmd, args) => args[0] === "info"
        ? { exitCode: 1, stderr: "Cannot connect to the Docker daemon" }
        : { exitCode: 0, stdout: "Docker version 1.0.0" },
    });

    assert.equal(dockerReport.status, "runtime-unreachable");
    assert.equal(dockerReport.checks.find((check) => check.requirement.key === "docker-daemon").status, "unreachable");
  });

  it("does not run Docker daemon probes unless explicitly allowed", async () => {
    const [dockerTarget] = registryDefToMcpInstallTargets({
      name: "oci-demo",
      title: "OCI Demo",
      description: "",
      installMode: "package",
      installTargets: [{
        targetKind: "stdio",
        transport: { type: "stdio" },
        registryType: "oci",
        identifier: "ghcr.io/example/mcp:1.0.0",
      }],
    });
    const commands = [];

    const report = await assessMcpRuntimeReadiness(dockerTarget, {
      findExecutable: (cmd) => cmd === "docker" ? "/usr/bin/docker" : null,
      runCommand: async (_cmd, args) => {
        commands.push(args[0]);
        return { exitCode: 0, stdout: "Docker version 1.0.0" };
      },
    });

    assert.equal(report.status, "not-checked");
    assert.deepEqual(commands, ["--version"]);
    assert.equal(report.checks.find((check) => check.requirement.key === "docker-daemon").status, "unknown");
  });

  it("does not shell out for unsafe command names during passive runtime checks", async () => {
    const [target] = registryDefToMcpInstallTargets({
      name: "unsafe-command-demo",
      title: "Unsafe Command Demo",
      description: "",
      installMode: "direct",
      transport: "stdio",
      stdioCommand: "node & echo unsafe",
      stdioArgs: ["server.js"],
    });
    let lookedUp = false;
    let ran = false;

    const report = await assessMcpRuntimeReadiness(target, {
      findExecutable: () => {
        lookedUp = true;
        return "/usr/bin/node";
      },
      runCommand: async () => {
        ran = true;
        return { exitCode: 0, stdout: "ok" };
      },
    });

    assert.equal(report.status, "not-checked");
    assert.equal(lookedUp, false);
    assert.equal(ran, false);
  });

  it("passes only a sanitized environment to runtime command checks", async () => {
    const [target] = registryDefToMcpInstallTargets({
      name: "npm-auth-demo",
      title: "npm Auth Demo",
      description: "",
      installMode: "direct",
      transport: "stdio",
      stdioCommand: "npx",
      stdioArgs: ["-y", "@example/mcp-server"],
      envKey: "EXAMPLE_TOKEN",
    });
    const seenEnvs = [];

    const report = await assessMcpRuntimeReadiness(target, {
      env: {
        PATH: "/usr/bin",
        EXAMPLE_TOKEN: "secret",
        EQUIP_BRIDGE_TOKEN: "bridge-secret",
      },
      findExecutable: (cmd) => cmd === "node" || cmd === "npx" ? `/usr/bin/${cmd}` : null,
      runCommand: async (_cmd, _args, options) => {
        seenEnvs.push(options.env);
        return { exitCode: 0, stdout: "1.0.0\n" };
      },
    });

    assert.equal(report.status, "ready");
    assert.equal(seenEnvs.length, 2);
    assert.equal(seenEnvs.every((env) => env.PATH === "/usr/bin"), true);
    assert.equal(seenEnvs.some((env) => Object.hasOwn(env, "EXAMPLE_TOKEN")), false);
    assert.equal(seenEnvs.some((env) => Object.hasOwn(env, "EQUIP_BRIDGE_TOKEN")), false);
  });

  it("uses the resolved Windows shim path for passive runtime checks", {
    skip: process.platform !== "win32" && "Windows shim resolution regression test",
  }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "equip-win-shim-"));
    const workspace = path.join(root, "workspace");
    const safeBin = path.join(root, "safe bin with spaces");
    const marker = path.join(root, "shadow-ran.txt");
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(safeBin, { recursive: true });
    fs.writeFileSync(
      path.join(workspace, "uvx.cmd"),
      `@echo off\r\necho shadow > "${marker}"\r\nexit /b 9\r\n`,
    );
    fs.writeFileSync(
      path.join(safeBin, "uvx.cmd"),
      "@echo off\r\necho uvx 1.0.0\r\nexit /b 0\r\n",
    );

    const previousCwd = process.cwd();
    try {
      process.chdir(workspace);
      const [target] = registryDefToMcpInstallTargets({
        name: "pypi-demo",
        title: "PyPI Demo",
        description: "",
        installMode: "package",
        installTargets: [{
          targetKind: "stdio",
          transport: { type: "stdio" },
          registryType: "pypi",
          identifier: "example-mcp",
        }],
      });

      const report = await assessMcpRuntimeReadiness(target, {
        env: {
          PATH: safeBin,
          PATHEXT: ".CMD",
          SYSTEMROOT: process.env.SYSTEMROOT,
          WINDIR: process.env.WINDIR,
        },
      });

      assert.equal(report.status, "ready");
      assert.equal(fs.existsSync(marker), false, "current-directory shim must not shadow the resolved PATH entry");
    } finally {
      process.chdir(previousCwd);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("builds a combined readiness report without running an MCP server", async () => {
    const [target] = registryDefToMcpInstallTargets({
      name: "remote-demo",
      title: "Remote Demo",
      description: "",
      installMode: "direct",
      serverUrl: "https://example.com/mcp",
    });

    const report = await assessMcpReadiness(target);

    assert.equal(report.target.kind, "remote");
    assert.equal(report.configure.status, "installable");
    assert.equal(report.runtime.status, "not-needed");
    assert.equal(report.probe.status, "not-run");
  });

  it("summarizes targets without raw auth, header, or env material", () => {
    const [target] = registryDefToMcpInstallTargets({
      name: "redacted-target",
      title: "Redacted Target",
      description: "",
      installMode: "direct",
      installTargets: [{
        targetKey: "token-abc123",
        targetKind: "remote",
        transport: "streamable-http",
        url: "https://user:pass@example.com/mcp?token=abc123",
        headers: {
          Authorization: "Bearer abc123",
        },
        auth: { type: "api_key", keyEnvVar: "EXAMPLE_TOKEN", secret: "abc123" },
        requiresAuth: true,
      }],
    });

    const summary = summarizeMcpInstallTarget(target);
    const encoded = JSON.stringify(summary);

    assert.equal(target.targetKey.includes("abc123"), false);
    assert.equal(encoded.includes("abc123"), false);
    assert.equal(encoded.includes("Authorization"), false);
    assert.equal(summary.remote.url, "https://example.com/mcp?token=%5Bredacted%5D");
  });
});
