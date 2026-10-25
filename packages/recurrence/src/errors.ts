export class RecurrenceError extends RangeError {
  constructor(
    readonly code:
      | "invalid_recurrence"
      | "invalid_timezone"
      | "unsupported_rule"
      | "timezone_data_changed"
      | "search_limit"
      | "no_occurrence"
      | "calendar_limit",
    message: string,
  ) {
    super(message);
    this.name = "RecurrenceError";
  }
}
