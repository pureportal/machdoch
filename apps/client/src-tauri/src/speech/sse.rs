use serde_json::Value;
const MAX_MESSAGE_BYTES:usize=2*1024*1024;

#[derive(Default)]
pub(crate) struct SseDecoder {
    line: Vec<u8>,
    data: Vec<u8>,
    has_data: bool,
    event: String,
    event_bytes: usize,
    skip_lf: bool,
}

impl SseDecoder {
    pub(crate) fn push(&mut self, bytes: &[u8]) -> Result<Vec<Value>, String> {
        let mut messages = Vec::new();
        for &byte in bytes {
            if self.skip_lf {
                self.skip_lf = false;
                if byte == b'\n' {
                    continue;
                }
            }
            self.event_bytes += 1;
            if self.event_bytes > MAX_MESSAGE_BYTES {
                return Err("Speech SSE event exceeded the size limit.".into());
            }
            match byte {
                b'\r' => {
                    self.end_line(&mut messages)?;
                    self.skip_lf = true;
                }
                b'\n' => self.end_line(&mut messages)?,
                _ => self.line.push(byte),
            }
        }
        Ok(messages)
    }

    fn end_line(&mut self, messages: &mut Vec<Value>) -> Result<(), String> {
        if self.line.is_empty() {
            if self.event == "error" {
                return Err("The speech backend rejected the request.".into());
            }
            if self.has_data {
                if !self.event.is_empty() && self.event != "message" {
                    return Err("The speech backend returned an unexpected SSE event.".into());
                }
                let message: Value = serde_json::from_slice(&self.data)
                    .map_err(|_| "The speech backend returned malformed SSE JSON.")?;
                if !message.is_object() {
                    return Err("The speech backend returned an invalid SSE payload.".into());
                }
                messages.push(message);
            }
            self.data.clear();
            self.has_data = false;
            self.event.clear();
            self.event_bytes = 0;
            return Ok(());
        }
        let line = std::str::from_utf8(&self.line)
            .map_err(|_| "The speech backend returned invalid SSE text.")?;
        let (field, value) = line.split_once(':').unwrap_or((line, ""));
        let value = value.strip_prefix(' ').unwrap_or(value);
        match field {
            "data" => {
                if self.has_data {
                    self.data.push(b'\n');
                }
                self.data.extend_from_slice(value.as_bytes());
                self.has_data = true;
            }
            "event" => self.event = value.to_owned(),
            _ => {}
        }
        self.line.clear();
        Ok(())
    }

    pub(crate) fn finish(&self) -> Result<(), String> {
        if !self.line.is_empty() || self.has_data || !self.event.is_empty() {
            return Err("Speech SSE stream ended inside an event.".into());
        }
        Ok(())
    }
}
