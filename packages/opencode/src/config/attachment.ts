export * as ConfigAttachment from "./attachment"

import { Schema } from "effect"
import { NonNegativeInt, PositiveInt } from "@opencode-ai/core/schema"

export const DEFAULT_IMAGE_MAX_BASE64_BYTES = 5 * 1024 * 1024
export const DEFAULT_DOCX = {
  max_images: 20,
  max_image_bytes: 3_932_160,
  max_total_image_bytes: 20_971_520,
  timeout_ms: 30_000,
  max_text_chars: 200_000,
} as const

export const Image = Schema.Struct({
  auto_resize: Schema.optional(Schema.Boolean).annotate({
    description: "Resize images before sending them to the model when they exceed configured limits (default: true)",
  }),
  max_width: Schema.optional(PositiveInt).annotate({
    description: "Maximum image width before resizing or rejecting the attachment (default: 2000)",
  }),
  max_height: Schema.optional(PositiveInt).annotate({
    description: "Maximum image height before resizing or rejecting the attachment (default: 2000)",
  }),
  max_base64_bytes: Schema.optional(PositiveInt).annotate({
    description: "Maximum base64 payload bytes for an image attachment (default: 5242880)",
  }),
}).annotate({ identifier: "ImageAttachmentConfig" })
export type Image = Schema.Schema.Type<typeof Image>

export const Docx = Schema.Struct({
  max_images: Schema.optional(NonNegativeInt).annotate({
    description: "Maximum number of embedded DOCX images to send to the model (default: 20)",
  }),
  max_image_bytes: Schema.optional(PositiveInt).annotate({
    description: "Maximum raw bytes for a single embedded DOCX image (default: 3932160)",
  }),
  max_total_image_bytes: Schema.optional(PositiveInt).annotate({
    description: "Maximum total raw bytes for embedded DOCX images (default: 20971520)",
  }),
  timeout_ms: Schema.optional(PositiveInt).annotate({
    description: "Maximum time in milliseconds spent extracting DOCX embedded images (default: 30000)",
  }),
  max_text_chars: Schema.optional(PositiveInt).annotate({
    description: "Maximum extracted DOCX text characters before truncation (default: 200000)",
  }),
}).annotate({ identifier: "DocxAttachmentConfig" })
export type Docx = Schema.Schema.Type<typeof Docx>

export function resolveDocx(input: Docx | undefined) {
  return {
    maxImages: input?.max_images ?? DEFAULT_DOCX.max_images,
    maxImageBytes: input?.max_image_bytes ?? DEFAULT_DOCX.max_image_bytes,
    maxTotalImageBytes: input?.max_total_image_bytes ?? DEFAULT_DOCX.max_total_image_bytes,
    timeoutMs: input?.timeout_ms ?? DEFAULT_DOCX.timeout_ms,
    maxTextChars: input?.max_text_chars ?? DEFAULT_DOCX.max_text_chars,
  }
}

export const Info = Schema.Struct({
  image: Schema.optional(Image).annotate({ description: "Image attachment configuration" }),
  docx: Schema.optional(Docx).annotate({ description: "DOCX attachment extraction configuration" }),
}).annotate({ identifier: "AttachmentConfig" })
export type Info = Schema.Schema.Type<typeof Info>
