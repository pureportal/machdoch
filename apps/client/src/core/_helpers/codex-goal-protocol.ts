import { getManyValues, none, type Many } from "stream-chain/core";
import {
  jsonParser,
  type ParserOptions,
  type Token,
} from "stream-json/core/parser.js";
import {
  sliceUtf16PrefixAtCodePointBoundary,
  sliceUtf16SuffixAtCodePointBoundary,
} from "@machdoch/fleet-protocol/unicode";

declare module "stream-json/core/parser.js" {
  export function jsonParser(options?: ParserOptions): GoalTokenizer;
}

type GoalTokenizer = (chunk: string | typeof none) => Many<Token> | typeof none;

const MAX_PARSE_CHUNK_CHARS = 16_384;
const MAX_DEPTH = 64;
const MAX_KEY_CHARS = 512;
const TRUNCATION_MARKER = "\n[output truncated by machdoch]\n";

interface ValueLimit {
  maxChars: number;
  truncate: boolean;
}
type Projection = ValueLimit | { readonly [key: string]: Projection };

const control: ValueLimit = { maxChars: 8_192, truncate: false };
const evidence: ValueLimit = { maxChars: 12_000, truncate: true };
const message: ValueLimit = { maxChars: 512_000, truncate: true };
const error = { message: control };
const turn = { id: control, status: control, error };
const goal = { status: control };
const envelope: Projection = {
  id: control,
  method: control,
  error,
  result: { thread: { id: control }, turn, goal },
  params: {
    threadId: control,
    turn,
    goal,
    error,
    willRetry: control,
    tokenUsage: {
      total: {
        inputTokens: control,
        outputTokens: control,
        totalTokens: control,
        cachedInputTokens: control,
        reasoningOutputTokens: control,
      },
    },
    item: {
      id: control,
      type: control,
      text: message,
      command: evidence,
      cwd: evidence,
      aggregatedOutput: evidence,
      exitCode: control,
      status: control,
      server: control,
      tool: control,
      arguments: evidence,
      changes: evidence,
      result: evidence,
      error: evidence,
    },
  },
};

interface Budget extends ValueLimit {
  remaining: number;
}
interface Frame {
  projection: Projection | undefined;
  budget: Budget | undefined;
  value: Record<string, unknown> | unknown[] | undefined;
  key: string | undefined;
}
interface Scalar {
  kind: "key" | "string" | "number";
  budget: Budget | undefined;
  capacity: number;
  length: number;
  head: string;
  tail: string;
}

const isLimit = (projection: Projection): projection is ValueLimit =>
  typeof projection.maxChars === "number";

export class CodexGoalProtocolError extends Error {}

export class CodexGoalProtocolReader {
  private parser: GoalTokenizer | undefined;
  private readonly frames: Frame[] = [];
  private scalar: Scalar | undefined;
  private root: Record<string, unknown> | undefined;
  private truncated = false;

  reset(): void {
    this.parser = undefined;
    this.frames.length = 0;
    this.scalar = undefined;
    this.root = undefined;
    this.truncated = false;
  }

  push(
    chunk: string,
    onEvent: (event: Record<string, unknown>) => boolean,
  ): void {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf("\n", offset);
      const end = newline < 0 ? chunk.length : newline;
      for (
        let position = offset;
        position < end;
        position += MAX_PARSE_CHUNK_CHARS
      )
        this.parse(
          chunk.slice(
            position,
            Math.min(end, position + MAX_PARSE_CHUNK_CHARS),
          ),
        );
      if (newline < 0) return;
      const event = this.finishLine();
      if (event && !onEvent(event)) return;
      offset = newline + 1;
    }
  }

  finish(onEvent: (event: Record<string, unknown>) => boolean): void {
    const event = this.finishLine();
    if (event) onEvent(event);
  }

  private parse(chunk: string | typeof none): void {
    if (!this.parser) {
      if (chunk === none || !chunk.trim()) return;
      this.parser = jsonParser({ packValues: false });
    }
    try {
      const tokens = this.parser(chunk);
      if (tokens !== none)
        for (const token of getManyValues(tokens)) this.accept(token);
    } catch (error) {
      throw new CodexGoalProtocolError(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private finishLine(): Record<string, unknown> | undefined {
    this.parse(none);
    const event = this.root;
    if (this.parser && !event)
      throw new CodexGoalProtocolError("Expected a goal protocol object.");
    if (this.truncated && event) {
      const params = event.params as Record<string, unknown> | undefined;
      const item = params?.item as Record<string, unknown> | undefined;
      if (item) item.outputTruncated = true;
    }
    this.reset();
    return event;
  }

  private selection(): {
    projection: Projection | undefined;
    budget: Budget | undefined;
  } {
    const parent = this.frames.at(-1);
    if (!parent) return { projection: envelope, budget: undefined };
    if (!parent.projection) return { projection: undefined, budget: undefined };
    if (isLimit(parent.projection))
      return { projection: parent.projection, budget: parent.budget };
    const projection =
      parent.key !== undefined && Object.hasOwn(parent.projection, parent.key)
        ? parent.projection[parent.key]
        : undefined;
    return {
      projection,
      budget:
        projection && isLimit(projection)
          ? { ...projection, remaining: projection.maxChars }
          : undefined,
    };
  }

  private reserve(budget: Budget | undefined, chars: number): boolean {
    if (!budget) return true;
    if (budget.remaining >= chars) {
      budget.remaining -= chars;
      return true;
    }
    if (!budget.truncate)
      throw new Error("Goal protocol control value is too large.");
    this.truncated = true;
    return false;
  }

  private attach(value: unknown): void {
    const parent = this.frames.at(-1);
    if (!parent) {
      if (value === null || typeof value !== "object" || Array.isArray(value))
        throw new Error("Expected a goal protocol object.");
      this.root = value as Record<string, unknown>;
      return;
    }
    if (value !== undefined && parent.value) {
      if (Array.isArray(parent.value)) parent.value.push(value);
      else if (parent.key !== undefined)
        Object.defineProperty(parent.value, parent.key, {
          value,
          enumerable: true,
          configurable: true,
          writable: true,
        });
    }
    parent.key = undefined;
  }

  private accept(token: Token): void {
    switch (token.name) {
      case "startObject":
      case "startArray": {
        if (this.frames.length >= MAX_DEPTH)
          throw new Error("Goal protocol nesting is too deep.");
        const selected = this.selection();
        const value =
          selected.projection && this.reserve(selected.budget, 16)
            ? token.name === "startArray"
              ? []
              : {}
            : undefined;
        this.frames.push({ ...selected, value, key: undefined });
        break;
      }
      case "endObject":
      case "endArray":
        this.attach(this.frames.pop()?.value);
        break;
      case "startKey":
      case "startString":
      case "startNumber": {
        const { projection, budget } = this.selection();
        const kind =
          token.name === "startKey"
            ? "key"
            : token.name === "startNumber"
              ? "number"
              : "string";
        const capacity =
          kind === "key"
            ? MAX_KEY_CHARS
            : projection
              ? Math.max(
                  0,
                  Math.min(
                    budget?.remaining ?? control.maxChars,
                    kind === "number"
                      ? 128
                      : (budget?.maxChars ?? control.maxChars),
                  ) - 8,
                )
              : 0;
        this.scalar = { kind, budget, capacity, length: 0, head: "", tail: "" };
        break;
      }
      case "stringChunk":
      case "numberChunk": {
        const scalar = this.scalar!;
        scalar.length += token.value.length;
        if (scalar.kind === "key" || !scalar.budget?.truncate) {
          if (scalar.length > scalar.capacity && scalar.capacity > 0)
            throw new Error("Goal protocol control value is too large.");
          if (scalar.capacity) scalar.head += token.value;
        } else {
          const half = Math.floor(
            Math.max(0, scalar.capacity - TRUNCATION_MARKER.length) / 2,
          );
          if (scalar.head.length < half)
            scalar.head += token.value.slice(0, half - scalar.head.length);
          if (half) {
            scalar.tail += token.value;
            if (scalar.tail.length > half * 2)
              scalar.tail = scalar.tail.slice(-half);
          }
        }
        break;
      }
      case "endKey": {
        const scalar = this.scalar!;
        const parent = this.frames.at(-1)!;
        parent.key =
          parent.projection &&
          this.reserve(parent.budget, scalar.head.length + 8)
            ? scalar.head
            : undefined;
        this.scalar = undefined;
        break;
      }
      case "endString":
      case "endNumber": {
        const scalar = this.scalar!;
        let value: unknown = undefined;
        if (scalar.capacity) {
          let text = scalar.head;
          if (scalar.budget?.truncate) {
            const half = Math.floor(
              Math.max(0, scalar.capacity - TRUNCATION_MARKER.length) / 2,
            );
            const tail = scalar.tail.slice(-half);
            if (scalar.length > half * 2) {
              this.truncated = true;
              text =
                sliceUtf16PrefixAtCodePointBoundary(scalar.head, half) +
                TRUNCATION_MARKER +
                sliceUtf16SuffixAtCodePointBoundary(tail, half);
            } else if (scalar.length > half) {
              text += tail.slice(half * 2 - scalar.length);
            }
          }
          if (this.reserve(scalar.budget, text.length + 8))
            value = scalar.kind === "number" ? Number(text) : text;
        } else if (scalar.budget?.truncate) this.truncated = true;
        this.attach(value);
        this.scalar = undefined;
        break;
      }
      case "nullValue":
      case "trueValue":
      case "falseValue": {
        const { projection, budget } = this.selection();
        this.attach(
          projection && this.reserve(budget, 8) ? token.value : undefined,
        );
        break;
      }
    }
  }
}
