"use strict";

const { describe, it } = require("node:test");
const assert = require("assert/strict");

const {
  assessMcpInstallability,
  assessMcpReadiness,
  assessMcpRuntimeReadiness,
  deriveMcpRuntimeRequirements,
  registryDefToMcpInstallTargets,
  summarizeMcpInstallTarget,
} = require("../dist/lib/mcp-readiness");

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

  it("keeps SSE visible but unsupported", () => {
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
    assert.equal(report.status, "unsupported");
    assert.equal(report.findings[0].code, "remote-sse-unsupported");
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
