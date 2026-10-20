pub(crate) fn response_error(provider: &str, status: u16) -> String {
    let action = match status {
        401 | 403 => "authentication failed. Check the API key and model access.",
        402 => "credit is insufficient. Add credit before retrying.",
        404 => "model or voice is unavailable. Choose an available speech profile.",
        400 | 422 => "rejected the speech input. Check its text and settings.",
        429 => "request quota is exhausted. Wait for other requests before retrying.",
        500..=599 => "service failed. Review usage before retrying.",
        _ => "request failed. Review the job before retrying.",
    };
    format!("{provider} speech {action}")
}
