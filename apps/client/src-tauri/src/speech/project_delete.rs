use super::*;

impl SpeechStore {
    pub(super) fn delete_project(&mut self, id: &str) -> Result<Value,String> {
        let transaction=self.connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(error)?;
        exists(&transaction,"SELECT 1 FROM projects WHERE id=?1 AND deleted=0",id)?;
        let active:bool=transaction.query_row("SELECT EXISTS(SELECT 1 FROM jobs WHERE project_id=?1 AND state IN ('queued','running'))",[id],|row|row.get(0)).map_err(error)?;
        if active {return Err("Cancel this project's active renders before deleting it.".into());}
        let reused:bool=transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM takes t WHERE (t.project_id IS NULL OR t.project_id<>?1) AND
              (t.parent_take_id IN (SELECT id FROM takes WHERE project_id=?1)
               OR json_extract(t.data,'$.reusedFromTakeId') IN (SELECT id FROM takes WHERE project_id=?1)))",
            [id],|row|row.get(0)
        ).map_err(error)?;
        if reused {return Err("This project's takes are reused elsewhere. Delete the dependent projects or retain this project.".into());}
        timing_store::clean_workspaces(&transaction,&self.root,Some(id))?;
        transaction.execute_batch("PRAGMA defer_foreign_keys=ON; DROP TRIGGER revisions_no_delete;").map_err(error)?;
        for sql in [
            "DELETE FROM speech_events WHERE job_id IN (SELECT id FROM jobs WHERE project_id=?1)",
            "DELETE FROM speech_budget WHERE job_id IN (SELECT id FROM jobs WHERE project_id=?1)",
            "DELETE FROM speech_requests WHERE job_id IN (SELECT id FROM jobs WHERE project_id=?1)",
            "DELETE FROM job_takes WHERE job_id IN (SELECT id FROM jobs WHERE project_id=?1)",
            "DELETE FROM jobs WHERE project_id=?1",
            "DELETE FROM revision_takes WHERE revision_id IN (SELECT id FROM revisions WHERE project_id=?1)",
            "DELETE FROM revision_assets WHERE revision_id IN (SELECT id FROM revisions WHERE project_id=?1)",
            "DELETE FROM revision_profiles WHERE revision_id IN (SELECT id FROM revisions WHERE project_id=?1)",
            "DELETE FROM revision_dictionaries WHERE revision_id IN (SELECT id FROM revisions WHERE project_id=?1)",
            "DELETE FROM revision_timings WHERE revision_id IN (SELECT id FROM revisions WHERE project_id=?1)",
            "DELETE FROM speech_timings WHERE take_id IN (SELECT id FROM takes WHERE project_id=?1)",
            "DELETE FROM takes WHERE project_id=?1",
            "DELETE FROM revisions WHERE project_id=?1",
            "DELETE FROM speech_exports WHERE project_id=?1",
            "DELETE FROM speech_mixes WHERE project_id=?1",
            "DELETE FROM projects WHERE id=?1",
        ] {transaction.execute(sql,[id]).map_err(error)?;}
        transaction.execute("INSERT INTO speech_deleted_projects VALUES(?1,?2)",params![id,timestamp()]).map_err(error)?;
        transaction.execute_batch("CREATE TRIGGER revisions_no_delete BEFORE DELETE ON revisions BEGIN SELECT RAISE(ABORT, 'Revisions are immutable'); END;").map_err(error)?;
        transaction.commit().map_err(error)?;
        Ok(Value::Null)
    }
}
