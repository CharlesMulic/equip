import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  assessMcpRuntimeReadiness,
  registryDefToMcpInstallTargets,
} from "../../dist/lib/mcp-readiness.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const casesPath = path.join(__dirname, "fixtures", "live-mcp-registry-cases.json");
const caseFixture = JSON.parse(fs.readFileSync(casesPath, "utf-8"));

function listen(server) {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address()));
    server.on("error", reject);
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["bin/equip.js", ...args], {
      cwd: repoRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => resolve({ code, stdout, stderr, output: `${stdout}${stderr}` }));
  });
}

async function fetchOfficialServer(registryBaseUrl, item) {
  const encodedName = encodeURIComponent(item.serverName);
  const encodedVersion = encodeURIComponent(item.version || "latest");
  const url = `${registryBaseUrl.replace(/\/+$/, "")}/v0.1/servers/${encodedName}/versions/${encodedVersion}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
    const body = await res.json();
    return body.server;
  } finally {
    clearTimeout(timeout);
  }
}

function selectRemote(server, item) {
  const remotes = Array.isArray(server.remotes) ? server.remotes : [];
  return remotes.find(remote => remote.type === item.target.transport) || null;
}

function selectPackage(server, item) {
  const packages = Array.isArray(server.packages) ? server.packages : [];
  return packages.find(pkg =>
    pkg.registryType === item.target.registryType &&
    pkg.transport?.type === item.target.transport
  ) || null;
}

function hasUnresolvedVariables(input) {
  if (!input) return false;
  if (input.variables && Object.keys(input.variables).length > 0) return true;
  return typeof input.value === "string" && /\{[^}]+\}/.test(input.value);
}

function isRequiredWithoutDefault(input) {
  return input?.isRequired === true && input.default === undefined && input.value === undefined;
}

function buildEnvPlan(envVars, item) {
  const vars = Array.isArray(envVars) ? envVars : [];
  const secretVars = vars.filter(variable => variable.isSecret === true);
  const omittedPlainVars = vars.filter(variable =>
    variable.isSecret !== true &&
    (variable.default !== undefined || variable.value !== undefined)
  );
  const requiredPlainVars = vars.filter(variable =>
    variable.isSecret !== true &&
    variable.isRequired === true &&
    variable.default === undefined &&
    variable.value === undefined
  );

  if (requiredPlainVars.length > 0) {
    return {
      supported: false,
      reason: "required-env-without-auth-value",
      detail: `Required non-secret env vars are not representable in Equip RegistryDef today: ${requiredPlainVars.map(v => v.name).join(", ")}`,
    };
  }

  const warnings = omittedPlainVars.map(variable => ({
    code: "static-env-omitted",
    detail: `Static/default env var ${variable.name} is present in registry metadata but cannot be represented by today's one-envKey RegistryDef shape.`,
  }));

  if (secretVars.length > 1) {
    return {
      supported: false,
      reason: "multiple-secret-env-values",
      detail: `Multiple secret env vars require a multi-credential config surface: ${secretVars.map(v => v.name).join(", ")}`,
    };
  }

  if (secretVars.length === 1) {
    const keyEnvVar = secretVars[0].name;
    if (!item.credential?.apiKey) {
      return {
        supported: false,
        reason: "secret-env-needs-test-credential",
        detail: `${keyEnvVar} is secret and this canary case did not provide a test credential.`,
      };
    }
    return {
      supported: true,
      keyEnvVar,
      warnings,
      auth: {
        type: "api_key",
        keyEnvVar,
        keyPrompt: `Enter ${keyEnvVar}`,
      },
    };
  }

  return { supported: true, warnings };
}

function appendSimpleArguments(args, packageArguments) {
  const inputs = Array.isArray(packageArguments) ? packageArguments : [];
  for (const input of inputs) {
    if (hasUnresolvedVariables(input)) {
      return {
        supported: false,
        reason: "package-argument-variable",
        detail: `Package argument ${input.name || input.valueHint || "unknown"} requires user variable substitution.`,
      };
    }
    if (isRequiredWithoutDefault(input)) {
      return {
        supported: false,
        reason: "required-package-argument",
        detail: `Package argument ${input.name || input.valueHint || "unknown"} is required and has no default.`,
      };
    }
    const value = input.value ?? input.default;
    if (value === undefined) continue;
    if (input.type === "named" && input.name) args.push(input.name);
    args.push(String(value));
  }
  return { supported: true };
}

function appendDockerRuntimeArguments(args, runtimeArguments, item) {
  const inputs = Array.isArray(runtimeArguments) ? runtimeArguments : [];
  let keyEnvVar = null;
  let auth = null;

  for (const input of inputs) {
    const variableNames = input.variables ? Object.keys(input.variables) : [];
    const variableValues = input.variables ? Object.values(input.variables) : [];
    const singleSecretVariable = variableNames.length === 1 && variableValues[0]?.isSecret === true;
    const envAssignment = typeof input.value === "string"
      ? /^([A-Za-z_][A-Za-z0-9_]*)=\{[^}]+\}$/.exec(input.value)
      : null;

    if (input.type === "named" && input.name && envAssignment && singleSecretVariable) {
      keyEnvVar = envAssignment[1];
      if (!item.credential?.apiKey) {
        return {
          supported: false,
          reason: "secret-runtime-argument-needs-test-credential",
          detail: `${keyEnvVar} is secret and this canary case did not provide a test credential.`,
        };
      }
      args.push(input.name, keyEnvVar);
      auth = {
        type: "api_key",
        keyEnvVar,
        keyPrompt: `Enter ${keyEnvVar}`,
      };
      continue;
    }

    if (hasUnresolvedVariables(input)) {
      return {
        supported: false,
        reason: "runtime-argument-variable",
        detail: `Runtime argument ${input.name || input.valueHint || "unknown"} requires user variable substitution.`,
      };
    }

    if (isRequiredWithoutDefault(input)) {
      return {
        supported: false,
        reason: "required-runtime-argument",
        detail: `Runtime argument ${input.name || input.valueHint || "unknown"} is required and has no default.`,
      };
    }

    const value = input.value ?? input.default;
    if (value === undefined) continue;
    if (input.type === "named" && input.name) args.push(input.name);
    args.push(String(value));
  }

  return { supported: true, keyEnvVar, auth };
}

function convertRemote(server, remote, item) {
  if (!remote) {
    return unsupported(item, "target-not-found", `Remote ${item.target.transport} not found on ${item.serverName}.`);
  }
  if (remote.type !== "streamable-http" && remote.type !== "sse") {
    return unsupported(item, "remote-transport", `Unsupported remote transport ${remote.type}.`);
  }
  if (remote.variables && Object.keys(remote.variables).length > 0) {
    return unsupported(item, "remote-url-variables", "Remote URL template variables need a caller-provided variable collection flow.");
  }

  const headers = Array.isArray(remote.headers) ? remote.headers : [];
  let auth = { type: "none" };
  if (headers.length > 0) {
    const authorizationOnly = headers.length === 1 && headers[0].name?.toLowerCase() === "authorization" && headers[0].isSecret === true;
    if (!authorizationOnly) {
      return unsupported(item, "remote-custom-headers", "Only Authorization bearer-style remote headers are representable by Equip direct-mode installs today.");
    }
    if (!item.credential?.apiKey) {
      return unsupported(item, "remote-authorization-needs-test-credential", "Authorization header requires a test credential for this canary case.");
    }
    auth = {
      type: "api_key",
      keyEnvVar: "MCP_AUTHORIZATION_TOKEN",
      keyPrompt: "Enter remote MCP authorization token",
    };
  }

  return supported(item, server, {
    transport: remote.type === "sse" ? "sse" : "http",
    serverUrl: remote.url,
    auth,
    platforms: remote.type === "sse" ? ["claude-code", "vscode"] : undefined,
    selectedTarget: {
      kind: "remote",
      type: remote.type,
      url: remote.url,
      headerNames: headers.map(header => header.name),
    },
  });
}

function convertPackage(server, pkg, item) {
  if (!pkg) {
    return unsupported(item, "target-not-found", `Package ${item.target.registryType}/${item.target.transport} not found on ${item.serverName}.`);
  }
  if (pkg.transport?.type !== "stdio") {
    return unsupported(item, "package-non-stdio-transport", "Equip can install remote streamable HTTP URLs or local stdio commands, but not package-launched HTTP servers.");
  }

  const packageArgs = [];
  const packageArgResult = appendSimpleArguments(packageArgs, pkg.packageArguments);
  if (!packageArgResult.supported) return unsupported(item, packageArgResult.reason, packageArgResult.detail);

  if (pkg.registryType === "npm") {
    const envPlan = buildEnvPlan(pkg.environmentVariables, item);
    if (!envPlan.supported) return unsupported(item, envPlan.reason, envPlan.detail);

    const packageSpec = pkg.version ? `${pkg.identifier}@${pkg.version}` : pkg.identifier;
    return supported(item, server, {
      transport: "stdio",
      stdioCommand: pkg.runtimeHint || "npx",
      stdioArgs: ["-y", packageSpec, ...packageArgs],
      envKey: envPlan.keyEnvVar,
      auth: envPlan.auth || { type: "none" },
      warnings: envPlan.warnings,
      selectedTarget: {
        kind: "package",
        registryType: pkg.registryType,
        identifier: pkg.identifier,
        version: pkg.version,
        transport: pkg.transport?.type,
      },
    });
  }

  if (pkg.registryType === "pypi") {
    const envPlan = buildEnvPlan(pkg.environmentVariables, item);
    if (!envPlan.supported) return unsupported(item, envPlan.reason, envPlan.detail);

    const packageSpec = pkg.version ? `${pkg.identifier}==${pkg.version}` : pkg.identifier;
    return supported(item, server, {
      transport: "stdio",
      stdioCommand: pkg.runtimeHint || "uvx",
      stdioArgs: [packageSpec, ...packageArgs],
      envKey: envPlan.keyEnvVar,
      auth: envPlan.auth || { type: "none" },
      warnings: envPlan.warnings,
      selectedTarget: {
        kind: "package",
        registryType: pkg.registryType,
        identifier: pkg.identifier,
        version: pkg.version,
        transport: pkg.transport?.type,
      },
    });
  }

  if (pkg.registryType === "oci") {
    const dockerArgs = ["run", "--rm", "-i"];
    const envPlan = buildEnvPlan(pkg.environmentVariables, item);
    if (!envPlan.supported) return unsupported(item, envPlan.reason, envPlan.detail);
    if (envPlan.keyEnvVar) dockerArgs.push("-e", envPlan.keyEnvVar);

    const runtimeResult = appendDockerRuntimeArguments(dockerArgs, pkg.runtimeArguments, item);
    if (!runtimeResult.supported) return unsupported(item, runtimeResult.reason, runtimeResult.detail);

    dockerArgs.push(pkg.identifier, ...packageArgs);
    const keyEnvVar = runtimeResult.keyEnvVar || envPlan.keyEnvVar;
    const auth = runtimeResult.auth || envPlan.auth || { type: "none" };

    return supported(item, server, {
      transport: "stdio",
      stdioCommand: pkg.runtimeHint || "docker",
      stdioArgs: dockerArgs,
      envKey: keyEnvVar,
      auth,
      warnings: envPlan.warnings,
      selectedTarget: {
        kind: "package",
        registryType: pkg.registryType,
        identifier: pkg.identifier,
        version: pkg.version,
        transport: pkg.transport?.type,
      },
    });
  }

  return unsupported(item, "package-registry-type", `Unsupported package registry type ${pkg.registryType}.`);
}

function convertCase(server, item) {
  if (item.expected?.support === "unsupported" && item.target.kind === "remote") {
    return convertRemote(server, selectRemote(server, item), item);
  }
  if (item.target.kind === "remote") {
    return convertRemote(server, selectRemote(server, item), item);
  }
  if (item.target.kind === "package") {
    return convertPackage(server, selectPackage(server, item), item);
  }
  return unsupported(item, "target-kind", `Unsupported target kind ${item.target.kind}.`);
}

function supported(item, server, fields) {
  const def = {
    name: item.installName,
    title: server.title || item.installName,
    description: server.description || `MCP registry server ${item.serverName}`,
    homepage: server.websiteUrl,
    repository: server.repository?.url,
    installMode: "direct",
    listed: true,
    status: "active",
    registryStatus: "active",
    reviewStatus: "approved",
    trustTier: "reviewed",
    tags: ["mcp-registry-live-canary", item.target.kind, item.target.transport].filter(Boolean),
    transport: fields.transport,
    serverUrl: fields.serverUrl,
    stdioCommand: fields.stdioCommand,
    stdioArgs: fields.stdioArgs,
    envKey: fields.envKey,
    auth: fields.auth || { type: "none" },
    platformHints: {
      "claude-code": `Installed from official MCP registry server ${item.serverName}.`,
      codex: `Installed from official MCP registry server ${item.serverName}.`,
    },
  };

  return {
    id: item.id,
    installName: item.installName,
    serverName: item.serverName,
    version: server.version,
    support: "install",
    def,
    platforms: fields.platforms || null,
    selectedTarget: fields.selectedTarget,
    credential: item.credential || null,
    warnings: fields.warnings || [],
  };
}

function unsupported(item, reason, detail) {
  return {
    id: item.id,
    installName: item.installName,
    serverName: item.serverName,
    support: "unsupported",
    reason,
    detail,
  };
}

function fakeCodeUserDir(homeDir) {
  if (process.platform === "win32") return path.join(homeDir, "AppData", "Roaming", "Code", "User");
  if (process.platform === "darwin") return path.join(homeDir, "Library", "Application Support", "Code", "User");
  return path.join(homeDir, ".config", "Code", "User");
}

function createFakePlatformHome(root) {
  const homeDir = path.join(root, "home");
  const codexHome = path.join(homeDir, ".codex");
  const appDataDir = path.join(homeDir, "AppData", "Roaming");
  const codeUserDir = fakeCodeUserDir(homeDir);
  fs.mkdirSync(path.join(homeDir, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(homeDir, ".cursor"), { recursive: true });
  fs.mkdirSync(path.join(homeDir, ".agents"), { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(codeUserDir, { recursive: true });
  fs.mkdirSync(path.join(codeUserDir, "globalStorage", "rooveterinaryinc.roo-cline", "settings"), { recursive: true });
  fs.writeFileSync(
    path.join(codeUserDir, "globalStorage", "rooveterinaryinc.roo-cline", "settings", "mcp_settings.json"),
    JSON.stringify({ mcpServers: {} }, null, 2) + "\n",
  );
  return { homeDir, codexHome, appDataDir, codeUserDir };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

function assertPlatformEntry(homeDir, codexHome, codeUserDir, platform, installName, def, item) {
  if (platform === "codex") {
    const toml = fs.readFileSync(path.join(codexHome, "config.toml"), "utf-8");
    assert.match(toml, new RegExp(`\\[mcp_servers\\.${installName}\\]`));
    const entry = parseCodexEntry(toml, installName);
    if (def.transport === "stdio") {
      assertStdioCommand(entry, def, platform);
      if (def.envKey) {
        assert.match(toml, new RegExp(`\\[mcp_servers\\.${installName}\\.env\\]`));
        assert.equal(entry.env?.[def.envKey], expectedCredentialForEnvKey(def.envKey), `${platform} env credential`);
      }
    } else {
      assert.equal(entry.url, def.serverUrl, `${platform} remote URL`);
      if (def.auth?.type === "api_key") {
        assert.match(toml, new RegExp(`\\[mcp_servers\\.${installName}\\.http_headers\\]`));
        assert.equal(entry.http_headers?.Authorization, `Bearer ${item.credential.apiKey}`, `${platform} auth header`);
      }
    }
    return;
  }

  const platformConfig = {
    "claude-code": { file: path.join(homeDir, ".claude.json"), root: "mcpServers" },
    cursor: { file: path.join(homeDir, ".cursor", "mcp.json"), root: "mcpServers" },
    vscode: { file: path.join(codeUserDir, "mcp.json"), root: "servers" },
    "roo-code": {
      file: path.join(codeUserDir, "globalStorage", "rooveterinaryinc.roo-cline", "settings", "mcp_settings.json"),
      root: "mcpServers",
    },
  }[platform];

  const data = readJson(platformConfig.file);
  const entry = data?.[platformConfig.root]?.[installName];
  assert.ok(entry, `${platform} should have ${installName}`);
  if (def.transport === "stdio") {
    assertStdioCommand(entry, def, platform);
    if (def.envKey) {
      assert.equal(entry.env?.[def.envKey], expectedCredentialForEnvKey(def.envKey), `${platform} env credential`);
    } else {
      assert.deepEqual(entry.env || {}, {}, `${platform} env should be empty`);
    }
  } else {
    const actualUrl = entry.url || entry.serverUrl || entry.httpUrl;
    assert.equal(actualUrl, def.serverUrl, `${platform} remote URL`);
    if (platform === "claude-code" || platform === "vscode") {
      assert.equal(entry.type, def.transport === "sse" ? "sse" : "http", `${platform} remote type`);
    }
    if (platform === "roo-code") {
      assert.equal(entry.type, "streamable-http", `${platform} remote type`);
    }
    if (def.auth?.type === "api_key") {
      assert.equal(entry.headers?.Authorization, `Bearer ${item.credential.apiKey}`, `${platform} auth header`);
    } else {
      assert.equal(entry.headers, undefined, `${platform} should not have auth headers`);
    }
  }
}

function assertStdioCommand(entry, def, platform) {
  if (process.platform === "win32") {
    assert.equal(entry.command, "cmd", `${platform} Windows stdio wrapper command`);
    assert.deepEqual(entry.args, ["/c", def.stdioCommand, ...def.stdioArgs], `${platform} Windows stdio wrapper args`);
    return;
  }

  assert.equal(entry.command, def.stdioCommand, `${platform} stdio command`);
  assert.deepEqual(entry.args, def.stdioArgs, `${platform} stdio args`);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseCodexEntry(toml, installName) {
  const mainHeader = `[mcp_servers.${installName}]`;
  const prefix = `[mcp_servers.${installName}.`;
  const result = {};
  let active = null;

  for (const rawLine of toml.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[")) {
      if (line === mainHeader) {
        active = result;
      } else if (line.startsWith(prefix) && line.endsWith("]")) {
        const subName = line.slice(prefix.length, -1);
        result[subName] = result[subName] || {};
        active = result[subName];
      } else {
        active = null;
      }
      continue;
    }
    if (!active) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const rawValue = line.slice(eq + 1).trim();
    active[key] = parseTomlFixtureValue(rawValue);
  }

  return result;
}

function parseTomlFixtureValue(rawValue) {
  if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
    const inner = rawValue.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map(item => parseTomlFixtureValue(item.trim()));
  }
  if (
    (rawValue.startsWith("\"") && rawValue.endsWith("\"")) ||
    (rawValue.startsWith("'") && rawValue.endsWith("'"))
  ) {
    return rawValue.slice(1, -1).replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
  }
  return rawValue;
}

function expectedCredentialForEnvKey(envKey) {
  if (envKey === "CONTEXT7_API_KEY") return "test-context7-token";
  if (envKey === "GITHUB_PERSONAL_ACCESS_TOKEN") return "test-github-token";
  if (envKey === "ARMOR_API_KEY") return "test-armor-token";
  if (envKey === "FODDA_API_KEY") return "test-fodda-token";
  if (envKey === "LINKGUARD_API_KEY") return "test-linkguard-token";
  throw new Error(`No fixture credential expectation for ${envKey}`);
}

function runProbe(command, args, timeoutMs = 10_000) {
  return new Promise((resolve) => {
    const useWindowsShimShell = process.platform === "win32" && ["docker", "npx", "uvx"].includes(command);
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: process.env,
      shell: useWindowsShimShell,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve({
        command,
        args,
        ok: false,
        timedOut: true,
        stdout,
        stderr,
        error: `Timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", error => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({
        command,
        args,
        ok: false,
        stdout,
        stderr,
        error: error.message,
      });
    });
    child.on("close", code => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({
        command,
        args,
        ok: code === 0,
        code,
        stdout,
        stderr,
      });
    });
  });
}

async function assessRuntimeReadiness(supported) {
  const entries = [];
  for (const item of supported.filter(entry => entry.def.transport === "stdio")) {
    const [target] = registryDefToMcpInstallTargets(item.def);
    const report = await assessMcpRuntimeReadiness(target, {
      allowDockerDaemonProbe: true,
      runCommand: async (command, args, options) => {
        const probe = await runProbe(command, args, options.timeoutMs);
        return {
          exitCode: probe.code ?? (probe.ok ? 0 : 1),
          stdout: probe.stdout,
          stderr: probe.stderr,
          timedOut: probe.timedOut,
          error: probe.error,
        };
      },
    });
    const commandChecks = report.checks.filter(check => !["credential", "input"].includes(check.requirement.kind));
    const primaryCheck = commandChecks.find(check => check.requirement.command === item.def.stdioCommand) || commandChecks[0];
    const dockerDaemon = commandChecks.find(check => check.requirement.kind === "docker-daemon");
    const entry = {
      installName: item.installName,
      targetKey: target.targetKey,
      command: item.def.stdioCommand,
      status: report.status,
      available: commandChecks.length === 0 || commandChecks.every(check => check.status !== "missing" && check.status !== "unknown"),
      versionOutput: String(primaryCheck?.evidence?.version || "").trim() || null,
      error: primaryCheck?.status === "ready" ? null : primaryCheck?.detail || report.summary,
      checks: report.checks.map(check => ({
        key: check.requirement.key,
        kind: check.requirement.kind,
        status: check.status,
        detail: check.detail,
      })),
    };
    if (dockerDaemon) {
      entry.daemonReachable = dockerDaemon.status === "ready";
      entry.daemonError = dockerDaemon.status === "ready" ? null : dockerDaemon.detail;
    }
    entries.push(entry);
  }
  return entries;
}

test("live MCP registry cases can be projected and installed into fake platform homes", async (t) => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "equip-live-mcp-registry-"));
  const { homeDir, codexHome, appDataDir, codeUserDir } = createFakePlatformHome(workspaceRoot);
  const registryBaseUrl = process.env.MCP_REGISTRY_BASE_URL || caseFixture.registryBaseUrl;
  const platforms = caseFixture.platforms;

  const fetched = await Promise.all(caseFixture.cases.map(async (item) => {
    const server = await fetchOfficialServer(registryBaseUrl, item);
    return convertCase(server, item);
  }));

  for (const item of fetched) {
    const expected = caseFixture.cases.find(c => c.id === item.id)?.expected;
    assert.equal(item.support, expected.support, `${item.id}: ${item.detail || ""}`);
    if (expected.reason) assert.equal(item.reason, expected.reason, item.detail);
  }

  const supported = fetched.filter(item => item.support === "install");
  assert.ok(supported.length >= 5, "canary should exercise several installable live registry cases");
  const runtimeReadiness = await assessRuntimeReadiness(supported);
  const runtimeReadinessByInstallName = new Map(runtimeReadiness.map(item => [item.installName, item]));
  if (process.env.EQUIP_MCP_REGISTRY_REQUIRE_RUNTIME_PREFLIGHT === "1") {
    for (const readiness of runtimeReadiness) {
      assert.equal(
        readiness.available,
        true,
        `runtime command ${readiness.command} should be available in the Docker canary image: ${readiness.error || ""}`,
      );
    }
  }

  const defs = new Map(supported.map(item => [item.installName, item.def]));
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url?.startsWith("/augments/")) {
      const name = decodeURIComponent(req.url.slice("/augments/".length));
      const def = defs.get(name);
      if (!def) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(def));
      return;
    }

    if (req.method === "POST" && req.url === "/telemetry") {
      req.resume();
      res.writeHead(204);
      res.end();
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  const address = await listen(server);
  t.after(async () => {
    await closeServer(server);
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  const env = {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    APPDATA: appDataDir,
    CODEX_HOME: codexHome,
    EQUIP_REGISTRY_URL: `http://127.0.0.1:${address.port}`,
    NO_COLOR: "1",
    FORCE_COLOR: "0",
  };

  for (const item of supported) {
    const args = [
      item.installName,
      "--platform",
      (item.platforms || platforms).join(","),
      "--non-interactive",
    ];
    const readiness = runtimeReadinessByInstallName.get(item.installName);
    const forceDockerConfigOnly = item.def.stdioCommand === "docker" && readiness?.daemonReachable === false;
    if (forceDockerConfigOnly) {
      args.push("--force");
    }
    let apiKeyFile = null;
    if (item.credential?.apiKey) {
      apiKeyFile = path.join(workspaceRoot, `${item.id}.key`);
      fs.writeFileSync(apiKeyFile, `${item.credential.apiKey}\n`, { mode: 0o600 });
      args.push("--api-key-file", apiKeyFile);
    }

    const result = await runCli(args, env);
    assert.equal(result.code, 0, `${item.id} failed:\n${result.output}`);
    assert.match(result.output, /Done\./, `${item.id} should complete`);
    if (forceDockerConfigOnly) {
      assert.match(result.output, /runtime is not ready/i, `${item.id} should explain the Docker daemon preflight override`);
      assert.match(result.output, /--force/i, `${item.id} should make the forced runtime override visible`);
    }
    if (item.credential?.apiKey) {
      assert.doesNotMatch(result.output, new RegExp(item.credential.apiKey), `${item.id} must not echo fixture credentials`);
      assert.ok(apiKeyFile, `${item.id} should use an api key file`);
    }

    for (const platform of (item.platforms || platforms)) {
      assertPlatformEntry(homeDir, codexHome, codeUserDir, platform, item.installName, item.def, item);
    }
  }

  const summary = {
    registryBaseUrl,
    platforms,
    installed: supported.map(item => ({
      id: item.id,
      installName: item.installName,
      serverName: item.serverName,
      version: item.version,
      selectedTarget: item.selectedTarget,
      transport: item.def.transport,
      platforms: item.platforms || platforms,
      stdioCommand: item.def.stdioCommand,
      stdioArgs: item.def.stdioArgs,
      serverUrl: item.def.serverUrl,
      envKey: item.def.envKey,
      warnings: item.warnings,
    })),
    unsupported: fetched.filter(item => item.support === "unsupported").map(item => ({
      id: item.id,
      installName: item.installName,
      serverName: item.serverName,
      reason: item.reason,
      detail: item.detail,
    })),
    runtimeReadiness,
  };

  if (process.env.EQUIP_MCP_REGISTRY_SPIKE_RESULTS) {
    fs.mkdirSync(path.dirname(process.env.EQUIP_MCP_REGISTRY_SPIKE_RESULTS), { recursive: true });
    fs.writeFileSync(process.env.EQUIP_MCP_REGISTRY_SPIKE_RESULTS, JSON.stringify(summary, null, 2) + "\n");
  }

  console.log(JSON.stringify(summary, null, 2));
});
