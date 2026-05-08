import type { RealtimeUserAttachment } from "../../shared/types";

export type AttachmentRejection = {
  name: string;
  reason: string;
};

export type AttachmentConversionResult = {
  attachments: RealtimeUserAttachment[];
  rejected: AttachmentRejection[];
};

const allowedImageMimeTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const defaultMaxImageBytes = 8 * 1024 * 1024;

export function filesFromDataTransfer(dataTransfer: DataTransfer | null): File[] {
  if (!dataTransfer) return [];
  return Array.from(dataTransfer.files ?? []);
}

export function filesFromClipboard(clipboardData: DataTransfer | null): File[] {
  if (!clipboardData) return [];
  return Array.from(clipboardData.files ?? []);
}

export function dataTransferHasImage(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false;
  const files = Array.from(dataTransfer.items ?? []);
  return files.some((item) => item.kind === "file" && item.type.startsWith("image/"));
}

export async function filesToRealtimeAttachments(
  files: File[],
  options: { maxImageBytes?: number } = {},
): Promise<AttachmentConversionResult> {
  const maxImageBytes = options.maxImageBytes ?? defaultMaxImageBytes;
  const attachments: RealtimeUserAttachment[] = [];
  const rejected: AttachmentRejection[] = [];

  for (const file of files) {
    if (!file.type.startsWith("image/")) {
      rejected.push({ name: file.name || "Dropped file", reason: "Only images can be sent to Realtime." });
      continue;
    }
    if (!allowedImageMimeTypes.has(file.type)) {
      rejected.push({ name: file.name || "Image", reason: `${file.type || "This image type"} is not supported yet.` });
      continue;
    }
    if (file.size > maxImageBytes) {
      rejected.push({
        name: file.name || "Image",
        reason: `Image is larger than ${formatBytes(maxImageBytes)}.`,
      });
      continue;
    }

    const dataUrl = await fileToDataUrl(file);
    attachments.push({
      id: `image-${Date.now()}-${attachments.length}-${stableFileToken(file)}`,
      kind: "image",
      name: file.name || "image",
      mimeType: file.type,
      sizeBytes: file.size,
      dataUrl,
      localPath: localPathForFile(file),
    });
  }

  return { attachments, rejected };
}

function localPathForFile(file: File): string | null {
  const maybePath = (file as File & { path?: unknown }).path;
  return typeof maybePath === "string" && maybePath.trim() ? maybePath : null;
}

async function fileToDataUrl(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const base64 = bytesToBase64(bytes);
  return `data:${file.type || "application/octet-stream"};base64,${base64}`;
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = "";
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return window.btoa(binary);
}

function stableFileToken(file: File): string {
  return [file.name, file.size, file.lastModified].join("-").replace(/[^a-z0-9._-]+/gi, "_");
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
