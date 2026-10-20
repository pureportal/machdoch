use super::*;

impl SpeechStore{
    pub(super) fn favorite_voice(&self,input:&Value)->Result<Value,String>{
        fields(input,&["id","favorite"])?;let id=identifier(input,"id")?;
        let favorite=boolean(input,"favorite")?;
        if favorite{self.connection.execute("INSERT INTO speech_voice_favorites(id) VALUES(?1) ON CONFLICT DO NOTHING",[id])}else{self.connection.execute("DELETE FROM speech_voice_favorites WHERE id=?1",[id])}.map_err(error)?;Ok(Value::Null)
    }

    pub(super) fn favorite_voices(&self,input:&Value)->Result<Value,String>{
        fields(input,&["offset","limit","search","language"])?;
        let offset=required(input,"offset")?.as_u64().filter(|offset|*offset<=9_007_199_254_740_991).ok_or("Use a nonnegative favorite offset.")?;
        let limit=required(input,"limit")?.as_u64().filter(|limit|(1..=100).contains(limit)).ok_or("Use a favorite page size from 1 to 100.")?;
        let search=optional_text(input,"search",256)?.unwrap_or("");let language=optional_text(input,"language",35)?.unwrap_or("");
        let transaction=self.connection.unchecked_transaction().map_err(error)?;
        let filter="FROM speech_voice_favorites f LEFT JOIN speech_voice_observations o ON o.id=f.id WHERE (?1='' OR instr(lower(f.id),lower(?1))>0 OR instr(lower(json_extract(o.data,'$.name')),lower(?1))>0) AND (?2='' OR EXISTS(SELECT 1 FROM json_each(o.data,'$.languages') language WHERE language.value=?2))";
        let total:i64=transaction.query_row(&format!("SELECT COUNT(*) {filter}"),params![search,language],|row|row.get(0)).map_err(error)?;
        let mut statement=transaction.prepare(&format!("SELECT f.id,o.data {filter} ORDER BY COALESCE(json_extract(o.data,'$.name'),f.id) COLLATE NOCASE,f.id LIMIT ?3 OFFSET ?4")).map_err(error)?;
        let rows=statement.query_map(params![search,language,limit as i64,offset as i64],|row|Ok((row.get::<_,String>(0)?,row.get::<_,Option<String>>(1)?))).map_err(error)?;
        let mut favorites=Vec::new();
        for row in rows{
            let (id,data)=row.map_err(error)?;
            let voice=if let Some(data)=data{let mut value=parse_json(data)?;voice_observations::validate(&value)?;value["favorite"]=json!(true);value["previewUrl"]=Value::Null;value}else{Value::Null};
            favorites.push(json!({"id":id,"voice":voice}));
        }
        Ok(json!({"favorites":favorites,"total":total,"offset":offset,"limit":limit}))
    }
}
