// Fleet fork patch, part 4 (see platform-v2/docs/OPENCODE-FORK.md): media
// base64 validation must stay LINEAR. JSC's regex engine exhausts its internal
// stack on the old nested-quantifier pattern (`(?:...{4})*`) over multi-MB
// inputs and reports NO MATCH instead of throwing, so a valid ~4 MB image was
// rejected with "media must contain valid base64" (observed live 2026-07-10 on
// the 4.15 MB steganography quickstart sample under Linux Bun).
//
// This suite proves the full provider validation path accepts media up to the
// max supported size — MAX_MEDIA_DECODED_BYTES (20 MB), which is also OpenAI's
// documented per-image limit — and still rejects malformed base64. Run by
// platform-v2/scripts/build-opencode.sh on every cache-miss build.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { LLM, Message } from "../src"
import { Auth, LLMClient } from "../src/route"
import * as OpenAIResponses from "../src/protocols/openai-responses"
import * as ProviderShared from "../src/protocols/shared"
import { it } from "./lib/effect"

const model = OpenAIResponses.route
  .with({ endpoint: { baseURL: "https://api.openai.test/v1/" }, auth: Auth.bearer("test") })
  .model({ id: "gpt-4.1-mini" })

const imageRequest = (id: string, data: string) =>
  LLM.request({ id, model, messages: [Message.user({ type: "media", mediaType: "image/png", data })] })

const imageUrlOf = (body: OpenAIResponses.OpenAIResponsesBody) => {
  const content = (body.input[0] as unknown as { content: Array<{ type: string; image_url: string }> }).content[0]!
  expect(content.type).toBe("input_image")
  return content.image_url
}

describe("Fleet media validation (linear base64 pattern)", () => {
  it.effect("accepts a data URL image at the max supported decoded size (20 MB)", () =>
    Effect.gen(function* () {
      const bytes = Buffer.alloc(ProviderShared.MAX_MEDIA_DECODED_BYTES)
      for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251
      const dataUrl = `data:image/png;base64,${bytes.toString("base64")}`

      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        imageRequest("req_media_max", dataUrl),
      )

      expect(imageUrlOf(prepared.body)).toBe(dataUrl)
    }),
  )

  // The live failure: 4,147,536 decoded bytes -> 5,530,048 base64 chars, just
  // past the size where JSC gave up on the old pattern (~5.5M chars).
  it.effect("accepts a data URL image at the size that regressed under JSC (~4 MB)", () =>
    Effect.gen(function* () {
      const dataUrl = `data:image/png;base64,${Buffer.alloc(4_147_536, 7).toString("base64")}`

      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        imageRequest("req_media_stego", dataUrl),
      )

      expect(imageUrlOf(prepared.body)).toBe(dataUrl)
    }),
  )

  it.effect("accepts raw base64 media at the max supported decoded size", () =>
    Effect.gen(function* () {
      const base64 = Buffer.alloc(ProviderShared.MAX_MEDIA_DECODED_BYTES, 3).toString("base64")

      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        imageRequest("req_media_raw", base64),
      )

      expect(imageUrlOf(prepared.body)).toBe(`data:image/png;base64,${base64}`)
    }),
  )

  const invalid = [
    ["a non-base64 character", "abc!"],
    ["mid-string padding", "ab==cd=="],
    ["excess padding", "AAAA===="],
    ["a bare workspace path", "/workspace/thread/image.png"],
    ["a length not divisible by 4", "AAAAA"],
  ] as const

  for (const [label, data] of invalid) {
    it.effect(`still rejects ${label}`, () =>
      Effect.gen(function* () {
        const error = yield* LLMClient.prepare(imageRequest("req_media_invalid", data)).pipe(Effect.flip)
        expect(error.message).toContain("OpenAI Responses media must contain valid base64")
      }),
    )
  }
})
