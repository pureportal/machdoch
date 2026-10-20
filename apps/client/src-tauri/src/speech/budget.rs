use rusqlite::Transaction;
use serde_json::Value;

pub fn check(transaction:&Transaction<'_>,scope:&str,estimate:Option<f64>,limit:Option<f64>,pricing:&Value)->Result<(),String>{
    if limit.is_some()&&estimate.is_none(){return Err("A verified rate and billing unit are required to enforce this spending limit.".into());}
    if estimate.is_some_and(|value|!value.is_finite()||value<0.0)||limit.is_some_and(|value|!value.is_finite()||value<0.0){return Err("Use finite nonnegative budget amounts.".into());}
    let reserved:f64=transaction.query_row("SELECT coalesce(sum(amount),0) FROM speech_budget WHERE scope=?1",[scope],|row|row.get(0)).map_err(|error|error.to_string())?;
    if estimate.is_some_and(|value|value>0.0){
        let currency=pricing["currency"].as_str().ok_or("Record the currency of the verified rate.")?;
        let mut statement=transaction.prepare("SELECT DISTINCT json_extract(r.snapshot,'$.pricing.currency') FROM speech_budget b JOIN speech_requests r ON r.job_id=b.job_id WHERE b.scope=?1 AND b.amount>0").map_err(|error|error.to_string())?;
        let currencies=statement.query_map([scope],|row|row.get::<_,Option<String>>(0)).map_err(|error|error.to_string())?;
        for existing in currencies{if existing.map_err(|error|error.to_string())?.as_deref()!=Some(currency){return Err("This budget already contains reservations in another currency. Use the same verified billing currency.".into());}}
    }
    if estimate.is_some_and(|estimate|estimate>0.0&&limit.is_some_and(|limit|reserved+estimate>limit)){return Err("The local speech budget would be exceeded. Increase it or choose less audio, text or fewer takes.".into());}
    Ok(())
}
