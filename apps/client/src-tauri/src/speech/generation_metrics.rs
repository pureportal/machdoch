use super::*;

pub(super) fn schema(connection:&Connection)->Result<(),String>{
    connection.execute_batch("CREATE TABLE IF NOT EXISTS speech_dispatch_measurements(job_id TEXT NOT NULL,ordinal INTEGER NOT NULL,queued_at TEXT NOT NULL,claimed_at TEXT NOT NULL,finished_at TEXT,state TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),PRIMARY KEY(job_id,ordinal));
        CREATE INDEX IF NOT EXISTS speech_dispatch_measurement_recent ON speech_dispatch_measurements(claimed_at);
        CREATE TABLE IF NOT EXISTS speech_request_measurements(id TEXT PRIMARY KEY,job_id TEXT NOT NULL,created_at TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)));
        CREATE INDEX IF NOT EXISTS speech_request_measurement_job ON speech_request_measurements(job_id,created_at,id);").map_err(error)
}

pub(crate) fn claim(connection:&Connection,job:&Value,now:&str)->Result<(),String>{
    let id=identifier(job,"id")?;
    let queued:Option<String>=connection.query_row("SELECT finished_at FROM speech_dispatch_measurements WHERE job_id=?1 AND state='queued' ORDER BY ordinal DESC LIMIT 1",[id],|row|row.get(0)).optional().map_err(error)?.flatten();
    let queued=queued.as_deref().unwrap_or(text(job,"createdAt",1,128)?);
    let delay=parse_time(now)?.signed_duration_since(parse_time(queued)?).num_microseconds().filter(|value|*value>=0).map(|value|value as f64/1000.0);
    let data=json!({"queueDelayMs":delay,"queueClock":"utc","workerRunningMs":null,"cancellationInitiatedMs":null,"cancellationWorkerReleasedMs":null});
    connection.execute("INSERT INTO speech_dispatch_measurements VALUES(?1,(SELECT coalesce(max(ordinal),0)+1 FROM speech_dispatch_measurements WHERE job_id=?1),?2,?3,NULL,'running',?4)",params![id,queued,now,encode(&data)?]).map_err(error)?;Ok(())
}

pub(crate) fn finish(connection:&Connection,id:&str,state:&str,now:&str)->Result<(),String>{
    connection.execute("UPDATE speech_dispatch_measurements SET state=?2,finished_at=?3 WHERE job_id=?1 AND finished_at IS NULL",params![id,state,now]).map_err(error)?;
    connection.execute("DELETE FROM speech_dispatch_measurements WHERE job_id=?1 AND ordinal<(SELECT max(ordinal)-99 FROM speech_dispatch_measurements WHERE job_id=?1)",[id]).map_err(error)?;
    connection.execute("DELETE FROM speech_dispatch_measurements WHERE finished_at IS NOT NULL AND (julianday(finished_at)<julianday(?1)-30 OR rowid IN(SELECT rowid FROM speech_dispatch_measurements WHERE finished_at IS NOT NULL ORDER BY finished_at DESC,rowid DESC LIMIT -1 OFFSET 10000)) AND NOT EXISTS(SELECT 1 FROM jobs WHERE jobs.id=speech_dispatch_measurements.job_id AND jobs.state IN('queued','running') AND speech_dispatch_measurements.ordinal=(SELECT max(latest.ordinal) FROM speech_dispatch_measurements latest WHERE latest.job_id=jobs.id))",[now]).map_err(error)?;Ok(())
}

impl SpeechStore{
    pub(crate) fn finish_dispatch_measurement(&mut self,job:&Value,measured:&Value)->Result<(),String>{
        let id=identifier(job,"id")?;
        let previous:Option<(i64,String)>=self.connection.query_row("SELECT ordinal,data FROM speech_dispatch_measurements WHERE job_id=?1 AND ordinal=?2",params![id,measured["ordinal"].as_i64().ok_or("The speech dispatch measurement identity is missing.")?],|row|Ok((row.get(0)?,row.get(1)?))).optional().map_err(error)?;
        let Some((ordinal,data))=previous else{return Err("The active speech dispatch measurement is missing.".into());};let mut data=parse_json(data)?;
        for field in ["workerRunningMs","cancellationInitiatedMs","cancellationWorkerReleasedMs"]{data[field]=measured[field].clone();}
        self.connection.execute("UPDATE speech_dispatch_measurements SET data=?3 WHERE job_id=?1 AND ordinal=?2",params![id,ordinal,encode(&data)?]).map_err(error)?;Ok(())
    }

    pub(crate) fn record_request_measurement(&mut self,snapshot:&Value,segment:&Value,source:&str,elapsed_ms:f64,first_frame_ms:Option<f64>,duration:Option<f64>,state:&str,dispatched:bool)->Result<(),String>{
        let id=identifier(snapshot,"jobId")?;let data=json!({"segmentId":identifier(segment,"id")?,"source":source,"backend":snapshot["profile"]["backend"],"model":snapshot["profile"]["model"],"state":state,"nativeTotalMs":elapsed_ms,"transportPrepareToFirstFrameMs":first_frame_ms,"producedAudioSeconds":duration,"renderSpeed":duration.filter(|_|source=="provider"&&elapsed_ms>0.0).map(|duration|duration/(elapsed_ms/1000.0)),"upstreamDispatched":dispatched});
        let now=timestamp();self.connection.execute("INSERT INTO speech_request_measurements VALUES(?1,?2,?3,?4)",params![uuid()?,id,now,encode(&data)?]).map_err(error)?;
        self.connection.execute("DELETE FROM speech_request_measurements WHERE created_at<?1 OR id IN(SELECT id FROM speech_request_measurements ORDER BY created_at DESC,id DESC LIMIT -1 OFFSET 10000)",[(Utc::now()-chrono::Duration::days(30)).to_rfc3339_opts(SecondsFormat::Millis,true)]).map_err(error)?;Ok(())
    }

    pub(crate) fn generation_performance(&self,job_id:&str)->Result<Value,String>{
        let mut dispatches=self.connection.prepare("SELECT ordinal,queued_at,claimed_at,finished_at,state,data FROM speech_dispatch_measurements WHERE job_id=?1 ORDER BY ordinal DESC LIMIT 100").map_err(error)?;
        let rows=dispatches.query_map([job_id],|row|Ok((row.get::<_,i64>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,Option<String>>(3)?,row.get::<_,String>(4)?,row.get::<_,String>(5)?))).map_err(error)?;
        let mut values=Vec::new();for row in rows{let (ordinal,queued,claimed,finished,state,data)=row.map_err(error)?;values.push(json!({"ordinal":ordinal,"queuedAt":queued,"claimedAt":claimed,"finishedAt":finished,"state":state,"measurements":parse_json(data)?}));}
        let count:i64=self.connection.query_row("SELECT count(*) FROM speech_request_measurements WHERE job_id=?1",[job_id],|row|row.get(0)).map_err(error)?;
        let mut requests=self.connection.prepare("SELECT data FROM speech_request_measurements WHERE job_id=?1 ORDER BY created_at DESC,id DESC LIMIT 100").map_err(error)?;let rows=requests.query_map([job_id],|row|row.get::<_,String>(0)).map_err(error)?;let requests=rows.map(|row|parse_json(row.map_err(error)?)).collect::<Result<Vec<_>,_>>()?;
        let mut groups=std::collections::BTreeMap::<String,Vec<f64>>::new();for value in &requests{if value["source"]=="provider"&&value["state"]=="completed"{for field in ["nativeTotalMs","transportPrepareToFirstFrameMs","renderSpeed"]{if let Some(value)=value[field].as_f64(){groups.entry(field.into()).or_default().push(value);}}}}
        let percentiles=groups.into_iter().map(|(metric,mut values)|{values.sort_by(f64::total_cmp);json!({"metric":metric,"count":values.len(),"p50":values[(values.len()*50).div_ceil(100)-1],"p95":values[(values.len()*95).div_ceil(100)-1]})}).collect::<Vec<_>>();
        Ok(json!({"scope":"native-runtime","dispatches":values,"requestCount":count,"recentRequests":requests,"recentSuccessfulProviderPercentiles":percentiles}))
    }
}
