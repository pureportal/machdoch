import type { FinalAnswerStreamSnapshot } from "../../types.js";

const MAX_ANSWER_BYTES = 1_048_576;
const utf8 = new TextEncoder();
type Message = {
  phase: string | null;
  parts: Map<number, string>;
  sequence: number;
  bytes: number;
  status: FinalAnswerStreamSnapshot["status"];
};
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const id = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 && value.length <= 512
    ? value
    : null;

export class OpenAIFinalAnswerStream {
  private responseId: string | null = null;
  private readonly messages = new Map<string, Message>();
  consume(value: unknown): FinalAnswerStreamSnapshot[] {
    const event = object(value);
    if (
      !event ||
      typeof event.sequence_number !== "number" ||
      !Number.isSafeInteger(event.sequence_number) ||
      event.sequence_number < 0
    )
      return [];
    const sequence = event.sequence_number;
    const response = object(event.response);
    if (event.type === "response.created") {
      const next = id(response?.id);
      if (next === this.responseId) return [];
      const retracted = [...this.messages].flatMap(([answerId, message]) =>
        message.phase === "final_answer" &&
        message.status !== "retracted" &&
        message.status !== "limited"
          ? [
              this.snapshot(
                answerId,
                message,
                Math.max(sequence, message.sequence + 1),
                "retracted",
                "The provider replaced this answer stream. Replay the corrected answer deliberately.",
              ),
            ]
          : [],
      );
      this.responseId = next;
      this.messages.clear();
      return retracted;
    }
    if (!this.responseId) return [];
    if (
      event.type === "response.failed" ||
      event.type === "response.incomplete" ||
      event.type === "error"
    ) {
      return [...this.messages].flatMap(([answerId, message]) =>
        message.phase === "final_answer" &&
        message.status !== "retracted" &&
        message.status !== "limited"
          ? [
              this.snapshot(
                answerId,
                message,
                sequence,
                "retracted",
                "The answer stream did not complete. Read the completed answer deliberately.",
              ),
            ]
          : [],
      );
    }
    if (event.type === "response.completed")
      return [...this.messages].flatMap(([answerId, message]) => {
        if (message.phase !== "final_answer" || message.status !== "streaming")
          return [];
        const item = Array.isArray(response?.output)
          ? response.output.find((value) => object(value)?.id === answerId)
          : null;
        return item
          ? this.consume({
              type: "response.output_item.done",
              item,
              sequence_number: sequence,
            })
          : [
              this.snapshot(
                answerId,
                message,
                sequence,
                "retracted",
                "The final answer stream has no verified completion. Read the completed answer deliberately.",
              ),
            ];
      });
    if (
      event.type === "response.output_item.added" ||
      event.type === "response.output_item.done"
    ) {
      const item = object(event.item);
      const answerId = id(item?.id);
      const agent = object(item?.agent);
      if (typeof agent?.agent_name === "string" && agent.agent_name !== "/root")
        return [];
      if (
        !item ||
        !answerId ||
        item.type !== "message" ||
        item.role !== "assistant"
      )
        return [];
      const previous = this.messages.get(answerId);
      if (previous && sequence <= previous.sequence) return [];
      if (!previous && this.messages.size >= 32) return [];
      const message = previous ?? {
        phase: null,
        parts: new Map<number, string>(),
        sequence,
        bytes: 0,
        status: "streaming",
      };
      const wasFinal = message.phase === "final_answer";
      message.phase = typeof item.phase === "string" ? item.phase : null;
      this.messages.set(answerId, message);
      if (wasFinal && message.phase !== "final_answer")
        return [
          this.snapshot(
            answerId,
            message,
            sequence,
            "retracted",
            "The provider revised the answer channel. Replay the corrected answer deliberately.",
          ),
        ];
      if (message.phase !== "final_answer") return [];
      if (message.status === "limited") return [];
      if (Array.isArray(item.content) && item.content.length) {
        const parts = item.content.flatMap((part) => {
          const text = object(part);
          return text?.type === "output_text" && typeof text.text === "string"
            ? [text.text]
            : [];
        });
        if (parts.length > 32) return [this.limit(answerId, message, sequence)];
        const text = parts.join("\n");
        if (utf8.encode(text).byteLength > MAX_ANSWER_BYTES)
          return [this.limit(answerId, message, sequence)];
        message.parts = new Map(parts.map((text, index) => [index, text]));
        message.bytes = utf8.encode(text).byteLength;
      }
      const status =
        event.type === "response.output_item.done"
          ? item.status === "completed"
            ? "completed"
            : "retracted"
          : "streaming";
      return [this.snapshot(answerId, message, sequence, status)];
    }
    if (
      event.type !== "response.output_text.delta" &&
      event.type !== "response.output_text.done"
    )
      return [];
    const answerId = id(event.item_id);
    if (!answerId) return [];
    const message = this.messages.get(answerId);
    if (
      !message ||
      sequence <= message.sequence ||
      message.status !== "streaming"
    )
      return [];
    const index = event.content_index;
    if (
      typeof index !== "number" ||
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= 32
    )
      return message.phase === "final_answer"
        ? [this.limit(answerId, message, sequence)]
        : [];
    const text =
      event.type === "response.output_text.done" ? event.text : event.delta;
    if (typeof text !== "string") return [];
    const previous = message.parts.get(index) ?? "";
    const next =
      event.type === "response.output_text.done" ? text : previous + text;
    const bytes =
      message.bytes -
      utf8.encode(previous).byteLength +
      utf8.encode(next).byteLength;
    if (bytes > MAX_ANSWER_BYTES)
      return message.phase === "final_answer"
        ? [this.limit(answerId, message, sequence)]
        : [];
    message.parts.set(index, next);
    message.bytes = bytes;
    message.sequence = sequence;
    return message.phase === "final_answer"
      ? [this.snapshot(answerId, message, sequence, "streaming")]
      : [];
  }
  private limit(
    answerId: string,
    message: Message,
    sequence: number,
  ): FinalAnswerStreamSnapshot {
    return this.snapshot(
      answerId,
      message,
      sequence,
      "limited",
      "The final answer stream exceeded its local size limit. Read a shorter completed selection.",
    );
  }
  private snapshot(
    answerId: string,
    message: Message,
    sequence: number,
    status: FinalAnswerStreamSnapshot["status"],
    reason?: string,
  ): FinalAnswerStreamSnapshot {
    message.sequence = sequence;
    message.status = status;
    return {
      source: "openai-responses",
      channel: "final_answer",
      responseId: this.responseId!,
      answerId,
      sequence,
      text: [...message.parts]
        .sort((a, b) => a[0] - b[0])
        .map(([, text]) => text)
        .join("\n"),
      status,
      ...(reason ? { reason } : {}),
    };
  }
}
