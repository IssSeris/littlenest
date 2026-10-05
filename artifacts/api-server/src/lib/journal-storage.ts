import { Storage } from "@google-cloud/storage";
import type { Readable } from "node:stream";

export interface JournalStorage {
  put(id: string, bytes: Buffer, contentType: string): Promise<void>;
  read(id: string): Readable;
  remove(id: string): Promise<void>;
}
const endpoint = "http://127.0.0.1:1106";
const client = new Storage({
  credentials: {
    audience: "replit", subject_token_type: "access_token",
    token_url: `${endpoint}/token`, type: "external_account",
    credential_source: { url: `${endpoint}/credential`, format: { type: "json", subject_token_field_name: "access_token" } },
    universe_domain: "googleapis.com",
  }, projectId: "",
});
function file(id: string) {
  const path = process.env.PRIVATE_OBJECT_DIR;
  if (!path?.startsWith("/")) throw new Error("Private attachment storage is not configured.");
  const [bucket, ...prefix] = path.slice(1).split("/");
  return client.bucket(bucket).file(`${prefix.join("/")}/journal/${id}`);
}
export const journalStorage: JournalStorage = {
  async put(id, bytes, contentType) { await file(id).save(bytes, { resumable: false, metadata: { contentType } }); },
  read(id) { return file(id).createReadStream(); },
  async remove(id) { await file(id).delete({ ignoreNotFound: true }); },
};

export function attachmentContentType(bytes: Buffer, name: string): string | null {
  if (bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString())) return "image/gif";
  if (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP") return "image/webp";
  if (bytes.subarray(0, 5).toString() === "%PDF-") return "application/pdf";
  // Other allowed files are always downloads, never interpreted as active web content.
  const ext = name.split(".").pop()?.toLowerCase();
  if (ext && ["txt", "csv", "md", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "zip"].includes(ext)) return "application/octet-stream";
  return null;
}