import { app, safeStorage } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

type ApiKeyFile = {
  version: 1;
  openAiApiKey?: string | null;
  openAiApiKeyEncoding?: "safeStorage" | "plain";
  updatedAt?: string;
};

export type ApiKeyStatus = {
  configured: boolean;
  source: "environment" | "saved" | null;
  encrypted: boolean;
};

const FILE_NAME = "cva-secrets.json";

export function getOpenAiApiKey(): string | null {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  const saved = readFile();
  if (!saved.openAiApiKey) return null;

  if (saved.openAiApiKeyEncoding === "safeStorage") {
    try {
      return safeStorage.decryptString(Buffer.from(saved.openAiApiKey, "base64"));
    } catch {
      return null;
    }
  }

  return saved.openAiApiKey;
}

export function getOpenAiApiKeyStatus(): ApiKeyStatus {
  if (process.env.OPENAI_API_KEY) {
    return { configured: true, source: "environment", encrypted: false };
  }
  const saved = readFile();
  if (saved.openAiApiKeyEncoding === "safeStorage" && saved.openAiApiKey) {
    try {
      safeStorage.decryptString(Buffer.from(saved.openAiApiKey, "base64"));
    } catch {
      return { configured: false, source: null, encrypted: true };
    }
  }
  return {
    configured: Boolean(saved.openAiApiKey),
    source: saved.openAiApiKey ? "saved" : null,
    encrypted: saved.openAiApiKeyEncoding === "safeStorage",
  };
}

export function saveOpenAiApiKey(apiKey: string): ApiKeyStatus {
  const trimmed = apiKey.trim();
  if (!trimmed) {
    clearOpenAiApiKey();
    return getOpenAiApiKeyStatus();
  }

  const encrypted = safeStorage.isEncryptionAvailable();
  const file: ApiKeyFile = {
    version: 1,
    openAiApiKey: encrypted
      ? safeStorage.encryptString(trimmed).toString("base64")
      : trimmed,
    openAiApiKeyEncoding: encrypted ? "safeStorage" : "plain",
    updatedAt: new Date().toISOString(),
  };
  writeFile(file);
  return getOpenAiApiKeyStatus();
}

export function clearOpenAiApiKey(): ApiKeyStatus {
  writeFile({ version: 1, openAiApiKey: null, openAiApiKeyEncoding: undefined });
  return getOpenAiApiKeyStatus();
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
