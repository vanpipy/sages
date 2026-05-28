/**
 * Image utilities for MiniMax API
 * 
 * Handles conversion of local files, HTTP URLs, and data URIs
 * to the format required by various MiniMax endpoints.
 */

import { readFileSync, existsSync } from "fs";
import { extname } from "path";

export const IMAGE_MIME_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
};

const MAX_IMAGE_SIZE_BYTES = 50 * 1024 * 1024; // 50MB

/**
 * Convert a local file to a data URI (base64-encoded)
 */
export function localFileToDataUri(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  const mime = IMAGE_MIME_TYPES[ext] || "image/jpeg";
  const data = readFileSync(filePath);
  return `data:${mime};base64,${data.toString("base64")}`;
}

/**
 * Check if a file exists and is a supported image format
 */
export function validateImageFile(filePath: string): void {
  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  
  const ext = extname(filePath).toLowerCase();
  if (!IMAGE_MIME_TYPES[ext]) {
    const supported = Object.keys(IMAGE_MIME_TYPES).join(", ");
    throw new Error(`Unsupported image format "${ext}". Supported: ${supported}`);
  }
}

/**
 * Convert an image (local file, HTTP URL, or data URI) to a data URI.
 * 
 * This is needed because the MiniMax VLM endpoint requires images to be
 * base64-encoded data URIs, not raw URLs.
 * 
 * @param image - Local file path, HTTP(S) URL, or data URI
 * @returns Data URI string (data:image/...;base64,...)
 */
export async function toDataUri(image: string): Promise<string> {
  // Already a data URI
  if (image.startsWith("data:")) {
    return image;
  }

  // HTTP(S) URL - download and convert
  if (image.startsWith("http://") || image.startsWith("https://")) {
    const response = await fetch(image);
    if (!response.ok) {
      throw new Error(`Failed to download image: HTTP ${response.status}`);
    }

    const contentType = response.headers.get("content-type") || "image/jpeg";
    const mime = contentType.split(";")[0]?.trim() || "image/jpeg";
    const buffer = await response.arrayBuffer();

    if (buffer.byteLength > MAX_IMAGE_SIZE_BYTES) {
      throw new Error(
        `Image too large (${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB). Maximum is 50 MB.`
      );
    }

    return `data:${mime};base64,${Buffer.from(buffer).toString("base64")}`;
  }

  // Local file
  validateImageFile(image);
  return localFileToDataUri(image);
}

/**
 * Resolve image input to appropriate format.
 * For HTTP URLs, returns as-is (some APIs accept URLs directly).
 * For local files, converts to data URI.
 */
export async function resolveImageInput(image: string): Promise<string> {
  // For local files, always convert to data URI
  if (!image.startsWith("http") && !image.startsWith("data:")) {
    validateImageFile(image);
    return localFileToDataUri(image);
  }
  
  // For HTTP URLs, still convert to data URI for VLM compatibility
  if (image.startsWith("http://") || image.startsWith("https://")) {
    const response = await fetch(image);
    if (!response.ok) {
      throw new Error(`Failed to download image: HTTP ${response.status}`);
    }
    const contentType = response.headers.get("content-type") || "image/jpeg";
    const mime = contentType.split(";")[0]?.trim() || "image/jpeg";
    const buffer = await response.arrayBuffer();
    return `data:${mime};base64,${Buffer.from(buffer).toString("base64")}`;
  }
  
  return image;
}
