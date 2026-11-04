/** ORB-2758 - the bytes of an attachment tool call: base64 from the model, or a local file the stdio server reads itself. */
import type { LocalFile } from '../local-file.js';

export interface AttachmentInput { filename?: string; contentBase64?: string; filePath?: string; localFiles: boolean }

export async function attachmentBytes(
  input: AttachmentInput,
  readLocal: (filePath: string) => Promise<LocalFile>,
): Promise<{ bytes: ArrayBuffer; filename: string }> {
  if (input.filePath !== undefined && !input.localFiles) throw new Error('filePath is only read by the local stdio server; pass contentBase64, or mint a browser link with orboto_upload_link.');
  if ((input.filePath === undefined) === (input.contentBase64 === undefined)) throw new Error('Pass exactly one of filePath or contentBase64.');
  let buf: Buffer;
  let filename = input.filename;
  if (input.filePath !== undefined) {
    const local = await readLocal(input.filePath);
    buf = local.bytes;
    filename ??= local.filename;
  } else {
    if (!filename) throw new Error('filename is required with contentBase64.');
    buf = Buffer.from(input.contentBase64!, 'base64');
    if (buf.byteLength === 0) throw new Error('contentBase64 decoded to 0 bytes - refuse to upload an empty file.');
  }
  const bytes = new ArrayBuffer(buf.byteLength);
  new Uint8Array(bytes).set(buf);
  return { bytes, filename };
}
