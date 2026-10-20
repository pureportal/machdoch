use super::*;

impl SpeechStore{
    pub fn admit_timing(&mut self,input:Value,preferences:&Value,encoder_sha:&str,configured:bool,now:String,job_id:String)->Result<Value,String>{
        fields(&input,&["owner","takeId","provider","model","language","pricing","budgetLimit","cloudConsent","reuseCache","parentJobId","confirmedUncertain"])?;
        let owner=text(&input,"owner",1,512)?;
        if input["provider"]!="openai"||input["model"]!=super::super::transcript_timing::MODEL{return Err("Choose OpenAI Whisper 1 explicitly for word timestamps.".into());}
        let language=super::super::transcript_timing::validate_language(required(&input,"language")?)?;
        boolean(&input,"cloudConsent")?;let reuse=boolean(&input,"reuseCache")?;
        let take=self.timing_take(identifier(&input,"takeId")?)?;
        let hash=super::super::transcript_timing::request_hash(asset_identifier(&take["asset"]["sha256"])? ,language,encoder_sha);
        let plan=super::super::transcript_timing::chunks(number(&take["asset"],"duration",0.0,f64::MAX)?)?;
        let cached=if reuse{self.timing_candidate(&take,&hash)?}else{None};
        let parent_id=optional_identifier(&input,"parentJobId")?;
        let mut previous_chunks=Vec::new();let mut attempt=1;
        if let Some(id)=parent_id{
            let data:String=self.connection.query_row("SELECT data FROM jobs WHERE id=?1",[id],|row|row.get(0)).optional().map_err(error)?.ok_or("The original transcription job is unavailable.")?;
            let parent=parse_json(data)?;
            if parent["kind"]!="alignment"||parent["owner"]!=owner||!matches!(parent["state"].as_str(),Some("failed"|"cancelled"|"uncertain"|"interrupted")){return Err("Retry a stopped transcription job owned by this session.".into());}
            if parent["state"]=="uncertain"&&input["confirmedUncertain"]!=true{return Err("Confirm that retrying uncertain transcription may create another provider charge.".into());}
            let snapshot:String=self.connection.query_row("SELECT snapshot FROM speech_requests WHERE job_id=?1",[id],|row|row.get(0)).map_err(error)?;
            let snapshot=parse_json(snapshot)?;
            for key in ["takeId","provider","model","language","pricing"]{if snapshot["input"][key]!=input[key]{return Err("Retry the exact audio, model, language and rate snapshot, or submit a new transcription.".into());}}
            if snapshot["requestHash"]!=hash||snapshot["chunks"]!=json!(plan){return Err("The transcription preprocessing contract changed. Submit a new job.".into());}
            previous_chunks=self.timing_chunks(id)?;
            if previous_chunks.len()>plan.len(){return Err("The transcription recovery log is inconsistent.".into());}
            for (data,window) in previous_chunks.iter().zip(&plan){if data["window"]!=*window{return Err("A completed transcription window changed. Submit a new job.".into());}}
            attempt=parent["attempt"].as_u64().ok_or("The original transcription attempt is invalid.")?+1;
        }
        let pending=if cached.is_some(){&[][..]}else{&plan[previous_chunks.len()..]};
        if !pending.is_empty()&&(!configured||preferences["cloudConsent"]!=true||input["cloudConsent"]!=true){return Err("Configure OpenAI and enable cloud speech requests before sending audio for transcription.".into());}
        let estimate=if pending.is_empty(){Some(0.0)}else{super::super::transcript_timing::estimate(required(&input,"pricing")?,pending,chrono::Utc::now().date_naive())?};
        let requested=if input["budgetLimit"].is_null(){None}else{Some(number(&input,"budgetLimit",0.0,f64::MAX)?)};
        let configured_limit=preferences["budgetLimit"].as_f64();
        let limit=match(requested,configured_limit){(Some(requested),Some(configured))=>Some(requested.min(configured)),(requested,configured)=>requested.or(configured)};
        let scope=take["projectId"].as_str().unwrap_or(owner);
        let resumed=if cached.is_some(){0}else{previous_chunks.len()};
        let total=if cached.is_some(){1}else{plan.len()};
        let take_ids=json!([take["id"]]);
        let job=json!({"id":job_id,"kind":"alignment","timingId":null,"owner":owner,"projectId":take["projectId"],"revisionId":take["revisionId"],"state":"queued","completedSegments":resumed,"totalSegments":total,"takeIds":take_ids,"error":null,"createdAt":now,"updatedAt":now,"priority":50,"attempt":attempt,"parentJobId":parent_id});
        let snapshot=json!({"operation":"align","jobId":job_id,"input":input,"take":take,"requestHash":hash,"chunks":plan,"encoderSha256":encoder_sha,"reusedTimingId":cached,"estimate":estimate,"pricing":input["pricing"],"admittedAt":now,"resumedSegments":resumed});
        let transaction=self.connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(error)?;
        super::super::budget::check(&transaction,scope,estimate,limit,&input["pricing"])?;
        Self::put_job_in_transaction(&transaction,&job)?;
        transaction.execute("INSERT INTO speech_budget VALUES(?1,?2,?3)",params![job_id,scope,estimate.unwrap_or(0.0)]).map_err(error)?;
        transaction.execute("INSERT INTO speech_requests VALUES(?1,?2)",params![job_id,encode(&snapshot)?]).map_err(error)?;
        if cached.is_none(){for (ordinal,data) in previous_chunks.iter().enumerate(){transaction.execute("INSERT INTO speech_timing_chunks VALUES(?1,?2,?3)",params![job_id,ordinal as i64,encode(data)?]).map_err(error)?;}}
        transaction.commit().map_err(error)?;
        Ok(job)
    }
}
