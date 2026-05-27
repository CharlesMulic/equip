import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { spawn } from "child_process";

export type McpInstallTargetKind = "remote" | "stdio" | "unsupported";
export type McpTransport = "streamable-http" | "sse" | "stdio" | "unknown";
export type McpInputKind = "credential" | "env" | "url-variable" | "header" | "arg-variable" | "plain";
export type McpInstallabilityStatus = "installable" | "needs-input" | "unsupported" | "unknown";
export type McpRuntimeRequirementKind =
  | "node"
  | "npx"
  | "npm"
  | "uvx"
  | "python"
  | "docker-cli"
  | "docker-daemon"
  | "executable"
  | "credential"
  | "input";
export type McpRuntimeCheckStatus =
  | "ready"
  | "missing"
  | "unreachable"
  | "needs-input"
  | "not-applicable"
  | "unknown";
export type McpRuntimeReadinessStatus =
  | "ready"
  | "not-needed"
  | "missing-runtime"
  | "runtime-unreachable"
  | "needs-input"
  | "not-checked";
export type McpProbeStatus = "not-run" | "passed" | "failed" | "blocked" | "skipped";

export interface McpTargetSource {
  kind: "registry" | "local" | "wrapped" | "manual" | "unknown";
  name?: string;
  version?: string | number;
  registryType?: string;
  contentHash?: string;
  raw?: unknown;
}

export interface McpInputRequirement {
  key: string;
  kind: McpInputKind;
  label: string;
  required: boolean;
  secret: boolean;
  description?: string;
  defaultValue?: string;
  substitutionUnsupported?: boolean;
}

interface McpInstallTargetBase {
  targetKey: string;
  label: string;
  name?: string;
  kind: McpInstallTargetKind;
  transport: McpTransport;
  source: McpTargetSource;
  inputs: McpInputRequirement[];
  requiresAuth?: boolean;
  auth?: Record<string, unknown> | null;
  raw?: unknown;
}

export interface McpRemoteInstallTarget extends McpInstallTargetBase {
  kind: "remote";
  transport: "streamable-http" | "sse";
  url: string;
  headers?: Record<string, string>;
}

export interface McpStdioInstallTarget extends McpInstallTargetBase {
  kind: "stdio";
  transport: "stdio";
  command: string;
  args: string[];
  env?: Record<string, string>;
  envKey?: string;
  packageRegistry?: string;
  packageName?: string;
}

export interface McpUnsupportedInstallTarget extends McpInstallTargetBase {
  kind: "unsupported";
  transport: McpTransport;
  reasonCode: string;
  detail: string;
}

export type McpInstallTarget =
  | McpRemoteInstallTarget
  | McpStdioInstallTarget
  | McpUnsupportedInstallTarget;

export interface McpReadinessFinding {
  code: string;
  severity: "info" | "warning" | "blocked";
  message: string;
  remediation?: string;
}

export interface McpInstallabilityReport {
  status: McpInstallabilityStatus;
  targetKey: string;
  summary: string;
  findings: McpReadinessFinding[];
  requiredInputs: McpInputRequirement[];
}

export interface McpRuntimeRequirement {
  key: string;
  kind: McpRuntimeRequirementKind;
  label: string;
  command?: string;
  args?: string[];
  inputKey?: string;
  required: boolean;
  remediation?: string;
}

export interface McpRuntimeReadinessCheck {
  requirement: McpRuntimeRequirement;
  status: McpRuntimeCheckStatus;
  detail: string;
  evidence?: Record<string, unknown>;
  remediation?: string;
}

export interface McpRuntimeReadinessReport {
  status: McpRuntimeReadinessStatus;
  targetKey: string;
  summary: string;
  requirements: McpRuntimeRequirement[];
  checks: McpRuntimeReadinessCheck[];
}

export interface McpProbeReadinessReport {
  status: McpProbeStatus;
  summary: string;
  findings: McpReadinessFinding[];
}

export interface McpReadinessTargetSummary {
  targetKey: string;
  label: string;
  name?: string;
  kind: McpInstallTargetKind;
  transport: McpTransport;
  source: Omit<McpTargetSource, "raw">;
  inputs: McpInputRequirement[];
  requiresAuth?: boolean;
  reasonCode?: string;
  detail?: string;
  remote?: {
    url: string;
  };
  stdio?: {
    command: string;
    argsCount: number;
    packageRegistry?: string;
    packageName?: string;
  };
}

export interface McpReadinessReport {
  target: McpReadinessTargetSummary;
  configure: McpInstallabilityReport;
  runtime: McpRuntimeReadinessReport;
  probe: McpProbeReadinessReport;
  generatedAt: string;
}

export interface McpDefinitionInput {
  name: string;
  title?: string;
  installMode?: string;
  transport?: string | null;
  serverUrl?: string | null;
  headers?: Record<string, string> | null;
  requiresAuth?: boolean | null;
  auth?: Record<string, unknown> | null;
  envKey?: string | null;
  stdioCommand?: string | null;
  stdioArgs?: string[] | null;
  stdio?: { command?: string; args?: string[]; envKey?: string; env?: Record<string, string> } | null;
  npmPackage?: string | null;
  setupCommand?: string | null;
  installTargets?: unknown;
}

export interface McpRuntimeReadinessOptions {
  env?: Record<string, string | undefined>;
  inputs?: Record<string, string | undefined>;
  findExecutable?: (command: string) => string | null;
  runCommand?: (
    command: string,
    args: string[],
    options: { timeoutMs: number; env: Record<string, string | undefined> },
  ) => Promise<McpRunCommandResult>;
  timeoutMs?: number;
  skipCommandChecks?: boolean;
  allowDockerDaemonProbe?: boolean;
}

export interface McpRunCommandResult {
  exitCode: number | null;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
  error?: string;
}

export function registryDefToMcpInstallTargets(def: McpDefinitionInput): McpInstallTarget[] {
  return mcpDefinitionToMcpInstallTargets(def, {
    kind: "registry",
    name: def.name,
    raw: def,
  });
}

export function selectPreferredMcpInstallTarget(
  targets: McpInstallTarget[],
  options: { inputs?: Record<string, string | undefined>; apiKey?: string | null } = {},
): McpInstallTarget | null {
  if (targets.length === 0) return null;
  return [...targets].sort((a, b) => {
    const aReport = assessMcpInstallability(a, {
      inputs: withLegacyCredentialFallback(a, options.inputs, options.apiKey),
    });
    const bReport = assessMcpInstallability(b, {
      inputs: withLegacyCredentialFallback(b, options.inputs, options.apiKey),
    });
    const statusDelta = installabilityRank(aReport.status) - installabilityRank(bReport.status);
    if (statusDelta !== 0) return statusDelta;

    const kindDelta = targetKindRank(a.kind) - targetKindRank(b.kind);
    if (kindDelta !== 0) return kindDelta;

    return a.targetKey.localeCompare(b.targetKey);
  })[0];
}

export function registryDefToPreferredMcpInstallTarget(
  def: McpDefinitionInput,
  options: { inputs?: Record<string, string | undefined>; apiKey?: string | null } = {},
): McpInstallTarget | null {
  return selectPreferredMcpInstallTarget(registryDefToMcpInstallTargets(def), options);
}

export function mcpDefinitionToMcpInstallTargets(
  def: McpDefinitionInput,
  source: McpTargetSource = { kind: "unknown", name: def.name, raw: def },
): McpInstallTarget[] {
  const explicit = parseExplicitTargets(def, source);
  if (explicit.length > 0) return explicit;

  const targets: McpInstallTarget[] = [];
  const label = def.title || def.name;
  const authInputs = inputRequirementsFromAuth(def);

  if (def.serverUrl) {
    const transport = normalizeRemoteTransport(def.transport);
    targets.push({
      targetKey: stableTargetKey(def.name, "remote", transport, def.serverUrl),
      label,
      name: def.name,
      kind: "remote",
      transport,
      url: def.serverUrl,
      headers: def.headers ?? undefined,
      inputs: authInputs,
      requiresAuth: def.requiresAuth ?? authRequiresInput(def.auth),
      auth: def.auth ?? null,
      source,
      raw: def,
    });
  }

  const stdio = normalizeFlatStdio(def);
  if (stdio) {
    targets.push({
      targetKey: stableTargetKey(def.name, "stdio", "stdio", `${stdio.command} ${stdio.args.join(" ")}`),
      label,
      name: def.name,
      kind: "stdio",
      transport: "stdio",
      command: stdio.command,
      args: stdio.args,
      env: stdio.env,
      envKey: stdio.envKey,
      inputs: mergeInputRequirements([
        ...authInputs,
        ...inputRequirementsFromStdio(stdio.envKey),
      ]),
      requiresAuth: def.requiresAuth ?? (!!stdio.envKey || authRequiresInput(def.auth)),
      auth: def.auth ?? null,
      source,
      raw: def,
    });
  }

  if (targets.length === 0 && def.installMode === "package") {
    targets.push({
      targetKey: stableTargetKey(def.name, "unsupported", "unknown", def.npmPackage || def.setupCommand || def.name),
      label,
      name: def.name,
      kind: "unsupported",
      transport: "unknown",
      reasonCode: "package-target-unresolved",
      detail: "Package-mode MCP target is missing structured install target data.",
      inputs: [],
      source,
      raw: def,
    });
  }

  return targets;
}

export function assessMcpInstallability(
  target: McpInstallTarget,
  options: { inputs?: Record<string, string | undefined> } = {},
): McpInstallabilityReport {
  const findings: McpReadinessFinding[] = [];

  if (target.kind === "unsupported") {
    findings.push(blocked(target.reasonCode, target.detail, "Choose a supported streamable HTTP or stdio target."));
    return {
      status: "unsupported",
      targetKey: target.targetKey,
      summary: target.detail,
      findings,
      requiredInputs: [],
    };
  }

  if (target.kind === "remote") {
    if (target.transport === "sse") {
      findings.push(blocked(
        "remote-sse-unsupported",
        "SSE MCP transport is recognized but not supported by Equip install output yet.",
        "Use a streamable HTTP endpoint, or wait for SSE platform support.",
      ));
    }
    if (hasUrlVariables(target.url)) {
      findings.push(blocked(
        "url-variables-unsupported",
        "The remote MCP URL contains variables that Equip cannot safely fill yet.",
        "Publish a concrete URL or expose structured inputs for the variable values.",
      ));
    }
    const customHeaderKeys = Object.keys(target.headers ?? {})
      .filter((key) => key.toLowerCase() !== "authorization");
    if (customHeaderKeys.length > 0) {
      findings.push(blocked(
        "custom-headers-unsupported",
        `Custom remote MCP headers are not supported yet: ${customHeaderKeys.join(", ")}.`,
        "Use standard Authorization or add structured header input support.",
      ));
    }
    const authorization = findHeaderValue(target.headers, "authorization");
    if (authorization && hasArgumentVariables(authorization)) {
      findings.push(blocked(
        "authorization-header-variable-unsupported",
        "The Authorization header contains a variable that Equip cannot safely fill yet.",
        "Expose a structured credential input instead of embedding variables in headers.",
      ));
    } else if (authorization) {
      findings.push(blocked(
        "static-authorization-header-unsupported",
        "Static Authorization headers in registry metadata are not installed into local MCP configs.",
        "Expose a structured credential input so the user-provided secret can be injected locally.",
      ));
    }
    if (target.requiresAuth && isInsecureRemoteUrl(target.url)) {
      findings.push(blocked(
        "insecure-auth-url-unsupported",
        "Credentialed remote MCP targets must use HTTPS unless they are local loopback endpoints.",
        "Use an HTTPS endpoint or localhost loopback URL.",
      ));
    }
    const unsupportedInputShape = unsupportedRemoteInputShape(target.inputs);
    if (unsupportedInputShape) {
      findings.push(blocked(
        "remote-input-shape-unsupported",
        unsupportedInputShape,
        "Expose no inputs for public remotes, or one required credential input for Authorization.",
      ));
    }
  }

  if (target.kind === "stdio") {
    const commandValidation = validateRuntimeCommand(target.command);
    if (!commandValidation.ok) {
      findings.push(blocked(
        "stdio-command-unsafe",
        commandValidation.detail,
        "Publish a command name/path without shell metacharacters or line breaks.",
      ));
    }
    const variableArgs = target.args.filter(hasArgumentVariables);
    if (variableArgs.length > 0) {
      findings.push(blocked(
        "arg-variables-unsupported",
        "The stdio command arguments contain variables that Equip cannot safely fill yet.",
        "Publish concrete args or expose structured inputs for the variable values.",
      ));
    }
    const unsafeArg = target.args.find((arg) => !validateRuntimeArgument(arg).ok);
    if (unsafeArg !== undefined) {
      const validation = validateRuntimeArgument(unsafeArg);
      findings.push(blocked(
        "stdio-arg-unsafe",
        validation.ok ? "The stdio command arguments contain characters that are not allowed." : validation.detail,
        "Publish argument values without shell metacharacters or line breaks.",
      ));
    }
  }

  const unsupportedInputs = target.inputs.filter((input) => input.substitutionUnsupported);
  if (unsupportedInputs.length > 0) {
    findings.push(blocked(
      "input-variables-unsupported",
      `Input defaults or variable declarations need structured substitution before install: ${unsupportedInputs.map((input) => input.key).join(", ")}.`,
      "Publish concrete defaults or required inputs without embedded variables.",
    ));
  }

  const missingInputs = target.inputs
    .filter((input) => input.required)
    .filter((input) => !inputProvided(input.key, options.inputs) && !input.defaultValue);

  if (missingInputs.length > 0) {
    findings.push({
      code: "input-required",
      severity: "warning",
      message: `Needs ${missingInputs.length} required value${missingInputs.length === 1 ? "" : "s"} before install.`,
      remediation: "Collect the required value and recheck readiness.",
    });
  }

  const blockers = findings.filter((finding) => finding.severity === "blocked");
  if (blockers.length > 0) {
    return {
      status: "unsupported",
      targetKey: target.targetKey,
      summary: blockers[0].message,
      findings,
      requiredInputs: missingInputs,
    };
  }

  if (missingInputs.length > 0) {
    return {
      status: "needs-input",
      targetKey: target.targetKey,
      summary: "Required input is missing.",
      findings,
      requiredInputs: missingInputs,
    };
  }

  return {
    status: "installable",
    targetKey: target.targetKey,
    summary: target.kind === "remote"
      ? "Equip can configure this remote MCP target."
      : "Equip can configure this stdio MCP target.",
    findings,
    requiredInputs: [],
  };
}

export function deriveMcpRuntimeRequirements(target: McpInstallTarget): McpRuntimeRequirement[] {
  if (target.kind !== "stdio") return [];

  const requirements: McpRuntimeRequirement[] = [];
  const add = (requirement: McpRuntimeRequirement): void => {
    if (!requirements.some((existing) => existing.key === requirement.key)) {
      requirements.push(requirement);
    }
  };

  for (const input of target.inputs) {
    if (!input.required) continue;
    if (input.defaultValue && !input.substitutionUnsupported) continue;
    add({
      key: `input:${input.key}`,
      kind: input.secret ? "credential" : "input",
      label: input.label,
      inputKey: input.key,
      required: true,
      remediation: input.secret
        ? `Provide ${input.label}; Equip will not log or display the value.`
        : `Provide ${input.label}.`,
    });
  }

  const command = normalizeCommandName(target.command);
  if (!command) return requirements;

  if (command === "npx") {
    add(executableRequirement("node", "Node.js", "node", ["--version"], "Install Node.js so npx-based MCP servers can run."));
    add(executableRequirement("npx", "npx", "npx", ["--version"], "Install Node.js/npm or ensure npx is on PATH."));
  } else if (command === "node") {
    add(executableRequirement("node", "Node.js", "node", ["--version"], "Install Node.js or ensure node is on PATH."));
  } else if (command === "npm") {
    add(executableRequirement("node", "Node.js", "node", ["--version"], "Install Node.js so npm-based MCP servers can run."));
    add(executableRequirement("npm", "npm", "npm", ["--version"], "Install npm or ensure it is on PATH."));
  } else if (command === "uvx") {
    add(executableRequirement("uvx", "uvx", "uvx", ["--version"], "Install uv so uvx-based Python MCP servers can run."));
  } else if (command === "python" || command === "python3" || command === "py") {
    add(executableRequirement("python", "Python", target.command, ["--version"], "Install Python or ensure it is on PATH."));
  } else if (command === "docker") {
    add(executableRequirement("docker-cli", "Docker CLI", "docker", ["--version"], "Install Docker and ensure docker is on PATH."));
    add({
      key: "docker-daemon",
      kind: "docker-daemon",
      label: "Docker daemon",
      command: "docker",
      args: ["info"],
      required: true,
      remediation: "Start Docker Desktop or the Docker daemon and recheck.",
    });
  } else {
    add({
      key: `executable:${target.command}`,
      kind: "executable",
      label: target.command,
      command: target.command,
      required: true,
      remediation: `Install ${target.command} or ensure it is available on PATH.`,
    });
  }

  return requirements;
}

export async function assessMcpRuntimeReadiness(
  target: McpInstallTarget,
  options: McpRuntimeReadinessOptions = {},
): Promise<McpRuntimeReadinessReport> {
  const requirements = deriveMcpRuntimeRequirements(target);
  if (requirements.length === 0) {
    return {
      status: target.kind === "remote" ? "not-needed" : "not-checked",
      targetKey: target.targetKey,
      summary: target.kind === "remote"
        ? "No local runtime is required for this remote MCP target."
        : "No runtime requirements could be derived for this target.",
      requirements,
      checks: [],
    };
  }

  const inputEnv = options.env ?? process.env;
  const commandEnv = sanitizedRuntimeEnv(inputEnv);
  const inputs = options.inputs ?? {};
  const findExecutable = options.findExecutable ?? ((command) => findExecutableOnPath(command, inputEnv));
  const runCommand = options.runCommand ?? defaultRunCommand;
  const timeoutMs = options.timeoutMs ?? 2500;
  const checks: McpRuntimeReadinessCheck[] = [];

  for (const requirement of requirements) {
    if (requirement.kind === "credential" || requirement.kind === "input") {
      const key = requirement.inputKey || requirement.key.replace(/^input:/, "");
      const present = inputProvided(key, inputs) || envValuePresent(key, inputEnv);
      checks.push({
        requirement,
        status: present ? "ready" : "needs-input",
        detail: present ? `${requirement.label} is present.` : `${requirement.label} is missing.`,
        remediation: present ? undefined : requirement.remediation,
      });
      continue;
    }

    const command = requirement.command;
    if (!command) {
      checks.push({
        requirement,
        status: "unknown",
        detail: "No command was available for this runtime check.",
      });
      continue;
    }

    const commandValidation = validateRuntimeCommand(command);
    if (!commandValidation.ok) {
      checks.push({
        requirement,
        status: "unknown",
        detail: commandValidation.detail,
        remediation: requirement.remediation,
      });
      continue;
    }

    const executable = findExecutable(command);
    if (!executable) {
      checks.push({
        requirement,
        status: "missing",
        detail: `${requirement.label} was not found on PATH.`,
        remediation: requirement.remediation,
      });
      continue;
    }

    if (requirement.kind === "docker-daemon" && !options.allowDockerDaemonProbe) {
      checks.push({
        requirement,
        status: "unknown",
        detail: "Docker daemon reachability was not checked because it requires explicit user action.",
        evidence: { path: executable },
        remediation: "Run an explicit Docker readiness check when the user wants to verify daemon access.",
      });
      continue;
    }

    if (options.skipCommandChecks || requirement.kind === "executable") {
      checks.push({
        requirement,
        status: "ready",
        detail: `${requirement.label} found.`,
        evidence: { path: executable },
      });
      continue;
    }

    const result = await runCommand(command, requirement.args ?? ["--version"], { timeoutMs, env: commandEnv });
    if (requirement.kind === "docker-daemon") {
      checks.push(dockerDaemonCheck(requirement, executable, result));
      continue;
    }

    checks.push(commandVersionCheck(requirement, executable, result));
  }

  return {
    status: summarizeRuntimeStatus(checks),
    targetKey: target.targetKey,
    summary: summarizeRuntimeChecks(checks),
    requirements,
    checks,
  };
}

export async function assessMcpReadiness(
  target: McpInstallTarget,
  options: McpRuntimeReadinessOptions & { inputs?: Record<string, string | undefined> } = {},
): Promise<McpReadinessReport> {
  return {
    target: summarizeMcpInstallTarget(target),
    configure: assessMcpInstallability(target, { inputs: options.inputs }),
    runtime: await assessMcpRuntimeReadiness(target, options),
    probe: {
      status: "not-run",
      summary: "Functional MCP probe has not been run.",
      findings: [],
    },
    generatedAt: new Date().toISOString(),
  };
}

function parseExplicitTargets(def: McpDefinitionInput, source: McpTargetSource): McpInstallTarget[] {
  if (!Array.isArray(def.installTargets)) return [];
  return def.installTargets.map((raw, index) => parseExplicitTarget(def, raw, index, source));
}

function parseExplicitTarget(
  def: McpDefinitionInput,
  raw: unknown,
  index: number,
  source: McpTargetSource,
): McpInstallTarget {
  const record = asRecord(raw);
  if (!record) {
    return unsupportedTarget(def, source, index, "target-shape-unsupported", "Install target is not an object.", raw);
  }

  const rawTransport = readString(record.transport) ?? readString(asRecord(record.transport)?.type);
  const transport = normalizeTransport(rawTransport);
  const rawKind = (readString(record.kind) ?? readString(record.targetKind) ?? inferTargetKind(record, transport)).toLowerCase();
  const targetKey = stableTargetKey(
    def.name,
    rawKind || "target",
    transport,
    readString(record.targetKey) ?? readString(record.id) ?? String(index),
  );
  const label = readString(record.label) ?? readString(record.name) ?? def.title ?? def.name;
  const inputs = mergeInputRequirements([
    ...inputRequirementsFromRawTarget(record),
    ...inputRequirementsFromAuth({ ...def, auth: asRecord(record.auth) ?? def.auth, requiresAuth: readBoolean(record.requiresAuth) ?? def.requiresAuth }),
  ]);

  if (rawKind === "remote") {
    const url = readString(record.url) ?? readString(record.serverUrl);
    if (!url) {
      return unsupportedTarget(def, source, index, "remote-url-missing", "Remote MCP target is missing a URL.", raw);
    }
    if (transport !== "streamable-http" && transport !== "sse") {
      return unsupportedTarget(def, source, index, "remote-transport-unsupported", `Unsupported remote transport: ${rawTransport ?? "unknown"}.`, raw);
    }
    return {
      targetKey,
      label,
      name: def.name,
      kind: "remote",
      transport,
      url,
      headers: stringRecord(record.headers),
      inputs,
      requiresAuth: readBoolean(record.requiresAuth) ?? def.requiresAuth ?? authRequiresInput(asRecord(record.auth) ?? def.auth),
      auth: asRecord(record.auth) ?? def.auth ?? null,
      source,
      raw,
    };
  }

  if (rawKind === "stdio" || transport === "stdio") {
    const argumentIssue = packageArgumentIssue(record);
    if (argumentIssue) {
      return unsupportedTarget(def, source, index, argumentIssue.reasonCode, argumentIssue.detail, raw);
    }
    const projected = projectPackageTarget(record);
    const command = readString(record.command) ?? readString(record.stdioCommand) ?? projected?.command;
    const args = stringArray(record.args) ?? stringArray(record.stdioArgs) ?? projected?.args ?? [];
    if (!command) {
      return unsupportedTarget(def, source, index, "stdio-command-missing", "Stdio MCP target is missing a command.", raw);
    }
    const registryType = readString(record.registryType) ?? readString(record.packageRegistry);
    const packageName = readString(record.identifier) ?? readString(record.packageName);
    const envKey = readString(record.envKey) ?? firstSecretInput(inputs)?.key;
    return {
      targetKey,
      label,
      name: def.name,
      kind: "stdio",
      transport: "stdio",
      command,
      args,
      env: stringRecord(record.env),
      envKey,
      packageRegistry: registryType,
      packageName,
      inputs: mergeInputRequirements([...inputs, ...inputRequirementsFromStdio(envKey)]),
      requiresAuth: readBoolean(record.requiresAuth) ?? !!envKey,
      auth: asRecord(record.auth) ?? def.auth ?? null,
      source: {
        ...source,
        registryType: registryType ?? source.registryType,
        raw,
      },
      raw,
    };
  }

  if (rawKind === "package") {
    return unsupportedTarget(
      def,
      source,
      index,
      "package-launched-http-unsupported",
      "Package-launched non-stdio MCP targets require a managed local service lifecycle, which Equip does not support yet.",
      raw,
    );
  }

  return unsupportedTarget(def, source, index, "target-shape-unsupported", "Install target shape is not supported yet.", raw);
}

function normalizeFlatStdio(def: McpDefinitionInput): { command: string; args: string[]; envKey?: string; env?: Record<string, string> } | null {
  if (def.stdioCommand) {
    return {
      command: def.stdioCommand,
      args: def.stdioArgs ?? [],
      envKey: def.envKey ?? undefined,
    };
  }
  if (def.stdio?.command) {
    return {
      command: def.stdio.command,
      args: def.stdio.args ?? [],
      envKey: def.stdio.envKey ?? def.envKey ?? undefined,
      env: def.stdio.env,
    };
  }
  return null;
}

function projectPackageTarget(record: Record<string, unknown>): { command: string; args: string[] } | null {
  const registryType = (readString(record.registryType) ?? readString(record.packageRegistry) ?? "").toLowerCase();
  const identifier = readString(record.identifier) ?? readString(record.packageName);
  const runtimeHint = readString(record.runtimeHint);
  const packageArgs = argumentValuesFromRaw(record.packageArguments);
  const runtimeArgs = argumentValuesFromRaw(record.runtimeArguments);
  if (runtimeHint) return { command: runtimeHint, args: stringArray(record.args) ?? [...runtimeArgs, ...(identifier ? [packageSpec(registryType, identifier, readString(record.version))] : []), ...packageArgs] };
  if (!identifier) return null;
  const version = readString(record.version);
  if (registryType === "npm") return { command: "npx", args: ["-y", packageSpec(registryType, identifier, version), ...packageArgs] };
  if (registryType === "pypi") return { command: "uvx", args: [packageSpec(registryType, identifier, version), ...packageArgs] };
  if (registryType === "oci" || registryType === "docker") return { command: "docker", args: ["run", "--rm", "-i", ...runtimeArgs, identifier, ...packageArgs] };
  return null;
}

function packageSpec(registryType: string, identifier: string, version: string | undefined): string {
  if (!version) return identifier;
  if (registryType === "npm") return `${identifier}@${version}`;
  if (registryType === "pypi") return `${identifier}==${version}`;
  return identifier;
}

function packageArgumentIssue(record: Record<string, unknown>): { reasonCode: string; detail: string } | null {
  const args = [
    ...argumentArray(record.packageArguments),
    ...argumentArray(record.runtimeArguments),
  ];
  for (const raw of args) {
    const arg = asRecord(raw);
    if (!arg) continue;
    const value = readString(arg.value);
    const defaultValue = readString(arg.default);
    if (hasDeclaredVariables(arg) || hasArgumentVariables(value ?? "") || hasArgumentVariables(defaultValue ?? "")) {
      return {
        reasonCode: "arg-variables-unsupported",
        detail: "Package/runtime argument variables need structured input substitution before this target can be installed.",
      };
    }
    if ((readBoolean(arg.required) ?? readBoolean(arg.isRequired)) === true && !value && !defaultValue) {
      return {
        reasonCode: "required-argument-unsupported",
        detail: "Package/runtime arguments include a required value without a default.",
      };
    }
  }
  return null;
}

function argumentValuesFromRaw(value: unknown): string[] {
  const out: string[] = [];
  for (const raw of argumentArray(value)) {
    const arg = asRecord(raw);
    if (!arg) continue;
    const literal = readString(arg.value) ?? readString(arg.default);
    if (literal === undefined) continue;
    const name = readString(arg.name);
    if (readString(arg.type) === "named" && name) out.push(name);
    out.push(literal);
  }
  return out;
}

function argumentArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function normalizeRemoteTransport(transport: string | null | undefined): "streamable-http" | "sse" {
  return transport === "sse" ? "sse" : "streamable-http";
}

function normalizeTransport(transport: string | null | undefined): McpTransport {
  const normalized = (transport ?? "").trim().toLowerCase();
  if (normalized === "http" || normalized === "streamable-http") return "streamable-http";
  if (normalized === "sse") return "sse";
  if (normalized === "stdio") return "stdio";
  return "unknown";
}

function inferTargetKind(record: Record<string, unknown>, transport: McpTransport): string {
  if (record.url || record.serverUrl) return "remote";
  if (record.command || record.stdioCommand || transport === "stdio") return "stdio";
  if (record.registryType || record.packageRegistry || record.identifier) return "package";
  return "";
}

function inputRequirementsFromAuth(def: {
  requiresAuth?: boolean | null;
  auth?: Record<string, unknown> | null;
  envKey?: string | null;
}): McpInputRequirement[] {
  const auth = def.auth;
  const authType = readString(auth?.type);
  if (authType && authType.toLowerCase() === "none") return [];
  if (!def.requiresAuth && !authRequiresInput(auth) && !def.envKey) return [];

  const key = readString(auth?.keyEnvVar) ?? readString(auth?.envKey) ?? def.envKey ?? credentialKeyForAuth(authType);
  return [{
    key,
    kind: "credential",
    label: authLabel(authType, key),
    required: true,
    secret: true,
  }];
}

function inputRequirementsFromStdio(envKey: string | undefined): McpInputRequirement[] {
  if (!envKey) return [];
  return [{
    key: envKey,
    kind: "env",
    label: envKey,
    required: true,
    secret: true,
  }];
}

function inputRequirementsFromRawTarget(record: Record<string, unknown>): McpInputRequirement[] {
  const out: McpInputRequirement[] = [];
  const inputs = Array.isArray(record.inputs) ? record.inputs : [];
  for (const raw of inputs) {
    const input = inputRequirementFromRaw(raw, "plain");
    if (input) out.push(input);
  }
  const envVars = Array.isArray(record.environmentVariables) ? record.environmentVariables : [];
  for (const raw of envVars) {
    const input = inputRequirementFromRaw(raw, "env");
    if (input) out.push(input);
  }
  return out;
}

function inputRequirementFromRaw(raw: unknown, defaultKind: McpInputKind): McpInputRequirement | null {
  const record = asRecord(raw);
  if (!record) return null;
  const key = readString(record.key) ?? readString(record.name);
  if (!key) return null;
  const isSecret = readBoolean(record.secret) ?? readBoolean(record.isSecret) ?? /token|key|secret|password/i.test(key);
  const kind = readString(record.kind) as McpInputKind | undefined;
  const rawDefaultValue = readString(record.value) ?? readString(record.default);
  const substitutionUnsupported = hasDeclaredVariables(record) || hasArgumentVariables(rawDefaultValue ?? "");
  return {
    key,
    kind: kind ?? (isSecret ? "credential" : defaultKind),
    label: readString(record.label) ?? key,
    required: readBoolean(record.required) ?? readBoolean(record.isRequired) ?? true,
    secret: isSecret,
    description: readString(record.description),
    defaultValue: isSecret || substitutionUnsupported ? undefined : rawDefaultValue,
    substitutionUnsupported,
  };
}

function authRequiresInput(auth: Record<string, unknown> | null | undefined): boolean {
  const type = readString(auth?.type);
  return !!type && type.toLowerCase() !== "none";
}

function credentialKeyForAuth(authType: string | undefined): string {
  if (authType === "oidc") return "equip-identity";
  if (authType === "oauth" || authType === "oauth_to_api_key") return "oauth-token";
  return "credential";
}

function authLabel(authType: string | undefined, key: string): string {
  if (authType === "oidc") return "Equip sign-in";
  if (authType === "oauth" || authType === "oauth_to_api_key") return "Connected account";
  return key;
}

function mergeInputRequirements(inputs: McpInputRequirement[]): McpInputRequirement[] {
  const byKey = new Map<string, McpInputRequirement>();
  for (const input of inputs) {
    const existing = byKey.get(input.key);
    byKey.set(input.key, existing
      ? {
          ...existing,
          required: existing.required || input.required,
          secret: existing.secret || input.secret,
          kind: existing.kind === "credential" || input.kind === "credential" ? "credential" : existing.kind,
          defaultValue: existing.defaultValue ?? input.defaultValue,
          substitutionUnsupported: existing.substitutionUnsupported || input.substitutionUnsupported,
        }
      : input);
  }
  return [...byKey.values()];
}

function installabilityRank(status: McpInstallabilityStatus): number {
  if (status === "installable") return 0;
  if (status === "needs-input") return 1;
  if (status === "unknown") return 2;
  return 3;
}

function targetKindRank(kind: McpInstallTargetKind): number {
  if (kind === "remote") return 0;
  if (kind === "stdio") return 1;
  return 2;
}

function firstSecretInput(inputs: McpInputRequirement[]): McpInputRequirement | undefined {
  return inputs.find((input) => input.required && input.secret);
}

function executableRequirement(
  key: string,
  label: string,
  command: string,
  args: string[],
  remediation: string,
): McpRuntimeRequirement {
  return {
    key,
    kind: key as McpRuntimeRequirementKind,
    label,
    command,
    args,
    required: true,
    remediation,
  };
}

function commandVersionCheck(
  requirement: McpRuntimeRequirement,
  executable: string,
  result: McpRunCommandResult,
): McpRuntimeReadinessCheck {
  if (result.timedOut) {
    return {
      requirement,
      status: "unknown",
      detail: `${requirement.label} version check timed out.`,
      evidence: { path: executable },
      remediation: requirement.remediation,
    };
  }
  if (result.exitCode !== 0) {
    return {
      requirement,
      status: "missing",
      detail: `${requirement.label} exists but did not answer a version check.`,
      evidence: { path: executable, exitCode: result.exitCode, output: redactOutput(`${result.stdout ?? ""}\n${result.stderr ?? ""}`) },
      remediation: requirement.remediation,
    };
  }
  return {
    requirement,
    status: "ready",
    detail: `${requirement.label} is available.`,
    evidence: { path: executable, version: firstOutputLine(result.stdout || result.stderr || "") },
  };
}

function dockerDaemonCheck(
  requirement: McpRuntimeRequirement,
  executable: string,
  result: McpRunCommandResult,
): McpRuntimeReadinessCheck {
  if (result.exitCode === 0) {
    return {
      requirement,
      status: "ready",
      detail: "Docker daemon is reachable.",
      evidence: { path: executable },
    };
  }
  return {
    requirement,
    status: "unreachable",
    detail: result.timedOut ? "Docker daemon check timed out." : "Docker CLI is installed, but the Docker daemon is not reachable.",
    evidence: { path: executable, exitCode: result.exitCode, output: redactOutput(`${result.stdout ?? ""}\n${result.stderr ?? ""}`) },
    remediation: requirement.remediation,
  };
}

function summarizeRuntimeStatus(checks: McpRuntimeReadinessCheck[]): McpRuntimeReadinessStatus {
  if (checks.some((check) => check.status === "missing")) return "missing-runtime";
  if (checks.some((check) => check.status === "unreachable")) return "runtime-unreachable";
  if (checks.some((check) => check.status === "needs-input")) return "needs-input";
  if (checks.some((check) => check.status === "unknown")) return "not-checked";
  return "ready";
}

function summarizeRuntimeChecks(checks: McpRuntimeReadinessCheck[]): string {
  const missing = checks.filter((check) => check.status === "missing");
  if (missing.length > 0) return `Missing ${missing.map((check) => check.requirement.label).join(", ")}.`;
  const unreachable = checks.find((check) => check.status === "unreachable");
  if (unreachable) return unreachable.detail;
  const needsInput = checks.filter((check) => check.status === "needs-input");
  if (needsInput.length > 0) return `Needs ${needsInput.map((check) => check.requirement.label).join(", ")}.`;
  const unknown = checks.find((check) => check.status === "unknown");
  if (unknown) return unknown.detail;
  return "Local runtime requirements are ready.";
}

export function summarizeMcpInstallTarget(target: McpInstallTarget): McpReadinessTargetSummary {
  const summary: McpReadinessTargetSummary = {
    targetKey: target.targetKey,
    label: target.label,
    name: target.name,
    kind: target.kind,
    transport: target.transport,
    source: {
      kind: target.source.kind,
      name: target.source.name,
      version: target.source.version,
      registryType: target.source.registryType,
      contentHash: target.source.contentHash,
    },
    inputs: target.inputs,
    requiresAuth: target.requiresAuth,
  };

  if (target.kind === "remote") {
    summary.remote = { url: sanitizeUrlForReport(target.url) };
  } else if (target.kind === "stdio") {
    summary.stdio = {
      command: target.command,
      argsCount: target.args.length,
      packageRegistry: target.packageRegistry,
      packageName: target.packageName,
    };
  } else {
    summary.reasonCode = target.reasonCode;
    summary.detail = target.detail;
  }

  return summary;
}

function sanitizeUrlForReport(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    for (const key of [...parsed.searchParams.keys()]) {
      parsed.searchParams.set(key, "[redacted]");
    }
    return parsed.toString();
  } catch {
    return hasUrlVariables(url) ? "[templated-url]" : "[invalid-url]";
  }
}

function sanitizedRuntimeEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  const allowed = new Set([
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "WINDIR",
    "HOME",
    "USERPROFILE",
    "TEMP",
    "TMP",
  ]);

  for (const [key, value] of Object.entries(env)) {
    if (allowed.has(key.toUpperCase())) out[key] = value;
  }

  return out;
}

function findExecutableOnPath(command: string, env: Record<string, string | undefined>): string | null {
  const validation = validateRuntimeCommand(command);
  if (!validation.ok) return null;

  if (isPathLike(command)) {
    return fileIsExecutable(command) ? path.resolve(command) : null;
  }

  const pathValue = readPathEnv(env);
  if (!pathValue) return null;

  const extensions = process.platform === "win32"
    ? (readPathExtEnv(env) || ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
    : [""];

  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    for (const extension of extensions) {
      const candidate = path.join(dir, command.endsWith(extension.toLowerCase()) || command.endsWith(extension.toUpperCase())
        ? command
        : `${command}${extension}`);
      if (fileIsExecutable(candidate)) return candidate;
    }
  }

  return null;
}

function validateRuntimeCommand(command: string): { ok: true } | { ok: false; detail: string } {
  if (!command.trim()) return { ok: false, detail: "Runtime command is empty." };
  if (/[\r\n;&|`$<>^%!"()]/.test(command)) {
    return {
      ok: false,
      detail: "Runtime command contains characters that are not allowed in passive readiness checks.",
    };
  }
  return { ok: true };
}

function validateRuntimeArgument(arg: string): { ok: true } | { ok: false; detail: string } {
  if (/[\r\n;&|`<>^%!"()]/.test(arg)) {
    return {
      ok: false,
      detail: "Runtime argument contains characters that are not allowed in generated MCP config.",
    };
  }
  return { ok: true };
}

function unsupportedRemoteInputShape(inputs: McpInputRequirement[]): string | null {
  if (inputs.length === 0) return null;
  if (inputs.length === 1) {
    const input = inputs[0];
    if (input.required && input.secret && input.kind === "credential") return null;
  }
  return "Remote MCP targets can only project public remotes or one required Authorization credential today.";
}

function withLegacyCredentialFallback(
  target: McpInstallTarget,
  inputs: Record<string, string | undefined> | undefined,
  apiKey: string | null | undefined,
): Record<string, string | undefined> | undefined {
  if (!apiKey) return inputs;
  const effective = { ...(inputs ?? {}) };
  const requiredSecrets = target.inputs.filter((input) => input.required && input.secret);
  if (requiredSecrets.length !== 1) return effective;
  const secret = requiredSecrets[0];
  if (!inputProvided(secret.key, effective)) effective[secret.key] = apiKey;
  return effective;
}

function isPathLike(command: string): boolean {
  return path.isAbsolute(command) || command.includes("/") || command.includes("\\");
}

function fileIsExecutable(candidate: string): boolean {
  try {
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) return false;
    if (process.platform === "win32") return true;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function readPathEnv(env: Record<string, string | undefined>): string | undefined {
  return env.PATH ?? env.Path ?? env.path;
}

function readPathExtEnv(env: Record<string, string | undefined>): string | undefined {
  return env.PATHEXT ?? env.PathExt ?? env.pathext;
}

function defaultRunCommand(
  command: string,
  args: string[],
  options: { timeoutMs: number; env: Record<string, string | undefined> },
): Promise<McpRunCommandResult> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, {
      env: options.env as NodeJS.ProcessEnv,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch {}
      resolve({ exitCode: null, stdout, stderr, timedOut: true });
    }, options.timeoutMs);

    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: null, stdout, stderr, error: error.message });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr });
    });
  });
}

function stableTargetKey(name: string, kind: string, transport: string, discriminator: string): string {
  return [
    sanitizeKeyPart(name),
    sanitizeKeyPart(kind),
    sanitizeKeyPart(transport),
    `target-${hashKeyPart(discriminator)}`,
  ].filter(Boolean).join(":");
}

function sanitizeKeyPart(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "target";
}

function hashKeyPart(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function unsupportedTarget(
  def: McpDefinitionInput,
  source: McpTargetSource,
  index: number,
  reasonCode: string,
  detail: string,
  raw: unknown,
): McpUnsupportedInstallTarget {
  return {
    targetKey: stableTargetKey(def.name, "unsupported", "unknown", String(index)),
    label: def.title || def.name,
    name: def.name,
    kind: "unsupported",
    transport: "unknown",
    reasonCode,
    detail,
    inputs: [],
    source,
    raw,
  };
}

function blocked(code: string, message: string, remediation?: string): McpReadinessFinding {
  return { code, severity: "blocked", message, remediation };
}

function hasUrlVariables(url: string): boolean {
  return /\{[^}]+\}|\$\{[^}]+\}|<[^>]+>/.test(url);
}

function hasArgumentVariables(arg: string): boolean {
  return /\{[^}]+\}|\$\{[^}]+\}|\$[A-Z_][A-Z0-9_]*/i.test(arg);
}

function hasDeclaredVariables(value: Record<string, unknown>): boolean {
  const variables = asRecord(value.variables);
  return !!variables && Object.keys(variables).length > 0;
}

function findHeaderValue(headers: Record<string, string> | undefined, needle: string): string | undefined {
  if (!headers) return undefined;
  const lowerNeedle = needle.toLowerCase();
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === lowerNeedle);
  return entry?.[1];
}

function isInsecureRemoteUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:") return false;
    if (parsed.protocol !== "http:") return true;
    const host = parsed.hostname.toLowerCase();
    return host !== "localhost" && host !== "127.0.0.1" && host !== "::1";
  } catch {
    return true;
  }
}

function inputProvided(key: string, inputs: Record<string, string | undefined> | undefined): boolean {
  const value = inputs?.[key];
  return typeof value === "string" && value.trim().length > 0;
}

function envValuePresent(key: string, env: Record<string, string | undefined>): boolean {
  const value = env[key];
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeCommandName(command: string): string {
  const base = path.basename(command).toLowerCase();
  return base.replace(/\.(cmd|exe|bat)$/i, "");
}

function redactOutput(output: string): string {
  return output
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/(token|api[_-]?key|secret|password)=\S+/gi, "$1=[redacted]")
    .trim()
    .slice(0, 500);
}

function firstOutputLine(output: string): string | undefined {
  return output.trim().split(/\r?\n/).find(Boolean);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === "string");
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
