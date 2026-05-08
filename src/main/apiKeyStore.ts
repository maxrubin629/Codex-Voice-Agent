import { app, safeStorage } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

type ApiKeyFile = {
  version: 1;
  openAiApiKey?: string | null;
  openAiApiKeyEncoding?: "safeStorage" | "plain";
  exaApiKey?: string | null;
  exaApiKeyEncoding?: "safeStorage" | "plain";
  updatedAt?: string;
};

export type ApiKeyStatus = {
  configured: boolean;
  source: "environment" | "saved" | null;
  encrypted: boolean;
};

export type ApiKeySecretView = {
  value: string;
  source: "environment" | "saved";
  encrypted: boolean;
};

const FILE_NAME = "codex-voice-secrets.json";

export function getOpenAiApiKey(): string | null {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  const saved = readFile();
  return decodeSavedSecret(saved.openAiApiKey, saved.openAiApiKeyEncoding);
}

export function getOpenAiApiKeyStatus(): ApiKeyStatus {
  if (process.env.OPENAI_API_KEY) {
    return { configured: true, source: "environment", encrypted: false };
  }
  const saved = readFile();
  return savedSecretStatus(saved.openAiApiKey, saved.openAiApiKeyEncoding);
}

export function revealOpenAiApiKey(): ApiKeySecretView {
  return revealSecret(getOpenAiApiKey(), getOpenAiApiKeyStatus(), "OpenAI API key");
}

export function saveOpenAiApiKey(apiKey: string): ApiKeyStatus {
  const trimmed = apiKey.trim();
  if (!trimmed) {
    clearOpenAiApiKey();
    return getOpenAiApiKeyStatus();
  }

  const current = readFile();
  const secret = encodeSecret(trimmed);
  const file: ApiKeyFile = {
    ...current,
    version: 1,
    openAiApiKey: secret.value,
    openAiApiKeyEncoding: secret.encoding,
    updatedAt: new Date().toISOString(),
  };
  writeFile(file);
  return getOpenAiApiKeyStatus();
}

export function clearOpenAiApiKey(): ApiKeyStatus {
  const current = readFile();
  writeFile({ ...current, version: 1, openAiApiKey: null, openAiApiKeyEncoding: undefined });
  return getOpenAiApiKeyStatus();
}

export function getExaApiKey(): string | null {
  if (process.env.EXA_API_KEY) return process.env.EXA_API_KEY;
  const saved = readFile();
  return decodeSavedSecret(saved.exaApiKey, saved.exaApiKeyEncoding);
}

export function getExaApiKeyStatus(): ApiKeyStatus {
  if (process.env.EXA_API_KEY) {
    return { configured: true, source: "environment", encrypted: false };
  }
  const saved = readFile();
  return savedSecretStatus(saved.exaApiKey, saved.exaApiKeyEncoding);
}

export function revealExaApiKey(): ApiKeySecretView {
  return revealSecret(getExaApiKey(), getExaApiKeyStatus(), "Exa API key");
}

export function saveExaApiKey(apiKey: string): ApiKeyStatus {
  const trimmed = apiKey.trim();
  if (!trimmed) {
    clearExaApiKey();
    return getExaApiKeyStatus();
  }

  const current = readFile();
  const secret = encodeSecret(trimmed);
  writeFile({
    ...current,
    version: 1,
    exaApiKey: secret.value,
    exaApiKeyEncoding: secret.encoding,
    updatedAt: new Date().toISOString(),
  });
  return getExaApiKeyStatus();
}

export function clearExaApiKey(): ApiKeyStatus {
  const current = readFile();
  writeFile({ ...current, version: 1, exaApiKey: null, exaApiKeyEncoding: undefined });
  return getExaApiKeyStatus();
}

function secretsPath(): string {
  return path.join(app.getPath("userData"), FILE_NAME);
}

function readFile(): ApiKeyFile {
  try {
    const filePath = secretsPath();
    if (!existsSync(filePath)) return { version: 1 };
    return JSON.parse(readFileSync(filePath, "utf8")) as ApiKeyFile;
  } catch {
    return { version: 1 };
  }
}

function writeFile(file: ApiKeyFile): void {
  const filePath = secretsPath();
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(file, null, 2), { mode: 0o600 });
}

function encodeSecret(value: string): { value: string; encoding: "safeStorage" | "plain" } {
  const encrypted = safeStorage.isEncryptionAvailable();
  return {
    value: encrypted ? safeStorage.encryptString(value).toString("base64") : value,
    encoding: encrypted ? "safeStorage" : "plain",
  };
}

function decodeSavedSecret(
  value: string | null | undefined,
  encoding: "safeStorage" | "plain" | undefined,
): string | null {
  if (!value) return null;
  if (encoding === "safeStorage") {
    try {
      return safeStorage.decryptString(Buffer.from(value, "base64"));
    } catch {
      return null;
    }
  }
  return value;
}

function savedSecretStatus(
  value: string | null | undefined,
  encoding: "safeStorage" | "plain" | undefined,
): ApiKeyStatus {
  if (encoding === "safeStorage" && value) {
    try {
      safeStorage.decryptString(Buffer.from(value, "base64"));
    } catch {
      return { configured: false, source: null, encrypted: true };
    }
  }
  return {
    configured: Boolean(value),
    source: value ? "saved" : null,
    encrypted: encoding === "safeStorage",
  };
}

function revealSecret(
  value: string | null,
  status: ApiKeyStatus,
  label: string,
): ApiKeySecretView {
  if (!value || !status.configured || !status.source) {
    throw new Error(`${label} is not configured.`);
  }
  return {
    value,
    source: status.source,
    encrypted: status.encrypted,
  };
}
